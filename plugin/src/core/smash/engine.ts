// Pro Smash Engine v2 — per-aspect band transfer.
//
// The Smash redesign. Instead of one master "amount" + a stack of opaque
// mechanics, the transform is broken into four independent ASPECTS:
//
//   value      — Oklab L (tonal distribution)
//   hue        — Oklab hue angle
//   saturation — S = C / L  (colorfulness relative to lightness)
//   chroma     — Oklab C    (absolute colorfulness)
//
// For each aspect:
//   • the SOURCE image's distribution along that axis is a histogram,
//   • the TARGET image's distribution along that axis is a histogram,
//   • BOTH are user-editable "ratio bands" — the band IS the distribution
//     (absolute per-bin weights), so any bin can be reshaped even when the
//     image has zero pixels there (e.g. the hue band of a grayscale image),
//   • a per-aspect "borrow amount" in [0,1] controls how far the target's
//     pixels are rank-transferred onto the source's distribution,
//   • a per-aspect "softness" smooths both bands' histograms before the CDF
//     is built, so the transfer's slice-to-slice transitions are gradual
//     instead of hard-stepped.
//
// Per pixel, per aspect:  rank = targetCDF(x);  smashed = sourceCDF⁻¹(rank);
//                         out  = lerp(x, smashed, amount)
// L, C, h are recombined → Oklab → sRGB.
//
// Each aspect has its OWN bin count (the number of editable slices).
//
// Grayscale colorization falls out for free: when the target band has no
// spread (a grayscale image's hue/chroma/saturation), that aspect's own
// rank carries no information, so the transfer borrows the pixel's VALUE
// rank instead — colour-by-luma without a separate mode.
//
// applySmash is a pure function of (r,g,b) → bakeable to a 3D LUT.

import { srgbByteToOklab, oklabToSrgbByte, oklchToOklab } from "../perceptual/oklab";

/** Default number of slices in an aspect's ratio band. */
export const DEFAULT_BIN_COUNT = 16;
/** Selectable slice counts — coarse (4) through fine (32). */
export const BIN_COUNT_OPTIONS: readonly number[] = [4, 8, 16, 32];

/** Oklab chroma upper bound used to normalize the Chroma axis to [0,1].
 *  sRGB content tops out near 0.33–0.37; 0.40 leaves headroom. */
const CHROMA_MAX = 0.4;
/** S = C/L clamp used to normalize the Saturation axis to [0,1]. */
const SAT_MAX = 2.0;
/** A target aspect distribution with more than this fraction of its mass in
 *  a single bin carries no usable rank — the transfer falls back to the
 *  value rank (this is what makes grayscale colorization work). */
const DEGENERATE_FRACTION = 0.85;
/** Maximum 3-tap blur passes the softness control applies. */
const MAX_SOFT_PASSES = 6;
/** Hue-histogram chroma weighting: pixels below MIN contribute nothing, ramp
 *  to full weight over the next RAMP of Oklab chroma. */
const HUE_CHROMA_MIN = 0.03;
const HUE_CHROMA_RAMP = 0.05;
const EPS = 1e-6;
const TWO_PI = Math.PI * 2;

export type AspectKey = "value" | "hue" | "saturation" | "chroma";
export const ASPECT_KEYS: readonly AspectKey[] = ["value", "hue", "saturation", "chroma"];

/** Rank-by selector values for the UI dropdown. An aspect's stored `rankBy`
 *  is always a CONCRETE axis; "auto" is only a dropdown action — picking it
 *  resolves to a concrete axis on the spot (own axis, or Value when the
 *  channel is flat). So the band, the dropdown, and the engine never desync. */
export type RankBy = "auto" | AspectKey;
export const RANK_BY_OPTIONS: readonly RankBy[] = [
  "auto", "value", "hue", "saturation", "chroma",
];

/** Coerce any value to a concrete rank axis (used on persistence load). */
export function coerceRankAxis(v: unknown): AspectKey {
  return v === "hue" || v === "saturation" || v === "chroma" ? v : "value";
}

export type RgbTriplet = readonly [number, number, number];

