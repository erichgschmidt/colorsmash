// CDF histogram matching: force a target dimension's value distribution to mirror the
// source's — same proportional ratios, compressed/expanded onto the target's actual range.
// Algorithm: matched(t) = sourceInvCdf(targetCdf(t)), implemented as a Float32Array LUT
// with linear interpolation at lookup time for smooth output on continuous OkLCh dimensions.

export interface CdfMatchLut {
  /** Number of buckets. */
  readonly bins: number;
  /** Min and max target values the LUT was built against. Input value space.
   *  Used at lookup time to normalize the input to a bucket index. */
  readonly tMin: number;
  readonly tMax: number;
  /** Per-bucket output value in source's value range. */
  readonly values: Float32Array;
}

/**
 * Returns the insertion index that keeps `sorted` in ascending order —
 * i.e. the count of elements strictly less than `value`. Runs in O(log n).
 * Does NOT mutate the input array.
 */
function binarySearchRank(sorted: Float32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build a `bins`-bucket lookup table that maps every value in target's range
 * to the source-CDF-equivalent value. Apply at lookup time via linear
 * interpolation between adjacent buckets.
 *
 * Algorithm:
 *   1. Sort source and target values independently (sorted copies — inputs untouched).
 *   2. For each bucket i in [0, bins), compute the target input value at that
 *      bucket: tValue = tMin + (i / (bins-1)) * tRange.
 *   3. Find tValue's rank in targetSorted via binary search -> percentile in [0, 1].
 *   4. Look up the source value at that same percentile in sourceSorted.
 *   5. Store at lut.values[i].
 *
 * Edge cases:
 *   - Empty source or target -> identity LUT over [0, 1].
 *   - Collapsed target (tMax === tMin) -> constant LUT at sourceSorted[0].
 */
export function buildCdfMatchLut(
  sourceValues: Float32Array,
  targetValues: Float32Array,
  bins = 256,
): CdfMatchLut {
  const b = Math.max(2, bins);

  // Empty source or target: identity over [0, 1].
  if (sourceValues.length === 0 || targetValues.length === 0) {
    const values = new Float32Array(b);
    for (let i = 0; i < b; i++) values[i] = i / (b - 1);
    return { bins: b, tMin: 0, tMax: 1, values };
  }

  const sourceSorted = new Float32Array(sourceValues).sort();
  const targetSorted = new Float32Array(targetValues).sort();

  const tMin = targetSorted[0];
  const tMax = targetSorted[targetSorted.length - 1];
  const tRange = tMax - tMin;

  // Collapsed target (all pixels same value): every bucket maps to source's modal value.
  if (tRange === 0) {
    const sourceFirst = sourceSorted[0];
    const values = new Float32Array(b).fill(sourceFirst);
    return { bins: b, tMin, tMax, values };
  }

  const srcLen = sourceSorted.length;
  const tgtLen = targetSorted.length;
  const values = new Float32Array(b);

  for (let i = 0; i < b; i++) {
    const tValue = tMin + (i / (b - 1)) * tRange;
    // Percentile of tValue in target distribution.
    const rank = binarySearchRank(targetSorted, tValue);
    const percentile = rank / tgtLen;
    // Source value at that percentile.
    const srcIdx = Math.min(srcLen - 1, Math.floor(percentile * srcLen));
    values[i] = sourceSorted[srcIdx];
  }

  return { bins: b, tMin, tMax, values };
}

/**
 * Apply a CdfMatchLut to a single input value. Linear interpolation between
 * adjacent buckets. Inputs outside [tMin, tMax] clamp to the LUT's first /
 * last bucket. Returns the matched value in source's value range.
 */
export function lookupCdfMatch(lut: CdfMatchLut, value: number): number {
  const { bins, tMin, tMax, values } = lut;
  const tRange = tMax - tMin;

  // Collapsed or degenerate: all buckets hold the same value.
  if (tRange === 0) return values[0];

  // Normalize to bucket space [0, bins-1].
  const t = ((value - tMin) / tRange) * (bins - 1);

  // Clamp to valid range.
  if (t <= 0) return values[0];
  if (t >= bins - 1) return values[bins - 1];

  const i0 = Math.floor(t);
  const i1 = i0 + 1; // guaranteed in-bounds because t < bins-1
  const frac = t - i0;

  return values[i0] + (values[i1] - values[i0]) * frac;
}
