// Generic ratio bar — a mass-conserving distribution editor over a set of
// coloured segments. The band IS the distribution: each segment's width is
// its absolute weight (normalized for display); dragging redistributes mass.
//
// Two drag modes, mirroring PaletteStrip:
//   • handle mode (default): drag a divider between two segments — mass is
//     conserved across that adjacent pair only.
//   • adaptive mode: drag a segment BODY — it grows/shrinks and every other
//     segment rebalances proportionally so their relative ratios hold.
//
// Absolute weights (not multipliers-on-a-natural) mean any bin is editable
// even when the image has zero pixels there — drag a neighbour's mass in.
// Double-click resets to `resetWeights` (the image's natural distribution).

import { useMemo, useRef } from "react";
import type { RgbTriplet } from "../../core/smash/engine";

interface RatioBarProps {
  /** Per-segment colours, parallel to `weights`. */
  colors: readonly RgbTriplet[];
  /** Absolute per-segment weights — the distribution itself. */
  weights: number[];
  setWeights: (w: number[]) => void;
  /** Double-click reset target (the natural histogram). Omit to disable. */
  resetWeights?: readonly number[];
  /** Adaptive (body-drag) mode. */
  adaptive?: boolean;
  disabled?: boolean;
  title?: string;
  /**
   * Sort display segments dark→light by luma. Default true. Set false to
   * render segments in array order — for axes whose bin order is meaningful
   * (Hue / Saturation / Chroma).
   */
  sortByLuma?: boolean;
}

const luma = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const BAR_HEIGHT = 22;
const HANDLE_HALF_WIDTH = 6;

/** Minimum on-screen width per segment, as a % of the bar. Scaled by segment
 *  count so the drag handles never overlap (and so a near-flat band's tiny
 *  slices stay grabbable) — at the cost of the bar being a slightly looser
 *  histogram readout when one slice dominates. */