/** One aspect's control state.
 *  - `binCount`: number of slices.
 *  - `sourceBand` / `targetBand`: ABSOLUTE per-bin weights forming the
 *    distribution (length `binCount`). Initialized to the extracted natural
 *    histogram; the user reshapes them directly. An all-equal band is a
 *    uniform distribution; the engine doesn't treat any band as "neutral".
 *  - `amount`: borrow/smash strength [0,1].
 *  - `softness`: [0,1] — smooths both bands before the CDF is built.
 *  - `rankBy`: which axis supplies the transfer's rank (the cross-feed). */
export interface AspectControl {
  readonly binCount: number;
  readonly sourceBand: readonly number[];
  readonly targetBand: readonly number[];
  readonly amount: number;
  readonly softness: number;
  /** The concrete axis whose distribution this aspect ranks by. The target
   *  band is binned along (and seeded from) this axis. */
  readonly rankBy: AspectKey;
}

export type SmashControls = Record<AspectKey, AspectControl>;

/** A fresh uniform band of the given length (placeholder before histograms
 *  are extracted; the panel re-seeds bands from the real histograms). */
export function neutralBand(binCount = DEFAULT_BIN_COUNT): number[] {
  return new Array(binCount).fill(1);
}

/** A fresh aspect control: uniform bands, amount 0 (a strict no-op). */
export function neutralAspectControl(
  binCount = DEFAULT_BIN_COUNT,
  rankBy: AspectKey = "value",
): AspectControl {
  return {
    binCount,
    sourceBand: neutralBand(binCount),
    targetBand: neutralBand(binCount),
    amount: 0,
    softness: 0,
    rankBy,
  };
}

/** Fresh neutral controls for all four aspects (each ranks by its own axis). */
export function neutralSmashControls(binCount = DEFAULT_BIN_COUNT): SmashControls {
  return {
    value: neutralAspectControl(binCount, "value"),
    hue: neutralAspectControl(binCount, "hue"),
    saturation: neutralAspectControl(binCount, "saturation"),
    chroma: neutralAspectControl(binCount, "chroma"),
  };
}

/** Per-aspect bin counts — convenience for a uniform count across aspects. */
export function uniformBinCounts(n = DEFAULT_BIN_COUNT): Record<AspectKey, number> {
  return { value: n, hue: n, saturation: n, chroma: n };
}

/** Pick the smart rank axis for an aspect: its own axis, or Value when its
 *  own target channel has essentially no variation (grayscale colorization).
 *  This is what "Auto" resolves to. */
export function pickRankAxis(histograms: AspectHistogramSet, key: AspectKey): AspectKey {
  if (key === "value") return "value";
  return isDegenerate(histograms[key].target) ? "value" : key;
}

/**
 * Build controls whose bands are seeded from a set of extracted histograms.
 * Each aspect's rank axis is smart-picked (own axis, or Value when the
 * channel is flat); its source band is the natural source distribution and
 * its target band is seeded from the rank axis. amount 0, softness 0.
 */
export function initControls(histograms: AspectHistogramSet): SmashControls {
  const out = {} as SmashControls;
  for (const key of ASPECT_KEYS) {
    const h = histograms[key];
    const rankBy = pickRankAxis(histograms, key);
    out[key] = {
      binCount: h.source.length,
      sourceBand: Array.from(h.source),
      targetBand: resampleHist(histograms[rankBy].target, h.source.length),
      amount: 0,
      softness: 0,
      rankBy,
    };
  }
  return out;
}

/**
 * Set an aspect's Rank-by axis and re-seed its target band from that axis's
 * target histogram (resampled to the aspect's slice count). The target band
 * stays the aspect's OWN — every aspect ranks by its own editable band, so
 * editing one aspect's band never affects another's.
 */
export function setAspectRank(
  control: AspectControl,
  axis: AspectKey,
  histograms: AspectHistogramSet,
): AspectControl {
  return {
    ...control,
    rankBy: axis,
    targetBand: resampleHist(histograms[axis].target, control.binCount),
  };
}

/** Natural (extracted) distribution of one image pair along one aspect, plus
 *  a representative colour per bin — what the UI seeds its bands from and
 *  draws their swatches with. Array lengths equal the aspect's bin count. */
export interface AspectHistogram {
  readonly source: Float32Array;
  readonly target: Float32Array;
  readonly sourceColors: readonly RgbTriplet[];
  readonly targetColors: readonly RgbTriplet[];
}

export type AspectHistogramSet = Record<AspectKey, AspectHistogram>;

