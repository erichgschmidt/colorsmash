// Color Match: fits per-channel R/G/B Curves so target's histograms match source's.
// Source = a layer in the active doc, OR a snapshot of the active marquee selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { CurvesGraph } from "./CurvesGraph";
import { ZoneCompoundSlider } from "./ZoneCompoundSlider";
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
  computeLumaBins, bandMeanColor, lumaRange,
  EnvelopePoint, DEFAULT_ENVELOPE,
  fitByMode, MatchMode, Preset,
  fitMultiZoneByMode, applyMultiZoneToRgba, processMultiZoneFit, MultiZoneFit, adaptiveBandPeaks,
  lerpCurvesTowardIdentity,
} from "../core/histogramMatch";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { loadSettings, makeDebouncedSaver, clearSettings, PersistedSettings } from "./persistence";
import { uxpInfo } from "./uxpInfo";
import { applyMatch } from "../app/applyMatch";
import { applyLutAsAdjustmentLayer, applyMultiZoneLutAsLayers } from "../app/applyLut";
import { updateMatchCurvesLayerInPlace } from "../app/liveCurvesUpdate";
import { LutLayerState, readLutLayerState, stampState } from "../app/lutXmp";
import {
  HistoryEntry, makeHistoryEntry, pushHistoryEntry, pruneHistory, togglePinnedEntry, renameHistoryEntry,
} from "../app/recentHistory";
import { lutGradientCSS } from "../app/historyThumbnail";
import { syncOutputVisibilityToMode, repositionGroupAboveTarget } from "../app/outputVisibility";
import {
  app, action as psAction, readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds, readSelectionMaskBytes,
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
  // Multi-zone output (beta): emit 3 stacked Curves layers (shadow/mid/highlight) limiting
  // each to its luminance band via mask, Blend If, or both. Default off so v1.0 behavior unchanged.
  const [multiZone, setMultiZone] = useState(false);
  const [multiZoneLimit, setMultiZoneLimit] = useState<"mask" | "blendIf" | "both">("mask");
  // Adaptive bands: when on, band peaks shift to target's P10/P50/P90 luma percentiles
  // so each band gets a meaningful pixel sample. When off, fixed peaks at 0/128/255.
  const [adaptiveBands, setAdaptiveBands] = useState(true);
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
  const [lockZoneTotal, setLockZoneTotal] = useState(false);

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
  const [lutAdvancedOpen, setLutAdvancedOpen] = useState(false);

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
  const HISTORY_MAX = 5;
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>([]);
  // Default open in v1.20.1 — feedback was that the collapsed disclosure
  // was easy to miss, and the strip is small enough to live exposed.
  const [historyOpen, setHistoryOpen] = useState(true);
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
  const liveLutLayerIdRef = useRef<number | null>(null);
  // (liveUpdates and stale state declared above, before the hooks that consume them.)

  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | "envelope" | null>(null);
  // Per-section enable toggles: when off, that section's params revert to defaults at apply
  // time, letting the user A/B-test the contribution of each section without losing settings.
  const [enColor, setEnColor] = useState(true);
  const [enTone, setEnTone] = useState(true);
  const [enZones, setEnZones] = useState(true);
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
        // Normalize legacy "both" persisted state to "blendIf" — Mask is now implicit
        // (used whenever Blend If is off), so "both" no longer makes sense in the UI.
        if (s.multiZoneLimit === "both" || s.multiZoneLimit === "blendIf") setMultiZoneLimit("blendIf");
        else if (s.multiZoneLimit === "mask") setMultiZoneLimit("mask");
        if (s.multiZone != null) setMultiZone(s.multiZone);
        if (s.multiZoneLimit) setMultiZoneLimit(s.multiZoneLimit);
        if (s.adaptiveBands != null) setAdaptiveBands(s.adaptiveBands);
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
        // deselectOnApply removed in v1.20.25 — ignore any old persisted value.
        if (s.overwriteOnApply != null) setOverwriteOnApply(s.overwriteOnApply);
        if (s.openSection !== undefined) setOpenSection(s.openSection);
        if (s.zones) { zonesRef.current = { ...DEFAULT_ZONES, ...s.zones }; setZonesLabel({ ...DEFAULT_ZONES, ...s.zones }); }
        if (s.lockZoneTotal != null) setLockZoneTotal(s.lockZoneTotal);
        if (s.dimensions) { dimsRef.current = { ...DEFAULT_DIMENSIONS, ...s.dimensions }; setDimsLabel({ ...DEFAULT_DIMENSIONS, ...s.dimensions }); }
        if (s.envelope && Array.isArray(s.envelope) && s.envelope.length > 0) {
          envelopeRef.current = s.envelope as EnvelopePoint[];
          setEnvelopeLabel(s.envelope as EnvelopePoint[]);
        }
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
      anchorStretchToHist, chromaOnly, colorSpace, outputMode, lutStrength, lutGrid, lutDither, selectionMode, matchMode, multiZone, multiZoneLimit, adaptiveBands,
      overwriteOnApply,
      openSection,
      zones: zonesLabel, lockZoneTotal,
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
  }, [remember, matchMode, multiZone, multiZoneLimit, adaptiveBands, amountLabel, smoothLabel, stretchLabel, anchorStretchToHist, chromaOnly,
      colorSpace, outputMode, lutStrength, lutGrid, lutDither, selectionMode, overwriteOnApply, openSection,
      zonesLabel, lockZoneTotal, dimsLabel, envelopeLabel, paletteCount, paletteAdaptive, sourceSoftness, targetSoftness, targetMaskEnabled, recentHistory]);

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

  const multiZonePeaks = useMemo(() => {
    if (!adaptiveBands || !lumaBins) return { shadow: 0, mid: 128, highlight: 255 };
    return adaptiveBandPeaks(lumaBins);
  }, [adaptiveBands, lumaBins]);

  // Outer extents for multi-zone bands. When adaptive, derived from the target's actual
  // luma range (lumaRange) — pixels outside this range get zero band application and pass
  // through unchanged. Slider positions in PS Blend If panel match these extents so the
  // visualization is honest about where the bands actually have effect.
  const multiZoneExtents = useMemo(() => {
    if (!adaptiveBands || !lumaBins) return { min: 0, max: 255 };
    const r = lumaRange(lumaBins);
    return { min: r.start, max: r.end };
  }, [adaptiveBands, lumaBins]);

  // Multi-zone fit: 3 separate per-band curves. Computed only when the multi-zone toggle
  // is on (otherwise null).
  const fittedMulti = useMemo<MultiZoneFit | null>(() => {
    if (!multiZone || !weightedSrcData || !tgt.snap) return null;
    return fitMultiZoneByMode(matchMode, weightedSrcData, tgt.snap.data, multiZonePeaks, multiZoneExtents);
  }, [multiZone, weightedSrcData, tgt.snap, multiZonePeaks, multiZoneExtents, matchMode]);

  // Matched preview is rendered by <MatchedPreview/>; we drive it imperatively via a handle.
  const matchedHandleRef = useRef<MatchedPreviewHandle | null>(null);
  const rafPendingRef = useRef(false);
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

    if (multiZone && fittedMulti) {
      // Multi-zone path: process each band's curves through Color + Tone, simulate
      // the 3-curve composite via compositional layer-stack blend (matches what PS
      // produces from three stacked masked Curves layers). Zones + Envelope are
      // skipped — they're zone-modulators that would double-apply over the bands.
      const procFit = processMultiZoneFit(fittedMulti, curveOpts, dimOpts);
      out = applyMultiZoneToRgba(tgtBuf.data, procFit, multiZonePeaks, multiZoneExtents);
      // Target-palette mask: when active, the bake wraps the 3 band Curves layers
      // in a sub-group and attaches the target-palette mask to the SUB-GROUP. PS
      // evaluates that as (multi-zone composite) × (group mask). Mirror the same
      // composition here per-pixel: lerp the multi-zone output toward original by
      // each pixel's effective weight.
      if (targetWeightsActive && targetEffectiveWeights) {
        const orig = tgtBuf.data;
        const ew = targetEffectiveWeights;
        for (let i = 0, p = 0; i < out.length; i += 4, p++) {
          const w = Math.max(0, Math.min(1, ew[p]));
          if (w >= 0.999) continue; // full match: keep as-is
          if (w <= 0.001) {
            out[i] = orig[i]; out[i + 1] = orig[i + 1]; out[i + 2] = orig[i + 2];
            continue;
          }
          out[i]     = Math.round(orig[i]     + (out[i]     - orig[i])     * w);
          out[i + 1] = Math.round(orig[i + 1] + (out[i + 1] - orig[i + 1]) * w);
          out[i + 2] = Math.round(orig[i + 2] + (out[i + 2] - orig[i + 2]) * w);
        }
      }
      // Curves graph shows the mid-band curve as representative (graph doesn't render 3 sets).
      curvesForGraph = procFit.mid;
    } else {
      // Single-curve path (default).
      const processed = processChannelCurves(fittedRaw, curveOpts);
      const dim = applyDimensions(processed, dimOpts);
      curvesForGraph = applyZoneAndEnvelopeToChannels(
        dim,
        enZones ? zonesRef.current : DEFAULT_ZONES,
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
  }, [fittedRaw, fittedMulti, multiZone, multiZonePeaks, multiZoneExtents, tgt.snap, chromaOnly, anchorStretchToHist, enColor, enTone, enZones, enEnvelope, activePreset, targetEffectiveWeights, targetMaskEnabled, showMask, outputMode, lutStrength, lutGrid, selectionPreviewMask, effectiveSelectionMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
    multiZone,
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
    if (state.multiZone != null) setMultiZone(!!state.multiZone);
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

    const targetPalette = targetPaletteSwatches.length > 0 ? {
      swatches: targetPaletteSwatches,
      weights: targetPaletteWeights.slice(),
      softness: targetSoftness,
    } : undefined;

    // Multi-zone LUT branch (v1.16.0). When Multi is on AND we have a fitted
    // multi-zone result, emit 3 stacked Color Lookup layers in a sub-group
    // (matches the Curves multi-zone structure). Each layer carries one
    // band's LUT + a luma triangular mask. Falls back to single-LUT if
    // multi-zone fit hasn't computed yet (e.g. no target snap).
    if (multiZone && fittedMulti) {
      setStatus("Applying multi-zone LUT...");
      try {
        // processMultiZoneFit normalizes the raw fit through curveOpts / dimOpts —
        // same processing single-LUT applies via renderedCurves. Without this
        // step the bands would carry pre-postprocess curves and the preset
        // blend math would double-apply.
        // curveOpts shape mirrors the preview pipeline (~line 746). enColor
        // gate is applied implicitly here — caller already decided to Apply,
        // so the Color section is honored at its current slider values.
        const stretchRange = anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined;
        const procFit = processMultiZoneFit(fittedMulti, {
          amount: amountRef.current / 100,
          smoothRadius: smoothRef.current,
          maxStretch: stretchRef.current,
          stretchRange,
        }, dimsRef.current);
        const result = await applyMultiZoneLutAsLayers({
          multiZoneFit: procFit,
          preset: activePreset,
          gridSize: lutGrid,
          strength: lutStrength / 100,
          dither: lutDither,
          selectionMode: effectiveSelectionMode,
          targetLayerId: targetId === MERGED_LAYER_ID ? null : targetId,
          targetIsMerged: targetId === MERGED_LAYER_ID,
          overwritePrior: overwriteOnApply,
          targetPalette,
          multiZonePeaks,
          multiZoneExtents,
          xmpState: buildXmpState(),
        });
        // Live LUT is disabled for multi-zone (would require updating 3
        // layers per commit + recomputing 3 ICC profiles — defer to a
        // future increment). Track the sub-group id for the visibility-sync
        // path so SWAP/AUTO can toggle the whole multi-zone trio at once.
        liveLutLayerIdRef.current = result.layerId;
        lastSelfWriteRef.current = Date.now();
        setStatus(`Applied "${result.layerName}" (3× 33³ multi-zone LUT).`);
        pushCurrentToHistory();
        return;
      } catch (e: any) {
        setStatus(`Apply multi-zone LUT failed: ${e?.message ?? e}`);
        return;
      }
    }

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
        overwritePrior: overwriteOnApply,
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
    // mechanism targets a single layer ID. Updating 3 layers per commit + re-
    // baking 3 ICC profiles is a future-increment; for now skip live updates
    // entirely when Multi is on. Apply still works (multi-zone bake).
    if (multiZone) {
      if (liveBakeTimerRef.current) { clearTimeout(liveBakeTimerRef.current); liveBakeTimerRef.current = null; }
      return;
    }
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
          const result = await updateMatchCurvesLayerInPlace(renderedCurves, activePreset);
          if (result.ok) lastSelfWriteRef.current = Date.now();
        }
      } catch (e: any) {
        setStatus(`Live update skipped: ${e?.message ?? e}`);
      }
    }, 300);
    return () => {
      if (liveBakeTimerRef.current) { clearTimeout(liveBakeTimerRef.current); liveBakeTimerRef.current = null; }
    };
  }, [liveLut, renderedCurves, activePreset, targetId, targetPaletteWeights, targetSoftness, multiZone, outputMode]);

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (srcMode === "layer" && sourceId == null) { setStatus("Pick source layer."); return; }
    if (srcMode === "selection" && !srcOverride) { setStatus("Snap a selection first."); return; }
    setStatus("Applying match...");
    try {
      if (srcDocId == null || tgtDocId == null) { setStatus("Pick source + target docs."); return; }
      setStatus(await applyMatch({
        srcDocId, tgtDocId,
        sourceLayerId: sourceId ?? -1,
        targetLayerId: targetId,
        matchMode,
        multiZone,
        multiZoneLimit,
        multiZonePeaks,
        multiZoneExtents,
        // Section-enable mirror — disabled sections apply with default params.
        amount: enColor ? amountRef.current / 100 : 1,
        smoothRadius: enColor ? smoothRef.current : 0,
        maxStretch: enColor ? stretchRef.current : 999,
        stretchRange: enColor && anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined,
        chromaOnly: enColor && chromaOnly,
        dimensions: enTone ? dimsRef.current : DEFAULT_DIMENSIONS,
        zones: enZones ? zonesRef.current : DEFAULT_ZONES,
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
        overwritePrior: overwriteOnApply,
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

  const sel = matchStyles.sel;
  const tinyBtn = matchStyles.tinyBtn;

  // Full reset: every persisted setting back to its default + delete the saved file.
  // Triggered by the red ✕ in the bottom bar.
  const onResetAll = () => {
    amountRef.current = 100; setAmountLabel(100);
    smoothRef.current = 0;   setSmoothLabel(0);
    stretchRef.current = 8;  setStretchLabel(8);
    setAnchorStretchToHist(false);
    setChromaOnly(false);
    setMatchMode("full");
    setMultiZone(false);
    setMultiZoneLimit("mask");
    setAdaptiveBands(true);
    setOutputMode("rgb");
    setOverwriteOnApply(true);
    setOpenSection(null);
    zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES });
    setLockZoneTotal(false);
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
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
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
            }
          />
        </div>

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

      {/* Matched preview (full-width, large) with zoom controls + Before/After badge */}
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

      {/* Target palette weight bar — mirrors the source palette but the
          weights modulate CURVE APPLICATION strength per cluster (not source
          contribution). Drag a target swatch to 0 → curves don't apply to that
          cluster's pixels (e.g., "leave skies alone, push the rest"). Reuses
          the same component, no preset transform (target swatches always show
          actual target colors). Sits directly below the matched preview, where
          it visually relates to "what's being modified" rather than to source. */}
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
          maskEnabled={targetMaskEnabled}
          setMaskEnabled={setTargetMaskEnabled}
        />
      </div>


      {/* Accordion controls */}
      <div style={{ borderTop: "1px solid #444", margin: "6px 0 0" }} />
      <div onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enColor ? "#dddddd" : "#888", fontStyle: enColor ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnColor(!enColor); }}
            title={enColor ? "Color section ENABLED — click to disable (revert all Color params to defaults)" : "Color section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enColor ? "#5fd16a" : "#555",
                     border: enColor ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
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
          { heading: "Source palette weights bar (above, under the source previews)",
            body: "K-means swatches sampled from the source in CIE Lab space (3 / 5 / 7 toggle, sorted dark→left to light→right). Mirrors the active preset's color emphasis: Full / Hue / Saturation = raw clusters, Color = pure-hue swatches with luminance flattened, Contrast = grayscale value strip. Segment widths are proportional: each cluster's natural prevalence × your multiplier. Drag the white dividers to redistribute weight pair-wise between two adjacent neighbors, or flip 'adapt' on to drag a swatch BODY — that swatch grows/shrinks and all others rebalance proportionally. Reset restores neutral (×1) weights. Source weights bias the histogram fit — which source colors influence the computed curves. Drives both live preview and Apply Curves bake." },
          { heading: "Target palette weights bar (under the matched preview)",
            body: "Same UI as the source bar (3/5/7 count, handle/adapt drag, dark→light sort, Reset) but different math. Target weights control curve application strength per cluster — drag a swatch toward 0 to leave that color region of the target untouched while the rest gets matched. The mask toggle on the header (default ON) bakes the per-cluster attenuation into a layer mask on the output Curves layer; OFF skips the mask on both preview and bake (uniform curves — useful for A/B comparing). Replaces the old Zones accordion." },
          { heading: "Softness slider (under each palette bar)",
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
          {/* @ts-ignore Spectrum web component */}
          <sp-checkbox checked={chromaOnly || undefined} onInput={(e: any) => setChromaOnly(e.target.checked)} style={{ marginTop: 4, fontSize: 11 }}
            title="Apply only the hue shift; preserve target's saturation and luminance. Uses PS Hue blend mode — sidesteps the saturation inflation that per-channel curves cause.">
            Hue only (preserve target saturation + luminance)
          {/* @ts-ignore */}
          </sp-checkbox>
        </div>
      )}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enTone ? "#dddddd" : "#888", fontStyle: enTone ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnTone(!enTone); }}
            title={enTone ? "Tone section ENABLED — click to disable" : "Tone section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enTone ? "#5fd16a" : "#555",
                     border: enTone ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
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
          palette weight bar above the accordion. The bar is a strictly more
          general tool (color clusters in Lab space vs. the old 3 fixed luma
          bands) and feels parallel to the source palette. The ZoneOpts
          math, persistence, and applyZoneAndEnvelopeToChannels still ship
          unchanged for backward-compatibility on saved settings, but the
          zonesLabel state stays at its default values now since users can't
          edit it. The Color section's enZones flag is unused but kept to
          avoid a persistence schema break. */}
      {false && <div onClick={() => toggleSection("zones")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enZones ? "#dddddd" : "#888", fontStyle: enZones ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnZones(!enZones); }}
            title={enZones ? "Zones section ENABLED — click to disable" : "Zones section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enZones ? "#5fd16a" : "#555",
                     border: enZones ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
          <Icon name={openSection === "zones" ? "chevronDown" : "chevronRight"} size={11} /> Zones
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "zones" && (
            <>
              <label onClick={(e: any) => e.stopPropagation()} title="Lock total: when one amount changes, the other two rebalance proportionally to preserve the sum"
                style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 400, opacity: 0.85, cursor: "pointer" }}>
                <input type="checkbox" checked={lockZoneTotal} onChange={e => setLockZoneTotal(e.target.checked)}
                  style={{ cursor: "pointer", margin: 0 }} />
                Lock total
              </label>
              <span onClick={(e: any) => { e.stopPropagation(); zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>
            </>
          )}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Zones — what each control does", [
            { heading: "What zones do",
              body: "Modulate how strongly the histogram match applies across input tones. Each zone (shadows / midtones / highlights) is a Gaussian bump centered on its anchor. With all amounts at 100% and biases at 0, the match runs full-strength and zones have no effect." },
            { heading: "Track (the gradient slider)",
              body: "Visualizes the zone's footprint over the 0–255 input range. The colored band is where the zone is active. Center thumb = anchor; edge thumbs = falloff." },
            { heading: "Anchor",
              body: "Where the zone is centered along the input axis (0 = pure black, 255 = pure white). Drag the center thumb." },
            { heading: "Falloff",
              body: "How wide the zone extends from its anchor. Drag either edge thumb in/out for a narrower/broader zone. Symmetric around the anchor." },
            { heading: "Amount",
              body: "Strength of the zone's contribution, 0–200%. 100% = standard. 0% = fully suppress the match in that range. 200% = doubles local pull. The wide slider to the right of the track." },
            { heading: "Bias",
              body: "Competitive pressure against neighboring zones at overlap regions. Positive bias makes this zone dominate the partition where it overlaps another — like 'grow this range' in Color Range. 0 = neutral, default 0 is identical to no bias." },
            { heading: "Lock total (header)",
              body: "When on, dragging one zone's amount slider proportionally rebalances the other two to preserve their sum. Shifts weight between shadows/mids/highlights without changing total match strength." },
            { heading: "Sampled swatch colors",
              body: "The colored band on each track is sampled from the target image's actual pixels in that zone's input range. Updates in real time as you move anchors and falloff." },
            { heading: "Reset (header)",
              body: "Restores all zone settings (amounts, anchors, falloffs, biases) to defaults. Lock total stays as-is." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
      </div>}
      {false && openSection === "zones" && (["shadows", "mids", "highlights"] as const).map(zone => {
        const fallback: Record<string, string> = { shadows: "#4a7fc1", mids: "#bbb", highlights: "#e0b85a" };
        const ankKey = `${zone}Anchor` as keyof ZoneOpts;
        const falKey = `${zone}Falloff` as keyof ZoneOpts;
        const biasKey = `${zone}Bias` as keyof ZoneOpts;
        // Derive band color from target pixels at this zone's luma range. Falls back to
        // fixed palette if no target snapshot yet or if the zone has no pixels in range.
        let bandColor = fallback[zone];
        if (lumaBins) {
          const c = bandMeanColor(lumaBins, zonesLabel[ankKey], zonesLabel[falKey]);
          if (c) bandColor = `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
        }
        return (
          <div key={zone} style={{ padding: 0 }}>
            <ZoneCompoundSlider
              label={zone}
              color={bandColor}
              value={{ amount: zonesLabel[zone], anchor: zonesLabel[ankKey], falloff: zonesLabel[falKey], bias: zonesLabel[biasKey] }}
              defaults={{ amount: DEFAULT_ZONES[zone], anchor: DEFAULT_ZONES[ankKey], falloff: DEFAULT_ZONES[falKey], bias: DEFAULT_ZONES[biasKey] }}
              onChange={next => {
                const cur = zonesRef.current;
                const amountChanged = next.amount !== cur[zone];
                let patch: Partial<ZoneOpts> = { [zone]: next.amount, [ankKey]: next.anchor, [falKey]: next.falloff, [biasKey]: next.bias } as Partial<ZoneOpts>;
                // Lock-total: if this drag changed the amount, redistribute the delta across the other two zones
                // proportionally to their current values (so their ratio is preserved).
                if (lockZoneTotal && amountChanged) {
                  const others = (["shadows", "mids", "highlights"] as const).filter(z => z !== zone);
                  const [a, b] = others;
                  const prevTotal = cur.shadows + cur.mids + cur.highlights;
                  const remaining = Math.max(0, prevTotal - next.amount);
                  const otherSum = cur[a] + cur[b];
                  let na: number, nb: number;
                  if (otherSum <= 0) { na = remaining / 2; nb = remaining / 2; }
                  else { na = (cur[a] / otherSum) * remaining; nb = remaining - na; }
                  patch[a] = Math.max(0, Math.min(200, Math.round(na)));
                  patch[b] = Math.max(0, Math.min(200, Math.round(nb)));
                }
                zonesRef.current = { ...cur, ...patch } as ZoneOpts;
                setZonesLabel(z => ({ ...z, ...patch }));
                scheduleRedraw();
              }}
            />
          </div>
        );
      })}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("envelope")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enEnvelope ? "#dddddd" : "#888", fontStyle: enEnvelope ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnEnvelope(!enEnvelope); }}
            title={enEnvelope ? "Envelope section ENABLED — click to disable" : "Envelope section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enEnvelope ? "#5fd16a" : "#555",
                     border: enEnvelope ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
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

      {/* v1.20.43 — BottomActionBar dissolved; SAVE/✕/⟳ pills relocated
          into the Apply row below for a single consolidated action cluster. */}

      {/* Apply (writes Curves layer to PS) and Export LUT (writes .CUBE to disk).
          50/50 split. flexWrap:nowrap + overflow:hidden + minWidth:0 on each cell
          guarantees the row stays single-line at any panel width — labels clip
          silently inside their own button instead of wrapping the buttons to two
          rows. Sp-button's internal text gets nowrap + overflow:hidden too. */}
      {/* Output mode 3-way control. v1.15.0 placed this under the target
          softness slider; v1.16.5 moved it above the Apply button row,
          directly below the Multi / Blend If / Adaptive toggles — sits with
          the other "what happens when I Apply" decisions instead of
          floating between palette UI and the apply cluster. Mode change is
          instant: preview re-renders to match the bake, Apply dispatches
          to the right path (Curves vs Color Lookup), visibility sync
          toggles existing outputs.

          - RGB: separable per-channel curves → Curves layer (continuous, editable)
          - Lab: perceptual L*a*b* match, projected back to RGB curves → Curves layer
          - LUT: 33³ 3D transform with preset blend math baked in → Color Lookup layer */}
      {/* v1.20.45 — SWAP pill removed; clicking RGB/Lab/LUT already fires
          visibility-sync via the outputMode effect (selecting a mode hides
          the other layer types in [Color Smash] and shows the matching
          one). No redundant button needed. The output+multi block now
          spans the full row width. */}
      <div style={{ marginTop: 6, display: "flex", alignItems: "stretch", gap: 4 }}>
        <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 0 }}>
          {/* Top row: output mode (RGB/Lab/LUT). No gap between pills. */}
          <div style={{ display: "flex", flex: 1, gap: 0 }}>
            {([
              ["rgb", "RGB", "Output mode: RGB — separable per-channel curves fit in RGB space. Creates a Curves adjustment layer; continuously editable in PS."],
              ["lab", "Lab", "Output mode: Lab — perceptual L*a*b* histogram match (curves projected to per-channel RGB). Creates a Curves adjustment layer."],
              ["lut", "LUT", "Output mode: LUT — 33³ 3D Color Lookup with preset blend math (Color/Hue/Saturation/Luminosity) baked in. Creates a Color Lookup adjustment layer that captures non-separable transforms a Curves layer can't represent. Preview shows the quantized LUT result so what you see matches what bakes."],
            ] as Array<["rgb" | "lab" | "lut", string, string]>).map(([val, label, tip], idx) => (
              <div key={val} onClick={() => setOutputMode(val)} title={tip}
                style={{
                  flex: 1, height: 18, padding: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
                  background: outputMode === val ? "#3a3a3a" : "transparent",
                  color: outputMode === val ? "#dddddd" : "#888",
                  border: `1px solid ${outputMode === val ? "#888" : "#444"}`,
                  // No-gap segmented block: collapse adjacent borders so the
                  // strip reads as a single control.
                  borderLeftWidth: idx === 0 ? 1 : 0,
                  borderRadius: 0,
                  cursor: "pointer", userSelect: "none",
                  lineHeight: "16px", boxSizing: "border-box",
                }}>{label}</div>
            ))}
          </div>
          {/* Bottom row: multi-zone toggles. Same no-gap segmented styling
              as the row above. Sub-toggles dim when MULTI is off. */}
          {(() => {
            const subDisabled = !multiZone;
            const segPill = (active: boolean, disabled: boolean, isFirst: boolean): React.CSSProperties => ({
              flex: 1, height: 18, padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
              background: active ? "#3a3a3a" : "transparent",
              color: disabled ? "#777" : (active ? "#dddddd" : "#888"),
              border: `1px solid ${disabled ? "#3a3a3a" : (active ? "#888" : "#444")}`,
              borderLeftWidth: isFirst ? 1 : 0,
              borderTopWidth: 0, // merge with the row above for a continuous block
              borderRadius: 0,
              cursor: disabled ? "default" : "pointer", userSelect: "none",
              lineHeight: "16px", boxSizing: "border-box",
              opacity: disabled ? 0.75 : 1,
            });
            return (
              <div style={{ display: "flex", flex: 1, gap: 0 }}>
                <div onClick={() => setMultiZone(!multiZone)}
                  style={segPill(multiZone, false, true)}
                  title="Multi: emit 3 stacked Curves layers (shadows / mids / highlights), each limited to its luminance band. Adapts spatially across mixed-lighting scenes.">
                  MULTI
                </div>
                <div onClick={() => { if (!subDisabled) setMultiZoneLimit(multiZoneLimit === "blendIf" ? "mask" : "blendIf"); }}
                  style={segPill(multiZoneLimit === "blendIf" && !subDisabled, subDisabled, false)}
                  title="Blend If: limit each band layer with the underlying-luma sliders (Layer Style → Blending Options) instead of a luminosity mask. When OFF, a paintable mask is exported instead. May not work in all PS versions.">
                  BLEND IF
                </div>
                <div onClick={() => { if (!subDisabled) setAdaptiveBands(!adaptiveBands); }}
                  style={segPill(adaptiveBands && !subDisabled, subDisabled, false)}
                  title={`Adaptive: shift band peaks + extents to the target histogram's percentiles (P10/P50/P90) instead of fixed 0/128/255. ${multiZone && lumaBins ? `Current peaks: ${multiZonePeaks.shadow}/${multiZonePeaks.mid}/${multiZonePeaks.highlight}` : ""}`}>
                  ADAPTIVE
                </div>
              </div>
            );
          })()}
        </div>
        {/* Help (?) icon — kept outside the segmented block. */}
        <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
          <span onClick={(e: any) => { e.stopPropagation(); e.preventDefault(); void uxpInfo("Multi-zone Curves — what each toggle does", [
            { heading: "Multi",
              body: "Apply emits three stacked Curves layers (Shadows, Mids, Highlights) instead of one. Each curve is fitted from ONLY the pixels whose luma falls in its band. The three layers land in the [Color Smash] group, clipped to the target, and stay independently editable in Photoshop afterwards. Useful for mixed-lighting scenes where a single global curve over- or under-corrects." },
            { heading: "Band limiting (default = Mask)",
              body: "By default each band layer gets a paintable luminosity layer mask — visible thumbnail in the Layers panel, fully editable (paint to localize, blur to feather). This is the cleanest separation and what you want most of the time." },
            { heading: "Blend If toggle",
              body: "Turn ON to use the underlying-luma sliders (Layer Style → Blending Options) instead of a mask. Lighter than a mask (no mask data) and editable from the Blending Options dialog. Mutually exclusive with the mask — turning Blend If on disables mask export. May not work reliably in all Photoshop versions." },
            { heading: "Adaptive",
              body: "When ON, the band peaks shift to the target histogram's P10 / P50 / P90 luma percentiles, and the outer extents follow the histogram's actual min/max — so each band gets a meaningful pixel sample even on low-key or high-key images. When OFF, peaks are fixed at 0 / 128 / 255. Default ON; turn off only when you want a strict 0/128/255 partition for a specific look." },
            { heading: "Replace",
              body: "When Replace is on, re-applying overwrites the prior multi-zone trio rather than stacking another set on top." },
          ]); }}
            title="What does Multi do? Click for details."
            style={{ cursor: "help", fontSize: 10, opacity: 0.7, flexShrink: 0,
                     border: "1px solid #888", borderRadius: 8, width: 12, height: 12,
                     display: "inline-flex", alignItems: "center", justifyContent: "center",
                     lineHeight: 1, userSelect: "none" }}>?</span>
        </span>
      </div>

      {/* Marquee tristate (v1.18.0 / v1.19.3 mutual-exclusion). At Apply
          time, the active PS marquee can be used as the OUTPUT layer mask:
            - Off:     ignore marquee, full-image apply
            - Focus:   marquee shape becomes the layer mask (apply inside only)
            - Exclude: inverse marquee becomes the layer mask (apply outside only)
          Auto-disabled (dimmed, click no-op) when source mode is
          "selection" because the marquee is already in use as source pixels —
          can't be source AND output mask simultaneously. */}
      {(() => {
        const marqueeDisabled = srcMode === "selection";
        const disabledTip = "Disabled because the source is using the active marquee. Switch source to a layer or browsed image to use the marquee as an output mask.";
        // v1.20.21 — clear hint text appears below the row when the user
        // has selected focus/exclude but no marquee is captured. Tells them
        // exactly what's missing instead of leaving them wondering why the
        // preview didn't change.
        const showNoSelectionHint =
          !marqueeDisabled &&
          selectionMode !== "off" &&
          !selectionPreviewMask;
        return (
          <>
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 4, height: 18, lineHeight: "16px" }}>
            {/* v1.20.38 — row order: marquee | MASK | Off | Focus | Exclude | ↻ */}
            {/* v1.20.42 — "marquee" label removed; MASK pill now leads the row.
                The Off/Focus/Exclude pill labels are self-descriptive enough. */}
            <div onClick={() => setShowMask(v => !v)}
              title={showMask
                ? "Show Mask ON — protected regions painted red on the matched preview (palette × selection composition). Click to disable."
                : "Show Mask OFF — preview shows pure transform output. Click to enable: protected regions paint red."}
              style={{
                padding: "0 6px",
                fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: showMask ? "#3a2828" : "transparent",
                color: showMask ? "#e87a7a" : "#5a3a3a",
                border: `1px solid ${showMask ? "#d87a7a" : "#5a3a3a"}`,
                borderRadius: 2, cursor: "pointer", userSelect: "none",
                height: 18, lineHeight: "16px", boxSizing: "border-box",
                flexShrink: 0,
                marginRight: 8, // v1.20.39 — visual breathing room before the marquee tristate.
              }}>MASK</div>
            <div style={{ display: "flex", flex: 1, gap: 2, opacity: marqueeDisabled ? 0.55 : 1 }}>
              {([
                ["off",     "Off",     "Ignore the marquee — full-image apply (default). The marquee stays on the doc."],
                ["focus",   "Focus",   "Use the active marquee as the layer mask — the Curves/LUT applies ONLY inside the marquee. Multiplied with the target-palette mask if both are active."],
                ["exclude", "Exclude", "Use the INVERSE of the active marquee as the layer mask — the Curves/LUT applies everywhere OUTSIDE the marquee. Useful for protecting a chosen area."],
              ] as Array<["off" | "focus" | "exclude", string, string]>).map(([val, label, tip]) => (
                <div key={val}
                  onClick={() => { if (!marqueeDisabled) setSelectionMode(val); }}
                  title={marqueeDisabled ? disabledTip : tip}
                  style={{
                    flex: 1, height: 18, padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
                    background: !marqueeDisabled && selectionMode === val ? "#3a3a3a" : "transparent",
                    color: !marqueeDisabled && selectionMode === val ? "#dddddd" : "#888",
                    border: `1px solid ${!marqueeDisabled && selectionMode === val ? "#888" : "#444"}`,
                    borderRadius: 2,
                    cursor: marqueeDisabled ? "default" : "pointer",
                    userSelect: "none",
                    lineHeight: "16px", boxSizing: "border-box",
                  }}>{label}</div>
              ))}
            </div>
            {/* v1.20.20 — manual refresh + status indicator for the marquee
                preview mask. Shows whether the selection is currently being
                captured (and at what coverage). Click ↻ to force a re-read
                if the PS 'set' notification was missed. */}
            <div
              onClick={() => setSelectionTick(t => t + 1)}
              title={(() => {
                if (marqueeDisabled) return disabledTip;
                if (effectiveSelectionMode === "off") return "Marquee mode is OFF — preview ignores any active selection. Click to force a selection re-read.";
                if (!selectionPreviewMask) return "No selection detected for the target preview (or the snap has no bounds yet). Draw a marquee on the target and click ↻ to retry.";
                let inside = 0;
                for (let i = 0; i < selectionPreviewMask.length; i++) if (selectionPreviewMask[i] > 127) inside++;
                const pct = ((inside / selectionPreviewMask.length) * 100).toFixed(1);
                return `Selection captured: ${inside}/${selectionPreviewMask.length} preview pixels inside (${pct}%). Click ↻ to refresh.`;
              })()}
              style={{
                width: 18, height: 18, marginLeft: 2,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                color: selectionPreviewMask ? "#7ad87a" : "#888",
                border: `1px solid ${selectionPreviewMask ? "#7ad87a" : "#555"}`,
                borderRadius: 2, cursor: marqueeDisabled ? "default" : "pointer",
                fontSize: 11, userSelect: "none",
                opacity: marqueeDisabled ? 0.3 : 1,
              }}>
              <span style={{ marginTop: -1, lineHeight: 1 }}>↻</span>
            </div>
          </div>
          {showNoSelectionHint && (
            <div style={{
              marginTop: 2, padding: "2px 6px",
              fontSize: 9, color: "#d8b87a",
              background: "transparent", border: "1px solid #5a4a2a", borderRadius: 2,
              lineHeight: 1.3,
            }}>
              Marquee mode is <b>{selectionMode}</b> but no selection was captured. Draw a marquee on the target document, then click ↻ to refresh.{selectionMaskError ? <><br/><span style={{ opacity: 0.7 }}>{selectionMaskError}</span></> : null}
            </div>
          )}
          {marqueeDisabled && (
            <div style={{
              marginTop: 2, padding: "2px 6px",
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

      <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginTop: 6, width: "100%" }}>
        {/* Unified Apply + Replace-arm widget (v1.20.4 / refined v1.20.5).
            Outer container provides the rounded pill silhouette with
            overflow:hidden so the two inner zones share the shape
            cleanly — the red arm is INSIDE the pill, not protruding.
            Inner zones:
              - Left arm (16px): toggles overwriteOnApply. Red armed, dim
                disarmed. White dot indicator.
              - Right body: Apply action. Custom button styled to match
                Spectrum secondary look without sp-button's own corners
                fighting the outer container's rounded shape. */}
        <div style={{
          flex: "1 1 0", minWidth: 0, height: 28,
          display: "flex", flexDirection: "row",
          // Outer shell: rounded pill, neutral gray border always. The
          // red armed state is communicated through the arm's own
          // background (and divider) — outer border stays classic so the
          // widget reads as a familiar Spectrum button at a glance.
          borderRadius: 4,
          border: "1px solid #888",
          overflow: "hidden",
          boxSizing: "border-box",
        }}>
          {/* v1.20.45 — arm redesigned. The DEFAULT is overwrite (replace
              the prior Match layer), and the default state shows no
              indicator at all — just "Apply." Toggling to NEW mode
              (stacks a new layer alongside priors) flips the arm to a
              friendly green "+" with the Apply label reading "Apply +".
              Old red dot was visually scary for what's actually the most
              common case. */}
          <div onClick={e => { e.stopPropagation(); setOverwriteOnApply(!overwriteOnApply); }}
            title={overwriteOnApply
              ? "Apply replaces the prior Match layer (default). Click the + to switch to 'Apply New' mode — each Apply stacks a fresh layer alongside priors."
              : "APPLY NEW — each Apply stacks a fresh Match layer alongside priors (your timeline grows). Click to switch back to overwrite mode (default)."}
            style={{
              width: 18, height: "100%", padding: 0, flexShrink: 0,
              background: overwriteOnApply ? "#2a2a2a" : "#1e3a1e",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", userSelect: "none",
              boxSizing: "border-box",
            }}>
            {overwriteOnApply
              ? <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#666", display: "inline-block",
                }} />
              : <span style={{
                  color: "#7ad87a", fontSize: 14, fontWeight: 700, lineHeight: 1,
                  userSelect: "none",
                }}>+</span>}
          </div>
          {/* Apply body — label reads "Apply" in default replace mode,
              "Apply +" in new-layer mode. */}
          <div onClick={outputMode === "lut" ? onApplyLut : onApply}
            title={
              outputMode === "lut"
                ? "Create a Color Lookup adjustment layer in [Color Smash] loaded with a 33³ 3D LUT. The + arm toggles whether Apply replaces the prior layer (default) or stacks new ones alongside it."
                : multiZone
                  ? "Multi: creates 3 stacked Curves layers (shadow/mid/highlight) with band limiting via mask and/or Blend If. Each editable independently in PS."
                  : "Create a new Curves adjustment layer in the target document, clipped to the target layer. The + arm toggles whether Apply replaces the prior layer (default) or stacks new ones."
            }
            style={{
              flex: "1 1 0", minWidth: 0, height: "100%",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#3a3a3a", color: "#eeeeee",
              fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
              borderLeft: "1px solid #555",
              cursor: "pointer", userSelect: "none",
              overflow: "hidden", whiteSpace: "nowrap",
            }}>{overwriteOnApply ? "Apply" : "Apply +"}</div>
        </div>
        {/* Live LUT toggle: when on, every state change re-bakes the LUT into
            the existing Match LUT layer (debounced ~300ms). Off by default —
            the contract is stronger than one-shot Apply LUT, so we make it opt-in.
            Match the visual style of the small mode-toggle pills used elsewhere
            (palette mask, adapt, count) — dim when off, soft amber when on. */}
        {/* v1.20.43 — LIVE pill restyled: neutral gray when off (was almost
            invisible amber-on-dark), warm amber only when on. Same height
            as Apply / Save LUT pills next to it. */}
        <div onClick={() => setLiveLut(v => !v)}
          title={liveLut
            ? "Live LUT ON — slider changes auto-update the Match LUT layer in real-time (debounced 300ms). Click Apply LUT once to seed the layer if none exists yet, then changes propagate automatically."
            : "Live LUT OFF — the Match LUT layer is frozen until you hit Apply LUT again. Click to enable: every change auto-bakes into the existing layer."}
          style={{
            padding: "0 8px", fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            background: liveLut ? "#3a3228" : "#2a2a2a",
            color: liveLut ? "#e8c882" : "#aaaaaa",
            border: `1px solid ${liveLut ? "#d8b87a" : "#666"}`,
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            height: 28, lineHeight: "26px", boxSizing: "border-box",
            flex: "0 0 auto",
          }}>LIVE</div>
        {/* v1.20.43 — RESTORE pill now dim/disabled when no XMP is found on
            the active layer; comes alive when the user clicks a previously-
            baked Match layer. Teaches users the feature exists by enabling
            itself exactly when it's useful. */}
        <div onClick={canRestore ? onRestoreFromLayer : undefined}
          title={canRestore
            ? "Restore panel state from the selected Match layer's XMP metadata. Snaps every slider, preset, palette weight, and doc/layer choice back to the state that produced this layer."
            : "Disabled — no Color Smash metadata found on the active layer. Click a previously-baked Match layer in the Layers panel to enable."}
          style={{
            padding: "0 8px", fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            // v1.20.46 — muted gray when disabled, accent color only when
            // there's actually something to restore. Matches LIVE's pattern:
            // reserve color for the active state.
            background: canRestore ? "#283440" : "#2a2a2a",
            color: canRestore ? "#7aa8d8" : "#aaaaaa",
            border: `1px solid ${canRestore ? "#7aa8d8" : "#666"}`,
            borderRadius: 4, cursor: canRestore ? "pointer" : "default", userSelect: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            height: 28, lineHeight: "26px", boxSizing: "border-box",
            flex: "0 0 auto",
            opacity: canRestore ? 1 : 0.7,
          }}>RESTORE</div>
        {/* v1.20.43 — Save LUT styled to match the Apply pill aesthetic:
            rounded shell, neutral gray background, light text. Reads as a
            sibling action to Apply rather than a different system. */}
        <div onClick={onExportLut}
          title="Export the staged preset as a portable 33³ .CUBE 3D LUT to disk. Loadable in Photoshop, Premiere, Resolve, etc. Use Apply LUT instead if you just want it in this PS doc."
          style={{
            padding: "0 10px", fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            background: "#3a3a3a", color: "#eeeeee",
            border: "1px solid #888",
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            height: 28, lineHeight: "26px", boxSizing: "border-box",
            flex: "0 0 auto",
            whiteSpace: "nowrap",
          }}>Save LUT…</div>
        {/* v1.20.43 — SAVE/✕/⟳ pills relocated from the BottomActionBar to
            this row. Compact icon-style so they trail the apply cluster
            without dominating it. */}
        <div onClick={() => setRemember(!remember)}
          title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles, output mode, LUT options)."
          style={{
            width: 32, height: 28, marginLeft: 4,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: remember ? "#3a3a3a" : "transparent",
            color: remember ? "#dddddd" : "#888",
            border: `1px solid ${remember ? "#888" : "#444"}`,
            borderRadius: 4, cursor: "pointer", userSelect: "none",
            fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
            boxSizing: "border-box", flexShrink: 0,
          }}>SAVE</div>
        <div onClick={async () => {
          const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
          if (ok) onResetAll();
        }}
          title="Reset all settings to defaults and clear the saved file"
          style={{
            width: 22, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 13, lineHeight: 1,
            border: "none", borderRadius: 4, cursor: "pointer", boxSizing: "border-box", flexShrink: 0,
          }}>
          <span style={{ marginTop: -1 }}>✕</span>
        </div>
        <div onClick={onRefreshAll}
          title={stale
            ? "Photoshop changed since last refresh — click to resync"
            : "In sync. Click to refresh source + target previews + layer lists"}
          style={{
            width: 22, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: stale ? "#c19a3a" : "transparent",
            color: stale ? "#fff" : "#aaa",
            border: `1px solid ${stale ? "#c19a3a" : "#888"}`,
            borderRadius: 4, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 15, userSelect: "none",
          }}>
          <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
        </div>
      </div>

      {/* Recent history (v1.20.0). Always rendered — empty buffer shows
          dim placeholder slots (v1.20.2) so the user discovers the feature
          even before their first Apply. As entries come in, placeholders
          get replaced from the left until the buffer fills. Pinned entries
          push placeholders out of the row. */}
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
          <div onClick={() => setHistoryOpen(o => !o)}
            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, opacity: 0.65,
                     cursor: "pointer", userSelect: "none", height: 14, lineHeight: "14px" }}
            title={historyOpen ? "Hide recent applies" : "Show recent applies — click any thumbnail to restore that state"}>
            <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>
              {historyOpen ? "▾" : "▸"}
            </span>
            <span>history ({recentHistory.length})</span>
          </div>
          {historyOpen && (
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
              {Array.from({ length: placeholderCount }).map((_, i) => (
                <div key={`ph-${i}`}
                  title="Empty history slot — Apply a match to fill."
                  style={{
                    width: 60, height: 22, padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    border: "1px dashed #3a3a3a", borderRadius: 2,
                    background: "transparent",
                    color: "#3a3a3a", fontSize: 9, lineHeight: 1,
                    userSelect: "none", flexShrink: 0,
                  }}>—</div>
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

      {/* LUT-specific knobs (v1.17.0; relocated below the Apply row in v1.18.x
          so the Apply cluster reads as the primary action — knobs are
          contextual settings for that action, not pre-actions). Only rendered
          when LUT mode is active. */}
      {outputMode === "lut" && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {/* Strength slider — lerps LUT toward identity before bake.
              Differs from PS layer opacity because the lerp is baked INTO
              the LUT, so .cube exports carry the dialed-back look. */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: 14, lineHeight: "14px" }}
            title={`LUT strength: ${lutStrength}% — blends the generated 3D LUT toward an identity LUT before bake. 100% = full match, 0% = identity (no transform). The lerp is baked into the LUT bytes, so portable .cube exports carry the dialed-back look (PS layer opacity wouldn't survive .cube export).`}>
            <span style={{ fontSize: 9, opacity: 0.5, width: 38 }}>strength</span>
            <input type="range" min={0} max={100} step={1} value={lutStrength}
              onChange={e => setLutStrength(parseInt((e.target as HTMLInputElement).value, 10))}
              style={{ flex: 1, margin: 0, cursor: "pointer" }} />
            <span style={{ fontSize: 9, opacity: 0.7, width: 28, textAlign: "right" }}>{lutStrength}%</span>
          </div>
          {/* Grid quality 3-way. 17³ draft / 33³ standard / 65³ high. */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: 18, lineHeight: "16px" }}>
            <span style={{ fontSize: 9, opacity: 0.5, width: 38 }}>quality</span>
            <div style={{ display: "flex", flex: 1, gap: 2 }}>
              {([
                [17 as const, "Draft 17³",   "Draft quality: 17³ grid (~50KB). Fastest to bake, visible banding in subtle gradients. Good for quick previews / iterative editing."],
                [33 as const, "Standard 33³", "Standard quality: 33³ grid (~430KB). Default. Matches PS Color Lookup's native default. Good for most photographic work."],
                [65 as const, "High 65³",    "High quality: 65³ grid (~3.3MB). Smoothest result, larger files. Useful for video-grading / log-LUT workflows where 33³ shows banding."],
              ] as Array<[17 | 33 | 65, string, string]>).map(([val, label, tip]) => (
                <div key={val} onClick={() => setLutGrid(val)} title={tip}
                  style={{
                    flex: 1, height: 18, padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
                    background: lutGrid === val ? "#3a3a3a" : "transparent",
                    color: lutGrid === val ? "#dddddd" : "#888",
                    border: `1px solid ${lutGrid === val ? "#888" : "#444"}`,
                    borderRadius: 2, cursor: "pointer", userSelect: "none",
                    lineHeight: "16px", boxSizing: "border-box",
                  }}>{label}</div>
              ))}
            </div>
          </div>
          {/* Advanced disclosure (collapsed by default) housing the Dither toggle. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div onClick={() => setLutAdvancedOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, opacity: 0.5, cursor: "pointer", userSelect: "none", height: 14, lineHeight: "14px" }}
              title="Advanced LUT options">
              <span style={{ width: 8, display: "inline-block", textAlign: "center" }}>
                {lutAdvancedOpen ? "▾" : "▸"}
              </span>
              <span>advanced</span>
            </div>
            {lutAdvancedOpen && (
              <div onClick={() => setLutDither(!lutDither)}
                style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 14, fontSize: 9, color: "#cccccc", cursor: "pointer", height: 14, lineHeight: "14px" }}
                title="Dither: PS Color Lookup's noise-injection field that hides quantization banding. Default ON, matches PS's own default. Turn off for a bit-exact LUT result and accept visible banding in subtle gradients.">
                <input type="checkbox" checked={lutDither}
                  onChange={e => setLutDither(e.target.checked)}
                  style={{ margin: 0, width: 12, height: 12 }} />
                <span>dither</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Curves graph below Apply */}
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
      <CurvesGraph curves={renderedCurves} />

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>

      {/* Diagnostic-only doc-rename probe. Read-only; never mutates srcDocId / srcMode /
          targetId / etc. Logs every name-shaped value across every API surface so we can
          see whether ANY source updates after Save As before the panel is reopened. */}
    </div>
  );
}
