// Generic ratio bar — a mass-conserving distribution editor over a set of
// weighted, colored segments. Each segment's width = natural weight × user
// multiplier; dragging redistributes mass. The Color Match PaletteStrip
// experience, generalized for the Smash section: it powers the SOURCE RATIOS
// axes (Value first; Hue / Saturation to follow) and can later replace the
// SOURCE MIX ClusterRatioBar.
//
// Two drag modes, mirroring PaletteStrip:
//   • handle mode (default): drag a divider between two segments — mass is
//     conserved across that adjacent pair only.
//   • adaptive mode: drag a segment BODY — it grows/shrinks and every other
//     segment rebalances proportionally so their relative ratios hold.
//
// Optional band-count toggle: when countOptions/count/setCount are supplied,
// a small 3/5/7-style chip row lets the user re-bin the axis. Multipliers are
// owned by the parent and must reset to all-1 when the count changes.

import { useMemo, useRef } from "react";

export interface RatioBarSwatch {
  /** sRGB bytes, 0..255. */
  readonly rgb: readonly [number, number, number];
  /** Natural prevalence, ≥ 0 (need not be normalized — widths normalize). */
  readonly weight: number;
}

interface RatioBarProps {
  /** Segments, parallel to `multipliers`. */
  swatches: readonly RatioBarSwatch[];
  /** Per-segment multipliers, length === swatches.length. 1 = neutral. */
  multipliers: number[];
  setMultipliers: (m: number[]) => void;
  /** Adaptive (body-drag) mode. Omit setAdaptive to hide the mode chip. */
  adaptive?: boolean;
  setAdaptive?: (b: boolean) => void;
  /** Band-count toggle. Supply all three to render the count chip row. */
  count?: number;
  countOptions?: readonly number[];
  setCount?: (n: number) => void;
  disabled?: boolean;
  /** Tooltip on the bar itself. */
  title?: string;
}

const luma = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const BAR_HEIGHT = 22;
const HANDLE_HALF_WIDTH = 6;
const MIN_VISUAL_WIDTH_PCT = 1.5;

const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: "0 5px", fontSize: 10, fontWeight: 600,
  background: active ? "#1473e6" : "transparent",
  color: active ? "#fff" : "#888",
  border: `1px solid ${active ? "#1473e6" : "#444"}`,
  borderRadius: 2, cursor: "pointer", userSelect: "none",
  height: 18, lineHeight: "16px", boxSizing: "border-box",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
});