/** Per-aspect transfer data, built from controls. Internal. */
interface AspectTransfer {
  readonly targetCdf: Float32Array;
  readonly sourceCdf: Float32Array;
  readonly amount: number;
  readonly circular: boolean;
}

export interface SmashEngine {
  readonly histograms: AspectHistogramSet;
  readonly controls: SmashControls;
  readonly transfers: Record<AspectKey, AspectTransfer>;
  /** True iff every aspect amount is 0 — applySmash is then a strict no-op. */
  readonly inert: boolean;
}

/** Raw RGBA image, as the panel's layer snaps provide it. */
export interface ImageBuffer {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

// ────────── per-pixel axis math ──────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface PixelAxes {
  readonly xValue: number; // [0,1]
  readonly xHue: number; // [0,1)
  readonly xChroma: number; // [0,1]
  readonly xSat: number; // [0,1]
  readonly chroma: number; // raw Oklab chroma
}

function pixelAxes(r: number, g: number, b: number): PixelAxes {
  const [L0, a, bb] = srgbByteToOklab(r, g, b);
  const L = clamp01(L0);
  const C = Math.sqrt(a * a + bb * bb);
  const h = Math.atan2(bb, a);
  const S = C / Math.max(L, EPS);
  return {
    xValue: L,
    xHue: (((h / TWO_PI) % 1) + 1) % 1,
    xChroma: clamp01(C / CHROMA_MAX),
    xSat: clamp01(S / SAT_MAX),
    chroma: C,
  };
}

/** Weight of a pixel in the HUE histogram. A pixel's hue is meaningless when
 *  it's near-neutral (atan2 of ~0 a,b is pure noise) — so near-neutral pixels
 *  contribute ~0 to the hue distribution, and only genuinely-coloured pixels
 *  shape it. Without this, the noise hues of every grey pixel pollute the
 *  source's hue distribution with spurious colours across the wheel. */
function hueWeight(chroma: number): number {
  return clamp01((chroma - HUE_CHROMA_MIN) / HUE_CHROMA_RAMP);
}

/** Linear-resample an array of weights to `n` entries. Used when a band has
 *  to be re-seeded from a histogram extracted at a different slice count. */
export function resampleHist(src: ArrayLike<number>, n: number): number[] {
  const m = src.length;
  if (m === n) {
    const copy = new Array<number>(n);
    for (let i = 0; i < n; i++) copy[i] = Math.max(0, src[i] ?? 0);
    return copy;
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const pos = n > 1 ? (i / (n - 1)) * (m - 1) : 0;
    const lo = Math.floor(pos);
    const hi = Math.min(m - 1, lo + 1);
    const f = pos - lo;
    out[i] = Math.max(0, (src[lo] ?? 0) * (1 - f) + (src[hi] ?? 0) * f);
  }
  return out;
}

/** Synthetic colour for an empty histogram bin, so the UI band still reads. */
function fallbackColor(aspect: AspectKey, bin: number, binCount: number): RgbTriplet {
  const t = (bin + 0.5) / binCount;
  if (aspect === "value") return oklabToSrgbByte(t, 0, 0);
  if (aspect === "hue") {
    const [L, a, b] = oklchToOklab(0.7, 0.13, t * TWO_PI);
    return oklabToSrgbByte(L, a, b);
  }
  // chroma / saturation: a neutral→amber colourfulness ramp.
  const [L, a, b] = oklchToOklab(0.7, t * 0.14, (70 / 180) * Math.PI);
  return oklabToSrgbByte(L, a, b);
}

/** Synthetic representative colours for one axis at a given slice count —
 *  used to paint a cross-fed band whose colours come from another axis. */
export function aspectBinColors(axis: AspectKey, binCount: number): RgbTriplet[] {
  const out: RgbTriplet[] = [];
  for (let i = 0; i < binCount; i++) out.push(fallbackColor(axis, i, binCount));
  return out;
}

// ────────── histogram extraction (snap-dependent, expensive) ──────────

interface AspectAccum {
  count: Float64Array;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
}

function makeAccum(n: number): AspectAccum {
  return {
    count: new Float64Array(n),
    r: new Float64Array(n),
    g: new Float64Array(n),
    b: new Float64Array(n),
  };
}

function binOf(x: number, n: number): number {
  let i = Math.floor(clamp01(x) * n);
  if (i >= n) i = n - 1;
  if (i < 0) i = 0;
  return i;
}

