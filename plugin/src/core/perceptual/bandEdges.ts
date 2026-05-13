// Adaptive band-edge detection over perceptual luma populations.
// Percentile-based inner edges track the actual tonal distribution of the image,
// so bands contain roughly equal numbers of pixels regardless of histogram shape.
// Outer edges use the data's true min/max rather than 0/1 so empty extremes don't
// create ghost bands with no content.

// Inner-edge percentiles per band count. Each entry is (count-1)/2 symmetric
// breakpoints expressed as fractions 0..1.
const INNER_PERCENTILES: Record<3 | 5 | 7, number[]> = {
  3: [1 / 3, 2 / 3],
  5: [1 / 5, 2 / 5, 3 / 5, 4 / 5],
  7: [1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7],
};

/**
 * Returns count+1 edge values in [0..1], with adaptive percentile-based inner
 * edges and the data's min/max for the outer edges. For count=3, the inner
 * edges are P33 and P67. For count=5 they're P20/P40/P60/P80. For count=7 they're
 * P14/P29/P43/P57/P71/P86. The lumas array is expected to be non-empty.
 */
export function adaptiveBandEdges(lumas: Float32Array, count: 3 | 5 | 7): number[] {
  const sorted = lumas.slice().sort();
  const n = sorted.length;

  const percentile = (p: number): number => {
    // Linear interpolation between adjacent sorted values.
    const idx = p * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n - 1);
    const frac = idx - lo;
    return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
  };

  const inner = INNER_PERCENTILES[count].map(percentile);
  return [sorted[0]!, ...inner, sorted[n - 1]!];
}
