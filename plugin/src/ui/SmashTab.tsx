// Smash tab — source↔target color-pool correspondence prototype.
//
// Picks a SOURCE layer and a TARGET layer (two independent doc/layer pickers,
// mirroring AnalysisTab's machinery twice), segments BOTH images into color
// pools with one shared set of controls, then runs matchPools() to auto-pair
// every target pool to a source pool.
//
// This tab does NO pixel transfer — it only computes and visualizes the
// correspondence. The auto-match result lives in editable component state:
// clicking a target row selects it, then clicking a source swatch reassigns
// that target's donor. "Reset to auto" restores matchPools()'s output.
//
// Segmentation runs in a deferred effect so the "analyzing…" state can paint
// before the synchronous segment work blocks the main thread.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  app, readLayerPixels, writePixelLayer, writePoolGroupLayers, executeAsModal,
  setGroupName,
  type PoolLayerData,
} from "../services/photoshop";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../core/prefs";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { SourceSelector } from "./SourceSelector";
import { Section } from "./Section";
import { SmashRecipes } from "./SmashRecipes";
import { Dropdown } from "./Dropdown";
import { downsampleToMaxEdge } from "../core/downsample";
import { rgbaToPngDataUrl } from "./encodePng";
import { matchStyles } from "./MatchSliders";
import { segmentImage, SegmentResult, Pool } from "../core/clusters";
import { matchPools, PoolMatch, Correspondence } from "../core/match";
import { transferColors, vectorizeUpscaleLabels, type TransferAnchor } from "../core/transfer";
import { analyzeAnchor, type AnchorAnalysis } from "../core/anchorAnalysis";

// Default max edge fed into segmentImage — keeps per-pixel clustering under a
// frame budget while staying detailed enough for a recognizable pool map. The
// live value is component state (the Fidelity slider) — this is just the seed.
const SEGMENT_MAX_EDGE = 256;
// Panel content width budget — pool-map images scale to fit this.
const PANEL_WIDTH = 220;
// Brightness multiplier applied to non-hovered pools in the pool maps.
const HOVER_DIM = 0.32;
// Side-by-side pool maps each get half the panel width (minus the gap).
const POOL_MAP_W = (PANEL_WIDTH - 6) / 2;

type SrcMode = "layer" | "selection" | "folder";

// Overlay dot rendered on a PoolMapPane. `kind` selects how PoolMapPane wires
// pointer events: "source" / "target" dots reference an anchor by index;
// "activeSource" is the unique sticky-source "loaded gun" dot which lives
// outside the anchors array. `dashed` is purely cosmetic (used by activeSource
// to read as pending/uncommitted).
type PoolMapDot = {
  kind: "source" | "target" | "activeSource";
  anchorIndex?: number;
  nx: number;
  ny: number;
  radius: number;
  color: string;
  dashed?: boolean;
};

// Sort modes for the TARGET → SOURCE list. Display-only — doesn't affect
// the underlying matches array or anything downstream.
type SortMode =
  | "weightDesc"   // largest first (default — matches segmentImage's order)
  | "weightAsc"    // smallest first
  | "lightToDark"  // by Lab L descending
  | "darkToLight"  // by Lab L ascending
  | "warmToCool"   // by (a + b) descending — yellow/red warm vs blue/cyan cool
  | "coolToWarm";  // by (a + b) ascending

function sortPools(pools: Pool[], mode: SortMode): Pool[] {
  const arr = [...pools];
  switch (mode) {
    case "weightAsc":   arr.sort((p, q) => p.descriptor.weight - q.descriptor.weight); break;
    case "lightToDark": arr.sort((p, q) => q.descriptor.labL - p.descriptor.labL); break;
    case "darkToLight": arr.sort((p, q) => p.descriptor.labL - q.descriptor.labL); break;
    case "warmToCool":  arr.sort((p, q) => (q.descriptor.labA + q.descriptor.labB) - (p.descriptor.labA + p.descriptor.labB)); break;
    case "coolToWarm":  arr.sort((p, q) => (p.descriptor.labA + p.descriptor.labB) - (q.descriptor.labA + q.descriptor.labB)); break;
    case "weightDesc":
    default:            arr.sort((p, q) => q.descriptor.weight - p.descriptor.weight); break;
  }
  return arr;
}

// Recursively search the layer tree for a layer with the given id. doc.layers
// only holds top-level items, so layers nested in groups need this walk.
// Mirrors the same helper in useLayerPreview.ts.
function findLayerById(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (Array.isArray(l.layers)) {
      const found = findLayerById(l.layers, id);
      if (found) return found;
    }
  }
  return null;
}

