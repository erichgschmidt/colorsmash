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
  // Softness 0..100. 0 = hard nearest-cluster boundaries (existing behavior);
  // higher values blend cluster contributions across the bar so pixels between
  // clusters get smoothly interpolated weights. The bar shows this visually as
  // gradient transitions between adjacent segments — no slider scrub needed to
  // see what the current softness is doing.
  softness?: number;
  setSoftness?: (n: number) => void;
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
  const softness = Math.max(0, Math.min(100, props.softness ?? 0));
  const setSoftness = props.setSoftness;
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

  // Pair-wise drag (handle between two segments): mass-conserving across the two
  // adjacent segments only. The pair's total displayValue stays constant; segments
  // outside the pair are unchanged. Used in the default (non-adaptive) mode.
  const startHandleDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idxLeft = orderedIndices[i];
    const idxRight = orderedIndices[i + 1];
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

  // Body drag (adaptive mode): each swatch becomes its own draggable target.
  // Drag right to grow the swatch, drag left to shrink it. All OTHER swatches
  // rebalance proportionally so their relative ratios stay intact. Symmetric:
  // every swatch has its own body, so the asymmetry of N-1 handles for N
  // segments doesn't show up here. Cursor delta in % of bar width maps
  // directly to Δvi (the segment's normalized displayValue). E.g., dragging
  // right by half the bar grows the segment's share by 50 percentage points.
  const startBodyDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idx = orderedIndices[i];
    const totalStart = displayValues.reduce((a, b) => a + b, 0) || 1;
    const viStart = displayValues[i] / totalStart;
    const sumOthersStart = 1 - viStart;
    const pi = Math.max(1e-6, swatches[idx]?.weight ?? 0);
    const weightsStart = weights.slice();
    const startX = e.clientX;
    const rect = bar.getBoundingClientRect();
    const barWidth = rect.width || 1;

    const onMove = (ev: PointerEvent) => {
      const dxFrac = (ev.clientX - startX) / barWidth; // − = shrink, + = grow
      const viNew = Math.max(0, Math.min(1, viStart + dxFrac));
      // Scale factor for all OTHER segments. If sum_others_start was 0
      // (segment i held all the weight), there's nothing to scale and we
      // can't redistribute back; clamp to leaving others at 0.
      const scale = sumOthersStart < 1e-6 ? 0 : (1 - viNew) / sumOthersStart;
      const next = weightsStart.slice();
      next[idx] = (viNew * totalStart) / pi;
      for (let j = 0; j < next.length; j++) {
        if (j === idx) continue;
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
        ? "Adaptive: drag a swatch body to grow/shrink it; others rebalance proportionally. Click to switch to handle mode."
        : "Handle mode: drag the white dividers to redistribute weight between adjacent neighbors. Click to switch to adaptive (drag swatch body)."}
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
        title={`Source palette — ${tipForPreset} ${adaptive ? "(drag swatch body — others rebalance)" : "(drag handles to weight)"}`}>
        {/* Segments. With softness=0 each segment is a solid color block, so
            adjacent segments meet at hard boundaries (the existing v1.7
            behavior). With softness>0 each segment's background becomes a
            horizontal linear-gradient that fades from the average-with-left-
            neighbor color at its left edge, through its own color at the
            center, to the average-with-right-neighbor color at its right edge.
            The fade-pad % is `softness/2`, so at softness=100 the fades reach
            the segment's center and the bar reads as a continuous gradient
            across all clusters. End segments don't fade at the panel edges. */}
        {orderedIndices.map((idx, i) => {
          const s = swatches[idx];
          const w = weights[idx] ?? 0;
          const naturalPct = (s.weight * 100).toFixed(0);
          const currentPct = ((displayValues[i] / valueSum) * 100).toFixed(0);
          const multiplierStr = w === 1 ? "neutral" : `×${w.toFixed(2)}`;
          const myCol = swatchColor(s, preset);
          const leftNeighbor = i > 0 ? swatches[orderedIndices[i - 1]] : null;
          const rightNeighbor = i < orderedIndices.length - 1 ? swatches[orderedIndices[i + 1]] : null;
          const blend = (a: PaletteSwatch | null) => {
            if (!a) return myCol;
            // Average my displayed color with neighbor's displayed color in RGB.
            const aCol = swatchColor(a, preset);
            const m1 = myCol.match(/rgb\((\d+), (\d+), (\d+)\)/);
            const m2 = aCol.match(/rgb\((\d+), (\d+), (\d+)\)/);
            if (!m1 || !m2) return myCol;
            const r = Math.round((+m1[1] + +m2[1]) / 2);
            const g = Math.round((+m1[2] + +m2[2]) / 2);
            const b = Math.round((+m1[3] + +m2[3]) / 2);
            return `rgb(${r}, ${g}, ${b})`;
          };
          const leftEdge = blend(leftNeighbor);
          const rightEdge = blend(rightNeighbor);
          const fadePct = softness / 2; // 0..50
          const bg = softness <= 0
            ? myCol
            : `linear-gradient(to right, ${leftEdge} 0%, ${myCol} ${fadePct}%, ${myCol} ${100 - fadePct}%, ${rightEdge} 100%)`;
          return (
            <div key={`seg-${idx}`}
              onPointerDown={adaptive ? startBodyDrag(i) : undefined}
              style={{
                position: "absolute", top: 0, height: BAR_HEIGHT,
                left: `${leftEdges[i]}%`, width: `${displayWidths[i]}%`,
                background: bg,
                border: softness > 0 ? "none" : "1px solid #333",
                borderRadius: 2,
                opacity: w < 0.02 ? 0.35 : 1,
                cursor: adaptive ? "ew-resize" : "default",
                touchAction: adaptive ? "none" : "auto",
              }}
              title={`rgb(${s.r}, ${s.g}, ${s.b}) — natural ${naturalPct}% · current ${currentPct}% · ${multiplierStr}`}
            />
          );
        })}
        {/* Pair-wise drag handles at internal boundaries. Hidden in adaptive
            mode since the swatch bodies themselves are the drag targets there.
            Only N-1 handles for N segments — that's the asymmetry that made
            adaptive feel weird when bound to handles instead of bodies. */}
        {!adaptive && orderedIndices.slice(0, -1).map((_, i) => {
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

      {/* Softness slider: thin range below the bar. Drives the gradient feathering
          on the bar above (visible immediately) AND the runtime softness used by
          synthesize/apply (per-pixel cluster blend strength). 0 = hard nearest-
          cluster boundaries (existing behavior); 100 = smooth blend across all
          clusters → gradient mask. Tooltip shows the current value. Hidden when
          no setSoftness handler is provided (caller can opt out). */}
      {setSoftness && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2, height: 12 }}
          title={`Softness: ${Math.round(softness)} — falloff between cluster regions (0 = hard, 100 = smooth blend)`}>
          <span style={{ fontSize: 9, opacity: 0.5, width: 38 }}>softness</span>
          <input type="range" min={0} max={100} step={1} value={softness}
            onInput={e => setSoftness(parseFloat((e.target as HTMLInputElement).value))}
            onChange={e => setSoftness(parseFloat((e.target as HTMLInputElement).value))}
            style={{ flex: 1, margin: 0, cursor: "pointer", height: 12 }} />
          <span style={{ fontSize: 9, opacity: 0.5, width: 22, textAlign: "right" }}>{Math.round(softness)}</span>
        </div>
      )}
    </div>
  );
}
