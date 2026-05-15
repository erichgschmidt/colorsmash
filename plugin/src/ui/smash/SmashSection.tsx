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
  bakeTargetPerPixel,
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
  /** Fired when the user clicks Test Bake. The parent should display the
   *  pixels in the matched preview tile so the user can A/B against the
   *  current LUT-based preview (which the parent will restore on the next
   *  engine change). Receives a Uint8Array of RGBA bytes plus dimensions. */
  onTestBake?: (pixels: Uint8Array, width: number, height: number) => void;
}

// ────────── internal pipeline type ──────────

interface EnginePipeline {
  sourceDNA: SourceDNA;
  engine: SmashEngineOutput;
}

// ────────── component ──────────

export function SmashSection(props: SmashSectionProps): JSX.Element {
  const { sourceSnap, targetSnap, onEngineChange, onTestBake } = props;

  const [amount, setAmount] = useState<number>(SMASH_PRESET_AMOUNTS.strong);
  const [traits, setTraits] = useState<TraitAmounts>(DEFAULT_TRAIT_AMOUNTS);
  const [traitsOpen, setTraitsOpen] = useState<boolean>(false);
  const [colorization, setColorization] = useState<ColorizationToggleState>(DEFAULT_COLORIZATION_TOGGLES);
  const [colorizationOpen, setColorizationOpen] = useState<boolean>(false);
  // Phase 4.5c — Passes: how many times applyTransform iterates per pixel
  // during the LUT bake. 1 = default (single transform). 2-3 emulates the
  // "stale-preview multi-pass" look the user accidentally discovered when
  // the panel snap captured a post-LUT version of the target layer. 4 is
  // the engine clamp ceiling.
  const [passes, setPasses] = useState<number>(1);
  // Phase 4.5g — Proportion match: 1.0 = tight (per-L lift, mirrors source's
  // color/neutral structure), 0.0 = loose (global median lift, uniform
  // colorization). Slider lerps between the two regimes.
  const [proportionMatch, setProportionMatch] = useState<number>(1.0);
  // Phase 4.5h — Posterize: 0 = off (engine's smooth output), 1 = full snap
  // (each output pixel is the nearest source CLUSTER's RGB by L distance).
  // Produces bold L-banded posterized output at high values.
  const [posterize, setPosterize] = useState<number>(0);
  // Phase 4.5i — Distribution: soft Gaussian-weighted cluster blend in
  // joint Oklab space, frequency-weighted by cluster population. 0 = off,
  // 1 = full lerp to weighted cluster mean. Smooth alternative to posterize.
  const [distribution, setDistribution] = useState<number>(0);
  // Phase 4.5j — Zone routing trio:
  //   clusterCount: number of source clusters (3..32). Re-extracts SourceDNA
  //                 when changed since clusters are computed during extraction.
  //   zoneInfluence: how strongly the zone path replaces the default
  //                  Hue-by-L for routed pixels.
  //   detailRichness: within the zone path, how much intra-cluster
  //                   variation is preserved (centroid vs sub-LUT).
  const [clusterCount, setClusterCount] = useState<number>(5);
  const [zoneInfluence, setZoneInfluence] = useState<number>(0);
  const [detailRichness, setDetailRichness] = useState<number>(1);
  // Phase 4.5k — zoneRatio modulates cluster weight distribution.
  // Range -1..+1, default 0 (natural). −1 flattens; +1 amplifies dominance.
  // Stored in state as -100..+100 (slider int) for UI; converted to float
  // before passing to the engine.
  const [zoneRatio, setZoneRatio] = useState<number>(0);
  // Phase 4.5m — temperature: warm/cool shift applied to output Oklab (a, b).
  // Range -1..+1, default 0 (no shift). −1 = full cool, +1 = full warm.
  const [temperature, setTemperature] = useState<number>(0);
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
      // files missing individual keys fall back to DEFAULT_COLORIZATION_TOGGLES.
      if (persisted?.colorization && typeof persisted.colorization === "object") {
        const cz = persisted.colorization;
        setColorization((prev) => ({
          ...prev,
          ...(typeof cz.hueByLuma === "boolean" ? { hueByLuma: cz.hueByLuma } : {}),
          ...(typeof cz.liftNeutrals === "boolean" ? { liftNeutrals: cz.liftNeutrals } : {}),
          ...(typeof cz.paletteSnap === "boolean" ? { paletteSnap: cz.paletteSnap } : {}),
        }));
      }
      // v1.21 Phase 4.5c — restore Passes (clamped to [1, 4], fractional OK).
      // Older save files written when passes was integer-only still load fine
      // since integer values are valid floats too.
      if (typeof persisted?.passes === "number" && Number.isFinite(persisted.passes)) {
        setPasses(Math.max(1, Math.min(4, persisted.passes)));
      }
      // v1.21 Phase 4.5g — restore Proportion match (clamped to [0, 1]).
      if (typeof persisted?.proportionMatch === "number" && Number.isFinite(persisted.proportionMatch)) {
        setProportionMatch(Math.max(0, Math.min(1, persisted.proportionMatch)));
      }
      // v1.21 Phase 4.5h — restore Posterize (clamped to [0, 1]).
      if (typeof persisted?.posterize === "number" && Number.isFinite(persisted.posterize)) {
        setPosterize(Math.max(0, Math.min(1, persisted.posterize)));
      }
      // v1.21 Phase 4.5i — restore Distribution (clamped to [0, 1]).
      if (typeof persisted?.distribution === "number" && Number.isFinite(persisted.distribution)) {
        setDistribution(Math.max(0, Math.min(1, persisted.distribution)));
      }
      // v1.21 Phase 4.5j — restore zone routing trio (clusterCount int 3..32,
      // zoneInfluence + detailRichness floats [0, 1]).
      if (typeof persisted?.clusterCount === "number" && Number.isFinite(persisted.clusterCount)) {
        setClusterCount(Math.max(3, Math.min(32, Math.round(persisted.clusterCount))));
      }
      if (typeof persisted?.zoneInfluence === "number" && Number.isFinite(persisted.zoneInfluence)) {
        setZoneInfluence(Math.max(0, Math.min(1, persisted.zoneInfluence)));
      }
      if (typeof persisted?.detailRichness === "number" && Number.isFinite(persisted.detailRichness)) {
        setDetailRichness(Math.max(0, Math.min(1, persisted.detailRichness)));
      }
      if (typeof persisted?.zoneRatio === "number" && Number.isFinite(persisted.zoneRatio)) {
        setZoneRatio(Math.max(-1, Math.min(1, persisted.zoneRatio)));
      }
      if (typeof persisted?.temperature === "number" && Number.isFinite(persisted.temperature)) {
        setTemperature(Math.max(-1, Math.min(1, persisted.temperature)));
      }
      loadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []);

  // Save amount + traits + colorization + passes + proportionMatch +
  // posterize + distribution + zone trio on change (debounced 500ms).
  // Skip until initial load resolved.
  useEffect(() => {
    if (!loadedRef.current) return;
    saverRef.current?.({
      amount, traits, colorization, passes, proportionMatch, posterize, distribution,
      clusterCount, zoneInfluence, detailRichness, zoneRatio, temperature,
    });
  }, [amount, traits, colorization, passes, proportionMatch, posterize, distribution, clusterCount, zoneInfluence, detailRichness, zoneRatio, temperature]);

  // ── Heavy: features + DNA + profile + CDF LUTs. Depends on SNAPS ONLY,
  // so slider drags don't re-run extractFeatures (~100K pixels per call)
  // four times AND don't rebuild the L/C/h CDFs each tick. The CDFs alone
  // were 200-400ms per slider tick before this; now they're computed ONCE
  // per snap change and reused on every drag.
  const snapDerived = useMemo(() => {
    if (!sourceSnap || !targetSnap) return null;
    // clusterCount drives source/target DNA k-means; cdfs uses the resulting
    // clusters to build per-cluster sub-LUTs for the zone-routing path.
    const sourceDNA = extractSourceDNA(sourceSnap.data, sourceSnap.width, sourceSnap.height, { clusterCount });
    const targetStructure = extractTargetStructure(targetSnap.data, targetSnap.width, targetSnap.height, { clusterCount });
    const profile = pairDNA(sourceDNA, targetStructure);
    const sourceFeatures = extractFeatures(sourceSnap.data, sourceSnap.width, sourceSnap.height, 4);
    const targetFeatures = extractFeatures(targetSnap.data, targetSnap.width, targetSnap.height, 4);
    const cdfs = buildSmashCdfs(sourceFeatures, targetFeatures, sourceDNA.clusters);
    return { sourceDNA, targetStructure, profile, sourceFeatures, targetFeatures, cdfs };
  }, [sourceSnap, targetSnap, clusterCount]);

  // ── Lighter: smash() invocation. Per slider tick — uses cached features
  // + profile + CDFs from above. The expensive build is now a no-op; smash()
  // just records the audit and returns the engine output. Sub-millisecond
  // per drag (vs. ~1s before this refactor).
  const pipeline = useMemo<EnginePipeline | null>(() => {
    if (!snapDerived) return null;
    const controls = {
      ...DEFAULT_SMASH_CONTROLS,
      global: amount,
      traits,
      // proportionMatch lives on colorization in the engine schema, so merge
      // it in here rather than carrying it around as a separate field.
      colorization: { ...colorization, proportionMatch, posterize, distribution, zoneInfluence, detailRichness, zoneRatio, temperature },
      passes,
    };
    const engine = smash(
      snapDerived.sourceFeatures,
      snapDerived.targetFeatures,
      snapDerived.profile,
      controls,
      snapDerived.cdfs,
    );
    return { sourceDNA: snapDerived.sourceDNA, engine };
  }, [snapDerived, amount, traits, colorization, passes, proportionMatch, posterize, distribution, zoneInfluence, detailRichness, zoneRatio, temperature]);

  // Propagate engine changes to the parent via useEffect, NOT inside the
  // useMemo body above. Calling setState on the parent during a child's
  // render is an anti-pattern: React 18 either drops the update or defers
  // it, and on subsequent renders the memo returns its cached value
  // without re-firing the side effect — so a colorization toggle that
  // changed the memo never reached `smashEngine` upstream. Symptom: the
  // preview hung on the previous toggle state until a refresh changed the
  // snap ref and forced an unrelated re-render. This effect runs after
  // commit and fires every time the pipeline reference changes.
  useEffect(() => {
    onEngineChange?.(pipeline?.engine ?? null);
    // onEngineChange is intentionally excluded — it's a stable setState
    // ref from useState in the parent and would be a closure-cycle hazard
    // if treated as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

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

  // Test Bake — diagnostic: render the engine's per-pixel ground-truth output
  // (no LUT, no interpolation, no grid quantization) into the panel preview.
  // The user A/Bs against the LUT-applied PS canvas to see whether the
  // canvas's deviation from the panel preview is the LUT's fidelity loss vs
  // the engine's intent. Any subsequent engine change (slider/toggle) reverts
  // the preview to the live LUT path automatically.
  const onTestBakeClick = () => {
    if (!pipeline || !targetSnap || !onTestBake) return;
    setExportStatus("baking test image…");
    try {
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const baked = bakeTargetPerPixel(
        pipeline.engine,
        targetSnap.data,
        targetSnap.width,
        targetSnap.height,
      );
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      onTestBake(baked, targetSnap.width, targetSnap.height);
      setExportStatus(`test bake shown (${Math.round(t1 - t0)} ms — touch any control to revert)`);
    } catch (err: any) {
      setExportStatus(`test bake error: ${err?.message ?? err}`);
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

      {/* Passes slider (Phase 4.5c, refined to continuous in 4.5e). Inline
          because it's a small, primary intensity knob. 1.0× = one transform
          per pixel (current default). Fractional values lerp between
          consecutive integer-pass results — 1.5× is halfway between
          single-apply and double-apply behavior. Range capped at 3.0× in
          the UI because anything past ~2× is usually visibly over-the-top;
          the engine clamp ceiling is 4 for direct callers. */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>PASSES</span>
        <input
          type="range"
          min={100}
          max={300}
          step={5}
          value={Math.round(passes * 100)}
          onChange={(e) => setPasses(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Drag for fine control over how many times the transform compounds per pixel. 1.0× = single pass (default). 1.5× lands halfway between single and double apply. Past 2× is usually over the top."
        />
        <span style={passesValueStyle}>{passes.toFixed(2)}×</span>
      </div>

      {/* Phase 4.5g — Proportion match. Same inline-slider vocabulary as
          PASSES. 100% (tight, default) makes the lift floor track source's
          per-L chroma magnitude — the output's color/neutral RATIO mirrors
          source's structure (dark stays dark, chromatic stays chromatic).
          0% (loose) uses source's GLOBAL median for every L — every near-
          neutral pixel gets the same lift regardless of where it sits in
          the source's L→C structure (more uniform "everything colorizes"
          look). Has no effect when liftNeutrals is OFF (no lift to
          compute). */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>PROPORTION</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(proportionMatch * 100)}
          onChange={(e) => setProportionMatch(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="How tightly the output's color/neutral ratio matches the source's. 100% (tight, default): lift floor uses source's chroma at the target's smashed L — dark areas of source come through dark, bright/chromatic areas come through chromatic. 0% (loose): lift floor uses source's GLOBAL median chroma — uniform colorization across L, ignoring source's structure. Affects only when Lift Neutrals is on."
        />
        <span style={passesValueStyle}>{Math.round(proportionMatch * 100)}%</span>
      </div>

      {/* Phase 4.5h — Posterize. Lerps the final RGB toward the nearest
          source CLUSTER's full RGB (matched by L distance — dark target
          pixels → dark cluster, highlights → bright cluster, etc.). 0% =
          off (default, smooth engine output). 100% = full snap (output
          IS the cluster's RGB), producing bold L-banded posterized
          coloration using only the source's actual palette colors.
          Different from paletteSnap (which only re-aims hue direction):
          posterize replaces the entire pixel L+a+b. */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>POSTERIZE</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(posterize * 100)}
          onChange={(e) => setPosterize(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Snap output pixels to the nearest source CLUSTER's full color (RGB, not just hue) — matched by L distance. 0% = off (smooth output). 100% = full snap, hard posterize into N source-derived bands. Different from Palette Snap (which only re-aims hue direction); Posterize replaces the entire pixel color."
        />
        <span style={passesValueStyle}>{Math.round(posterize * 100)}%</span>
      </div>

      {/* Phase 4.5i — Distribution. Soft Gaussian-weighted blend across
          ALL source clusters in joint Oklab (L+a+b) space. Each cluster's
          contribution is weighted by both gaussian proximity to the input
          pixel AND the cluster's population (frequency in source). Result
          is smooth (no banding, unlike posterize) but naturally emphasizes
          source's high-density modes (unlike per-dim CDFs which treat L,
          C, h independently). This is the "color smash with structure"
          knob the user asked for. */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>DISTRIBUTION</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(distribution * 100)}
          onChange={(e) => setDistribution(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Smooth-blend the output toward source's joint color distribution. For each pixel, all source clusters contribute weighted by (gaussian proximity in Oklab) × (cluster population). Result emphasizes source's high-frequency modes WITHOUT the banding of Posterize. Different from per-dim CDFs (which treat L, C, h independently); Distribution respects the joint distribution where source's pixels actually co-occur. 0% = off, 100% = full lerp to weighted cluster mean."
        />
        <span style={passesValueStyle}>{Math.round(distribution * 100)}%</span>
      </div>

      {/* Phase 4.5j — Zone routing trio. ZONES sets how many source palette
          buckets exist (re-extracts DNA on change — slight pause). INFLUENCE
          sets how strongly the per-cluster path overrides default Hue-by-L.
          DETAIL sets, within the zone path, how much intra-cluster L→(a,b)
          variation is preserved (0 = cluster's centroid, 1 = cluster's own
          sub-LUT). */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>ZONES</span>
        <input
          type="range"
          min={3}
          max={32}
          step={1}
          value={clusterCount}
          onChange={(e) => setClusterCount(parseInt((e.target as HTMLInputElement).value, 10))}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Number of source palette zones (clusters) used by the zone-routing path. 3 = very coarse (Subtle / Balanced / Vivid groupings); 32 = fine-grained (smooth transitions). Changing this re-extracts the source DNA (~50ms pause). Default 5."
        />
        <span style={passesValueStyle}>{clusterCount}</span>
      </div>

      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>INFLUENCE</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(zoneInfluence * 100)}
          onChange={(e) => setZoneInfluence(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="How strongly the zone-routed path overrides the default Hue-by-L for each pixel. 0% = off. 100% = each pixel's hue and chroma magnitude come entirely from its source cluster's contribution. 100–200% = OVERDRIVE: hue over-rotates past the zone's hue and Csm overshoots past the zone's chroma magnitude, exaggerating the cluster's character. Use DETAIL to control how much intra-cluster variation comes through."
        />
        <span style={passesValueStyle}>{Math.round(zoneInfluence * 100)}%</span>
      </div>

      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>DETAIL</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(detailRichness * 100)}
          onChange={(e) => setDetailRichness(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Inside the zone path, how much intra-cluster L→(a,b) variation is preserved. 0% = cluster's CENTROID (flat color within zone). 100% = cluster's own Hue-by-L sub-LUT (preserves the source's value→color variation within each zone). Only takes effect when INFLUENCE > 0."
        />
        <span style={passesValueStyle}>{Math.round(detailRichness * 100)}%</span>
      </div>

      {/* Phase 4.5k — Zone Ratio. Modulates the source clusters' weight
          distribution. Affects every mechanic that reads cluster.weight
          (today: Distribution). Slider stores -100..+100 ints for UI
          tidiness; we map to a -1..+1 float when passing to the engine. */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>ZONE RATIO</span>
        <input
          type="range"
          min={-100}
          max={100}
          step={5}
          value={Math.round(zoneRatio * 100)}
          onChange={(e) => setZoneRatio(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Modulates source's cluster weights. 0% (default) = natural distribution. NEGATIVE = flatten (minority colors get more equal voice in the Distribution blend). POSITIVE = amplify dominance (high-population clusters dominate even more). Affects mechanics that read cluster.weight (currently DISTRIBUTION)."
        />
        <span style={passesValueStyle}>{zoneRatio >= 0 ? "+" : ""}{Math.round(zoneRatio * 100)}%</span>
      </div>

      {/* Phase 4.5m — Temperature. Final-pass warm/cool shift in Oklab
          (a, b). Pure global bias applied after all structure-aware
          mechanics. Cool drift toward blue/green; warm drift toward
          red/yellow. ±100% ≈ 30-byte channel shift on neutral inputs. */}
      <div style={passesRowStyle}>
        <span style={passesLabelStyle}>TEMPERATURE</span>
        <input
          type="range"
          min={-100}
          max={100}
          step={5}
          value={Math.round(temperature * 100)}
          onChange={(e) => setTemperature(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
          disabled={!hasSnaps}
          style={passesSliderStyle}
          title="Relative warm/cool migration. 0% = no shift. POSITIVE = warm slider: cool pixels migrate TOWARD NEUTRAL (desaturate along the warm axis). At +100% cool pixels reach neutral gray. NEGATIVE = cool slider: warm pixels migrate toward neutral. At ±100% pixels never cross into opposite color (no literal green/blue tint) — the perception of cool/warm emerges from CONTRAST with un-migrated pixels, not by injecting opposite hue. Same-polarity pixels are always untouched."
        />
        <span style={passesValueStyle}>{temperature >= 0 ? "+" : ""}{Math.round(temperature * 100)}%</span>
      </div>

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
            style={pipeline && onTestBake ? actionButtonStyle : actionButtonDisabledStyle}
            onClick={onTestBakeClick}
            title="Diagnostic: render the engine's per-pixel ground-truth output (no LUT, no interpolation) into the panel preview. A/B against the LUT-applied PS canvas to see whether the LUT is losing fidelity vs the engine's intent. Touch any control to revert to the live LUT preview."
          >
            Test Bake
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

// Passes slider — small inline row with a label, native range slider, and
// numeric readout. Slider min/max in 0.01 units (100..300 → 1.00×..3.00×)
// because <input type="range"> wants integer values for clean step behavior.
const passesRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  marginTop: -2, // tuck under the controls bar
};

const passesLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase",
};

const passesSliderStyle: React.CSSProperties = {
  flex: 1, height: 14,
};

const passesValueStyle: React.CSSProperties = {
  fontSize: 10, color: "#aaa", fontVariantNumeric: "tabular-nums",
  minWidth: 38, textAlign: "right",
};
