// Interactive palette weight bar. Each cluster from k-means becomes a horizontal
// segment whose width is proportional to its weight; draggable handles between
// segments redistribute weight mass-conservingly. The user dials up "give me more
// of the orange" or down to zero ("ignore the sky entirely") and the histogram
// match re-fits using a weighted source synthesized from those proportions.
//
// Default weights = 1 per cluster (neutral; identical fit to the unweighted
// pipeline). The reset double-click restores them. Reset on every source change
// in the parent so weights from one source don't leak into the next.
//
// Active preset still drives a per-swatch RGB display transform (Full / Color /
// Contrast) so the bar reads consistently with the PresetStrip above it.

import { useMemo, useRef } from "react";
import { PaletteSwatch } from "../core/palette";
import { Preset } from "../core/histogramMatch";

export type PaletteCount = 3 | 5 | 7;

interface PaletteStripProps {
  swatches: PaletteSwatch[];     // from MatchTab's extractPalette useMemo
  weights: number[];             // length === swatches.length; 1 = neutral, 0 = excluded
  setWeights: (w: number[]) => void;
  count: PaletteCount;
  setCount: (n: PaletteCount) => void;
  preset?: Preset;
}

// Per-preset display transform on a swatch's RGB. Cluster math is unchanged.
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function swatchColor(s: PaletteSwatch, preset: Preset | undefined): string {
  if (preset === "contrast") {
    const y = Math.round(luma(s.r, s.g, s.b));
    return `rgb(${y}, ${y}, ${y})`;
  }
  if (preset === "hue") {
    const TARGET_Y = 140;
    const y = luma(s.r, s.g, s.b);
    if (y < 1) return `rgb(${TARGET_Y}, ${TARGET_Y}, ${TARGET_Y})`;
    const k = TARGET_Y / y;
    return `rgb(${Math.max(0, Math.min(255, Math.round(s.r * k)))}, ${Math.max(0, Math.min(255, Math.round(s.g * k)))}, ${Math.max(0, Math.min(255, Math.round(s.b * k)))})`;
  }
  return `rgb(${s.r}, ${s.g}, ${s.b})`;
}

// Count toggle styling.
const countBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: "1px 6px", fontSize: 9, fontWeight: 600,
  background: active ? "#1473e6" : "transparent",
  color: active ? "#fff" : "#888",
  border: `1px solid ${active ? "#1473e6" : "#444"}`,
  borderRadius: 2, cursor: "pointer", userSelect: "none",
  height: 14, lineHeight: "12px", boxSizing: "border-box",
});

const BAR_HEIGHT = 24;
const HANDLE_HALF_WIDTH = 6;       // each handle's clickable half-width in px
const MIN_VISUAL_WIDTH_PCT = 1.5;  // smallest visible segment so a weight=0 cluster stays grabbable

