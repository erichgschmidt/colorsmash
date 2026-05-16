// Phase 7 — Stochastic per-L-band sampling (preview-only).
//
// Conditional CDF (Phase 5) recovers within-L colour SPREAD deterministically.
// But CDF matching is still a monotone map — every target pixel at the same
// (Lsm, Cin, hin) gets exactly the same output, so a flat region recolors to
// a perfectly flat region and the source's natural per-pixel GRAIN is averaged
// away. Stochastic sampling restores it: instead of the CDF rank-map, draw a
// random (a,b) sample from the matching source L-band's actual distribution.
//
// This deliberately breaks f(R,G,B)→(R',G',B') purity (same input → different
// output), so it is NOT LUT-bakable — it's a preview-only mechanic. The
// per-pixel uniform is a hash of the pixel's (x,y) coordinates (`hash2u`), so
// the grain is spatially stable and reproducible across re-renders, even
// though it's still keyed on coordinates rather than RGB.
//
// See stochastic-preview-design.md and ColorSmash_Masterplan_v1.1_addendum §8.5.

import type { PixelFeatures } from './types';
import { L_BUCKETS } from './conditionalCdf';

/** Max (a,b) sample pairs retained per L bucket. 256 pairs = 2 KB/bucket;
 *  12 buckets ≈ 24 KB total — varied enough for re-draws, light on the
 *  engine snapshot. Larger buckets are reservoir-sampled down to this cap. */
export const BAND_RESERVOIR_CAP = 256;

/** Empirical (a,b) sample reservoir for one image, sliced by L bucket.
 *  Built once per snap change next to ConditionalCdf; frozen engine state. */
export interface StochasticBands {
  /** === L_BUCKETS. Stored for forward-compat. */
  readonly buckets: number;
  /** Source L range the buckets span (mirrors ConditionalCdf.lMin/lMax). */
  readonly lMin: number;
  readonly lMax: number;
  /** Per-bucket flat (a,b) pairs: samples[k] has length 2×counts[k].
   *  Pair j is (samples[k][2j], samples[k][2j+1]). Empty when sparse. */
  readonly samples: readonly Float32Array[];
  /** Per-bucket retained sample count (samples[k].length / 2). */
  readonly counts: Int32Array;
}

/** Deterministic, seedable PRNG (mulberry32) — used for the build-time
 *  reservoir fill so the engine snapshot is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit integer hash of (x, y, seed) → uniform [0, 1). Spatially stable: the
 * same pixel always draws the same sample for a given seed, so the grain is
 * frozen in place across re-renders (no shimmer). Changing `seed` re-rolls the
 * whole field. Still a function of (x,y) — NOT of (R,G,B) — so it does not
 * make the transform LUT-bakable.
 */
export function hash2u(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x8da6b343) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function emptyStochasticBands(): StochasticBands {
  return {
    buckets: L_BUCKETS,
    lMin: 0,
    lMax: 1,
    samples: Array.from({ length: L_BUCKETS }, () => new Float32Array(0)),
    counts: new Int32Array(L_BUCKETS),
  };
}

/**
 * Build the per-L-bucket (a,b) sample reservoir from the source features.
 * Buckets match ConditionalCdf's `L_BUCKETS` equal-width slices over the
 * source L range. Buckets with more than `BAND_RESERVOIR_CAP` pixels are
 * reservoir-sampled (Algorithm R) to an unbiased uniform subsample;
 * `rngSeed` makes that fill deterministic so the snapshot is reproducible.
 */
export function buildStochasticBands(
  sourceFeatures: PixelFeatures[],
  rngSeed = 0x9e3779b9,
): StochasticBands {
  if (sourceFeatures.length === 0) return emptyStochasticBands();

  let lMin = sourceFeatures[0].luma;
  let lMax = lMin;
  for (let i = 1; i < sourceFeatures.length; i++) {
    const l = sourceFeatures[i].luma;
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
  }
  const lRange = lMax - lMin;
  if (lRange <= 0) return emptyStochasticBands();

  const bucketOf = (l: number): number =>
    Math.min(L_BUCKETS - 1, Math.max(0,
      Math.floor(((l - lMin) / lRange) * L_BUCKETS)));

  const reservoirs: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const seen = new Int32Array(L_BUCKETS);
  const rng = mulberry32(rngSeed);
  for (const f of sourceFeatures) {
    const k = bucketOf(f.luma);
    const n = seen[k]++;
    const a = f.oklab[1];
    const b = f.oklab[2];
    if (n < BAND_RESERVOIR_CAP) {
      reservoirs[k].push(a, b);
    } else {
      // Algorithm R — keep an unbiased uniform subsample.
      const j = Math.floor(rng() * (n + 1));
      if (j < BAND_RESERVOIR_CAP) {
        reservoirs[k][2 * j] = a;
        reservoirs[k][2 * j + 1] = b;
      }
    }
  }
  const samples = reservoirs.map((r) => Float32Array.from(r));
  const counts = Int32Array.from(samples.map((s) => s.length / 2));
  return { buckets: L_BUCKETS, lMin, lMax, samples, counts };
}

/**
 * Draw one random source (a,b) sample for a pixel, routed by its smashed L.
 * `u` is the pixel's uniform random in [0,1) (from `hash2u`). Stochastic
 * interpolation: a decorrelated second uniform picks one of the two L
 * buckets straddling `Lsm` — same expected mix as a linear blend, but never
 * averages two colours into a muddy mean. Returns null when the routed
 * bucket (and its sibling) are both empty — caller falls back to the
 * deterministic result.
 */
export function sampleBandColor(
  sb: StochasticBands,
  Lsm: number,
  u: number,
): { a: number; b: number } | null {
  if (sb.lMax <= sb.lMin || sb.buckets < 2) return null;
  const clampedL = Math.max(sb.lMin, Math.min(sb.lMax, Lsm));
  const t = ((clampedL - sb.lMin) / (sb.lMax - sb.lMin)) * (sb.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, sb.buckets - 1);
  const frac = t - k0;
  const u2 = (u * 1.6180339887 + 0.5) % 1; // decorrelated second uniform
  let k = u2 < frac ? k1 : k0;
  if (sb.counts[k] === 0) k = k === k1 ? k0 : k1; // try the sibling bucket
  if (sb.counts[k] === 0) return null;            // both sparse → fall back
  const j = Math.min(sb.counts[k] - 1, Math.floor(u * sb.counts[k]));
  const arr = sb.samples[k];
  return { a: arr[2 * j], b: arr[2 * j + 1] };
}