function extractOne(
  img: ImageBuffer,
  stride: number,
  binCounts: Record<AspectKey, number>,
): Record<AspectKey, { hist: Float32Array; colors: RgbTriplet[] }> {
  const acc: Record<AspectKey, AspectAccum> = {
    value: makeAccum(binCounts.value),
    hue: makeAccum(binCounts.hue),
    saturation: makeAccum(binCounts.saturation),
    chroma: makeAccum(binCounts.chroma),
  };
  const { data, width, height } = img;
  const total = width * height;
  const step = Math.max(1, Math.floor(stride));

  const put = (
    a: AspectAccum, x: number, n: number,
    r: number, g: number, b: number, w: number,
  ): void => {
    const i = binOf(x, n);
    a.count[i] += w;
    a.r[i] += r * w;
    a.g[i] += g * w;
    a.b[i] += b * w;
  };

  for (let p = 0; p < total; p += step) {
    const o = p * 4;
    if (data[o + 3] < 128) continue; // skip transparent
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const ax = pixelAxes(r, g, b);
    // Value / Saturation / Chroma are meaningful for every pixel (weight 1);
    // Hue is meaningless for near-neutral pixels, so it's chroma-weighted.
    put(acc.value, ax.xValue, binCounts.value, r, g, b, 1);
    put(acc.hue, ax.xHue, binCounts.hue, r, g, b, hueWeight(ax.chroma));
    put(acc.saturation, ax.xSat, binCounts.saturation, r, g, b, 1);
    put(acc.chroma, ax.xChroma, binCounts.chroma, r, g, b, 1);
  }

  const out = {} as Record<AspectKey, { hist: Float32Array; colors: RgbTriplet[] }>;
  for (const key of ASPECT_KEYS) {
    const a = acc[key];
    const n = binCounts[key];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a.count[i];
    const hist = new Float32Array(n);
    const colors: RgbTriplet[] = [];
    for (let i = 0; i < n; i++) {
      hist[i] = sum > 0 ? a.count[i] / sum : 0;
      if (a.count[i] > 0) {
        colors.push([
          Math.round(a.r[i] / a.count[i]),
          Math.round(a.g[i] / a.count[i]),
          Math.round(a.b[i] / a.count[i]),
        ]);
      } else {
        colors.push(fallbackColor(key, i, n));
      }
    }
    out[key] = { hist, colors };
  }
  return out;
}

/**
 * Extract the four aspect histograms (+ per-bin colours) for a source/target
 * image pair, each at its own bin count. The expensive, snap-dependent step —
 * the caller memoizes this on the snaps + bin counts.
 */
export function extractAspectHistograms(
  source: ImageBuffer,
  target: ImageBuffer,
  binCounts: Record<AspectKey, number> = uniformBinCounts(),
  stride = 1,
): AspectHistogramSet {
  const s = extractOne(source, stride, binCounts);
  const t = extractOne(target, stride, binCounts);
  const set = {} as AspectHistogramSet;
  for (const key of ASPECT_KEYS) {
    set[key] = {
      source: s[key].hist,
      target: t[key].hist,
      sourceColors: s[key].colors,
      targetColors: t[key].colors,
    };
  }
  return set;
}

// ────────── band → CDF (control-dependent, cheap) ──────────

/** Coerce a user band to a clean Float32Array of `expectedLen` non-negative
 *  finite values. A non-conforming band falls back to `naturalFallback`. */
function sanitizeBand(
  band: readonly number[] | undefined,
  naturalFallback: Float32Array,
): Float32Array {
  const n = naturalFallback.length;
  if (!Array.isArray(band) || band.length !== n) {
    return naturalFallback;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = band[i];
    out[i] = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}

/** Smooth a histogram with `softness`-scaled 3-tap [0.25,0.5,0.25] blur
 *  passes, so the CDF's slice-to-slice transitions are gradual. Hue blurs
 *  circularly; the others clamp at the edges. softness 0 is a strict no-op. */
function smoothHist(hist: Float32Array, softness: number, circular: boolean): Float32Array {
  const n = hist.length;
  if (softness <= 0 || n < 3) return hist;
  const totalPasses = clamp01(softness) * MAX_SOFT_PASSES;
  const fullPasses = Math.floor(totalPasses);
  const frac = totalPasses - fullPasses;

  const onePass = (src: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = i === 0 ? (circular ? src[n - 1] : src[0]) : src[i - 1];
      const hi = i === n - 1 ? (circular ? src[0] : src[n - 1]) : src[i + 1];
      out[i] = 0.25 * lo + 0.5 * src[i] + 0.25 * hi;
    }
    return out;
  };

  let cur: Float32Array = new Float32Array(hist);
  for (let p = 0; p < fullPasses; p++) cur = onePass(cur);
  if (frac > 0) {
    const next = onePass(cur);
    const blended = new Float32Array(n);
    for (let i = 0; i < n; i++) blended[i] = cur[i] + (next[i] - cur[i]) * frac;
    cur = blended;
  }
  return cur;
}

