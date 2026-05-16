// Phase 5 — Conditional CDF P(color | L).
//
// The Phase 3-4 engine matches L / C / h independently: the global chroma and
// hue CDFs rank-map every target pixel onto the WHOLE source's distribution.
// That discards the joint structure that makes a source legible — "dark pixels
// are blue, bright pixels are orange." Hue-by-L recovers the MEAN color per L
// band, but a single averaged (a,b) per bucket can't express within-L spread.
//
// Conditional CDF fixes this for the chroma + hue dimensions: instead of one
// global CDF, build a PER-L-BUCKET chroma CDF and hue CDF. A target pixel at
// lightness L gets its chroma / hue rank-mapped against the source pixels that
// SHARE that L band — restoring L-conditional color spread, not just the mean.
//
// Fully LUT-bakable: no per-pixel random state, no spatial access. Built once
// per snap change, cached on SmashCdfs. The apply-time mechanic is a no-op at
// its default control value (conditionalCdf = 0), so existing presets and LUT
// bakes are byte-identical.
//
// See ColorSmash_Masterplan_v1.1_addendum.md §8.5 and conditional-cdf-design.md.

import { buildCdfMatchLut, type CdfMatchLut } from './cdfMatch';
import type { PixelFeatures } from './types';

/** Number of equal-width L buckets the conditional CDF is sliced into.
 *  Internal resolution parameter, not a creative knob — 12 balances within-L
 *  resolution against per-bucket sample count for typical 16k+ feature sets. */
export const L_BUCKETS = 12;

/** Sub-CDF bin count. Smaller than the global CDFs' 256: each bucket holds
 *  ~1/12 of the samples, so 64 bins keeps per-bucket noise down while
 *  halving memory. */
export const SUB_CDF_BINS = 64;

/**
 * Per-L-bucket chroma + hue CDFs. `chroma[i]` / `hue[i]` are the sub-CDFs for
 * L bucket i; either may be null when that bucket is too sparse on the source
 * OR target side — apply-time falls back to the global CDF for that bucket.
 */
export interface ConditionalCdf {
  /** Bucket count (=== L_BUCKETS); stored for forward-compat. */
  readonly buckets: number;
  /** Source L range the buckets span. Apply-time maps input L into this range. */
  readonly lMin: number;
  readonly lMax: number;
  /** Per-bucket chroma sub-CDF; null = sparse, use the global chromaCdf. */
  readonly chroma: readonly (CdfMatchLut | null)[];
  /** Per-bucket hue sub-CDF (linear on [-π,π]); null = sparse, use global hueCdf. */
  readonly hue: readonly (CdfMatchLut | null)[];
  /** Per-bucket source sample count — diagnostic / audit only. */
  readonly sampleCounts: Int32Array;
}

/** Empty / identity ConditionalCdf — all buckets sparse, so apply-time always
 *  falls back to the global CDF (a strict no-op). */
function emptyConditionalCdf(): ConditionalCdf {
  return {
    buckets: L_BUCKETS,
    lMin: 0,
    lMax: 1,
    chroma: new Array(L_BUCKETS).fill(null),
    hue: new Array(L_BUCKETS).fill(null),
    sampleCounts: new Int32Array(L_BUCKETS),
  };
}

/**
 * Build per-L-bucket chroma + hue CDFs from source/target features.
 * Buckets are equal-width over the SOURCE L range. A bucket is viable only
 * when BOTH its source and target slices clear `viabilityThreshold`; otherwise
 * its slot is null and apply-time falls back to the global CDF.
 *
 * Target pixels are routed into the source-defined buckets by their OWN L —
 * `lumaCdf` already rank-maps the target's L distribution onto the source's,
 * so a target pixel landing in source bucket k is exactly the pixel whose
 * smashed lightness sits in that band.
 *
 * Cost: two O(N) passes over the feature arrays + up to 24 buildCdfMatchLut
 * calls (each sorts ~N/12 values). ~one global-CDF-build × 2 — fine for the
 * snap-cached path, never run on a slider drag.
 */
export function buildConditionalCdf(
  sourceFeatures: PixelFeatures[],
  targetFeatures: PixelFeatures[],
  viabilityThreshold: number,
  hueFilterChroma: number,
): ConditionalCdf {
  if (sourceFeatures.length === 0 || targetFeatures.length === 0) {
    return emptyConditionalCdf();
  }

  // L range from the SOURCE (matches the HueByLumaLut convention).
  let lMin = sourceFeatures[0].luma;
  let lMax = sourceFeatures[0].luma;
  for (let i = 1; i < sourceFeatures.length; i++) {
    const l = sourceFeatures[i].luma;
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
  }
  const lRange = lMax - lMin;
  if (lRange <= 0) return emptyConditionalCdf(); // degenerate single-L source

  const bucketOf = (l: number): number =>
    Math.min(L_BUCKETS - 1, Math.max(0,
      Math.floor(((l - lMin) / lRange) * L_BUCKETS)));

  // Partition source + target chroma / hue values by L bucket.
  const srcC: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const tgtC: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const srcH: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const tgtH: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const sampleCounts = new Int32Array(L_BUCKETS);

  for (const f of sourceFeatures) {
    const k = bucketOf(f.luma);
    srcC[k].push(f.chroma);
    sampleCounts[k]++;
    if (f.chroma >= hueFilterChroma) srcH[k].push(f.hueAngle);
  }
  for (const f of targetFeatures) {
    const k = bucketOf(f.luma);
    tgtC[k].push(f.chroma);
    if (f.chroma >= hueFilterChroma) tgtH[k].push(f.hueAngle);
  }

  const chroma: (CdfMatchLut | null)[] = new Array(L_BUCKETS).fill(null);
  const hue: (CdfMatchLut | null)[] = new Array(L_BUCKETS).fill(null);
  for (let k = 0; k < L_BUCKETS; k++) {
    if (srcC[k].length >= viabilityThreshold &&
        tgtC[k].length >= viabilityThreshold) {
      chroma[k] = buildCdfMatchLut(
        Float32Array.from(srcC[k]), Float32Array.from(tgtC[k]), SUB_CDF_BINS);
    }
    if (srcH[k].length >= viabilityThreshold &&
        tgtH[k].length >= viabilityThreshold) {
      hue[k] = buildCdfMatchLut(
        Float32Array.from(srcH[k]), Float32Array.from(tgtH[k]), SUB_CDF_BINS);
    }
  }

  return { buckets: L_BUCKETS, lMin, lMax, chroma, hue, sampleCounts };
}
