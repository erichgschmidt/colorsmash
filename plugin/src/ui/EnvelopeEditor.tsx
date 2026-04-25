// Envelope editor: arbitrary-N piecewise-linear weight curve over input 0..255.
//
// Track shows the target's luma histogram as backdrop (so user sees where pixel mass lives).
// Click empty area → adds a point at click position. Drag point → moves position+weight.
// Double-click point → deletes it. Reference line at weight=1 (no modulation).

import { useRef } from "react";
import { EnvelopePoint, LumaBins } from "../core/histogramMatch";

export interface EnvelopeEditorProps {
  points: EnvelopePoint[];
  onChange: (pts: EnvelopePoint[]) => void;
  lumaBins: LumaBins | null;        // target luma histogram (filled bars)
  sourceLumaBins?: LumaBins | null; // source luma histogram (outline overlay)
  height?: number;
}

const W_MAX = 2;       // weight range 0..2
const TRACK_H_DEFAULT = 56;

export function EnvelopeEditor(props: EnvelopeEditorProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const trackH = props.height ?? TRACK_H_DEFAULT;

  // Log-scaled, normalized [0..1] bin heights for both target and source.
  const normBars = (bins: LumaBins | null | undefined): number[] | null => {
    if (!bins) return null;
    const c = bins.count;
    let max = 0;
    for (let i = 0; i < 256; i++) { const v = Math.log1p(c[i]); if (v > max) max = v; }
    if (max < 1e-6) return null;
    const out = new Array(256);
    for (let i = 0; i < 256; i++) out[i] = Math.log1p(c[i]) / max;
    return out;
  };
  const tgtBars = normBars(props.lumaBins);
  const srcBars = normBars(props.sourceLumaBins);

  // Build SVG polyline points string for a histogram (for source outline overlay).
  const barsToPolyPoints = (bars: number[]): string => {
    // Down-sample to ~64 segments so the outline is smooth, not noisy.
    const N = 64;
    const stride = 256 / N;
    const out: string[] = [];
    for (let i = 0; i <= N; i++) {
      const idx = Math.min(255, Math.round(i * stride));
      const x = (idx / 255) * 100;
      const y = (1 - bars[idx]) * 100;
      out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return out.join(" ");
  };

  const xyFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { position: Math.round(x * 255), weight: (1 - y) * W_MAX };
  };

  const startDrag = (idx: number, initial?: { position: number; weight: number }) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    let dragging = props.points.slice();
    if (initial !== undefined && idx >= dragging.length) {
      dragging.push(initial);
      props.onChange(dragging.slice());
    }
    const move = (ev: PointerEvent) => {
      const { position, weight } = xyFromEvent(ev);
      const next = dragging.slice();
      next[idx] = { position, weight: Math.round(weight * 100) / 100 };
      dragging = next;
      props.onChange(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Click on empty track adds a point at click coords AND immediately starts dragging.
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.target !== trackRef.current) return; // clicked on a point handle, not empty area
    const { position, weight } = xyFromEvent(e);
    const newPt = { position, weight: Math.round(weight * 100) / 100 };
    const newIdx = props.points.length;
    startDrag(newIdx, newPt)(e);
  };

  const deletePoint = (idx: number) => {
    const next = props.points.slice();
    next.splice(idx, 1);
    props.onChange(next);
  };

  // Build SVG-like path connecting sorted points (for the line overlay).
  const sorted = [...props.points].map((p, originalIdx) => ({ ...p, originalIdx })).sort((a, b) => a.position - b.position);
  const xPct = (p: number) => (p / 255) * 100;
  const yPct = (w: number) => (1 - Math.max(0, Math.min(W_MAX, w)) / W_MAX) * 100;

  return (
    <div style={{ position: "relative", marginBottom: 4 }}>
      <div ref={trackRef}
        onPointerDown={onTrackPointerDown}
        style={{
          position: "relative", width: "100%", height: trackH,
          background: "#1a1a1a", border: "1px solid #444", borderRadius: 3,
          overflow: "hidden", touchAction: "none", cursor: "crosshair",
        }}
        title="Click empty area to add a point. Drag to move. Double-click a point to delete.">
        {/* Target histogram backdrop — filled bars in mid-gray */}
        {tgtBars && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", pointerEvents: "none" }}>
            {tgtBars.map((h, i) => (
              <div key={i} style={{ flex: 1, height: `${h * 100}%`, background: "#6a6a6a" }} />
            ))}
          </div>
        )}
        {/* Source histogram outline — overlay so user sees where the match is pulling toward */}
        {srcBars && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polyline
              points={barsToPolyPoints(srcBars)}
              fill="none" stroke="#e8a060" strokeWidth="0.7" vectorEffect="non-scaling-stroke" opacity="0.85" />
          </svg>
        )}
        {/* Reference line at weight=1 (no modulation) */}
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "#555", pointerEvents: "none", opacity: 0.6 }} />
        {/* Connecting polyline */}
        {sorted.length >= 2 && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polyline
              points={sorted.map(p => `${xPct(p.position)},${yPct(p.weight)}`).join(" ")}
              fill="none" stroke="#7d7" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {/* Point handles */}
        {props.points.map((p, idx) => (
          <div key={idx}
            onPointerDown={startDrag(idx)}
            onDoubleClick={(e) => { e.stopPropagation(); deletePoint(idx); }}
            title={`pos ${p.position}, weight ${p.weight.toFixed(2)} — drag to move, double-click to delete`}
            style={{
              position: "absolute",
              left: `${xPct(p.position)}%`, top: `${yPct(p.weight)}%`,
              transform: "translate(-50%, -50%)",
              width: 10, height: 10, borderRadius: "50%",
              background: "#7d7", border: "1.5px solid #111",
              cursor: "grab", touchAction: "none", zIndex: 2,
            }} />
        ))}
      </div>
      <div style={{ fontSize: 9, opacity: 0.55, marginTop: 2, display: "flex", justifyContent: "space-between" }}>
        <span>0 (shadows)</span>
        <span><span style={{ color: "#999" }}>■ target</span>{srcBars ? <> · <span style={{ color: "#e8a060" }}>— source</span></> : null} · {props.points.length} pt{props.points.length === 1 ? "" : "s"} · click to add</span>
        <span>255 (highlights)</span>
      </div>
    </div>
  );
}
