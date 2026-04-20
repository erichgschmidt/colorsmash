// Multi-thumb slider: 3 zone thumbs on one track. Uncontrolled (writes through callbacks),
// crash-safe (no React state during drag — DOM positioning + ref-based value notification).

import { useEffect, useRef } from "react";

export type ZoneKey = "shadows" | "midtones" | "highlights";
export const ZONE_COLORS: Record<ZoneKey, string> = {
  shadows:    "#4a7fc1",   // blue
  midtones:   "#bbb",      // gray
  highlights: "#e0b85a",   // amber
};
const ZONE_ORDER: ZoneKey[] = ["shadows", "midtones", "highlights"];

export interface MultiThumbSliderProps {
  label: string;
  min: number;
  max: number;
  values: Record<ZoneKey, number>;          // current per-zone value (initial; not re-read)
  onChange: (zone: ZoneKey, value: number) => void;
  cascade?: boolean;                         // if true, dragging one thumb pushes neighbors
                                             // (used for range sliders)
  activeZone?: ZoneKey;                      // visual emphasis only
}

export function MultiThumbSlider(props: MultiThumbSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef<Record<ZoneKey, number>>({ ...props.values });
  const thumbRefs = useRef<Record<ZoneKey, HTMLDivElement | null>>({ shadows: null, midtones: null, highlights: null });
  const labelValueRef = useRef<HTMLSpanElement>(null);

  const valueToPct = (v: number) => ((v - props.min) / (props.max - props.min)) * 100;
  const pctToValue = (p: number) => props.min + (p / 100) * (props.max - props.min);

  const renderThumb = (zone: ZoneKey) => {
    const el = thumbRefs.current[zone];
    if (!el) return;
    el.style.left = `${valueToPct(valuesRef.current[zone])}%`;
  };

  const renderAll = () => ZONE_ORDER.forEach(renderThumb);

  // Re-sync from props.values whenever they change (e.g. zone tab switch / reset).
  useEffect(() => {
    valuesRef.current = { ...props.values };
    renderAll();
    if (labelValueRef.current && props.activeZone) {
      labelValueRef.current.textContent = String(Math.round(valuesRef.current[props.activeZone]));
    }
  }, [props.values, props.activeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (zone: ZoneKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    const track = trackRef.current;
    if (!track) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const move = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      let pct = ((clientX - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      let v = pctToValue(pct);
      v = Math.round(v);

      // Cascade for range sliders: enforce ordering shadows ≤ midtones ≤ highlights.
      if (props.cascade) {
        const cur = valuesRef.current;
        if (zone === "shadows") {
          if (v > cur.midtones) cur.midtones = v;
          if (cur.midtones > cur.highlights) cur.highlights = cur.midtones;
        } else if (zone === "midtones") {
          if (v < cur.shadows) cur.shadows = v;
          if (v > cur.highlights) cur.highlights = v;
        } else {
          if (v < cur.midtones) cur.midtones = v;
          if (cur.midtones < cur.shadows) cur.shadows = cur.midtones;
        }
      }
      valuesRef.current[zone] = v;
      renderAll();
      if (labelValueRef.current && props.activeZone === zone) labelValueRef.current.textContent = String(v);

      // Notify parent for every changed zone in case cascade pushed others.
      ZONE_ORDER.forEach(z => props.onChange(z, valuesRef.current[z]));
    };

    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = (ev: PointerEvent) => {
      try { (e.target as Element).releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    move(e.clientX);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7, flexShrink: 0 }}>{props.label}</span>
      <div ref={trackRef}
        style={{
          flex: 1, height: 18, position: "relative", background: "#333",
          border: "1px solid #444", borderRadius: 9,
        }}
      >
        {ZONE_ORDER.map(zone => {
          const isActive = props.activeZone === zone;
          const size = isActive ? 16 : 12;
          return (
            <div
              key={zone}
              ref={el => { thumbRefs.current[zone] = el; }}
              onPointerDown={onPointerDown(zone)}
              title={`${zone}: ${valuesRef.current[zone]}`}
              style={{
                position: "absolute",
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: size, height: size, borderRadius: "50%",
                background: ZONE_COLORS[zone],
                border: isActive ? "2px solid white" : "1px solid #222",
                cursor: "ew-resize",
                touchAction: "none",
                zIndex: isActive ? 3 : zone === "midtones" ? 2 : 1,
                left: `${valueToPct(valuesRef.current[zone])}%`,
              }}
            />
          );
        })}
      </div>
      <span ref={labelValueRef}
        style={{ width: 36, textAlign: "right", opacity: 0.8 }}>
        {props.activeZone ? Math.round(valuesRef.current[props.activeZone]) : ""}
      </span>
    </div>
  );
}
