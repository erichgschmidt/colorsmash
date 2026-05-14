// Phase 4.5 colorization primitive: maps Oklab L → average (a, b) from source pixels.
// Solves the "colorize grayscale target" case where per-dimension CDF match cannot invent
// chroma structure. Build from source features; apply to each target pixel's L after CDF
// match to assign source-correlated hue without hallucinating new color relationships.

import type { PixelFeatures } from './types';

/**
 * A 1D LUT mapping Oklab L (in lMin..lMax range; almost always 0..1 but
 * tracks the actual data range for safety) to the source's average (a, b)
 * components at that L. Linear-interpolated at lookup time.
 *
 * Used by Phase 4.5 colorization when target chroma is too low for the
 * per-dimension CDF match to work — i.e. the "colorize grayscale" case.
 */
export interface HueByLumaLut {
  /** Number of buckets in the LUT. */
  readonly bins: number;
  /** L range the LUT was built against (inputs outside this range clamp). */
  readonly lMin: number;
  readonly lMax: number;
  /** Per-bucket [a, b] pairs. Length = bins * 2. Index = bucketIndex * 2;
   *  values[i+0] is a, values[i+1] is b. */
  readonly values: Float32Array;
  /** Per-bucket sample count, so callers can detect empty/sparse buckets if
   *  they care. Length = bins. */
  readonly sampleCounts: Int32Array;
}

/**
 * Build the L → (avg a, avg b) LUT from a feature array (usually source
 * features). Bins source features by L into `bins` equal-width buckets
 * across the data's [Lmin, Lmax] range, then averages the (a, b) values
 * within each bucket.
 *
 * Empty buckets (zero source samples) inherit from the nearest non-empty
 * neighbor so lookups never return zero for an L value sitting between
 * sparse buckets. If ALL buckets are empty (degenerate input), the LUT is
 * returned with all-zero values (the lookup will produce neutral (0,0)).
 *
 * Defaults: bins=64. Higher = sharper color-by-L transitions but more
 * noise per bucket; 64 is a good balance for ~16K-100K source features.
 */
