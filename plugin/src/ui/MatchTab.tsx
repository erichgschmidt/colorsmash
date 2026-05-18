// Color Match: fits per-channel R/G/B Curves so target's histograms match source's.
// Source = a layer in the active doc, OR a snapshot of the active marquee selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { CurvesGraph } from "./CurvesGraph";
import { Icon } from "./Icon";
import { MatchedPreview, MatchedPreviewHandle } from "./MatchedPreview";
import { SourceSelector } from "./SourceSelector";
import { PresetStrip } from "./PresetStrip";
import { PaletteStrip, PaletteCount } from "./PaletteStrip";
import { extractPalette, synthesizeWeightedSource, computeClusterDistances, precomputeEffectiveWeights, PaletteSwatch } from "../core/palette";
import { uxpConfirm } from "./uxpConfirm";
import { BasicSlider, DimSlider, matchStyles } from "./MatchSliders";
import { ChannelCurves } from "../core/histogramMatch";
import {
  processChannelCurves, applyChannelCurvesToRgba, applyChannelCurvesToRgbaWeighted, applyChromaOnly, applyLutPreviewToRgba,
  applyDimensions, applyZoneAndEnvelopeToChannels, MERGED_LAYER_ID,
  transformCurvesForPreset, applyPresetPostprocess, generateLutCube,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
  computeLumaBins, lumaRange,
  EnvelopePoint, DEFAULT_ENVELOPE,
  fitByMode, MatchMode, Preset,
  // v1.20.70 — multi-zone math fully removed from histogramMatch.ts
  // alongside the UI retirement.
  lerpCurvesTowardIdentity,
} from "../core/histogramMatch";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { loadSettings, makeDebouncedSaver, clearSettings, PersistedSettings } from "./persistence";
import { uxpInfo } from "./uxpInfo";
import { applyMatch } from "../app/applyMatch";
import { applyLutAsAdjustmentLayer } from "../app/applyLut";
import { updateMatchCurvesLayerInPlace } from "../app/liveCurvesUpdate";
import { LutLayerState, readLutLayerState, stampState } from "../app/lutXmp";
import {
  HistoryEntry, makeHistoryEntry, pushHistoryEntry, pruneHistory, togglePinnedEntry, renameHistoryEntry,
  dedupKey,
} from "../app/recentHistory";
import { serializeRecipes, parseRecipes, mergeImportedRecipes } from "../app/recipeIO";
import { buildStarterRecipes } from "../app/starterRecipes";
import { ModeToggle, type SmashMode } from "./smash/ModeToggle";
import { SmashSection } from "./smash/SmashSection";
import { bakeEngineLut, type SmashEngine, type EngineLut } from "../core/smash/engine";
import { rgbaToPngDataUrl } from "./encodePng";

