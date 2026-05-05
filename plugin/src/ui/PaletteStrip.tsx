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
  // Adaptive mode: when true, dragging a handle scales segment i and ALL OTHER
  // segments rebalance proportionally so their relative ratios stay intact. When
  // false (default), only the two adjacent neighbors redistribute mass between
  // themselves. Adaptive feels more like editing a single weight in isolation;
  // pair-wise feels like local rebalancing between neighbors. Different mental
  // models — both useful.
  adaptive?: boolean;
  setAdaptive?: (b: boolean) => void;
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
  const adaptive = !!props.adaptive;
  const setAdaptive = props.setAdaptive;
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

  // Display value per cluster = natural prevalence × user multiplier. With all
  // multipliers = 1 (the default), the bar's segment widths reflect the natural
  // k-means prevalence — exactly what users expect from a "this is your source"
  // palette display. Dragging adjusts a multiplier; reset returns multipliers to 1
  // so the bar snaps back to its natural look.
  const displayValues = orderedIndices.map(idx => {
    const w = Math.max(0, weights[idx] ?? 0);
    const p = Math.max(0, swatches[idx]?.weight ?? 0);
    return w * p;
  });
  const valueSum = displayValues.reduce((a, b) => a + b, 0) || 1;
  // Width % per segment, with min-visual clamp so a zeroed segment stays grabbable.
  const widthsPct = displayValues.map(v => Math.max(MIN_VISUAL_WIDTH_PCT, (v / valueSum) * 100));
  const widthSum = widthsPct.reduce((a, b) => a + b, 0);
  const displayWidths = widthsPct.map(w => (w / widthSum) * 100);

  // Cumulative left-edge % per segment in display order (for handle positioning).
  const leftEdges: number[] = [];
  {
    let acc = 0;
    for (const w of displayWidths) { leftEdges.push(acc); acc += w; }
  }

  // Drag a boundary handle: index `i` separates display-order segment i from i+1.
  // Two modes:
  //
  // Pair-wise (default): mass-conserving across the two adjacent segments only.
  //   The pair's total displayValue stays constant; segments outside the pair
  //   are unchanged. Feels like local rebalancing.
  //
  // Adaptive: drag determines a new value for segment i (the segment to the
  //   left of the handle), and ALL OTHER segments rescale by the same factor
  //   so their ratios stay intact. Total displayValue stays at 1.0 (normalized).
  //   Feels like editing a single weight in isolation.
  const startHandleDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idxLeft = orderedIndices[i];
    const idxRight = orderedIndices[i + 1];

    if (adaptive) {
      // Snapshot at drag start: total displayValue normalization, segment i's
      // value, and the sum of all segments to the LEFT of i. We solve for vi_new
      // such that the cursor lands at leftEdges[i]_new + vi_new, with all
      // non-i segments scaling proportionally as vi changes.
      //
      //   leftEdges[i]_new = L_start × (1 - vi_new) / (1 - vi_start)
      //   xFrac = leftEdges[i]_new + vi_new
      //   → vi_new = (xFrac - ratio_left) / (1 - ratio_left)
      //   where ratio_left = L_start / (1 - vi_start)
      const totalStart = displayValues.reduce((a, b) => a + b, 0) || 1;
      const viStart = displayValues[i] / totalStart;
      const lStart = leftEdges[i] / 100; // already in % normalized to bar
      const sumOthersStart = 1 - viStart;
      if (sumOthersStart < 1e-6) {
        // Degenerate: segment i is the only one with weight. Nothing to scale.
        return;
      }
      const ratioLeft = lStart / sumOthersStart;
      const pi = Math.max(1e-6, swatches[idxLeft]?.weight ?? 0);
      // Capture the current weights so each onMove computes from the snapshot,
      // not from the previous frame's weights (would compound rounding).
      const weightsStart = weights.slice();

      const onMove = (ev: PointerEvent) => {
        const rect = bar.getBoundingClientRect();
        if (rect.width === 0) return;
        const xFrac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const denom = 1 - ratioLeft;
        if (denom < 1e-6) return; // degenerate; shouldn't happen if sumOthersStart > 0
        const viNew = Math.max(0, Math.min(1, (xFrac - ratioLeft) / denom));
        // Scale factor applied to every OTHER weight.
        const scale = (1 - viNew) / Math.max(1e-6, 1 - viStart);
        const next = weightsStart.slice();
        next[idxLeft] = (viNew * totalStart) / pi;
        for (let j = 0; j < next.length; j++) {
          if (j === idxLeft) continue;
          next[j] = weightsStart[j] * scale;
        }
        setWeights(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    // Pair-wise mode (default): mass-conserving on the displayValue (= weights ×
    // natural prevalence) of just the two adjacent segments. The pair's total
    // stays constant, the split shifts based on cursor position within the pair.
    const leftEdgeOfPair = leftEdges[i];
    const rightEdgeOfPair = leftEdges[i + 1] + displayWidths[i + 1];
    const pLeft = Math.max(1e-6, swatches[idxLeft]?.weight ?? 0);
    const pRight = Math.max(1e-6, swatches[idxRight]?.weight ?? 0);
    const pairValue = (weights[idxLeft] ?? 0) * pLeft + (weights[idxRight] ?? 0) * pRight;
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
      next[idxLeft] = (pairValue * fracLeft) / pLeft;
      next[idxRight] = (pairValue * (1 - fracLeft)) / pRight;
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

  // Adaptive toggle: same dim styling as count buttons. Clicking flips drag mode.
  // Tooltip explains the difference at a glance.
  const adaptiveToggle = setAdaptive ? (
    <div onClick={() => setAdaptive(!adaptive)}
      title={adaptive
        ? "Adaptive: dragging keeps OTHER swatches' ratios intact (proportional rebalance). Click to switch to pair-wise."
        : "Pair-wise: dragging only redistributes between the two neighbors. Click to switch to adaptive (proportional rebalance)."}
      style={countBtnStyle(adaptive)}>
      adapt
    </div>
  ) : null;

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
          {adaptiveToggle}
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
          const naturalPct = (s.weight * 100).toFixed(0);
          const currentPct = ((displayValues[i] / valueSum) * 100).toFixed(0);
          const multiplierStr = w === 1 ? "neutral" : `×${w.toFixed(2)}`;
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
              title={`rgb(${s.r}, ${s.g}, ${s.b}) — natural ${naturalPct}% · current ${currentPct}% · ${multiplierStr}`}
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