export function PaletteStrip(props: PaletteStripProps) {
  const { swatches, weights, setWeights, preset, count, setCount } = props;
  const barRef = useRef<HTMLDivElement>(null);

  // Display order: sort swatches by luminance dark→light so the bar reads as a value
  // gradient. We sort the indices, not the swatches themselves — weights stay aligned
  // with the original palette index, which is also what synthesizeWeightedSource expects.
  const orderedIndices = useMemo(() => {
    return swatches
      .map((s, i) => [i, luma(s.r, s.g, s.b)] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .map(([i]) => i);
  }, [swatches]);

  const totalWeight = useMemo(() => weights.reduce((acc, w) => acc + Math.max(0, w), 0), [weights]);
  const safeTotal = totalWeight > 0 ? totalWeight : 1;

  // Width % per swatch (in display order). Clamped to MIN_VISUAL_WIDTH_PCT so a
  // zeroed segment stays visible + grabbable; the math weight stays at 0.
  const widthsPct = orderedIndices.map(idx => {
    const w = Math.max(0, weights[idx] ?? 0);
    return Math.max(MIN_VISUAL_WIDTH_PCT, (w / safeTotal) * 100);
  });
  // Renormalize so the displayed widths sum to 100 (after the min-clamp inflation).
  const widthSum = widthsPct.reduce((a, b) => a + b, 0);
  const displayWidths = widthsPct.map(w => (w / widthSum) * 100);

  // Cumulative left-edge % per segment in display order (for handle positioning).
  const leftEdges: number[] = [];
  {
    let acc = 0;
    for (const w of displayWidths) { leftEdges.push(acc); acc += w; }
  }

  // Drag a boundary handle: index `i` separates display-order segment i from i+1.
  // Mass-conserving: weights[orderedIndices[i]] + weights[orderedIndices[i+1]] stays
  // constant, the split shifts based on cursor position within the bar.
  const startHandleDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idxLeft = orderedIndices[i];
    const idxRight = orderedIndices[i + 1];
    const leftEdgeOfPair = leftEdges[i];
    const rightEdgeOfPair = leftEdges[i + 1] + displayWidths[i + 1];
    const pairWeight = (weights[idxLeft] ?? 0) + (weights[idxRight] ?? 0);
    const onMove = (ev: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      if (rect.width === 0) return;
      const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
      // Clamp so the handle can't cross its neighbors.
      const minX = leftEdgeOfPair + 0.5;
      const maxX = rightEdgeOfPair - 0.5;
      const clamped = Math.max(minX, Math.min(maxX, xPct));
      // Convert handle position back to a weight split. The displayed pair spans
      // (leftEdgeOfPair → rightEdgeOfPair) in % and represents pairWeight in absolute
      // terms; the handle's fractional position within that span is the new ratio.
      const span = rightEdgeOfPair - leftEdgeOfPair;
      if (span <= 0) return;
      const fracLeft = (clamped - leftEdgeOfPair) / span;
      const next = weights.slice();
      next[idxLeft] = pairWeight * fracLeft;
      next[idxRight] = pairWeight * (1 - fracLeft);
      setWeights(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Reset to neutral (all weights = 1). Single-click on the reset button.
  const resetWeights = () => setWeights(swatches.map(() => 1));

  // Detect "is neutral" (all weights ≈ 1) to dim the reset button when there's
  // nothing to reset.
  const isNeutral = useMemo(() => weights.every(w => Math.abs(w - 1) < 0.01), [weights]);

  const countToggle = (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}
      title="Number of palette swatches — fewer for primary themes, more for nuance">
      {([3, 5, 7] as PaletteCount[]).map(n => (
        <div key={n} onClick={() => setCount(n)} style={countBtnStyle(n === count)}>{n}</div>
      ))}
    </div>
  );

  if (swatches.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, opacity: 0.5 }}>palette</span>
          {countToggle}
        </div>
        <div style={{ display: "flex", height: BAR_HEIGHT, gap: 2, opacity: 0.4 }}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
          ))}
        </div>
      </div>
    );
  }

  const tipForPreset = preset === "contrast" ? "value range (preset: Contrast)"
                     : preset === "hue"      ? "hues (preset: Color)"
                     :                          "dominant colors (preset: Full)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <span style={{ fontSize: 9, opacity: 0.5 }}>palette</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div onClick={isNeutral ? undefined : resetWeights}
            title={isNeutral ? "Weights are neutral" : "Reset all weights to natural ratios"}
            style={{
              padding: "1px 6px", fontSize: 9, fontWeight: 600,
              background: "transparent",
              color: isNeutral ? "#444" : "#aaa",
              border: `1px solid ${isNeutral ? "#333" : "#555"}`,
              borderRadius: 2, cursor: isNeutral ? "default" : "pointer", userSelect: "none",
              height: 14, lineHeight: "12px", boxSizing: "border-box",
            }}>reset</div>
          {countToggle}
        </div>
      </div>

      {/* The bar: positioned segments + absolutely-placed handles between them.
          We use position:relative on the outer + absolute children so the handle
          sit exactly at boundary edges without flex math drifting. */}
      <div ref={barRef}
        style={{ position: "relative", height: BAR_HEIGHT, width: "100%", userSelect: "none" }}
        title={`Source palette — ${tipForPreset} (drag handles to weight)`}>
        {orderedIndices.map((idx, i) => {
          const s = swatches[idx];
          const w = weights[idx] ?? 0;
          const pct = (Math.max(0, w) / safeTotal) * 100;
          return (
            <div key={`seg-${idx}`}
              style={{
                position: "absolute", top: 0, height: BAR_HEIGHT,
                left: `${leftEdges[i]}%`, width: `${displayWidths[i]}%`,
                background: swatchColor(s, preset),
                border: "1px solid #333",
                borderRadius: 2,
                opacity: w < 0.02 ? 0.35 : 1,
              }}
              title={`rgb(${s.r}, ${s.g}, ${s.b}) — natural ${(s.weight * 100).toFixed(0)}%, current weight ${pct.toFixed(0)}%`}
            />
          );
        })}
        {/* Drag handles at internal boundaries. Sit on top of the segment edge
            with a small grab affordance. Only N-1 handles for N segments. */}
        {orderedIndices.slice(0, -1).map((_, i) => {
          const x = leftEdges[i] + displayWidths[i]; // boundary between i and i+1
          return (
            <div key={`handle-${i}`} onPointerDown={startHandleDrag(i)}
              style={{
                position: "absolute", top: -1, height: BAR_HEIGHT + 2,
                left: `calc(${x}% - ${HANDLE_HALF_WIDTH}px)`,
                width: HANDLE_HALF_WIDTH * 2,
                cursor: "ew-resize", touchAction: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              <div style={{
                width: 2, height: BAR_HEIGHT - 4, background: "#fff",
                opacity: 0.6, borderRadius: 1, pointerEvents: "none",
                boxShadow: "0 0 2px rgba(0,0,0,0.6)",
              }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