export function RatioBar(props: RatioBarProps): JSX.Element {
  const { swatches, multipliers, setMultipliers } = props;
  const disabled = !!props.disabled;
  const adaptive = !!props.adaptive;
  const barRef = useRef<HTMLDivElement>(null);

  // Display order: segments sorted by luma dark→light. Indices are sorted,
  // not the data — multipliers stay aligned to the original index.
  const orderedIndices = useMemo(() => {
    return swatches
      .map((s, i) => [i, luma(s.rgb[0], s.rgb[1], s.rgb[2])] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .map(([i]) => i);
  }, [swatches]);

  const lengthOk = swatches.length > 0 && multipliers.length === swatches.length;

  // Count toggle + adaptive chip — the toolbar above the bar.
  const toolbar = (props.countOptions && props.setCount) || props.setAdaptive ? (
    <div style={{ display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end" }}>
      {props.setAdaptive && (
        <div
          onClick={() => { if (!disabled) props.setAdaptive!(!adaptive); }}
          title={adaptive
            ? "Adaptive: drag a segment body to grow/shrink it; others rebalance proportionally. Click for handle mode."
            : "Handle mode: drag the dividers to redistribute weight between neighbors. Click for adaptive (drag segment body)."}
          style={{ ...chipStyle(adaptive), padding: "0 3px", fontSize: 12 }}
        >
          ↔
        </div>
      )}
      {props.countOptions && props.setCount && props.countOptions.map((n) => (
        <div
          key={n}
          onClick={() => { if (!disabled) props.setCount!(n); }}
          style={chipStyle(n === props.count)}
        >
          {n}
        </div>
      ))}
    </div>
  ) : null;

  if (!lengthOk) {
    // No data, or a stale-length array mid-render after a count change.
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {toolbar}
        <div style={{ display: "flex", height: BAR_HEIGHT, gap: 2, opacity: 0.35, width: "100%" }}>
          {Array.from({ length: Math.max(3, swatches.length) }, (_, i) => (
            <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
          ))}
        </div>
      </div>
    );
  }

  // Display value per segment = natural weight × user multiplier.
  const displayValues = orderedIndices.map((idx) => {
    const m = Math.max(0, multipliers[idx] ?? 0);
    const p = Math.max(0, swatches[idx]?.weight ?? 0);
    return m * p;
  });
  const valueSum = displayValues.reduce((a, b) => a + b, 0) || 1;
  const widthsPct = displayValues.map((v) =>
    Math.max(MIN_VISUAL_WIDTH_PCT, (v / valueSum) * 100));
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
    const pLeft = Math.max(1e-6, swatches[idxLeft]?.weight ?? 0);
    const pRight = Math.max(1e-6, swatches[idxRight]?.weight ?? 0);
    const pairValue =
      (multipliers[idxLeft] ?? 0) * pLeft + (multipliers[idxRight] ?? 0) * pRight;
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
      const next = multipliers.slice();
      next[idxLeft] = (pairValue * fracLeft) / pLeft;
      next[idxRight] = (pairValue * (1 - fracLeft)) / pRight;
      setMultipliers(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Body drag (adaptive mode): grow/shrink one segment; others rebalance
  // proportionally. Lifted from PaletteStrip.startBodyDrag.
  const startBodyDrag = (i: number) => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault(); e.stopPropagation();
    const bar = barRef.current;
    if (!bar) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const idx = orderedIndices[i];
    const totalStart = displayValues.reduce((a, b) => a + b, 0) || 1;
    const viStart = displayValues[i] / totalStart;
    const sumOthersStart = 1 - viStart;
    const pi = Math.max(1e-6, swatches[idx]?.weight ?? 0);
    const weightsStart = multipliers.slice();
    const startX = e.clientX;
    const rect = bar.getBoundingClientRect();
    const barWidth = rect.width || 1;
    let sumPOthers = 0;
    for (let j = 0; j < swatches.length; j++) {
      if (j === idx) continue;
      sumPOthers += Math.max(0, swatches[j]?.weight ?? 0);
    }
    const onMove = (ev: PointerEvent) => {
      const dxFrac = (ev.clientX - startX) / barWidth;
      const viNew = Math.max(0, Math.min(1, viStart + dxFrac));
      const next = weightsStart.slice();
      next[idx] = (viNew * totalStart) / pi;
      if (sumOthersStart < 1e-6) {
        // This segment held all the mass at drag-start — redistribute the
        // freed budget by natural prevalence so the user can shrink back.
        if (sumPOthers > 1e-6) {
          const w = (1 - viNew) / sumPOthers;
          for (let j = 0; j < next.length; j++) {
            if (j === idx) continue;
            next[j] = w;
          }
        }
      } else {
        const scale = (1 - viNew) / sumOthersStart;
        for (let j = 0; j < next.length; j++) {
          if (j === idx) continue;
          next[j] = weightsStart[j] * scale;
        }
      }
      setMultipliers(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const isNeutral = multipliers.every((m) => Math.abs(m - 1) < 0.01);
  const resetMultipliers = () => {
    if (disabled || isNeutral) return;
    setMultipliers(swatches.map(() => 1));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {toolbar}
      <div
        ref={barRef}
        onDoubleClick={resetMultipliers}
        style={{
          position: "relative", height: BAR_HEIGHT, width: "100%",
          userSelect: "none", opacity: disabled ? 0.4 : 1,
        }}
        title={props.title ?? (adaptive
          ? "Drag a segment body to grow/shrink it; others rebalance. Double-click to reset."
          : "Drag the dividers to reweight. Double-click to reset.")}
      >
        {orderedIndices.map((idx, i) => {
          const s = swatches[idx];
          const m = multipliers[idx] ?? 0;
          const naturalPct = ((swatches[idx]?.weight ?? 0) * 100).toFixed(0);
          const currentPct = ((displayValues[i] / valueSum) * 100).toFixed(0);
          const multiplierStr = Math.abs(m - 1) < 0.01 ? "neutral" : `×${m.toFixed(2)}`;
          return (
            <div
              key={`seg-${idx}`}
              onPointerDown={adaptive ? startBodyDrag(i) : undefined}
              style={{
                position: "absolute", top: 0, height: BAR_HEIGHT,
                left: `${leftEdges[i]}%`, width: `${displayWidths[i]}%`,
                background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})`,
                border: "1px solid #333", borderRadius: 2,
                opacity: m < 0.02 ? 0.35 : 1,
                cursor: adaptive ? "ew-resize" : "default",
                touchAction: adaptive ? "none" : "auto",
              }}
              title={`rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]}) — natural ${naturalPct}% · current ${currentPct}% · ${multiplierStr}`}
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
    </div>
  );
}
