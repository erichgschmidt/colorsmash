// Color-match tab. One Curves layer fitted via per-channel histogram specification.
// Captures range, contrast, value, and color cast in a single editable node.
// Controls: amount, smoothing (anti-banding), stretch cap, chroma-only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane, PreviewImgHandle } from "./PreviewPane";
import {
  fitHistogramCurves, processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
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

  const redrawMatched = () => {
    if (!fittedRaw || !tgt.snap || !matchedHandleRef.current) return;
    const c = processChannelCurves(fittedRaw, {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
    });
    let out = applyChannelCurvesToRgba(tgt.snap.data, c);
    if (chromaOnly) out = applyChromaOnly(tgt.snap.data, out);
    matchedHandleRef.current.setPixels(out, tgt.snap.width, tgt.snap.height);
  };

  const scheduleRedraw = () => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => { rafPendingRef.current = false; redrawMatched(); });
  };

  useEffect(() => { scheduleRedraw(); }, [fittedRaw, tgt.snap, chromaOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <PreviewPane label="Source" layers={layers} selectedId={sourceId} onSelect={setSourceId} snapshot={src.snap} onRefresh={src.refresh} height={120} />
        <PreviewPane label="Target" layers={layers} selectedId={targetId} onSelect={setTargetId} snapshot={tgt.snap} onRefresh={tgt.refresh} height={120} />
      </div>

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Matched preview</div>
      <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} imgHandleRef={matchedHandleRef} hideSelector fitAspect />

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {slider("Amount",     amountRef,  amountLabel,  setAmountLabel,  0, 100, "%")}
        {slider("Smoothing",  smoothRef,  smoothLabel,  setSmoothLabel,  0,  32)}
        {slider("Max stretch",stretchRef, stretchLabel, setStretchLabel, 1,  32)}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginTop: 2, cursor: "pointer", opacity: 0.85 }}>
        <input type="checkbox" checked={chromaOnly} onChange={e => setChromaOnly(e.target.checked)} />
        Chroma only (preserve target luminance)
      </label>

      <button onClick={onApply} style={btn}>Apply Match (1 Curves layer)</button>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
