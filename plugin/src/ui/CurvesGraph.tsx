// Inline SVG showing the three fitted R/G/B curves. Diagonal = identity.
// Subsamples to STEP points per curve to keep SVG render cheap during drag.

import { memo } from "react";
import { ChannelCurves } from "../core/histogramMatch";

const STEP = 4; // 256 / 4 = 64 segments per channel

export const CurvesGraph = memo(function CurvesGraph(props: { curves: ChannelCurves | null; height?: number }) {
  const h = props.height ?? 90;
  const w = 256;

  const path = (curve: Uint8Array) => {
    let d = "";
    for (let v = 0; v < 256; v += STEP) {
      const x = (v / 255) * w;
      const y = h - (curve[v] / 255) * h;
      d += (v === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    // ensure last point
    const x = w, y = h - (curve[255] / 255) * h;
    d += "L" + x.toFixed(1) + " " + y.toFixed(1);
    return d;
  };

  return (
    <div style={{ background: "#111", border: "1px solid #555", borderRadius: 2, padding: 4 }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h, display: "block" }}>
        {/* grid */}
        <line x1={0} y1={h} x2={w} y2={0} stroke="#333" strokeWidth={0.5} />
        <line x1={w / 4} y1={0} x2={w / 4} y2={h} stroke="#222" strokeWidth={0.5} />
        <line x1={w / 2} y1={0} x2={w / 2} y2={h} stroke="#222" strokeWidth={0.5} />
        <line x1={(3 * w) / 4} y1={0} x2={(3 * w) / 4} y2={h} stroke="#222" strokeWidth={0.5} />
        <line x1={0} y1={h / 4} x2={w} y2={h / 4} stroke="#222" strokeWidth={0.5} />
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="#222" strokeWidth={0.5} />
        <line x1={0} y1={(3 * h) / 4} x2={w} y2={(3 * h) / 4} stroke="#222" strokeWidth={0.5} />

        {props.curves && (
          <>
            <path d={path(props.curves.b)} fill="none" stroke="#5ac" strokeWidth={1} opacity={0.85} />
            <path d={path(props.curves.g)} fill="none" stroke="#5c5" strokeWidth={1} opacity={0.85} />
            <path d={path(props.curves.r)} fill="none" stroke="#e55" strokeWidth={1} opacity={0.85} />
          </>
        )}
      </svg>
    </div>
  );
});
