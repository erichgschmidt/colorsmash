// Smash cluster ratio bar (Phase 4.5s). The Color Match "ratio slider"
// (PaletteStrip) ported to the Smash section: each source cluster becomes a
// horizontal segment whose width is proportional to its prevalence × the
// user's multiplier. Dragging a handle between two segments redistributes
// mass-conservingly — "give me more of the orange, less of the sky" — and
// the engine feeds those multipliers into adjustedClusterWeights, so the
// DISTRIBUTION mechanic blends the target toward the re-weighted source mix.
//
// Differences from PaletteStrip:
//   • No count toggle — the ENGINE > ZONES slider (3..32) owns cluster count.
//   • No adaptive / softness / mask / preset machinery — just the core
//     pair-wise handle drag, which is the "ratio" gesture the user asked for.
//   • Multipliers reset to all-1 whenever the source / cluster count changes
//     (handled by the parent), since clusters are source-specific.
//
// The bar reads dark→light left-to-right (segments sorted by luma) so it
// lines up with the SOURCE DNA strip above it.

import { useMemo, useRef } from "react";

export interface ClusterRatioSwatch {
  /** sRGB bytes, 0..255 — straight from ClusterStats.rgb. */
  readonly rgb: readonly [number, number, number];
  /** Natural prevalence in the source, 0..1 (k-means population share). */
  readonly weight: number;
}

interface ClusterRatioBarProps {
  /** Source clusters, parallel to `multipliers`. From sourceDNA.clusters. */
  swatches: readonly ClusterRatioSwatch[];
  /** Per-cluster multipliers, length === swatches.length. 1 = neutral. */
  multipliers: number[];
  setMultipliers: (m: number[]) => void;
  disabled?: boolean;
}

const luma = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const BAR_HEIGHT = 22;
const HANDLE_HALF_WIDTH = 6;       // each handle's clickable half-width in px
const MIN_VISUAL_WIDTH_PCT = 1.5;  // smallest visible segment so a 0-weight cluster stays grabbable

export function ClusterRatioBar(props: ClusterRatioBarProps): JSX.Element | null {
  const { swatches, multipliers, setMultipliers } = props;
  const disabled = !!props.disabled;
  const barRef = useRef<HTMLDivElement>(null);

  // Display order: sort cluster indices by luma dark→light so the bar reads
  // as a value gradient. We sort indices — multipliers stay aligned to the
  // original cluster index, which is what the engine expects.
  const orderedIndices = useMemo(() => {
    return swatches
      .map((s, i) => [i, luma(s.rgb[0], s.rgb[1], s.rgb[2])] as [number, number])
      .sort((a, b) => a[1] - b[1])
      .map(([i]) => i);
  }, [swatches]);

  // Detect "is neutral" (all multipliers ≈ 1) to dim the reset affordance.
  const isNeutral = useMemo(
    () => multipliers.length > 0 && multipliers.every((m) => Math.abs(m - 1) < 0.01),
    [multipliers],
  );

  if (swatches.length === 0 || multipliers.length !== swatches.length) {
    // No clusters yet, or a stale-length array mid-render after a ZONES
    // change — render a flat placeholder rather than a broken bar.
    return (
      <div
        style={{
          display: "flex", height: BAR_HEIGHT, gap: 2, opacity: 0.35,
          width: "100%",
        }}
      >
        {Array.from({ length: Math.max(3, swatches.length) }, (_, i) => (
          <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
        ))}
      </div>
    );
  }

  // Display value per cluster = natural prevalence × user multiplier. With all
  // multipliers = 1 the segment widths reflect the natural k-means prevalence.
  const displayValues = orderedIndices.map((idx) => {
    const m = Math.max(0, multipliers[idx] ?? 0);
    const p = Math.max(0, swatches[idx]?.weight ?? 0);
    return m * p;
  });
  const valueSum = displayValues.reduce((a, b) => a + b, 0) || 1;
  // Width % per segment, with a min-visual clamp so a zeroed segment stays grabbable.
  const widthsPct = displayValues.map((v) =>
    Math.max(MIN_VISUAL_WIDTH_PCT, (v / valueSum) * 100),
  );
  const widthSum = widthsPct.reduce((a, b) => a + b, 0);
  const displayWidths = widthsPct.map((w) => (w / widthSum) * 100);

  // Cumulative left-edge % per segment, in display order (for handle placement).
  const leftEdges: number[] = [];
  {
    let acc = 0;
    for (const w of displayWidths) { leftEdges.push(acc); acc += w; }
  }

  // Pair-wise drag (handle between two segments): mass-conserving across the
  // two adjacent segments only. The pair's total displayValue stays constant;
  // segments outside the pair are unchanged. (Lifted from PaletteStrip's
  // startHandleDrag — the default non-adaptive mode.)
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

  // Double-click anywhere on the bar resets all multipliers to neutral (1).
  const resetMultipliers = () => {
    if (disabled || isNeutral) return;
    setMultipliers(swatches.map(() => 1));
  };

  return (
    <div
      ref={barRef}
      onDoubleClick={resetMultipliers}
      style={{
        position: "relative", height: BAR_HEIGHT, width: "100%",
        userSelect: "none", opacity: disabled ? 0.4 : 1,
      }}
      title="Source mix — drag the white dividers to reweight how prominent each source cluster is in the smashed output. Double-click to reset all to neutral. Feeds the DISTRIBUTION mechanic."
    >
      {/* Segments — solid color blocks meeting at hard boundaries. */}
      {orderedIndices.map((idx, i) => {
        const s = swatches[idx];
        const m = multipliers[idx] ?? 0;
        const naturalPct = (s.weight * 100).toFixed(0);
        const currentPct = ((displayValues[i] / valueSum) * 100).toFixed(0);
        const multiplierStr = Math.abs(m - 1) < 0.01 ? "neutral" : `×${m.toFixed(2)}`;
        return (
          <div
            key={`seg-${idx}`}
            style={{
              position: "absolute", top: 0, height: BAR_HEIGHT,
              left: `${leftEdges[i]}%`, width: `${displayWidths[i]}%`,
              background: `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]})`,
              border: "1px solid #333", borderRadius: 2,
              opacity: m < 0.02 ? 0.35 : 1,
            }}
            title={`rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]}) — natural ${naturalPct}% · current ${currentPct}% · ${multiplierStr}`}
          />
        );
      })}
      {/* Draggable boundary handles between adjacent cluster segments. */}
      {orderedIndices.slice(0, -1).map((_, i) => {
        const x = leftEdges[i] + displayWidths[i]; // boundary between i and i+1
        return (
          <div
            key={`handle-${i}`}
            onPointerDown={startHandleDrag(i)}
            style={{
              position: "absolute", top: -1, height: BAR_HEIGHT + 2,
              left: `calc(${x}% - ${HANDLE_HALF_WIDTH}px)`,
              width: HANDLE_HALF_WIDTH * 2,
              cursor: disabled ? "default" : "ew-resize",
              touchAction: "none",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div
              style={{
                width: 2, height: BAR_HEIGHT - 4, background: "#fff",
                opacity: 0.6, borderRadius: 1, pointerEvents: "none",
                boxShadow: "0 0 2px rgba(0,0,0,0.6)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
