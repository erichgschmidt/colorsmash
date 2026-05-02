// Envelope editor: arbitrary-N piecewise-linear weight curve over input 0..255.
//
// Click empty area → adds a smooth point and immediately starts dragging.
// Drag → moves position+weight. Shift = vertical only. Ctrl = horizontal only.
// Click point → selects it. Delete/Backspace removes selected. Right-click point also removes.
// Alt-click point → toggles smooth (round handle) ↔ corner (square handle).
// Smooth segments use monotone cubic Hermite; corner segments are linear.

import { useEffect, useRef, useState } from "react";
import { EnvelopePoint, LumaBins, buildEnvelopeWeights } from "../core/histogramMatch";

export interface EnvelopeEditorProps {
  points: EnvelopePoint[];
  onChange: (pts: EnvelopePoint[]) => void;
  lumaBins: LumaBins | null;        // target luma histogram (filled bars)
  sourceLumaBins?: LumaBins | null; // source luma histogram (outline overlay)
  resultLumaBins?: LumaBins | null; // result luma histogram (cyan outline overlay)
  height?: number;
}

const W_MAX = 2;       // weight range 0..2
const TRACK_H_DEFAULT = 56;
const HANDLE_SIZE = 10; // px; track gets internal padding so endpoint handles aren't clipped.

