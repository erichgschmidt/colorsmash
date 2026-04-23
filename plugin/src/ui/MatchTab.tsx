// Color-match tab. One Curves layer fitted via per-channel histogram specification.
// Captures range, contrast, value, and color cast in a single editable node.
// Controls: amount, smoothing, stretch cap, dimension warps, zone targeting, chroma-only.
// Source can be a layer, a marquee selection snapshot, or a saved preset (history).

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane, PreviewImgHandle } from "./PreviewPane";
import { CurvesGraph } from "./CurvesGraph";
import { ChannelCurves } from "../core/histogramMatch";
import {
  fitHistogramCurves, processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
  applyDimensions, applyZoneWeightsToChannels,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
} from "../core/histogramMatch";
import { applyMatch } from "../app/applyMatch";
import {
  readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  listPresets, savePreset, deletePreset, loadPresetSnap,
  SourcePreset, SourcePresetSnapshot,
} from "../services/sourcePresets";

const SOURCE_MAX_EDGE = 256;

export function MatchTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const smoothRef = useRef(0);
  const stretchRef = useRef(8);
  const [chromaOnly, setChromaOnly] = useState(false);
  const [amountLabel, setAmountLabel] = useState(100);
  const [smoothLabel, setSmoothLabel] = useState(0);
  const [stretchLabel, setStretchLabel] = useState(8);
  const [status, setStatus] = useState("Pick source + target.");

  const dimsRef = useRef<DimensionOpts>({ ...DEFAULT_DIMENSIONS });
  const [dimsLabel, setDimsLabel] = useState<DimensionOpts>({ ...DEFAULT_DIMENSIONS });

  const zonesRef = useRef<ZoneOpts>({ ...DEFAULT_ZONES });
  const [zonesLabel, setZonesLabel] = useState<ZoneOpts>({ ...DEFAULT_ZONES });

  // Source override: when set, fit uses these pixels instead of the source layer.
  const [srcOverride, setSrcOverride] = useState<SourcePresetSnapshot | null>(null);
  const [presets, setPresets] = useState<SourcePreset[]>([]);

  useEffect(() => { listPresets().then(setPresets).catch(() => {}); }, []);

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(sourceId);
  const tgt = useLayerPreview(targetId);

  // Effective source snapshot for fit + preview.
  const srcSnap = srcOverride ?? src.snap;

  const fittedRaw = useMemo(() => {
    if (!srcSnap || !tgt.snap) return null;
    return fitHistogramCurves(srcSnap.data, tgt.snap.data);
  }, [srcSnap, tgt.snap]);

  const matchedHandleRef = useRef<PreviewImgHandle | null>(null);
  const rafPendingRef = useRef(false);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  const redrawMatched = () => {
    if (!tgt.snap || !matchedHandleRef.current) return;
    if (showOriginal) {
      matchedHandleRef.current.setPixels(tgt.snap.data, tgt.snap.width, tgt.snap.height);
      return;
    }
    if (!fittedRaw) return;
    const processed = processChannelCurves(fittedRaw, {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
    });
    const dim = applyDimensions(processed, dimsRef.current);
    const c = applyZoneWeightsToChannels(dim, zonesRef.current);
    setRenderedCurves(c);
    let out = applyChannelCurvesToRgba(tgt.snap.data, c);
    if (chromaOnly) out = applyChromaOnly(tgt.snap.data, out);
    matchedHandleRef.current.setPixels(out, tgt.snap.width, tgt.snap.height);
  };

  const scheduleRedraw = () => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => { rafPendingRef.current = false; redrawMatched(); });
  };

  useEffect(() => { scheduleRedraw(); }, [fittedRaw, tgt.snap, chromaOnly, showOriginal]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSwap = () => {
    if (srcOverride) { setStatus("Cannot swap while source is an override. Clear override first."); return; }
    const a = sourceId, b = targetId;
    setSourceId(b); setTargetId(a);
  };

  const onSnapshotSelection = async () => {
    setStatus("Snapshotting selection...");
    try {
      const snap = await executeAsModal("Color Smash snapshot selection", async () => {
        const doc = getActiveDoc();
        const sel = getSelectionBounds();
        if (!sel) throw new Error("No active marquee selection.");
        const layer = doc.activeLayers?.[0];
        if (!layer) throw new Error("No active layer.");
        const buf = await readLayerPixels(layer, sel);
        const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
        return { width: small.width, height: small.height, data: small.data, name: `${layer.name} (selection)` };
      });
      setSrcOverride(snap);
      setStatus(`Source = ${snap.name} (${snap.width}×${snap.height})`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const onSavePreset = async () => {
    if (!srcSnap) { setStatus("No source snapshot to save."); return; }
    const name = prompt("Preset name:", srcOverride?.name ?? src.snap?.layerName ?? "Untitled");
    if (!name) return;
    try {
      const p = await savePreset({ width: srcSnap.width, height: srcSnap.height, data: srcSnap.data, name });
      setPresets(await listPresets());
      setStatus(`Saved preset "${p.name}".`);
    } catch (e: any) { setStatus(`Error saving preset: ${e?.message ?? e}`); }
  };

  const onLoadPreset = (id: string) => {
    if (!id) { setSrcOverride(null); setStatus("Source = layer."); return; }
    const p = presets.find(x => x.id === id);
    if (!p) return;
    setSrcOverride(loadPresetSnap(p));
    setStatus(`Source = preset "${p.name}".`);
  };

  const onDeletePreset = async () => {
    const sel = (document.querySelector("#match-preset-select") as HTMLSelectElement | null)?.value;
    if (!sel) { setStatus("Pick a preset to delete."); return; }
    if (!confirm(`Delete preset "${presets.find(p => p.id === sel)?.name}"?`)) return;
    await deletePreset(sel);
    setPresets(await listPresets());
    if (srcOverride && presets.find(p => p.id === sel)) setSrcOverride(null);
    setStatus("Preset deleted.");
  };

  const onClearOverride = () => { setSrcOverride(null); setStatus("Source = layer."); };

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (!srcOverride && sourceId == null) { setStatus("Pick source layer."); return; }
    setStatus("Applying match...");
    try {
      setStatus(await applyMatch({
        sourceLayerId: sourceId ?? -1,
        targetLayerId: targetId,
        amount: amountRef.current / 100,
        smoothRadius: smoothRef.current,
        maxStretch: stretchRef.current,
        chromaOnly,
        dimensions: dimsRef.current,
        zones: zonesRef.current,
        sourcePixelsOverride: srcOverride?.data,
        sourceLabel: srcOverride?.name,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 6, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };
  const tinyBtn: React.CSSProperties = { padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 };
  const sel: React.CSSProperties = { flex: 1, padding: "2px 4px", fontSize: 10, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" };

  const slider = (
    label: string, ref: React.MutableRefObject<number>, value: number, setValue: (n: number) => void,
    min: number, max: number, suffix = "",
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
      <input type="range" min={min} max={max} defaultValue={value}
        onInput={e => { const v = Number((e.target as HTMLInputElement).value); ref.current = v; setValue(v); scheduleRedraw(); }}
        style={{ flex: 1, minWidth: 0 }} />
      <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
    </div>
  );

  const zoneSlider = (label: string, key: keyof ZoneOpts, min: number, max: number, suffix = "") => {
    const value = zonesLabel[key];
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 80, opacity: 0.7 }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => { const v = Number((e.target as HTMLInputElement).value); zonesRef.current = { ...zonesRef.current, [key]: v }; setZonesLabel(z => ({ ...z, [key]: v })); scheduleRedraw(); }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 40, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
      </div>
    );
  };

  const dimSlider = (label: string, key: keyof DimensionOpts, min: number, max: number, suffix = "") => {
    const value = dimsLabel[key];
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => { const v = Number((e.target as HTMLInputElement).value); dimsRef.current = { ...dimsRef.current, [key]: v }; setDimsLabel(d => ({ ...d, [key]: v })); scheduleRedraw(); }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 40, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
      </div>
    );
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <PreviewPane label="Source" layers={srcOverride ? [] : layers} selectedId={srcOverride ? null : sourceId} onSelect={setSourceId}
          snapshot={srcOverride ? { ...srcOverride, layerId: -1, layerName: srcOverride.name } : src.snap}
          onRefresh={srcOverride ? undefined : src.refresh} height={120} />
        <PreviewPane label="Target" layers={layers} selectedId={targetId} onSelect={setTargetId} snapshot={tgt.snap} onRefresh={tgt.refresh} height={120} />
      </div>

      {/* Source toolbar: snapshot / save / preset dropdown / clear */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
        <button onClick={onSnapshotSelection} style={tinyBtn} title="Use the active marquee selection on the active layer as source">Snapshot selection</button>
        <button onClick={onSavePreset} style={tinyBtn} title="Save current source for later reuse">Save preset</button>
        <select id="match-preset-select" style={sel} value={srcOverride && presets.find(p => p.name === srcOverride.name) ? presets.find(p => p.name === srcOverride.name)!.id : ""}
          onChange={e => onLoadPreset(e.target.value)}>
          <option value="">— layer mode —</option>
          {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={onDeletePreset} style={tinyBtn} title="Delete the preset selected in the dropdown">Del</button>
        {srcOverride && <button onClick={onClearOverride} style={tinyBtn}>Use layer</button>}
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <button onClick={onSwap} style={{ padding: "2px 10px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 10 }}>⇄ Swap source / target</button>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <span style={{ fontSize: 10, opacity: 0.7 }}>Matched preview {showOriginal && <span style={{ color: "#e80" }}>· showing original</span>}</span>
        <button
          onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)}
          onTouchStart={() => setShowOriginal(true)} onTouchEnd={() => setShowOriginal(false)}
          style={{ padding: "1px 8px", background: showOriginal ? "#e80" : "transparent", color: showOriginal ? "white" : "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 }}
        >Hold for A/B</button>
      </div>
      <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} imgHandleRef={matchedHandleRef} hideSelector fitAspect />

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
      <CurvesGraph curves={renderedCurves} />

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {slider("Amount",     amountRef,  amountLabel,  setAmountLabel,  0, 100, "%")}
        {slider("Smoothing",  smoothRef,  smoothLabel,  setSmoothLabel,  0,  32)}
        {slider("Max stretch",stretchRef, stretchLabel, setStretchLabel, 1,  32)}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginTop: 2, cursor: "pointer", opacity: 0.85 }}>
        <input type="checkbox" checked={chromaOnly} onChange={e => setChromaOnly(e.target.checked)} />
        Chroma only (preserve target luminance)
      </label>

      <div style={{ borderTop: "1px solid #444", margin: "8px 0 4px" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, opacity: 0.7 }}>
        <span>Post-fit dimension warps (defaults = no change)</span>
        <button onClick={() => { dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS }); scheduleRedraw(); }} style={tinyBtn}>Reset</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {dimSlider("Value",       "value",      0, 200, "%")}
        {dimSlider("Chroma",      "chroma",     0, 200, "%")}
        {dimSlider("Hue shift",   "hueShift", -180, 180, "°")}
        {dimSlider("Contrast",    "contrast",   1, 200, "%")}
        {dimSlider("Neutralize",  "neutralize", 0, 100, "%")}
        {dimSlider("Separation",  "separation", 0, 200, "%")}
      </div>

      <div style={{ borderTop: "1px solid #444", margin: "8px 0 4px" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, opacity: 0.7 }}>
        <span>Zone targeting (per-zone amount / anchor / falloff)</span>
        <button onClick={() => { zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES }); scheduleRedraw(); }} style={tinyBtn}>Reset</button>
      </div>
      {(["shadows", "mids", "highlights"] as const).map(zone => (
        <div key={zone} style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4 }}>
          <span style={{ fontSize: 10, opacity: 0.6, textTransform: "capitalize" }}>{zone}</span>
          {zoneSlider("Amount", zone, 0, 200, "%")}
          {zoneSlider("Anchor", `${zone}Anchor` as keyof ZoneOpts, 0, 255, "")}
          {zoneSlider("Falloff", `${zone}Falloff` as keyof ZoneOpts, 0, 100, "%")}
        </div>
      ))}

      <button onClick={onApply} style={btn}>Apply Match (1 Curves layer)</button>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
