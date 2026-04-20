// Tiny luminance histogram strip. Renders as a horizontal bar (0..100% L) with vertical lines
// per bucket, opacity proportional to log(count). Drawn imperatively to a canvas via fillRect
// (no createImageData needed, so works in UXP).

import { useEffect, useRef } from "react";

const BUCKETS = 100;

export interface HistogramProps {
  rgba: Uint8Array | null;
  height?: number;
}

export function Histogram(props: HistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = props.height ?? 24;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = BUCKETS;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // Clear.
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.clearRect(0, 0, BUCKETS, height);

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

    // Draw each bucket as a vertical bar scaled by log(count) so smaller populations are still visible.
    for (let i = 0; i < BUCKETS; i++) {
      if (counts[i] === 0) continue;
      const h = Math.round((Math.log(1 + counts[i]) / Math.log(1 + max)) * height);
      ctx.fillStyle = "rgba(220, 220, 220, 0.85)";
      ctx.fillRect(i, height - h, 1, h);
    }
  }, [props.rgba, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block", background: "#1a1a1a", borderRadius: 2 }}
    />
  );
}