export function EnvelopeEditor(props: EnvelopeEditorProps) {
  const trackRef = useRef<HTMLDivElement>(null);   // outer (handles live here, no clip)
  const innerRef = useRef<HTMLDivElement>(null);   // inner clipped area (histogram + lines)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const trackH = props.height ?? TRACK_H_DEFAULT;

  // Log-scaled normalized [0..1] bin heights for both target and source.
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
  const resBars = normBars(props.resultLumaBins);

  const barsToPolyPoints = (bars: number[]): string => {
    const N = 64;
    const stride = 256 / N;
    const out: string[] = [];
    for (let i = 0; i <= N; i++) {
      const idx = Math.min(255, Math.round(i * stride));
      out.push(`${((idx / 255) * 100).toFixed(2)},${((1 - bars[idx]) * 100).toFixed(2)}`);
    }
    return out.join(" ");
  };

  // Convert pointer event → logical (position 0..255, weight 0..W_MAX). Uses inner area
  // (which excludes the padding) so position 0 / 255 land at the histogram extremes.
  const xyFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = innerRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { position: Math.round(x * 255), weight: (1 - y) * W_MAX };
  };

  const startDrag = (idx: number, initial?: EnvelopePoint) => (e: React.PointerEvent) => {
    // Alt-click on an existing point toggles smooth/corner instead of dragging.
    if (e.altKey && initial === undefined && idx < props.points.length) {
      e.preventDefault(); e.stopPropagation();
      togglePointSmooth(idx);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelectedIdx(idx);
    const startPt = initial ?? props.points[idx];
    let dragging = props.points.slice();
    if (initial !== undefined && idx >= dragging.length) {
      dragging.push(initial);
      props.onChange(dragging.slice());
    }
    const move = (ev: PointerEvent) => {
      const { position, weight } = xyFromEvent(ev);
      const next = dragging.slice();
      // Shift = lock horizontal axis (vertical movement only — change weight, preserve position).
      // Ctrl  = lock vertical axis (horizontal movement only — change position, preserve weight).
      const lockX = ev.shiftKey;
      const lockY = ev.ctrlKey || ev.metaKey;
      next[idx] = {
        position: lockX ? startPt.position : position,
        weight: lockY ? startPt.weight : Math.round(weight * 100) / 100,
      };
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

  // Click on empty track adds a smooth point at click coords AND immediately starts dragging.
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.target !== trackRef.current && e.target !== innerRef.current) return; // hit a handle
    const { position, weight } = xyFromEvent(e);
    const newPt: EnvelopePoint = { position, weight: Math.round(weight * 100) / 100, smooth: true };
    startDrag(props.points.length, newPt)(e);
  };

  const togglePointSmooth = (idx: number) => {
    const next = props.points.slice();
    const cur = next[idx];
    next[idx] = { ...cur, smooth: cur.smooth === false ? true : false };
    props.onChange(next);
  };

  const deletePoint = (idx: number) => {
    const next = props.points.slice();
    next.splice(idx, 1);
    props.onChange(next);
    setSelectedIdx(null);
  };

  // Delete / Backspace removes the currently selected point.
  useEffect(() => {
    if (selectedIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIdx !== null && selectedIdx < props.points.length) {
          e.preventDefault();
          deletePoint(selectedIdx);
        }
      } else if (e.key === "Escape") {
        setSelectedIdx(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [selectedIdx, props.points]); // eslint-disable-line react-hooks/exhaustive-deps

  const xPct = (p: number) => (p / 255) * 100;
  const yPct = (w: number) => (1 - Math.max(0, Math.min(W_MAX, w)) / W_MAX) * 100;

  // Compute the actual weight curve for the connecting line — picks up smooth segments so
  // the visualization matches what's applied. Sampled every 2 inputs (128 segments).
  const weightSamples = props.points.length >= 2 ? buildEnvelopeWeights(props.points) : null;
  const weightCurvePoints = weightSamples
    ? Array.from({ length: 129 }, (_, k) => {
        const v = Math.min(255, k * 2);
        return `${xPct(v).toFixed(2)},${yPct(weightSamples[v]).toFixed(2)}`;
      }).join(" ")
    : "";

  // Padding so endpoint handles sit fully inside the visible track.
  const pad = HANDLE_SIZE / 2 + 1;

  return (
    <div style={{ position: "relative", marginBottom: 4 }}>
      <div ref={trackRef}
        onPointerDown={onTrackPointerDown}
        style={{
          position: "relative", width: "100%", height: trackH,
          background: "#1a1a1a", border: "1px solid #444", borderRadius: 3,
          touchAction: "none", cursor: "crosshair",
          paddingLeft: pad, paddingRight: pad, boxSizing: "border-box",
        }}
        title="Click empty area to add a point. Drag to move. Shift = vertical, Ctrl = horizontal. Alt-click toggles smooth (●) / corner (■). Right-click or Delete to remove. Right-click or Delete to remove.">
        {/* Inner clipped layer: histogram + lines. Position 0 / 255 align with this area. */}
        <div ref={innerRef} style={{ position: "absolute", top: 0, bottom: 0, left: pad, right: pad, overflow: "hidden", pointerEvents: "none" }}>
          {tgtBars && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end" }}>
              {tgtBars.map((h, i) => (
                <div key={i} style={{ flex: 1, height: `${h * 100}%`, background: "#6a6a6a" }} />
              ))}
            </div>
          )}
          {srcBars && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polyline points={barsToPolyPoints(srcBars)} fill="none" stroke="#e8a060" strokeWidth="0.7" vectorEffect="non-scaling-stroke" opacity="0.85" />
            </svg>
          )}
          {resBars && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polyline points={barsToPolyPoints(resBars)} fill="none" stroke="#5fd1c8" strokeWidth="0.7" vectorEffect="non-scaling-stroke" opacity="0.95" />
            </svg>
          )}
          <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "#555", opacity: 0.6 }} />
          {weightSamples && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polyline points={weightCurvePoints} fill="none" stroke="#7d7" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
        </div>
        {/* Handles layer (no clipping). Positions are relative to the inner area. */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: pad, right: pad, pointerEvents: "none" }}>
          {props.points.map((p, idx) => {
            const isSel = idx === selectedIdx;
            const smooth = p.smooth !== false;
            return (
              <div key={idx}
                onPointerDown={startDrag(idx)}
                onDoubleClick={(e) => { e.stopPropagation(); deletePoint(idx); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); deletePoint(idx); }}
                title={`pos ${p.position}, weight ${p.weight.toFixed(2)} (${smooth ? "smooth" : "corner"}) — drag to move (Shift=vert, Ctrl=horiz), Alt-click to toggle smooth/corner, right-click or Delete to remove`}
                style={{
                  position: "absolute",
                  left: `${xPct(p.position)}%`, top: `${yPct(p.weight)}%`,
                  transform: "translate(-50%, -50%)",
                  width: HANDLE_SIZE, height: HANDLE_SIZE,
                  borderRadius: smooth ? "50%" : 1,
                  background: isSel ? "#aef" : "#7d7",
                  border: isSel ? "1.5px solid #fff" : "1.5px solid #111",
                  cursor: "grab", touchAction: "none", zIndex: 2,
                  pointerEvents: "auto",
                }} />
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 9, opacity: 0.55, marginTop: 2, display: "flex", justifyContent: "space-between" }}>
        <span>0 (shadows)</span>
        <span><span style={{ color: "#999" }}>■ target</span>{srcBars ? <> · <span style={{ color: "#e8a060" }}>— source</span></> : null}{resBars ? <> · <span style={{ color: "#5fd1c8" }}>— result</span></> : null} · {props.points.length} pt{props.points.length === 1 ? "" : "s"} · click to add · drag to move · Alt-click = smooth/corner · Delete to remove</span>
        <span>255 (highlights)</span>
      </div>
    </div>
  );
}
