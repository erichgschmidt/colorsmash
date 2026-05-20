// Analysis tab — prototype for clustering-based color "pool" analysis.
//
// Picks a source layer (reusing SourceSelector + useLayerPreview, same as
// MatchTab), downsamples the snapshot to a small edge for segmentation speed,
// and runs segmentImage() from core/clusters. Results render as a pool map
// canvas (each pixel painted with its pool's mean color) plus a per-pool
// breakdown list with weight %, compactness readout and a sub-palette strip.
//
// Segmentation runs in a deferred effect so the "analyzing…" state can paint
// before the synchronous segment work blocks the main thread.

import { useEffect, useMemo, useRef, useState } from "react";
import { app } from "../services/photoshop";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { SourceSelector } from "./SourceSelector";
import { Section } from "./Section";
import { downsampleToMaxEdge } from "../core/downsample";
import { rgbaToPngDataUrl } from "./encodePng";
import { matchStyles } from "./MatchSliders";
import { segmentImage, expandPool, collapsePool, SegmentResult, Pool } from "../core/clusters";

// Max edge fed into segmentImage. The layer snapshot already comes in at
// PREVIEW_MAX_EDGE (640); 256 keeps the per-pixel clustering well under a
// frame budget while staying detailed enough for a recognizable pool map.
const SEGMENT_MAX_EDGE = 256;
// Panel content width budget — the pool-map canvas scales to fit this.
const PANEL_WIDTH = 220;

type SrcMode = "layer" | "selection" | "folder";

// Compactness 0..1 → human label. Tuned per the spec thresholds.
function compactnessLabel(c: number): { text: string; color: string } {
  if (c > 0.6) return { text: "localized", color: "#7dd87d" };
  if (c < 0.3) return { text: "diffuse", color: "#d8867d" };
  return { text: "mixed", color: "#d8c87d" };
}

