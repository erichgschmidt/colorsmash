import { useEffect, useRef, useState } from "react";
import { applyTransfer } from "../app/applyTransfer";
import { applyAsLut } from "../app/applyAsLut";
import { applyAsStack } from "../app/applyAsStack";
import { validateStack } from "../app/validateStack";
import { probeLayers } from "../app/probeLayers";
import { calibrateCB } from "../app/calibrateCB";
import { runRoundTrip } from "../app/runRoundTrip";
import { exportCube } from "../app/exportCube";
import { useLayers } from "./useLayers";

function Slider(props: { label: string; defaultValue: number; valueRef: React.MutableRefObject<number> }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7, flexShrink: 0 }}>{props.label}</span>
      <input
        type="range" min={0} max={100} defaultValue={props.defaultValue}
        onInput={e => {
          const v = Number((e.target as HTMLInputElement).value);
          props.valueRef.current = v;
          if (labelRef.current) labelRef.current.textContent = `${v}%`;
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span ref={labelRef} style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{props.defaultValue}%</span>
    </div>
  );
}

export function TransferTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [quality, setQuality] = useState<"draft" | "robust">("draft");
  const [showDebug, setShowDebug] = useState(false);
  const [status, setStatus] = useState("Ready");

  const amountRef = useRef(80);
  const lumRef = useRef(100);
  const chromaRef = useRef(100);
  const neutRef = useRef(0);

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildWeights = () => ({
    amount: amountRef.current / 100,
    luminance: lumRef.current / 100,
    chroma: chromaRef.current / 100,
    neutralize: neutRef.current / 100,
  });

  const wrap = (label: string, fn: () => Promise<string>) => async () => {
    setStatus(`${label}...`);
    try { setStatus(await fn()); }
    catch (e) { setStatus(`Error: ${(e as Error).message}`); }
  };

  const onApplyStack = async () => {
    if (sourceId == null || targetId == null) { setStatus("Pick layers."); return; }
    setStatus(quality === "robust" ? "Applying (robust mode — slower)..." : "Applying...");
    try { setStatus(await applyAsStack({ sourceLayerId: sourceId, targetLayerId: targetId, weights: buildWeights() })); }
    catch (e) { setStatus(`Error: ${(e as Error).message}`); }
  };

  const onApplyExact = wrap("Applying baked", async () => {
    if (sourceId == null || targetId == null) throw new Error("Pick layers.");
    return await applyTransfer({ sourceLayerId: sourceId, targetLayerId: targetId, weights: buildWeights() });
  });

  const onExport = wrap("Exporting LUT", async () => {
    if (sourceId == null || targetId == null) throw new Error("Pick layers.");
    return await exportCube({ sourceLayerId: sourceId, targetLayerId: targetId, size: 33, weights: buildWeights() });
  });

  const onApplyLut = wrap("Installing LUT", async () => {
    if (sourceId == null || targetId == null) throw new Error("Pick layers.");
    return await applyAsLut({ sourceLayerId: sourceId, targetLayerId: targetId, weights: buildWeights() });
  });

  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11 };
  const lbl: React.CSSProperties = { width: 64, opacity: 0.7, flexShrink: 0 };
  const sel: React.CSSProperties = { flex: 1, padding: "2px 4px", fontSize: 11, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" };
  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 4, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };
  const btnSecondary: React.CSSProperties = { ...btn, background: "transparent", color: "#aaa", border: "1px solid #555" };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={row}>
        <span style={lbl}>Source</span>
        <select style={sel} value={sourceId ?? ""} onChange={e => setSourceId(Number(e.target.value))}>
          {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div style={row}>
        <span style={lbl}>Target</span>
        <select style={sel} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}>
          {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      <div style={{ borderTop: "1px solid #444", margin: "6px 0 4px" }} />

      <Slider label="Amount" defaultValue={80} valueRef={amountRef} />
      <Slider label="Luminance" defaultValue={100} valueRef={lumRef} />
      <Slider label="Color Int." defaultValue={100} valueRef={chromaRef} />
      <Slider label="Neutralize" defaultValue={0} valueRef={neutRef} />

      <div style={{ ...row, marginTop: 6 }}>
        <span style={lbl}>Quality</span>
        <select style={sel} value={quality} onChange={e => setQuality(e.target.value as "draft" | "robust")}>
          <option value="draft">Draft (fast)</option>
          <option value="robust" disabled>Robust (slow, in dev)</option>
        </select>
      </div>

      <button onClick={onApplyStack} style={btn}>Apply (editable stack)</button>
      <button onClick={onApplyExact} style={btnSecondary}>Apply (baked pixels — exact)</button>
      <button onClick={onExport} style={btnSecondary}>Export .cube (33³)</button>

      <div style={{ marginTop: 10, fontSize: 10 }}>
        <label style={{ cursor: "pointer", opacity: 0.6 }}>
          <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} /> Show debug tools
        </label>
      </div>
      {showDebug && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          <button onClick={onApplyLut} style={btnSecondary}>Apply (LUT layer — experimental)</button>
          <button onClick={wrap("Validating", async () => {
            if (sourceId == null || targetId == null) throw new Error("Pick layers.");
            return await validateStack({ sourceLayerId: sourceId, targetLayerId: targetId, weights: buildWeights() });
          })} style={btnSecondary}>Validate (sim vs PS)</button>
          <button onClick={wrap("Probing", async () => {
            if (targetId == null) throw new Error("Pick target.");
            return await probeLayers({ targetLayerId: targetId });
          })} style={btnSecondary}>Probe per-layer</button>
          <button onClick={wrap("Calibrating", () => calibrateCB())} style={btnSecondary}>Calibrate CB</button>
          <button onClick={wrap("Round-trip", () => runRoundTrip())} style={btnSecondary}>Round-trip top layer</button>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
