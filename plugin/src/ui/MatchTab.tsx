// Color-match tab. One Curves layer fitted via per-channel histogram specification.
// Captures range, contrast, value, and color cast in a single editable node.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane, PreviewImgHandle } from "./PreviewPane";
import { fitHistogramCurves, blendWithIdentity, applyChannelCurvesToRgba } from "../core/histogramMatch";
import { applyMatch } from "../app/applyMatch";

export function MatchTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const [amountLabel, setAmountLabel] = useState(100);
  const [status, setStatus] = useState("Pick source + target.");

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(sourceId);
  const tgt = useLayerPreview(targetId);

  // Fit curves from preview pixels (cheap; runs whenever snapshots change).
  const fittedRaw = useMemo(() => {
    if (!src.snap || !tgt.snap) return null;
    return fitHistogramCurves(src.snap.data, tgt.snap.data);
  }, [src.snap, tgt.snap]);

  const matchedHandleRef = useRef<PreviewImgHandle | null>(null);
  const rafPendingRef = useRef(false);

  const redrawMatched = () => {
    if (!fittedRaw || !tgt.snap || !matchedHandleRef.current) return;
    const a = amountRef.current / 100;
    const c = {
      r: blendWithIdentity(fittedRaw.r, a),
      g: blendWithIdentity(fittedRaw.g, a),
      b: blendWithIdentity(fittedRaw.b, a),
    };
    const out = applyChannelCurvesToRgba(tgt.snap.data, c);
    matchedHandleRef.current.setPixels(out, tgt.snap.width, tgt.snap.height);
  };

  const scheduleRedraw = () => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => { rafPendingRef.current = false; redrawMatched(); });
  };

  useEffect(() => { scheduleRedraw(); }, [fittedRaw, tgt.snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const onApply = async () => {
    if (sourceId == null || targetId == null) { setStatus("Pick layers."); return; }
    setStatus("Applying match...");
    try { setStatus(await applyMatch({ sourceLayerId: sourceId, targetLayerId: targetId, amount: amountRef.current / 100 })); }
    catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 6, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <PreviewPane label="Source" layers={layers} selectedId={sourceId} onSelect={setSourceId} snapshot={src.snap} onRefresh={src.refresh} height={120} />
        <PreviewPane label="Target" layers={layers} selectedId={targetId} onSelect={setTargetId} snapshot={tgt.snap} onRefresh={tgt.refresh} height={120} />
      </div>

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Matched preview</div>
      <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} imgHandleRef={matchedHandleRef} hideSelector fitAspect />

      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginTop: 4 }}>
        <span style={{ width: 64, opacity: 0.7 }}>Amount</span>
        <input type="range" min={0} max={100} defaultValue={100}
          onInput={e => {
            const v = Number((e.target as HTMLInputElement).value);
            amountRef.current = v;
            setAmountLabel(v);
            scheduleRedraw();
          }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{amountLabel}%</span>
      </div>

      <button onClick={onApply} style={btn}>Apply Match (1 Curves layer)</button>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
