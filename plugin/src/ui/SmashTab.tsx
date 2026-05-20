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

import { Fragment, useEffect, useMemo, useState } from "react";
import { app, readLayerPixels, writePixelLayer, executeAsModal } from "../services/photoshop";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { SourceSelector } from "./SourceSelector";
import { Section } from "./Section";
import { downsampleToMaxEdge } from "../core/downsample";
import { rgbaToPngDataUrl } from "./encodePng";
import { matchStyles } from "./MatchSliders";
import { segmentImage, SegmentResult, Pool } from "../core/clusters";
import { matchPools, PoolMatch, Correspondence } from "../core/match";
import { transferColors, vectorizeUpscaleLabels, type TransferAnchor } from "../core/transfer";

// Max edge fed into segmentImage — keeps per-pixel clustering under a frame
// budget while staying detailed enough for a recognizable pool map.
const SEGMENT_MAX_EDGE = 256;
// Panel content width budget — pool-map images scale to fit this.
const PANEL_WIDTH = 220;
// Brightness multiplier applied to non-hovered pools in the pool maps.
const HOVER_DIM = 0.32;
// Side-by-side pool maps each get half the panel width (minus the gap).
const POOL_MAP_W = (PANEL_WIDTH - 6) / 2;

type SrcMode = "layer" | "selection" | "folder";

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
function useImagePicker() {
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
      SEGMENT_MAX_EDGE,
    );
  }, [snap]);

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
  const source = useImagePicker();
  const target = useImagePicker();

  // ── Shared segmentation controls (applied to BOTH images) ──────────
  const [poolCount, setPoolCount] = useState(6);
  const [edgePreservation, setEdgePreservation] = useState(0.55);
  const [regionCleanup, setRegionCleanup] = useState(0.4);
  const [colorVsValueBias, setColorVsValueBias] = useState(0.5);
  const [neutralProtection, setNeutralProtection] = useState(0);
  const [subPaletteSize, setSubPaletteSize] = useState(5);

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

  // ── Focal anchors (list of pairs) ──
  // Each anchor is a completed source↔target pair, captured with the source
  // pool id picked at the click site. Building one happens in two clicks:
  // first the SOURCE map (sets pendingSource), then the TARGET map (consumes
  // pendingSource and pushes the new pair). The radius is SHARED across all
  // anchors for this round — per-anchor radius is a later refinement.
  interface AnchorPair {
    sourceX: number;
    sourceY: number;
    sourcePoolId: number;
    targetX: number;
    targetY: number;
  }
  const [anchors, setAnchors] = useState<AnchorPair[]>([]);
  const [pendingSource, setPendingSource] = useState<
    { nx: number; ny: number; poolId: number } | null
  >(null);
  const [anchorRadius, setAnchorRadius] = useState(0.2);

  // The list passed into transferColors. Memoised so the live-preview effect
  // re-runs only when the actual list contents (or shared radius) change.
  const transferAnchors = useMemo<TransferAnchor[]>(
    () =>
      anchors.map(a => ({
        sourcePoolId: a.sourcePoolId,
        targetX: a.targetX,
        targetY: a.targetY,
        radius: anchorRadius,
      })),
    [anchors, anchorRadius],
  );

  // Repeating distinguishable palette so multiple anchors on the maps don't
  // collide visually. Source and target dots for anchor N share the same hue
  // so they read as a pair.
  const ANCHOR_COLORS = ["#ff9a00", "#22c1d6", "#d646b9", "#7ad62f", "#e8d227"];
  const colorForAnchor = (i: number) => ANCHOR_COLORS[i % ANCHOR_COLORS.length];

  // Dot+ring overlays for the two pool maps. Each completed anchor contributes
  // a source dot and a target dot in its paired colour. A pending source (no
  // target yet) is shown on the source map only, in the colour the next anchor
  // would take.
  const sourceAnchorDots = useMemo(() => {
    const dots = anchors.map((a, i) => ({
      nx: a.sourceX,
      ny: a.sourceY,
      radius: anchorRadius,
      color: colorForAnchor(i),
    }));
    if (pendingSource) {
      dots.push({
        nx: pendingSource.nx,
        ny: pendingSource.ny,
        radius: anchorRadius,
        color: colorForAnchor(anchors.length),
      });
    }
    return dots;
  }, [anchors, pendingSource, anchorRadius]);
  const targetAnchorDots = useMemo(
    () =>
      anchors.map((a, i) => ({
        nx: a.targetX,
        ny: a.targetY,
        radius: anchorRadius,
        color: colorForAnchor(i),
      })),
    [anchors, anchorRadius],
  );

  // ── Color transfer (in-panel preview) ─────────────────────────────
  // Blend amount fed to transferColors — 0 = unchanged target, 1 = full donor.
  const [strength, setStrength] = useState(1.0);
  // Boundary softness — 0 = hard pool edges, 1 = maximally blended recolor.
  const [relax, setRelax] = useState(0.35);
  // Luminance preservation — 0 = full recolor, 1 = keep target's lightness.
  const [preserveLuminance, setPreserveLuminance] = useState(0);
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
        const opts = { poolCount, edgePreservation, regionCleanup, colorVsValueBias, subPaletteSize, neutralProtection };
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
  }, [source.segInput, target.segInput, poolCount, edgePreservation, regionCleanup, colorVsValueBias, neutralProtection, subPaletteSize]);

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
          targetResult, sourceResult,
          correspondence, { strength, relax, preserveLuminance, anchors: transferAnchors },
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
  }, [hasApplied, sourceResult, targetResult, target.segInput, matches, strength, relax, preserveLuminance, transferAnchors]);

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
  // Source-map click: capture a pending source point + the pool id beneath it.
  // The pool id is read from the segmentation labels at the clicked location.
  // The next target-map click consumes this pendingSource to push a new pair.
  const handleAnchorSourceClick = (nx: number, ny: number) => {
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
    setPendingSource({ nx, ny, poolId });
  };
  const handleAnchorTargetClick = (nx: number, ny: number) => {
    if (!targetResult) return;
    if (!pendingSource) return; // no source click yet — hint shown in the UI
    const pair: AnchorPair = {
      sourceX: pendingSource.nx,
      sourceY: pendingSource.ny,
      sourcePoolId: pendingSource.poolId,
      targetX: nx,
      targetY: ny,
    };
    setAnchors(prev => [...prev, pair]);
    setPendingSource(null);
  };
  const clearAllAnchors = () => {
    setAnchors([]);
    setPendingSource(null);
  };
  const removeAnchor = (index: number) => {
    setAnchors(prev => prev.filter((_, i) => i !== index));
  };

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
        fullResult, sourceResult,
        correspondence, { strength, relax, preserveLuminance, anchors: transferAnchors },
      );

      // Place the new layer over the target layer's region, not at (0,0).
      await writePixelLayer(
        target.docId, "Color Smash", recolored, fullW, fullH,
        fullBuf.bounds.left, fullBuf.bounds.top,
      );
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

      {/* ── Inputs: source + target pickers + segmentation controls ── */}
      <Section title="INPUTS">
        <div style={SUB_HEADER}>SOURCE</div>
        <SourceSelector {...selectorProps(source)} selStyle={sel} />

        <div style={SUB_HEADER}>TARGET</div>
        <SourceSelector {...selectorProps(target)} selStyle={sel} />

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
        </div>
      </Section>

      {/* ── Pool maps (source left, target right) ── */}
      <Section title="POOL MAPS">
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PoolMapPane
              label="Source"
              url={sourceMapUrl}
              display={sourceMapDisplay}
              analyzing={analyzing}
              placeholder={source.snapError ?? "Pick a source layer."}
              onClickNormalized={sourceResult ? handleAnchorSourceClick : undefined}
              anchorDots={sourceAnchorDots}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PoolMapPane
              label={showDonorTint ? "Target — donor tint" : "Target"}
              url={targetMapUrl}
              display={targetMapDisplay}
              analyzing={analyzing}
              placeholder={target.snapError ?? "Pick a target layer."}
              onClickNormalized={targetResult ? handleAnchorTargetClick : undefined}
              anchorDots={targetAnchorDots}
            />
          </div>
        </div>
      </Section>

      {segError && (
        <div style={{ fontSize: 10, color: "#d8867d" }}>Segmentation failed: {segError}</div>
      )}

      {ready && (
        <>
          {/* ── Color transfer — in-panel before/after preview.
                Placed ABOVE Correspondence so it stays anchored to a stable
                spot while the correspondence list grows. ── */}
          <Section title="COLOR TRANSFER">
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

            {/* Output the smashed result back into the target document at its
                full resolution, as a new layer. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                onClick={canOutput ? outputToDocument : undefined}
                title="Run the transfer at the target document's full resolution and add the result as a new 'Color Smash' layer."
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

            {/* Before/after preview pane — toggles between the original target
                pixels and the recolored result. */}
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
          </Section>

          {/* ── Correspondence: target→source list with sort + scroll ── */}
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
              <select
                value={sortMode}
                onChange={e => setSortMode(e.target.value as SortMode)}
                title="Reorder the target → source list for easier scanning. Display-only — doesn't change the mapping."
                style={{
                  fontSize: 10, padding: "2px 4px", borderRadius: 2,
                  border: "1px solid #4a4a4a", background: "#2a2a2a",
                  color: "#cccccc", fontFamily: "inherit", cursor: "pointer",
                }}
              >
                <option value="weightDesc">Sort: largest first</option>
                <option value="weightAsc">Sort: smallest first</option>
                <option value="lightToDark">Sort: light → dark</option>
                <option value="darkToLight">Sort: dark → light</option>
                <option value="warmToCool">Sort: warm → cool</option>
                <option value="coolToWarm">Sort: cool → warm</option>
              </select>
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
                  color: pendingSource
                    ? "#d8c87d"
                    : anchors.length > 0
                      ? "#7dd87d"
                      : "#9a9aa8",
                }}>
                  {pendingSource
                    ? `Click the TARGET map to complete anchor ${anchors.length + 1}`
                    : anchors.length === 0
                      ? "0 anchors — click the SOURCE map to start one."
                      : anchors.length === 1
                        ? "1 anchor active — click the SOURCE map to add another."
                        : `${anchors.length} anchors active — click the SOURCE map to add another.`}
                </span>
                <div style={{ flex: 1 }} />
                {(anchors.length > 0 || pendingSource) && (
                  <div
                    onClick={clearAllAnchors}
                    title="Remove every focal anchor."
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
              {(anchors.length > 0 || pendingSource) && (
                <Control
                  label="Anchor radius"
                  title="Shared falloff radius around every target anchor — how far each anchor's source pool reaches before fading back to the auto donor."
                  min={0.05} max={0.6} step={0.025}
                  value={anchorRadius} onChange={setAnchorRadius}
                  display={anchorRadius.toFixed(2)}
                />
              )}
              {anchors.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {anchors.map((a, i) => {
                    const color = colorForAnchor(i);
                    const donor = sourcePoolsById.get(a.sourcePoolId);
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "3px 6px",
                          background: "#1f1f1f",
                          border: "1px solid #3a3a3a",
                          borderRadius: 2,
                        }}
                      >
                        <div style={{
                          width: 12, height: 12, borderRadius: "50%",
                          background: color, border: "1px solid #000",
                          flexShrink: 0,
                        }} title={`anchor ${i + 1}`} />
                        <span style={{ fontSize: 10, color: "#cccccc" }}>
                          anchor {i + 1}
                        </span>
                        <span style={{ fontSize: 9, color: "#777" }}>
                          {donor ? `source pool ${donor.id}` : "—"}
                        </span>
                        <div style={{ flex: 1 }} />
                        <div
                          onClick={() => removeAnchor(i)}
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
        </>
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
function PoolMapPane({
  label, url, display, analyzing, placeholder,
  onClickNormalized, anchorDots,
}: {
  label: string;
  url: string | null;
  display: { w: number; h: number };
  analyzing: boolean;
  placeholder: string;
  onClickNormalized?: (nx: number, ny: number) => void;
  // Anchor overlays — every dot+ring this map should render. Order is the
  // pair index, so callers control colour pairing across the two maps.
  anchorDots?: { nx: number; ny: number; radius: number; color: string }[];
}) {
  const handleClick = onClickNormalized
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
        onClickNormalized(nx, ny);
      }
    : undefined;

  // Falloff rings size by the larger displayed edge, matching radius units.
  const ringDiameterFor = (radius: number) =>
    radius * 2 * Math.max(display.w, display.h);

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
            onClick={handleClick}
            style={{
              position: "relative",
              width: display.w, height: display.h,
              cursor: handleClick ? "crosshair" : "default",
            }}
          >
            <img
              src={url}
              style={{
                width: display.w, height: display.h,
                imageRendering: "pixelated", display: "block",
              }}
            />
            {anchorDots && anchorDots.map((d, i) => {
              const ringDiameter = ringDiameterFor(d.radius);
              return (
                <Fragment key={i}>
                  {/* Falloff ring */}
                  <div style={{
                    position: "absolute", pointerEvents: "none",
                    left: d.nx * display.w - ringDiameter / 2,
                    top: d.ny * display.h - ringDiameter / 2,
                    width: ringDiameter, height: ringDiameter,
                    borderRadius: "50%",
                    border: `1px solid ${d.color}`,
                    opacity: 0.85,
                  }} />
                  {/* Center dot */}
                  <div style={{
                    position: "absolute", pointerEvents: "none",
                    left: d.nx * display.w - 4,
                    top: d.ny * display.h - 4,
                    width: 8, height: 8, borderRadius: "50%",
                    background: d.color,
                    border: "1px solid #000",
                  }} />
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
