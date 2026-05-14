// SmashSection — slim Smash mode fragment that lives inside MatchTab.
// Receives source/target RGBA snaps as props (no layer pickers, no
// useLayerPreview) and owns only the engine pipeline, amount state,
// persistence, and the controls/audit/apply/export action row.
// The parent drives the matched preview via the onEngineChange callback.

import { useEffect, useMemo, useRef, useState } from "react";
import { SourceDNAStrip } from "./SourceDNAStrip";
import {
  SmashControlsBar,
  type SmashPreset,
  SMASH_PRESET_AMOUNTS,
  detectPreset,
} from "./SmashControlsBar";
import { SmashAuditPanel } from "./SmashAuditPanel";
import { TraitSliders, DEFAULT_TRAIT_AMOUNTS } from "./TraitSliders";
import {
  ColorizationToggles,
  DEFAULT_COLORIZATION_TOGGLES,
  type ColorizationToggleState,
} from "./ColorizationToggles";
import type { TraitAmounts } from "../../core/smash/types";
import {
  extractFeatures,
  extractSourceDNA,
  extractTargetStructure,
  pairDNA,
  smash,
  buildSmashCdfs,
  bakeSmashLut,
  serializeSmashCube,
  DEFAULT_SMASH_CONTROLS,
  type SmashEngineOutput,
  type SourceDNA,
} from "../../core/smash";
import { loadSmashSettings, makeSmashSaver, type SmashPersisted } from "./persistence";
import { applySmashLut } from "../../app/smash/applySmashLut";

// ────────── public types ──────────

export interface SmashSectionLayerSnap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface SmashSectionProps {
  /** Source layer RGBA from the parent's useLayerPreview. Null when nothing
   *  picked or snap pending. */
  sourceSnap: SmashSectionLayerSnap | null;
  /** Target layer RGBA. Null when nothing picked. */
  targetSnap: SmashSectionLayerSnap | null;
  /** Fired whenever the engine rebuilds (slider drag, snap arrival). The
   *  parent uses this to drive the matched preview. Receives null when the
   *  engine has no valid output (no snaps yet). */
  onEngineChange?: (engine: SmashEngineOutput | null) => void;
}

// ────────── internal pipeline type ──────────

interface EnginePipeline {
  sourceDNA: SourceDNA;
  engine: SmashEngineOutput;
}

// ────────── component ──────────

