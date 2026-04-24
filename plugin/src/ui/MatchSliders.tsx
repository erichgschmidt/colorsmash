// Slider helpers + shared styles for MatchTab. Extracted to keep MatchTab lean.

import React, { useRef } from "react";
import { Icon } from "./Icon";
import { DimensionOpts, DEFAULT_DIMENSIONS } from "../core/histogramMatch";

export const matchStyles = {
  tinyBtn: { padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 } as React.CSSProperties,
  sel: {
    width: "100%", display: "block", padding: "2px 4px", fontSize: 10,
    background: "#333", color: "#dddddd", border: "1px solid #555",
    margin: 0, boxSizing: "border-box", appearance: "none" as any, WebkitAppearance: "none" as any,
    fontWeight: 600,
  } as React.CSSProperties,
  numInput: {
    width: 38, padding: "1px 3px", fontSize: 10, textAlign: "right",
    background: "#404040", color: "#dddddd",
    border: "1px solid #6e6e6e", borderRadius: 2,
    boxSizing: "border-box", height: 18, lineHeight: "14px", margin: 0,
    // Strip browser-default input chrome (inset shadows, spinners, focus ring).
    appearance: "none" as any,
    WebkitAppearance: "none" as any,
    MozAppearance: "textfield" as any,
    outline: "none",
    boxShadow: "none",
    verticalAlign: "middle",
  } as React.CSSProperties,
  resetIconBtn: {
    width: 16, height: 16, padding: 0, lineHeight: "14px", fontSize: 10, textAlign: "center",
    background: "transparent", color: "#888", border: "1px solid #444", borderRadius: 2, cursor: "pointer",
    flexShrink: 0, boxSizing: "border-box",
  } as React.CSSProperties,
};

export interface BasicSliderProps {
  label: string;
  refObj: React.MutableRefObject<number>;
  value: number;
  setValue: (n: number) => void;
  min: number;
  max: number;
  suffix?: string;
  defaultVal?: number;
  scheduleRedraw: () => void;
}

export function BasicSlider(props: BasicSliderProps) {
  const { label, refObj, value, setValue, min, max, suffix = "", defaultVal, scheduleRedraw } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reset = () => {
    if (defaultVal == null) return;
    refObj.current = defaultVal; setValue(defaultVal);
    if (inputRef.current) inputRef.current.value = String(defaultVal);
    scheduleRedraw();
  };
  const setFromTyped = (raw: string) => {
    const v = Math.max(min, Math.min(max, Math.round(Number(raw) || 0)));
    refObj.current = v; setValue(v);
    if (inputRef.current) inputRef.current.value = String(v);
    scheduleRedraw();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, fontSize: 11, marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0 }}>
        <span style={{ opacity: 0.75 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <input type="number" min={min} max={max} value={value}
            onChange={e => setFromTyped(e.target.value)}
            style={matchStyles.numInput} />
          {suffix && <span style={{ opacity: 0.7, fontSize: 10, marginLeft: 1 }}>{suffix}</span>}
          {defaultVal != null && <button onClick={reset} title={`Reset to ${defaultVal}${suffix}`} style={matchStyles.resetIconBtn}><Icon name="revert" size={11} /></button>}
        </div>
      </div>
      <input type="range" min={min} max={max} defaultValue={value}
        ref={el => { inputRef.current = el; }}
        onInput={e => { const v = Math.round(Number((e.target as HTMLInputElement).value)); refObj.current = v; setValue(v); scheduleRedraw(); }}
        style={{ width: "calc(100% + 16px)", marginLeft: -8, marginTop: -2, marginBottom: -2 }} />
    </div>
  );
}

export interface DimSliderProps {
  label: string;
  dimKey: keyof DimensionOpts;
  min: number;
  max: number;
  suffix?: string;
  dimsLabel: DimensionOpts;
  dimsRef: React.MutableRefObject<DimensionOpts>;
  setDimsLabel: React.Dispatch<React.SetStateAction<DimensionOpts>>;
  scheduleRedraw: () => void;
}

export function DimSlider(props: DimSliderProps) {
  const { label, dimKey, min, max, suffix = "", dimsLabel, dimsRef, setDimsLabel, scheduleRedraw } = props;
  const value = dimsLabel[dimKey];
  const def = DEFAULT_DIMENSIONS[dimKey];
  const reset = () => {
    dimsRef.current = { ...dimsRef.current, [dimKey]: def };
    setDimsLabel(d => ({ ...d, [dimKey]: def }));
    scheduleRedraw();
  };
  const setFromTyped = (raw: string) => {
    const v = Math.max(min, Math.min(max, Math.round(Number(raw) || 0)));
    dimsRef.current = { ...dimsRef.current, [dimKey]: v };
    setDimsLabel(d => ({ ...d, [dimKey]: v }));
    scheduleRedraw();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, fontSize: 11, marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0 }}>
        <span style={{ opacity: 0.75 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <input type="number" min={min} max={max} value={value}
            onChange={e => setFromTyped(e.target.value)}
            style={matchStyles.numInput} />
          {suffix && <span style={{ opacity: 0.7, fontSize: 10, marginLeft: 1 }}>{suffix}</span>}
          <button onClick={reset} title={`Reset to ${def}${suffix}`} style={matchStyles.resetIconBtn}><Icon name="revert" size={11} /></button>
        </div>
      </div>
      <input type="range" min={min} max={max} value={value}
        onInput={e => { const v = Math.round(Number((e.target as HTMLInputElement).value)); dimsRef.current = { ...dimsRef.current, [dimKey]: v }; setDimsLabel(d => ({ ...d, [dimKey]: v })); scheduleRedraw(); }}
        style={{ width: "calc(100% + 16px)", marginLeft: -8, marginTop: -2, marginBottom: -2 }} />
    </div>
  );
}