/** Cumulative distribution at bin edges, length n+1, normalized to [0,1].
 *  A zero-mass histogram yields the identity CDF (uniform) so the transfer
 *  degrades to a no-op rather than collapsing. */
function buildCdf(hist: Float32Array): Float32Array {
  const n = hist.length;
  const cdf = new Float32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) total += hist[i];
  if (total < EPS) {
    for (let i = 0; i <= n; i++) cdf[i] = i / n;
    return cdf;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += hist[i];
    cdf[i + 1] = acc / total;
  }
  cdf[0] = 0;
  cdf[n] = 1;
  return cdf;
}

/** True when one bin holds DEGENERATE_FRACTION+ of the mass. */
function isDegenerate(hist: Float32Array): boolean {
  let total = 0;
  let max = 0;
  for (let i = 0; i < hist.length; i++) {
    total += hist[i];
    if (hist[i] > max) max = hist[i];
  }
  if (total < EPS) return true;
  return max / total > DEGENERATE_FRACTION;
}

/**
 * Build the runnable engine from extracted histograms + the current controls.
 * Cheap — call this per control edit; reuse the histograms across edits.
 */
export function buildSmashEngine(
  histograms: AspectHistogramSet,
  controls: SmashControls,
): SmashEngine {
  const transfers = {} as Record<AspectKey, AspectTransfer>;
  let inert = true;
  for (const key of ASPECT_KEYS) {
    const ctrl = controls[key];
    const amount = clamp01(ctrl?.amount ?? 0);
    if (amount > 0) inert = false;
    const h = histograms[key];
    const softness = clamp01(ctrl?.softness ?? 0);
    const circular = key === "hue";
    const effSource = smoothHist(sanitizeBand(ctrl?.sourceBand, h.source), softness, circular);
    const effTarget = smoothHist(sanitizeBand(ctrl?.targetBand, h.target), softness, circular);
    transfers[key] = {
      targetCdf: buildCdf(effTarget),
      sourceCdf: buildCdf(effSource),
      amount,
      circular,
    };
  }
  return { histograms, controls, transfers, inert };
}

// ────────── transfer + apply ──────────

/** Evaluate a CDF at axis position x∈[0,1] → rank∈[0,1]. */
function evalCdf(cdf: Float32Array, x: number): number {
  const n = cdf.length - 1;
  const pos = clamp01(x) * n;
  let i = Math.floor(pos);
  if (i >= n) i = n - 1;
  if (i < 0) i = 0;
  const frac = pos - i;
  return cdf[i] + (cdf[i + 1] - cdf[i]) * frac;
}

/** Invert a CDF: rank∈[0,1] → axis position x∈[0,1]. */
function invCdf(cdf: Float32Array, r: number): number {
  const n = cdf.length - 1;
  const rc = clamp01(r);
  let i = 0;
  while (i < n - 1 && cdf[i + 1] < rc) i++;
  const lo = cdf[i];
  const seg = cdf[i + 1] - lo;
  const frac = seg > EPS ? clamp01((rc - lo) / seg) : 0;
  return (i + frac) / n;
}

/** Rank-transfer x toward the source distribution, by `amount`. `rank` is the
 *  pre-resolved target rank (its own, or the value rank when degenerate). */
function transferWithRank(x: number, rank: number, t: AspectTransfer): number {
  if (t.amount <= 0) return x;
  const smashed = invCdf(t.sourceCdf, rank);
  if (t.circular) {
    let d = smashed - x;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    const out = x + d * t.amount;
    return ((out % 1) + 1) % 1;
  }
  return x + (smashed - x) * t.amount;
}

// ────────── sRGB gamut mapping ──────────

