// SmashSection — the Pro "Smash" mode body, redesigned around per-aspect
// band transfer.
//
// The transform is broken into four ASPECTS — Value, Hue, Saturation,
// Chroma. Each aspect is one AspectRow: the source image's distribution
// along that axis (an editable ratio band), the target's distribution
// (another editable ratio band), and a "borrow amount" — how far the
// target's pixels are rank-transferred onto the source's distribution.
//
// SmashSection owns the four-aspect control state, the engine pipeline,
// persistence, and the Apply / Test Bake / Export action row. The parent
// (MatchTab) supplies the source/target RGBA snaps as props and drives the
// live matched preview from the engine handed back via onEngineChange.

import { useEffect, useMemo, useRef, useState } from "react";
import { AspectRow } from "./AspectRow";
import {
  ASPECT_KEYS,
  BIN_COUNT_OPTIONS,
  DEFAULT_BIN_COUNT,
  RANK_BY_OPTIONS,
  neutralSmashControls,
  initControls,
  setAspectRank,
  pickRankAxis,
  coerceRankAxis,
  resampleHist,
  extractAspectHistograms,
  buildSmashEngine,
  applySmash,
  bakeEngineLut,
  type SmashEngine,
  type SmashControls,
  type AspectControl,
  type AspectKey,
  type AspectHistogramSet,
  type RankBy,
  type RgbTriplet,
} from "../../core/smash/engine";
import { serializeSmashCube } from "../../core/smash";
import { applySmashLut } from "../../app/smash/applySmashLut";
import { applySmashTestBake } from "../../app/smash/applySmashTestBake";
import { loadSmashSettings, makeSmashSaver, type SmashPersisted } from "./persistence";

// ────────── public types ──────────

export interface SmashSectionLayerSnap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface SmashSectionProps {
  /** Source layer RGBA from the parent's useLayerPreview. Null when nothing
   *  is picked or the snap is pending. */
  sourceSnap: SmashSectionLayerSnap | null;
  /** Target layer RGBA. Null when nothing is picked. */
  targetSnap: SmashSectionLayerSnap | null;
  /** Fires whenever the engine rebuilds — the parent bakes the live preview
   *  LUT from it. Null when source/target aren't both ready. */
  onEngineChange?: (engine: SmashEngine | null) => void;
  /** Test Bake feeds the engine's per-pixel ground truth into the panel
   *  preview tile (full-res layer is written separately to the document). */
  onTestBake?: (pixels: Uint8Array, width: number, height: number) => void;
  /** Active target document / layer ids — used to write a full-res,
   *  target-aligned Test Bake layer. */
  targetDocId?: number | null;
  targetLayerId?: number | null;
}

// ────────── aspect labels ──────────

const ASPECT_LABEL: Record<AspectKey, string> = {
  value: "Value",
  hue: "Hue",
  saturation: "Saturation",
  chroma: "Chroma",
};

/**
 * "Auto" — pick a sensible novice-friendly configuration that matches the
 * target to the source. Detects whether the target is near-grayscale (a
 * colorization job) and adapts:
 *   • Hue + Chroma — full borrow (the core of a colour match).
 *   • Saturation — left at 0; it overlaps Chroma, so Chroma drives colourfulness.
 *   • Value — light borrow on a grayscale target (keep the photo's tones),
 *     fuller borrow on a colour target.
 *   • Softness 25% everywhere so transitions aren't harsh.
 * Bands are reset to the images' natural distributions; Rank-by stays Auto.
 */
function autoConfigure(histograms: AspectHistogramSet): SmashControls {
  const base = initControls(histograms);
  const tc = histograms.chroma.target;
  let total = 0;
  let low = 0;
  const lowBins = Math.max(1, Math.round(tc.length * 0.12));
  for (let i = 0; i < tc.length; i++) {
    total += tc[i];
    if (i < lowBins) low += tc[i];
  }
  const grayscaleTarget = total < 1e-6 || low / total > 0.9;
  const valueAmount = grayscaleTarget ? 0.3 : 0.7;
  for (const key of ASPECT_KEYS) {
    const amount = key === "value" ? valueAmount : key === "saturation" ? 0 : 1;
    base[key] = { ...base[key], amount, softness: 0.25 };
  }
  return base;
}

