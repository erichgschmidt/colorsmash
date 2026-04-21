// N-zone tonal-zones slider. Variable count driven by bounds.boundaries length.

import { useEffect, useRef } from "react";
import { ZONE_COLORS } from "./MultiThumbSlider";

export interface TonalBounds {
  boundaries: number[]; // length 2*(N-1)
  pads: number[];       // length N-1
}

export interface TonalZonesSliderProps {
  bounds: TonalBounds;
  onChange: (b: TonalBounds) => void;
  zoneColors?: string[]; // length N; if omitted we derive from defaults
}

// Smooth gradient palette for N zones between blue → gray → amber.
export function paletteFor(n: number, override?: string[]): string[] {
  if (override && override.length === n) return override;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const parse = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
  const blue = parse(ZONE_COLORS.shadows);
  const gray = parse(ZONE_COLORS.midtones);
  const amber = parse(ZONE_COLORS.highlights);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    let c: { r: number; g: number; b: number };
    if (t < 0.5) {
      const k = t * 2;
      c = { r: lerp(blue.r, gray.r, k), g: lerp(blue.g, gray.g, k), b: lerp(blue.b, gray.b, k) };
    } else {
      const k = (t - 0.5) * 2;
      c = { r: lerp(gray.r, amber.r, k), g: lerp(gray.g, amber.g, k), b: lerp(gray.b, amber.b, k) };
    }
    out.push(`rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`);
  }
  return out;
}

