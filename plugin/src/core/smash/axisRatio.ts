// Phase 6 — source-axis ratio reweighting.
//
// A "source ratio" lets the user reshape the SOURCE's histogram along one
// dimension before the CDF match runs. Bin the source's sorted values for an
// axis into N equal-width bands, scale each band's mass by a user multiplier,
// then synthesize a reweighted sorted sample array. Feeding that to
// buildCdfMatchLut produces a CDF that drags the target onto the user-edited
// source shape — "apply the ratio from the source, the target matches it."
//
// This module is axis-agnostic: it operates on a plain sorted Float32Array,
// so the same code serves the Value (L), Hue and Saturation axes. The Value
// axis ships first (see SmashSection's SOURCE RATIOS section).
//
// Everything here is pure and cheap (O(N) over the sample array), so the
// reweight + CDF rebuild can run per slider drag inside smash() without the
// snap-cached buildSmashCdfs penalty.

/** A band-count below this is meaningless; callers clamp before calling. */
const MIN_BANDS = 2;

/**
 * Returns true when every multiplier is ≈ 1 (neutral) — the caller can then
 * skip the reweight entirely and reuse the natural CDF byte-for-byte. A
 * length mismatch is also treated as neutral (a stale array must not corrupt
 * the distribution).
 */
export function isNeutralRatio(
  multipliers: readonly number[] | undefined,
  bandCount: number,
): boolean {
  if (!multipliers || multipliers.length !== bandCount) return true;
  for (let i = 0; i < bandCount; i++) {
    const m = multipliers[i];
    if (typeof m !== 'number' || !Number.isFinite(m) || Math.abs(m - 1) > 1e-4) {
      return false;
    }
  }
  return true;
}

/**
 * Per-band slice boundaries for a sorted array binned into `bandCount`
 * equal-width bands over [sorted[0], sorted[last]]. `starts[b]` / `counts[b]`
 * describe the contiguous slice of `sorted` that falls in band b.
 */
interface BandSlices {
  readonly starts: Int32Array;
  readonly counts: Int32Array;
  readonly lMin: number;
  readonly lMax: number;
}

function sliceByBands(sorted: Float32Array, bandCount: number): BandSlices {
  const starts = new Int32Array(bandCount);
  const counts = new Int32Array(bandCount);
  const n = sorted.length;
  if (n === 0) return { starts, counts, lMin: 0, lMax: 0 };
  const lMin = sorted[0];
  const lMax = sorted[n - 1];
  const range = lMax - lMin;
  if (range <= 0) {
    // Degenerate single-value source — everything in band 0.
    counts[0] = n;
    return { starts, counts, lMin, lMax };
  }
  const bandOf = (v: number) =>
    Math.min(bandCount - 1, Math.max(0,
      Math.floor(((v - lMin) / range) * bandCount)));
  // Single linear pass — `sorted` is ascending so band assignment is monotone.
  let cur = 0;
  starts[0] = 0;
  for (let i = 0; i < n; i++) {
    const b = bandOf(sorted[i]);
    while (cur < b) { cur++; starts[cur] = i; }
    counts[cur]++;
  }
  // Bands above the last populated one start at n (empty slices).
  for (let b = cur + 1; b < bandCount; b++) starts[b] = n;
  return { starts, counts, lMin, lMax };
}

/**
 * Natural per-band weights of a sorted source array — the band populations
 * normalized to sum to 1. Used by the UI to draw the ratio bar's segment
 * widths at their unedited (neutral) proportions.
 */
export function naturalBandWeights(
  sorted: Float32Array,
  bandCount: number,
): Float32Array {
  const bands = Math.max(MIN_BANDS, Math.floor(bandCount));
  const out = new Float32Array(bands);
  const n = sorted.length;
  if (n === 0) {
    out.fill(1 / bands); // no data → uniform so the bar still renders
    return out;
  }
  const { counts } = sliceByBands(sorted, bands);
  for (let b = 0; b < bands; b++) out[b] = counts[b] / n;
  return out;
}

/** Resample a sorted slice `src[start, start+count)` to `m` ascending points
 *  via linear interpolation, writing into `out` at `outOffset`. */
function resampleSlice(
  src: Float32Array,
  start: number,
  count: number,
  m: number,
  out: Float32Array,
  outOffset: number,
): void {
  if (m <= 0) return;
  if (m === 1) {
    out[outOffset] = src[start + (count >> 1)];
    return;
  }
  for (let j = 0; j < m; j++) {
    const pos = (j / (m - 1)) * (count - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, count - 1);
    const frac = pos - i0;
    out[outOffset + j] =
      src[start + i0] + (src[start + i1] - src[start + i0]) * frac;
  }
}

/**
 * Synthesize a reweighted, sorted source sample array.
 *
 * Each band b's contribution to the output is `M × (count_b × mult_b) / Σ`,
 * resampled from that band's slice of `sorted`. A band with multiplier 0
 * vanishes (the CDF will never map a target pixel into that L range); a band
 * boosted above 1 occupies a larger share of the output distribution.
 *
 * The result is globally sorted (bands are L-ordered and each band's resample
 * is ascending), so it drops straight into buildCdfMatchLut.
 *
 * `sorted` is returned unchanged (a copy) when the ratio is neutral or
 * degenerate, so the neutral path is exact.
 */
export function reweightSourceByBands(
  sorted: Float32Array,
  bandCount: number,
  multipliers: readonly number[],
): Float32Array {
  const bands = Math.max(MIN_BANDS, Math.floor(bandCount));
  const n = sorted.length;
  if (n === 0 || isNeutralRatio(multipliers, bands)) {
    return sorted.slice();
  }
  const { starts, counts, lMin, lMax } = sliceByBands(sorted, bands);
  const range = lMax - lMin;
  if (range <= 0) return sorted.slice(); // degenerate single-value source

  // Effective per-band mass = population × multiplier (clamped ≥ 0).
  const eff = new Float64Array(bands);
  let totalEff = 0;
  for (let b = 0; b < bands; b++) {
    const m = multipliers[b];
    const mult = typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : 1;
    eff[b] = counts[b] * mult;
    totalEff += eff[b];
  }
  if (totalEff <= 0) return sorted.slice(); // all weights zero — no-op

  // Sample budget per band, then total output length.
  const mPer = new Int32Array(bands);
  let outLen = 0;
  for (let b = 0; b < bands; b++) {
    const m = Math.round((eff[b] / totalEff) * n);
    mPer[b] = m;
    outLen += m;
  }
  if (outLen === 0) return sorted.slice();

  const out = new Float32Array(outLen);
  let off = 0;
  for (let b = 0; b < bands; b++) {
    const m = mPer[b];
    if (m === 0) continue;
    if (counts[b] > 0) {
      resampleSlice(sorted, starts[b], counts[b], m, out, off);
    } else {
      // Band is empty in the source but the user wants mass there — fill
      // with the band's center L so the CDF still has something to map to.
      const center = lMin + ((b + 0.5) / bands) * range;
      for (let j = 0; j < m; j++) out[off + j] = center;
    }
    off += m;
  }
  return out;
}