export function SmashSection(props: SmashSectionProps): JSX.Element {
  const { sourceSnap, targetSnap, onEngineChange } = props;

  const [amount, setAmount] = useState<number>(SMASH_PRESET_AMOUNTS.strong);
  const [traits, setTraits] = useState<TraitAmounts>(DEFAULT_TRAIT_AMOUNTS);
  const [traitsOpen, setTraitsOpen] = useState<boolean>(false);
  const [colorization, setColorization] = useState<ColorizationToggleState>(DEFAULT_COLORIZATION_TOGGLES);
  const [colorizationOpen, setColorizationOpen] = useState<boolean>(false);
  const [exportStatus, setExportStatus] = useState<string>("");
  const loadedRef = useRef<boolean>(false);

  // Debounced saver — created once per component lifetime.
  const saverRef = useRef<((s: SmashPersisted) => void) | null>(null);
  if (!saverRef.current) saverRef.current = makeSmashSaver(500);

  // Mount: restore persisted amount + trait amounts. Layer ids are managed
  // by the parent. Missing trait keys fall back to DEFAULT_TRAIT_AMOUNTS so
  // older save files load cleanly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = await loadSmashSettings();
      if (cancelled) return;
      if (typeof persisted?.amount === "number" && Number.isFinite(persisted.amount)) {
        setAmount(Math.max(0, Math.min(1, persisted.amount)));
      }
      if (persisted?.traits && typeof persisted.traits === "object") {
        const t = persisted.traits;
        // Trait values can be in [0, 2] — values past 1 are oversample / crank
        // territory (extrapolate past literal CDF match). Hue stays in [0, 1]
        // because circular wrap-overshoot looks broken visually.
        const clampGate = (v: unknown, max: number): number | null =>
          typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : null;
        setTraits((prev) => ({
          value:      clampGate(t.value, 2)      ?? prev.value,
          hue:        clampGate(t.hue, 1)        ?? prev.hue,
          saturation: clampGate(t.saturation, 2) ?? prev.saturation,
          chroma:     clampGate(t.chroma, 2)     ?? prev.chroma,
          neutral:    clampGate(t.neutral, 1)    ?? prev.neutral,
          accent:     clampGate(t.accent, 1)     ?? prev.accent,
        }));
      }
      // v1.21 Phase 4.5 — restore colorization toggle state. Older save
      // files without it fall back to DEFAULT_COLORIZATION_TOGGLES (hueByLuma: true).
      if (persisted?.colorization && typeof persisted.colorization === "object") {
        const cz = persisted.colorization;
        setColorization((prev) => ({
          ...prev,
          ...(typeof cz.hueByLuma === "boolean" ? { hueByLuma: cz.hueByLuma } : {}),
        }));
      }
      loadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []);

  // Save amount + traits + colorization on change (debounced 500ms). Skip
  // until initial load resolved.
  useEffect(() => {
    if (!loadedRef.current) return;
    saverRef.current?.({ amount, traits, colorization });
  }, [amount, traits, colorization]);

  // ── Heavy: features + DNA + profile + CDF LUTs. Depends on SNAPS ONLY,
  // so slider drags don't re-run extractFeatures (~100K pixels per call)
  // four times AND don't rebuild the L/C/h CDFs each tick. The CDFs alone
  // were 200-400ms per slider tick before this; now they're computed ONCE
  // per snap change and reused on every drag.
  const snapDerived = useMemo(() => {
    if (!sourceSnap || !targetSnap) return null;
    const sourceDNA = extractSourceDNA(sourceSnap.data, sourceSnap.width, sourceSnap.height);
    const targetStructure = extractTargetStructure(targetSnap.data, targetSnap.width, targetSnap.height);
    const profile = pairDNA(sourceDNA, targetStructure);
    const sourceFeatures = extractFeatures(sourceSnap.data, sourceSnap.width, sourceSnap.height, 4);
    const targetFeatures = extractFeatures(targetSnap.data, targetSnap.width, targetSnap.height, 4);
    const cdfs = buildSmashCdfs(sourceFeatures, targetFeatures);
    return { sourceDNA, targetStructure, profile, sourceFeatures, targetFeatures, cdfs };
  }, [sourceSnap, targetSnap]);

  // ── Lighter: smash() invocation. Per slider tick — uses cached features
  // + profile + CDFs from above. The expensive build is now a no-op; smash()
  // just records the audit and returns the engine output. Sub-millisecond
  // per drag (vs. ~1s before this refactor).
  const pipeline = useMemo<EnginePipeline | null>(() => {
    if (!snapDerived) {
      onEngineChange?.(null);
      return null;
    }
    const controls = {
      ...DEFAULT_SMASH_CONTROLS,
      global: amount,
      traits,
      colorization,
    };
    const engine = smash(
      snapDerived.sourceFeatures,
      snapDerived.targetFeatures,
      snapDerived.profile,
      controls,
      snapDerived.cdfs,
    );
    onEngineChange?.(engine);
    return { sourceDNA: snapDerived.sourceDNA, engine };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapDerived, amount, traits, colorization]);

  const preset = detectPreset(amount);
  const onPresetChange = (next: SmashPreset) => setAmount(SMASH_PRESET_AMOUNTS[next]);

  // Track Smash LUT layer ids we've created. Default Apply replaces the most
  // recent one in place; "+" fork mode creates a new one and auto-hides the
  // prior. Stored in a ref (not state) because we want it to persist across
  // re-renders without triggering them.
  const smashLayerIdsRef = useRef<number[]>([]);

  const onApply = async () => {
    if (!pipeline) return;
    setExportStatus("applying…");
    try {
      // Default Apply: replace the most-recently-created Smash LUT in place.
      const replaceId = smashLayerIdsRef.current.length > 0
        ? smashLayerIdsRef.current[smashLayerIdsRef.current.length - 1]
        : null;
      const result = await applySmashLut(pipeline.engine, { replaceLayerId: replaceId });
      if (result.ok) {
        // Track the layer id (whether it's the same as before for replace
        // path, or a fresh one when the prior was deleted).
        if (typeof result.layerId === "number") {
          // Replace the most-recent entry rather than appending — there's
          // still only one active Smash LUT layer in the doc.
          const next = smashLayerIdsRef.current.slice();
          if (next.length > 0) next[next.length - 1] = result.layerId;
          else next.push(result.layerId);
          smashLayerIdsRef.current = next;
        }
        const verb = result.replacedInPlace ? "replaced" : "applied";
        setExportStatus(`${verb}: ${result.layerName ?? "Smash LUT"}`);
      } else {
        setExportStatus(`apply error: ${result.error ?? "unknown"}`);
      }
    } catch (err: any) {
      setExportStatus(`apply error: ${err?.message ?? err}`);
    }
  };

  // "+" fork mode — create a fresh Smash LUT alongside the prior one, and
  // hide the prior so the doc isn't cluttered with concurrent overlays. The
  // user can toggle the prior's visibility in PS's Layers panel to A/B.
  const onApplyFork = async () => {
    if (!pipeline) return;
    setExportStatus("forking…");
    try {
      const priorIds = smashLayerIdsRef.current.slice();
      const result = await applySmashLut(pipeline.engine, {
        replaceLayerId: null,         // force create-new path
        hidePriorIds: priorIds,        // auto-hide previous Smash variations
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

  const onExportCube = async () => {
    if (!pipeline) return;
    setExportStatus("baking…");
    try {
      const lut = bakeSmashLut(pipeline.engine, 33);
      const cubeText = serializeSmashCube(lut, "ColorSmash");
      // Lazy-load UXP storage so the test environment never touches it.
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

  const hasSnaps = sourceSnap !== null && targetSnap !== null;

  return (
    <div style={containerStyle}>
      {!hasSnaps && (
        <div style={placeholderStyle}>
          Pick a source and target layer to run Smash.
        </div>
      )}

      {hasSnaps && pipeline && (
        <>
          <div style={sectionLabelStyle}>SOURCE DNA</div>
          <SourceDNAStrip bands={pipeline.sourceDNA.bands} height={36} />
        </>
      )}

      <SmashControlsBar
        amount={amount}
        preset={preset}
        onAmountChange={setAmount}
        onPresetChange={onPresetChange}
        disabled={!hasSnaps}
      />

      {/* Traits disclosure. Closed by default so the primary surface stays
          the one-big-knob + preset row. Opens to reveal six trait sliders
          (Value, Hue, Saturation, Chroma, Neutral, Accent). Phase 2a:
          Value + Neutral differentially affect the output; the others are
          recorded in the audit but no-op in applyTransform until Phase 2b. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div
          style={{ ...traitsHeaderStyle, flex: 1 }}
          onClick={() => setTraitsOpen((o) => !o)}
          title={traitsOpen ? "Hide trait sliders" : "Show trait sliders"}
        >
          <span style={{ width: 10, display: "inline-block", textAlign: "center" }}>
            {traitsOpen ? "▾" : "▸"}
          </span>
          <span>TRAITS</span>
        </div>
        {traitsOpen && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              setTraits(DEFAULT_TRAIT_AMOUNTS);
            }}
            title="Reset all trait sliders to defaults (value/hue/sat/chroma = 100%, neutral = 50%, accent = 0%)."
            style={resetButtonStyle}
          >
            ✕
          </div>
        )}
      </div>
      {traitsOpen && (
        <TraitSliders
          amounts={traits}
          onAmountsChange={setTraits}
          disabled={!hasSnaps}
        />
      )}

      {/* Phase 4.5+ — colorization toggles. Auto-detect grayscale targets and
          engage cross-dimensional inference when active toggles say so. The
          engine ignores the toggles for colorful targets (per-dimension CDF
          handles those correctly). Disclosure pattern matches TRAITS above. */}
      <div
        style={traitsHeaderStyle}
        onClick={() => setColorizationOpen((o) => !o)}
        title={colorizationOpen ? "Hide colorization toggles" : "Show colorization toggles (cross-dimensional mechanics for grayscale targets)"}
      >
        <span style={{ width: 10, display: "inline-block", textAlign: "center" }}>
          {colorizationOpen ? "▾" : "▸"}
        </span>
        <span>COLORIZATION</span>
      </div>
      {colorizationOpen && (
        <ColorizationToggles
          state={colorization}
          onChange={setColorization}
          disabled={!hasSnaps}
        />
      )}

      {hasSnaps && pipeline && (
        <>
          <div style={sectionLabelStyle}>SMASH AUDIT</div>
          <SmashAuditPanel
            audit={pipeline.engine.audit}
            bandCount={pipeline.engine.profile.bands.length}
          />
        </>
      )}

      {hasSnaps && (
        <div style={actionRowStyle}>
          <div
            style={pipeline ? primaryButtonStyle : primaryButtonDisabledStyle}
            onClick={onApply}
            title="Apply the Smash transform — replaces the most recent Smash LUT layer in place. Use [+] to fork a new layer alongside."
          >
            Apply
          </div>
          <div
            style={pipeline ? plusButtonStyle : plusButtonDisabledStyle}
            onClick={onApplyFork}
            title="Fork a new Smash LUT layer alongside the previous one — auto-hides prior Smash layers so the new one shows alone. Use to compare variations."
          >
            +
          </div>
          <div
            style={pipeline ? actionButtonStyle : actionButtonDisabledStyle}
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

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", marginTop: 2,
};

const traitsHeaderStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", marginTop: 2,
  cursor: "pointer", userSelect: "none",
};

// Coral ✕ reset, matching the shipped PaletteStrip reset glyph (#ff5050).
// Same width/height as the action buttons on the right cluster so it lines
// up visually with the rest of the panel's "destructive action" affordances.
const resetButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 17, height: 17,
  background: "#ff5050", color: "#fff",
  border: "1px solid #1a1a1a", borderRadius: 2,
  fontSize: 10, fontWeight: 700, lineHeight: 1,
  cursor: "pointer", userSelect: "none",
  flexShrink: 0,
};

const placeholderStyle: React.CSSProperties = {
  fontSize: 10, color: "#555", lineHeight: 1.4,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, marginTop: 4,
};

const actionButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#ddd", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 12px", fontFamily: "inherit", fontSize: 11,
  cursor: "pointer", userSelect: "none", display: "inline-block",
};

const actionButtonDisabledStyle: React.CSSProperties = {
  ...actionButtonStyle,
  opacity: 0.4, cursor: "default",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#6ab7ff", color: "#0f1620", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 14px", fontFamily: "inherit", fontSize: 11,
  fontWeight: 600, cursor: "pointer", userSelect: "none", display: "inline-block",
};

const primaryButtonDisabledStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  opacity: 0.4, cursor: "default",
};

const plusButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#6ab7ff", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 0", fontFamily: "inherit", fontSize: 14,
  fontWeight: 700, cursor: "pointer", userSelect: "none", display: "inline-flex",
  alignItems: "center", justifyContent: "center", width: 28, lineHeight: 1,
};

const plusButtonDisabledStyle: React.CSSProperties = {
  ...plusButtonStyle,
  opacity: 0.4, cursor: "default",
};

const statusStyle: React.CSSProperties = {
  fontSize: 9, color: "#888", minWidth: 56, textAlign: "right",
};