/** Oklab → linear sRGB (no clamp) — for testing gamut membership. */
function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const lp = L + 0.3963377774 * a + 0.2158037573 * b;
  const mp = L - 0.1055613458 * a - 0.0638541728 * b;
  const sp = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = lp * lp * lp;
  const m = mp * mp * mp;
  const s = sp * sp * sp;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function inSrgbGamut(L: number, a: number, b: number): boolean {
  const [r, g, bl] = oklabToLinearRgb(L, a, b);
  const lo = -0.0015;
  const hi = 1.0015;
  return r >= lo && r <= hi && g >= lo && g <= hi && bl >= lo && bl <= hi;
}

/**
 * Convert Oklab → sRGB bytes, gamut-mapping by chroma reduction. When the
 * colour is outside sRGB, its chroma is scaled down (lightness AND hue held
 * fixed) until it fits — a graceful desaturation. The naive alternative,
 * clamping each RGB channel independently, shifts an out-of-gamut colour into
 * a garish WRONG hue (the purple/cyan speckles in over-saturated highlights).
 */
function oklabToSrgbGamutMapped(L: number, a: number, b: number): RgbTriplet {
  if (inSrgbGamut(L, a, b)) return oklabToSrgbByte(L, a, b);
  // Binary-search the largest chroma scale that stays in gamut.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(L, a * mid, b * mid)) lo = mid;
    else hi = mid;
  }
  return oklabToSrgbByte(L, a * lo, b * lo);
}

/**
 * Apply the per-aspect transform to one sRGB byte triplet. Pure function of
 * (r,g,b) — bakeable to a 3D LUT. A fully-neutral engine returns the input
 * untouched.
 */
export function applySmash(engine: SmashEngine, r: number, g: number, b: number): RgbTriplet {
  if (engine.inert) return [r, g, b];
  const ax = pixelAxes(r, g, b);
  const tr = engine.transfers;

  // Each aspect ranks by its OWN target band, read at the position of its
  // (concrete) rank axis — its own, or the cross-feed axis the band was
  // re-seeded along. Rank-by is always a concrete axis here; "Auto" is
  // resolved to one upstream.
  const axisX: Record<AspectKey, number> = {
    value: ax.xValue, hue: ax.xHue, saturation: ax.xSat, chroma: ax.xChroma,
  };
  const resolveRank = (aspect: AspectKey): number =>
    evalCdf(tr[aspect].targetCdf, axisX[engine.controls[aspect].rankBy]);

  const Lp = clamp01(transferWithRank(ax.xValue, resolveRank("value"), tr.value));
  const hp = transferWithRank(ax.xHue, resolveRank("hue"), tr.hue) * TWO_PI;
  let Cp = clamp01(transferWithRank(ax.xChroma, resolveRank("chroma"), tr.chroma)) * CHROMA_MAX;

  // Saturation aspect. Operates on S = C/L of the POST-CHROMA colour: it
  // lerps the current saturation toward the source's (a bounded move) and
  // rebuilds chroma as C = S·L. No division by the pixel's own ~0 chroma.
  if (tr.saturation.amount > 0) {
    const xSatCur = clamp01(Cp / Math.max(Lp, EPS) / SAT_MAX);
    const sNew = clamp01(transferWithRank(xSatCur, resolveRank("saturation"), tr.saturation)) * SAT_MAX;
    Cp = sNew * Lp;
  }

  const a = Cp * Math.cos(hp);
  const bb = Cp * Math.sin(hp);
  return oklabToSrgbGamutMapped(Lp, a, bb);
}

// ────────── LUT bake ──────────

export interface EngineLut {
  readonly size: number;
  /** size³ × 3 floats in [0,1], r-fastest then g then b (.cube order). */
  readonly values: Float32Array;
}

/**
 * Bake the engine to an N³ LUT by sampling applySmash at every grid point.
 * r-fastest layout — matches the existing cube serializer / ICC builder.
 */
export function bakeEngineLut(engine: SmashEngine, size: number): EngineLut {
  const values = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = applySmash(
          engine,
          Math.round((ri / (size - 1)) * 255),
          Math.round((gi / (size - 1)) * 255),
          Math.round((bi / (size - 1)) * 255),
        );
        values[o++] = clamp01(r / 255);
        values[o++] = clamp01(g / 255);
        values[o++] = clamp01(b / 255);
      }
    }
  }
  return { size, values };
}
