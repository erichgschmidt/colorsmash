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

import { useEffect, useMemo, useState } from "react";
import { app } from "../services/photoshop";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { SourceSelector } from "./SourceSelector";
import { downsampleToMaxEdge } from "../core/downsample";
import { rgbaToPngDataUrl } from "./encodePng";
import { matchStyles } from "./MatchSliders";
import { segmentImage, SegmentResult, Pool } from "../core/clusters";
import { matchPools, PoolMatch } from "../core/match";

// Max edge fed into segmentImage — keeps per-pixel clustering under a frame
// budget while staying detailed enough for a recognizable pool map.
const SEGMENT_MAX_EDGE = 256;
// Panel content width budget — pool-map images scale to fit this.
const PANEL_WIDTH = 220;

type SrcMode = "layer" | "selection" | "folder";

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
  const [spatialWeight, setSpatialWeight] = useState(0.5);
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
  // Currently-selected target pool id (null = none). While set, clicking a
  // source swatch reassigns this target's donor.
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
  // Nice-to-have: tint the target pool map by each region's matched donor.
  const [donorPreview, setDonorPreview] = useState(false);

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
        const opts = { poolCount, spatialWeight, subPaletteSize };
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
  }, [source.segInput, target.segInput, poolCount, spatialWeight, subPaletteSize]);

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
  const sourceMapUrl = useMemo(
    () => buildPoolMapUrl(sourceResult, p => p.descriptor),
    [sourceResult],
  );

  // Target map: either each pool's own mean color, or (donor preview) the
  // mean color of its matched source pool.
  const targetMapUrl = useMemo(
    () => buildPoolMapUrl(targetResult, p => {
      if (!donorPreview) return p.descriptor;
      const match = matchByTargetId.get(p.id);
      const donor = match ? sourcePoolsById.get(match.sourcePoolId) : undefined;
      return donor ? donor.descriptor : p.descriptor;
    }),
    [targetResult, donorPreview, matchByTargetId, sourcePoolsById],
  );

  const sourceDisplay = useDisplaySize(sourceResult);
  const targetDisplay = useDisplaySize(targetResult);

  // ── Remap interaction ──────────────────────────────────────────────
  // Click a source swatch: if a target row is selected, reassign its donor.
  const assignDonor = (sourcePoolId: number) => {
    if (selectedTargetId == null) return;
    setMatches(prev => prev.map(m =>
      m.targetPoolId === selectedTargetId
        ? { ...m, sourcePoolId, score: NaN } // score no longer meaningful after a manual edit
        : m,
    ));
  };

  const resetToAuto = () => {
    setMatches(autoMatches.map(m => ({ ...m })));
    setSelectedTargetId(null);
  };

  // Whether the current matches differ from the auto result (enables Reset).
  const isEdited = useMemo(() => {
    if (matches.length !== autoMatches.length) return true;
    const auto = new Map(autoMatches.map(m => [m.targetPoolId, m.sourcePoolId]));
    return matches.some(m => auto.get(m.targetPoolId) !== m.sourcePoolId);
  }, [matches, autoMatches]);

  const sel = matchStyles.sel;
  const ready = !!sourceResult && !!targetResult;

  // Target pools sorted heaviest-first for the correspondence list.
  const targetPools = targetResult?.pools ?? [];
  const sourcePools = sourceResult?.pools ?? [];

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_HEADER}>SMASH — POOL CORRESPONDENCE</div>

      {/* ── Source picker ── */}
      <div style={SUB_HEADER}>SOURCE</div>
      <SourceSelector {...selectorProps(source)} selStyle={sel} />

      {/* ── Target picker ── */}
      <div style={SUB_HEADER}>TARGET</div>
      <SourceSelector {...selectorProps(target)} selStyle={sel} />

      {/* ── Shared segmentation controls ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
        <Control
          label="Pool count"
          title="Number of color pools to segment each image into."
          min={2} max={12} step={1}
          value={poolCount} onChange={setPoolCount}
          display={String(poolCount)}
        />
        <Control
          label="Cluster sharpness"
          title="Low = pools grouped by color only. High = pools favor compact, contiguous regions."
          min={0} max={1} step={0.05}
          value={spatialWeight} onChange={setSpatialWeight}
          display={spatialWeight.toFixed(2)}
        />
        <Control
          label="Sub-palette size"
          title="Number of swatches sampled within each pool."
          min={3} max={7} step={1}
          value={subPaletteSize} onChange={setSubPaletteSize}
          display={String(subPaletteSize)}
        />
      </div>

      {/* ── Pool maps (source + target stacked) ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <PoolMapPane
          label="Source pools"
          url={sourceMapUrl}
          display={sourceDisplay}
          analyzing={analyzing}
          placeholder={source.snapError ?? "Pick a source layer."}
        />
        <PoolMapPane
          label={donorPreview ? "Target — tinted by matched donor" : "Target pools"}
          url={targetMapUrl}
          display={targetDisplay}
          analyzing={analyzing}
          placeholder={target.snapError ?? "Pick a target layer."}
        />
      </div>

      {segError && (
        <div style={{ fontSize: 10, color: "#d8867d" }}>Segmentation failed: {segError}</div>
      )}

      {ready && (
        <>
          {/* ── Donor-preview toggle + reset ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer" }}
              title="Tint the target pool map by each region's matched source color — a preview of which donor goes where.">
              <input type="checkbox" checked={donorPreview}
                onChange={e => setDonorPreview(e.target.checked)}
                style={{ cursor: "pointer", margin: 0 }} />
              Donor preview
            </label>
            <div style={{ flex: 1 }} />
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

          {/* ── Source pool strip — selectable donors ── */}
          <div style={SUB_HEADER}>
            SOURCE POOLS{selectedTargetId != null ? " — click to assign" : ""}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {sourcePools.map(p => {
              const d = p.descriptor;
              const selectedMatch = selectedTargetId != null
                ? matchByTargetId.get(selectedTargetId)
                : undefined;
              const isCurrentDonor = selectedMatch?.sourcePoolId === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => assignDonor(p.id)}
                  title={`Source pool ${p.id} · rgb(${d.r}, ${d.g}, ${d.b}) · ${d.valueBand} · ${(d.weight * 100).toFixed(1)}%`
                    + (selectedTargetId != null ? " — click to assign as donor" : "")}
                  style={{
                    width: 30, height: 30, borderRadius: 2,
                    background: `rgb(${d.r}, ${d.g}, ${d.b})`,
                    border: isCurrentDonor ? "2px solid #1473e6" : "1px solid #555",
                    boxSizing: "border-box",
                    cursor: selectedTargetId != null ? "pointer" : "default",
                    opacity: selectedTargetId != null ? 1 : 0.92,
                  }}
                />
              );
            })}
          </div>

          {/* ── Correspondence list — one row per TARGET pool ── */}
          <div style={SUB_HEADER}>CORRESPONDENCE (target → source)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {targetPools.map(tp => {
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
                  onSelect={() => setSelectedTargetId(selected ? null : tp.id)}
                />
              );
            })}
          </div>
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