/**
 * Per-bin colours for a CROSS-FED target band. The band's slices are rank
 * slots along the cross axis; this paints each slot with the SOURCE colour
 * its pixels will actually adopt (the source aspect's colour at that rank),
 * so the band reads congruently with the source instead of as a flat,
 * unrelated axis ramp (a grey value ramp sitting in the Hue panel, etc.).
 */
function rankColors(
  srcHist: Float32Array,
  srcColors: readonly RgbTriplet[],
): RgbTriplet[] {
  const n = srcHist.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.max(0, srcHist[i]);
  const out: RgbTriplet[] = [];
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n; // this slot's rank
    let acc = 0;
    let b = 0;
    for (; b < n - 1; b++) {
      acc += Math.max(0, srcHist[b]) / (total || 1);
      if (acc >= r) break;
    }
    out.push(srcColors[b] ?? [128, 128, 128]);
  }
  return out;
}

// ────────── persistence helpers ──────────

// Bands are absolute, image-specific distributions — they're re-seeded from
// the extracted histograms each session, so only the count / amount /
// softness / drag-mode are persisted.
function serializeControls(
  c: SmashControls,
  adaptive: Record<AspectKey, boolean>,
): NonNullable<SmashPersisted["aspects"]> {
  const out = {} as NonNullable<SmashPersisted["aspects"]>;
  for (const key of ASPECT_KEYS) {
    out[key] = {
      binCount: c[key].binCount,
      amount: c[key].amount,
      softness: c[key].softness,
      rankBy: c[key].rankBy,
      adaptive: adaptive[key],
    };
  }
  return out;
}

function restoreControls(
  prev: SmashControls,
  aspects: NonNullable<SmashPersisted["aspects"]>,
): SmashControls {
  const out: SmashControls = { ...prev };
  for (const key of ASPECT_KEYS) {
    const p = aspects[key];
    if (!p) continue;
    const binCount =
      typeof p.binCount === "number" && BIN_COUNT_OPTIONS.includes(p.binCount)
        ? p.binCount
        : prev[key].binCount;
    const amount =
      typeof p.amount === "number" && Number.isFinite(p.amount)
        ? Math.max(0, Math.min(1, p.amount))
        : prev[key].amount;
    const softness =
      typeof p.softness === "number" && Number.isFinite(p.softness)
        ? Math.max(0, Math.min(1, p.softness))
        : prev[key].softness;
    const rankBy =
      typeof p.rankBy === "string" ? coerceRankAxis(p.rankBy) : prev[key].rankBy;
    out[key] = { ...prev[key], binCount, amount, softness, rankBy };
  }
  return out;
}

function restoreAdaptive(
  prev: Record<AspectKey, boolean>,
  aspects: NonNullable<SmashPersisted["aspects"]>,
): Record<AspectKey, boolean> {
  const out = { ...prev };
  for (const key of ASPECT_KEYS) {
    const p = aspects[key];
    if (p && typeof p.adaptive === "boolean") out[key] = p.adaptive;
  }
  return out;
}

/** Run the engine over every opaque pixel of a snap — the panel preview tile
 *  for Test Bake. (The full-res, document-aligned layer is written by
 *  applySmashTestBake.) */
function bakePanelTile(engine: SmashEngine, snap: SmashSectionLayerSnap): Uint8Array {
  const { data, width, height } = snap;
  const out = new Uint8Array(width * height * 4);
  const px = width * height;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 128) {
      out[o] = data[o]; out[o + 1] = data[o + 1]; out[o + 2] = data[o + 2]; out[o + 3] = a;
      continue;
    }
    const [r, g, b] = applySmash(engine, data[o], data[o + 1], data[o + 2]);
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return out;
}

// ────────── component ──────────