// ────────── per-image doc/layer picking ──────────
// Encapsulates one image's doc list + active doc + layer pick + snapshot.
// SmashTab uses two of these (source + target). Duplication of AnalysisTab's
// machinery is intentional — a prototype, not worth a shared abstraction yet.
function useImagePicker(segmentMaxEdge: number) {
  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  const [docId, setDocId] = useState<number | null>(null);
  const [layerId, setLayerId] = useState<number | null>(null);

  const { layers, refresh: refreshLayers } = useLayers(docId);

  // Seed the doc list + active doc on mount.
  useEffect(() => {
    try {
      const list = (app.documents ?? []).map((d: any) => ({ id: d.id as number, name: d.name as string }));
      setDocs(list);
      setDocId(prev => (prev != null && list.some((d: { id: number }) => d.id === prev))
        ? prev
        : (app.activeDocument?.id ?? list[0]?.id ?? null));
    } catch { /* */ }
  }, []);

  // Auto-pick a layer once the layer list resolves (last = topmost edit).
  useEffect(() => {
    if (layers.length > 0 && (layerId == null || !layers.find(l => l.id === layerId))) {
      setLayerId(layers[layers.length - 1].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const docsKey = useMemo(() => docs.map(d => `${d.id}:${d.name}`).join("|"), [docs]);
  const layersKey = useMemo(() => layers.map(l => `${l.id}:${l.name}`).join("|"), [layers]);

  const { snap, error: snapError } = useLayerPreview(docId, layerId);

  // Downsample the snapshot once per snapshot change to the segmentation edge.
  const segInput = useMemo(() => {
    if (!snap) return null;
    const bounds = snap.bounds ?? { left: 0, top: 0, right: snap.width, bottom: snap.height };
    return downsampleToMaxEdge(
      { width: snap.width, height: snap.height, data: snap.data, bounds },
      segmentMaxEdge,
    );
  }, [snap, segmentMaxEdge]);

  return {
    docs, docId, setDocId, layerId, setLayerId,
    layers, refreshLayers, docsKey, layersKey,
    snap, snapError, segInput,
  };
}

// Build a pool-map PNG data URL by walking labels → pool color. The `colorFor`
// callback resolves a pool to the RGB it should paint as, so the same routine
// renders both a pool's own mean color and (for the donor preview) its matched
// source color.
function buildPoolMapUrl(
  result: SegmentResult | null,
  colorFor: (pool: Pool) => { r: number; g: number; b: number },
): string | null {
  if (!result) return null;
  const { width, height, labels, pools } = result;
  const byId = new Map<number, Pool>();
  for (const p of pools) {
    byId.set(p.id, p);
    if (p.subPools) for (const c of p.subPools) byId.set(c.id, c);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < labels.length; i++) {
    const pool = byId.get(labels[i]);
    const o = i * 4;
    if (pool) {
      const c = colorFor(pool);
      rgba[o] = c.r;
      rgba[o + 1] = c.g;
      rgba[o + 2] = c.b;
    }
    rgba[o + 3] = 255;
  }
  return rgbaToPngDataUrl(rgba, width, height);
}

export function SmashTab() {
  // ── Shared segmentation controls (applied to BOTH images) ──────────
  const [poolCount, setPoolCount] = useState(6);
  const [edgePreservation, setEdgePreservation] = useState(0.55);
  const [regionCleanup, setRegionCleanup] = useState(0.4);
  const [colorVsValueBias, setColorVsValueBias] = useState(0.5);
  const [neutralProtection, setNeutralProtection] = useState(0);
  const [poolContinuity, setPoolContinuity] = useState(0);
  const [subPaletteSize, setSubPaletteSize] = useState(5);
  // Fidelity = segmentation working resolution. Higher = finer islands /
  // crisper boundaries, but slower to re-segment on every control change.
  // Shared between source and target so both sides recompute together.
  const [segmentMaxEdge, setSegmentMaxEdge] = useState(SEGMENT_MAX_EDGE);

  const source = useImagePicker(segmentMaxEdge);
  const target = useImagePicker(segmentMaxEdge);

  // ── Segmentation results + analyzing state ─────────────────────────
  const [sourceResult, setSourceResult] = useState<SegmentResult | null>(null);
  const [targetResult, setTargetResult] = useState<SegmentResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [segError, setSegError] = useState<string | null>(null);

  // ── Correspondence (editable) ──────────────────────────────────────
  // `matches` starts as matchPools()'s output and is mutated by manual remap
  // clicks. `autoMatches` keeps the pristine auto result for "Reset to auto".
  const [matches, setMatches] = useState<PoolMatch[]>([]);
  const [autoMatches, setAutoMatches] = useState<PoolMatch[]>([]);
  // Currently-selected target pool id (null = none). The selected row shows
  // an inline source-pool picker.
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
  // Hovered pool ids — highlight the matching region in the pool maps.
  const [hoveredTargetId, setHoveredTargetId] = useState<number | null>(null);
  const [hoveredSourceId, setHoveredSourceId] = useState<number | null>(null);
  // Nice-to-have: tint the target pool map by each region's matched donor.
  const [donorPreview, setDonorPreview] = useState(false);
  // Display-only sort for the correspondence list.
  const [sortMode, setSortMode] = useState<SortMode>("weightDesc");

  // Inner tab switcher for the two big control surfaces. The pool maps +
  // before/after preview stay persistently visible above this; only the
  // Controls (segmentation + transfer) and Correspondence (list + anchors)
  // surfaces are tabbed so the preview never gets pushed off-screen.
  const [innerTab, setInnerTab] = useState<"controls" | "correspondence">("controls");

  // ── Focal anchors (list of pairs) ──
  // Each anchor is a completed source↔target pair. Each click captures a
  // source POINT (no longer a single source pool id — anchors now run their
  // own mini-Smash on the pixels inside their falloff). Workflow is sticky
  // source:
  //   1. Click the SOURCE map → sets `activeSource` (the "loaded gun").
  //   2. Click the TARGET map → drops an anchor using activeSource's point;
  //      activeSource PERSISTS so subsequent target clicks spawn more anchors
  //      all sharing the same source point.
  // activeSource is replaced by another source-map click, or cleared via the
  // × on its dot. Each anchor carries its OWN per-side radii and correlation
  // knobs; the shared `anchorRadius` state below seeds NEW anchors only.
  interface AnchorPair {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    // Decoupled radii: sourceRadius sizes the SOURCE sample circle (how much
    // source structure the mini-Smash pulls in); targetRadius sizes the TARGET
    // apply circle (the per-pixel falloff reach). Seeded equally from
    // `anchorRadius` on creation, then tuned per-anchor in the row below.
    sourceRadius: number;
    targetRadius: number;
    // How much this anchor REPLACES the auto transfer, on top of the spatial
    // falloff. 0..1, default 1 (falloff alone gates the replace).
    strength: number;
    // Per-channel transfer locks (LCh). When true (default) the anchor moves
    // that dimension toward the source; when false it keeps the target's own.
    transferValue: boolean;
    transferChroma: boolean;
    transferHue: boolean;
  }
  const [anchors, setAnchors] = useState<AnchorPair[]>([]);
  const [activeSource, setActiveSource] = useState<{ nx: number; ny: number } | null>(null);
  // Default falloff radius applied to NEW anchors when they're completed.
  // Existing anchors keep whatever radius they were created with — change
  // them individually via their row slider.
  const [anchorRadius, setAnchorRadius] = useState(0.2);
  // "Anchor detail" — controls the local pool density of the mini-Smash run
  // inside each anchor's falloff. Higher = more sub-pools = richer local
  // transfer. See anchorAnalysis.ts for the detail→poolCount mapping.
  const [anchorDetail, setAnchorDetail] = useState(0.5);
  // Single-accordion model for the per-anchor control rows: at most one anchor
  // is expanded at a time. Tracked as an index (null = all collapsed) rather
  // than a Set so it degrades gracefully as indices shift on removal.
  const [expandedAnchor, setExpandedAnchor] = useState<number | null>(null);

  // ── Per-anchor mini-Smash analyses ──
  // Each anchor in the list above is fed through analyzeAnchor (which runs a
  // local segmentation on both sides of the anchor's circle, matches the
  // local pools, and builds per-local-pool sub-mappings). The result is what
  // transferColors actually consumes — the AnchorPair list is purely the UI
  // representation. Analysis depends on: anchors, anchorDetail, the global
  // segmentation opts, and both segInputs (which carry the rgba pixels +
  // dimensions). Deferred a frame so the UI can render an "analyzing…" state
  // before the synchronous work blocks the main thread.
  const [anchorAnalyses, setAnchorAnalyses] = useState<AnchorAnalysis[]>([]);
  const [anchorAnalyzing, setAnchorAnalyzing] = useState(false);

  useEffect(() => {
    if (anchors.length === 0 || !source.segInput || !target.segInput) {
      setAnchorAnalyses([]);
      setAnchorAnalyzing(false);
      return;
    }
    let cancelled = false;
    setAnchorAnalyzing(true);
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        const baseSegmentOpts = {
          poolCount, edgePreservation, regionCleanup, colorVsValueBias,
          subPaletteSize, neutralProtection, poolContinuity,
        };
        const next = anchors.map(a => analyzeAnchor({
          sourceRgba: source.segInput!.data,
          sourceWidth: source.segInput!.width,
          sourceHeight: source.segInput!.height,
          sourceX: a.sourceX, sourceY: a.sourceY,
          targetRgba: target.segInput!.data,
          targetWidth: target.segInput!.width,
          targetHeight: target.segInput!.height,
          targetX: a.targetX, targetY: a.targetY,
          sourceRadius: a.sourceRadius,
          targetRadius: a.targetRadius,
          baseSegmentOpts,
          detail: anchorDetail,
        }));
        if (!cancelled) setAnchorAnalyses(next);
      } finally {
        if (!cancelled) setAnchorAnalyzing(false);
      }
    }, 16);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [
    anchors, anchorDetail,
    source.segInput, target.segInput,
    poolCount, edgePreservation, regionCleanup, colorVsValueBias,
    subPaletteSize, neutralProtection, poolContinuity,
  ]);

  // The list passed into transferColors. Each AnchorAnalysis carries the
  // geometry (radius = the anchor's targetRadius) + localTargetLabels +
  // per-pool mappings; here we merge in the per-anchor correlation knobs
  // (strength + the three channel locks) from the matching AnchorPair. The
  // analysis array and the anchors array are index-aligned (analyzeAnchor is
  // mapped 1:1 over anchors), so anchors[i] supplies anchorAnalyses[i]'s knobs.
  const transferAnchors = useMemo<TransferAnchor[]>(
    () => anchorAnalyses.map((analysis, i) => {
      const a = anchors[i];
      return {
        ...analysis,
        strength: a?.strength ?? 1,
        transferValue: a?.transferValue ?? true,
        transferChroma: a?.transferChroma ?? true,
        transferHue: a?.transferHue ?? true,
      };
    }),
    [anchorAnalyses, anchors],
  );

  // Repeating distinguishable palette so multiple anchors on the maps don't
  // collide visually. Source and target dots for anchor N share the same hue
  // so they read as a pair.
  const ANCHOR_COLORS = ["#ff9a00", "#22c1d6", "#d646b9", "#7ad62f", "#e8d227"];
  const colorForAnchor = (i: number) => ANCHOR_COLORS[i % ANCHOR_COLORS.length];
  // Distinct hue for the "loaded gun" — reads as "not yet committed".
  const ACTIVE_SOURCE_COLOR = "#fff14d";

  // Dot+ring overlays for the two pool maps. Each committed anchor contributes
  // a source dot and a target dot in its paired colour. The active source (a
  // sticky "loaded gun", may spawn many anchors) is shown on the source map
  // only, in a distinct colour with a dashed ring so it reads as pending.
  //
  // The `kind` field tells PoolMapPane how to wire pointer events: anchor dots
  // map back to an `anchorIndex`; the active-source dot drags/removes the
  // activeSource state directly.
  const sourceAnchorDots = useMemo<PoolMapDot[]>(() => {
    const dots: PoolMapDot[] = anchors.map((a, i) => ({
      kind: "source",
      anchorIndex: i,
      nx: a.sourceX,
      ny: a.sourceY,
      // Source dot ring shows the SOURCE sample radius.
      radius: a.sourceRadius,
      color: colorForAnchor(i),
    }));
    if (activeSource) {
      dots.push({
        kind: "activeSource",
        nx: activeSource.nx,
        ny: activeSource.ny,
        // Active source has no committed radius; preview it at the
        // default-for-new-anchors value.
        radius: anchorRadius,
        color: ACTIVE_SOURCE_COLOR,
        dashed: true,
      });
    }
    return dots;
  }, [anchors, activeSource, anchorRadius]);
  const targetAnchorDots = useMemo<PoolMapDot[]>(
    () =>
      anchors.map((a, i) => ({
        kind: "target",
        anchorIndex: i,
        nx: a.targetX,
        ny: a.targetY,
        // Target dot ring shows the TARGET apply radius.
        radius: a.targetRadius,
        color: colorForAnchor(i),
      })),
    [anchors],
  );

  // ── Color transfer (in-panel preview) ─────────────────────────────
  // Blend amount fed to transferColors — 0 = unchanged target, 1 = full donor.
  const [strength, setStrength] = useState(1.0);
  // Boundary softness — 0 = hard pool edges, 1 = maximally blended recolor.
  const [relax, setRelax] = useState(0.35);
  // Luminance preservation — 0 = full recolor, 1 = keep target's lightness.
  const [preserveLuminance, setPreserveLuminance] = useState(0);
  // Source richness — 0 = sub-swatch averaged transfer (today's behaviour),
  // 1 = per-pixel sample-rank match against the donor pool's actual source
  // pixels, pulling the donor's original chroma variation through.
  const [richness, setRichness] = useState(0);
  // The recolored-target PNG data URL. null until a transfer has been run.
  const [transferUrl, setTransferUrl] = useState<string | null>(null);
  // Before/after toggle for the preview pane (false = before, true = after).
  const [showAfter, setShowAfter] = useState(true);
  // Last error from a transfer attempt, if any.
  const [transferError, setTransferError] = useState<string | null>(null);
  // Once "Apply Smash" has been pressed the preview goes live — it re-runs
  // automatically whenever segmentation, the correspondence, or strength change.
  const [hasApplied, setHasApplied] = useState(false);

  // ── Output to document ─────────────────────────────────────────────
  // True while a full-resolution transfer + layer write is in flight.
  const [outputting, setOutputting] = useState(false);
  // Last error from an "Output to document" attempt, if any.
  const [outputError, setOutputError] = useState<string | null>(null);
  // What the Output button writes:
  //   "single" — one recolored "Color Smash" pixel layer (legacy behaviour).
  //   "group"  — one layer group ("Color Smash · pools") with one transparent
  //              pixel layer per pool, hand-editable region by region.
  //   "both"   — the single layer AND a per-pool group, in that order.
  type OutputMode = "single" | "group" | "both";
  const [outputMode, setOutputMode] = useState<OutputMode>("single");
  // User-configurable base name for the output layer / group. Persisted to
  // localStorage via core/prefs; mirrored into the photoshop service's
  // GROUP_NAME so any in-session callsite that reads it picks up the choice.
  // Default until the mount effect below hydrates from storage.
  const [outputName, setOutputName] = useState<string>(DEFAULT_PREFS.outputName);

  // Hydrate the output-name pref once on mount and push it into the photoshop
  // service so existing GROUP_NAME readers see the user's choice.
  useEffect(() => {
    const prefs = loadPrefs();
    setOutputName(prefs.outputName);
    setGroupName(prefs.outputName);
  }, []);

  // Segment both images whenever either input or any control changes. Work is
  // synchronous and can take a moment, so flip on "analyzing", yield a frame
  // for it to paint, then run both segmentations + the match.
  useEffect(() => {
    if (!source.segInput || !target.segInput) {
      setSourceResult(null);
      setTargetResult(null);
      setSegError(null);
      return;
    }
    let cancelled = false;
    setAnalyzing(true);
    setSegError(null);
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        const opts = { poolCount, edgePreservation, regionCleanup, colorVsValueBias, subPaletteSize, neutralProtection, poolContinuity };
        const sRes = segmentImage(source.segInput!.data, source.segInput!.width, source.segInput!.height, opts);
        const tRes = segmentImage(target.segInput!.data, target.segInput!.width, target.segInput!.height, opts);
        const corr = matchPools(sRes.pools, tRes.pools);
        if (!cancelled) {
          setSourceResult(sRes);
          setTargetResult(tRes);
          setMatches(corr.matches.map(m => ({ ...m })));
          setAutoMatches(corr.matches.map(m => ({ ...m })));
          setSelectedTargetId(null);
        }
      } catch (e: any) {
        if (!cancelled) {
          setSourceResult(null);
          setTargetResult(null);
          setSegError(e?.message ?? String(e));
        }
      } finally {
        if (!cancelled) setAnalyzing(false);
      }
    }, 16);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [source.segInput, target.segInput, poolCount, edgePreservation, regionCleanup, colorVsValueBias, neutralProtection, poolContinuity, subPaletteSize]);

  // ── Lookups ────────────────────────────────────────────────────────
  const sourcePoolsById = useMemo(() => {
    const m = new Map<number, Pool>();
    for (const p of sourceResult?.pools ?? []) m.set(p.id, p);
    return m;
  }, [sourceResult]);

  const matchByTargetId = useMemo(() => {
    const m = new Map<number, PoolMatch>();
    for (const mm of matches) m.set(mm.targetPoolId, mm);
    return m;
  }, [matches]);

  // ── Pool-map images ────────────────────────────────────────────────
  // When a pool is hovered, every other pool is dimmed so the hovered
  // region stands out — that's the "which area is this?" highlight.
  const sourceMapUrl = useMemo(
    () => buildPoolMapUrl(sourceResult, p => {
      const d = p.descriptor;
      return hoveredSourceId != null && p.id !== hoveredSourceId
        ? { r: d.r * HOVER_DIM, g: d.g * HOVER_DIM, b: d.b * HOVER_DIM }
        : { r: d.r, g: d.g, b: d.b };
    }),
    [sourceResult, hoveredSourceId],
  );

  // The target map tints by matched donor when "Donor preview" is on OR while
  // a row is selected for remapping — so reassigning a donor shows up live in
  // the target map instead of only in the row.
  const showDonorTint = donorPreview || selectedTargetId != null;

  // Target map: each pool's own mean color, or (donor tint) the mean color
  // of its matched source pool — with the hovered pool kept bright. While the
  // user hovers a swatch in the selected row's picker, that prospective donor
  // is previewed on the selected pool before any click commits it.
  const targetMapUrl = useMemo(
    () => buildPoolMapUrl(targetResult, p => {
      let base = p.descriptor;
      if (showDonorTint) {
        const previewing = p.id === selectedTargetId && hoveredSourceId != null;
        const donorId = previewing
          ? hoveredSourceId
          : matchByTargetId.get(p.id)?.sourcePoolId;
        const donor = donorId != null ? sourcePoolsById.get(donorId) : undefined;
        if (donor) base = donor.descriptor;
      }
      return hoveredTargetId != null && p.id !== hoveredTargetId
        ? { r: base.r * HOVER_DIM, g: base.g * HOVER_DIM, b: base.b * HOVER_DIM }
        : { r: base.r, g: base.g, b: base.b };
    }),
    [targetResult, showDonorTint, matchByTargetId, sourcePoolsById,
      hoveredTargetId, hoveredSourceId, selectedTargetId],
  );

  // Half-width sizes for the side-by-side pool maps; full width is kept for
  // the before/after preview pane below.
  const sourceMapDisplay = useDisplaySize(sourceResult, POOL_MAP_W);
  const targetMapDisplay = useDisplaySize(targetResult, POOL_MAP_W);
  const targetDisplay = useDisplaySize(targetResult);

  // ── Before/after preview ───────────────────────────────────────────
  // "Before" is the actual original target pixels — encode the target's
  // segInput RGBA (the same downsampled buffer the transfer recolors), so
  // before and after are pixel-aligned at identical dimensions.
  const beforeUrl = useMemo(() => {
    const seg = target.segInput;
    if (!seg) return null;
    return rgbaToPngDataUrl(seg.data, seg.width, seg.height);
  }, [target.segInput]);

  // Live transfer preview. Once "Apply Smash" has been pressed (hasApplied),
  // the recolored result is recomputed whenever the segmentation, the
  // correspondence, or the strength changes — so every control, sub-palette
  // size included, affects the preview without a manual re-apply. Debounced a
  // frame so slider drags stay responsive.
  useEffect(() => {
    if (!hasApplied) return;
    if (!sourceResult || !targetResult || !target.segInput || matches.length === 0) {
      setTransferUrl(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        const usedSourceIds = new Set(matches.map(m => m.sourcePoolId));
        const correspondence: Correspondence = {
          matches: matches.map(m => ({ ...m })),
          unmatchedSourceIds: sourceResult.pools
            .filter(p => !usedSourceIds.has(p.id))
            .map(p => p.id),
        };
        const { data, width, height } = target.segInput!;
        const recolored = transferColors(
          data, width, height,
          targetResult,
          source.segInput!.data, sourceResult,
          correspondence,
          { strength, relax, preserveLuminance, richness, anchors: transferAnchors },
        );
        if (!cancelled) {
          setTransferUrl(rgbaToPngDataUrl(recolored, width, height));
          setTransferError(null);
        }
      } catch (e: any) {
        if (!cancelled) {
          setTransferUrl(null);
          setTransferError(e?.message ?? String(e));
        }
      }
    }, 16);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [hasApplied, source.segInput, sourceResult, targetResult, target.segInput, matches, strength, relax, preserveLuminance, richness, transferAnchors]);

  // ── Remap interaction ──────────────────────────────────────────────
  // Reassign a target pool's donor (from a row's inline source-pool picker).
  const assignDonorTo = (targetPoolId: number, sourcePoolId: number) => {
    setMatches(prev => prev.map(m =>
      m.targetPoolId === targetPoolId
        ? { ...m, sourcePoolId, score: NaN } // score no longer meaningful after a manual edit
        : m,
    ));
  };

  const resetToAuto = () => {
    setMatches(autoMatches.map(m => ({ ...m })));
    setSelectedTargetId(null);
  };

  // ── Focal anchor click handlers ──
  // Source-map click: load (or replace) the sticky activeSource at the click
  // site. We just store the point — no single source pool id is captured;
  // the mini-Smash inside the anchor's falloff analyses whatever local source
  // structure is around that click. Transparent pixels are still rejected so
  // the source point is always inside the figure.
  const handleAnchorSourceClick = useCallback((nx: number, ny: number) => {
    if (!sourceResult) return;
    const sx = Math.min(
      sourceResult.width - 1,
      Math.max(0, Math.floor(nx * sourceResult.width)),
    );
    const sy = Math.min(
      sourceResult.height - 1,
      Math.max(0, Math.floor(ny * sourceResult.height)),
    );
    const poolId = sourceResult.labels[sy * sourceResult.width + sx];
    if (poolId < 0) return; // clicked a transparent / unlabeled pixel
    setActiveSource({ nx, ny });
  }, [sourceResult]);
  // Target-map click: drop a new anchor using the sticky activeSource. The
  // activeSource is NOT cleared — subsequent target clicks spawn more anchors
  // all sharing the same source point.
  const handleAnchorTargetClick = useCallback((nx: number, ny: number) => {
    if (!targetResult) return;
    if (!activeSource) return; // no source loaded yet — hint shown in the UI
    const pair: AnchorPair = {
      sourceX: activeSource.nx,
      sourceY: activeSource.ny,
      targetX: nx,
      targetY: ny,
      // Snapshot the current "new-anchor radius" into BOTH the source and
      // target radii — they start equal and are re-tuned per-anchor via the
      // row sliders. Correlation knobs start at the full-transfer defaults.
      sourceRadius: anchorRadius,
      targetRadius: anchorRadius,
      strength: 1,
      transferValue: true,
      transferChroma: true,
      transferHue: true,
    };
    setAnchors(prev => [...prev, pair]);
    // activeSource intentionally NOT cleared — sticky source persists.
  }, [targetResult, activeSource, anchorRadius]);
  const clearAllAnchors = () => {
    setAnchors([]);
    setActiveSource(null);
  };
  const removeAnchor = useCallback((index: number) => {
    setAnchors(prev => prev.filter((_, i) => i !== index));
  }, []);
  const clearActiveSource = useCallback(() => {
    setActiveSource(null);
  }, []);
  // Mutate a single anchor's field (driven by the per-row controls). Generic
  // patch keeps the six per-anchor knobs (two radii, strength, three locks)
  // from each needing its own near-identical setter.
  const patchAnchorAt = (index: number, patch: Partial<AnchorPair>) => {
    setAnchors(prev => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  // ── Drag handlers — repositioning existing anchor dots / activeSource ──
  // Anchors no longer carry a single source pool id; we still reject drops
  // onto transparent pixels so the source point stays inside the figure (the
  // mini-Smash needs source pixels to analyse).
  const moveAnchorSource = useCallback((index: number, nx: number, ny: number): boolean => {
    if (!sourceResult) return false;
    const sx = Math.min(
      sourceResult.width - 1,
      Math.max(0, Math.floor(nx * sourceResult.width)),
    );
    const sy = Math.min(
      sourceResult.height - 1,
      Math.max(0, Math.floor(ny * sourceResult.height)),
    );
    const poolId = sourceResult.labels[sy * sourceResult.width + sx];
    if (poolId < 0) return false;
    setAnchors(prev => prev.map((a, i) =>
      i === index ? { ...a, sourceX: nx, sourceY: ny } : a,
    ));
    return true;
  }, [sourceResult]);
  const moveAnchorTarget = useCallback((index: number, nx: number, ny: number): boolean => {
    if (!targetResult) return false;
    setAnchors(prev => prev.map((a, i) =>
      i === index ? { ...a, targetX: nx, targetY: ny } : a,
    ));
    return true;
  }, [targetResult]);
  const moveActiveSource = useCallback((nx: number, ny: number): boolean => {
    if (!sourceResult) return false;
    const sx = Math.min(
      sourceResult.width - 1,
      Math.max(0, Math.floor(nx * sourceResult.width)),
    );
    const sy = Math.min(
      sourceResult.height - 1,
      Math.max(0, Math.floor(ny * sourceResult.height)),
    );
    const poolId = sourceResult.labels[sy * sourceResult.width + sx];
    if (poolId < 0) return false;
    setActiveSource({ nx, ny });
    return true;
  }, [sourceResult]);

  // First press starts the live preview; the effect above keeps it current
  // from then on, so every control change is reflected automatically.
  const applySmash = () => {
    if (!sourceResult || !targetResult || !target.segInput || matches.length === 0) return;
    setHasApplied(true);
    setShowAfter(true);
  };

  // Run the transfer at the TARGET document's real resolution and write the
  // recolored pixels back as a new "Color Smash" layer.
  //
  // The in-panel preview works at SEGMENT_MAX_EDGE; to produce a usable result
  // we re-read the target layer at full resolution, upscale the pool-label map
  // to match (nearest-neighbour), and re-run transferColors at that size. The
  // pools/correspondence themselves are resolution-independent. A full-res
  // transfer + write can take a couple of seconds — the button disables while
  // it runs.
  const outputToDocument = async () => {
    if (outputting) return;
    if (!sourceResult || !targetResult || matches.length === 0) return;
    if (target.docId == null || target.layerId == null) return;

    setOutputting(true);
    setOutputError(null);
    try {
      // Read the target layer's pixels at full resolution (no downsample).
      const fullBuf = await executeAsModal("Color Smash output", async () => {
        const doc = (app.documents ?? []).find((d: any) => d.id === target.docId);
        if (!doc) throw new Error("Target document not found.");
        const layer = findLayerById(doc.layers, target.layerId!);
        if (!layer) throw new Error(`Target layer ${target.layerId} not found.`);
        return await readLayerPixels(layer, undefined, doc.id);
      });

      const fullW = fullBuf.width;
      const fullH = fullBuf.height;

      // Project the segmentation label map up to the real resolution.
      const fullLabels = vectorizeUpscaleLabels(
        targetResult.labels, targetResult.width, targetResult.height,
        fullW, fullH,
      );
      const fullResult: SegmentResult = {
        width: fullW, height: fullH,
        labels: fullLabels, pools: targetResult.pools,
      };

      // Rebuild the correspondence exactly as the live-preview effect does.
      const usedSourceIds = new Set(matches.map(m => m.sourcePoolId));
      const correspondence: Correspondence = {
        matches: matches.map(m => ({ ...m })),
        unmatchedSourceIds: sourceResult.pools
          .filter(p => !usedSourceIds.has(p.id))
          .map(p => p.id),
      };

      const recolored = transferColors(
        fullBuf.data, fullW, fullH,
        fullResult,
        source.segInput!.data, sourceResult,
        correspondence,
        { strength, relax, preserveLuminance, richness, anchors: transferAnchors },
      );

      // Place the result(s) over the target layer's region, not at (0,0).
      // `outputMode` decides whether we write the single recolored layer, a
      // per-pool group, or both. "group" alone deliberately SKIPS the single
      // layer — the brief is "instead of" not "alongside", and a stray
      // recolored layer underneath the editable group would just be redundant.
      // Use the user-configured base name (trimmed, with a fallback so a blank
      // input never produces a "" layer name in Photoshop).
      const baseName = outputName.trim() || DEFAULT_PREFS.outputName;
      if (outputMode === "single" || outputMode === "both") {
        await writePixelLayer(
          target.docId, baseName, recolored, fullW, fullH,
          fullBuf.bounds.left, fullBuf.bounds.top,
        );
      }
      if (outputMode === "group" || outputMode === "both") {
        // Build one PoolLayerData per TOP-LEVEL pool: copy the recolored
        // pixels where `fullLabels[i] === pool.id`, leave everything else
        // transparent. Pools come weight-desc, but UXP creates layers
        // top-down — so reverse the array so the LARGEST pool ends up at
        // the BOTTOM of the group and smaller, more specific pools overlay
        // it. Intent: the dominant swatch is the base layer; targeted
        // pools sit on top, easy to mask / re-color individually.
        const pixelCount = fullW * fullH;
        const poolLayers: PoolLayerData[] = [];
        for (const pool of fullResult.pools) {
          const rgba = new Uint8Array(pixelCount * 4); // zero-init = transparent
          for (let i = 0; i < pixelCount; i++) {
            if (fullLabels[i] === pool.id) {
              const o = i * 4;
              rgba[o]     = recolored[o];
              rgba[o + 1] = recolored[o + 1];
              rgba[o + 2] = recolored[o + 2];
              rgba[o + 3] = recolored[o + 3];
            }
          }
          const weightPct = (pool.descriptor.weight * 100).toFixed(1);
          poolLayers.push({
            poolId: pool.id,
            name: `Pool ${pool.id} · ${weightPct}%`,
            rgba,
          });
        }
        // Reverse so largest (already first) ends up created LAST → BOTTOM.
        poolLayers.reverse();
        await writePoolGroupLayers(
          target.docId, `${baseName} · pools`, poolLayers,
          fullW, fullH, fullBuf.bounds.left, fullBuf.bounds.top,
        );
      }
    } catch (e: any) {
      setOutputError(e?.message ?? String(e));
    } finally {
      setOutputting(false);
    }
  };

  // Whether the current matches differ from the auto result (enables Reset).
  const isEdited = useMemo(() => {
    if (matches.length !== autoMatches.length) return true;
    const auto = new Map(autoMatches.map(m => [m.targetPoolId, m.sourcePoolId]));
    return matches.some(m => auto.get(m.targetPoolId) !== m.sourcePoolId);
  }, [matches, autoMatches]);

  const sel = matchStyles.sel;
  const ready = !!sourceResult && !!targetResult;
  // "Output to document" is available once both images are segmented, a
  // correspondence exists, the target layer is known, and no write is running.
  const canOutput = !outputting
    && !!sourceResult && !!targetResult
    && matches.length > 0
    && target.docId != null && target.layerId != null;

  // Target pools sorted heaviest-first for the correspondence list.
  const targetPools = targetResult?.pools ?? [];
  const sourcePools = sourceResult?.pools ?? [];
  // Display-sorted target pools — re-orders only the visible list.
  const sortedTargetPools = useMemo(
    () => sortPools(targetPools, sortMode),
    [targetPools, sortMode],
  );

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_HEADER}>SMASH — POOL CORRESPONDENCE</div>

      {/* ── Recipes: save / load global settings (no per-image data) ── */}
      <Section title="RECIPES" defaultOpen={false}>
        <SmashRecipes
          current={{
            segmentation: {
              poolCount, edgePreservation, regionCleanup,
              colorVsValueBias, neutralProtection, subPaletteSize,
              poolContinuity,
            },
            transfer: { strength, relax, preserveLuminance, richness },
          }}
          onApply={(s) => {
            setPoolCount(s.segmentation.poolCount);
            setEdgePreservation(s.segmentation.edgePreservation);
            setRegionCleanup(s.segmentation.regionCleanup);
            setColorVsValueBias(s.segmentation.colorVsValueBias);
            setNeutralProtection(s.segmentation.neutralProtection);
            setSubPaletteSize(s.segmentation.subPaletteSize);
            // Optional fields — default to 0 when loading a recipe that
            // pre-dates these controls.
            setPoolContinuity(s.segmentation.poolContinuity ?? 0);
            setStrength(s.transfer.strength);
            setRelax(s.transfer.relax);
            setPreserveLuminance(s.transfer.preserveLuminance);
            setRichness(s.transfer.richness ?? 0);
          }}
        />
      </Section>

      {/* ── Inputs: source + target layer pickers only. The segmentation
            controls that used to live here moved into the Controls tab so the
            preview can stay anchored higher up. ── */}
      <Section title="INPUTS">
        <div style={SUB_HEADER}>SOURCE</div>
        <SourceSelector {...selectorProps(source)} selStyle={sel} />

        <div style={SUB_HEADER}>TARGET</div>
        <SourceSelector {...selectorProps(target)} selStyle={sel} />
      </Section>

      {/* ── Persistent preview area: pool maps + before/after preview. Always
            visible — this is the whole point of the layout. The tab strip
            below switches the control surfaces without ever pushing this
            off-screen. ── */}
      <div style={SECTION_HEADER}>PREVIEW / POOL MAPS</div>

      {/* Pool maps (source left, target right) */}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PoolMapPane
            label="Source"
            url={sourceMapUrl}
            display={sourceMapDisplay}
            analyzing={analyzing}
            placeholder={source.snapError ?? "Pick a source layer."}
            onPlaceNormalized={sourceResult ? handleAnchorSourceClick : undefined}
            anchorDots={sourceAnchorDots}
            onMoveAnchor={moveAnchorSource}
            onMoveActiveSource={moveActiveSource}
            onRemoveAnchor={removeAnchor}
            onRemoveActiveSource={clearActiveSource}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PoolMapPane
            label={showDonorTint ? "Target — donor tint" : "Target"}
            url={targetMapUrl}
            display={targetMapDisplay}
            analyzing={analyzing}
            placeholder={target.snapError ?? "Pick a target layer."}
            onPlaceNormalized={targetResult ? handleAnchorTargetClick : undefined}
            anchorDots={targetAnchorDots}
            onMoveAnchor={moveAnchorTarget}
            onRemoveAnchor={removeAnchor}
          />
        </div>
      </div>

      {/* Before/after recolored preview pane — relocated up here from the
          COLOR TRANSFER section so it stays visible regardless of which tab
          is active. Its show-before/after toggle lives with the transfer
          controls in the Controls tab; the toggle + label logic stay wired to
          the same showAfter / transferUrl / beforeUrl state. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 9, color: "#999", letterSpacing: 0.3 }}>
          {transferUrl
            ? (showAfter ? "After — recolored target" : "Before — original target")
            : "Preview"}
        </span>
        <div style={{
          position: "relative", alignSelf: "center",
          width: targetDisplay.w || PANEL_WIDTH, minHeight: 60,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#1f1f1f", border: "1px solid #3a3a3a", borderRadius: 2,
        }}>
          {transferUrl ? (
            <img
              src={(showAfter ? transferUrl : beforeUrl) ?? undefined}
              style={{
                width: targetDisplay.w, height: targetDisplay.h,
                imageRendering: "pixelated", display: "block",
              }}
            />
          ) : (
            <div style={{ padding: 24, fontSize: 10, opacity: 0.5 }}>
              Click “Apply Smash” to preview the recolored target.
            </div>
          )}
        </div>
      </div>

      {segError && (
        <div style={{ fontSize: 10, color: "#d8867d" }}>Segmentation failed: {segError}</div>
      )}

      {/* ── Tab strip: switch between the Controls surface (segmentation +
            transfer) and the Correspondence surface (list + focal anchors).
            Styled distinctly from the Section chips so it reads as a tab
            control, not another collapsible. ── */}
      <div style={{ display: "flex", gap: 4 }}>
        {([
          { id: "controls" as const, label: "Controls" },
          { id: "correspondence" as const, label: "Correspondence" },
        ]).map(t => {
          const active = innerTab === t.id;
          return (
            <div
              key={t.id}
              onClick={() => setInnerTab(t.id)}
              style={{
                flex: 1, textAlign: "center",
                padding: "5px 8px", fontSize: 11, fontWeight: 600,
                letterSpacing: 0.3, borderRadius: 3,
                border: `1px solid ${active ? "#1473e6" : "#444"}`,
                background: active ? "#1473e6" : "#2c2c2c",
                color: active ? "#ffffff" : "#aaaaaa",
                cursor: "pointer", userSelect: "none",
              }}
            >
              {t.label}
            </div>
          );
        })}
      </div>

      {/* ── Controls tab: segmentation sliders (usable always — they drive the
            segmentation that happens before `ready`) plus the color-transfer
            controls (gated on `ready`). ── */}
      {innerTab === "controls" && (
        <Section title="CONTROLS">
          <div style={SUB_HEADER}>SEGMENTATION</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
            <Control
              label="Pool count"
              title="Number of color pools to segment each image into."
              min={2} max={12} step={1}
              value={poolCount} onChange={setPoolCount}
              display={String(poolCount)}
            />
            <Control
              label="Edge preservation"
              title="Higher keeps more pool boundaries — refuses to merge regions across strong color edges."
              min={0} max={1} step={0.05}
              value={edgePreservation} onChange={setEdgePreservation}
              display={edgePreservation.toFixed(2)}
            />
            <Control
              label="Region cleanup"
              title="Higher absorbs more small speckled regions into their neighbours for simpler shapes."
              min={0} max={1} step={0.05}
              value={regionCleanup} onChange={setRegionCleanup}
              display={regionCleanup.toFixed(2)}
            />
            <Control
              label="Neutral protection"
              title="Higher refuses merges across strong chroma steps — defends low-chroma neighbours (gray shadows) from swallowing chromatic regions."
              min={0} max={1} step={0.05}
              value={neutralProtection} onChange={setNeutralProtection}
              display={neutralProtection.toFixed(2)}
            />
            <Control
              label="Pool continuity"
              title="Color-range unification pass: clusters whose mean Lab distance falls below the threshold get merged into a single pool. Restores colour continuity for regions split by an intervening colour (e.g. a dress under a sash). 0 = no unification."
              min={0} max={1} step={0.05}
              value={poolContinuity} onChange={setPoolContinuity}
              display={poolContinuity.toFixed(2)}
            />
            <Control
              label="Color vs Value"
              title="0 = chroma/hue identity dominates (skin shadow and shirt shadow stay separate by color). 0.5 = balanced. 1 = value/lightness dominates (classic luminance-driven cutout)."
              min={0} max={1} step={0.05}
              value={colorVsValueBias} onChange={setColorVsValueBias}
              display={colorVsValueBias.toFixed(2)}
            />
            <Control
              label="Sub-palette size"
              title="Number of swatches sampled within each pool."
              min={3} max={7} step={1}
              value={subPaletteSize} onChange={setSubPaletteSize}
              display={String(subPaletteSize)}
            />
            <Control
              label="Fidelity"
              title="Working resolution for the segmentation. Higher = finer islands and crisper boundaries, but slower to re-segment. Default 256."
              min={256} max={512} step={64}
              value={segmentMaxEdge} onChange={setSegmentMaxEdge}
              display={String(segmentMaxEdge)}
            />
          </div>

          {/* Color transfer controls (minus the preview pane, which moved to
              the persistent area above). Gated on `ready` like the original
              COLOR TRANSFER section was. */}
          <div style={SUB_HEADER}>COLOR TRANSFER</div>
          {ready ? (
            <>
              <Control
                label="Strength"
                title="Transfer blend amount. 0 = target unchanged, 1 = full donor recolor."
                min={0} max={1} step={0.05}
                value={strength} onChange={setStrength}
                display={strength.toFixed(2)}
              />
              <Control
                label="Relax"
                title="Softens pool boundaries so the recolor blends instead of looking cutout."
                min={0} max={1} step={0.05}
                value={relax} onChange={setRelax}
                display={relax.toFixed(2)}
              />
              <Control
                label="Preserve detail"
                title="Keeps the target's original lightness/form; only color is transferred."
                min={0} max={1} step={0.05}
                value={preserveLuminance} onChange={setPreserveLuminance}
                display={preserveLuminance.toFixed(2)}
              />
              <Control
                label="Source richness"
                title="0 = simplified sub-swatch transfer (today's behaviour). 1 = pull the donor pool's actual source pixel colours through via lightness-rank matching, so the source's full chroma variation comes through instead of just a few averages."
                min={0} max={1} step={0.05}
                value={richness} onChange={setRichness}
                display={richness.toFixed(2)}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  onClick={applySmash}
                  title="Recolor the target using the current correspondence. After the first apply the preview updates live."
                  style={{
                    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 2,
                    border: "1px solid #1473e6",
                    background: "#1473e6", color: "#ffffff",
                    cursor: "pointer", userSelect: "none",
                  }}
                >
                  Apply Smash
                </div>
                {transferUrl && (
                  <div
                    onClick={() => setShowAfter(s => !s)}
                    title="Swap the preview between the original target and the recolored result."
                    style={{
                      padding: "5px 10px", fontSize: 10, borderRadius: 2,
                      border: "1px solid #4a4a4a", background: "#3a3a3a",
                      color: "#cccccc", cursor: "pointer", userSelect: "none",
                    }}
                  >
                    {showAfter ? "Show before" : "Show after"}
                  </div>
                )}
                {hasApplied && (
                  <span style={{ fontSize: 9, color: "#7dd87d" }}
                    title="Preview updates automatically as you change controls.">
                    live
                  </span>
                )}
              </div>

              {/* Output name — base name applied to the written single layer
                  ("<name>") and / or pool group ("<name> · pools"). Persisted
                  via core/prefs so it survives panel reloads, and mirrored
                  into the photoshop service's GROUP_NAME so any in-session
                  callsite reading that picks up the user's choice. Saves on
                  blur to avoid thrashing localStorage on every keystroke. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#cccccc" }}>Output name:</span>
                <input
                  type="text"
                  value={outputName}
                  onChange={(e) => setOutputName(e.target.value)}
                  onBlur={() => {
                    const trimmed = outputName.trim() || DEFAULT_PREFS.outputName;
                    if (trimmed !== outputName) setOutputName(trimmed);
                    savePrefs({ outputName: trimmed });
                    setGroupName(trimmed);
                  }}
                  title="Base name for the written layer / group. The pool-group variant appends ' · pools'."
                  style={{
                    flex: 1, fontSize: 10,
                    padding: "3px 6px",
                    background: "#1f1f1f", color: "#cccccc",
                    border: "1px solid #4a4a4a", borderRadius: 2,
                    outline: "none",
                  }}
                />
              </div>

              {/* Output the smashed result back into the target document at its
                  full resolution. The dropdown next to the button selects
                  between a single recolored layer (today's behaviour), a
                  per-pool layer group (each pool becomes a hand-editable
                  transparent layer inside one group), or both. Custom
                  Dropdown — see Dropdown.tsx for why we avoid native <select>
                  in the panel. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  onClick={canOutput ? outputToDocument : undefined}
                  title="Run the transfer at the target document's full resolution and add the result as a new layer (or per-pool group, depending on the mode picker)."
                  style={{
                    padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 2,
                    border: "1px solid #4a4a4a",
                    background: canOutput ? "#3a3a3a" : "#2a2a2a",
                    color: canOutput ? "#cccccc" : "#666666",
                    cursor: canOutput ? "pointer" : "default", userSelect: "none",
                  }}
                >
                  {outputting ? "Working…" : "Output to document"}
                </div>
                <Dropdown<OutputMode>
                  value={outputMode}
                  onChange={setOutputMode}
                  title="What 'Output to document' writes. Single = one recolored layer. Pool group = one transparent layer per pool, wrapped in a group (hand-editable region by region). Both = single layer plus the group."
                  style={{ minWidth: 130 }}
                  options={[
                    { value: "single", label: "Single layer" },
                    { value: "group",  label: "Pool group" },
                    { value: "both",   label: "Both" },
                  ]}
                />
              </div>

              {transferError && (
                <div style={{ fontSize: 10, color: "#d8867d" }}>
                  Transfer failed: {transferError}
                </div>
              )}

              {outputError && (
                <div style={{ fontSize: 10, color: "#d8867d" }}>
                  Output failed: {outputError}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 10, color: "#9a9aa8" }}>
              Pick a source and target layer to begin.
            </div>
          )}
        </Section>
      )}

      {/* ── Correspondence tab: target→source list with sort + scroll, plus
            the focal-anchors subsection. Gated on `ready`. ── */}
      {innerTab === "correspondence" && (
        ready ? (
          <Section title="CORRESPONDENCE">
            {/* Donor-preview toggle + sort selector + reset */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer" }}
                title="Tint the target pool map by each region's matched source color — a preview of which donor goes where.">
                <input type="checkbox" checked={donorPreview}
                  onChange={e => setDonorPreview(e.target.checked)}
                  style={{ cursor: "pointer", margin: 0 }} />
                Donor preview
              </label>
              <div style={{ flex: 1 }} />
              {/* Custom (non-native) dropdown — UXP's native <select> popovers
                  interfere with each other across the panel (the open list of
                  one shows up next to another's value). This one is divs only,
                  so SourceSelector's native selects stay clean. */}
              <Dropdown<SortMode>
                value={sortMode}
                onChange={setSortMode}
                title="Reorder the target → source list for easier scanning. Display-only — doesn't change the mapping."
                style={{ minWidth: 130 }}
                options={[
                  { value: "weightDesc",   label: "Sort: largest first" },
                  { value: "weightAsc",    label: "Sort: smallest first" },
                  { value: "lightToDark",  label: "Sort: light → dark" },
                  { value: "darkToLight",  label: "Sort: dark → light" },
                  { value: "warmToCool",   label: "Sort: warm → cool" },
                  { value: "coolToWarm",   label: "Sort: cool → warm" },
                ]}
              />
              <div
                onClick={isEdited ? resetToAuto : undefined}
                title="Restore the automatic correspondence."
                style={{
                  padding: "3px 8px", fontSize: 10, borderRadius: 2,
                  border: "1px solid #4a4a4a",
                  background: isEdited ? "#3a3a3a" : "#2a2a2a",
                  color: isEdited ? "#cccccc" : "#666666",
                  cursor: isEdited ? "pointer" : "default", userSelect: "none",
                }}
              >
                Reset to auto
              </div>
            </div>

            {/* ── Focal anchors (list of pairs) ──
                Drop pairs by clicking the SOURCE map then the TARGET map. Each
                completed anchor pulls pixels inside its target falloff toward
                the source pool picked at click time. Multiple anchors blend
                additively; overlapping anchors are renormalized to sum 1. */}
            <div style={SUB_HEADER}>FOCAL ANCHORS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontSize: 10,
                  color: activeSource
                    ? "#d8c87d"
                    : anchors.length > 0
                      ? "#7dd87d"
                      : "#9a9aa8",
                }}>
                  {activeSource
                    ? anchors.length === 0
                      ? "Active source ready — click TARGET to drop an anchor (source stays loaded)."
                      : `Active source ready — click TARGET to drop another anchor (${anchors.length} so far). Drag dots to reposition · × to remove.`
                    : anchors.length === 0
                      ? "0 anchors — click the SOURCE map to start one."
                      : anchors.length === 1
                        ? "1 anchor active — click SOURCE to load another. Drag dots to reposition · × to remove."
                        : `${anchors.length} anchors active — click SOURCE to load another. Drag dots to reposition · × to remove.`}
                </span>
                <div style={{ flex: 1 }} />
                {(anchors.length > 0 || activeSource) && (
                  <div
                    onClick={clearAllAnchors}
                    title="Remove every focal anchor and clear the active source."
                    style={{
                      padding: "3px 8px", fontSize: 10, borderRadius: 2,
                      border: "1px solid #4a4a4a", background: "#3a3a3a",
                      color: "#cccccc", cursor: "pointer", userSelect: "none",
                    }}
                  >
                    Clear all
                  </div>
                )}
              </div>
              {/* Always-visible anchor config. "New-anchor radius" only seeds
                  NEW anchors; existing anchors keep their per-row radius. Both
                  knobs are useful BEFORE any anchor is placed (set defaults),
                  so we don't gate them on anchors.length / activeSource. */}
              <Control
                label="New-anchor radius"
                title="Default falloff radius applied to NEWLY-created anchors only. Existing anchors keep their own radius — tune each one individually with its row slider below."
                min={0.05} max={0.6} step={0.025}
                value={anchorRadius} onChange={setAnchorRadius}
                display={anchorRadius.toFixed(2)}
              />
              <Control
                label="Anchor detail"
                title="How densely the mini-Smash inside each anchor analyses local colour structure. Higher = more sub-pools inside the anchor's region = richer local transfer."
                min={0} max={1} step={0.05}
                value={anchorDetail} onChange={setAnchorDetail}
                display={anchorDetail.toFixed(2)}
              />
              {anchorAnalyzing && (
                <span style={{ fontSize: 9, color: "#9a9aa8" }}>analyzing anchors…</span>
              )}
              {anchors.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {anchors.map((a, i) => {
                    const color = colorForAnchor(i);
                    const analysis = anchorAnalyses[i];
                    const localPoolCount = analysis?.localMappingsByPool.size ?? 0;
                    const expanded = expandedAnchor === i;
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex", flexDirection: "column", gap: 3,
                          padding: "3px 6px",
                          background: "#1f1f1f",
                          border: "1px solid #3a3a3a",
                          borderRadius: 2,
                        }}
                      >
                        {/* Summary row — chevron + colour chip + label +
                            local-pool count + remove. Click anywhere on the row
                            (except ×) toggles this anchor's expansion. Single-
                            accordion: expanding one collapses any other. */}
                        <div
                          onClick={() => setExpandedAnchor(prev => (prev === i ? null : i))}
                          title={expanded ? "Collapse this anchor's controls." : "Expand to tune this anchor's radii, strength and channel locks."}
                          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}
                        >
                          <span style={{ fontSize: 9, color: "#777", width: 8, flexShrink: 0 }}>
                            {expanded ? "▾" : "▸"}
                          </span>
                          <div style={{
                            width: 12, height: 12, borderRadius: "50%",
                            background: color, border: "1px solid #000",
                            flexShrink: 0,
                          }} title={`anchor ${i + 1}`} />
                          <span style={{ fontSize: 10, color: "#cccccc" }}>
                            anchor {i + 1}
                          </span>
                          <span
                            style={{ fontSize: 9, color: "#777" }}
                            title="Number of local target pools the mini-Smash inside this anchor produced."
                          >
                            {localPoolCount > 0 ? `${localPoolCount} local pools` : "—"}
                          </span>
                          <div style={{ flex: 1 }} />
                          <div
                            onClick={e => { e.stopPropagation(); removeAnchor(i); }}
                            title="Remove this anchor."
                            style={{
                              padding: "1px 6px", fontSize: 11, lineHeight: "12px",
                              borderRadius: 2,
                              border: "1px solid #4a4a4a", background: "#3a3a3a",
                              color: "#cccccc", cursor: "pointer", userSelect: "none",
                            }}
                          >
                            ×
                          </div>
                        </div>

                        {/* Expanded controls — the full per-anchor knob set.
                            Source/target radii, strength, then the three LCh
                            transfer locks. Only the expanded anchor shows them. */}
                        {expanded && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 2 }}>
                            <AnchorSlider
                              label="Source radius"
                              title="Size of the SOURCE sample circle — how much source colour structure this anchor's mini-Smash pulls in."
                              min={0.05} max={0.6} step={0.025}
                              value={a.sourceRadius}
                              onChange={v => patchAnchorAt(i, { sourceRadius: v })}
                            />
                            <AnchorSlider
                              label="Target radius"
                              title="Size of the TARGET apply circle — how far this anchor's transfer reaches before fading back to the auto donor."
                              min={0.05} max={0.6} step={0.025}
                              value={a.targetRadius}
                              onChange={v => patchAnchorAt(i, { targetRadius: v })}
                            />
                            <AnchorSlider
                              label="Strength"
                              title="How much this anchor replaces the auto transfer, independent of radius. 1 = full replace at the centre; 0.5 = half-replace even at the centre."
                              min={0} max={1} step={0.05}
                              value={a.strength}
                              onChange={v => patchAnchorAt(i, { strength: v })}
                            />
                            {/* Channel locks — which LCh dimensions this anchor
                                moves toward the source. */}
                            <div
                              style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                              title="Which colour dimensions this anchor transfers. Unchecking one keeps the target's own value for that dimension (e.g. Hue only = rotate hue toward the source, keep the target's lightness and chroma)."
                            >
                              <AnchorCheckbox
                                label="Value"
                                checked={a.transferValue}
                                onChange={c => patchAnchorAt(i, { transferValue: c })}
                              />
                              <AnchorCheckbox
                                label="Chroma"
                                checked={a.transferChroma}
                                onChange={c => patchAnchorAt(i, { transferChroma: c })}
                              />
                              <AnchorCheckbox
                                label="Hue"
                                checked={a.transferHue}
                                onChange={c => patchAnchorAt(i, { transferHue: c })}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Correspondence list — scrollable, capped height. Hover a row
                to locate its region in the target map; click to open its
                inline source-pool picker. */}
            <div style={SUB_HEADER}>TARGET → SOURCE — hover to locate · click to remap</div>
            <div style={{
              display: "flex", flexDirection: "column", gap: 4,
              maxHeight: 360, overflowY: "auto", paddingRight: 2,
            }}>
              {sortedTargetPools.map(tp => {
                const match = matchByTargetId.get(tp.id);
                const donor = match ? sourcePoolsById.get(match.sourcePoolId) : undefined;
                const selected = selectedTargetId === tp.id;
                return (
                  <CorrespondenceRow
                    key={tp.id}
                    targetPool={tp}
                    donorPool={donor}
                    score={match?.score}
                    selected={selected}
                    sourcePools={sourcePools}
                    onSelect={() => setSelectedTargetId(selected ? null : tp.id)}
                    onAssign={sid => assignDonorTo(tp.id, sid)}
                    onHoverTarget={setHoveredTargetId}
                    onHoverSource={setHoveredSourceId}
                  />
                );
              })}
            </div>
          </Section>
        ) : (
          <div style={{ fontSize: 10, color: "#9a9aa8" }}>
            Pick a source and target layer to begin.
          </div>
        )
      )}
    </div>
  );
}

// ── Map a useImagePicker bundle onto SourceSelector's prop surface ────
// SmashTab is layer-only; the selection/folder props are stubbed exactly as
// AnalysisTab does.
function selectorProps(p: ReturnType<typeof useImagePicker>) {
  return {
    docs: p.docs,
    activeDocId: p.docId,
    srcMode: "layer" as SrcMode,
    browsedFile: "",
    onSwitchDoc: p.setDocId,
    onSwitchSrcMode: () => { /* layer-only */ },
    setBrowsedFile: () => { /* unused */ },
    onBrowseImage: () => { /* unused */ },
    layers: p.layers,
    sourceId: p.layerId,
    setSourceId: p.setLayerId,
    autoUpdate: false,
    setAutoUpdate: () => { /* unused */ },
    sampleMerged: false,
    setSampleMerged: () => { /* unused */ },
    sampleLock: false,
    setSampleLock: () => { /* unused */ },
    onRefreshLayers: p.refreshLayers,
    docsKey: p.docsKey,
    layersKey: p.layersKey,
  };
}

// Display size: scale a segmented image to fit a width budget, no upscaling.
function useDisplaySize(result: SegmentResult | null, maxWidth = PANEL_WIDTH): { w: number; h: number } {
  return useMemo(() => {
    if (!result) return { w: 0, h: 0 };
    const scale = Math.min(1, maxWidth / result.width);
    return { w: Math.round(result.width * scale), h: Math.round(result.height * scale) };
  }, [result, maxWidth]);
}

// ── One pool-map image pane (label + framed image + analyzing overlay) ──
//
// Interaction model:
// - Place-new: a pointerdown on empty map area starts a "place candidate".
//   If the pointer doesn't move past PLACE_DRAG_PX before pointerup, the
//   pointerup site is treated as a click and `onPlaceNormalized` fires.
// - Drag: a pointerdown on a dot's hit area starts a drag for that dot;
//   pointermove (attached to window) calls the matching move callback, and
//   pointerup detaches and clears the drag. If a source-side drag tries to
//   land on a transparent pixel, the move callback returns false and the
//   anchor stays where it last validly was (snap-back).
// - Remove: the × badge eats its own pointer events and short-circuits to
//   the matching remove callback — never starts a drag.
//
// Movement past PLACE_DRAG_PX during a place candidate cancels the place
// (treated as a stray drag) so users don't get an unwanted anchor when they
// just shifted the cursor.
function PoolMapPane({
  label, url, display, analyzing, placeholder,
  onPlaceNormalized, anchorDots,
  onMoveAnchor, onMoveActiveSource,
  onRemoveAnchor, onRemoveActiveSource,
}: {
  label: string;
  url: string | null;
  display: { w: number; h: number };
  analyzing: boolean;
  placeholder: string;
  // Click-on-empty-area handler (true "place new" click — debounced against
  // stray drag motion).
  onPlaceNormalized?: (nx: number, ny: number) => void;
  // Anchor overlays — every dot+ring this map should render. Order is the
  // pair index, so callers control colour pairing across the two maps.
  anchorDots?: PoolMapDot[];
  // Drag the dot at anchorIndex to (nx, ny). Returns false to indicate the
  // attempt is invalid (e.g. transparent pixel) — the pane interprets that
  // as "snap back to previous valid position".
  onMoveAnchor?: (anchorIndex: number, nx: number, ny: number) => boolean;
  // Drag the activeSource dot. Same return semantics as onMoveAnchor.
  onMoveActiveSource?: (nx: number, ny: number) => boolean;
  onRemoveAnchor?: (anchorIndex: number) => void;
  onRemoveActiveSource?: () => void;
}) {
  // Hit radius (px) for grabbing a dot — slightly larger than the 8-px
  // visual for forgiving grabs.
  const DOT_HIT_RADIUS = 12;
  // Max pixel movement between pointerdown and pointerup that still counts
  // as a "click" rather than a drag (used for place-new candidates and
  // distinguishing a real drag from a jitter on dot pointerdown).
  const PLACE_DRAG_PX = 4;
  // Pointerup site for a place-new candidate must be within this many px of
  // the pointerdown site (same general area) to count as a click.
  const PLACE_TOLERANCE_PX = 6;

  // Drag state. `dragging` is null when idle. `moved` flips true once the
  // pointer has moved past PLACE_DRAG_PX from `startX`/`startY`, which both
  // suppresses the place-new on pointerup and enables visual drag boost.
  type DragState =
    | { mode: "place"; startX: number; startY: number; moved: boolean }
    | { mode: "dragAnchor"; anchorIndex: number; startX: number; startY: number; moved: boolean; lastValid: { nx: number; ny: number } }
    | { mode: "dragActive"; startX: number; startY: number; moved: boolean; lastValid: { nx: number; ny: number } };
  const [dragging, setDragging] = useState<DragState | null>(null);
  // Hovered dot index — null when none. `-1` is the special id for the
  // activeSource dot. Drives the opacity boost.
  const [hoveredDotKey, setHoveredDotKey] = useState<string | null>(null);

  const mapRef = useRef<HTMLDivElement | null>(null);

  // Convert a window-space pointer event to normalized [0,1] map coords,
  // clamped to the map rect.
  const toNormalized = useCallback((clientX: number, clientY: number): { nx: number; ny: number } | null => {
    const el = mapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { nx, ny };
  }, []);

  // Window-level pointermove/pointerup wiring — only mounted while a drag
  // (or place candidate) is in progress. Lets the cursor leave the map.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      const past = Math.hypot(dx, dy) > PLACE_DRAG_PX;

      if (dragging.mode === "place") {
        if (past && !dragging.moved) {
          // Place candidate cancelled — user dragged too far.
          setDragging({ ...dragging, moved: true });
        }
        return;
      }

      // Real drag — update the anchored point continuously.
      const norm = toNormalized(e.clientX, e.clientY);
      if (!norm) return;
      if (dragging.mode === "dragAnchor") {
        const ok = onMoveAnchor?.(dragging.anchorIndex, norm.nx, norm.ny) ?? false;
        if (ok) {
          setDragging({ ...dragging, moved: true, lastValid: norm });
        } else {
          // Invalid drop — keep the last valid position but mark moved so
          // we don't treat pointerup as a click.
          setDragging({ ...dragging, moved: true });
        }
      } else if (dragging.mode === "dragActive") {
        const ok = onMoveActiveSource?.(norm.nx, norm.ny) ?? false;
        if (ok) {
          setDragging({ ...dragging, moved: true, lastValid: norm });
        } else {
          setDragging({ ...dragging, moved: true });
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      if (dragging.mode === "place") {
        // Place-new fires only if we didn't drag away AND the up is in the
        // same area AND we're still over the map.
        if (!dragging.moved) {
          const dx = e.clientX - dragging.startX;
          const dy = e.clientY - dragging.startY;
          if (Math.hypot(dx, dy) <= PLACE_TOLERANCE_PX) {
            const norm = toNormalized(e.clientX, e.clientY);
            if (norm) onPlaceNormalized?.(norm.nx, norm.ny);
          }
        }
      } else if (dragging.mode === "dragAnchor") {
        // If the final drop was invalid (off-image, transparent), snap
        // back to the last valid position so the anchor doesn't sit on a
        // visually wrong spot. moveAnchor returns true on success, so the
        // anchor already lives at lastValid — nothing more to do.
        const norm = toNormalized(e.clientX, e.clientY);
        if (norm) {
          const ok = onMoveAnchor?.(dragging.anchorIndex, norm.nx, norm.ny) ?? false;
          if (!ok) {
            onMoveAnchor?.(dragging.anchorIndex, dragging.lastValid.nx, dragging.lastValid.ny);
          }
        }
      } else if (dragging.mode === "dragActive") {
        const norm = toNormalized(e.clientX, e.clientY);
        if (norm) {
          const ok = onMoveActiveSource?.(norm.nx, norm.ny) ?? false;
          if (!ok) {
            onMoveActiveSource?.(dragging.lastValid.nx, dragging.lastValid.ny);
          }
        }
      }
      setDragging(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, toNormalized, onPlaceNormalized, onMoveAnchor, onMoveActiveSource]);

  // Place candidate starter — pointerdown on map area NOT on a dot.
  const onMapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onPlaceNormalized) return;
    // Don't start a place candidate if the down hit a dot's interactive
    // child (badge / dot hit area) — those stopPropagation on themselves.
    setDragging({
      mode: "place", startX: e.clientX, startY: e.clientY, moved: false,
    });
  };

  // Falloff rings size by the larger displayed edge, matching radius units.
  const ringDiameterFor = (radius: number) =>
    radius * 2 * Math.max(display.w, display.h);

  // Base opacities — lower than before so stacks of anchors stay legible.
  // The ring gets an additional scale-down when many anchors are present
  // (clamped to a floor so it never disappears entirely). The dragged or
  // hovered dot is boosted back to full to make manipulation obvious.
  const dotCount = anchorDots?.length ?? 0;
  const ringStackScale = dotCount <= 2
    ? 1
    : Math.max(0.45, 1 / Math.sqrt(dotCount / 2));
  const BASE_RING_OPACITY = 0.55 * ringStackScale;
  const BASE_DOT_OPACITY = 0.85;

  const dotKey = (d: PoolMapDot) =>
    d.kind === "activeSource" ? "active" : `${d.kind}-${d.anchorIndex}`;

  const isDraggingDot = (d: PoolMapDot): boolean => {
    if (!dragging) return false;
    if (d.kind === "activeSource" && dragging.mode === "dragActive") return true;
    if (d.kind !== "activeSource" && dragging.mode === "dragAnchor"
      && dragging.anchorIndex === d.anchorIndex) return true;
    return false;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, color: "#999", letterSpacing: 0.3 }}>{label}</span>
      <div style={{
        position: "relative",
        width: "100%", minHeight: 60, boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "#1f1f1f", border: "1px solid #3a3a3a", borderRadius: 2,
      }}>
        {url && (
          <div
            ref={mapRef}
            onPointerDown={onMapPointerDown}
            style={{
              position: "relative",
              width: display.w, height: display.h,
              cursor: onPlaceNormalized
                ? (dragging?.mode === "dragAnchor" || dragging?.mode === "dragActive"
                    ? "grabbing"
                    : "crosshair")
                : "default",
              touchAction: "none",
            }}
          >
            <img
              src={url}
              style={{
                width: display.w, height: display.h,
                imageRendering: "pixelated", display: "block",
                pointerEvents: "none",
              }}
            />
            {anchorDots && anchorDots.map(d => {
              const key = dotKey(d);
              const ringDiameter = ringDiameterFor(d.radius);
              const draggingThis = isDraggingDot(d);
              const hoveredThis = hoveredDotKey === key;
              const boost = draggingThis || hoveredThis;
              const ringOpacity = boost ? 1 : BASE_RING_OPACITY;
              const dotOpacity = boost ? 1 : BASE_DOT_OPACITY;

              const canDrag = d.kind === "activeSource"
                ? !!onMoveActiveSource
                : !!onMoveAnchor;
              const canRemove = d.kind === "activeSource"
                ? !!onRemoveActiveSource
                : !!onRemoveAnchor;

              const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
                if (!canDrag) return;
                e.stopPropagation(); // suppress place-new candidate
                if (d.kind === "activeSource") {
                  setDragging({
                    mode: "dragActive",
                    startX: e.clientX, startY: e.clientY, moved: false,
                    lastValid: { nx: d.nx, ny: d.ny },
                  });
                } else {
                  setDragging({
                    mode: "dragAnchor",
                    anchorIndex: d.anchorIndex!,
                    startX: e.clientX, startY: e.clientY, moved: false,
                    lastValid: { nx: d.nx, ny: d.ny },
                  });
                }
              };

              const handleRemove = (e: React.PointerEvent<HTMLDivElement>) => {
                // Eat the event so it never starts a drag or a place-new.
                e.stopPropagation();
                e.preventDefault();
                if (d.kind === "activeSource") onRemoveActiveSource?.();
                else onRemoveAnchor?.(d.anchorIndex!);
              };

              return (
                <Fragment key={key}>
                  {/* Falloff ring — visual only, never intercepts pointer. */}
                  <div style={{
                    position: "absolute", pointerEvents: "none",
                    left: d.nx * display.w - ringDiameter / 2,
                    top: d.ny * display.h - ringDiameter / 2,
                    width: ringDiameter, height: ringDiameter,
                    borderRadius: "50%",
                    border: d.dashed
                      ? `1px dashed ${d.color}`
                      : `1px solid ${d.color}`,
                    opacity: ringOpacity,
                  }} />
                  {/* Center dot — also the drag handle (square hit area
                      slightly larger than the visible 8px). */}
                  <div
                    onPointerDown={startDrag}
                    onPointerEnter={() => setHoveredDotKey(key)}
                    onPointerLeave={() => setHoveredDotKey(k => k === key ? null : k)}
                    style={{
                      position: "absolute",
                      left: d.nx * display.w - DOT_HIT_RADIUS,
                      top: d.ny * display.h - DOT_HIT_RADIUS,
                      width: DOT_HIT_RADIUS * 2, height: DOT_HIT_RADIUS * 2,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: canDrag
                        ? (draggingThis ? "grabbing" : "grab")
                        : "default",
                    }}
                  >
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: d.color,
                      border: "1px solid #000",
                      opacity: dotOpacity,
                      pointerEvents: "none",
                    }} />
                  </div>
                  {/* × remove badge — high opacity, takes precedence over
                      the drag hit area via stopPropagation + its own offset
                      pointer-events region. */}
                  {canRemove && (
                    <div
                      onPointerDown={handleRemove}
                      title={d.kind === "activeSource"
                        ? "Clear the active source."
                        : `Remove anchor ${(d.anchorIndex ?? 0) + 1}.`}
                      style={{
                        position: "absolute",
                        // Upper-right of the dot.
                        left: d.nx * display.w + 4,
                        top: d.ny * display.h - 12,
                        width: 12, height: 12,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "#1f1f1f",
                        color: "#ffffff",
                        border: `1px solid ${d.color}`,
                        borderRadius: "50%",
                        fontSize: 10, lineHeight: "10px", fontWeight: 700,
                        cursor: "pointer",
                        userSelect: "none",
                        opacity: 0.95,
                      }}
                    >
                      ×
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
        {!url && !analyzing && (
          <div style={{ padding: 24, fontSize: 10, opacity: 0.5 }}>{placeholder}</div>
        )}
        {analyzing && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(31,31,31,0.78)", fontSize: 10, color: "#cccccc",
          }}>
            analyzing…
          </div>
        )}
      </div>
    </div>
  );
}

// ── One correspondence row — a target pool, its donor, and (when selected)
// an inline source-pool picker. Hovering the row highlights the target
// region in the pool map; hovering a picker swatch highlights the source. ──
function CorrespondenceRow({
  targetPool, donorPool, score, selected, sourcePools,
  onSelect, onAssign, onHoverTarget, onHoverSource,
}: {
  targetPool: Pool;
  donorPool: Pool | undefined;
  score: number | undefined;
  selected: boolean;
  sourcePools: Pool[];
  onSelect: () => void;
  onAssign: (sourcePoolId: number) => void;
  onHoverTarget: (id: number | null) => void;
  onHoverSource: (id: number | null) => void;
}) {
  const t = targetPool.descriptor;
  const targetColor = `rgb(${t.r}, ${t.g}, ${t.b})`;
  const donorColor = donorPool
    ? `rgb(${donorPool.descriptor.r}, ${donorPool.descriptor.g}, ${donorPool.descriptor.b})`
    : "#2a2a2a";

  return (
    <div
      onMouseEnter={() => onHoverTarget(targetPool.id)}
      onMouseLeave={() => onHoverTarget(null)}
      style={{
        display: "flex", flexDirection: "column", gap: 4,
        background: selected ? "#22364f" : "#1f1f1f",
        border: `1px solid ${selected ? "#1473e6" : "#3a3a3a"}`,
        borderRadius: 2,
      }}
    >
      {/* Main row — click to open/close the inline picker */}
      <div
        onClick={onSelect}
        title={selected ? "Click to collapse." : "Hover highlights this region in the target map. Click to pick a donor."}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 6px", cursor: "pointer", userSelect: "none",
        }}
      >
        {/* Target pool swatch */}
        <div style={{
          width: 24, height: 24, flexShrink: 0, borderRadius: 2,
          background: targetColor, border: "1px solid #555",
        }} title={`target pool ${targetPool.id} · ${targetColor}`} />

        {/* Target descriptor — weight % + value band */}
        <div style={{ display: "flex", flexDirection: "column", gap: 1, width: 58, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{(t.weight * 100).toFixed(1)}%</span>
          <span style={{ fontSize: 9, color: "#9a9aa8" }}>{t.valueBand}</span>
        </div>

        {/* Arrow */}
        <span style={{ fontSize: 12, color: "#777", flexShrink: 0 }}>→</span>

        {/* Matched source donor swatch */}
        <div style={{
          width: 24, height: 24, flexShrink: 0, borderRadius: 2,
          background: donorColor, border: "1px solid #555",
        }} title={donorPool ? `donor: source pool ${donorPool.id} · ${donorColor}` : "no donor"} />

        {/* Donor label + match score */}
        <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: "#cccccc" }}>
            {donorPool ? `source pool ${donorPool.id}` : "—"}
          </span>
          <span style={{ fontSize: 9, color: "#777" }}>
            {score == null
              ? ""
              : Number.isNaN(score)
                ? "manual"
                : `score ${score.toFixed(2)}`}
          </span>
        </div>

        {/* Expand affordance */}
        <span style={{ fontSize: 9, color: "#777", flexShrink: 0 }}>{selected ? "▾" : "▸"}</span>
      </div>

      {/* Inline donor picker — only for the selected row */}
      {selected && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "0 6px 6px" }}>
          {sourcePools.map(sp => {
            const sd = sp.descriptor;
            const isDonor = donorPool?.id === sp.id;
            return (
              <div
                key={sp.id}
                onClick={e => { e.stopPropagation(); onAssign(sp.id); }}
                onMouseEnter={() => onHoverSource(sp.id)}
                onMouseLeave={() => onHoverSource(null)}
                title={`source pool ${sp.id} · ${sd.valueBand} · ${(sd.weight * 100).toFixed(1)}% — click to assign as donor`}
                style={{
                  width: 22, height: 22, borderRadius: 2,
                  background: `rgb(${sd.r}, ${sd.g}, ${sd.b})`,
                  border: isDonor ? "2px solid #1473e6" : "1px solid #555",
                  boxSizing: "border-box", cursor: "pointer",
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Compact per-anchor slider — narrower label/readout than `Control`, sized
// for the per-anchor accordion rows. Behaviour mirrors the old inline radius
// slider so the dark theme stays consistent. ──
function AnchorSlider(props: {
  label: string; title: string;
  min: number; max: number; step: number;
  value: number; onChange: (n: number) => void;
}) {
  const { label, title, min, max, step, value, onChange } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={title}>
      <span style={{ fontSize: 9, color: "#9a9aa8", width: 64, flexShrink: 0 }}>
        {label}
      </span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, minWidth: 0, margin: 0, cursor: "pointer", height: 10 }}
      />
      <span style={{ fontSize: 9, width: 26, textAlign: "right", flexShrink: 0, opacity: 0.8 }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

// ── Compact per-anchor checkbox (one of the three LCh transfer locks). ──
function AnchorCheckbox(props: {
  label: string; checked: boolean; onChange: (c: boolean) => void;
}) {
  const { label, checked, onChange } = props;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "#cccccc", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ cursor: "pointer", margin: 0 }}
      />
      {label}
    </label>
  );
}

// ── Labelled slider + readout control ──────────────────────────────
function Control(props: {
  label: string; title: string;
  min: number; max: number; step: number;
  value: number; onChange: (n: number) => void;
  display: string;
}) {
  const { label, title, min, max, step, value, onChange, display } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={title}>
      <span style={{ fontSize: 10, width: 92, flexShrink: 0 }}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, minWidth: 0, margin: 0, cursor: "pointer", height: 12 }}
      />
      <span style={{ fontSize: 10, width: 30, textAlign: "right", flexShrink: 0, opacity: 0.8 }}>
        {display}
      </span>
    </div>
  );
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: "#cccccc",
  padding: "3px 6px", background: "#2c2c2c",
  border: "1px solid #444", borderRadius: 3,
};

const SUB_HEADER: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "#999",
  marginTop: 2,
};