// Display size: scale a segmented image to fit the panel width, no upscaling.
function useDisplaySize(result: SegmentResult | null): { w: number; h: number } {
  return useMemo(() => {
    if (!result) return { w: 0, h: 0 };
    const scale = Math.min(1, PANEL_WIDTH / result.width);
    return { w: Math.round(result.width * scale), h: Math.round(result.height * scale) };
  }, [result]);
}

// ── One pool-map image pane (label + framed image + analyzing overlay) ──
function PoolMapPane({ label, url, display, analyzing, placeholder }: {
  label: string;
  url: string | null;
  display: { w: number; h: number };
  analyzing: boolean;
  placeholder: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, color: "#999", letterSpacing: 0.3 }}>{label}</span>
      <div style={{
        position: "relative", alignSelf: "center",
        width: display.w || PANEL_WIDTH, minHeight: 60,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "#1f1f1f", border: "1px solid #3a3a3a", borderRadius: 2,
      }}>
        {url && (
          <img
            src={url}
            style={{
              width: display.w, height: display.h,
              imageRendering: "pixelated", display: "block",
            }}
          />
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

// ── One correspondence row — a target pool and its matched source donor ──
function CorrespondenceRow({ targetPool, donorPool, score, selected, onSelect }: {
  targetPool: Pool;
  donorPool: Pool | undefined;
  score: number | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = targetPool.descriptor;
  const targetColor = `rgb(${t.r}, ${t.g}, ${t.b})`;
  const donorColor = donorPool
    ? `rgb(${donorPool.descriptor.r}, ${donorPool.descriptor.g}, ${donorPool.descriptor.b})`
    : "#2a2a2a";

  return (
    <div
      onClick={onSelect}
      title={selected ? "Selected — click a source pool to reassign this target's donor." : "Click to select this target pool for remapping."}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "4px 6px",
        background: selected ? "#22364f" : "#1f1f1f",
        border: `1px solid ${selected ? "#1473e6" : "#3a3a3a"}`,
        borderRadius: 2, cursor: "pointer", userSelect: "none",
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