export function TonalZonesSlider(props: TonalZonesSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<TonalBounds>({ boundaries: [...props.bounds.boundaries], pads: [...props.bounds.pads] });
  const handleRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bandRefs = useRef<(HTMLDivElement | null)[]>([]);
  const padThumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  const padBarRef = useRef<HTMLDivElement>(null);

  const N = boundsRef.current.boundaries.length / 2 + 1;
  const palette = paletteFor(N, props.zoneColors);

  const PAD_MAX = 40;

  const layout = () => {
    const b = boundsRef.current;
    // Handles at each boundary value
    for (let h = 0; h < b.boundaries.length; h++) {
      const el = handleRefs.current[h];
      if (el) el.style.left = `${b.boundaries[h]}%`;
    }
    // Bands: zone i from (i===0 ? 0 : b.boundaries[2*i-1]) to (i===N-1 ? 100 : b.boundaries[2*i])
    // Feather gradient between zones i and i+1 covers boundaries[2i] to boundaries[2i+1]
    let bandIdx = 0;
    for (let i = 0; i < N; i++) {
      const coreStart = i === 0 ? 0 : b.boundaries[2 * i - 1];
      const coreEnd   = i === N - 1 ? 100 : b.boundaries[2 * i];
      const el = bandRefs.current[bandIdx++];
      if (el) { el.style.left = `${coreStart}%`; el.style.width = `${Math.max(0, coreEnd - coreStart)}%`; }
      if (i < N - 1) {
        const fStart = b.boundaries[2 * i];
        const fEnd   = b.boundaries[2 * i + 1];
        const fel = bandRefs.current[bandIdx++];
        if (fel) { fel.style.left = `${fStart}%`; fel.style.width = `${Math.max(0, fEnd - fStart)}%`; }
      }
    }
    // Pad thumbs
    for (let i = 0; i < N - 1; i++) {
      const el = padThumbRefs.current[i];
      if (!el) continue;
      const center = (b.boundaries[2 * i] + b.boundaries[2 * i + 1]) / 2;
      el.style.left = `${center}%`;
    }
  };

  useEffect(() => {
    boundsRef.current = { boundaries: [...props.bounds.boundaries], pads: [...props.bounds.pads] };
    layout();
  });

  const onBoundaryDown = (hIndex: number) => (e: React.PointerEvent) => {
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
      b.boundaries[hIndex] = v;
      // Cascade: enforce monotonic increase through boundaries array.
      for (let i = hIndex - 1; i >= 0; i--) if (b.boundaries[i] > b.boundaries[i + 1]) b.boundaries[i] = b.boundaries[i + 1];
      for (let i = hIndex + 1; i < b.boundaries.length; i++) if (b.boundaries[i] < b.boundaries[i - 1]) b.boundaries[i] = b.boundaries[i - 1];
      layout();
      props.onChange({ boundaries: [...b.boundaries], pads: [...b.pads] });
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

  const onPadDown = (padIdx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const bar = padBarRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (clientX: number) => {
      const rect = bar.getBoundingClientRect();
      let pct = ((clientX - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      const b = boundsRef.current;
      const center = (b.boundaries[2 * padIdx] + b.boundaries[2 * padIdx + 1]) / 2;
      const distance = Math.abs(pct - center);
      b.pads[padIdx] = Math.min(PAD_MAX, Math.round(distance));
      layout();
      props.onChange({ boundaries: [...b.boundaries], pads: [...b.pads] });
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

  // Bands = N cores + (N-1) feathers (interleaved)
  const bands: { type: "core" | "feather"; color: string; nextColor?: string }[] = [];
  for (let i = 0; i < N; i++) {
    bands.push({ type: "core", color: palette[i] });
    if (i < N - 1) bands.push({ type: "feather", color: palette[i], nextColor: palette[i + 1] });
  }

  return (
    <div style={{ marginBottom: 6, fontSize: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2, opacity: 0.65 }}>
        <span>Tonal zones ({N})</span>
        <span style={{ fontSize: 9 }}>top: zone cores · bottom: feather softness</span>
      </div>
      <div ref={trackRef}
        style={{ position: "relative", height: 28, background: "#222", border: "1px solid #444", borderRadius: 4, overflow: "hidden" }}>
        {bands.map((band, idx) => (
          <div key={`band-${idx}`}
            ref={el => { bandRefs.current[idx] = el; }}
            style={{
              position: "absolute", top: 0, bottom: 0, opacity: 0.55,
              background: band.type === "core" ? band.color : `linear-gradient(to right, ${band.color}, ${band.nextColor})`,
            }} />
        ))}
        {boundsRef.current.boundaries.map((_, h) => (
          <div key={`bdry-${h}`}
            ref={el => { handleRefs.current[h] = el; }}
            onPointerDown={onBoundaryDown(h)}
            style={{
              position: "absolute", top: 0, bottom: 0, transform: "translateX(-50%)",
              width: 7, background: "#fff", opacity: 0.9, cursor: "ew-resize", touchAction: "none",
              zIndex: 2, borderRadius: 2, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
            }} />
        ))}
      </div>
      <div ref={padBarRef} style={{ position: "relative", height: 14, background: "#1a1a1a", border: "1px solid #333", borderTop: "none" }}>
        {boundsRef.current.pads.map((_, i) => (
          <div key={`pad-${i}`}
            ref={el => { padThumbRefs.current[i] = el; }}
            onPointerDown={onPadDown(i)}
            title="drag away from center to widen this transition's feather"
            style={{
              position: "absolute", top: 0, bottom: 0, transform: "translateX(-50%)",
              width: 7, background: "#888", cursor: "ew-resize", touchAction: "none", zIndex: 2, borderRadius: 2,
            }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, opacity: 0.5, marginTop: 2 }}>
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
    </div>
  );
}

export function boundsToRanges(b: TonalBounds) {
  // Import boundariesToZoneRanges from core — but keep it structural here too.
  const N = b.boundaries.length / 2 + 1;
  const out: { rangeStart: number; rangeEnd: number; featherLeft: number; featherRight: number }[] = [];
  for (let i = 0; i < N; i++) {
    const coreStart = i === 0 ? 0 : b.boundaries[2 * i - 1];
    const coreEnd   = i === N - 1 ? 100 : b.boundaries[2 * i];
    const featherL = i === 0 ? 0 : (b.boundaries[2 * i - 1] - b.boundaries[2 * i - 2]) + 2 * (b.pads[i - 1] ?? 0);
    const featherR = i === N - 1 ? 0 : (b.boundaries[2 * i + 1] - b.boundaries[2 * i]) + 2 * (b.pads[i] ?? 0);
    out.push({ rangeStart: coreStart, rangeEnd: coreEnd, featherLeft: featherL, featherRight: featherR });
  }
  return out;
}
