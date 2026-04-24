// Compact zone control: one horizontal track per zone with 3 thumbs
// (left-edge, anchor center, right-edge). Drag anchor to move the whole zone.
// Drag either edge to widen/narrow falloff (symmetric). Amount slider on the right.

import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

export interface ZoneCompoundValue {
  amount: number;   // 0..200
  anchor: number;   // 0..255
  falloff: number;  // 0..100
  bias: number;     // -100..100, competitive pressure vs other zones
}

export interface ZoneCompoundSliderProps {
  label: string;
  color: string;        // band color
  value: ZoneCompoundValue;
  defaults?: ZoneCompoundValue;
  onChange: (next: ZoneCompoundValue) => void;
}

// Map falloff (0..100) -> half-width on the 0..255 track. Mirrors histogramMatch.ts sigma scale.
function falloffToHalfWidth(falloff: number): number {
  const sigma = 18 + (falloff / 100) * 60;  // 18..78 — matches buildZoneWeights sigma
  return Math.min(127, sigma);
}
function halfWidthToFalloff(hw: number): number {
  const sigma = Math.max(18, Math.min(78, hw));
  return ((sigma - 18) / 60) * 100;
}

export function ZoneCompoundSlider(props: ZoneCompoundSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<ZoneCompoundValue>({ ...props.value });

  // Keep ref in sync with prop changes (reset etc).
  useEffect(() => { valueRef.current = { ...props.value }; }, [props.value]);

  const trackPctOfValue = (v: number) => (v / 255) * 100;

  const onTrackPointerDown = (mode: "anchor" | "leftEdge" | "rightEdge") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const move = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      let pct = ((clientX - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      const v = (pct / 100) * 255;

      const cur = valueRef.current;
      let next: ZoneCompoundValue;
      if (mode === "anchor") {
        next = { ...cur, anchor: Math.round(v) };
      } else {
        const dist = Math.abs(v - cur.anchor);
        next = { ...cur, falloff: Math.round(halfWidthToFalloff(dist)) };
      }
      valueRef.current = next;
      props.onChange(next);
    };

    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = (ev: PointerEvent) => {
      try { (e.target as Element).releasePointerCapture?.(ev.pointerId); } catch { /* */ }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    move(e.clientX);
  };

  const halfWidth = falloffToHalfWidth(props.value.falloff);
  const leftEdge = Math.max(0, props.value.anchor - halfWidth);
  const rightEdge = Math.min(255, props.value.anchor + halfWidth);
  const bandStartPct = trackPctOfValue(leftEdge);
  const bandEndPct = trackPctOfValue(rightEdge);
  const anchorPct = trackPctOfValue(props.value.anchor);
  // Amount shown as opacity of band (0% = invisible band, 200% = fully opaque).
  const bandOpacity = Math.min(1, props.value.amount / 100) * 0.55;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4, fontSize: 10 }}>
      {/* Row 1: amount slider | bias slider | reset — label is implicit (band color + tooltip) */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }} title={`${props.label} — amount % and bias`}>
        <input type="range" min={0} max={200} value={props.value.amount} tabIndex={-1}
          onInput={e => {
            const v = Math.round(Number((e.target as HTMLInputElement).value));
            valueRef.current = { ...valueRef.current, amount: v };
            props.onChange(valueRef.current);
          }}
          onFocus={e => e.currentTarget.blur()}
          title={`${props.label} amount: ${props.value.amount}%`}
          style={{ flex: 1, minWidth: 24 }} />
        <span style={{ width: 28, textAlign: "right", opacity: 0.8, fontSize: 9 }}>{props.value.amount}%</span>
        <input type="range" min={-100} max={100} value={props.value.bias} tabIndex={-1}
          onInput={e => {
            const v = Math.round(Number((e.target as HTMLInputElement).value));
            valueRef.current = { ...valueRef.current, bias: v };
            props.onChange(valueRef.current);
          }}
          onDoubleClick={() => {
            valueRef.current = { ...valueRef.current, bias: 0 };
            props.onChange(valueRef.current);
          }}
          onFocus={e => e.currentTarget.blur()}
          title={`${props.label} bias: ${props.value.bias > 0 ? "+" : ""}${props.value.bias} — positive grows this zone at neighbors' expense; double-click to reset`}
          style={{ flex: 1, minWidth: 24, height: 10 }} />
        <span style={{ width: 22, textAlign: "right", opacity: 0.6, fontSize: 9 }}>{props.value.bias > 0 ? "+" : ""}{props.value.bias}</span>
        {props.defaults && (
          <button onClick={() => { valueRef.current = { ...props.defaults! }; props.onChange({ ...props.defaults! }); }}
            title={`Reset ${props.label} zone`}
            style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                     background: "transparent", color: "#888", border: "1px solid #444", borderRadius: 2, cursor: "pointer", flexShrink: 0, boxSizing: "border-box" }}><Icon name="revert" size={11} /></button>
        )}
      </div>
      {/* Row 2: full-width multi-thumb anchor + falloff track */}
      <div ref={trackRef}
        style={{
          height: 18, position: "relative", background: "#222",
          border: "1px solid #444", borderRadius: 9, overflow: "hidden", touchAction: "none",
        }}>
        <div style={{
          position: "absolute", top: 0, bottom: 0,
          left: `${bandStartPct}%`, width: `${Math.max(0, bandEndPct - bandStartPct)}%`,
          background: props.color, opacity: bandOpacity, pointerEvents: "none",
        }} />
        <div onPointerDown={onTrackPointerDown("leftEdge")}
          style={{
            position: "absolute", top: "50%", left: `${bandStartPct}%`,
            transform: "translate(-50%, -50%)",
            width: 6, height: 14, background: props.color, opacity: 0.8,
            border: "1px solid #111", borderRadius: 2, cursor: "ew-resize",
          }} title={`falloff edge (${Math.round(leftEdge)})`} />
        <div onPointerDown={onTrackPointerDown("rightEdge")}
          style={{
            position: "absolute", top: "50%", left: `${bandEndPct}%`,
            transform: "translate(-50%, -50%)",
            width: 6, height: 14, background: props.color, opacity: 0.8,
            border: "1px solid #111", borderRadius: 2, cursor: "ew-resize",
          }} title={`falloff edge (${Math.round(rightEdge)})`} />
        <div onPointerDown={onTrackPointerDown("anchor")}
          style={{
            position: "absolute", top: "50%", left: `${anchorPct}%`,
            transform: "translate(-50%, -50%)",
            width: 14, height: 14, background: "#ddd", border: "2px solid #111",
            borderRadius: "50%", cursor: "ew-resize", zIndex: 2,
          }} title={`anchor (${props.value.anchor})`} />
      </div>
    </div>
  );
}
