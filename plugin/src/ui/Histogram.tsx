// Tiny luminance histogram strip, drawn imperatively to a canvas via fillRect.
// Sizes the canvas to match its container width so it fills the row regardless of zoom level.

import { useEffect, useRef } from "react";

const BUCKETS = 200;

export interface HistogramProps {
  rgba: Uint8Array | null;
  height?: number;
}

export function Histogram(props: HistogramProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = props.height ?? 24;

  useEffect(() => {
    const wrap = wrapRef.current;
    const c = canvasRef.current;
    if (!wrap || !c) return;
    const w = Math.max(BUCKETS, Math.floor(wrap.clientWidth || BUCKETS));
    c.width = w;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, height);
    if (!props.rgba) return;

    const counts = new Uint32Array(BUCKETS);
    const data = props.rgba;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const L = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(L * BUCKETS)));
      counts[b]++;
    }

    let max = 0;
    for (let i = 0; i < BUCKETS; i++) if (counts[i] > max) max = counts[i];
    if (max === 0) return;

    const barWidth = w / BUCKETS;
    ctx.fillStyle = "rgba(220, 220, 220, 0.85)";
    for (let i = 0; i < BUCKETS; i++) {
      if (counts[i] === 0) continue;
      const h = Math.round((Math.log(1 + counts[i]) / Math.log(1 + max)) * height);
      ctx.fillRect(Math.floor(i * barWidth), height - h, Math.max(1, Math.ceil(barWidth)), h);
    }
  }, [props.rgba, height]);

  return (
    <div ref={wrapRef} style={{ width: "100%", background: "#1a1a1a", borderRadius: 2 }}>
      <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} />
    </div>
  );
}
