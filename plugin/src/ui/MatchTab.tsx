// Color-match tab. One Curves layer fitted via per-channel histogram specification.
// Captures range, contrast, value, and color cast in a single editable node.
// Controls: amount, smoothing (anti-banding), stretch cap, chroma-only.

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

export function MatchTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const smoothRef = useRef(0);
  const stretchRef = useRef(8); // 8 = generous default; visually identity-ish for typical fits
  const [chromaOnly, setChromaOnly] = useState(false);
  const [amountLabel, setAmountLabel] = useState(100);
  const [smoothLabel, setSmoothLabel] = useState(0);
  const [stretchLabel, setStretchLabel] = useState(8);
  const [status, setStatus] = useState("Pick source + target.");

  // Post-fit dimension warps. All defaults = identity (no change to base match).
  const dimsRef = useRef<DimensionOpts>({ ...DEFAULT_DIMENSIONS });
  const [dimsLabel, setDimsLabel] = useState<DimensionOpts>({ ...DEFAULT_DIMENSIONS });

  // Zone-targeted weights. Defaults give partition-of-unity = identity behavior.
  const zonesRef = useRef<ZoneOpts>({ ...DEFAULT_ZONES });
  const [zonesLabel, setZonesLabel] = useState<ZoneOpts>({ ...DEFAULT_ZONES });

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(sourceId);
  const tgt = useLayerPreview(targetId);

  const fittedRaw = useMemo(() => {
    if (!src.snap || !tgt.snap) return null;
    return fitHistogramCurves(src.snap.data, tgt.snap.data);
  }, [src.snap, tgt.snap]);

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
    const a = sourceId, b = targetId;
    setSourceId(b); setTargetId(a);
  };

  const onApply = async () => {
    if (sourceId == null || targetId == null) { setStatus("Pick layers."); return; }
    setStatus("Applying match...");
    try {
      setStatus(await applyMatch({
        sourceLayerId: sourceId,
        targetLayerId: targetId,
        amount: amountRef.current / 100,
        smoothRadius: smoothRef.current,
        maxStretch: stretchRef.current,
        chromaOnly,
        dimensions: dimsRef.current,
        zones: zonesRef.current,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 6, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };

  const slider = (
    label: string, ref: React.MutableRefObject<number>, value: number, setValue: (n: number) => void,
    min: number, max: number, suffix = "",
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
      <input type="range" min={min} max={max} defaultValue={value}
        onInput={e => {
          const v = Number((e.target as HTMLInputElement).value);
          ref.current = v; setValue(v); scheduleRedraw();
        }}
        style={{ flex: 1, minWidth: 0 }} />
      <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
    </div>
  );

  const zoneSlider = (
    label: string, key: keyof ZoneOpts, min: number, max: number, suffix = "",
  ) => {
    const value = zonesLabel[key];
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 80, opacity: 0.7 }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => {
            const v = Number((e.target as HTMLInputElement).value);
            zonesRef.current = { ...zonesRef.current, [key]: v };
            setZonesLabel(z => ({ ...z, [key]: v }));
            scheduleRedraw();
          }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 40, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
      </div>
    );
  };

  const dimSlider = (
    label: string, key: keyof DimensionOpts, min: number, max: number, suffix = "",
  ) => {
    const value = dimsLabel[key];
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => {
            const v = Number((e.target as HTMLInputElement).value);
            dimsRef.current = { ...dimsRef.current, [key]: v };
            setDimsLabel(d => ({ ...d, [key]: v }));
            scheduleRedraw();
          }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 40, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
      </div>
    );
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <PreviewPane label="Source" layers={layers} selectedId={sourceId} onSelect={setSourceId} snapshot={src.snap} onRefresh={src.refresh} height={120} />
        <PreviewPane label="Target" layers={layers} selectedId={targetId} onSelect={setTargetId} snapshot={tgt.snap} onRefresh={tgt.refresh} height={120} />
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
        <button onClick={() => {
          dimsRef.current = { ...DEFAULT_DIMENSIONS };
          setDimsLabel({ ...DEFAULT_DIMENSIONS });
          scheduleRedraw();
        }} style={{ padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 }}>Reset</button>
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
        <span>Zone targeting (modulates match strength by input range)</span>
        <button onClick={() => {
          zonesRef.current = { ...DEFAULT_ZONES };
          setZonesLabel({ ...DEFAULT_ZONES });
          scheduleRedraw();
        }} style={{ padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 }}>Reset</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {zoneSlider("Shadows",    "shadows",    0, 200, "%")}
        {zoneSlider("Mids",       "mids",       0, 200, "%")}
        {zoneSlider("Highlights", "highlights", 0, 200, "%")}
        {zoneSlider("Falloff",    "falloff",    0, 100, "%")}
      </div>

      <button onClick={onApply} style={btn}>Apply Match (1 Curves layer)</button>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
