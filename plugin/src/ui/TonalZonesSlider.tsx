// Unified tonal-zones slider. Four boundary thumbs (T1, T2, T3, T4) define three colored zones:
//   shadows:    [0, T1] core, fading out across [T1, T2]
//   midtones:   fading in across [T1, T2], core [T2, T3], fading out across [T3, T4]
//   highlights: fading in across [T3, T4], core [T4, 100]
// Constraints enforced on drag: T1 ≤ T2 ≤ T3 ≤ T4. The gap T1→T2 is the shadow↔mid feather;
// the gap T3→T4 is the mid↔highlight feather. Zones never touch core ranges of neighbors.

import { useEffect, useRef } from "react";
import { ZONE_COLORS } from "./MultiThumbSlider";

export interface TonalBounds { t1: number; t2: number; t3: number; t4: number }
type Handle = "t1" | "t2" | "t3" | "t4";
const HANDLES: Handle[] = ["t1", "t2", "t3", "t4"];
const HANDLE_LABEL: Record<Handle, string> = {
  t1: "shadow→mid (start of feather)",
  t2: "shadow→mid (end of feather, mid core start)",
  t3: "mid→highlight (mid core end, start of feather)",
  t4: "mid→highlight (end of feather, highlight core)",
};

export interface TonalZonesSliderProps {
  bounds: TonalBounds;
  onChange: (b: TonalBounds) => void;
}

export function TonalZonesSlider(props: TonalZonesSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<TonalBounds>({ ...props.bounds });
  const handleRefs = useRef<Record<Handle, HTMLDivElement | null>>({ t1: null, t2: null, t3: null, t4: null });
  const bandRefs = useRef<{ shadows: HTMLDivElement | null; midtones: HTMLDivElement | null; highlights: HTMLDivElement | null; sToM: HTMLDivElement | null; mToH: HTMLDivElement | null }>({
    shadows: null, midtones: null, highlights: null, sToM: null, mToH: null,
  });

  const layout = () => {
    const b = boundsRef.current;
    HANDLES.forEach(h => {
      const el = handleRefs.current[h];
      if (el) el.style.left = `${b[h]}%`;
    });
    const setBand = (el: HTMLDivElement | null, start: number, end: number) => {
      if (!el) return;
      el.style.left = `${start}%`;
      el.style.width = `${Math.max(0, end - start)}%`;
    };
    setBand(bandRefs.current.shadows,    0,   b.t1);
    setBand(bandRefs.current.sToM,       b.t1, b.t2);
    setBand(bandRefs.current.midtones,   b.t2, b.t3);
    setBand(bandRefs.current.mToH,       b.t3, b.t4);
    setBand(bandRefs.current.highlights, b.t4, 100);
  };

  useEffect(() => {
    boundsRef.current = { ...props.bounds };
    layout();
  });

  const onPointerDown = (h: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    const track = trackRef.current;
    if (!track) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      let pct = ((clientX - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      const v = Math.round(pct);
      const b = boundsRef.current;
      if (h === "t1") {
        b.t1 = v;
        if (b.t1 > b.t2) b.t2 = b.t1;
        if (b.t2 > b.t3) b.t3 = b.t2;
        if (b.t3 > b.t4) b.t4 = b.t3;
      } else if (h === "t2") {
        b.t2 = v;
        if (b.t2 < b.t1) b.t1 = b.t2;
        if (b.t2 > b.t3) b.t3 = b.t2;
        if (b.t3 > b.t4) b.t4 = b.t3;
      } else if (h === "t3") {
        b.t3 = v;
        if (b.t3 < b.t2) b.t2 = b.t3;
        if (b.t2 < b.t1) b.t1 = b.t2;
        if (b.t3 > b.t4) b.t4 = b.t3;
      } else {
        b.t4 = v;
        if (b.t4 < b.t3) b.t3 = b.t4;
        if (b.t3 < b.t2) b.t2 = b.t3;
        if (b.t2 < b.t1) b.t1 = b.t2;
      }
      layout();
      props.onChange({ ...b });
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

  // Track is taller to fit the 3 zone bands + handles + tick guides.
  return (
    <div style={{ marginBottom: 6, fontSize: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2, opacity: 0.65 }}>
        <span>Tonal zones</span>
        <span style={{ fontSize: 9 }}>blue = shadows · gray = mids · amber = highlights · gradient = feather</span>
      </div>
      <div ref={trackRef}
        style={{
          position: "relative", height: 28, background: "#222",
          border: "1px solid #444", borderRadius: 4, overflow: "hidden",
        }}>
        {/* zone bands */}
        <div ref={el => { bandRefs.current.shadows = el; }} style={bandStyle(ZONE_COLORS.shadows)} />
        <div ref={el => { bandRefs.current.sToM = el; }} style={featherStyle(ZONE_COLORS.shadows, ZONE_COLORS.midtones)} />
        <div ref={el => { bandRefs.current.midtones = el; }} style={bandStyle(ZONE_COLORS.midtones)} />
        <div ref={el => { bandRefs.current.mToH = el; }} style={featherStyle(ZONE_COLORS.midtones, ZONE_COLORS.highlights)} />
        <div ref={el => { bandRefs.current.highlights = el; }} style={bandStyle(ZONE_COLORS.highlights)} />
        {/* handles */}
        {HANDLES.map(h => (
          <div key={h}
            ref={el => { handleRefs.current[h] = el; }}
            onPointerDown={onPointerDown(h)}
            title={HANDLE_LABEL[h]}
            style={{
              position: "absolute", top: 0, bottom: 0,
              transform: "translateX(-50%)",
              width: 8, background: "#fff", opacity: 0.9,
              cursor: "ew-resize", touchAction: "none", zIndex: 2,
              borderRadius: 2,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
            }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, opacity: 0.5, marginTop: 2 }}>
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
    </div>
  );
}

function bandStyle(color: string): React.CSSProperties {
  return { position: "absolute", top: 0, bottom: 0, background: color, opacity: 0.55 };
}
function featherStyle(from: string, to: string): React.CSSProperties {
  return { position: "absolute", top: 0, bottom: 0, background: `linear-gradient(to right, ${from}, ${to})`, opacity: 0.55 };
}

// Convert TonalBounds → per-zone ZoneState range/feather fields (for sim + bake).
export function boundsToRanges(b: TonalBounds) {
  return {
    shadows:    { rangeStart: 0,    rangeEnd: b.t1, featherLeft: 0,         featherRight: b.t2 - b.t1 },
    midtones:   { rangeStart: b.t2, rangeEnd: b.t3, featherLeft: b.t2 - b.t1, featherRight: b.t4 - b.t3 },
    highlights: { rangeStart: b.t4, rangeEnd: 100,  featherLeft: b.t4 - b.t3, featherRight: 0 },
  };
}

export function rangesToBounds(zones: { shadows: { rangeEnd: number; featherRight: number }; midtones: { rangeStart: number; rangeEnd: number; featherRight: number }; highlights: { rangeStart: number } }): TonalBounds {
  return {
    t1: zones.shadows.rangeEnd,
    t2: zones.midtones.rangeStart,
    t3: zones.midtones.rangeEnd,
    t4: zones.highlights.rangeStart,
  };
}