export function SmashSection(props: SmashSectionProps): JSX.Element {
  const { sourceSnap, targetSnap, onEngineChange, onTestBake, targetDocId, targetLayerId } = props;

  // Aspects start fully engaged (borrow 100%) so opening Smash does something
  // immediately — the user dials each one DOWN as desired.
  const [controls, setControls] = useState<SmashControls>(() => {
    const c = neutralSmashControls();
    for (const k of ASPECT_KEYS) c[k] = { ...c[k], amount: 1 };
    return c;
  });
  // Per-aspect adaptive-drag mode for the ratio bands. UI-only (it doesn't
  // affect the transform), so it's kept beside the engine controls rather
  // than inside them — but it IS persisted.
  const [adaptive, setAdaptive] = useState<Record<AspectKey, boolean>>(() => ({
    value: false, hue: false, saturation: false, chroma: false,
  }));
  // Accordion: at most one aspect's body open at a time. Its header (label +
  // borrow slider) stays visible whether open or closed.
  const [openAspect, setOpenAspect] = useState<AspectKey | null>("value");
  const [exportStatus, setExportStatus] = useState<string>("");

  const loadedRef = useRef(false);
  const saverRef = useRef<ReturnType<typeof makeSmashSaver> | null>(null);
  // Smash LUT layer ids we've created. Default Apply replaces the most recent
  // in place; "+" forks a new one and auto-hides the prior.
  const smashLayerIdsRef = useRef<number[]>([]);

  // ── persistence: load once ──
  useEffect(() => {
    saverRef.current = makeSmashSaver(500);
    let cancelled = false;
    (async () => {
      const persisted = await loadSmashSettings();
      if (!cancelled && persisted?.aspects) {
        setControls((prev) => restoreControls(prev, persisted.aspects!));
        setAdaptive((prev) => restoreAdaptive(prev, persisted.aspects!));
      }
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── persistence: save on change (debounced) ──
  useEffect(() => {
    if (!loadedRef.current) return;
    saverRef.current?.({ aspects: serializeControls(controls, adaptive) });
  }, [controls, adaptive]);

  const hasSnaps = sourceSnap !== null && targetSnap !== null;

  // Per-aspect slice counts. A new object only when a count actually changes,
  // so band/amount drags don't perturb the histogram memo below.
  const binCounts = useMemo(
    () => ({
      value: controls.value.binCount,
      hue: controls.hue.binCount,
      saturation: controls.saturation.binCount,
      chroma: controls.chroma.binCount,
    }),
    [
      controls.value.binCount,
      controls.hue.binCount,
      controls.saturation.binCount,
      controls.chroma.binCount,
    ],
  );

  // ── heavy: per-aspect histograms. Re-extracts only when the snaps or a
  // slice count change — a band/amount drag never re-extracts (one pass over
  // ~100K pixels). ──
  const histograms = useMemo<AspectHistogramSet | null>(() => {
    if (!sourceSnap || !targetSnap) return null;
    return extractAspectHistograms(
      { data: sourceSnap.data, width: sourceSnap.width, height: sourceSnap.height },
      { data: targetSnap.data, width: targetSnap.width, height: targetSnap.height },
      binCounts,
      1,
    );
  }, [sourceSnap, targetSnap, binCounts]);

  // New images → re-pick each aspect's smart rank axis (its own axis, or
  // Value when that channel is flat — grayscale colorization). Keyed on the
  // snaps only, so changing a slice count keeps a manually-chosen Rank-by.
  // Declared before the band re-seed below so its rankBy lands first.
  useEffect(() => {
    if (!histograms) return;
    setControls((c) => {
      const next = { ...c } as SmashControls;
      for (const key of ASPECT_KEYS) {
        next[key] = setAspectRank(c[key], pickRankAxis(histograms, key), histograms);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSnap, targetSnap]);

  // Re-seed the ratio bands from the extracted histograms whenever the snaps
  // or a slice count change. Bands are absolute distributions tied to the
  // current images, so a snap / count change must reset them; band edits
  // (which never touch the histograms) survive in between.
  useEffect(() => {
    if (!histograms) return;
    setControls((prev) => {
      const next = { ...prev } as SmashControls;
      for (const key of ASPECT_KEYS) {
        // The target band is binned along the aspect's (concrete) rank axis —
        // re-seed it from that axis's target histogram.
        const rankAxis = prev[key].rankBy;
        const n = histograms[key].source.length;
        next[key] = {
          ...prev[key],
          binCount: n,
          sourceBand: Array.from(histograms[key].source),
          targetBand: resampleHist(histograms[rankAxis].target, n),
        };
      }
      return next;
    });
  }, [histograms]);

  // ── light: build the runnable engine. Cheap — just rebuilds the per-aspect
  // CDFs from the edited bands. Runs every control tick. ──
  const engine = useMemo<SmashEngine | null>(() => {
    if (!histograms) return null;
    return buildSmashEngine(histograms, controls);
  }, [histograms, controls]);

  // Propagate the engine to the parent AFTER commit. Debounced ~90ms: the
  // engine rebuild itself is cheap, but the parent bakes a 33³ preview LUT
  // (~36K transforms) off it — doing that every slider tick janks the drag.
  // Debouncing means the preview catches up shortly after you pause, while
  // the drag stays smooth. Apply / Export read the engine directly, undelayed.
  useEffect(() => {
    const t = setTimeout(() => onEngineChange?.(engine), 90);
    return () => clearTimeout(t);
    // onEngineChange is a stable setState ref; excluding it avoids a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const updateAspect = (key: AspectKey, patch: Partial<AspectControl>): void => {
    setControls((c) => ({ ...c, [key]: { ...c[key], ...patch } }));
  };

  // Changing Rank-by re-seeds that aspect's (own) target band along the new
  // axis. "Auto" resolves to a concrete axis on the spot (own, or Value when
  // the channel is flat) so the band, the dropdown, and the engine all agree.
  const changeRankBy = (key: AspectKey, rb: RankBy): void => {
    if (!histograms) return;
    const axis: AspectKey = rb === "auto" ? pickRankAxis(histograms, key) : rb;
    setControls((c) => ({ ...c, [key]: setAspectRank(c[key], axis, histograms) }));
  };

  // Reset one aspect to defaults: borrow 100%, softness 0, default slice
  // count, handle-drag mode, smart rank axis, bands back to natural.
  const defaultAspect = (key: AspectKey): AspectControl => {
    const rankBy = histograms ? pickRankAxis(histograms, key) : key;
    return {
      binCount: DEFAULT_BIN_COUNT,
      sourceBand: histograms ? Array.from(histograms[key].source) : [],
      targetBand: histograms ? Array.from(histograms[rankBy].target) : [],
      amount: 1,
      softness: 0,
      rankBy,
    };
  };
  const resetAspect = (key: AspectKey): void => {
    setControls((c) => ({ ...c, [key]: defaultAspect(key) }));
    setAdaptive((a) => ({ ...a, [key]: false }));
  };
  const resetAllAspects = (): void => {
    setControls(() => ({
      value: defaultAspect("value"),
      hue: defaultAspect("hue"),
      saturation: defaultAspect("saturation"),
      chroma: defaultAspect("chroma"),
    }));
    setAdaptive({ value: false, hue: false, saturation: false, chroma: false });
  };

  // Auto-configure all aspects to a sensible match of the source.
  const autoConfigureAll = (): void => {
    if (!histograms) return;
    setControls(autoConfigure(histograms));
    setAdaptive({ value: false, hue: false, saturation: false, chroma: false });
  };

  // ── actions ──

  const onApply = async () => {
    if (!engine) return;
    setExportStatus("applying…");
    try {
      const replaceId =
        smashLayerIdsRef.current.length > 0
          ? smashLayerIdsRef.current[smashLayerIdsRef.current.length - 1]
          : null;
      const result = await applySmashLut(engine, { replaceLayerId: replaceId });
      if (result.ok) {
        if (typeof result.layerId === "number") {
          const next = smashLayerIdsRef.current.slice();
          if (next.length > 0) next[next.length - 1] = result.layerId;
          else next.push(result.layerId);
          smashLayerIdsRef.current = next;
        }
        setExportStatus(`${result.replacedInPlace ? "replaced" : "applied"}: ${result.layerName ?? "Smash LUT"}`);
      } else {
        setExportStatus(`apply error: ${result.error ?? "unknown"}`);
      }
    } catch (err: any) {
      setExportStatus(`apply error: ${err?.message ?? err}`);
    }
  };

  const onApplyFork = async () => {
    if (!engine) return;
    setExportStatus("forking…");
    try {
      const priorIds = smashLayerIdsRef.current.slice();
      const result = await applySmashLut(engine, {
        replaceLayerId: null,
        hidePriorIds: priorIds,
      });
      if (result.ok) {
        if (typeof result.layerId === "number") {
          smashLayerIdsRef.current = [...priorIds, result.layerId];
        }
        setExportStatus(`forked: ${result.layerName ?? "Smash LUT"} (${smashLayerIdsRef.current.length} total)`);
      } else {
        setExportStatus(`apply error: ${result.error ?? "unknown"}`);
      }
    } catch (err: any) {
      setExportStatus(`apply error: ${err?.message ?? err}`);
    }
  };

  const onTestBakeClick = async () => {
    if (!engine || !targetSnap) return;
    setExportStatus("baking test image…");
    try {
      // Instant preview-tier feedback into the panel tile.
      onTestBake?.(bakePanelTile(engine, targetSnap), targetSnap.width, targetSnap.height);
      // Full-res, target-aligned ground-truth layer for on-canvas A/B.
      if (typeof targetDocId === "number" && typeof targetLayerId === "number") {
        setExportStatus("baking test image… (full-res layer)");
        const result = await applySmashTestBake(engine, targetDocId, targetLayerId);
        if (result.ok) {
          setExportStatus(
            `test bake layer added: "${result.layerName}" (${result.width}×${result.height}, engine ground truth)`,
          );
        } else {
          setExportStatus(`test bake error: ${result.error ?? "unknown"}`);
        }
      } else {
        setExportStatus("test bake shown in panel (no target layer id for a full-res layer)");
      }
    } catch (err: any) {
      setExportStatus(`test bake error: ${err?.message ?? err}`);
    }
  };

  const onExportCube = async () => {
    if (!engine) return;
    setExportStatus("baking…");
    try {
      const lut = bakeEngineLut(engine, 33);
      const cubeText = serializeSmashCube(lut, "ColorSmash");
      const uxp = await import("uxp");
      const fs = (uxp as any).default?.storage?.localFileSystem
        ?? (uxp as any).storage?.localFileSystem;
      if (!fs) throw new Error("UXP storage unavailable");
      const entry = await fs.getFileForSaving("ColorSmash.cube", { types: ["cube"] });
      if (!entry) { setExportStatus("cancelled"); return; }
      await entry.write(cubeText);
      setExportStatus(`saved ${entry.name}`);
    } catch (err: any) {
      setExportStatus(`error: ${err?.message ?? err}`);
    }
  };

  // ── render ──

  return (
    <div style={containerStyle}>
      {!hasSnaps && (
        <div style={placeholderStyle}>Pick a source and target layer to run Smash.</div>
      )}

      {hasSnaps && histograms && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ ...sectionLabelStyle, flex: 1 }}>
              ASPECTS — borrow the source's distribution, per axis
            </div>
            <div
              style={autoChipStyle}
              onClick={autoConfigureAll}
              title="Auto — pick a sensible match of the source: full Hue + Chroma borrow, a light Value borrow (keeps the target's tones on a grayscale image), and gentle softness. A good novice starting point to then fine-tune."
            >
              ✦ Auto
            </div>
            <div
              style={resetAllChipStyle}
              onClick={resetAllAspects}
              title="Reset all four aspects to defaults — borrow 100%, softness 0, 16 slices, bands back to the images' own distributions."
            >
              ↺ Reset all
            </div>
          </div>
          {ASPECT_KEYS.map((key) => {
            // The TARGET band is binned along the (concrete) Rank-by axis.
            const rankAxis: AspectKey = controls[key].rankBy;
            const crossFed = rankAxis !== key;
            return (
              <AspectRow
                key={key}
                label={ASPECT_LABEL[key]}
                expanded={openAspect === key}
                onToggleExpand={() => setOpenAspect((o) => (o === key ? null : key))}
                sourceSortByLuma={false}
                sourceColors={histograms[key].sourceColors}
                sourceWeights={controls[key].sourceBand}
                sourceNatural={Array.from(histograms[key].source)}
                onSourceWeightsChange={(w) => updateAspect(key, { sourceBand: w })}
                targetSortByLuma={false}
                targetColors={crossFed
                  ? rankColors(histograms[key].source, histograms[key].sourceColors)
                  : histograms[key].targetColors}
                targetWeights={controls[key].targetBand}
                targetNatural={resampleHist(histograms[rankAxis].target, controls[key].binCount)}
                onTargetWeightsChange={(w) => updateAspect(key, { targetBand: w })}
                targetAxisName={crossFed ? ASPECT_LABEL[rankAxis] : null}
                amount={controls[key].amount}
                onAmountChange={(a) => updateAspect(key, { amount: a })}
                softness={controls[key].softness}
                onSoftnessChange={(s) => updateAspect(key, { softness: s })}
                rankBy={controls[key].rankBy}
                rankByOptions={RANK_BY_OPTIONS}
                onRankByChange={(rb) => changeRankBy(key, rb)}
                binCount={controls[key].binCount}
                binCountOptions={BIN_COUNT_OPTIONS}
                onBinCountChange={(n) => updateAspect(key, { binCount: n })}
                adaptive={adaptive[key]}
                onAdaptiveChange={(v) => setAdaptive((a) => ({ ...a, [key]: v }))}
                onReset={() => resetAspect(key)}
              />
            );
          })}
        </>
      )}

      {hasSnaps && (
        <div style={actionRowStyle}>
          <div
            style={engine ? primaryButtonStyle : primaryButtonDisabledStyle}
            onClick={onApply}
            title="Apply the Smash transform — replaces the most recent Smash LUT layer in place. Use [+] to fork a new layer alongside."
          >
            Apply
          </div>
          <div
            style={engine ? plusButtonStyle : plusButtonDisabledStyle}
            onClick={onApplyFork}
            title="Fork a new Smash LUT layer alongside the previous one — auto-hides prior Smash layers so the new one shows alone. Use to compare variations."
          >
            +
          </div>
          <div
            style={engine ? actionButtonStyle : actionButtonDisabledStyle}
            onClick={onTestBakeClick}
            title="Diagnostic: render the engine's per-pixel ground-truth output (no 3D LUT, no interpolation) as a new 'Smash Test Bake' pixel layer in the document, and into the panel preview tile."
          >
            Test Bake
          </div>
          <div
            style={engine ? actionButtonStyle : actionButtonDisabledStyle}
            onClick={onExportCube}
            title="Bake the current Smash transform to a portable .cube LUT."
          >
            Export .cube
          </div>
          {exportStatus && <span style={statusStyle}>{exportStatus}</span>}
        </div>
      )}
    </div>
  );
}

// ────────── styles ──────────

const containerStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10,
};

const resetAllChipStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, color: "#999", flexShrink: 0,
  padding: "2px 7px", borderRadius: 2, cursor: "pointer", userSelect: "none",
  border: "1px solid #555", background: "transparent",
};

const autoChipStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, color: "#0f1620", flexShrink: 0,
  padding: "2px 8px", borderRadius: 2, cursor: "pointer", userSelect: "none",
  border: "1px solid #1a1a1a", background: "#6ab7ff",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", marginTop: 2,
};

const placeholderStyle: React.CSSProperties = {
  fontSize: 10, color: "#555", lineHeight: 1.4,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap",
};

const actionButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#ddd", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 12px", fontFamily: "inherit", fontSize: 11,
  cursor: "pointer", userSelect: "none", display: "inline-block",
};

const actionButtonDisabledStyle: React.CSSProperties = {
  ...actionButtonStyle, opacity: 0.4, cursor: "default",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#6ab7ff", color: "#0f1620", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 14px", fontFamily: "inherit", fontSize: 11,
  fontWeight: 600, cursor: "pointer", userSelect: "none", display: "inline-block",
};

const primaryButtonDisabledStyle: React.CSSProperties = {
  ...primaryButtonStyle, opacity: 0.4, cursor: "default",
};

const plusButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#6ab7ff", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 0", fontFamily: "inherit", fontSize: 14,
  fontWeight: 700, cursor: "pointer", userSelect: "none", display: "inline-flex",
  alignItems: "center", justifyContent: "center", width: 28, lineHeight: 1,
};

const plusButtonDisabledStyle: React.CSSProperties = {
  ...plusButtonStyle, opacity: 0.4, cursor: "default",
};

const statusStyle: React.CSSProperties = {
  fontSize: 9, color: "#888", flex: 1, textAlign: "right", minWidth: 80,
};