const STARTER_PACK_VERSION = 1;
import { lutGradientCSS } from "../app/historyThumbnail";
import { syncOutputVisibilityToMode, repositionGroupAboveTarget } from "../app/outputVisibility";
import {
  app, action as psAction, readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds, readSelectionMaskBytes,
  branchColorSmashGroup,
  consolidateColorSmashGroups,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const SOURCE_MAX_EDGE = 256;
type SrcMode = "layer" | "selection" | "folder";

interface SourceSnap { width: number; height: number; data: Uint8Array; name: string; }

export function MatchTab() {
  // Stale indicator — flips true when any PS event fires (layer rename, doc switch, paint,
  // etc.). User clicks ⟳ to refresh + clear. No live polling; everything is manual.
  const [stale, setStale] = useState(false);
  // Source and target each have their own doc — fully independent. Source can come from
  // doc A while target lives in doc B. Both default to PS's active doc on first mount.
  const [srcDocId, setSrcDocId] = useState<number | null>(null);
  const [tgtDocId, setTgtDocId] = useState<number | null>(null);
  const { layers: srcLayers, refresh: refreshSrcLayers } = useLayers(srcDocId);
  const { layers: tgtLayers, refresh: refreshTgtLayers } = useLayers(tgtDocId);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const smoothRef = useRef(0);
  const stretchRef = useRef(8);
  const [chromaOnly, setChromaOnly] = useState(false);
  const [anchorStretchToHist, setAnchorStretchToHist] = useState(false);
  // Match mode: full-distribution (default), mean shift, median shift, or percentile-anchored.
  // Lighter modes are gentler — useful when full-histogram match feels over-aggressive.
  const [matchMode, setMatchMode] = useState<MatchMode>("full");
  // v1.20.70 — multi-zone output (beta) retired. The per-output-mode
  // tabConfig (Multi + Blend If per RGB/Lab/LUT tab) is gone along with
  // adaptiveBands and multiExpanded. Multi was never publicly shipped,
  // so no saved files affected. Persistence load silently ignores legacy
  // multi-related keys (multiZone, multiZoneLimit, tabConfig, adaptiveBands).
  // Quick-select preset — staged in the UI, applied to the matched preview live, baked
  // into PS when the user hits Apply Curves. Defaults to "color" (full match) so the
  // initial behavior matches v1.0.
  const [activePreset, setActivePreset] = useState<Preset>("color");
  // Palette swatch count (3 / 5 / 7). Persisted across sessions.
  const [paletteCount, setPaletteCount] = useState<PaletteCount>(5);
  // Adaptive drag mode: when true, dragging a handle keeps the other swatches'
  // ratio intact by scaling them all proportionally. When false (default), only
  // the two neighbors of the dragged handle redistribute. Persisted.
  const [paletteAdaptive, setPaletteAdaptive] = useState(false);
  // Falloff between cluster regions, 0..100. 0 = hard nearest-cluster boundaries
  // (existing behavior), >0 = gaussian-soft blend across all clusters → smooth
  // gradients in the mask / soft histogram contribution. Source and target each
  // get their own slider since they affect different math (fit vs apply).
  // Persisted.
  const [sourceSoftness, setSourceSoftness] = useState(0);
  const [targetSoftness, setTargetSoftness] = useState(0);
  // Target-palette mask active toggle. When ON (default), the target weights
  // produce per-pixel attenuation in BOTH the preview (via the weighted apply
  // path) AND the bake (via a layer mask on the Curves adjustment). When OFF,
  // the mask is bypassed in both — preview shows curves uniformly, bake
  // outputs a Curves layer with no mask. Lets the user toggle the mask
  // contribution on/off and see both states. Default true so existing
  // behavior is preserved on first load.
  const [targetMaskEnabled, setTargetMaskEnabled] = useState(true);
  // Per-cluster weights (1 = neutral, 0 = excluded, >1 = boosted). Reset on every
  // source/count change since clusters change identity. NOT persisted — different
  // sources produce different clusters and stale weights would be confusing.
  const [paletteWeights, setPaletteWeights] = useState<number[]>([]);
  // Target-side palette: same UI/mechanics as source but the weights modulate
  // CURVE APPLICATION strength per cluster rather than fit contribution. Drag
  // a target cluster's weight to 0 → that cluster's pixels pass through
  // unchanged (the match curves don't apply there). Replaces the previous
  // 1D-luma Zones tab with a more intuitive color-based control.
  const [targetPaletteWeights, setTargetPaletteWeights] = useState<number[]>([]);
  const [amountLabel, setAmountLabel] = useState(100);
  const [smoothLabel, setSmoothLabel] = useState(0);
  const [stretchLabel, setStretchLabel] = useState(8);
  const [status, setStatus] = useState("Pick source + target.");

  const dimsRef = useRef<DimensionOpts>({ ...DEFAULT_DIMENSIONS });
  const [dimsLabel, setDimsLabel] = useState<DimensionOpts>({ ...DEFAULT_DIMENSIONS });

  const zonesRef = useRef<ZoneOpts>({ ...DEFAULT_ZONES });
  const [zonesLabel, setZonesLabel] = useState<ZoneOpts>({ ...DEFAULT_ZONES });
  // v1.20.70 — lockZoneTotal state removed alongside the multi-zone UI cleanup.

  const envelopeRef = useRef<EnvelopePoint[]>([...DEFAULT_ENVELOPE]);
  const [envelopeLabel, setEnvelopeLabel] = useState<EnvelopePoint[]>([...DEFAULT_ENVELOPE]);

  const [srcMode, setSrcMode] = useState<SrcMode>("layer");
  const [srcOverride, setSrcOverride] = useState<SourceSnap | null>(null);
  // v1.20.13 — recipe-synthesized source snapshot, declared early so the
  // srcSnap derivation below can reference it. See the long comment near
  // the recipeMode state for the full rationale.
  const [recipeSrcSnap, setRecipeSrcSnap] = useState<SourceSnap | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [sampleMerged, setSampleMerged] = useState(false);
  const [sampleLock, setSampleLock] = useState(false);
  const sampleLockRef = useRef(false);
  useEffect(() => { sampleLockRef.current = sampleLock; }, [sampleLock]);

  // Browse Image source: pick a single image file from disk; loads as srcOverride.
  const [browsedFile, setBrowsedFile] = useState<string>("");

  const onBrowseImage = async () => {
    setStatus("Picking image...");
    try {
      const uxp = require("uxp");
      const file = await uxp.storage.localFileSystem.getFileForOpening({
        types: ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp"],
      });
      if (!file) { setStatus("Cancelled."); return; }
      const { app, action: psA } = require("photoshop");
      const snap = await executeAsModal("Color Smash load image", async () => {
        const token = uxp.storage.localFileSystem.createSessionToken(file);
        const beforeId = app.activeDocument?.id ?? null;
        await psA.batchPlay([{ _obj: "open", null: { _path: token } }], {});
        const opened = app.activeDocument;
        if (!opened || opened.id === beforeId) throw new Error("Open failed.");
        const bg = opened.backgroundLayer ?? opened.layers[opened.layers.length - 1];
        const buf = await readLayerPixels(bg, undefined, opened.id);
        const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
        try { await opened.closeWithoutSaving(); } catch { /* ignore */ }
        return { width: small.width, height: small.height, data: small.data, name: file.name };
      });
      setSrcOverride(snap);
      setSrcMode("folder");
      setBrowsedFile(file.name);
      setStatus(`Source = ${file.name}`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };
  // Output mode — the unified successor to the old colorSpace toggle.
  // - "rgb": separable per-channel R/G/B curves → Curves adjustment layer
  // - "lab": perceptual L*a*b* histogram match (curves projected to R/G/B) → Curves layer
  // - "lut": non-separable 3D transform with preset blend math baked in → Color Lookup layer
  // The 3-way control lives under the target palette softness slider so the
  // selector sits next to the destination it modifies. Apply button dispatches
  // to either applyMatch (RGB/Lab) or applyLutAsAdjustmentLayer (LUT) based on mode.
  const [outputMode, setOutputMode] = useState<"rgb" | "lab" | "lut">("rgb");
  // v1.20.70 — multi-zone output retired entirely. The setters that
  // routed Multi/BlendIf into a per-tab `tabConfig` slot are gone now
  // along with the tabConfig state itself. Multi was never publicly
  // shipped so no persisted state needs migrating.
  // Derived alias for places that still operate on the legacy "rgb" | "lab"
  // pair (fitByMode, applyMatch's colorSpace param). LUT mode fits in RGB since
  // the curves are then trilinearly sampled into a 3D LUT regardless.
  const colorSpace: "rgb" | "lab" = outputMode === "lut" ? "rgb" : outputMode;

  // LUT-specific knobs (v1.17.0).
  //   lutStrength: 0..100. Lerps the generated LUT toward an identity LUT
  //     before bake — 100 = full transform, 0 = no-op. Differs from PS layer
  //     opacity because the lerp is baked INTO the LUT, so .cube exports
  //     carry the dialed-back look.
  //   lutGrid: 17 | 33 | 65. 17³ = draft (~50KB), 33³ = standard, 65³ = high
  //     quality (~3.3MB). Higher grid = less banding in subtle gradients,
  //     slower to bake / bigger files.
  //   lutDither: PS's colorLookup.dither field — injects noise to hide
  //     quantization banding. Default ON, mirrors PS's own default.
  const [lutStrength, setLutStrength] = useState(100);
  const [lutGrid, setLutGrid] = useState<17 | 33 | 65>(33);
  const [lutDither, setLutDither] = useState(true);
  // v1.20.63 — lutAdvancedOpen removed; Dither now shown inline.
  const [curvesGraphOpen, setCurvesGraphOpen] = useState(false);

  // Show Mask overlay (v1.18.x). When ON, the matched preview paints
  // protected regions (where the mask is LOW = LUT/Curves WON'T apply) with
  // a semi-transparent red wash. Convention matches PS's Quick Mask: red =
  // protected, clear = affected. Lets users SEE the composed mask
  // (palette × selection) before Apply, without manually inspecting masks.
  const [showMask, setShowMask] = useState(true);

  // Selection / marquee tristate (v1.18.0). At Apply time, if a marquee is
  // active in PS and mode is Focus/Exclude, the marquee becomes the layer
  // mask (composed with the target-palette mask if both are active).
  //
  // Mutual exclusion (v1.19.3): when srcMode === "selection", the marquee
  // is being used as the SOURCE pixel input — reusing it as an OUTPUT mask
  // simultaneously creates an ambiguous mental model. We auto-treat the
  // marquee tristate as "off" while source mode is selection (no UI lock
  // — just an effective override), and the pill row visually dims to
  // signal it's inactive.
  const [selectionMode, setSelectionMode] = useState<"off" | "focus" | "exclude">("off");

  // Recent-history ring buffer (v1.20.0). Every successful Apply pushes a
  // snapshot of the panel state. UI shows the last N (default 5) as small
  // palette-strip thumbnails near the Apply area; click an entry to restore.
  // Stored in PersistedSettings so the history survives panel reloads.
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>([]);
  // v1.20.66 — track which starter-pack version this user is on so we don't
  // re-inject every reload. Loaded from persistence; if absent the next
  // save writes it.
  const [starterPackVersion, setStarterPackVersion] = useState(0);
  // v1.20.70 — multiExpanded state removed alongside the Multi/Blend UI retirement.
  // v1.20.70 — Settings drawer state + persisted prefs.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<{ general: boolean; lut: boolean; advanced: boolean; diag: boolean }>({
    general: true, lut: false, advanced: false, diag: false,
  });
  const [groupColor, setGroupColor] = useState<"none" | "red" | "orange" | "yellow" | "green" | "blue" | "violet" | "gray">("orange");
  const [groupName, setGroupName] = useState<string>("[Color Smash]");
  const [autoDebounceMs, setAutoDebounceMs] = useState<number>(300);
  const [historyCap, setHistoryCap] = useState<number>(10);
  const [verboseStatus, setVerboseStatus] = useState<boolean>(false);
  // v1.20.70 — was a hard-coded const 10; now driven by the Settings
  // drawer's `historyCap` slider (range 5–30, persisted).
  const HISTORY_MAX = historyCap;
  // Default open in v1.20.1 — feedback was that the collapsed disclosure
  // was easy to miss, and the strip is small enough to live exposed.
  // v1.20.70 — collapse defaults: only OUTPUT opens by default. All
  // other optional sections (TRANSFORM / MASK / HISTORY / FITTED
  // CURVES) start collapsed so the panel boots compact; click a
  // section header ▾/▸ to reveal. Source / Target islands have no
  // toggle (always visible — they're the input surface).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const [transformOpen, setTransformOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  // v1.20.3 — when set to an entry id, the thumbnail's title area swaps to
  // a small text input for renaming. Pinned entries only; recents use the
  // auto-generated label. Saved on blur / Enter; canceled on Escape.
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  // Effective value used by Apply pipeline + buildXmpState. When source
  // mode is "selection," force "off" so the source marquee isn't double-
  // duty as an output mask. The raw `selectionMode` state preserves the
  // user's last choice for when they switch source mode away from selection.
  const effectiveSelectionMode: "off" | "focus" | "exclude" =
    srcMode === "selection" ? "off" : selectionMode;

  // v1.20.19 — selection-aware preview compositing.
  // selectionPreviewMask is one byte per preview pixel (0..255, where 255 =
  // fully inside the marquee). Read from PS via imaging.getSelection at the
  // target snap's source bounds, downsampled to the preview resolution by
  // nearest-neighbor. Refresh triggers: target snap reference change,
  // selectionMode change, or PS notification (user redrew the marquee).
  // Used to mask both the matched preview render AND the MASK overlay,
  // so users can see the focus/exclude effect before baking.
  const [selectionPreviewMask, setSelectionPreviewMask] = useState<Uint8Array | null>(null);
  const [selectionMaskError, setSelectionMaskError] = useState<string>("");
  const [selectionTick, setSelectionTick] = useState(0);
  // Listen to PS 'set' notifications and bump the ticker — covers marquee
  // drag commits, deselect, modify selection, etc. Throttled to ~150ms so
  // a fast lasso drag doesn't fire dozens of reads in flight.
  useEffect(() => {
    if (effectiveSelectionMode === "off") return;
    let scheduled: any = null;
    const onSet = () => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        setSelectionTick(t => t + 1);
      }, 150);
    };
    try { psAction.addNotificationListener(["set"], onSet); } catch { /* ignore */ }
    return () => {
      if (scheduled) clearTimeout(scheduled);
      try { psAction.removeNotificationListener?.(["set"], onSet); } catch { /* ignore */ }
    };
  }, [effectiveSelectionMode]);

  // Remember the last Curves-flavor mode so the SWAP pill can flip between
  // LUT and the user's preferred Curves space (RGB or Lab). Toggling out of
  // LUT goes back to whichever Curves mode was last active.
  const lastCurvesModeRef = useRef<"rgb" | "lab">("rgb");
  useEffect(() => {
    if (outputMode === "rgb" || outputMode === "lab") {
      lastCurvesModeRef.current = outputMode;
    }
  }, [outputMode]);

  // Mode-switch visibility sync (v1.15.1). When outputMode flips, walk the
  // [Color Smash] group and toggle Match Curves vs Match LUT layer visibility
  // so what's showing in PS matches what the panel is editing — no manual
  // eye-icon clicking. Skips first run to avoid spurious modal scopes on
  // panel mount. The effect runs INSIDE executeAsModal already (helper
  // wraps), so the React effect just kicks it off without await ceremony.
  const visSyncFirstRunRef = useRef(false);
  useEffect(() => {
    if (!visSyncFirstRunRef.current) { visSyncFirstRunRef.current = true; return; }
    syncOutputVisibilityToMode(outputMode).catch(() => { /* non-fatal */ });
  }, [outputMode]);

  // Reposition the [Color Smash] group above the new target whenever the
  // user picks a different target layer. Keeps the existing Curves/LUT
  // outputs anchored above whatever the user is now editing — without this,
  // switching targets leaves the group orphaned in its previous location.
  // Skipped on first run (mount) so picking up a saved targetId doesn't
  // jolt the layer panel before the user has even interacted.
  const reposFirstRunRef = useRef(false);
  useEffect(() => {
    if (!reposFirstRunRef.current) { reposFirstRunRef.current = true; return; }
    if (targetId == null || targetId === MERGED_LAYER_ID) return;
    repositionGroupAboveTarget(targetId).catch(() => { /* non-fatal */ });
  }, [targetId]);

  // v1.20.45 — onSwapMode removed with the SWAP pill. Clicking the
  // RGB/Lab/LUT pills directly already fires visibility sync.
  // v1.20.25 — deselectOnApply removed. See applyMatch.ts for context.
  const [overwriteOnApply, setOverwriteOnApply] = useState(true);
  const [remember, setRemember] = useState(false);

  // Auto-restore: when ON, selecting any Match LUT layer in PS's Layers
  // panel auto-rehydrates the panel state from that layer's XMP. Mirrors
  // ChromaWarp's "click the layer to keep editing where you left off"
  // model. Off by default — opt-in because it can clobber in-progress
  // edits if the user is mid-tweak and clicks a different layer to inspect.
  // v1.20.43 — AUTO removed (silently mutating panel state on layer-click was
  // surprising and most users left it off). RESTORE stays as a manual action.
  // `canRestore` tracks whether the active layer has Color Smash XMP so the
  // RESTORE button can dim itself when there's nothing to recover — teaches
  // users the feature exists by enabling it precisely when it's useful.
  const [canRestore, setCanRestore] = useState(false);
  // Suppress auto-restore for a short window after we ourselves wrote a
  // layer's XMP. Apply LUT creates the layer → PS fires a select event for
  // it → without suppression we'd immediately restore from the layer we
  // just wrote (no-op visually, but adds a redundant modal scope + status
  // line). The ref holds the timestamp of the last self-write.
  const lastSelfWriteRef = useRef<number>(0);

  // Live LUT mode: when ON, every state commit (debounced) re-bakes the .cube
  // and replaces the LUT data inside the existing Match LUT layer instead of
  // waiting for the user to hit Apply LUT. Mirrors ChromaWarp's "every change
  // updates the layer in real-time" workflow. Off by default — opt-in because
  // it modifies a PS layer continuously while the user adjusts sliders, which
  // is a stronger contract than the one-shot Apply button.
  const [liveLut, setLiveLut] = useState(false);
  // v1.20.68 — isolation toggle. When on, all top-level layers in the
  // target doc except the target's ancestor chain and the [Color Smash]
  // group are hidden, giving the user a quick "see just the matched
  // result" view. Snapshot of prior visibility is stored in a ref so we
  // can flip back cleanly. Toggling off restores the saved state.
  const [isolated, setIsolated] = useState(false);
  const isolationSnapshotRef = useRef<Map<number, boolean> | null>(null);
  const liveLutLayerIdRef = useRef<number | null>(null);
  // v1.20.70 — when the user clicks a different output-mode tab (RGB/Lab/LUT),
  // we want to (a) swap mode and (b) fire Apply for the new mode. Because the
  // fit + renderedCurves pipeline runs through useMemo + state, we can't just
  // call onApply synchronously after setOutputMode — the curves for the new
  // mode haven't been computed yet. Instead we set this flag and let an
  // effect that depends on [outputMode, renderedCurves] fire Apply once both
  // have settled into the new mode.
  const pendingApplyRef = useRef(false);
  // (liveUpdates and stale state declared above, before the hooks that consume them.)

  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | "envelope" | null>(null);
  // Per-section enable toggles: when off, that section's params revert to defaults at apply
  // time, letting the user A/B-test the contribution of each section without losing settings.
  const [enColor, setEnColor] = useState(true);
  const [enTone, setEnTone] = useState(true);
  // v1.20.70 — enZones state removed. The Zones accordion UI was already
  // dead-code-gated since v1.8, and the toggle is unreachable. Apply paths
  // now use `zonesRef.current` directly (always-on, defaults to neutral if
  // no saved zones).
  const [enEnvelope, setEnEnvelope] = useState(true);
  const toggleSection = (s: "basic" | "dims" | "zones" | "envelope") => setOpenSection(o => o === s ? null : s);
  // ─── Persistence ───────────────────────────────────────────────────────────
  // Load once on mount. Always read the file so we know whether 'remember' was on
  // last session; only restore the rest of the state if it was. After load,
  // set up a debounced saver that fires on any persisted state change while
  // remember=true.
  const loadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      if (!s) { loadedRef.current = true; return; }
      // Always restore the toggle itself so users don't have to re-enable it.
      setRemember(!!s.remember);
      if (s.remember) {
        if (s.amount != null) { amountRef.current = s.amount; setAmountLabel(s.amount); }
        if (s.smooth != null) { smoothRef.current = s.smooth; setSmoothLabel(s.smooth); }
        if (s.stretch != null) { stretchRef.current = s.stretch; setStretchLabel(s.stretch); }
        if (s.anchorStretchToHist != null) setAnchorStretchToHist(s.anchorStretchToHist);
        if (s.matchMode) setMatchMode(s.matchMode as MatchMode);
        // v1.20.70 — multi-zone retired. Legacy `tabConfig`, `multiZone`,
        // `multiZoneLimit`, `adaptiveBands`, and `multiExpanded` persistence
        // reads are dropped here. Multi was never publicly shipped so no
        // user saves are affected.
        if (s.paletteCount === 3 || s.paletteCount === 5 || s.paletteCount === 7) setPaletteCount(s.paletteCount);
        if (s.paletteAdaptive != null) setPaletteAdaptive(s.paletteAdaptive);
        if (typeof s.sourceSoftness === "number") setSourceSoftness(Math.max(0, Math.min(100, s.sourceSoftness)));
        if (typeof s.targetSoftness === "number") setTargetSoftness(Math.max(0, Math.min(100, s.targetSoftness)));
        if (typeof s.targetMaskEnabled === "boolean") setTargetMaskEnabled(s.targetMaskEnabled);
        if (s.chromaOnly != null) setChromaOnly(s.chromaOnly);
        // Back-compat: pre-v1.15.0 settings stored `colorSpace: "rgb" | "lab"`.
        // Newer settings store `outputMode` (one of "rgb" | "lab" | "lut").
        if (s.outputMode === "rgb" || s.outputMode === "lab" || s.outputMode === "lut") {
          setOutputMode(s.outputMode);
        } else if (s.colorSpace === "rgb" || s.colorSpace === "lab") {
          setOutputMode(s.colorSpace);
        }
        // v1.17.0 LUT knobs
        if (typeof s.lutStrength === "number") setLutStrength(Math.max(0, Math.min(100, s.lutStrength)));
        if (s.lutGrid === 17 || s.lutGrid === 33 || s.lutGrid === 65) setLutGrid(s.lutGrid);
        if (typeof s.lutDither === "boolean") setLutDither(s.lutDither);
        if (s.selectionMode === "off" || s.selectionMode === "focus" || s.selectionMode === "exclude") {
          setSelectionMode(s.selectionMode);
        }
        // v1.20.0 — restore recent-history ring buffer. pruneHistory drops
        // malformed entries from older saves and clamps to max.
        if (Array.isArray(s.recentHistory)) {
          setRecentHistory(pruneHistory(s.recentHistory, HISTORY_MAX));
        }
        // v1.20.66 — track which starter pack version this install has seen.
        if (typeof s.starterPackVersion === "number") setStarterPackVersion(s.starterPackVersion);
        // v1.20.70 — Settings-drawer prefs.
        if (s.groupColor && ["none","red","orange","yellow","green","blue","violet","gray"].includes(s.groupColor)) {
          setGroupColor(s.groupColor as any);
        }
        if (typeof s.groupName === "string" && s.groupName.trim().length > 0) setGroupName(s.groupName);
        if (typeof s.autoDebounceMs === "number" && s.autoDebounceMs >= 60 && s.autoDebounceMs <= 1000) setAutoDebounceMs(s.autoDebounceMs);
        if (typeof s.historyCap === "number" && s.historyCap >= 5 && s.historyCap <= 30) setHistoryCap(s.historyCap);
        if (typeof s.verboseStatus === "boolean") setVerboseStatus(s.verboseStatus);
        // deselectOnApply removed in v1.20.25 — ignore any old persisted value.
        if (s.overwriteOnApply != null) setOverwriteOnApply(s.overwriteOnApply);
        if (s.openSection !== undefined) setOpenSection(s.openSection);
        if (s.zones) { zonesRef.current = { ...DEFAULT_ZONES, ...s.zones }; setZonesLabel({ ...DEFAULT_ZONES, ...s.zones }); }
        if (s.dimensions) { dimsRef.current = { ...DEFAULT_DIMENSIONS, ...s.dimensions }; setDimsLabel({ ...DEFAULT_DIMENSIONS, ...s.dimensions }); }
        if (s.envelope && Array.isArray(s.envelope) && s.envelope.length > 0) {
          envelopeRef.current = s.envelope as EnvelopePoint[];
          setEnvelopeLabel(s.envelope as EnvelopePoint[]);
        }
      }
      // v1.20.66 — first-run starter pack injection. If this install hasn't
      // seen the current starter pack version yet AND has no prior pinned
      // recipes (so we don't clobber a user's curated library), inject
      // the bundled set + mark this version as installed. starterPackVersion
      // saves on the next debounced persistence flush.
      const loadedVersion = (s && typeof s.starterPackVersion === "number") ? s.starterPackVersion : 0;
      if (loadedVersion < STARTER_PACK_VERSION) {
        setRecentHistory(prev => {
          const hasPinned = prev.some(e => e.pinned);
          if (hasPinned) return prev; // respect the user's curated state
          const starters = buildStarterRecipes();
          // Filter out any starter with an id that already exists (defensive
          // — handles weird reload states).
          const existingIds = new Set(prev.map(e => e.id));
          const fresh = starters.filter(s2 => !existingIds.has(s2.id));
          return [...fresh, ...prev];
        });
        setStarterPackVersion(STARTER_PACK_VERSION);
      }
      loadedRef.current = true;
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDebouncedRef = useRef<((s: PersistedSettings) => void) | null>(null);
  if (!saveDebouncedRef.current) saveDebouncedRef.current = makeDebouncedSaver(500);
  useEffect(() => {
    if (!loadedRef.current) return; // skip until initial load resolves
    const snapshot: PersistedSettings = {
      remember,
      amount: amountLabel, smooth: smoothLabel, stretch: stretchLabel,
      anchorStretchToHist, chromaOnly, colorSpace, outputMode, lutStrength, lutGrid, lutDither, selectionMode, matchMode,
      // v1.20.70 — multi-zone schema fields (multiZone, multiZoneLimit,
      // adaptiveBands, tabConfig, multiExpanded) removed from the saved
      // snapshot alongside the UI retirement.
      // v1.20.66 — once the starter pack has been injected, this prevents
      // re-injection on every reload.
      starterPackVersion,
      groupColor, groupName, autoDebounceMs, historyCap, verboseStatus,
      overwriteOnApply,
      openSection,
      zones: zonesLabel,
      dimensions: dimsLabel,
      envelope: envelopeLabel,
      paletteCount,
      paletteAdaptive,
      sourceSoftness,
      targetSoftness,
      targetMaskEnabled,
      recentHistory,
    };
    saveDebouncedRef.current!(snapshot);
  }, [remember, matchMode, starterPackVersion, groupColor, groupName, autoDebounceMs, historyCap, verboseStatus, amountLabel, smoothLabel, stretchLabel, anchorStretchToHist, chromaOnly,
      colorSpace, outputMode, lutStrength, lutGrid, lutDither, selectionMode, overwriteOnApply, openSection,
      zonesLabel, dimsLabel, envelopeLabel, paletteCount, paletteAdaptive, sourceSoftness, targetSoftness, targetMaskEnabled, recentHistory]);

  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  // Hash of doc id+name pairs. Used as the key on the doc <select> elements so that
  // when a doc gets renamed (Save As), React fully remounts the select rather than
  // patching it in place. UXP's native select widget caches the displayed option text
  // and won't repaint when only an <option>'s children change — only a fresh mount
  // picks up the new label. Same trick applied to layer <select>s below.
  const docsKey = useMemo(() => docs.map(d => `${d.id}:${d.name}`).join("|"), [docs]);
  const srcLayersKey = useMemo(() => srcLayers.map(l => `${l.id}:${l.name}`).join("|"), [srcLayers]);
  const tgtLayersKey = useMemo(() => tgtLayers.map(l => `${l.id}:${l.name}`).join("|"), [tgtLayers]);

  // Single source of truth for "re-read PS state into our React mirror". Splits into
  // two concerns:
  //   • readDocs():  re-read the doc list. Names-only by default (no pickFallback) so
  //                  background events never mutate srcDocId / tgtDocId / srcMode.
  //                  Mount path passes withFallback=true to seed the initial selection.
  //   • Layer refresh: deferred to useLayers' refresh() per side.
  // The doc <select>s + layer <select>s have docsKey/layersKey applied so any name
  // change forces a UXP widget remount — which is why we no longer need the doc-id
  // bounce that the old refreshSrcAll/refreshTgtAll did to clear UXP's label cache.
  const refreshDocsRef = useRef<(withFallback?: boolean) => void>(() => {});
  const refreshSrcLayersRef = useRef(refreshSrcLayers);
  const refreshTgtLayersRef = useRef(refreshTgtLayers);
  useEffect(() => { refreshSrcLayersRef.current = refreshSrcLayers; });
  useEffect(() => { refreshTgtLayersRef.current = refreshTgtLayers; });

  useEffect(() => {
    let cancelled = false;
    // Cache the last-applied docs list so we can skip setDocs when nothing changed.
    // Most "set" events change layer pixel data, not doc identity/name; without this
    // we'd produce a fresh array reference on every brush stroke and force a parent
    // re-render for no UI change. Compared by length + (id:name) tuples — cheap.
    let lastDocsKey = "";
    const readDocs = (withFallback = false) => {
      if (cancelled) return;
      try {
        const list = (app.documents ?? []).map((d: any) => ({ id: d.id, name: d.name }));
        const key = list.map((d: { id: number; name: string }) => `${d.id}:${d.name}`).join("|");
        if (key !== lastDocsKey) {
          lastDocsKey = key;
          setDocs(list);
        }
        if (withFallback) {
          // Auto-pick the active doc if nothing is selected yet, or if the previously
          // selected doc has been closed. Only on mount and explicit ⟳ — never on
          // background events, which is what caused the auto-swap-to-selection regression.
          const pickFallback = (prev: number | null) => {
            if (prev != null && list.some((d: { id: number }) => d.id === prev)) return prev;
            return app.activeDocument?.id ?? list[0]?.id ?? null;
          };
          setSrcDocId(pickFallback);
          setTgtDocId(pickFallback);
        }
      } catch { /* */ }
    };
    refreshDocsRef.current = readDocs;
    readDocs(true);  // mount: seed selection

    // Single consolidated listener — replaces 3 overlapping ones. Every event that
    // could change the doc list, layer list, or any name fires the same refresh path.
    // Sets stale=true so the ⟳ button shows a "something changed" affordance, then
    // re-reads docs (names-only) and re-pulls layer lists for both sides. The
    // docsKey/layersKey on the <select>s handle UXP widget label invalidation.
    //
    // Coalesced via a 60ms trailing debounce: PS fires events in bursts (a paint stroke
    // can produce 30+ "set" descriptors in 100ms). Without coalescing each one schedules
    // its own setDocs + 2 layer refreshes, all of which would be no-ops thanks to the
    // identity-skip above and useLayers' inflight guard — but they each still cost a
    // React render. Debouncing collapses bursts into one trailing refresh.
    //
    // Visibility-gated: when document.hidden is true (PS in another app or panel
    // collapsed), defer the work until visibility returns. UXP doesn't pause timers
    // on hidden panels, so this is real CPU we'd otherwise burn.
    const events = [
      "save", "rename", "set", "select", "make", "delete", "open", "close", "move",
      "duplicate", "paste", "rasterizeLayer", "groupLayer", "ungroupLayer",
      "mergeLayers", "mergeVisible", "historyStateChanged", "selectDocument",
    ];
    let burstTimer: any = null;
    let pendingWhileHidden = false;
    const flushRefresh = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        // Hidden: arm a flag; we'll flush on visibilitychange instead.
        pendingWhileHidden = true;
        return;
      }
      setStale(true);
      readDocs(false);
      try { refreshSrcLayersRef.current(); } catch { /* */ }
      try { refreshTgtLayersRef.current(); } catch { /* */ }
    };
    const scheduleRefresh = () => {
      if (burstTimer) clearTimeout(burstTimer);
      burstTimer = setTimeout(flushRefresh, 60);
    };
    const onEvt = () => scheduleRefresh();
    psAction.addNotificationListener(events, onEvt);
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden && pendingWhileHidden) {
        pendingWhileHidden = false;
        flushRefresh();
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (burstTimer) clearTimeout(burstTimer);
      psAction.removeNotificationListener?.(events, onEvt);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // ⟳ button: force-refresh path. Same data sources as the auto-refresh, but allows
  // pickFallback to repair a closed-doc selection. No more doc-id bounce — the
  // layersKey on the layer <select> takes care of UXP label cache invalidation, so
  // we don't need to drop+remount useLayers. Kept for the rare case where another
  // plugin's silent batch ops leave PS's descriptor cache stale and only a manual
  // re-read clears it.
  const refreshSrcAll = () => {
    refreshDocsRef.current(true);
    refreshSrcLayers();
  };
  const refreshTgtAll = () => {
    refreshDocsRef.current(true);
    refreshTgtLayers();
  };

  // Picking a doc in our dropdown is panel-only — we do NOT change PS's active document.
  // Source and target each have their own setter so they can point to different docs.
  const onSwitchSrcDoc = (id: number) => {
    if ((app.documents ?? []).find((x: any) => x.id === id)) setSrcDocId(id);
  };
  const onSwitchTgtDoc = (id: number) => {
    if ((app.documents ?? []).find((x: any) => x.id === id)) setTgtDocId(id);
  };

  // When source layers list changes (doc switch or refresh), pick a sensible default if the
  // current sourceId no longer exists in the new list. Bottom-most layer for source.
  useEffect(() => {
    if (srcLayers.length > 0 && (sourceId == null || !srcLayers.find(l => l.id === sourceId))) {
      setSourceId(srcLayers[srcLayers.length - 1].id);
    }
  }, [srcLayers]); // eslint-disable-line react-hooks/exhaustive-deps
  // Same for target layers — top-most layer for target.
  useEffect(() => {
    if (tgtLayers.length > 0 && (targetId == null || !tgtLayers.find(l => l.id === targetId))) {
      setTargetId(tgtLayers[0].id);
    }
  }, [tgtLayers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(srcDocId, srcMode === "layer" ? sourceId : null);
  const tgt = useLayerPreview(tgtDocId, targetId);

  // v1.20.19 — read the PS selection at the target snap's source bounds and
  // downsample to preview resolution by nearest-neighbor. Stored as one byte
  // per preview pixel (0..255). Cleared when selectionMode is "off" or
  // there's no snap.
  useEffect(() => {
    const snap = tgt.snap;
    if (effectiveSelectionMode === "off" || !snap || tgtDocId == null) {
      setSelectionPreviewMask(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Prefer the snap's canvas-space bounds (so the selection mask
        // aligns with the exact pixels the preview is showing). Fall back
        // to the active doc's bounds if the snap was created by an older
        // useLayerPreview version that didn't return bounds.
        let bounds = snap.bounds;
        if (!bounds) {
          try {
            const doc = (app.documents ?? []).find((d: any) => d.id === tgtDocId);
            if (doc) bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
          } catch { /* ignore */ }
        }
        if (!bounds) { setSelectionPreviewMask(null); setSelectionMaskError("no target bounds available"); return; }
        // v1.20.22 — imaging.getSelection requires executeAsModal. Apply
        // already wraps its reads; the preview path didn't, so the call was
        // throwing silently and selectionPreviewMask stayed null forever.
        const full = await executeAsModal("Color Smash selection preview", async () => {
          return await readSelectionMaskBytes(tgtDocId, bounds!);
        });
        if (cancelled) return;
        if (!full) {
          setSelectionPreviewMask(null);
          setSelectionMaskError("imaging.getSelection returned null (no marquee on target doc, or unsupported)");
          return;
        }
        const srcW = (bounds.right - bounds.left) | 0;
        const srcH = (bounds.bottom - bounds.top) | 0;
        const dstW = snap.width;
        const dstH = snap.height;
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
          setSelectionPreviewMask(null);
          return;
        }
        // Nearest-neighbor downsample. Selection masks are binary-ish so
        // bilinear gains little, and NN keeps edges crisp.
        const out = new Uint8Array(dstW * dstH);
        for (let y = 0; y < dstH; y++) {
          const sy = Math.min(srcH - 1, Math.floor((y / dstH) * srcH));
          for (let x = 0; x < dstW; x++) {
            const sx = Math.min(srcW - 1, Math.floor((x / dstW) * srcW));
            out[y * dstW + x] = full[sy * srcW + sx];
          }
        }
        if (!cancelled) { setSelectionPreviewMask(out); setSelectionMaskError(""); }
      } catch (e: any) {
        if (!cancelled) {
          setSelectionPreviewMask(null);
          setSelectionMaskError(`error: ${e?.message ?? e}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveSelectionMode, tgt.snap, tgtDocId, selectionTick]);
  // v1.20.13 — recipe-synthesized source wins over both selection-mode
  // override and live src.snap. The recipe's swatch+weight distribution
  // IS the source while a recipe is active. Cleared automatically on
  // refocus events.
  const srcSnap = recipeSrcSnap ?? srcOverride ?? src.snap;

  // ─── Selection mode: snapshot from active marquee on active layer ───────
  const snapshotSelectionInner = async (): Promise<SourceSnap> => {
    return executeAsModal("Color Smash snap selection", async () => {
      const doc = getActiveDoc();
      const sel = getSelectionBounds();
      if (!sel) throw new Error("No active marquee selection.");
      let buf;
      let sourceName: string;
      if (sampleMerged) {
        // Read the merged composite within sel: imaging.getPixels with no layerID returns the doc composite.
        try {
          const { imaging } = require("photoshop");
          const result = await imaging.getPixels({ documentID: doc.id, sourceBounds: sel, componentSize: 8, applyAlpha: false, colorSpace: "RGB" });
          const id = result.imageData;
          const raw = await id.getData();
          const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const w = id.width, h = id.height;
          const components = id.components ?? (src.length / (w * h));
          const data = new Uint8Array(w * h * 4);
          if (components === 4) data.set(src);
          else for (let i = 0, j = 0; i < w * h; i++, j += 3) { const o = i * 4; data[o] = src[j]; data[o + 1] = src[j + 1]; data[o + 2] = src[j + 2]; data[o + 3] = 255; }
          if (id.dispose) id.dispose();
          buf = { width: w, height: h, data, bounds: sel };
          sourceName = "Composite (selection)";
        } catch (e: any) {
          throw new Error(`Merged sample failed (UXP version may not support compositeless getPixels): ${e?.message ?? e}`);
        }
      } else {
        const layer = doc.activeLayers?.[0];
        if (!layer) throw new Error("No active layer.");
        buf = await readLayerPixels(layer, sel, doc.id);
        sourceName = `${layer.name} (selection)`;
      }
      // Read the selection mask within the same bbox; bake it into the alpha channel
      // so non-selected pixels are excluded from the histogram fit.
      try {
        const { imaging } = require("photoshop");
        const maskResult = await imaging.getSelection({ documentID: doc.id, sourceBounds: sel });
        const maskRaw = await maskResult.imageData.getData();
        const mask = maskRaw instanceof Uint8Array ? maskRaw : new Uint8Array(maskRaw);
        const px = buf.data;
        for (let i = 0, m = 0; i < px.length; i += 4, m++) {
          px[i + 3] = mask[m] ?? 0;
        }
        if (maskResult.imageData.dispose) maskResult.imageData.dispose();
      } catch { /* fallback: use full bbox if mask read fails */ }
      const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
      return { width: small.width, height: small.height, data: small.data, name: sourceName };
    });
  };

  // Auto-update: re-snap on EITHER selection-bounds change OR PS pixel-changing events.
  const lastBoundsRef = useRef<string>("");
  const snapInFlightRef = useRef(false);
  // Ref the latest snapshot fn so the long-lived effect doesn't capture a stale closure.
  const snapshotFnRef = useRef(snapshotSelectionInner);
  useEffect(() => { snapshotFnRef.current = snapshotSelectionInner; });

  useEffect(() => {
    if (srcMode !== "selection" || !autoUpdate) return;
    let cancelled = false;
    // Debounce: only snap once bounds have been stable for SETTLE_MS. Prevents flicker
    // during a lasso draw — the user's pointer churns bounds every frame, but we wait
    // for them to actually let go (or pause) before doing the heavy pixel grab.
    const SETTLE_MS = 250;
    let settleTimer: any = null;
    const scheduleSnap = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(async () => {
        if (cancelled || snapInFlightRef.current || sampleLockRef.current) return;
        let bounds: any = null;
        try { bounds = getSelectionBounds(); } catch { /* */ }
        if (!bounds) return;
        snapInFlightRef.current = true;
        try { const snap = await snapshotFnRef.current(); if (!cancelled) setSrcOverride(snap); }
        catch { /* ignore transient auto-update failures */ }
        finally { snapInFlightRef.current = false; }
      }, SETTLE_MS);
    };
    // Cheap poll: just reads doc.selection.bounds. Schedules a debounced snap only when
    // the bounds key actually changes — no work if the marquee is sitting idle. Skipped
    // entirely when the panel/document is hidden (UXP doesn't pause timers in hidden
    // panels, so without this gate we'd burn cycles polling while the user is in another
    // app or the panel is collapsed behind a tab).
    const boundsTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      let bounds: any = null;
      try { bounds = getSelectionBounds(); } catch { /* */ }
      const key = bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : "";
      if (key !== lastBoundsRef.current) {
        lastBoundsRef.current = key;
        if (key) scheduleSnap();
      }
    }, 200);
    // PS pixel-changing events (paint/fill/etc): also debounced so a flurry of strokes
    // collapses into one snap. Bounds-change check skipped here since pixels can change
    // without bounds changing.
    const events = ["set", "make", "delete", "paste", "fill", "stroke", "move", "applyImage", "rasterizeLayer", "modifyLayerEffect"];
    const onPsEvent = () => scheduleSnap();
    psAction.addNotificationListener(events, onPsEvent);
    scheduleSnap(); // initial
    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearInterval(boundsTimer);
      psAction.removeNotificationListener?.(events, onPsEvent);
    };
  }, [srcMode, autoUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchSrcMode = (m: SrcMode) => {
    setSrcMode(m);
    if (m === "layer") { setSrcOverride(null); setBrowsedFile(""); }
  };

  // Saved-swatch fallback state (Phase 2c). When RESTORE pulls palette
  // swatches from a Match LUT layer's XMP, we stash them here so the palette
  // strips can show what the user was working with even when the original
  // source/target docs aren't open. Live srcSnap/tgt.snap always wins —
  // these only kick in when there's no live data.
  const [savedSourceSwatches, setSavedSourceSwatches] = useState<PaletteSwatch[] | null>(null);
  const [savedTargetSwatches, setSavedTargetSwatches] = useState<PaletteSwatch[] | null>(null);
  // v1.20.12 — when true, the loaded history recipe's palette (swatches +
  // weights) is the ACTIVE source palette. Live extraction is suppressed so
  // the panel UI (sliders, swatch chips) shows what the engine is actually
  // computing against, and Apply bakes against the recipe's clusters — not
  // whatever the live source layer happens to extract. Auto-clears on any
  // refocus event: source layer change, source mode change, Refresh button.
  const [recipeMode, setRecipeMode] = useState(false);
  // v1.20.14 — recipe display name, surfaced in the "Source: Preset" banner
  // above the source selector so the user always knows when their live source
  // layer is being bypassed in favor of a stored recipe.
  const [recipeLabel, setRecipeLabel] = useState<string>("");
  // recipeSrcSnap is declared earlier (near srcOverride) because the srcSnap
  // derivation references it. It holds the synthesized source pixel buffer
  // reconstructed from a recipe's swatches + weights, routing BEFORE
  // srcOverride so histogram match / palette extraction / curve derivation
  // all operate on the recipe's color distribution rather than the live
  // source layer's pixels.

  // Palette extraction lives at the parent level so weights can be wired into both
  // the PaletteStrip UI and the synthesized-weighted-source path that drives the
  // histogram match. Recomputes when source pixels or count change. Falls back
  // to a restored-from-XMP cached swatch list when no live source is available.
  // v1.20.10 — live srcSnap ALWAYS wins. Whatever the user is focusing on
  // (current source layer / selection) is the functional source. Recipe
  // loaded from history seeds weights/preset but lets the live source's
  // natural clusters drive synthesis — so re-focusing the panel (picking
  // a layer, refreshing, dragging a marquee) immediately takes effect
  // instead of being trapped behind a sticky recipe override.
  // savedSourceSwatches is only the cold-start fallback when no live
  // source exists yet (panel just opened against an XMP-tagged layer).
  const paletteSwatches = useMemo(() => {
    // v1.20.12 — recipe mode wins over live extraction. User explicitly
    // loaded a recipe; the panel should show that recipe's palette until
    // they refocus (auto-cleared by source-layer or srcMode change effects
    // below, or manually by Refresh).
    if (recipeMode && savedSourceSwatches && savedSourceSwatches.length > 0) return savedSourceSwatches;
    if (srcSnap) return extractPalette(srcSnap.data, srcSnap.width, srcSnap.height, paletteCount);
    if (savedSourceSwatches && savedSourceSwatches.length > 0) return savedSourceSwatches;
    return [];
  }, [srcSnap, paletteCount, savedSourceSwatches, recipeMode]);

  // v1.20.12 — auto-escape recipe mode when the user changes their source
  // focus. sourceId / srcMode are the canonical signals that "the user
  // wants their live source back."
  useEffect(() => {
    if (recipeMode) {
      setRecipeMode(false);
      setSavedSourceSwatches(null);
      setRecipeSrcSnap(null);
      setRecipeLabel("");
    }
    // Intentionally excludes recipeMode — we only want refocus events to
    // trigger the auto-clear, not the recipe-load itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, srcMode]);

  // Reset weights to all-1 (neutral) whenever the palette identity changes. Stale
  // weights from a previous source's clusters would be meaningless against a fresh
  // set of centroids. We trigger off swatches.length + the first swatch's centroid
  // (cheap proxy for "did the palette actually change") rather than re-running on
  // every re-render.
  const paletteIdentity = paletteSwatches.length > 0
    ? `${paletteSwatches.length}:${paletteSwatches[0].labL.toFixed(1)}:${paletteSwatches[0].labA.toFixed(1)}:${paletteSwatches[0].labB.toFixed(1)}`
    : "0";
  // v1.20.8 — when a recipe restore (history click or XMP restore) sets
  // sourcePaletteWeights, paletteCount may change which triggers a palette
  // identity change which would normally reset weights to all-1, clobbering
  // the recipe. This ref tells the reset effect to skip exactly one cycle.
  const skipNextWeightResetRef = useRef(false);
  useEffect(() => {
    // v1.20.12 — recipe mode owns the weights array; do NOT reset to neutral
    // just because the swatch list changed. The recipe's weights are bound
    // to the recipe's swatches and they arrive together via applyHistoryEntry.
    if (recipeMode) return;
    if (skipNextWeightResetRef.current) {
      skipNextWeightResetRef.current = false;
      return;
    }
    setPaletteWeights(paletteSwatches.map(() => 1));
  }, [paletteIdentity, recipeMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-pixel cluster assignment cache. Expensive (~3M ops at 256-edge: RGB→Lab
  // + nearest-centroid for every pixel) but only depends on srcSnap + palette
  // identity — NOT weights. Recompute only when one of those changes. Saves
  // ~95% of the synthesis cost during drag where weights change every
  // pointermove but assignments don't.
  const clusterDistances = useMemo(() => {
    if (!srcSnap || paletteSwatches.length === 0) return null;
    return computeClusterDistances(srcSnap.data, paletteSwatches);
  }, [srcSnap, paletteSwatches]);

  // Target-side palette + assignments. Same paletteCount drives both bars
  // (one count toggle for the user's mental model — N source clusters /
  // N target clusters in one number). Target weights default to all-1
  // (full match everywhere) so the existing behavior is preserved when the
  // user hasn't touched the target bar.
  const targetPaletteSwatches = useMemo(() => {
    if (tgt.snap) return extractPalette(tgt.snap.data, tgt.snap.width, tgt.snap.height, paletteCount);
    if (savedTargetSwatches && savedTargetSwatches.length > 0) return savedTargetSwatches;
    return [];
  }, [tgt.snap, paletteCount, savedTargetSwatches]);
  const targetClusterDistances = useMemo(() => {
    if (!tgt.snap || targetPaletteSwatches.length === 0) return null;
    return computeClusterDistances(tgt.snap.data, targetPaletteSwatches);
  }, [tgt.snap, targetPaletteSwatches]);
  const targetPaletteIdentity = targetPaletteSwatches.length > 0
    ? `${targetPaletteSwatches.length}:${targetPaletteSwatches[0].labL.toFixed(1)}:${targetPaletteSwatches[0].labA.toFixed(1)}:${targetPaletteSwatches[0].labB.toFixed(1)}`
    : "0";
  useEffect(() => {
    setTargetPaletteWeights(targetPaletteSwatches.map(() => 1));
  }, [targetPaletteIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weighted-source buffer: synthesized only when at least one weight diverges
  // from neutral. Otherwise the original srcSnap.data is passed through unchanged
  // (synthesizeWeightedSource has a fast path for the neutral case).
  const weightedSrcData = useMemo(() => {
    if (!srcSnap || !clusterDistances || paletteWeights.length !== paletteSwatches.length) {
      return srcSnap?.data ?? null;
    }
    // Fast path: weights neutral → no synthesis needed (would be identity).
    const isNeutral = !paletteWeights.some(w => Math.abs(w - 1) > 0.01);
    if (isNeutral) return srcSnap.data;
    // Precompute soft-blended per-pixel weight cache, then emit the weighted
    // buffer using just lookups. The expensive cluster math happens once here
    // instead of in synthesizeWeightedSource's inner loop, which keeps the
    // hot path cheap during interactive softness drags.
    const effective = precomputeEffectiveWeights(clusterDistances, paletteWeights, sourceSoftness);
    return synthesizeWeightedSource(srcSnap.data, effective, false);
  }, [srcSnap, clusterDistances, paletteSwatches.length, paletteWeights, sourceSoftness]);

  // Target-side per-pixel effective-weight cache. Computed asynchronously via
  // setTimeout(0) so the heavy per-pixel Lorentzian-blend math doesn't block
  // the synchronous render path. While this is pending, the slider thumb (in
  // PaletteStrip's local state) keeps tracking the cursor at full pointer
  // rate — only the preview redraw lags by one microtask + the compute time.
  //
  // Without the defer, useMemo ran the precompute INSIDE React render, which
  // means the slider thumb's repaint had to wait for ~10-15ms of math on
  // every commit. With non-neutral target weights, that visibly stutters.
  const [targetEffectiveWeights, setTargetEffectiveWeights] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!targetClusterDistances || targetPaletteWeights.length !== targetPaletteSwatches.length) {
      setTargetEffectiveWeights(null);
      return;
    }
    // setTimeout(0) yields to the browser so paint/UI tasks can land before
    // the precompute. cleanup cancels in-flight work if a newer commit
    // arrives — keeps the queue short.
    const id = setTimeout(() => {
      const ew = precomputeEffectiveWeights(targetClusterDistances, targetPaletteWeights, targetSoftness);
      setTargetEffectiveWeights(ew);
    }, 0);
    return () => clearTimeout(id);
  }, [targetClusterDistances, targetPaletteSwatches.length, targetPaletteWeights, targetSoftness]);

  const fittedRaw = useMemo(() => {
    if (!weightedSrcData || !tgt.snap) return null;
    return fitByMode(matchMode, weightedSrcData, tgt.snap.data, colorSpace);
  }, [weightedSrcData, tgt.snap, colorSpace, matchMode]);

  // Multi-zone band peaks. Adaptive (P10/P50/P90 of target luma) when toggle is on,
  // fixed at 0/128/255 otherwise. Adaptive peaks make each band fit on a similar
  // pixel-count sample, producing more reliable shadow + highlight curves on images
  // with concentrated histograms.

  // Luma-binned color stats from target pixels — used to color the zone band swatches with the
  // actual mean color of pixels at each luminance level. Recomputed only when target pixels change.
  const lumaBins = useMemo(() => tgt.snap ? computeLumaBins(tgt.snap.data) : null, [tgt.snap]);
  const sourceLumaBins = useMemo(() => srcSnap ? computeLumaBins(srcSnap.data) : null, [srcSnap]);

  // v1.20.70 — multi-zone derived values removed alongside the multi UI.
  // multiZonePeaks / multiZoneExtents / fittedMulti previously computed
  // band peaks + the 3-band fit. With multiZone always false, none of
  // those useMemos were consumed, so they're dropped to skip the work.
  // adaptiveBandPeaks / fitMultiZoneByMode / lumaRange remain in
  // core/histogramMatch.ts for unit-testability + recipe compat.

  // Matched preview is rendered by <MatchedPreview/>; we drive it imperatively via a handle.
  const matchedHandleRef = useRef<MatchedPreviewHandle | null>(null);
  const rafPendingRef = useRef(false);

  // v1.21 — Pro mode toggle. Lives below the matched preview, swaps the lower
  // control surface between Match (existing) and Smash (new Pro engine). State
  // is held regardless of __SMASH_ENABLED__ so refs into it from existing code
  // stay valid; the ModeToggle UI and SmashSection are gated separately. The
  // engine output flows back here so we can drive the matched preview through
  // the same MatchedPreview handle the Match path uses.
  const [smashMode, setSmashMode] = useState<SmashMode>("match");
  const [smashEngine, setSmashEngine] = useState<SmashEngine | null>(null);

  // v1.21 — small source-preview thumbnail rendered in the SOURCE island's
  // thumbnail slot when in Smash mode (replaces the Match-only PresetStrip +
  // source PaletteStrip). Pure raw source pixels, no preset transform —
  // visually confirms which layer the user just picked. Memoized on srcSnap
  // identity so flipping modes doesn't re-encode the PNG.
  const smashSourceThumbnailUrl = useMemo<string | null>(() => {
    if (!__SMASH_ENABLED__) return null;
    if (!srcSnap) return null;
    return rgbaToPngDataUrl(srcSnap.data, srcSnap.width, srcSnap.height);
  }, [srcSnap]);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  // Result pixels captured at the end of each redraw — feeds the diagnostic histogram overlay.
  // Throttled (only commits to state every ~150ms) so we don't thrash React during slider drags.
  const [resultPixels, setResultPixels] = useState<Uint8Array | null>(null);
  const resultLumaBins = useMemo(() => resultPixels ? computeLumaBins(resultPixels) : null, [resultPixels]);
  const resultTimeoutRef = useRef<any>(null);
  const resultPendingRef = useRef<Uint8Array | null>(null);
  const curvesPendingRef = useRef<ChannelCurves | null>(null);
  const curvesTimeoutRef = useRef<any>(null);

  const redrawMatched = () => {
    const tgtBuf = tgt.snap;
    if (!tgtBuf || !fittedRaw) return;
    // Handle ref may not be bound yet on first render — retry shortly.
    if (!matchedHandleRef.current) {
      setTimeout(() => redrawMatched(), 100);
      return;
    }
    // Section-enable: when a section is disabled, its params revert to defaults so the
    // user can see what the match would look like without that section's contribution.
    const stretchRange = enColor && anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined;
    const curveOpts = enColor ? {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
      stretchRange,
    } : { amount: 1, smoothRadius: 0, maxStretch: 999 };
    const dimOpts = enTone ? dimsRef.current : DEFAULT_DIMENSIONS;

    let out: Uint8Array;
    let curvesForGraph: ChannelCurves;

    // Target palette weighting: if any target cluster's weight diverges from 1
    // we use the per-pixel weighted apply (cluster blend strength); otherwise
    // the standard apply (bit-for-bit identical to v1.7 when target weights
    // are neutral, which they are by default).
    // Mask gate: when targetMaskEnabled is false, the user has explicitly
    // turned off the per-cluster attenuation. Preview falls back to uniform
    // curves application; bake skips the layer mask. Lets the user A/B-compare
    // the masked vs unmasked output in the same panel.
    const targetWeightsActive = targetMaskEnabled
      && targetEffectiveWeights != null
      && targetPaletteWeights.some(w => Math.abs(w - 1) > 0.01);

    // v1.20.70 — single-curve path only. Multi-zone preview branch
    // retired alongside the UI; the apply branches in
    // applyMatch.ts / applyLut.ts are unreachable from the panel now
    // (multiZone is hard-coded false). processMultiZoneFit /
    // applyMultiZoneToRgba still ship in core/histogramMatch.ts for
    // recipe compat, just no longer invoked from MatchTab.
    {
      const processed = processChannelCurves(fittedRaw, curveOpts);
      const dim = applyDimensions(processed, dimOpts);
      curvesForGraph = applyZoneAndEnvelopeToChannels(
        dim,
        zonesRef.current,
        enEnvelope ? envelopeRef.current : DEFAULT_ENVELOPE,
      );
      // Use weighted apply if target weights are non-neutral, else fast path.
      // The assignments were computed against tgt.snap (full-quality 256), and
      // tgtBuf may equal tgt.snap or be a downsampled version. When they differ
      // (legacy code path in earlier versions), the assignments wouldn't align —
      // here they always match because we removed the dual-resolution path.
      out = (targetWeightsActive && targetEffectiveWeights)
        ? applyChannelCurvesToRgbaWeighted(tgtBuf.data, curvesForGraph, targetEffectiveWeights)
        : applyChannelCurvesToRgba(tgtBuf.data, curvesForGraph);
    }

    curvesPendingRef.current = curvesForGraph;
    if (!curvesTimeoutRef.current) {
      curvesTimeoutRef.current = setTimeout(() => {
        curvesTimeoutRef.current = null;
        if (curvesPendingRef.current) setRenderedCurves(curvesPendingRef.current);
      }, 100);
    }
    if (enColor && chromaOnly) out = applyChromaOnly(tgtBuf.data, out);
    // Apply staged preset on top of everything else. Preset takes precedence: if it's
    // "color" it's a no-op; otherwise we transform the curves (avg for bw/contrast),
    // remap the target, then post-process (grayscale clamp, luma swap, etc.) so the
    // matched preview reflects exactly what Apply Curves will bake into PS.
    if (activePreset !== "color" && curvesForGraph) {
      const cP = transformCurvesForPreset(curvesForGraph, activePreset);
      // Mirror the target-weighting choice on the preset's separate apply pass
      // so cluster strength applies consistently regardless of preset.
      const mapped = (targetWeightsActive && targetEffectiveWeights)
        ? applyChannelCurvesToRgbaWeighted(tgtBuf.data, cP, targetEffectiveWeights)
        : applyChannelCurvesToRgba(tgtBuf.data, cP);
      out = applyPresetPostprocess(tgtBuf.data, mapped, activePreset);
    }
    // LUT-mode preview override (v1.15.0). When the output mode is LUT, what
    // the user will see in the baked Color Lookup adjustment layer differs
    // from the Curves preview above by 33³ quantization + trilinear interpolation.
    // applyLutPreviewToRgba samples each target pixel through the same in-memory
    // grid generateLutCube would write, so the preview matches the bake.
    // Target-weight attenuation is preserved by lerping toward the original.
    if (outputMode === "lut" && curvesForGraph) {
      // Preview matches what the bake produces: apply strength lerp first, then
      // pass through the LUT preview at the user's selected grid size.
      const previewCurves = lutStrength >= 100
        ? curvesForGraph
        : lerpCurvesTowardIdentity(curvesForGraph, lutStrength / 100);
      const lutOut = applyLutPreviewToRgba(tgtBuf.data, previewCurves, activePreset, lutGrid);
      if (targetWeightsActive && targetEffectiveWeights) {
        const orig = tgtBuf.data;
        const ew = targetEffectiveWeights;
        for (let i = 0, p = 0; i < lutOut.length; i += 4, p++) {
          const w = Math.max(0, Math.min(1, ew[p]));
          if (w >= 0.999) continue;
          if (w <= 0.001) {
            lutOut[i] = orig[i]; lutOut[i + 1] = orig[i + 1]; lutOut[i + 2] = orig[i + 2];
            continue;
          }
          lutOut[i]     = Math.round(orig[i]     + (lutOut[i]     - orig[i])     * w);
          lutOut[i + 1] = Math.round(orig[i + 1] + (lutOut[i + 1] - orig[i + 1]) * w);
          lutOut[i + 2] = Math.round(orig[i + 2] + (lutOut[i + 2] - orig[i + 2]) * w);
        }
      }
      out = lutOut;
    }
    // v1.20.19 — compose the selection mask into the preview BEFORE the
    // MASK overlay. When effectiveSelectionMode is "focus" or "exclude" and
    // we have a downsampled selection mask matching the preview, blend the
    // transformed pixels back toward the original outside the selection
    // (focus) or inside it (exclude). This mirrors what Apply will bake as
    // the layer mask, so users see the selection effect live.
    const selMask = selectionPreviewMask;
    if (
      effectiveSelectionMode !== "off" &&
      selMask &&
      selMask.length * 4 === out.length
    ) {
      const orig = tgtBuf.data;
      const invert = effectiveSelectionMode === "exclude";
      const composed = new Uint8Array(out);
      for (let i = 0, p = 0; i < composed.length; i += 4, p++) {
        let w = selMask[p] / 255;
        if (invert) w = 1 - w;
        if (w >= 0.999) continue;
        if (w <= 0.001) {
          composed[i]     = orig[i];
          composed[i + 1] = orig[i + 1];
          composed[i + 2] = orig[i + 2];
          continue;
        }
        composed[i]     = Math.round(orig[i]     + (composed[i]     - orig[i])     * w);
        composed[i + 1] = Math.round(orig[i + 1] + (composed[i + 1] - orig[i + 1]) * w);
        composed[i + 2] = Math.round(orig[i + 2] + (composed[i + 2] - orig[i + 2]) * w);
      }
      out = composed;
    }

    // Show Mask overlay (v1.18.x, v1.20.19). When toggled on, red-wash
    // regions where the composed mask is LOW (LUT/Curves will NOT apply
    // there). Convention matches PS Quick Mask: red = protected. The
    // composed mask now multiplies target-palette weight × selection
    // weight, so both palette-based protection AND marquee focus/exclude
    // are visualized together.
    const ew = targetEffectiveWeights;
    if (showMask && ew && ew.length * 4 === out.length) {
      // Mutate a fresh copy so toggling showMask off doesn't force a curves
      // recompute — out stays the un-overlaid version for cached redraw.
      const overlaid = new Uint8Array(out);
      const sel = selMask && selMask.length === ew.length ? selMask : null;
      const invert = effectiveSelectionMode === "exclude";
      for (let i = 0, p = 0; i < overlaid.length; i += 4, p++) {
        const paletteW = Math.max(0, Math.min(1, ew[p]));
        let selW = 1;
        if (sel && effectiveSelectionMode !== "off") {
          selW = sel[p] / 255;
          if (invert) selW = 1 - selW;
        }
        const composedW = paletteW * selW;
        // protectAmount = 1 - mask. 0 = fully applied (no red). 1 = fully
        // protected (max red).
        const protectAmount = 1 - composedW;
        if (protectAmount < 0.01) continue;
        // Lerp toward red (255, 40, 40) by 0.6 × protectAmount. Strong
        // enough to be visible against most images, not so strong that the
        // underlying preview disappears.
        const wash = protectAmount * 0.6;
        overlaid[i]     = Math.round(overlaid[i]     * (1 - wash) + 255 * wash);
        overlaid[i + 1] = Math.round(overlaid[i + 1] * (1 - wash) + 40  * wash);
        overlaid[i + 2] = Math.round(overlaid[i + 2] * (1 - wash) + 40  * wash);
      }
      matchedHandleRef.current.setPixels(overlaid, tgtBuf.width, tgtBuf.height);
    } else {
      matchedHandleRef.current.setPixels(out, tgtBuf.width, tgtBuf.height);
    }
    // Also push the unmodified target pixels so the preview's Before/After badge
    // can swap to the original on click/hold without a round-trip to the parent.
    matchedHandleRef.current.setBefore(tgtBuf.data, tgtBuf.width, tgtBuf.height);
    // Throttle result-pixel state updates so the diagnostic histogram doesn't re-render
    // on every slider tick — every ~150ms is plenty fast visually, and avoids React thrash.
    resultPendingRef.current = out;
    if (!resultTimeoutRef.current) {
      resultTimeoutRef.current = setTimeout(() => {
        resultTimeoutRef.current = null;
        if (resultPendingRef.current) setResultPixels(resultPendingRef.current);
      }, 150);
    }
  };

  // v1.21 — Smash-mode preview drive. Bakes a 33³ LUT once per engine change
  // (~36K applyTransform calls), then trilinear-interpolates per TARGET pixel
  // — same convention Match mode uses: the matched preview shows the TARGET
  // image with the transform applied, not the source. (Bug fix v1.21.x:
  // previous version mistakenly fed srcSnap into the lookup.)
  //
  // The preview LUT is 33³ to MATCH the Apply path's 33³ export grid — a 17³
  // preview quantized chroma coarsely enough that the in-panel preview looked
  // muted next to the Apply'd Color Lookup layer; 33³ closes that gap.
  //
  // "Before" = unmodified target pixels; "after" = LUT-applied target pixels.
  // Click/hold the Before/After badge on MatchedPreview to toggle.
  const smashPreviewLut = useMemo<EngineLut | null>(() => {
    if (!__SMASH_ENABLED__) return null;
    if (!smashEngine) return null;
    return bakeEngineLut(smashEngine, 33);
  }, [smashEngine]);

  useEffect(() => {
    if (!__SMASH_ENABLED__) return;
    if (smashMode !== "smash") return;
    if (!smashPreviewLut || !tgt.snap || !matchedHandleRef.current) return;
    const { width: w, height: h, data: tgtPixels } = tgt.snap;
    const lut = smashPreviewLut.values;
    const N = smashPreviewLut.size;
    const NM1 = N - 1;
    const out = new Uint8Array(tgtPixels.length);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const a = tgtPixels[o + 3];
      if (a < 128) {
        out[o] = tgtPixels[o]; out[o + 1] = tgtPixels[o + 1]; out[o + 2] = tgtPixels[o + 2]; out[o + 3] = a;
        continue;
      }
      // Trilinear lookup. bakeSmashLut writes r-fastest, b-slowest:
      //   index(ri, gi, bi) = (bi * N + gi) * N + ri
      // Triple offset = index * 3.
      const fr = (tgtPixels[o]     / 255) * NM1;
      const fg = (tgtPixels[o + 1] / 255) * NM1;
      const fb = (tgtPixels[o + 2] / 255) * NM1;
      const r0 = Math.floor(fr), r1 = r0 < NM1 ? r0 + 1 : r0;
      const g0 = Math.floor(fg), g1 = g0 < NM1 ? g0 + 1 : g0;
      const b0 = Math.floor(fb), b1 = b0 < NM1 ? b0 + 1 : b0;
      const dr = fr - r0, dg = fg - g0, db = fb - b0;
      const c000 = ((b0 * N + g0) * N + r0) * 3;
      const c100 = ((b0 * N + g0) * N + r1) * 3;
      const c010 = ((b0 * N + g1) * N + r0) * 3;
      const c110 = ((b0 * N + g1) * N + r1) * 3;
      const c001 = ((b1 * N + g0) * N + r0) * 3;
      const c101 = ((b1 * N + g0) * N + r1) * 3;
      const c011 = ((b1 * N + g1) * N + r0) * 3;
      const c111 = ((b1 * N + g1) * N + r1) * 3;
      let or = 0, og = 0, ob = 0;
      for (let ch = 0; ch < 3; ch++) {
        const v00 = lut[c000 + ch] + (lut[c100 + ch] - lut[c000 + ch]) * dr;
        const v10 = lut[c010 + ch] + (lut[c110 + ch] - lut[c010 + ch]) * dr;
        const v01 = lut[c001 + ch] + (lut[c101 + ch] - lut[c001 + ch]) * dr;
        const v11 = lut[c011 + ch] + (lut[c111 + ch] - lut[c011 + ch]) * dr;
        const v0 = v00 + (v10 - v00) * dg;
        const v1 = v01 + (v11 - v01) * dg;
        const v = v0 + (v1 - v0) * db;
        if (ch === 0) or = v; else if (ch === 1) og = v; else ob = v;
      }
      out[o]     = Math.max(0, Math.min(255, Math.round(or * 255)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(og * 255)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(ob * 255)));
      out[o + 3] = a;
    }
    matchedHandleRef.current.setPixels(out, w, h);
    matchedHandleRef.current.setBefore(tgtPixels, w, h);
  }, [smashMode, smashPreviewLut, tgt.snap]);

  // v1.21 — Mode-flip back to Match: nudge the existing Match preview pipeline
  // to re-fire so the user sees Match's output again. Without this, flipping
  // Smash → Match leaves the previously-pushed Smash pixels frozen until the
  // user touches a Match slider. scheduleRedraw is the same throttled entry
  // point Match's own state effects use, so the behavior matches normal
  // Match flow exactly.
  useEffect(() => {
    if (!__SMASH_ENABLED__) return;
    if (smashMode !== "match") return;
    scheduleRedraw();
  }, [smashMode]);

  const scheduleRedraw = () => {
    // 16ms throttle (~60fps). Drag latency is bounded by this throttle, not
    // by per-frame work — at 256² the synthesize → fit → curves → PNG encode
    // chain takes ~20-25ms, well under one frame. Tightening the throttle
    // from 33ms to 16ms is the actual lever for "feels more real-time" while
    // keeping full preview quality. requestAnimationFrame would be cleaner
    // here than setTimeout but UXP's RAF behavior under heavy load isn't
    // characterized — sticking with setTimeout for predictability.
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    setTimeout(() => { rafPendingRef.current = false; redrawMatched(); }, 16);
  };

  useEffect(() => {
    // Reset throttle so an in-flight no-op (from before snapshots loaded) doesn't block
    // this redraw — fixes "preview blank until I wiggle a slider" on first mount.
    rafPendingRef.current = false;
    scheduleRedraw();
    // targetEffectiveWeights captures the (distances, weights, softness)
    // memoized cache, so any change to those inputs invalidates it and
    // triggers a redraw with the fresh per-pixel weights.
    // targetMaskEnabled also in deps so toggling the mask gate redraws the
    // preview between masked and uniform application.
  }, [fittedRaw, tgt.snap, chromaOnly, anchorStretchToHist, enColor, enTone, enEnvelope, activePreset, targetEffectiveWeights, targetMaskEnabled, showMask, outputMode, lutStrength, lutGrid, selectionPreviewMask, effectiveSelectionMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Export the staged preset as a 33-grid 3D LUT in .CUBE format. Sidesteps the
  // unreliable PS Color Lookup API entirely — user picks a save location, we write
  // the file, they load it manually wherever they want (PS Color Lookup layer,
  // Premiere, Resolve, another tool). The LUT bakes the full preset behavior
  // including Color/Luminosity blend emulation that a Curves layer alone can't
  // express, so the file is a complete, portable representation of the look.
  const onExportLut = async () => {
    const curves = renderedCurves ?? curvesPendingRef.current;
    if (!curves) { setStatus("Compute a match first."); return; }
    setStatus("Exporting LUT...");
    try {
      const uxp = require("uxp");
      const presetLabel = activePreset === "color" ? "full"
                        : activePreset === "hue" ? "color"
                        : activePreset === "hueOnly" ? "hue"
                        : activePreset === "saturationOnly" ? "saturation"
                        : "contrast";
      const file = await uxp.storage.localFileSystem.getFileForSaving(`color-smash-${presetLabel}.cube`, { types: ["cube"] });
      if (!file) { setStatus("Export cancelled."); return; }
      const cube = generateLutCube(curves, activePreset, 33, "Color Smash");
      await file.write(cube, { format: uxp.storage.formats.utf8 });
      setStatus(`Exported ${file.name} (33³ LUT, ${presetLabel}).`);
    } catch (e: any) { setStatus(`LUT export error: ${e?.message ?? e}`); }
  };

  // Build the XMP fingerprint we attach to every Match LUT layer. Captures
  // the full panel state that produced the bake so Restore can hydrate the
  // UI back to it later. Doesn't include source pixels — Phase 2c will add
  // a tiny histogram-based fingerprint so the layer is fully self-contained.
  const buildXmpState = (): LutLayerState => stampState({
    preset: activePreset,
    matchMode,
    colorSpace,
    outputMode,
    paletteCount,
    sourcePaletteWeights: paletteWeights.slice(),
    targetPaletteWeights: targetPaletteWeights.slice(),
    sourceSoftness,
    targetSoftness,
    paletteAdaptive,
    dimensions: dimsRef.current,
    zones: zonesRef.current,
    envelope: envelopeRef.current,
    sourceDocId: srcDocId,
    sourceLayerId: sourceId,
    targetDocId: tgtDocId,
    targetLayerId: targetId,
    // Phase 2c source fingerprint — the actual k-means swatches at bake time.
    // With these saved on the layer, RESTORE on a closed-source doc still
    // shows the palette the user was working with, and weight changes can
    // apply against saved swatches even when the source pixels are gone.
    sourcePaletteSwatches: paletteSwatches.map(s => ({
      r: s.r, g: s.g, b: s.b, weight: s.weight,
      labL: s.labL, labA: s.labA, labB: s.labB,
    })),
    targetPaletteSwatches: targetPaletteSwatches.map(s => ({
      r: s.r, g: s.g, b: s.b, weight: s.weight,
      labL: s.labL, labA: s.labA, labB: s.labB,
    })),
    // v1.19.0 — LUT-output knobs + marquee selector saved in XMP. RESTORE
    // pulls these back so the panel re-creates the exact bake conditions
    // (grid, strength, dither, marquee mode) that produced this layer.
    lutStrength,
    lutGrid,
    lutDither,
    selectionMode: effectiveSelectionMode,
  }, "1.19.0");

  // Push the current panel state to the recent-history ring buffer. Called
  // by both Curves and LUT Apply success paths. Dedupe / immutable update
  // is handled inside pushHistoryEntry — multiple identical Applies in a
  // row won't spam the buffer.
  // v1.20.17 — history entries are SOURCE-ONLY recipes. Target state
  // (targetPaletteSwatches, targetPaletteWeights, targetSoftness, selectionMode)
  // is intentionally stripped before pushing — it's session-ephemeral and
  // changes per document. Keeping it in recipes made them confusing to
  // reuse across docs and bloated the persisted file. The baked LAYER'S
  // XMP still gets full state (for RESTORE/AUTO continue-editing); history
  // is just the portable preset library on top.
  const pushCurrentToHistory = (): void => {
    const full = buildXmpState();
    const recipeOnly: LutLayerState = {
      ...full,
      targetPaletteSwatches: [],
      targetPaletteWeights: [],
      targetSoftness: 0,
      selectionMode: "off",
    };
    const entry = makeHistoryEntry(recipeOnly);
    setRecentHistory(prev => pushHistoryEntry(prev, entry, HISTORY_MAX));
  };

  // v1.20.65 — Recipe export. Writes ALL pinned entries (plus all entries
  // if there are no pins) to a versioned JSON file via the OS save dialog.
  // Cross-machine portable; doc/layer ids are stripped at serialization
  // time (see recipeIO.ts).
  const onExportRecipes = async () => {
    try {
      const pinned = recentHistory.filter(e => e.pinned);
      const toExport = pinned.length > 0 ? pinned : recentHistory;
      if (toExport.length === 0) {
        setStatus("No recipes to export. Apply a match (and pin it) first.");
        return;
      }
      const uxp = require("uxp");
      const stamp = new Date().toISOString().slice(0, 10);
      const fname = `color-smash-recipes-${stamp}.json`;
      const file = await uxp.storage.localFileSystem.getFileForSaving(fname, { types: ["json"] });
      if (!file) { setStatus("Export cancelled."); return; }
      const text = serializeRecipes(toExport, "1.20.65");
      await file.write(text, { format: uxp.storage.formats.utf8 });
      setStatus(`Exported ${toExport.length} recipe${toExport.length === 1 ? "" : "s"} to ${file.name}.`);
    } catch (e: any) {
      setStatus(`Recipe export failed: ${e?.message ?? e}`);
    }
  };

  // v1.20.65 — Recipe import. Reads a previously-exported JSON file via
  // the OS open dialog, validates per-entry, merges via dedupKey (skips
  // duplicates), auto-pins everything imported so it survives ring-buffer
  // eviction. Cross-machine doc/layer ids never travel (stripped at
  // export time).
  const onImportRecipes = async () => {
    try {
      const uxp = require("uxp");
      const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"] });
      if (!file) { setStatus("Import cancelled."); return; }
      const text = await file.read({ format: uxp.storage.formats.utf8 });
      if (typeof text !== "string" || text.length === 0) {
        setStatus("Import failed: empty file.");
        return;
      }
      const result = parseRecipes(text);
      if ("error" in result) {
        setStatus(`Import failed: ${result.error}`);
        return;
      }
      if (result.entries.length === 0) {
        setStatus("Import: file contained no valid recipes.");
        return;
      }
      setRecentHistory(prev => {
        const merge = mergeImportedRecipes(prev, result.entries, dedupKey);
        // Report via status after the state update settles.
        setTimeout(() => {
          setStatus(`Imported ${merge.added} recipe${merge.added === 1 ? "" : "s"}${merge.skipped > 0 ? ` (${merge.skipped} duplicate${merge.skipped === 1 ? "" : "s"} skipped)` : ""}.`);
        }, 0);
        return merge.merged;
      });
    } catch (e: any) {
      setStatus(`Recipe import failed: ${e?.message ?? e}`);
    }
  };

  // Click handler for a history thumbnail — restores panel state from the
  // entry's saved snapshot. Does NOT auto-Apply (predictable: user picks
  // history, panel updates, user hits Apply if they want to bake again).
  // v1.20.13 — synthesize a fake source image from a recipe's swatches +
  // weights so the engine (histogram match, palette extraction, curve
  // derivation) all operate on the recipe's color distribution. Pixels
  // per cluster are proportional to displayValue = clusterPrevalence ×
  // userMultiplier, exactly mirroring PaletteStrip's bar widths. 64×64
  // is plenty for k-means + histogram work.
  const synthesizeRecipeSource = (
    swatches: any[],
    weights: number[],
  ): SourceSnap => {
    const W = 64, H = 64;
    const total = W * H;
    const dv = swatches.map((s, i) => {
      const w = typeof weights[i] === "number" ? Math.max(0, weights[i]) : 1;
      const p = typeof s?.weight === "number" ? Math.max(0, s.weight) : 1;
      return w * p;
    });
    const sum = dv.reduce((a, b) => a + b, 0) || 1;
    const data = new Uint8Array(total * 4);
    let pIdx = 0;
    for (let i = 0; i < swatches.length && pIdx < total; i++) {
      const count = Math.max(1, Math.round((dv[i] / sum) * total));
      const s = swatches[i];
      for (let j = 0; j < count && pIdx < total; j++) {
        data[pIdx * 4]     = s.r | 0;
        data[pIdx * 4 + 1] = s.g | 0;
        data[pIdx * 4 + 2] = s.b | 0;
        data[pIdx * 4 + 3] = 255;
        pIdx++;
      }
    }
    // Pad remainder with first swatch (rounding remainder pixels).
    if (pIdx < total && swatches.length > 0) {
      const s = swatches[0];
      while (pIdx < total) {
        data[pIdx * 4]     = s.r | 0;
        data[pIdx * 4 + 1] = s.g | 0;
        data[pIdx * 4 + 2] = s.b | 0;
        data[pIdx * 4 + 3] = 255;
        pIdx++;
      }
    }
    return { width: W, height: H, data, name: "Recipe" };
  };

  // v1.20.13 — apply a history recipe by both activating its palette AND
  // synthesizing a source pixel buffer from it. This makes the recipe truly
  // portable: histogram match, palette extraction, and Apply all run against
  // the recipe's color distribution rather than whatever live source layer
  // happens to be focused. Auto-escapes on source-layer change, srcMode
  // change, or Refresh — see effects + onRefreshAll.
  const applyHistoryEntry = (entry: HistoryEntry): void => {
    const recipeSerialized = entry.state.sourcePaletteSwatches ?? [];
    const recipeWeights = entry.state.sourcePaletteWeights ?? [];
    const recipeSwatches = recipeSerialized.map((s: any) => ({
      r: s.r, g: s.g, b: s.b,
      weight: typeof s.weight === "number" ? s.weight : 1,
      labL: typeof s.labL === "number" ? s.labL : 50,
      labA: typeof s.labA === "number" ? s.labA : 0,
      labB: typeof s.labB === "number" ? s.labB : 0,
    })) as PaletteSwatch[];
    if (recipeSwatches.length > 0) {
      setSavedSourceSwatches(recipeSwatches);
      setRecipeSrcSnap(synthesizeRecipeSource(recipeSerialized, recipeWeights));
      setRecipeMode(true);
      setRecipeLabel(entry.customName || entry.label || "Recipe");
    }
    applyStateToPanel(entry.state, "recipe");
    setStatus(`Loaded recipe (${entry.label}). Source synthesized from recipe — change source layer or click Refresh to return to live extraction.`);
  };

  // Shared restore implementation — pulled out of the manual onRestoreFromLayer
  // handler so the auto-restore listener can use the same code path. Takes a
  // layer id so the listener can target the just-selected layer specifically
  // (vs the manual button which uses whatever is active). Returns true if it
  // applied a restore, false if the layer had no Color Smash XMP.
  // Apply a LutLayerState to the panel setters.
  //   mode === "full":   restores EVERYTHING including target-side state.
  //                      Used by RESTORE/AUTO on XMP — "continue editing
  //                      this Match layer" is the right semantic there.
  //   mode === "recipe": skips target-side fields (targetPaletteWeights,
  //                      targetSoftness, targetPaletteSwatches, selectionMode).
  //                      Used by history click so the user can apply an old
  //                      RECIPE to their CURRENT target without losing their
  //                      target-side tuning. History becomes a preset library
  //                      instead of an undo timeline.
  const applyStateToPanel = (state: LutLayerState, mode: "full" | "recipe" = "full"): void => {
    if (state.preset) setActivePreset(state.preset as any);
    if (state.matchMode) setMatchMode(state.matchMode as MatchMode);
    if (state.outputMode === "rgb" || state.outputMode === "lab" || state.outputMode === "lut") {
      setOutputMode(state.outputMode);
    } else if (state.colorSpace === "rgb" || state.colorSpace === "lab") {
      setOutputMode(state.colorSpace);
    } else {
      setOutputMode("lut");
    }
    if (state.paletteCount === 3 || state.paletteCount === 5 || state.paletteCount === 7) {
      setPaletteCount(state.paletteCount);
    }
    if (state.sourcePaletteWeights && Array.isArray(state.sourcePaletteWeights)) {
      skipNextWeightResetRef.current = true;
      setPaletteWeights(state.sourcePaletteWeights);
    }
    if (mode === "full" && state.targetPaletteWeights && Array.isArray(state.targetPaletteWeights)) {
      setTargetPaletteWeights(state.targetPaletteWeights);
    }
    if (typeof state.sourceSoftness === "number") setSourceSoftness(state.sourceSoftness);
    if (mode === "full" && typeof state.targetSoftness === "number") setTargetSoftness(state.targetSoftness);
    if (state.paletteAdaptive != null) setPaletteAdaptive(!!state.paletteAdaptive);
    // v1.20.70 — restored XMP / recipe state.multiZone is ignored
    // (multi-zone UI retired). Old XMP that carried multi:true still
    // parses, but the panel always lands in single-curve mode.
    if (state.dimensions) {
      dimsRef.current = { ...DEFAULT_DIMENSIONS, ...state.dimensions } as DimensionOpts;
      setDimsLabel(dimsRef.current);
    }
    if (state.zones) {
      zonesRef.current = { ...DEFAULT_ZONES, ...state.zones } as ZoneOpts;
      setZonesLabel(zonesRef.current);
    }
    if (state.envelope && Array.isArray(state.envelope) && state.envelope.length > 0) {
      envelopeRef.current = state.envelope as EnvelopePoint[];
      setEnvelopeLabel(state.envelope as EnvelopePoint[]);
    }
    if (Array.isArray(state.sourcePaletteSwatches) && state.sourcePaletteSwatches.length > 0) {
      setSavedSourceSwatches(state.sourcePaletteSwatches as PaletteSwatch[]);
    }
    if (mode === "full" && Array.isArray(state.targetPaletteSwatches) && state.targetPaletteSwatches.length > 0) {
      setSavedTargetSwatches(state.targetPaletteSwatches as PaletteSwatch[]);
    }
    if (typeof state.lutStrength === "number") setLutStrength(Math.max(0, Math.min(100, state.lutStrength)));
    if (state.lutGrid === 17 || state.lutGrid === 33 || state.lutGrid === 65) setLutGrid(state.lutGrid);
    if (typeof state.lutDither === "boolean") setLutDither(state.lutDither);
    if (mode === "full" && (state.selectionMode === "off" || state.selectionMode === "focus" || state.selectionMode === "exclude")) {
      setSelectionMode(state.selectionMode);
    }
    // v1.20.43 — full restore also reinstates the doc + layer pairing
    // that produced the bake, so RESTORE actually drops the user back
    // into the exact source/target combination. Only sets when the
    // referenced doc/layer is still openable (silently skips otherwise
    // so a stale id doesn't blow up the UI).
    if (mode === "full") {
      try {
        const ps = require("photoshop");
        const docs = ps.app.documents ?? [];
        if (typeof state.sourceDocId === "number" && docs.find((d: any) => d.id === state.sourceDocId)) {
          setSrcDocId(state.sourceDocId);
        }
        if (typeof state.targetDocId === "number" && docs.find((d: any) => d.id === state.targetDocId)) {
          setTgtDocId(state.targetDocId);
        }
        if (typeof state.sourceLayerId === "number") setSourceId(state.sourceLayerId);
        if (typeof state.targetLayerId === "number") setTargetId(state.targetLayerId);
      } catch { /* ignore */ }
    }
  };

  const restoreFromLayerId = async (layerId: number): Promise<boolean> => {
    // v1.20.24 — single-layer applies are now wrapped in a sub-group inside
    // [Color Smash]. XMP is written to both the inner layer and the sub-
    // group, so either one restores. As a safety net, if the directly-
    // addressed layer has no XMP but it's a group, look at its first child.
    let state = await readLutLayerState(layerId);
    if (!state) {
      try {
        const ps = require("photoshop");
        const doc = ps.app.activeDocument;
        const find = (layers: any[]): any | null => {
          for (const l of layers) {
            if (l.id === layerId) return l;
            if (Array.isArray(l.layers)) {
              const found = find(l.layers); if (found) return found;
            }
          }
          return null;
        };
        const layer = doc ? find(doc.layers ?? []) : null;
        const child = layer && Array.isArray(layer.layers) ? layer.layers[0] : null;
        if (child?.id != null) state = await readLutLayerState(child.id);
      } catch { /* ignore */ }
    }
    if (!state) return false;
    applyStateToPanel(state);
    return true;
  };

  // v1.20.43 — always-on listener that probes the active layer for Color
  // Smash XMP and sets canRestore accordingly. Does NOT auto-mutate panel
  // state (AUTO was removed); just gates the RESTORE button's enabled state
  // so users see at a glance whether the layer they clicked can be
  // restored from. Suppressed for ~1.5s after self-writes to avoid the
  // Apply→select echo.
  useEffect(() => {
    const ps = require("photoshop");
    const psAction = ps.action;
    let scheduled: any = null;
    const probe = async () => {
      if (Date.now() - lastSelfWriteRef.current < 1500) return;
      try {
        const doc = ps.app.activeDocument;
        const layer = doc?.activeLayers?.[0];
        if (!layer) { setCanRestore(false); return; }
        // Use restoreFromLayerId's read path; just don't apply.
        const state = await readLutLayerState(layer.id);
        if (state) { setCanRestore(true); return; }
        // Fall back to first child (group with XMP'd inner layer).
        const child = Array.isArray(layer.layers) ? layer.layers[0] : null;
        if (child?.id != null) {
          const cs = await readLutLayerState(child.id);
          setCanRestore(!!cs);
          return;
        }
        setCanRestore(false);
      } catch { setCanRestore(false); }
    };
    const onSelect = () => {
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => { scheduled = null; probe(); }, 80);
    };
    psAction.addNotificationListener(["select"], onSelect);
    // Run once on mount so the button reflects whatever's already active.
    probe();
    return () => {
      if (scheduled) clearTimeout(scheduled);
      try { psAction.removeNotificationListener?.(["select"], onSelect); } catch { /* ignore */ }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore — read the active layer's XMP and push every captured value
  // back into the panel. Useful when the user clicked a previously-authored
  // Match LUT layer and wants to resume editing where they left off.
  // v1.14.1 will fire this automatically on layer-select notifications;
  // for now it's a manual button next to LIVE / Apply LUT.
  const onRestoreFromLayer = async () => {
    try {
      const ps = require("photoshop");
      const doc = ps.app.activeDocument;
      const activeLayer = doc?.activeLayers?.[0];
      if (!activeLayer) { setStatus("No layer selected."); return; }
      const ok = await restoreFromLayerId(activeLayer.id);
      setStatus(ok
        ? `Restored panel state from "${activeLayer.name}".`
        : "Selected layer has no Color Smash metadata.");
    } catch (e: any) {
      setStatus(`Restore failed: ${e?.message ?? e}`);
    }
  };

  // v1.20.70 — sync the user's chosen group name to the photoshop
  // service module's mutable GROUP_NAME var. Runs on every change so
  // find/consolidate helpers + branch numbering pick up the new value.
  useEffect(() => {
    try {
      const { setGroupName: setSvc } = require("../services/photoshop");
      setSvc(groupName);
    } catch { /* non-fatal */ }
  }, [groupName]);

  // v1.20.70 — when the user renames the group via Settings, rename the
  // existing canonical group in PS to match (best-effort; if no group
  // exists yet, the next Apply / consolidate will use the new name).
  useEffect(() => {
    if (tgtDocId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const ps = require("photoshop");
        const { executeAsModal } = ps.core ?? {};
        const doc = (ps.app.documents ?? []).find((d: any) => d.id === tgtDocId);
        if (!doc) return;
        const findCS = (layers: any[]): any | null => {
          for (const l of layers ?? []) {
            if (l?.name && (l.name === groupName || l.name === "[Color Smash]") && Array.isArray(l.layers)) return l;
            if (Array.isArray(l?.layers)) { const f = findCS(l.layers); if (f) return f; }
          }
          return null;
        };
        const group = findCS(doc.layers ?? []);
        if (!group || cancelled) return;
        if (group.name !== groupName) {
          if (executeAsModal) {
            await executeAsModal(async () => { try { group.name = groupName; } catch { /* */ } }, { commandName: "Rename Color Smash group" });
          } else {
            try { group.name = groupName; } catch { /* */ }
          }
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [groupName, tgtDocId]);

  // v1.20.70 — sync the user's chosen group color to PS whenever it
  // changes (or when the target doc changes). Finds the canonical
  // [Color Smash] group in the target doc and applies the color tag
  // via setLayerColor. No-op if no group exists yet.
  useEffect(() => {
    if (tgtDocId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const ps = require("photoshop");
        const { setLayerColor } = require("../services/photoshop");
        const { executeAsModal } = require("photoshop").core ?? {};
        const doc = (ps.app.documents ?? []).find((d: any) => d.id === tgtDocId);
        if (!doc) return;
        const findCS = (layers: any[]): any | null => {
          for (const l of layers ?? []) {
            if (l?.name && (l.name === groupName || l.name === "[Color Smash]") && Array.isArray(l.layers)) return l;
            if (Array.isArray(l?.layers)) { const f = findCS(l.layers); if (f) return f; }
          }
          return null;
        };
        const group = findCS(doc.layers ?? []);
        if (!group || cancelled) return;
        if (executeAsModal) {
          await executeAsModal(() => setLayerColor(group.id, groupColor), { commandName: "Update group color" });
        } else {
          await setLayerColor(group.id, groupColor);
        }
      } catch { /* non-fatal — color is decorative */ }
    })();
    return () => { cancelled = true; };
  }, [groupColor, tgtDocId]);

  // v1.20.70 — REVERT shadow slot. Holds the panel state from JUST BEFORE
  // the last REVERT was applied. While non-null, the REVERT button styles
  // itself as "UN-REVERT" and clicking it restores the snapshot. Cleared
  // on UN-REVERT click or on a fresh REVERT from a different layer.
  const [preRevertSnapshot, setPreRevertSnapshot] = useState<LutLayerState | null>(null);
  const onRevertClick = async () => {
    if (preRevertSnapshot) {
      // Un-revert: restore the shadow slot.
      const slot = preRevertSnapshot;
      setPreRevertSnapshot(null);
      applyStateToPanel(slot);
      setStatus("Pre-revert state restored.");
      return;
    }
    if (!canRestore) return;
    // Snapshot current state into shadow slot AND push to history as a
    // safety entry the user can recover from even after the slot clears.
    const snap = buildXmpState();
    setPreRevertSnapshot(snap);
    try {
      const safety = makeHistoryEntry(snap);
      safety.customName = `Before REVERT @ ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      safety.pinned = true;
      setRecentHistory(prev => pushHistoryEntry(prev, safety, HISTORY_MAX));
    } catch { /* non-fatal */ }
    await onRestoreFromLayer();
  };

  // v1.20.70+ — panel-state undo / redo (header ↶ ↷ buttons).
  //
  // Captures snapshots of `buildXmpState()` whenever tracked panel state
  // settles for ≥250ms (debounced — slider drags don't pollute the
  // stack). ↶ pops the prior snapshot, pushes the current state onto
  // redo, applies the popped state. ↷ symmetric. Capacity 30; oldest
  // entries auto-evicted.
  //
  // DOES NOT touch PS's own undo/redo. PS-side undo (layer creation,
  // mask attach, etc.) remains on Ctrl/Cmd+Z while PS has focus. This
  // is purely a panel-side affordance for "I tweaked a slider, want
  // it back".
  //
  // isRestoringRef gates the snapshot watcher so applying an undo
  // doesn't ALSO push the just-applied state onto the undo stack
  // (which would create an infinite-undo loop / make ↷ unreachable).
  const PANEL_UNDO_CAP = 30;
  const panelUndoStackRef = useRef<LutLayerState[]>([]);
  const panelRedoStackRef = useRef<LutLayerState[]>([]);
  const panelLastSnapshotRef = useRef<LutLayerState | null>(null);
  const isRestoringRef = useRef(false);
  // Force a re-render when stacks change so the header buttons dim/light
  // correctly. The stacks themselves live in refs (no rerender on push);
  // this tick is the React-visible signal.
  const [undoTick, setUndoTick] = useState(0);
  const onPanelUndo = () => {
    const prev = panelUndoStackRef.current.pop();
    if (!prev) { setStatus("Nothing to undo."); return; }
    const current = panelLastSnapshotRef.current ?? buildXmpState();
    panelRedoStackRef.current.push(current);
    if (panelRedoStackRef.current.length > PANEL_UNDO_CAP) panelRedoStackRef.current.shift();
    isRestoringRef.current = true;
    panelLastSnapshotRef.current = prev;
    applyStateToPanel(prev);
    setUndoTick(t => t + 1);
    const remainingUndo = panelUndoStackRef.current.length;
    const inRedo = panelRedoStackRef.current.length;
    setStatus(`Undo — ${remainingUndo} more undoable, ${inRedo} redoable.`);
    // Release the gate after the snapshot effect has had a chance to
    // re-fire from the applied state. 350ms > the 250ms debounce.
    setTimeout(() => { isRestoringRef.current = false; }, 350);
  };
  const onPanelRedo = () => {
    const next = panelRedoStackRef.current.pop();
    if (!next) { setStatus("Nothing to redo."); return; }
    const current = panelLastSnapshotRef.current ?? buildXmpState();
    panelUndoStackRef.current.push(current);
    if (panelUndoStackRef.current.length > PANEL_UNDO_CAP) panelUndoStackRef.current.shift();
    isRestoringRef.current = true;
    panelLastSnapshotRef.current = next;
    applyStateToPanel(next);
    setUndoTick(t => t + 1);
    const remainingRedo = panelRedoStackRef.current.length;
    const inUndo = panelUndoStackRef.current.length;
    setStatus(`Redo — ${remainingRedo} more redoable, ${inUndo} undoable.`);
    setTimeout(() => { isRestoringRef.current = false; }, 350);
  };
  // v1.20.70 — keyboard shortcut for panel undo / redo. Listens at
  // document level — UXP only fires keydown when the panel itself has
  // focus (a slider / input / picker is active here, not in PS), so
  // we never steal Cmd/Ctrl+Z from Photoshop's own undo. When the user
  // is hovering / focused INSIDE the panel:
  //   Cmd/Ctrl+Z              → onPanelUndo()
  //   Cmd/Ctrl+Shift+Z        → onPanelRedo()
  //   Ctrl+Y (Windows convention) → onPanelRedo()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) onPanelRedo();
        else onPanelUndo();
      } else if (key === "y") {
        e.preventDefault();
        onPanelRedo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced snapshot watcher. Fires 250ms after the last tracked
  // state change. On each fire, if not restoring, the prior snapshot
  // is pushed onto the undo stack and the redo stack is cleared (new
  // user action invalidates the old redo branch — same as text editor
  // undo semantics).
  useEffect(() => {
    if (!loadedRef.current) return; // skip until persistence load resolves
    if (isRestoringRef.current) return;
    const id = setTimeout(() => {
      const current = buildXmpState();
      const prior = panelLastSnapshotRef.current;
      if (prior !== null) {
        // Skip no-op snapshots (string-equal == no real change).
        const priorJson = JSON.stringify(prior);
        const currJson = JSON.stringify(current);
        if (priorJson === currJson) return;
        panelUndoStackRef.current.push(prior);
        if (panelUndoStackRef.current.length > PANEL_UNDO_CAP) panelUndoStackRef.current.shift();
        // Clear redo on any genuine new change (standard undo
        // semantics — once you start a new action branch, the old
        // redo path is no longer reachable).
        if (panelRedoStackRef.current.length > 0) {
          panelRedoStackRef.current = [];
        }
        setUndoTick(t => t + 1);
      }
      panelLastSnapshotRef.current = current;
    }, 250);
    return () => clearTimeout(id);
    // Watching a wide dep slice — every panel state slice that should
    // count as an "undoable" change. Intentionally NOT including:
    //   - recentHistory (auto-record after apply would push a useless
    //     undo step; the user wouldn't expect ↶ to remove a history
    //     entry)
    //   - sourceId / targetId / srcDocId / tgtDocId / srcMode (context
    //     switches, not panel "tweaks" the user would expect undo for
    //     — they're picking where to work, not what to do)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    matchMode,
    amountLabel, smoothLabel, stretchLabel, anchorStretchToHist, chromaOnly,
    colorSpace, outputMode, lutStrength, lutGrid, lutDither, selectionMode,
    overwriteOnApply, zonesLabel, dimsLabel, envelopeLabel,
    paletteCount, paletteAdaptive, sourceSoftness, targetSoftness,
    targetMaskEnabled, paletteWeights, targetPaletteWeights,
  ]);

  // Apply LUT — bake the staged preset into a Color Lookup adjustment layer
  // automatically, no file dialog. The .cube goes to the plugin's temp folder
  // (PS references it from there) and the layer lands in the [Color Smash]
  // group. If batchPlay descriptor fails on this PS version, falls back to
  // surfacing a diagnostic — user can still hit Export LUT for the file flow.
  const onApplyLut = async () => {
    // v1.20.11 — prefer renderedCurves but fall back to curvesPendingRef when
    // the React state hasn't caught up yet (100ms debounce window). Previously,
    // hitting Apply LUT immediately after a source/target layer change would
    // silently bail with "Compute a match first" because renderedCurves was
    // briefly null while the preview re-ran. Users perceived this as "history
    // stopped recording after I changed a layer" — Apply itself wasn't firing.
    const curves = renderedCurves ?? curvesPendingRef.current;
    if (!curves) { setStatus("Compute a match first."); return; }

    // v1.20.54 — if the + arm is "armed" (overwriteOnApply=false), branch
    // off the current [Color Smash] group before applying: rename + hide
    // the old one so getOrCreateColorSmashGroup spawns a fresh empty one
    // for this Apply. Then disarm the + so subsequent Applies replace
    // within this new group.
    // v1.20.70 — consolidate any stray [Color Smash] groups into one
    // canonical group at the doc root. Defensive: JUMP / ISOLATE / user
    // selection changes can cause PS's insertion-point to nest a new
    // group inside a sub-group on a subsequent create. Runs before the
    // branch path so it operates on a clean slate.
    if (tgtDocId != null) {
      try { await consolidateColorSmashGroups(tgtDocId); } catch { /* non-fatal */ }
    }
    if (!overwriteOnApply && tgtDocId != null) {
      try { await branchColorSmashGroup(tgtDocId); } catch { /* non-fatal */ }
      // v1.20.64 — clear the live-LUT layer pointer so AUTO doesn't keep
      // mutating the LUT layer inside the now-archived hidden group.
      liveLutLayerIdRef.current = null;
      setOverwriteOnApply(true);
    }

    const targetPalette = targetPaletteSwatches.length > 0 ? {
      swatches: targetPaletteSwatches,
      weights: targetPaletteWeights.slice(),
      softness: targetSoftness,
    } : undefined;

    // v1.20.70 — multi-zone LUT branch removed alongside the UI. The
    // applyMultiZoneLutAsLayers entry point in applyLut.ts still ships
    // (recipe-compat) but is unreachable from the panel now.
    // Single-LUT branch.
    setStatus("Applying LUT...");
    try {
      const result = await applyLutAsAdjustmentLayer({
        curves,
        preset: activePreset,
        gridSize: lutGrid,
        strength: lutStrength / 100,
        dither: lutDither,
        targetLayerId: targetId === MERGED_LAYER_ID ? null : targetId,
        targetIsMerged: targetId === MERGED_LAYER_ID,
        overwritePrior: true,
        targetPalette,
        xmpState: buildXmpState(),
      });
      // Track the new layer's id so toggling Live LUT later updates THIS layer
      // instead of creating yet another one.
      liveLutLayerIdRef.current = result.layerId;
      lastSelfWriteRef.current = Date.now();
      setStatus(`Applied "${result.layerName}" (33³ LUT).`);
      pushCurrentToHistory();
    } catch (e: any) {
      setStatus(`Apply LUT failed: ${e?.message ?? e} — try Save LUT and load manually via Image → Adjustments → Color Lookup.`);
    }
  };

  // ─── Live LUT auto-update ────────────────────────────────────────────────
  // When Live LUT is on, every change to renderedCurves / preset triggers a
  // debounced re-bake into the existing Match LUT layer. Debounce ~300ms so
  // rapid slider drags coalesce into a single PS update — without it, every
  // intermediate value would queue its own modal scope, which serializes and
  // freezes the UI.
  //
  // Sequencing notes:
  //   - We don't fire on mount even if liveLut starts true; waits for an
  //     actual curve update so we don't spuriously create a layer at startup.
  //   - If liveLut turns OFF, we cancel the pending timer and leave the
  //     layer in whatever state it's in (frozen — predictable).
  //   - If a re-bake fails silently (PS modal busy, doc closed mid-drag), we
  //     surface a brief status message but don't disable Live LUT — the next
  //     successful commit recovers state.
  const liveBakeTimerRef = useRef<any>(null);
  const liveBakeFirstRunSkippedRef = useRef(false);
  useEffect(() => {
    if (!liveLut) {
      // Cancel any pending fire when toggling off.
      if (liveBakeTimerRef.current) { clearTimeout(liveBakeTimerRef.current); liveBakeTimerRef.current = null; }
      liveBakeFirstRunSkippedRef.current = false;
      return;
    }
    // Multi-zone LUT incompatibility (v1.16.0): the multi-zone path creates 3
    // Color Lookup layers in a sub-group, while Live LUT's update-in-place
    // v1.20.70 — multi-zone skip removed (multi UI retired; multiZone
    // is now hard-coded false in the panel).
    // First effect run after enabling: skip — don't auto-create on toggle.
    // The user must either drag a slider OR hit Apply LUT once to seed the layer.
    if (!liveBakeFirstRunSkippedRef.current) {
      liveBakeFirstRunSkippedRef.current = true;
      return;
    }
    if (!renderedCurves) return;
    if (liveBakeTimerRef.current) clearTimeout(liveBakeTimerRef.current);
    liveBakeTimerRef.current = setTimeout(async () => {
      liveBakeTimerRef.current = null;
      try {
        // v1.20.70 — stale-layer guard. If the user did Cmd+Z in PS to
        // undo a prior bake, liveLutLayerIdRef.current still points at
        // the (now-deleted) layer. The next live-bake would try to
        // update-in-place and silently fail. Resolve the id against
        // the live target doc; if it doesn't exist, clear the ref so
        // AUTO takes the create path on this fire.
        if (liveLutLayerIdRef.current != null && tgtDocId != null) {
          try {
            const ps = require("photoshop");
            const doc = (ps.app.documents ?? []).find((d: any) => d.id === tgtDocId);
            if (doc) {
              const findById = (layers: any[]): any | null => {
                for (const l of layers ?? []) {
                  if (l?.id === liveLutLayerIdRef.current) return l;
                  if (Array.isArray(l?.layers)) { const f = findById(l.layers); if (f) return f; }
                }
                return null;
              };
              if (!findById(doc.layers ?? [])) {
                liveLutLayerIdRef.current = null;
              }
            }
          } catch { /* non-fatal */ }
        }
        // Mode-aware dispatch (v1.16.4). LIVE used to only handle LUT mode —
        // in RGB/Lab mode it was creating Color Lookup layers, which is wrong
        // (those modes produce Curves layers). Branch by outputMode so LIVE
        // works for whatever output the user has selected.
        if (outputMode === "lut") {
          const result = await applyLutAsAdjustmentLayer({
            curves: renderedCurves,
            preset: activePreset,
            gridSize: lutGrid,
            strength: lutStrength / 100,
            dither: lutDither,
            targetLayerId: targetId === MERGED_LAYER_ID ? null : targetId,
            targetIsMerged: targetId === MERGED_LAYER_ID,
            overwritePrior: false, // update-in-place handles the existing layer
            updateExistingLayerId: liveLutLayerIdRef.current,
            targetPalette: targetPaletteSwatches.length > 0 ? {
              swatches: targetPaletteSwatches,
              weights: targetPaletteWeights.slice(),
              softness: targetSoftness,
            } : undefined,
          });
          liveLutLayerIdRef.current = result.layerId;
          lastSelfWriteRef.current = Date.now();
        } else {
          // RGB / Lab modes: update the existing Match Curves adjustment layer's
          // curves descriptor + blend mode in place. No-op if user hasn't hit
          // Apply yet (no layer to update); they need to seed one first.
          const result = await updateMatchCurvesLayerInPlace(renderedCurves, activePreset, tgtDocId ?? undefined);
          if (result.ok) lastSelfWriteRef.current = Date.now();
        }
      } catch (e: any) {
        setStatus(`Live update skipped: ${e?.message ?? e}`);
      }
    }, autoDebounceMs);
    return () => {
      if (liveBakeTimerRef.current) { clearTimeout(liveBakeTimerRef.current); liveBakeTimerRef.current = null; }
    };
  }, [liveLut, renderedCurves, activePreset, targetId, targetPaletteWeights, targetSoftness, outputMode, autoDebounceMs]);

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (srcMode === "layer" && sourceId == null) { setStatus("Pick source layer."); return; }
    // v1.20.54 — branch off when + is armed (see onApplyLut for context).
    // v1.20.70 — consolidate any stray [Color Smash] groups into one
    // canonical group at the doc root. Defensive: JUMP / ISOLATE / user
    // selection changes can cause PS's insertion-point to nest a new
    // group inside a sub-group on a subsequent create. Runs before the
    // branch path so it operates on a clean slate.
    if (tgtDocId != null) {
      try { await consolidateColorSmashGroups(tgtDocId); } catch { /* non-fatal */ }
    }
    if (!overwriteOnApply && tgtDocId != null) {
      try { await branchColorSmashGroup(tgtDocId); } catch { /* non-fatal */ }
      // v1.20.64 — clear the live-LUT layer pointer so AUTO doesn't keep
      // mutating the LUT layer inside the now-archived hidden group.
      liveLutLayerIdRef.current = null;
      setOverwriteOnApply(true);
    }
    if (srcMode === "selection" && !srcOverride) { setStatus("Snap a selection first."); return; }
    setStatus("Applying match...");
    try {
      if (srcDocId == null || tgtDocId == null) { setStatus("Pick source + target docs."); return; }
      setStatus(await applyMatch({
        srcDocId, tgtDocId,
        sourceLayerId: sourceId ?? -1,
        targetLayerId: targetId,
        matchMode,
        // v1.20.70 — multi-zone retired; applyMatch no longer accepts
        // multiZone / multiZoneLimit / peak / extent params.
        // Section-enable mirror — disabled sections apply with default params.
        amount: enColor ? amountRef.current / 100 : 1,
        smoothRadius: enColor ? smoothRef.current : 0,
        maxStretch: enColor ? stretchRef.current : 999,
        stretchRange: enColor && anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined,
        chromaOnly: enColor && chromaOnly,
        dimensions: enTone ? dimsRef.current : DEFAULT_DIMENSIONS,
        zones: zonesRef.current,
        envelope: enEnvelope ? envelopeRef.current : DEFAULT_ENVELOPE,
        // sourcePixelsOverride: priority order is
        //   1) weighted source (when palette weights diverge from neutral) — supersedes
        //      everything else because the user has explicitly shaped the source's
        //      tonal contribution and that override must reach the bake.
        //   2) selection snapshot (when source mode = selection) — the pre-snapped
        //      marquee pixels, which would otherwise be lost.
        //   3) undefined → applyMatch reads full-res pixels from the source layer.
        // Note: when weights are non-neutral we lose the full-res advantage because
        // the synthesized buffer is built from the 256-edge snapshot. Acceptable
        // tradeoff — histogram stats from a 256-edge sample are already representative
        // and the user's weight control operates on the cluster centroids anyway.
        sourcePixelsOverride: (() => {
          const isNonNeutral = paletteWeights.some(w => Math.abs(w - 1) > 0.01);
          if (isNonNeutral && weightedSrcData) return weightedSrcData;
          return srcOverride?.data;
        })(),
        sourceLabel: srcOverride?.name,
        colorSpace,
        // v1.20.25 — deselectFirst no longer passed; applyMatch never
        // deselects now so the marquee survives into the mask path.
        overwritePrior: true,
        preset: activePreset,
        // Target-palette weighting → layer mask on the Curves adjustment.
        // Pass the cluster centroids + per-cluster weights through; applyMatch
        // (when it sees non-neutral weights) reads full-res target pixels,
        // assigns each to its nearest centroid, and builds a grayscale mask
        // where mask[pixel] = clamp01(weights[cluster]) × 255. The Curves
        // layer then applies at masked strength: full-match where weight=1,
        // pass-through where weight=0, blended in between.
        targetPalette: (() => {
          // Honor the mask toggle: when off, the bake produces an unmasked
          // Curves layer regardless of weights. Matches the preview, which
          // is also unmasked when the gate is off.
          if (!targetMaskEnabled) return undefined;
          const isNonNeutral = targetPaletteWeights.some(w => Math.abs(w - 1) > 0.01);
          if (!isNonNeutral || targetPaletteSwatches.length === 0) return undefined;
          return {
            swatches: targetPaletteSwatches,
            weights: targetPaletteWeights.slice(),
            softness: targetSoftness,
          };
        })(),
        selectionMode: effectiveSelectionMode,
        // v1.20.40 — embed the panel-state snapshot so RESTORE / AUTO can
        // round-trip a Curves bake the same way LUT bakes already do.
        xmpState: buildXmpState(),
      }));
      pushCurrentToHistory();
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  // v1.20.70 — tab-click handler: clicking RGB/Lab/LUT swaps mode AND fires
  // Apply for that mode. If switching to a NEW mode, we can't call apply
  // synchronously — fit + renderedCurves run through useMemo on outputMode,
  // so the curves for the new mode aren't ready yet. We flip a ref flag and
  // a useEffect (below) waits for outputMode to commit + renderedCurves to
  // refresh, then dispatches to the appropriate handler.
  const onTabClick = (val: "rgb" | "lab" | "lut") => {
    if (val === outputMode) {
      // Same tab clicked → fire apply right away with current curves.
      (val === "lut" ? onApplyLut : onApply)();
      return;
    }
    pendingApplyRef.current = true;
    setOutputMode(val);
  };
  useEffect(() => {
    if (!pendingApplyRef.current) return;
    pendingApplyRef.current = false;
    // Defer one tick so fit/useMemo for the new colorSpace has propagated
    // into renderedCurves before Apply reads it via curvesPendingRef.
    const t = setTimeout(() => {
      (outputMode === "lut" ? onApplyLut : onApply)();
    }, 40);
    return () => clearTimeout(t);
  }, [outputMode, renderedCurves]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = matchStyles.sel;
  const tinyBtn = matchStyles.tinyBtn;

  // v1.20.68 — jump to target layer in PS Layers panel. Quality-of-life:
  // when the panel target dropdown points at a layer buried in a group,
  // this saves the user a click+expand to actually open + edit it.
  const onJumpToTarget = async () => {
    if (targetId == null || targetId === MERGED_LAYER_ID) {
      setStatus("No specific target layer to jump to.");
      return;
    }
    try {
      await executeAsModal("Color Smash jump to target", async () => {
        await psAction.batchPlay([{
          _obj: "select",
          _target: [{ _ref: "layer", _id: targetId }],
          makeVisible: true,
        }], {});
      });
    } catch (e: any) {
      setStatus(`Jump failed: ${e?.message ?? e}`);
    }
  };

  // v1.20.68 — isolation toggle. When activated, snapshots the current
  // visibility of every layer in the target doc, then hides everything
  // EXCEPT the target's ancestor chain and the [Color Smash] group's
  // ancestor chain. Toggling off restores the snapshot exactly.
  // Acts as an A/B compare: see the matched output without surrounding
  // context, then flip back to the full comp.
  const onToggleIsolation = async () => {
    if (tgtDocId == null) { setStatus("Pick a target doc first."); return; }
    try {
      await executeAsModal("Color Smash isolate", async () => {
        const ps = require("photoshop");
        const doc = (ps.app.documents ?? []).find((d: any) => d.id === tgtDocId);
        if (!doc) return;
        if (!isolated) {
          // Build the keep-visible set: target layer + its ancestor chain,
          // plus [Color Smash] group + its ancestor chain.
          const keep = new Set<number>();
          const addAncestors = (id: number) => {
            const findPath = (layers: any[], path: any[]): any[] | null => {
              for (const l of layers) {
                if (l.id === id) return [...path, l];
                if (Array.isArray(l.layers)) {
                  const p = findPath(l.layers, [...path, l]);
                  if (p) return p;
                }
              }
              return null;
            };
            const path = findPath(doc.layers ?? [], []);
            if (path) for (const node of path) keep.add(node.id);
          };
          if (targetId != null && targetId !== MERGED_LAYER_ID) addAncestors(targetId);
          // Find [Color Smash] group + add its ancestor chain.
          const findCS = (layers: any[]): any | null => {
            for (const l of layers) {
              if ((l.name === groupName || l.name === "[Color Smash]") && Array.isArray(l.layers)) return l;
              if (Array.isArray(l.layers)) { const f = findCS(l.layers); if (f) return f; }
            }
            return null;
          };
          const csGroup = findCS(doc.layers ?? []);
          if (csGroup) addAncestors(csGroup.id);
          // Snapshot + hide the others.
          const snap = new Map<number, boolean>();
          const walk = (layers: any[]) => {
            for (const l of layers) {
              snap.set(l.id, !!l.visible);
              if (!keep.has(l.id)) {
                try { l.visible = false; } catch { /* ignore */ }
              } else {
                try { l.visible = true; } catch { /* ignore */ }
              }
              if (Array.isArray(l.layers)) walk(l.layers);
            }
          };
          walk(doc.layers ?? []);
          isolationSnapshotRef.current = snap;
          setIsolated(true);
        } else {
          // Restore from snapshot.
          const snap = isolationSnapshotRef.current;
          if (snap) {
            const walk = (layers: any[]) => {
              for (const l of layers) {
                const prev = snap.get(l.id);
                if (typeof prev === "boolean") {
                  try { l.visible = prev; } catch { /* ignore */ }
                }
                if (Array.isArray(l.layers)) walk(l.layers);
              }
            };
            walk(doc.layers ?? []);
          }
          isolationSnapshotRef.current = null;
          setIsolated(false);
        }
      });
    } catch (e: any) {
      setStatus(`Isolate toggle failed: ${e?.message ?? e}`);
    }
  };

  // Full reset: every persisted setting back to its default + delete the saved file.
  // Triggered by the red ✕ in the bottom bar.
  const onResetAll = () => {
    amountRef.current = 100; setAmountLabel(100);
    smoothRef.current = 0;   setSmoothLabel(0);
    stretchRef.current = 8;  setStretchLabel(8);
    setAnchorStretchToHist(false);
    setChromaOnly(false);
    setMatchMode("full");
    // v1.20.70 — setMultiZone / setMultiZoneLimit / setAdaptiveBands /
    // setLockZoneTotal removed alongside the multi-zone UI cleanup.
    setOutputMode("rgb");
    setOverwriteOnApply(true);
    setOpenSection(null);
    zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES });
    dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS });
    envelopeRef.current = [...DEFAULT_ENVELOPE]; setEnvelopeLabel([...DEFAULT_ENVELOPE]);
    setRemember(false);
    void clearSettings();
    scheduleRedraw();
    setStatus("Settings reset to defaults.");
  };

  const onRefreshAll = async () => {
    setStale(false);
    // v1.20.9 — drop any recipe-restored swatches so live extraction wins
    // again on this refresh. Otherwise a previously-clicked history entry
    // would keep dominating the palette even after the user explicitly
    // asks for a re-sync.
    setSavedSourceSwatches(null);
    setSavedTargetSwatches(null);
    setRecipeMode(false);
    setRecipeSrcSnap(null);
    setRecipeLabel("");
    refreshSrcLayers();
    refreshTgtLayers();
    src.refresh();
    tgt.refresh();
    if (srcMode === "selection" && srcOverride) {
      try { setSrcOverride(await snapshotSelectionInner()); } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
    }
    // v1.20.70 — force selection mask re-read. Folded in from the old
    // inline ↻ button (removed from the MASK row) so the main refresh
    // is the single sync entry point for everything PS-side.
    setSelectionTick(t => t + 1);
  };

  // v1.20.70 — Diagnostics handlers (Settings drawer).
  // Open the plugin's per-user data folder in the OS file browser.
  const onOpenDataFolder = async () => {
    try {
      const { storage, shell } = require("uxp");
      const folder = await storage.localFileSystem.getDataFolder();
      const native = (folder as any).nativePath ?? (folder as any).url ?? folder;
      // Try shell.openPath (modern); fall back to openExternal with file:// URL.
      if (shell?.openPath) await shell.openPath(native);
      else if (shell?.openExternal && native) await shell.openExternal(`file://${native}`);
      setStatus(`Data folder: ${native}`);
    } catch (e: any) {
      setStatus(`Open data folder failed: ${e?.message ?? e}`);
    }
  };
  // Export the entire persisted-settings file to a user-chosen location.
  const onExportConfig = async () => {
    try {
      const uxp = require("uxp");
      const stamp = new Date().toISOString().slice(0, 10);
      const fname = `color-smash-config-${stamp}.json`;
      const target = await uxp.storage.localFileSystem.getFileForSaving(fname, {
        types: ["json"],
      });
      if (!target) return;
      // Read current saved-settings file content; if missing, build from live state.
      const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
      const entries = await dataFolder.getEntries();
      const settingsFile = entries.find((e: any) => e.name === "color-smash-settings.json");
      let payload: string;
      if (settingsFile) {
        payload = await settingsFile.read({ format: uxp.storage.formats.utf8 });
      } else {
        payload = JSON.stringify({ note: "No persisted settings file found — start the plugin with Persistence ON, change a setting, and try again." }, null, 2);
      }
      await target.write(payload, { format: uxp.storage.formats.utf8 });
      setStatus(`Config exported: ${target.name}`);
    } catch (e: any) {
      setStatus(`Export config failed: ${e?.message ?? e}`);
    }
  };
  // Import a previously-exported config JSON, overwriting current settings.
  const onImportConfig = async () => {
    try {
      const uxp = require("uxp");
      const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"] });
      if (!file) return;
      const text = await file.read({ format: uxp.storage.formats.utf8 });
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Not a JSON object.");
      // Write into the plugin's settings file. The next reload will pick it up.
      const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
      const target = await dataFolder.createFile("color-smash-settings.json", { overwrite: true });
      await target.write(JSON.stringify(parsed), { format: uxp.storage.formats.utf8 });
      setStatus("Config imported. Reload the panel to apply.");
    } catch (e: any) {
      setStatus(`Import config failed: ${e?.message ?? e}`);
    }
  };

  // v1.20.70 — section "island" styles. Each major section (Source,
  // Target, Color/Tone/Envelope, Output, Mask, History, Fitted Curves)
  // is wrapped in a softly-rounded frame with a slightly darker
  // background — replaces the old heavy black-bar zone dividers and
  // matches the Adobe panel aesthetic (each section reads as its own
  // contained card).
  const ISLAND: React.CSSProperties = {
    // v1.20.70 — three-step brightness palette, OUTSIDE-IN darker:
    //   panel bg (UXP default, lightest)
    //   ↓ island bg (mid)        ← this
    //   ↓ dropdown / input bg (darkest, see MatchSliders.sel)
    // Each level recesses into the next. Border just barely visible
    // so the island reads as a soft inset pad, not a framed box.
    background: "#4a4a4a",
    border: "1px solid #525252",
    borderRadius: 6,
    padding: "8px 10px",
    display: "flex", flexDirection: "column", gap: 4,
    minWidth: 0,
  };
  const ISLAND_HEADER: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
    color: "#888", textTransform: "uppercase",
    marginBottom: 4, userSelect: "none",
  };

  return (
    // v1.20.70 — three-step palette, OUTSIDE-IN light→dark per reference:
    //   outer wrapper bg #555555 (lightest)
    //   island bg       #444444 (mid)
    //   dropdown/control #2e2e2e (darkest)
    <div style={{ padding: 8, background: "#555555", display: "flex", flexDirection: "column", gap: 8 }}>
      {/* v1.20.70 — header layout: [wordmark left] [↶ ↷ center, PS native
          undo/redo] [💾 REVERT ✕ ⟳ ⚙ ? right]. Plugin-action cluster
          moved here from the bottom action row so the body row carries
          only target-specific actions (JUMP, ISOLATE). The two arrow
          glyphs in the center are intentionally separated from REVERT
          (text pill) so users don't conflate them. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        height: 24, marginBottom: 2,
      }}>
        {/* Left: wordmark. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.7, flexShrink: 1, minWidth: 0 }}>
          <img src="icons/icon-light.png" alt=""
            style={{ width: 14, height: 14, flexShrink: 0, imageRendering: "auto" }} />
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.5,
            color: "#cccccc", userSelect: "none", whiteSpace: "nowrap",
          }}>Color Smash</span>
          <span style={{
            fontSize: 9, color: "#888", userSelect: "none", whiteSpace: "nowrap",
          }}>v1.20.70</span>
        </div>
        <span style={{ flex: 1 }} />
        {/* Center: panel-state ↶ undo / ↷ redo. Walks a debounced
            snapshot stack of buildXmpState() values. PURE panel-side —
            doesn't trigger PS's own undo (Cmd/Ctrl+Z still does that). */}
        {(() => {
          // Re-read from refs each render — undoTick forces this IIFE
          // to recompute when stacks change.
          void undoTick;
          const canUndo = panelUndoStackRef.current.length > 0;
          const canRedo = panelRedoStackRef.current.length > 0;
          return <>
            <div onClick={canUndo ? onPanelUndo : undefined}
              title={canUndo
                ? `Undo last panel change (${panelUndoStackRef.current.length} in stack). Reverses slider drags, palette tweaks, output-mode swaps, etc. Does NOT touch Photoshop's own undo (use Cmd/Ctrl+Z for that).`
                : "Undo — nothing on the panel-state stack yet. Change a slider / toggle / palette to enable. (Photoshop's own undo for layer creation etc. is Cmd/Ctrl+Z.)"}
              style={{
                width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                color: canUndo ? "#aaa" : "#555",
                border: `1px solid ${canUndo ? "#555" : "#3a3a3a"}`,
                borderRadius: 4, cursor: canUndo ? "pointer" : "default",
                fontSize: 14, lineHeight: 1, boxSizing: "border-box", flexShrink: 0, userSelect: "none",
                opacity: canUndo ? 1 : 0.5,
              }}>↶</div>
            <div onClick={canRedo ? onPanelRedo : undefined}
              title={canRedo
                ? `Redo (${panelRedoStackRef.current.length} in stack). Re-applies a state you just undid. Any new panel change clears the redo stack.`
                : "Redo — nothing on the panel-state redo stack. Undo something first to enable."}
              style={{
                width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                color: canRedo ? "#aaa" : "#555",
                border: `1px solid ${canRedo ? "#555" : "#3a3a3a"}`,
                borderRadius: 4, cursor: canRedo ? "pointer" : "default",
                fontSize: 14, lineHeight: 1, boxSizing: "border-box", flexShrink: 0, userSelect: "none",
                opacity: canRedo ? 1 : 0.5,
              }}>↷</div>
          </>;
        })()}
        <span style={{ flex: 1 }} />
        {/* Right: 💾 REVERT ✕ ⟳ ⚙ ? */}
        <div onClick={onExportLut}
          title="Export the current preset to disk as a portable 33³ .CUBE 3D LUT (loadable in PS, Premiere, Resolve, etc.)."
          style={{
            width: 22, height: 22,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "transparent", color: "#aaa",
            border: "1px solid #555",
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            fontSize: 12, lineHeight: 1,
            boxSizing: "border-box", flexShrink: 0,
          }}>💾</div>
        <div onClick={onRevertClick}
          title={preRevertSnapshot
            ? "UN-REVERT — restore the panel state from just before your last REVERT (in-memory shadow slot). Safety net for accidental REVERT clicks."
            : canRestore
              ? "REVERT panel state to the snapshot stored in the selected Match layer's XMP. Snaps every slider, preset, palette weight, and doc/layer choice back to the state that produced this layer. Auto-saves a 'Before REVERT' history entry first, so this action is recoverable."
              : "Disabled — no Color Smash metadata found on the active layer. Click a previously-baked Match layer in the Layers panel to enable."}
          style={{
            padding: "0 8px", fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            background: preRevertSnapshot ? "#3a3228" : (canRestore ? "#283440" : "#2a2a2a"),
            color: preRevertSnapshot ? "#e8c882" : (canRestore ? "#7aa8d8" : "#aaaaaa"),
            border: `1px solid ${preRevertSnapshot ? "#d8b87a" : (canRestore ? "#7aa8d8" : "#555")}`,
            borderRadius: 4,
            cursor: (preRevertSnapshot || canRestore) ? "pointer" : "default",
            userSelect: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            height: 22, lineHeight: "20px", boxSizing: "border-box",
            flex: "0 0 auto",
            opacity: (preRevertSnapshot || canRestore) ? 1 : 0.7,
          }}>{preRevertSnapshot ? "UN-REVERT" : "REVERT"}</div>
        <div onClick={async () => {
          const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
          if (ok) onResetAll();
        }}
          title="Reset all panel settings to defaults and clear the saved file"
          style={{
            width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 13, lineHeight: 1,
            border: "1px solid #b34a4a", borderRadius: 4, cursor: "pointer", boxSizing: "border-box", flexShrink: 0,
          }}>
          <span style={{ marginTop: -1 }}>✕</span>
        </div>
        <div onClick={onRefreshAll}
          title={stale
            ? "Photoshop changed since last refresh — click to resync everything (docs, layer lists, source/target previews, selection mask)."
            : "In sync. Click to force-refresh source + target previews + layer lists + selection mask."}
          style={{
            width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: stale ? "#c19a3a" : "transparent",
            color: stale ? "#fff" : "#aaa",
            border: `1px solid ${stale ? "#c19a3a" : "#555"}`,
            borderRadius: 4, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 13, userSelect: "none",
          }}>
          <span style={{ marginTop: -1, lineHeight: 1 }}>⟳</span>
        </div>
        <div onClick={() => setSettingsOpen(o => !o)}
          title={settingsOpen
            ? "Close settings drawer."
            : "Open settings — group color/name, LUT options, AUTO debounce, history cap, persistence, diagnostics."}
          style={{
            width: 22, height: 22,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: settingsOpen ? "#3a3a3a" : "transparent",
            color: settingsOpen ? "#dddddd" : "#888",
            border: `1px solid ${settingsOpen ? "#888" : "#555"}`,
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            fontSize: 12, lineHeight: 1,
            boxSizing: "border-box", flexShrink: 0,
          }}>⚙</div>
        <span onClick={(e: any) => { e.stopPropagation(); e.preventDefault(); void uxpInfo("Color Smash — about", [
          { heading: "What this is",
            body: "Histogram-matching color grade between a source and target layer. Outputs editable Curves (RGB / Lab) or 3D Color Lookup adjustment layers, organized in a [Color Smash] group with masks and round-trippable XMP metadata. Each output mode bakes a separate layer that can coexist in the group so you can A/B them." },
          { heading: "Quick start",
            body: "1. Pick a source in SOURCE / REFERENCE (any open doc, a marquee, or a file on disk).\n2. Pick a target in TARGET / PREVIEW.\n3. Open the OUTPUT island and click RGB, Lab, or LUT — clicking a tab BOTH swaps the output mode AND applies in one click.\n4. Optional: expand MASK or TRANSFORM (Color / Tone / Envelope) for finer control. Pin recipes in HISTORY; ↓ IMPORT / ↑ EXPORT to share." },
          { heading: "Header icons (left → right)",
            body: "↶ ↷ — PANEL-state undo / redo. Reverses slider drags, palette tweaks, output-mode swaps, toggles — anything that changes the panel. Cmd/Ctrl+Z (or Cmd/Ctrl+Shift+Z to redo, or Ctrl+Y on Windows) inside the panel triggers the same actions; while PS has focus those same shortcuts hit PS's own undo. Dim when there's nothing to undo/redo. Capacity 30, oldest auto-evicted. Snapshots are debounced 250ms so slider drags collapse into a single undo step. 💾 — export the current preset to disk as a portable 33³ .CUBE 3D LUT. REVERT — restore panel state from the active Match layer's XMP. A 'Before REVERT' history entry is auto-saved as a permanent safety net; click REVERT again while it's still displayed as UN-REVERT to undo the revert from a one-shot in-memory shadow slot. ✕ — reset all panel settings to defaults (confirm dialog). ⟳ — resync source / target / layer lists / selection mask from PS. ⚙ — open the Settings drawer (group color, group name, LUT options, AUTO debounce, history cap, persistence, diagnostics)." },
          { heading: "Sections",
            body: "Panel sections render as soft 'islands'. SOURCE / REFERENCE and TARGET / PREVIEW are always visible (they're the input surface). TRANSFORM / OUTPUT / MASK / HISTORY / FITTED CURVES are collapsible — only OUTPUT is open by default. Each island's ▾/▸ disclosure on its header label toggles visibility." },
          { heading: "Version",
            body: "Color Smash v1.20.70. Branch: master. Builds cleanly on PS 25.0+." },
        ]); }}
          title="About Color Smash"
          style={{
            cursor: "pointer", fontSize: 11, fontWeight: 700, opacity: 0.85,
            border: "1px solid #555", borderRadius: 4,
            width: 22, height: 22,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1, userSelect: "none", flexShrink: 0, color: "#aaa",
            boxSizing: "border-box",
          }}>?</span>
      </div>
      {/* v1.20.70 — Settings drawer. Toggled by the ⚙ icon in the header.
          Inline (not modal) so it composes with the rest of the panel. */}
      {settingsOpen && (() => {
        // Reusable per-row layout: 80px label column, controls flex 1.
        // Keeps every row's left edge aligned and gives the right side
        // the same horizontal extent across rows.
        const LABEL_W = 84;
        const ROW: React.CSSProperties = {
          display: "flex", alignItems: "center", gap: 6,
          minHeight: 22,
        };
        const LABEL: React.CSSProperties = {
          width: LABEL_W, flexShrink: 0,
          fontSize: 10, color: "#bbb", letterSpacing: 0.3,
        };
        const SECTION_HEADER: React.CSSProperties = {
          display: "flex", alignItems: "center", gap: 4,
          marginTop: 4, padding: "2px 0",
          fontSize: 10, fontWeight: 700, color: "#e8c882", letterSpacing: 0.5,
          cursor: "pointer", userSelect: "none",
        };
        const sectionToggle = (key: keyof typeof settingsSection) =>
          () => setSettingsSection(prev => ({ ...prev, [key]: !prev[key] }));
        const COLORS: Array<{ id: typeof groupColor; swatch: string; label: string }> = [
          { id: "none",   swatch: "transparent", label: "None"   },
          { id: "red",    swatch: "#c34a4a",     label: "Red"    },
          { id: "orange", swatch: "#d8884a",     label: "Orange" },
          { id: "yellow", swatch: "#d8c14a",     label: "Yellow" },
          { id: "green",  swatch: "#5ea85e",     label: "Green"  },
          { id: "blue",   swatch: "#5a8ad8",     label: "Blue"   },
          { id: "violet", swatch: "#9a6acc",     label: "Violet" },
          { id: "gray",   swatch: "#888",        label: "Gray"   },
        ];
        return (
          <div style={{
            border: "1px solid #444", borderRadius: 4,
            background: "#1f1f1f",
            padding: 8, marginTop: -2, marginBottom: 4,
            display: "flex", flexDirection: "column", gap: 4,
          }}>
            {/* Drawer title bar. */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#dddddd" }}>SETTINGS</span>
              <span style={{ flex: 1 }} />
              <span onClick={() => setSettingsOpen(false)}
                title="Close settings drawer."
                style={{
                  width: 18, height: 18, cursor: "pointer", userSelect: "none",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  border: "1px solid #555", borderRadius: 3, color: "#aaa",
                  fontSize: 10, lineHeight: 1, boxSizing: "border-box",
                }}>✕</span>
            </div>

            {/* ── General ── */}
            <div style={SECTION_HEADER} onClick={sectionToggle("general")}>
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{settingsSection.general ? "▾" : "▸"}</span>
              <span>GENERAL</span>
            </div>
            {settingsSection.general && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12 }}>
                {/* Group color picker — 8 color swatches in a row. */}
                <div style={ROW}>
                  <span style={LABEL} title="Photoshop color tag applied to the [Color Smash] group in the Layers panel. Decorative — helps the group stand out. 'None' disables the tag.">Group color</span>
                  <div style={{ display: "flex", flex: 1, gap: 3, flexWrap: "wrap" }}>
                    {COLORS.map(c => {
                      const active = groupColor === c.id;
                      return (
                        <div key={c.id ?? "none"} onClick={() => setGroupColor(c.id)}
                          title={c.label}
                          style={{
                            width: 22, height: 22, flexShrink: 0,
                            background: c.id === "none" ? "transparent" : c.swatch,
                            backgroundImage: c.id === "none"
                              ? "linear-gradient(45deg, transparent 46%, #d84a4a 46%, #d84a4a 54%, transparent 54%)"
                              : undefined,
                            border: `2px solid ${active ? "#e8c882" : "#444"}`,
                            borderRadius: 4, cursor: "pointer", userSelect: "none",
                            boxSizing: "border-box",
                          }} />
                      );
                    })}
                  </div>
                </div>
                {/* Group name editor. */}
                <div style={ROW}>
                  <span style={LABEL} title="Name used for the canonical [Color Smash] group in PS. Defaults to '[Color Smash]'. Empty input reverts to default on save.">Group name</span>
                  <input type="text" value={groupName}
                    onChange={e => setGroupName(e.target.value)}
                    onBlur={() => { if (!groupName.trim()) setGroupName("[Color Smash]"); }}
                    style={{
                      flex: 1, minWidth: 0, height: 22, padding: "0 6px",
                      background: "#2a2a2a", color: "#ddd",
                      border: "1px solid #555", borderRadius: 3,
                      fontSize: 11, lineHeight: "20px",
                      boxSizing: "border-box",
                    }} />
                </div>
                {/* Persistence toggle (moved from the header gear). */}
                <div style={ROW}>
                  <span style={LABEL} title="When ON, panel settings (sliders, palette weights, envelope, output mode, etc.) are saved to disk and restored across reloads.">Persistence</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none", fontSize: 10, color: "#bbb" }}>
                    <input type="checkbox" checked={remember}
                      onChange={e => setRemember(e.target.checked)}
                      style={{ margin: 0, width: 14, height: 14 }} />
                    <span>{remember ? "Saved across reloads" : "Reset on next reload"}</span>
                  </label>
                </div>
              </div>
            )}

            {/* ── LUT ── */}
            <div style={SECTION_HEADER} onClick={sectionToggle("lut")}>
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{settingsSection.lut ? "▾" : "▸"}</span>
              <span>LUT</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 9, fontWeight: 400, color: "#888", letterSpacing: 0 }}>
                {outputMode !== "lut" ? "(only applies when output = LUT)" : null}
              </span>
            </div>
            {settingsSection.lut && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12, opacity: outputMode !== "lut" ? 0.55 : 1 }}>
                <div style={ROW} title={`LUT strength: ${lutStrength}% — blends the generated 3D LUT toward an identity LUT before bake. 100% = full match, 0% = identity (no transform). The lerp is baked into the LUT bytes, so portable .cube exports carry the dialed-back look.`}>
                  <span style={LABEL}>Strength</span>
                  <input type="range" min={0} max={100} step={1} value={lutStrength}
                    onChange={e => setLutStrength(parseInt((e.target as HTMLInputElement).value, 10))}
                    style={{ flex: 1, minWidth: 0, margin: 0, cursor: "pointer" }} />
                  <span style={{ fontSize: 10, color: "#aaa", width: 32, textAlign: "right", flexShrink: 0 }}>{lutStrength}%</span>
                </div>
                <div style={ROW}>
                  <span style={LABEL} title="3D LUT grid density. Higher = smoother gradients, larger files.">Quality</span>
                  <div style={{ display: "flex", flex: 1, gap: 2, minWidth: 0 }}>
                    {([
                      [17 as const, "Draft 17³",   "Draft quality: 17³ grid (~50KB). Fastest, visible banding in subtle gradients."],
                      [33 as const, "Standard 33³","Standard quality: 33³ grid (~430KB). Default. Matches PS Color Lookup's own default."],
                      [65 as const, "High 65³",    "High quality: 65³ grid (~3.3MB). Smoothest result, larger files."],
                    ] as Array<[17 | 33 | 65, string, string]>).map(([val, label, tip]) => (
                      <div key={val} onClick={() => setLutGrid(val)} title={tip}
                        style={{
                          flex: "1 1 0", minWidth: 0, height: 22, padding: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          overflow: "hidden", whiteSpace: "nowrap",
                          fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                          background: lutGrid === val ? "#3a3a3a" : "transparent",
                          color: lutGrid === val ? "#dddddd" : "#888",
                          border: `1px solid ${lutGrid === val ? "#888" : "#444"}`,
                          borderRadius: 3, cursor: "pointer", userSelect: "none",
                          lineHeight: "20px", boxSizing: "border-box",
                        }}>{label}</div>
                    ))}
                  </div>
                </div>
                <div style={ROW}>
                  <span style={LABEL} title="PS Color Lookup's noise-injection field that hides quantization banding. Default ON.">Dither</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none", fontSize: 10, color: "#bbb" }}>
                    <input type="checkbox" checked={lutDither}
                      onChange={e => setLutDither(e.target.checked)}
                      style={{ margin: 0, width: 14, height: 14 }} />
                    <span>{lutDither ? "Enabled (smoother gradients)" : "Disabled (bit-exact LUT)"}</span>
                  </label>
                </div>
              </div>
            )}

            {/* ── Advanced ── */}
            <div style={SECTION_HEADER} onClick={sectionToggle("advanced")}>
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{settingsSection.advanced ? "▾" : "▸"}</span>
              <span>ADVANCED</span>
            </div>
            {settingsSection.advanced && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12 }}>
                <div style={ROW} title={`AUTO debounce: ${autoDebounceMs}ms — wait window between the last slider change and the live re-bake. Lower = snappier (more re-bakes). Higher = smoother (fewer re-bakes).`}>
                  <span style={LABEL}>AUTO debounce</span>
                  <input type="range" min={60} max={1000} step={20} value={autoDebounceMs}
                    onChange={e => setAutoDebounceMs(parseInt((e.target as HTMLInputElement).value, 10))}
                    style={{ flex: 1, minWidth: 0, margin: 0, cursor: "pointer" }} />
                  <span style={{ fontSize: 10, color: "#aaa", width: 48, textAlign: "right", flexShrink: 0 }}>{autoDebounceMs}ms</span>
                </div>
                <div style={ROW} title={`History capacity: ${historyCap} entries. Maximum ring-buffer size for the recent-history strip. Pinned entries are kept even when capacity is exceeded; unpinned ones are evicted oldest-first.`}>
                  <span style={LABEL}>History cap</span>
                  <input type="range" min={5} max={30} step={1} value={historyCap}
                    onChange={e => setHistoryCap(parseInt((e.target as HTMLInputElement).value, 10))}
                    style={{ flex: 1, minWidth: 0, margin: 0, cursor: "pointer" }} />
                  <span style={{ fontSize: 10, color: "#aaa", width: 48, textAlign: "right", flexShrink: 0 }}>{historyCap}</span>
                </div>
                {/* v1.20.70 — "Adaptive bands" toggle removed alongside
                    the multi-zone UI. State stays in place for recipe
                    compat but is no longer user-exposed. */}
              </div>
            )}

            {/* ── Diagnostics ── */}
            <div style={SECTION_HEADER} onClick={sectionToggle("diag")}>
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{settingsSection.diag ? "▾" : "▸"}</span>
              <span>DIAGNOSTICS</span>
            </div>
            {settingsSection.diag && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12 }}>
                <div style={ROW}>
                  <span style={LABEL} title="When ON, the status line surfaces extra timing + batchPlay diagnostic detail. Useful when reporting bugs.">Verbose status</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none", fontSize: 10, color: "#bbb" }}>
                    <input type="checkbox" checked={verboseStatus}
                      onChange={e => setVerboseStatus(e.target.checked)}
                      style={{ margin: 0, width: 14, height: 14 }} />
                    <span>{verboseStatus ? "Detailed status messages" : "Concise status messages"}</span>
                  </label>
                </div>
                <div style={ROW}>
                  <span style={LABEL} title="Reveal the plugin's per-user data folder in your OS file browser. Inspect color-smash-settings.json, recipes, etc.">Data folder</span>
                  <div onClick={onOpenDataFolder}
                    style={{
                      padding: "0 10px", height: 22,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 600,
                      background: "#2a2a2a", color: "#ddd",
                      border: "1px solid #555", borderRadius: 3,
                      cursor: "pointer", userSelect: "none", boxSizing: "border-box",
                    }}>Reveal in OS</div>
                </div>
                <div style={ROW}>
                  <span style={LABEL} title="Save a JSON dump of every persisted panel setting to disk. Useful as a config backup or to share your setup.">Export config</span>
                  <div onClick={onExportConfig}
                    style={{
                      padding: "0 10px", height: 22,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 600,
                      background: "#2a2a2a", color: "#ddd",
                      border: "1px solid #555", borderRadius: 3,
                      cursor: "pointer", userSelect: "none", boxSizing: "border-box",
                    }}>↓ Save JSON</div>
                </div>
                <div style={ROW}>
                  <span style={LABEL} title="Load a previously-exported JSON config. Overwrites every current panel setting with the values from the file.">Import config</span>
                  <div onClick={onImportConfig}
                    style={{
                      padding: "0 10px", height: 22,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 600,
                      background: "#2a2a2a", color: "#ddd",
                      border: "1px solid #555", borderRadius: 3,
                      cursor: "pointer", userSelect: "none", boxSizing: "border-box",
                    }}>↑ Load JSON</div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* SOURCE / REFERENCE island. v1.20.70. */}
      <div style={ISLAND}>
        <div style={ISLAND_HEADER}>SOURCE / REFERENCE</div>
      {/* Source picker — full width, doc dropdown + dense layer list + thumbnail right.
          Target lives below (above the preview) and reuses the preview itself for its
          visual feedback, so the target column no longer needs its own thumbnail. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          {recipeMode && (
            <div
              onClick={() => { setRecipeMode(false); setSavedSourceSwatches(null); setRecipeSrcSnap(null); setRecipeLabel(""); }}
              title="A recipe preset is acting as the source — the live layer below is bypassed. Click to drop the preset and return to live source extraction."
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "4px 8px", marginBottom: 2,
                fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                background: "linear-gradient(90deg, #4a2a4a 0%, #3a2a4a 100%)",
                color: "#e6c6e6",
                border: "1px solid #7a4a7a", borderRadius: 3,
                cursor: "pointer", userSelect: "none",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11 }}>◆</span>
                <span>SOURCE: PRESET</span>
                <span style={{ opacity: 0.75, fontWeight: 500 }}>{recipeLabel}</span>
              </span>
              <span style={{ opacity: 0.7, fontWeight: 500 }}>✕ drop</span>
            </div>
          )}
          <SourceSelector
            docs={docs} activeDocId={srcDocId} srcMode={srcMode} browsedFile={browsedFile}
            onSwitchDoc={onSwitchSrcDoc} onSwitchSrcMode={switchSrcMode}
            setBrowsedFile={setBrowsedFile} onBrowseImage={onBrowseImage}
            layers={srcLayers} sourceId={sourceId} setSourceId={setSourceId}
            autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate}
            sampleMerged={sampleMerged} setSampleMerged={setSampleMerged}
            sampleLock={sampleLock} setSampleLock={setSampleLock}
            selStyle={sel}
            onRefreshLayers={refreshSrcAll}
            docsKey={docsKey}
            layersKey={srcLayersKey}
            // Source thumbnail slot: PresetStrip on top (interactive Full /
            // Color / Contrast staging — these are the source previews under
            // each preset) and PaletteStrip below (display-only k-means
            // swatches that visually "synthesize" out of the previews above).
            // Order intentional: previews → palette reads as cause → effect.
            //
            // PaletteStrip mirrors the active preset: Full shows raw clusters,
            // Color flattens luminance for pure-hue swatches, Contrast desats
            // to a grayscale value strip — the palette is a visual preview of
            // what the source contributes to the match under that preset.
            thumbnail={
              // v1.21 — two thumbnail layouts depending on mode:
              //   Match → PresetStrip (Full/Color/Hue/Sat/Contrast preview row)
              //           + source PaletteStrip (k-means swatch weight bar)
              //   Smash → plain source image thumbnail (raw pixels, no preset
              //           transform). Confirms which layer the user just picked.
              //           Smash has its own DNA strip + preset row + audit in
              //           SmashSection so the Match-mode tools aren't useful
              //           here, but the user still wants to SEE the source.
              (__SMASH_ENABLED__ && smashMode === "smash") ? (
                smashSourceThumbnailUrl ? (
                  <img
                    src={smashSourceThumbnailUrl}
                    style={{
                      width: "100%", height: "auto",
                      maxHeight: 120, objectFit: "contain",
                      borderRadius: 3, background: "#1a1a1a",
                    }}
                  />
                ) : (
                  <div style={{
                    padding: "12px 8px", fontSize: 10, color: "#777",
                    fontStyle: "italic", textAlign: "center",
                    border: "1px dashed #333", borderRadius: 3,
                  }}>
                    Pick a source layer to preview.
                  </div>
                )
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <PresetStrip
                    srcRgba={srcSnap?.data ?? null}
                    srcWidth={srcSnap?.width ?? 0}
                    srcHeight={srcSnap?.height ?? 0}
                    active={activePreset}
                    onSelect={setActivePreset}
                  />
                  <PaletteStrip
                    swatches={paletteSwatches}
                    weights={paletteWeights}
                    setWeights={setPaletteWeights}
                    preset={activePreset}
                    count={paletteCount}
                    setCount={setPaletteCount}
                    adaptive={paletteAdaptive}
                    setAdaptive={setPaletteAdaptive}
                    softness={sourceSoftness}
                    setSoftness={setSourceSoftness}
                  />
                </div>
              )
            }
          />
        </div>
      </div>{/* end SOURCE island */}

      {/* TARGET / PREVIEW island. v1.20.70. */}
      <div style={ISLAND}>
        <div style={ISLAND_HEADER}>TARGET / PREVIEW</div>
      {/* Target selector — single horizontal row directly above the matched preview:
          [doc dropdown] [layer dropdown] [refresh]. Kept compact (no list, no thumbnail)
          because the preview pane itself shows the target via the Before/After badge. */}
      <div style={{ marginTop: 6, display: "flex", gap: 4, alignItems: "center" }}>
        <select key={`tgtdoc-${docsKey}-${tgtLayersKey}`} style={{ ...sel, flex: 1, minWidth: 0 }} value={tgtDocId ?? ""} onChange={e => onSwitchTgtDoc(Number(e.target.value))}
          title="Target document — where the new Curves layer will land. Independent of the source doc.">
          {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select key={`tgtlayer-${docsKey}-${tgtLayersKey}`} style={{ ...sel, flex: 1, minWidth: 0 }} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}
          title="Target layer — the layer the Curves adjustment will be clipped to.">
          {tgtLayers.length === 0 && <option value="">— none —</option>}
          {tgtLayers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value={MERGED_LAYER_ID}>Merged</option>
        </select>
        {/* ⟳ demoted: smaller and dim. PS event listener auto-refreshes everything in
            the background, so this is now a fallback for the rare cross-plugin
            descriptor-cache case where PS itself returns stale data. */}
        <div onClick={refreshTgtAll} title="Force refresh — rare; only needed if names look stale after another plugin's batch ops"
          style={{ width: 18, height: 18, marginTop: 2, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #555", borderRadius: 2, color: "#888", fontSize: 12, userSelect: "none", boxSizing: "border-box", flexShrink: 0, opacity: stale ? 1 : 0.5 }}>
          <span style={{ marginTop: -2, marginLeft: 1, lineHeight: 1 }}>⟳</span>
        </div>
      </div>

      {/* v1.20.63 — when no target is selected the preview is just empty
          black space. Render a thin placeholder banner instead so the
          panel doesn't have a void in the middle. Once a target lands,
          MatchedPreview takes over and the placeholder is replaced. */}
      {targetId == null ? (
        <div style={{
          marginTop: 4, padding: "18px 8px",
          fontSize: 10, color: "#777", fontStyle: "italic",
          background: "transparent", border: "1px dashed #333", borderRadius: 3,
          textAlign: "center", lineHeight: 1.4,
        }}>
          Pick a target layer above to preview the match.
          <br />
          <span style={{ opacity: 0.7 }}>Source: {srcDocId != null ? "✓" : "—"} · Target: —</span>
        </div>
      ) : (
        <MatchedPreview
          ref={matchedHandleRef}
          canSwap={srcMode === "layer"}
          onSwap={() => {
            setSrcDocId(tgtDocId);
            setTgtDocId(srcDocId);
            setSourceId(targetId);
            setTargetId(sourceId);
          }}
        />
      )}

      {/* v1.21 — Pro mode toggle. Renders directly below the matched preview
          but INSIDE the TARGET / PREVIEW island. Visually anchors the toggle
          to the preview which is the shared surface. Gated by __SMASH_ENABLED__
          so the free build's MatchTab renders byte-equivalent to today. */}
      {__SMASH_ENABLED__ && (
        <ModeToggle mode={smashMode} onModeChange={setSmashMode} />
      )}

      {/* Target palette weight bar — Match-only control inside TARGET / PREVIEW
          island. Wrapped in a Smash-mode conditional so it disappears when
          flipping to Smash (Smash doesn't speak per-cluster target weights). */}
      {(!__SMASH_ENABLED__ || smashMode === "match") && (
        <div style={{ marginTop: 4 }}>
          <PaletteStrip
            swatches={targetPaletteSwatches}
            weights={targetPaletteWeights}
            setWeights={setTargetPaletteWeights}
            count={paletteCount}
            setCount={setPaletteCount}
            adaptive={paletteAdaptive}
            setAdaptive={setPaletteAdaptive}
            softness={targetSoftness}
            setSoftness={setTargetSoftness}
          />
        </div>
      )}
      </div>{/* end TARGET island */}

      {/* Match-mode lower controls (TRANSFORM, OUTPUT, MASK, HISTORY,
          FITTED CURVES islands). Conditionally rendered as a Fragment so
          there's no extra wrapping div — the islands' margins and gaps
          continue to compose with the outer flex column exactly as in
          Match-only builds. MatchTab's state hooks survive unmount, so
          flipping Smash → Match → Smash restores all slider positions. */}
      {(!__SMASH_ENABLED__ || smashMode === "match") && (<>

      {/* COLOR / TONE / ENVELOPE island. v1.20.70. The 3 inline section
          dividers (each was a 1px gray rule) are removed — the island
          frame already groups them, and inner separators inside the
          island are softer. */}
      <div style={ISLAND}>
        <div onClick={() => setTransformOpen(o => !o)}
          style={{ ...ISLAND_HEADER, marginBottom: transformOpen ? 4 : 0, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          title={transformOpen ? "Hide transform controls (Color / Tone / Envelope)" : "Show transform controls (Color / Tone / Envelope)"}>
          <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{transformOpen ? "▾" : "▸"}</span>
          <span>TRANSFORM</span>
        </div>
        {transformOpen && <>{/* TRANSFORM body */}
      {/* Accordion controls */}
      <div onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enColor ? "#dddddd" : "#888", fontStyle: enColor ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnColor(!enColor); }}
            title={enColor ? "Color section ENABLED — click to disable (revert all Color params to defaults)" : "Color section DISABLED — click to enable"}
            style={{ width: 11, height: 11, borderRadius: 2, flexShrink: 0,
                     background: enColor ? "#3a3a3a" : "transparent",
                     border: `1px solid ${enColor ? "#888" : "#555"}`,
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                     fontSize: 10, fontWeight: 700, color: "#ddd", lineHeight: 1,
                     cursor: "pointer", userSelect: "none" }}>{enColor ? "✓" : ""}</span>
          <Icon name={openSection === "basic" ? "chevronDown" : "chevronRight"} size={11} /> Color
        </span>
        <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Color — what each control does", [
          { heading: "Section purpose",
            body: "Shapes the per-channel R/G/B match curves before they're combined and output. These controls operate on the raw fitted curves: blending strength, smoothing, slope cap, and the Hue-only blend mode for the final layer." },
          { heading: "Amount",
            body: "Strength of the histogram match, 0–100%. Blends the matched curve with identity. 100% = full match. 50% = half-strength match. 0% = no match (identity curves)." },
          { heading: "Smooth",
            body: "Box-filter smoothing radius applied to the curves after blending, 0–32. Higher values average over a wider window — useful when the source histogram is sparse or noisy. 0 = no smoothing. Mild values (4–8) typically clean things up without losing tonal detail." },
          { heading: "Stretch",
            body: "Local slope cap. Limits how steep adjacent curve points can rise or fall. 1 = hard cap (slope ≤ 1 per step) — heavily flattens any aggressive contrast. 15 = essentially uncapped. Most visible changes happen in the 1–8 range." },
          { heading: "Anchor stretch to histogram range",
            body: "Toggle. When on, the slope cap walks from where the target image's data actually starts/ends (≥0.5% of peak count) instead of always 0–255. Makes Stretch behave consistently across bright vs dark sources." },
          { heading: "Hue only",
            body: "Toggle. Sets the output Curves layer to Photoshop's Hue blend mode (instead of Normal). Result: only the hue shifts toward the source; target's saturation and luminance are preserved. Sidesteps the saturation inflation that per-channel curves naturally produce." },
          { heading: "Source palette weights bar (SOURCE / REFERENCE island)",
            body: "K-means swatches sampled from the source in CIE Lab space, sorted dark→left to light→right. The palette toolbar above the bar holds: softness slider (cluster-falloff), ↔ adapt mode toggle, 3 / 5 / 7 cluster-count picker, ✕ reset. Bar segment widths are proportional: each cluster's natural prevalence × your multiplier. Default 'handle mode' — drag the white dividers between segments to redistribute weight pair-wise between two adjacent neighbors. ↔ adapt mode — drag a swatch BODY instead of a divider; that swatch grows/shrinks and all others rebalance proportionally. ✕ reset restores neutral (×1) weights. Source weights bias the histogram fit — which source colors influence the computed curves. Drives both live preview and the bake." },
          { heading: "Target palette weights bar (TARGET / PREVIEW island)",
            body: "Same UI as the source bar (softness / ↔ / 3-5-7 / ✕ toolbar above a full-width bar) but different math. Target weights control curve application strength per cluster — drag a swatch toward 0 to leave that color region of the target untouched while the rest gets matched. Replaces the old Zones accordion. The per-cluster attenuation gate is unified with the MASK island button at the bottom of the panel (see MASK section below) — there's no longer a separate mask toggle on this bar." },
          { heading: "MASK island (single source of mask control)",
            body: "Single MASK button toggles BOTH the red preview overlay (visualization) and the per-cluster + selection-mask attenuation gate (which bakes a layer mask onto the output Curves / LUT layer). Default ON. The Off / Focus / Exclude pills next to MASK control whether the active marquee composes with the palette mask: Off = ignore marquee, Focus = apply only inside marquee, Exclude = apply only outside." },
          { heading: "Softness slider (palette toolbar, above each bar)",
            body: "Falloff between cluster regions, 0–100. 0 = hard nearest-cluster boundary. 100 = smooth Lorentzian blend across all clusters. Visible immediately as feathering on the bar itself. Source and target each have their own slider — both persisted." },
        ]); }}
          title="What this section does — full explanation"
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
      </div>
      {openSection === "basic" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            <span style={{ opacity: 0.75, flexShrink: 0 }}>Mode</span>
            <select value={matchMode} onChange={e => { setMatchMode(e.target.value as MatchMode); scheduleRedraw(); }}
              title="Match algorithm. Full = match the whole histogram (default, most aggressive). Mean/Median = just shift color cast (subtle). Percentile = anchor a few percentile points (middle ground)."
              style={{ ...sel, flex: 1, height: 22 }}>
              <option value="full">Full distribution</option>
              <option value="percentile">Percentile anchors</option>
              <option value="median">Median shift</option>
              <option value="mean">Mean shift</option>
            </select>
          </div>
          <BasicSlider label="Amount"  refObj={amountRef}  value={amountLabel}  setValue={setAmountLabel}  min={0} max={100} suffix="%" defaultVal={100} scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Smooth"  refObj={smoothRef}  value={smoothLabel}  setValue={setSmoothLabel}  min={0} max={32}  defaultVal={0}   scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Stretch" refObj={stretchRef} value={stretchLabel} setValue={setStretchLabel} min={1} max={15}  defaultVal={8}   scheduleRedraw={scheduleRedraw} step={0.1} />
          <label title="Anchor the slope cap at the target's actual histogram bounds instead of 0/255 — makes Stretch behave consistently regardless of whether the source is bright or dark"
            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, opacity: 0.85, cursor: "pointer", marginLeft: 4 }}>
            <input type="checkbox" checked={anchorStretchToHist} onChange={e => { setAnchorStretchToHist(e.target.checked); scheduleRedraw(); }} style={{ cursor: "pointer", margin: 0 }} />
            Anchor stretch to histogram range
          </label>
          {/* sp-checkbox renders via UXP's global JSX intrinsic-element
              allowance (no per-tag suppression needed in this codebase). */}
          <sp-checkbox checked={chromaOnly || undefined} onInput={(e: any) => setChromaOnly(e.target.checked)} style={{ marginTop: 4, fontSize: 11 }}
            title="Apply only the hue shift; preserve target's saturation and luminance. Uses PS Hue blend mode — sidesteps the saturation inflation that per-channel curves cause.">
            Hue only (preserve target saturation + luminance)
          </sp-checkbox>
        </div>
      )}

      <div onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enTone ? "#dddddd" : "#888", fontStyle: enTone ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnTone(!enTone); }}
            title={enTone ? "Tone section ENABLED — click to disable" : "Tone section DISABLED — click to enable"}
            style={{ width: 11, height: 11, borderRadius: 2, flexShrink: 0,
                     background: enTone ? "#3a3a3a" : "transparent",
                     border: `1px solid ${enTone ? "#888" : "#555"}`,
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                     fontSize: 10, fontWeight: 700, color: "#ddd", lineHeight: 1,
                     cursor: "pointer", userSelect: "none" }}>{enTone ? "✓" : ""}</span>
          <Icon name={openSection === "dims" ? "chevronDown" : "chevronRight"} size={11} /> Tone
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "dims" && <span onClick={(e: any) => { e.stopPropagation(); dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Tone — what each control does", [
            { heading: "Section purpose",
              body: "Reshapes the matched curves along perceptual axes after they're fit. Lets you scale luminance, push or pull saturation, rotate hue, adjust contrast, neutralize color casts, and separate the per-channel response — all without re-fitting." },
            { heading: "Value",
              body: "Scales overall luminance contribution of the match, 0–200%. 100% = pass-through. <100% reduces tonal change. >100% amplifies it." },
            { heading: "Chroma",
              body: "Scales chroma (saturation) contribution, 0–200%. 100% = pass-through. 0% removes saturation changes. 200% doubles the saturation pull toward source." },
            { heading: "Hue",
              body: "Rotates hue of the match output, -180 to +180 degrees. 0 = no rotation. Useful for shifting matched color toward a complementary palette without re-fitting." },
            { heading: "Contrast",
              body: "Scales contrast, 0–200%. 100% = pass-through. <100% flattens. >100% pushes harder." },
            { heading: "Neutralize",
              body: "Pulls the match toward neutral gray, 0–100%. 0% = no neutralization. 100% = fully gray. Useful for taming an over-aggressive color cast while keeping the tonal shaping." },
            { heading: "Separation",
              body: "How independently R/G/B channels respond, 0–200%. 100% = pass-through. <100% blends channels (more neutral). >100% exaggerates differences between channels." },
            { heading: "Reset (header)",
              body: "Restores all six Tone sliders to defaults. Section enable/disable state stays as-is." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
      </div>
      {openSection === "dims" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0 }}>
          {([
            ["Value",      "value",      0, 200, "%"],
            ["Chroma",     "chroma",     0, 200, "%"],
            ["Hue shift",  "hueShift", -180, 180, "°"],
            ["Contrast",   "contrast",   1, 200, "%"],
            ["Neutralize", "neutralize", 0, 100, "%"],
            ["Separation", "separation", 0, 200, "%"],
          ] as Array<[string, keyof DimensionOpts, number, number, string]>).map(([lbl, k, mn, mx, sfx]) => (
            <DimSlider key={k} label={lbl} dimKey={k} min={mn} max={mx} suffix={sfx}
              dimsLabel={dimsLabel} dimsRef={dimsRef} setDimsLabel={setDimsLabel} scheduleRedraw={scheduleRedraw} />
          ))}
        </div>
      )}

      {/* Zones accordion section removed in v1.8: replaced by the target
          palette weight bar above the accordion. The bar is a strictly
          more general tool (color clusters in Lab space vs. the old 3
          fixed luma bands) and feels parallel to the source palette.
          The ZoneOpts math + persistence + applyZoneAndEnvelopeToChannels
          still ship unchanged so older saved settings (with non-default
          zones) load + apply transparently. v1.20.70 — the dead
          {false && ...} UI block (Zones accordion + per-band sliders)
          was removed. zonesRef.current still flows into apply as the
          zones param; if a user had saved zone settings before v1.8
          they still take effect, just no longer editable via UI. */}

      <div onClick={() => toggleSection("envelope")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enEnvelope ? "#dddddd" : "#888", fontStyle: enEnvelope ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnEnvelope(!enEnvelope); }}
            title={enEnvelope ? "Envelope section ENABLED — click to disable" : "Envelope section DISABLED — click to enable"}
            style={{ width: 11, height: 11, borderRadius: 2, flexShrink: 0,
                     background: enEnvelope ? "#3a3a3a" : "transparent",
                     border: `1px solid ${enEnvelope ? "#888" : "#555"}`,
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                     fontSize: 10, fontWeight: 700, color: "#ddd", lineHeight: 1,
                     cursor: "pointer", userSelect: "none" }}>{enEnvelope ? "✓" : ""}</span>
          <Icon name={openSection === "envelope" ? "chevronDown" : "chevronRight"} size={11} /> Envelope{envelopeLabel.length > 0 && <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>· {envelopeLabel.length} pt{envelopeLabel.length === 1 ? "" : "s"}</span>}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "envelope" && (
            <span onClick={(e: any) => { e.stopPropagation(); const def = [...DEFAULT_ENVELOPE]; envelopeRef.current = def; setEnvelopeLabel(def); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>
          )}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Envelope — what each control does", [
            { heading: "What the envelope does",
              body: "Arbitrary-N piecewise weight curve over input range 0–255. Modulates how strongly the match applies at each tonal value. Composes multiplicatively with Zones — fine-grained per-tone weight on top of the broader zone shaping. Default = three identity-weight points (no-op until moved)." },
            { heading: "Track + reference line",
              body: "X = input tone (0 left, 255 right). Y = weight 0 (bottom, suppress match) to 2 (top, double match). Gray bars = target luma histogram. Orange outline = source histogram (the gap the match is closing). Cyan outline = result histogram (current matched output). Mid-line at weight=1 = identity." },
            { heading: "Adding a point",
              body: "Click any empty area of the track. A new smooth point appears and immediately enters drag mode — drop it where you want." },
            { heading: "Moving a point",
              body: "Drag any handle. Shift = lock horizontal (vertical-only). Ctrl/Cmd = lock vertical (horizontal-only)." },
            { heading: "Smooth vs corner points",
              body: "Alt-click a handle to toggle. Smooth = filled circle (●), uses monotone cubic Hermite (no overshoot). Corner = square (■), uses linear interpolation. Mix freely: sharp shadow rolloff + smooth midtones + hard highlight cap." },
            { heading: "Removing a point",
              body: "Double-click, right-click, OR click-to-select then press Delete/Backspace. Selected handles render cyan with white border. Escape clears selection." },
            { heading: "Reset (header)",
              body: "Restores the three default identity-weight points (positions 0, 127, 255 all at weight 1.0)." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
      </div>
      {openSection === "envelope" && (
        <div style={{ padding: "2px 0" }}>
          <EnvelopeEditor
            points={envelopeLabel}
            lumaBins={lumaBins}
            sourceLumaBins={sourceLumaBins}
            resultLumaBins={resultLumaBins}
            onChange={pts => {
              envelopeRef.current = pts;
              setEnvelopeLabel(pts);
              scheduleRedraw();
            }}
          />
        </div>
      )}
      </>}{/* end transformOpen */}
      </div>{/* end TRANSFORM island */}

      {/* OUTPUT island. v1.20.70 — header label + framed container.
          Collapsible via the ▾/▸ disclosure on the header (default
          expanded — the most-used section). */}
      <div style={ISLAND}>
        <div onClick={() => setOutputOpen(o => !o)}
          style={{ ...ISLAND_HEADER, marginBottom: outputOpen ? 4 : 0, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          title={outputOpen ? "Hide output controls" : "Show output controls"}>
          <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{outputOpen ? "▾" : "▸"}</span>
          <span>OUTPUT</span>
        </div>
        {outputOpen && <>{/* OUTPUT body */}

      {/* v1.20.70 — output block restructured again. Apply pill removed:
          tab clicks (RGB/Lab/LUT) now BOTH swap output mode AND fire Apply.
          Column 1 (76px) is now the global-modifier stack:
            top row (aligned w/ RGB|Lab|LUT) = "+" branch arm
            bottom row (aligned w/ MULTI|BLEND) = AUTO armed-record indicator
          The thin top strip drops AUTO and keeps [ADAPT][JUMP][ISOLATE]. */}
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 0 }}>
        {/* v1.20.70 — top strip removed. JUMP / ISOLATE moved DOWN into
            the action row at the bottom of the output block, alongside
            REVERT / RESET / ⟳ / ⚙. ADAPT (was here pre-v1.20.70)
            relocated into the MULTI/BLEND expandable row. */}
        {(() => {
          // v1.20.70 — extracted per-tab meta so the tabs row and the
          // (separate, optional) MULTI/BLEND row can both render from the
          // same source. ACCENT + subState formerly inlined inside the map.
          const ACCENT = "#d8b87a";
          const TABS = ([
            ["rgb", "RGB", "RGB — separable per-channel Curves layer. Click to switch mode AND Apply (bakes a new Curves layer)."],
            ["lab", "Lab", "Lab — perceptual histogram match, projected to per-channel Curves layer. Click to switch mode AND Apply."],
            ["lut", "LUT", "LUT — 33³ Color Lookup adjustment with preset blend math baked in. Click to switch mode AND Apply."],
          ] as Array<["rgb" | "lab" | "lut", string, string]>).map(([val, label, tip], idx) => {
            // v1.20.70 — multi/blend metadata removed (UI retired). Tab
            // styling is just active vs inactive now; the old "dormant"
            // warm tint that signalled "this mode has multi/blend
            // configured" is no longer applicable since neither toggle
            // exists.
            const active = outputMode === val;
            const isFirst = idx === 0;
            const tabS = active
              ? { bg: "#3a3a3a", fg: "#dddddd", bd: ACCENT }
              : { bg: "transparent", fg: "#888", bd: "#444" };
            return { val, label, tip, active, isFirst, tabS };
          });
          return (
        // v1.20.70 — shared 2-column outer layout: col-1 (74px) stacks
        // the [+|○|▼] controls row above an optional ADAPT row; col-2
        // (flex 1) stacks the tabs row above an optional MULTI/BLEND
        // row. Because the col-1 and col-2 *outer columns* are the
        // SAME flex children for both visual rows, their right edges
        // align by construction — no sub-pixel rounding stagger
        // possible between the [+|○|▼] block and ADAPT.
        <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
          {/* Column 1 (60px wide = 28+4+28, flexShrink:0).
              v1.20.70 — was 92 (3 buttons + 2 gaps) when the ▾/▸
              multi-disclosure was the third button. Multi-zone output
              was removed late v1.20.70 to focus the panel on single-
              layer RGB/Lab/LUT bakes, so col-1 now holds just
              [+ branch][○ AUTO] = 28+4+28 = 60. */}
          <div style={{ width: 60, display: "flex", flexDirection: "column", gap: 0, flexShrink: 0 }}>
            {/* Top sub-row inside col-1: + ○ buttons. */}
            <div style={{ display: "flex", gap: 4, height: 28 }}>
          {/* v1.20.70 — + branch arm relocated into the main row so all
              three column-1 controls (+, ○ AUTO, ▶/▼ disclosure) live
              side-by-side. ADAPT then sits directly below them. */}
          <div onClick={e => { e.stopPropagation(); setOverwriteOnApply(!overwriteOnApply); }}
            title={overwriteOnApply
              ? "Click + to arm 'Branch' — next Apply (RGB/Lab/LUT tab click) hides the current [Color Smash] group and starts a fresh session."
              : "BRANCH ARMED — next Apply will collapse + hide the current [Color Smash] group (preserved, just invisible) and start a fresh session. Auto-disarms after that Apply. Click to cancel."}
            style={{
              width: 28, height: 28, padding: 0, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: overwriteOnApply ? "transparent" : "#1e3a1e",
              border: `1px solid ${overwriteOnApply ? "#444" : "#7ad87a"}`,
              borderRadius: 4,
              cursor: "pointer", userSelect: "none", boxSizing: "border-box",
              lineHeight: "26px",
            }}>
            <span style={{
              color: overwriteOnApply ? "#888" : "#7ad87a",
              fontSize: 22, fontWeight: 700, lineHeight: 1,
              display: "block", marginTop: -3, marginLeft: 1,
            }}>+</span>
          </div>
          <div onClick={() => setLiveLut(v => !v)}
            title={liveLut
              ? `AUTO ARMED — slider changes auto-update the existing Match ${outputMode === "lut" ? "LUT" : "Curves"} layer in real-time (debounced 300ms). Click to disarm.`
              : `AUTO — click to arm real-time auto-bake. Match ${outputMode === "lut" ? "LUT" : "Curves"} layer will re-bake on every slider change once seeded by an Apply.`}
            style={{
              width: 28, height: 28, padding: 0, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: liveLut ? "#3a1818" : "transparent",
              border: `1px solid ${liveLut ? "#d84a4a" : "#444"}`,
              color: liveLut ? "#ff8a8a" : "#888",
              borderRadius: 4, cursor: "pointer", userSelect: "none",
              boxSizing: "border-box",
            }}>
            <span style={{
              width: 12, height: 12, borderRadius: "50%",
              background: liveLut ? "#ff3a3a" : "transparent",
              border: liveLut ? "1px solid #ff8a8a" : "1.5px solid #888",
              boxShadow: liveLut ? "0 0 6px #ff3a3a" : "none",
              display: "inline-block", flexShrink: 0,
            }} />
          </div>
            </div>
            {/* v1.20.70 — Multi/Blend disclosure + ADAPT button removed.
                Multi-zone output (3-band stacking) was retired late
                v1.20.70 to focus on single-layer RGB/Lab/LUT bakes
                with palette + selection masks. Multi-zone bake paths
                stay in applyMatch/applyLut.ts for now (recipe
                compatibility) but are unreachable from the UI. */}
          </div>
          {/* Tabs row: RGB | Lab | LUT. overflow:hidden so tab labels
              clip at narrow widths instead of overflowing the row. */}
          <div style={{ display: "flex", gap: 0, overflow: "hidden", flex: 1, minWidth: 0 }}>
            {TABS.map(t => (
              <div key={t.val} onClick={() => onTabClick(t.val)} title={t.tip}
                style={{
                  flex: "1 1 0", height: 28, padding: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  overflow: "hidden", whiteSpace: "nowrap",
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                  background: t.tabS.bg,
                  color: t.tabS.fg,
                  border: `1px solid ${t.tabS.bd}`,
                  borderLeftWidth: t.isFirst ? 1 : 0,
                  borderRadius: 0,
                  cursor: "pointer", userSelect: "none",
                  lineHeight: "26px", boxSizing: "border-box",
                  minWidth: 0,
                }}>{t.label}</div>
            ))}
          </div>
        </div>
          );
        })()}
      </div>

      {/* v1.20.53 — marquee tristate was relocated up alongside MASK
          (above the output-mode block). This slot is now empty. */}

      {/* v1.20.70 — body action row carries only target-specific actions
          (JUMP / ISOLATE). The plugin-level cluster (💾 REVERT ✕ ⟳ ⚙ ?)
          lives in the header, with PS native ↶ ↷ in the header center. */}
      <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginTop: 6, width: "100%", alignItems: "center" }}>
        {/* JUMP / ISOLATE — equal-width pills (44px each = (92 - 4 gap)
            / 2), so the cluster is exactly col-1-wide and lines up with
            MASK / [+|○|▼] / ADAPT above. */}
        <div onClick={onJumpToTarget}
          title={targetId == null || targetId === MERGED_LAYER_ID
            ? "JUMP — no specific target layer to jump to (pick a layer in the target dropdown first)."
            : "JUMP — select the target layer in PS Layers panel + scroll it into view."}
          style={{
            width: 44, height: 22, padding: 0, flexShrink: 0,
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent",
            color: (targetId != null && targetId !== MERGED_LAYER_ID) ? "#aaa" : "#555",
            border: `1px solid ${(targetId != null && targetId !== MERGED_LAYER_ID) ? "#666" : "#3a3a3a"}`,
            borderRadius: 4,
            cursor: (targetId != null && targetId !== MERGED_LAYER_ID) ? "pointer" : "default",
            userSelect: "none",
            lineHeight: "20px", boxSizing: "border-box",
            opacity: (targetId != null && targetId !== MERGED_LAYER_ID) ? 1 : 0.55,
          }}>JUMP</div>
        <div onClick={onToggleIsolation}
          title={isolated
            ? "ISOLATE ON — non-target / non-[Color Smash] layers hidden. Click to restore prior visibility."
            : "ISOLATE OFF — click to hide every layer except the target's ancestor chain + [Color Smash] group. A/B compare against the full comp."}
          style={{
            width: 44, height: 22, padding: 0, flexShrink: 0,
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: isolated ? "#283440" : "transparent",
            color: isolated ? "#7aa8d8" : "#aaa",
            border: `1px solid ${isolated ? "#7aa8d8" : "#666"}`,
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            lineHeight: "20px", boxSizing: "border-box",
          }}>ISOLATE</div>
      </div>
      </>}{/* end outputOpen */}
      </div>{/* end OUTPUT island */}

      {/* MASK island. v1.20.70 — moved BELOW the output block (was above
          pre-v1.20.70). MASK button toggles BOTH the visualization
          overlay (showMask) and the per-cluster attenuation gate
          (targetMaskEnabled), unifying what was two separate toggles.
          The old per-palette mask pill in PaletteStrip is gone — this
          is now the single source of mask control. */}
      <div style={ISLAND}>
        <div onClick={() => setMaskOpen(o => !o)}
          style={{ ...ISLAND_HEADER, marginBottom: maskOpen ? 4 : 0, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
          title={maskOpen ? "Hide mask controls" : "Show mask controls"}>
          <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{maskOpen ? "▾" : "▸"}</span>
          <span>MASK</span>
        </div>
        {maskOpen && (() => {
        const marqueeDisabled = srcMode === "selection";
        const disabledTip = "Disabled because the source is using the active marquee. Switch source to a layer or browsed image to use the marquee as an output mask.";
        const maskOn = showMask && targetMaskEnabled;
        const showNoSelectionHint =
          !marqueeDisabled &&
          selectionMode !== "off" &&
          !selectionPreviewMask;
        return (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div onClick={() => {
              // v1.20.70 — toggle BOTH the per-cluster attenuation gate
              // and the red preview overlay together. Default ON.
              const next = !maskOn;
              setShowMask(next);
              setTargetMaskEnabled(next);
            }}
              title={maskOn
                ? "MASK ON — per-cluster target attenuation is active (preview AND bake honor the target-palette weights). Protected regions show red on the preview. Click to disable: preview shows pure transform, bake produces an unmasked Curves/LUT layer."
                : "MASK OFF — preview shows pure transform output and bake produces an unmasked Curves/LUT layer. Click to enable: per-cluster mask attenuates the transform + paints protected regions red on the preview."}
              style={{
                width: 56, height: 22, flexShrink: 0, marginRight: 4,
                fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: maskOn ? "#3a2828" : "transparent",
                color: maskOn ? "#e87a7a" : "#5a3a3a",
                border: `1px solid ${maskOn ? "#d87a7a" : "#5a3a3a"}`,
                borderRadius: 4, cursor: "pointer", userSelect: "none",
                lineHeight: "20px", boxSizing: "border-box",
              }}>MASK</div>
            <div style={{ display: "flex", flex: 1, gap: 0, opacity: marqueeDisabled ? 0.55 : 1, overflow: "hidden" }}>
              {([
                ["off",     "Off",     "Ignore the marquee — full-image apply (default). The marquee stays on the doc."],
                ["focus",   "Focus",   "Use the active marquee as the layer mask — the Curves/LUT applies ONLY inside the marquee. Multiplied with the target-palette mask if both are active."],
                ["exclude", "Exclude", "Use the INVERSE of the active marquee as the layer mask — the Curves/LUT applies everywhere OUTSIDE the marquee. Useful for protecting a chosen area."],
              ] as Array<["off" | "focus" | "exclude", string, string]>).map(([val, label, tip], idx) => (
                <div key={val}
                  onClick={() => { if (!marqueeDisabled) setSelectionMode(val); }}
                  title={marqueeDisabled ? disabledTip : tip}
                  style={{
                    flex: "1 1 0", minWidth: 0, height: 22, padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    overflow: "hidden", whiteSpace: "nowrap",
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                    background: !marqueeDisabled && selectionMode === val ? "#3a3a3a" : "transparent",
                    color: !marqueeDisabled && selectionMode === val ? "#dddddd" : "#888",
                    border: `1px solid ${!marqueeDisabled && selectionMode === val ? "#888" : "#444"}`,
                    borderLeftWidth: idx === 0 ? 1 : 0,
                    borderRadius: 0,
                    cursor: marqueeDisabled ? "default" : "pointer",
                    userSelect: "none",
                    lineHeight: "20px", boxSizing: "border-box",
                  }}>{label}</div>
              ))}
            </div>
          </div>
          {showNoSelectionHint && (
            <div style={{
              marginTop: 4, padding: "2px 6px",
              fontSize: 9, color: "#d8b87a",
              background: "transparent", border: "1px solid #5a4a2a", borderRadius: 2,
              lineHeight: 1.3,
            }}>
              Marquee mode is <b>{selectionMode}</b> but no selection was captured. Draw a marquee on the target doc and click ⟳ to refresh.{selectionMaskError ? <><br/><span style={{ opacity: 0.7 }}>{selectionMaskError}</span></> : null}
            </div>
          )}
          {marqueeDisabled && (
            <div style={{
              marginTop: 4, padding: "2px 6px",
              fontSize: 9, color: "#888",
              background: "transparent", border: "1px solid #444", borderRadius: 2,
              lineHeight: 1.3,
            }}>
              Disabled because your <b>source mode is "selection"</b> — the marquee is in use as source pixels. Switch source mode to "layer" to use the marquee here as an output mask.
            </div>
          )}
          </>
        );
      })()}
      </div>{/* end MASK island */}

      {/* HISTORY island. */}
      <div style={ISLAND}>
      {/* Recent history. Empty state shows a single hint line; otherwise the
          stored entries render as small palette-color thumbnails. */}
      {(() => {
        // Sort pinned entries to the FRONT (visually) so favorites are
        // always immediately reachable. Pinned entries have a gold border
        // and a visible star icon; recents have plain border + outline star.
        const sorted = [...recentHistory].sort((a, b) => {
          const ap = a.pinned ? 1 : 0;
          const bp = b.pinned ? 1 : 0;
          return bp - ap;
        });
        // Pad with placeholders up to HISTORY_MAX so the row always shows
        // the same visual capacity. Each placeholder slot is rendered as a
        // dim outlined rectangle below.
        const placeholderCount = Math.max(0, HISTORY_MAX - sorted.length);
        return (
        <div style={{ marginTop: 6 }}>
          {/* v1.20.65 — header row: disclosure on the left, import/export
              tiny icons on the right. Cross-machine recipe portability. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 16, lineHeight: "14px", marginBottom: 4 }}>
            <div onClick={() => setHistoryOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: "#888",
                       cursor: "pointer", userSelect: "none" }}
              title={historyOpen ? "Hide recent applies" : "Show recent applies — click any thumbnail to restore that state"}>
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>
                {historyOpen ? "▾" : "▸"}
              </span>
              <span>HISTORY ({recentHistory.length})</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div onClick={onImportRecipes}
                title="Import recipes from a .json file (cross-machine portable, auto-pinned)"
                style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
                  padding: "2px 6px", color: "#888",
                  border: "1px solid #444", borderRadius: 2,
                  cursor: "pointer", userSelect: "none",
                }}>↓ IMPORT</div>
              <div onClick={onExportRecipes}
                title={recentHistory.some(e => e.pinned)
                  ? "Export PINNED recipes to a .json file (cross-machine portable)"
                  : "Export ALL recipes to a .json file (cross-machine portable). Pin entries to export just a curated set."}
                style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
                  padding: "2px 6px", color: "#888",
                  border: "1px solid #444", borderRadius: 2,
                  cursor: "pointer", userSelect: "none",
                }}>↑ EXPORT</div>
            </div>
          </div>
          {historyOpen && sorted.length === 0 && (
            <div style={{
              marginTop: 4, padding: "6px 8px",
              fontSize: 9, color: "#666", fontStyle: "italic",
              border: "1px dashed #333", borderRadius: 2,
              textAlign: "center",
            }}>
              Apply a match — recent recipes will appear here. Pin or rename to keep.
            </div>
          )}
          {historyOpen && sorted.length > 0 && (
            <div style={{ display: "flex", flexDirection: "row", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {sorted.map(entry => {
                const displayLabel = entry.customName || entry.label;
                return (
                <div key={entry.id}
                  title={`${displayLabel}${entry.customName ? ` (auto: ${entry.label})` : ""}\nSaved ${new Date(entry.timestamp).toLocaleString()}\nClick to restore. ${entry.pinned ? "Double-click to rename. ★ Pinned — won't be evicted." : "Click the star to pin."}`}
                  onDoubleClick={() => {
                    // v1.20.3 — double-click triggers rename mode. Auto-pins
                    // the entry if not already pinned (rename only makes
                    // sense for entries you want to keep around).
                    if (!entry.pinned) {
                      setRecentHistory(prev => togglePinnedEntry(prev, entry.id));
                    }
                    setRenamingEntryId(entry.id);
                  }}
                  style={{
                    width: 60, height: 22, padding: 0,
                    display: "flex", flexDirection: "row", position: "relative",
                    border: `1px solid ${entry.pinned ? "#c19a3a" : "#555"}`,
                    borderRadius: 2,
                    userSelect: "none",
                    overflow: "hidden", flexShrink: 0,
                  }}>
                  {/* Thumbnail body (v1.20.17) — recipes are SOURCE-ONLY.
                      Top: source palette signature (sized by clusterPrevalence
                      × userMultiplier). Bottom: transform-preview gradient
                      (32-stop CSS gradient pre-transformed by the recipe's
                      curves + preset) — visually communicates "what this
                      recipe DOES to a neutral input." Reads as palette →
                      effect, top to bottom. Click anywhere to load. */}
                  <div onClick={() => applyHistoryEntry(entry)}
                    style={{ flex: 1, display: "flex", flexDirection: "column", cursor: "pointer", overflow: "hidden" }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}>
                      {entry.signature.colors.length > 0
                        ? entry.signature.colors.map((c, i) => {
                            const r = (c >> 16) & 0xff;
                            const g = (c >> 8) & 0xff;
                            const b = c & 0xff;
                            const w = entry.signature.weights[i] ?? 0;
                            const total = entry.signature.weights.reduce((s, x) => s + (x || 0), 0) || 1;
                            return (
                              <div key={i} style={{
                                flex: `${Math.max(1, w)} 1 0`,
                                background: `rgb(${r},${g},${b})`,
                                minWidth: 0,
                              }} title={`rgb(${r},${g},${b}) · ${((w / total) * 100).toFixed(0)}%`} />
                            );
                          })
                        : <div style={{ flex: 1, background: "#444" }} />
                      }
                    </div>
                    <div style={{ flex: 1, background: lutGradientCSS(entry.state), minHeight: 0 }} />
                  </div>
                  {/* Pin star — top-right corner overlay. Solid when pinned,
                      outline when not. Click toggles pinned state without
                      triggering the restore handler. */}
                  <div onClick={e => {
                    e.stopPropagation();
                    setRecentHistory(prev => togglePinnedEntry(prev, entry.id));
                  }}
                    title={entry.pinned ? "Pinned — click to unpin" : "Click to pin (preserves this entry from being evicted)"}
                    style={{
                      position: "absolute", top: -1, right: -1,
                      width: 12, height: 12, display: "flex",
                      alignItems: "center", justifyContent: "center",
                      fontSize: 9, lineHeight: 1,
                      background: entry.pinned ? "#c19a3a" : "rgba(20,20,20,0.7)",
                      color: entry.pinned ? "#fff" : "#aaa",
                      border: `1px solid ${entry.pinned ? "#c19a3a" : "#555"}`,
                      borderRadius: 2,
                      cursor: "pointer", userSelect: "none",
                    }}>{entry.pinned ? "★" : "☆"}</div>
                  {/* Custom-name badge — small text "tick" hanging off the
                      bottom-left when the user has renamed the entry. Tooltip
                      shows the name; double-click the thumbnail to edit. */}
                  {entry.customName && (
                    <div style={{
                      position: "absolute", bottom: -1, left: -1,
                      maxWidth: 56, padding: "0 2px",
                      fontSize: 7, fontWeight: 600, lineHeight: 1,
                      background: "rgba(20,20,20,0.85)",
                      color: "#c19a3a",
                      border: "1px solid #c19a3a",
                      borderRadius: 1,
                      overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                      pointerEvents: "none",
                    }}>{entry.customName}</div>
                  )}
                </div>
                );
              })}
              {/* Placeholder slots (v1.20.2) — fill out the row to
                  HISTORY_MAX so the user discovers the feature even
                  before their first Apply. Each placeholder is a thin
                  dashed-outline rectangle with a faint "—" centered.
                  Non-interactive (no click handler). */}
              {/* v1.20.63 — placeholder slots removed. The empty-state hint
                  banner above handles discoverability; placeholders just
                  ate vertical space once the user had a few entries. */}
              {false && Array.from({ length: placeholderCount }).map((_, i) => (
                <div key={`ph-${i}`} />
              ))}
              {/* Clear-history — only nukes the non-pinned recents; pinned
                  stay. Tooltip explains the distinction. Hidden when there
                  are no non-pinned entries to clear (avoid dead affordance). */}
              {recentHistory.some(e => !e.pinned) && (
                <div onClick={() => setRecentHistory(prev => prev.filter(e => e.pinned))}
                  title="Clear recent history. Pinned entries are preserved."
                  style={{
                    width: 16, height: 16, display: "flex",
                    alignItems: "center", justifyContent: "center",
                    fontSize: 10, color: "#888", border: "1px solid #444",
                    borderRadius: 2, cursor: "pointer", userSelect: "none",
                    flexShrink: 0,
                  }}>×</div>
              )}
            </div>
          )}
          {/* Rename input (v1.20.3) — appears below the thumbnail strip when
              the user double-clicks an entry. Auto-focuses, saves on Enter
              or blur, cancels on Escape. Leaving the name empty clears any
              prior custom name (entry falls back to the auto-generated
              label). */}
          {historyOpen && renamingEntryId && (() => {
            const targetEntry = recentHistory.find(e => e.id === renamingEntryId);
            if (!targetEntry) return null;
            const initialValue = targetEntry.customName ?? "";
            return (
              <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 4, height: 18, lineHeight: "16px" }}>
                <span style={{ fontSize: 9, opacity: 0.6, flexShrink: 0 }}>rename</span>
                <input type="text"
                  defaultValue={initialValue}
                  autoFocus
                  placeholder={targetEntry.label}
                  onBlur={e => {
                    setRecentHistory(prev => renameHistoryEntry(prev, targetEntry.id, e.target.value));
                    setRenamingEntryId(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      setRecentHistory(prev => renameHistoryEntry(prev, targetEntry.id, (e.target as HTMLInputElement).value));
                      setRenamingEntryId(null);
                    } else if (e.key === "Escape") {
                      setRenamingEntryId(null);
                    }
                  }}
                  style={{
                    flex: 1, height: 16, fontSize: 9, padding: "0 4px",
                    background: "#1a1a1a", color: "#ddd",
                    border: "1px solid #c19a3a", borderRadius: 2,
                    boxSizing: "border-box", lineHeight: "14px",
                  }} />
                <div onClick={() => setRenamingEntryId(null)}
                  title="Cancel rename"
                  style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center",
                           fontSize: 9, color: "#888", border: "1px solid #444", borderRadius: 2,
                           cursor: "pointer", userSelect: "none", flexShrink: 0 }}>×</div>
              </div>
            );
          })()}
        </div>
        );
      })()}
      </div>{/* end HISTORY island */}

      {/* FITTED CURVES island. v1.20.70. */}
      <div style={ISLAND}>
        <div onClick={() => setCurvesGraphOpen(o => !o)}
          style={{ display: "flex", alignItems: "center", gap: 4, ...ISLAND_HEADER, marginBottom: curvesGraphOpen ? 4 : 0, cursor: "pointer" }}
          title={curvesGraphOpen ? "Hide fitted-curves graph" : "Show fitted-curves graph (R G B channel transfer curves)"}>
          <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>{curvesGraphOpen ? "▾" : "▸"}</span>
          <span>FITTED CURVES (R G B)</span>
        </div>
        {curvesGraphOpen && <CurvesGraph curves={renderedCurves} />}
        <div style={{ marginTop: 2, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
      </div>{/* end FITTED CURVES island */}

      {/* Diagnostic-only doc-rename probe. Read-only; never mutates srcDocId / srcMode /
          targetId / etc. Logs every name-shaped value across every API surface so we can
          see whether ANY source updates after Save As before the panel is reopened. */}

      </>)}{/* end Match-mode lower controls conditional fragment */}

      {/* Smash-mode lower controls. Slim section that receives the same src
          /tgt snaps MatchTab already manages and exposes the engine output up
          via onEngineChange so the matched-preview effect below can drive the
          shared <MatchedPreview/> through the same handle the Match path uses. */}
      {__SMASH_ENABLED__ && smashMode === "smash" && (
        <SmashSection
          sourceSnap={srcSnap}
          targetSnap={tgt.snap}
          targetDocId={tgtDocId}
          targetLayerId={targetId}
          onEngineChange={setSmashEngine}
          onTestBake={(pixels, w, h) => {
            // Diagnostic: push the per-pixel ground-truth bake into the
            // matched preview tile via showAfter — the atomic variant that
            // bypasses displayBefore gating and synchronously updates the
            // visible <img> tags. setPixels alone would silently cache the
            // bytes without displaying them when the user is currently
            // viewing Before mode (the gate is on `!displayBefore` and a
            // setShowBefore call wouldn't propagate in time). The LUT-
            // driven smash preview useEffect overwrites this on the next
            // engine change (slider/toggle), so the test-bake state is
            // naturally transient.
            if (matchedHandleRef.current) {
              matchedHandleRef.current.showAfter(pixels, w, h);
              if (tgt.snap) {
                matchedHandleRef.current.setBefore(tgt.snap.data, tgt.snap.width, tgt.snap.height);
              }
            }
          }}
        />
      )}
    </div>
  );
}