export function AnalysisTab() {
  // ── Source picking ──────────────────────────────────────────────
  // AnalysisTab only supports layer mode (no selection / folder browse here),
  // but SourceSelector needs the full prop surface, so unused modes are stubbed.
  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  const [docId, setDocId] = useState<number | null>(null);
  const [layerId, setLayerId] = useState<number | null>(null);

  const { layers, refresh: refreshLayers } = useLayers(docId);

  // Seed the doc list + active doc on mount, refresh on PS doc events.
  useEffect(() => {
    const readDocs = () => {
      try {
        const list = (app.documents ?? []).map((d: any) => ({ id: d.id as number, name: d.name as string }));
        setDocs(list);
        setDocId(prev => (prev != null && list.some((d: { id: number }) => d.id === prev))
          ? prev
          : (app.activeDocument?.id ?? list[0]?.id ?? null));
      } catch { /* */ }
    };
    readDocs();
  }, []);

  // Auto-pick a layer once the layer list resolves (last layer = topmost edit).
  useEffect(() => {
    if (layers.length > 0 && (layerId == null || !layers.find(l => l.id === layerId))) {
      setLayerId(layers[layers.length - 1].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const docsKey = useMemo(() => docs.map(d => `${d.id}:${d.name}`).join("|"), [docs]);
  const layersKey = useMemo(() => layers.map(l => `${l.id}:${l.name}`).join("|"), [layers]);

  const { snap, error: snapError } = useLayerPreview(docId, layerId);

  // ── Segmentation controls ───────────────────────────────────────
  const [poolCount, setPoolCount] = useState(6);
  const [edgePreservation, setEdgePreservation] = useState(0.55);
  const [regionCleanup, setRegionCleanup] = useState(0.4);
  const [colorVsValueBias, setColorVsValueBias] = useState(0.5);
  const [neutralProtection, setNeutralProtection] = useState(0);
  const [subPaletteSize, setSubPaletteSize] = useState(5);

  // ── Segmentation result + analyzing state ───────────────────────
  const [result, setResult] = useState<SegmentResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [segError, setSegError] = useState<string | null>(null);
  // Ids of pools the user has drilled into. Re-applied after a control change
  // (warm-start keeps top-level ids stable, so a drill-down survives by id).
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Downsample the (already small) snapshot once per snapshot change to the
  // segmentation edge. Memoized so control changes don't redo the box filter.
  const segInput = useMemo(() => {
    if (!snap) return null;
    // useLayerPreview's bounds is optional; downsampleToMaxEdge wants a
    // concrete PixelBuffer, so fall back to a full-image rect when absent.
    const bounds = snap.bounds ?? { left: 0, top: 0, right: snap.width, bottom: snap.height };
    return downsampleToMaxEdge(
      { width: snap.width, height: snap.height, data: snap.data, bounds },
      SEGMENT_MAX_EDGE,
    );
  }, [snap]);

  // Warm-start state: the last result + the input it came from. Re-segmenting
  // after a control change reuses the prior result so pool ids and the
  // partition stay stable; a new image segments cold. expandedIdsRef mirrors
  // the expandedIds state so the (non-reactive) effect can read it.
  const prevResultRef = useRef<SegmentResult | null>(null);
  const lastSegInputRef = useRef<ReturnType<typeof downsampleToMaxEdge> | null>(null);
  const expandedIdsRef = useRef(expandedIds);

  // Recompute segmentation whenever the input or any control changes. The work
  // is synchronous and can take a moment, so we flip on the "analyzing" flag,
  // yield a frame for it to paint, then run segmentImage.
  useEffect(() => {
    if (!segInput) { setResult(null); setSegError(null); return; }
    let cancelled = false;
    setAnalyzing(true);
    setSegError(null);
    // Warm-start only when the image is unchanged (a control changed).
    const warm = lastSegInputRef.current === segInput
      ? prevResultRef.current ?? undefined
      : undefined;
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        const opts = { poolCount, edgePreservation, regionCleanup, colorVsValueBias, subPaletteSize, neutralProtection };
        let r = segmentImage(segInput.data, segInput.width, segInput.height, opts, warm);
        // Re-apply drilled-down pools by id (top-level ids are warm-stable).
        for (const id of expandedIdsRef.current) {
          if (r.pools.some(p => p.id === id && !p.subPools)) {
            r = expandPool(r, segInput.data, id, opts);
          }
        }
        if (!cancelled) {
          setResult(r);
          prevResultRef.current = r;
          lastSegInputRef.current = segInput;
        }
      } catch (e: any) {
        if (!cancelled) { setResult(null); setSegError(e?.message ?? String(e)); }
      } finally {
        if (!cancelled) setAnalyzing(false);
      }
    }, 16);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [segInput, poolCount, edgePreservation, regionCleanup, colorVsValueBias, neutralProtection, subPaletteSize]);

  // Drill a pool down into child pools (or fold it back up). Operates on the
  // current result directly so the click is snappy.
  const toggleExpand = (poolId: number) => {
    if (!segInput || !result) return;
    const willExpand = !expandedIds.has(poolId);
    const next = new Set(expandedIds);
    if (willExpand) next.add(poolId); else next.delete(poolId);
    const opts = { poolCount, edgePreservation, regionCleanup, colorVsValueBias, subPaletteSize, neutralProtection };
    const r = willExpand
      ? expandPool(result, segInput.data, poolId, opts)
      : collapsePool(result, poolId);
    setExpandedIds(next);
    expandedIdsRef.current = next;
    setResult(r);
    prevResultRef.current = r;
  };

  // ── Pool-map image ──────────────────────────────────────────────
  // UXP's canvas 2D context lacks createImageData, so the pool map is built
  // as an RGBA buffer and PNG-encoded for an <img> (same pattern as previews).
  const poolMapUrl = useMemo(() => {
    if (!result) return null;
    const { width, height, labels, pools } = result;
    // Index every pool (top-level + drilled-down children) by id so a label —
    // which may be a child id where a pool is expanded — maps to its color.
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
        rgba[o] = pool.descriptor.r;
        rgba[o + 1] = pool.descriptor.g;
        rgba[o + 2] = pool.descriptor.b;
      }
      rgba[o + 3] = 255;
    }
    return rgbaToPngDataUrl(rgba, width, height);
  }, [result]);

  // Display size: scale the segmented image to fit the panel width,
  // never upscaling past its native pixel size.
  const canvasDisplay = useMemo(() => {
    if (!result) return { w: 0, h: 0 };
    const scale = Math.min(1, PANEL_WIDTH / result.width);
    return { w: Math.round(result.width * scale), h: Math.round(result.height * scale) };
  }, [result]);

  // segmentImage already returns pools sorted heaviest-first.
  const sortedPools = result?.pools ?? [];

  // ── Render ──────────────────────────────────────────────────────
  const sel = matchStyles.sel;

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_HEADER}>COLOR POOLS</div>

      {/* ── Inputs: source picker + segmentation controls ── */}
      <Section title="INPUTS">
        <SourceSelector
          docs={docs}
          activeDocId={docId}
          srcMode={"layer" as SrcMode}
          browsedFile=""
          onSwitchDoc={setDocId}
          onSwitchSrcMode={() => { /* analysis is layer-only */ }}
          setBrowsedFile={() => { /* unused */ }}
          onBrowseImage={() => { /* unused */ }}
          layers={layers}
          sourceId={layerId}
          setSourceId={setLayerId}
          autoUpdate={false}
          setAutoUpdate={() => { /* unused */ }}
          sampleMerged={false}
          setSampleMerged={() => { /* unused */ }}
          sampleLock={false}
          setSampleLock={() => { /* unused */ }}
          selStyle={sel}
          onRefreshLayers={refreshLayers}
          docsKey={docsKey}
          layersKey={layersKey}
        />

        {/* Controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
          <Control
            label="Pool count"
            title="Number of color pools to segment the image into."
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

      {/* ── Pool map image pane (with placeholder / analyzing states) ── */}
      <Section title="POOL MAP">
        <div style={{
          position: "relative", alignSelf: "center",
          width: canvasDisplay.w || PANEL_WIDTH, minHeight: 60,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#1f1f1f", border: "1px solid #3a3a3a", borderRadius: 2,
        }}>
          {poolMapUrl && (
            <img
              src={poolMapUrl}
              style={{
                width: canvasDisplay.w, height: canvasDisplay.h,
                imageRendering: "pixelated", display: "block",
              }}
            />
          )}
          {!result && !analyzing && (
            <div style={{ padding: 24, fontSize: 10, opacity: 0.5 }}>
              {snapError ?? segError ?? "Pick a layer to analyze."}
            </div>
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

        {segError && (
          <div style={{ fontSize: 10, color: "#d8867d" }}>Segmentation failed: {segError}</div>
        )}
      </Section>

      {/* ── Pool breakdown list — click a pool's chevron to drill into sub-pools ── */}
      <Section title="POOLS">
        {sortedPools.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {sortedPools.map(pool => (
              <div key={pool.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <PoolRow
                  pool={pool}
                  depth={0}
                  expanded={!!pool.subPools}
                  onToggle={() => toggleExpand(pool.id)}
                />
                {pool.subPools && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, marginLeft: 16 }}>
                    {pool.subPools.map(child => (
                      <PoolRow key={child.id} pool={child} depth={1} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: 8, fontSize: 10, opacity: 0.5 }}>
            No pools yet — pick a layer to analyze.
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Single pool row ────────────────────────────────────────────────
function PoolRow({ pool, depth, expanded, onToggle }: {
  pool: Pool;
  depth: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const d = pool.descriptor;
  const meanColor = `rgb(${d.r}, ${d.g}, ${d.b})`;
  const compact = compactnessLabel(d.compactness);
  const structured = pool.subPalette;
  const noiseSw = pool.noise?.swatches ?? [];
  // Strip segment widths proportional to each swatch's weight — structured and
  // noise swatches share one weight budget so the strip reads as the pool.
  const total =
    (structured.reduce((a, s) => a + Math.max(0, s.weight), 0) +
      noiseSw.reduce((a, s) => a + Math.max(0, s.weight), 0)) || 1;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "4px 6px",
      background: depth > 0 ? "#191919" : "#1f1f1f",
      border: "1px solid #3a3a3a", borderRadius: 2,
    }}>
      {/* Expand / collapse chevron — top-level pools only */}
      {onToggle && (
        <div
          onClick={onToggle}
          title={expanded ? "Collapse sub-pools" : "Drill down into sub-pools"}
          style={{
            width: 12, flexShrink: 0, cursor: "pointer", userSelect: "none",
            fontSize: 9, color: "#cccccc", textAlign: "center",
          }}
        >
          {expanded ? "▾" : "▸"}
        </div>
      )}

      {/* Pool mean swatch */}
      <div style={{
        width: 22, height: 22, flexShrink: 0, borderRadius: 2,
        background: meanColor, border: "1px solid #555",
      }} title={`${meanColor} · ${d.valueBand}`} />

      {/* Weight % + compactness + noise share */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, width: 56, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{(d.weight * 100).toFixed(1)}%</span>
        <span style={{ fontSize: 9, color: compact.color }} title={`compactness ${d.compactness.toFixed(2)}`}>
          {compact.text}
        </span>
        {pool.noise && (
          <span
            style={{ fontSize: 9, color: "#9a9aa8" }}
            title="diffuse / speckled color split out of the structured sub-palette"
          >
            noise {(pool.noise.weight * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Sub-palette strip: structured swatches at full opacity, diffuse
          (noise) swatches dimmed so the split is visible at a glance. */}
      <div style={{
        flex: 1, minWidth: 0, height: 16, display: "flex",
        borderRadius: 2, overflow: "hidden", border: "1px solid #3a3a3a",
      }}>
        {structured.length === 0 && noiseSw.length === 0 && (
          <div style={{ flex: 1, background: "#2a2a2a" }} />
        )}
        {structured.map((s, i) => (
          <div
            key={`s${i}`}
            style={{
              width: `${(Math.max(0, s.weight) / total) * 100}%`,
              background: `rgb(${s.r}, ${s.g}, ${s.b})`,
            }}
            title={`structured · rgb(${s.r}, ${s.g}, ${s.b}) — ${(s.weight * 100).toFixed(0)}%`}
          />
        ))}
        {noiseSw.map((s, i) => (
          <div
            key={`n${i}`}
            style={{
              width: `${(Math.max(0, s.weight) / total) * 100}%`,
              background: `rgb(${s.r}, ${s.g}, ${s.b})`, opacity: 0.45,
            }}
            title={`noise · rgb(${s.r}, ${s.g}, ${s.b}) — ${(s.weight * 100).toFixed(0)}%`}
          />
        ))}
      </div>
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