export function buildHueByLumaLut(
  sourceFeatures: PixelFeatures[],
  bins = 64,
): HueByLumaLut {
  const b = Math.max(1, bins);

  // Empty input: return a degenerate all-zero LUT.
  if (sourceFeatures.length === 0) {
    return {
      bins: b,
      lMin: 0,
      lMax: 1,
      values: new Float32Array(b * 2),
      sampleCounts: new Int32Array(b),
    };
  }

  // Pass 1: find L range.
  let lMin = sourceFeatures[0].luma;
  let lMax = sourceFeatures[0].luma;
  for (let i = 1; i < sourceFeatures.length; i++) {
    const l = sourceFeatures[i].luma;
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
  }

  const lRange = lMax - lMin;
  const sumA = new Float64Array(b);
  const sumB = new Float64Array(b);
  // Scalar sum of chroma magnitudes (sqrt(a²+b²)) per bucket. The vector mean
  // (sumA/N, sumB/N) gives DIRECTION but its magnitude collapses toward zero
  // when a bucket has hues that cancel (e.g. red AND cyan at the same L). To
  // preserve the bucket's typical chroma we average the magnitudes separately
  // and rescale the vector mean to that magnitude below.
  const sumC = new Float64Array(b);
  const sampleCounts = new Int32Array(b);

  // Pass 2: accumulate per bucket.
  for (let i = 0; i < sourceFeatures.length; i++) {
    const f = sourceFeatures[i];
    let bucket: number;
    if (lRange === 0) {
      bucket = 0;
    } else {
      bucket = Math.min(b - 1, Math.max(0, Math.floor(((f.luma - lMin) / lRange) * (b - 1))));
    }
    const a = f.oklab[1];
    const fb = f.oklab[2];
    sumA[bucket] += a;
    sumB[bucket] += fb;
    sumC[bucket] += Math.sqrt(a * a + fb * fb);
    sampleCounts[bucket]++;
  }

  // Pass 3: compute per-bucket magnitude-preserving averages. For each
  // populated bucket we take the vector mean for DIRECTION and the scalar
  // mean of chroma for MAGNITUDE, then rescale to combine them. Effect:
  // - bucket with one dominant hue (all-red): direction strong, magnitude
  //   strong, factor ≈ 1 → output unchanged from naive average
  // - bucket with mixed hues (red + cyan): direction weak (cancels),
  //   magnitude strong → output preserves the dominant direction at the
  //   typical chroma level instead of collapsing to ~zero
  const values = new Float32Array(b * 2);
  for (let i = 0; i < b; i++) {
    if (sampleCounts[i] > 0) {
      const inv = 1 / sampleCounts[i];
      const avgA = sumA[i] * inv;
      const avgB = sumB[i] * inv;
      const avgC = sumC[i] * inv;
      const vecMag = Math.sqrt(avgA * avgA + avgB * avgB);
      if (vecMag > 1e-6) {
        // Rescale unit direction by the average chroma magnitude.
        const scale = avgC / vecMag;
        values[i * 2 + 0] = avgA * scale;
        values[i * 2 + 1] = avgB * scale;
      } else {
        // Full cancellation — bucket has no dominant direction. Output 0
        // contribution (the bucket's typical pixel really is neutral on
        // average even if individual pixels have chroma).
        values[i * 2 + 0] = 0;
        values[i * 2 + 1] = 0;
      }
    }
    // Empty buckets remain 0 — filled in pass 4.
  }

  // Pass 4: fill empty buckets via nearest-neighbor sweep.
  // Forward sweep: carry last seen non-empty values left-to-right.
  let lastA = 0;
  let lastB = 0;
  let seenAny = false;
  // Track which buckets had data so we can distinguish filled-forward from original.
  const hasData = new Uint8Array(b);
  for (let i = 0; i < b; i++) {
    if (sampleCounts[i] > 0) {
      lastA = values[i * 2 + 0];
      lastB = values[i * 2 + 1];
      hasData[i] = 1;
      seenAny = true;
    } else if (seenAny) {
      values[i * 2 + 0] = lastA;
      values[i * 2 + 1] = lastB;
    }
  }

  // If no data at all, return all-zero LUT as-is.
  if (!seenAny) {
    return { bins: b, lMin, lMax, values, sampleCounts };
  }

  // Backward sweep: fill leading empty buckets (before the first non-empty one).
  let firstA = 0;
  let firstB = 0;
  for (let i = 0; i < b; i++) {
    if (hasData[i]) {
      firstA = values[i * 2 + 0];
      firstB = values[i * 2 + 1];
      break;
    }
  }
  for (let i = 0; i < b; i++) {
    if (hasData[i]) break;
    values[i * 2 + 0] = firstA;
    values[i * 2 + 1] = firstB;
  }

  return { bins: b, lMin, lMax, values, sampleCounts };
}

/**
 * Look up the (a, b) at a given L. Linear interpolation between adjacent
 * buckets. Inputs outside [lMin, lMax] clamp to the LUT's first/last
 * bucket. Returns a tuple [a, b].
 */
export function lookupHueByLuma(lut: HueByLumaLut, L: number): readonly [number, number] {
  const { bins, lMin, lMax, values } = lut;

  if (bins === 0) return [0, 0];

  // Single bucket: no interpolation needed.
  if (bins === 1) return [values[0], values[1]];

  // Clamp L to valid range.
  const lClamped = L < lMin ? lMin : L > lMax ? lMax : L;

  const lRange = lMax - lMin;
  let pos: number;
  if (lRange === 0) {
    pos = 0;
  } else {
    pos = ((lClamped - lMin) / lRange) * (bins - 1);
  }

  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, bins - 1);
  const frac = pos - i0;

  const a = values[i0 * 2 + 0] * (1 - frac) + values[i1 * 2 + 0] * frac;
  const b = values[i0 * 2 + 1] * (1 - frac) + values[i1 * 2 + 1] * frac;

  return [a, b];
}