function minVisualPct(segments: number): number {
  return Math.max(1.5, Math.min(3.6, 90 / Math.max(1, segments)));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function RatioBar(props: RatioBarProps): JSX.Element {
  const { colors, weights, setWeights } = props;
  const disabled = !!props.disabled;
  const adaptive = !!props.adaptive;
  const barRef = useRef<HTMLDivElement>(null);
  const sortByLuma = props.sortByLuma ?? true;

  // Display order: segments sorted by luma dark→light, or array order when
  // sortByLuma is false. Indices are reordered, not the data — weights stay
  // aligned to the original index.
  const orderedIndices = useMemo(() => {
    if (!sortByLuma) return colors.map((_, i) => i);
    return colors
      .map((c, i) => [i, luma(c[0], c[1], c[2])] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .map(([i]) => i);
  }, [colors, sortByLuma]);

  const lengthOk = colors.length > 0 && weights.length === colors.length;

  if (!lengthOk) {
    // No data, or a stale-length array mid-render after a count change.
    return (
      <div style={{ display: "flex", height: BAR_HEIGHT, gap: 2, opacity: 0.35, width: "100%" }}>
        {Array.from({ length: Math.max(3, colors.length) }, (_, i) => (
          <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
        ))}
      </div>
    );
  }

  // Display value per segment = its (non-negative) weight.
  const displayValues = orderedIndices.map((idx) => Math.max(0, weights[idx] ?? 0));
  const valueSum = displayValues.reduce((a, b) => a + b, 0) || 1;
  const minPct = minVisualPct(displayValues.length);
  const widthsPct = displayValues.map((v) =>
    Math.max(minPct, (v / valueSum) * 100));
  const widthSum = widthsPct.reduce((a, b) => a + b, 0);
  const displayWidths = widthsPct.map((w) => (w / widthSum) * 100);

  const leftEdges: number[] = [];
  {
    let acc = 0;
    for (const w of displayWidths) { leftEdges.push(acc); acc += w; }
  }

  // Handle drag (default mode): mass-conserving across one adjacent pair.
  const startHandleDrag = (i: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idxLeft = orderedIndices[i];
    const idxRight = orderedIndices[i + 1];
    const leftEdgeOfPair = leftEdges[i];
    const rightEdgeOfPair = leftEdges[i + 1] + displayWidths[i + 1];
    const pairValue = Math.max(0, weights[idxLeft] ?? 0) + Math.max(0, weights[idxRight] ?? 0);
    const onMove = (ev: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      if (rect.width === 0) return;
      const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
      const minX = leftEdgeOfPair + 0.5;
      const maxX = rightEdgeOfPair - 0.5;
      const clamped = Math.max(minX, Math.min(maxX, xPct));
      const span = rightEdgeOfPair - leftEdgeOfPair;
      if (span <= 0) return;
      const fracLeft = (clamped - leftEdgeOfPair) / span;
      const next = weights.slice();
      next[idxLeft] = pairValue * fracLeft;
      next[idxRight] = pairValue * (1 - fracLeft);
      setWeights(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Body drag (adaptive mode): grow/shrink one segment; others rebalance
  // proportionally.
  const startBodyDrag = (i: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idx = orderedIndices[i];
    const weightsStart = weights.map((w) => Math.max(0, w));
    const total = weightsStart.reduce((a, b) => a + b, 0) || 1;
    const viStart = weightsStart[idx] / total;
    const sumOthersStart = 1 - viStart;
    const startX = e.clientX;
    const rect = bar.getBoundingClientRect();
    const barWidth = rect.width || 1;
    const otherCount = Math.max(1, weightsStart.length - 1);
    const onMove = (ev: PointerEvent) => {
      const dxFrac = (ev.clientX - startX) / barWidth;
      const viNew = clamp01(viStart + dxFrac);
      const next = weightsStart.slice();
      next[idx] = viNew * total;
      if (sumOthersStart < 1e-6) {
        // This segment held all the mass — spread the freed budget evenly.
        const w = ((1 - viNew) * total) / otherCount;
        for (let j = 0; j < next.length; j++) if (j !== idx) next[j] = w;
      } else {
        const scale = (1 - viNew) / sumOthersStart;
        for (let j = 0; j < next.length; j++) if (j !== idx) next[j] = weightsStart[j] * scale;
      }
      setWeights(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetWeights = props.resetWeights;
  const onDoubleClick = () => {
    if (disabled || !resetWeights || resetWeights.length !== weights.length) return;
    setWeights(resetWeights.slice());
  };

  return (
    <div
      ref={barRef}
      onDoubleClick={onDoubleClick}
      style={{
        position: "relative", height: BAR_HEIGHT, width: "100%",
        userSelect: "none", opacity: disabled ? 0.4 : 1,
      }}
      title={props.title ?? (adaptive
        ? "Drag a segment body to grow/shrink it; others rebalance. Double-click to reset."
        : "Drag the dividers to reweight. Double-click to reset.")}
    >
      {orderedIndices.map((idx, i) => {
        const c = colors[idx];
        const pct = ((displayValues[i] / valueSum) * 100).toFixed(0);
        return (
          <div
            key={`seg-${idx}`}
            onPointerDown={adaptive ? startBodyDrag(i) : undefined}
            style={{
              position: "absolute", top: 0, height: BAR_HEIGHT,
              left: `${leftEdges[i]}%`, width: `${displayWidths[i]}%`,
              background: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
              border: "1px solid #333", borderRadius: 2,
              opacity: displayValues[i] < valueSum * 0.002 ? 0.35 : 1,
              cursor: adaptive ? "ew-resize" : "default",
              touchAction: adaptive ? "none" : "auto",
            }}
            title={`rgb(${c[0]}, ${c[1]}, ${c[2]}) — ${pct}% of the band`}
          />
        );
      })}
      {orderedIndices.slice(0, -1).map((_, i) => {
        const x = leftEdges[i] + displayWidths[i];
        return (
          <div
            key={`handle-${i}`}
            onPointerDown={adaptive ? undefined : startHandleDrag(i)}
            style={{
              position: "absolute", top: -1, height: BAR_HEIGHT + 2,
              left: `calc(${x}% - ${HANDLE_HALF_WIDTH}px)`,
              width: HANDLE_HALF_WIDTH * 2,
              cursor: adaptive ? "default" : "ew-resize",
              touchAction: adaptive ? "auto" : "none",
              pointerEvents: adaptive ? "none" : "auto",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div style={{
              width: 2, height: BAR_HEIGHT - 4, background: "#fff",
              opacity: adaptive ? 0.4 : 0.6, borderRadius: 1,
              pointerEvents: "none", boxShadow: "0 0 2px rgba(0,0,0,0.6)",
            }} />
          </div>
        );
      })}
    </div>
  );
}
