// Per-channel histogram specification: builds a 0..255 → 0..255 remap per RGB channel that
// makes target's per-channel histogram match source's. Captures range, contrast, value, and
// color cast in a single Curves-shaped function (no cross-channel coupling).

// Sentinel layer-id used by the source/target dropdowns to mean "the document composite"
// instead of any specific layer. PS layer IDs are positive, so -2 is safe.
export const MERGED_LAYER_ID = -2;

export interface ChannelCurves {
  r: Uint8Array; // length 256, input → output
  g: Uint8Array;
  b: Uint8Array;
}

function buildHistogram(rgba: Uint8Array, channelOffset: 0 | 1 | 2): Float64Array {
  const h = new Float64Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue; // skip masked-out / transparent pixels
    h[rgba[i + channelOffset]]++;
  }
  return h;
}

function cumulative(h: Float64Array): Float64Array {
  const c = new Float64Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; c[i] = acc; }
  if (acc > 0) for (let i = 0; i < 256; i++) c[i] /= acc;
  return c;
}

// For each input v, find smallest u such that srcCDF[u] >= tgtCDF[v]. Classic specification.
function specifyChannel(srcCDF: Float64Array, tgtCDF: Float64Array): Uint8Array {
  const out = new Uint8Array(256);
  let u = 0;
  for (let v = 0; v < 256; v++) {
    const target = tgtCDF[v];
    while (u < 255 && srcCDF[u] < target) u++;
    out[v] = u;
  }
  return out;
}

export function fitHistogramCurves(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogram(srcRgba, off);
    const tH = buildHistogram(tgtRgba, off);
    out[name] = specifyChannel(cumulative(sH), cumulative(tH));
  }
  return out as ChannelCurves;
}

// ─── Lighter-touch match modes ───────────────────────────────────────────
// Alternatives to full-histogram matching for users who want subtler color
// transfer. All three return ChannelCurves so they slot into the same
// processing pipeline (smoothing, stretch, dimensions, zones, envelope).

// Mean-shift: match per-channel arithmetic mean. Curves are linear shifts —
// gentle "mood transfer" that nudges the color cast without restructuring tones.
export function fitMatchMeanShift(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    let sSum = 0, sN = 0, tSum = 0, tN = 0;
    for (let i = 0; i < srcRgba.length; i += 4) { if (srcRgba[i + 3] < 128) continue; sSum += srcRgba[i + off]; sN++; }
    for (let i = 0; i < tgtRgba.length; i += 4) { if (tgtRgba[i + 3] < 128) continue; tSum += tgtRgba[i + off]; tN++; }
    const shift = (sN > 0 && tN > 0) ? (sSum / sN - tSum / tN) : 0;
    const arr = new Uint8Array(256);
    for (let v = 0; v < 256; v++) arr[v] = Math.max(0, Math.min(255, Math.round(v + shift)));
    out[name] = arr;
  }
  return out as ChannelCurves;
}

// Median-shift: match per-channel median (50th percentile). Robust to outliers
// (a few extreme pixels won't skew the shift). Otherwise identical in effect to mean-shift.
export function fitMatchMedianShift(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogram(srcRgba, off);
    const tH = buildHistogram(tgtRgba, off);
    const sMed = histogramPercentile(sH, 0.5);
    const tMed = histogramPercentile(tH, 0.5);
    const shift = sMed - tMed;
    const arr = new Uint8Array(256);
    for (let v = 0; v < 256; v++) arr[v] = Math.max(0, Math.min(255, Math.round(v + shift)));
    out[name] = arr;
  }
  return out as ChannelCurves;
}

// Percentile match: anchor a few percentile points (10/25/50/75/90) and linearly
// interpolate between. Captures more of the distribution shape than mean/median
// alone but less aggressive than full-histogram matching. Sweet spot for "a bit
// more than mood transfer, less than full distribution match."
export function fitMatchPercentiles(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  const ps = [0.05, 0.25, 0.5, 0.75, 0.95];
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogram(srcRgba, off);
    const tH = buildHistogram(tgtRgba, off);
    const sV = ps.map(p => histogramPercentile(sH, p));
    const tV = ps.map(p => histogramPercentile(tH, p));
    // Build piecewise-linear curve: target percentile values map to source values.
    // Anchored at 0→0 and 255→255 so endpoints are stable.
    const anchorsX = [0, ...tV, 255];
    const anchorsY = [0, ...sV, 255];
    const arr = new Uint8Array(256);
    let i = 0;
    for (let v = 0; v < 256; v++) {
      while (i < anchorsX.length - 2 && v > anchorsX[i + 1]) i++;
      const xa = anchorsX[i], xb = anchorsX[i + 1];
      const ya = anchorsY[i], yb = anchorsY[i + 1];
      const span = (xb - xa) || 1;
      const t = (v - xa) / span;
      arr[v] = Math.max(0, Math.min(255, Math.round(ya + (yb - ya) * t)));
    }
    out[name] = arr;
  }
  return out as ChannelCurves;
}

// Helper: percentile lookup against a histogram bin count array.
function histogramPercentile(h: Float64Array, p: number): number {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[i];
  if (total <= 0) return 128;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    if (acc >= target) return i;
  }
  return 255;
}

export type MatchMode = "full" | "mean" | "median" | "percentile";

// ─── Multi-zone (multi-curves) output ───────────────────────────────────
// Instead of one global Curves layer, fit three separate curves — shadows, mids,
// highlights — each computed using only the target/source pixels in that luminance
// band. The on-PS output emits three Curves adjustment layers in the [Color Smash]
// group, each with Blend If sliders limiting it to its band so they composite into
// a single visually-coherent result. Major distinguishing feature vs other plugins.
//
// Band weights are triangular over [0, 128, 255] forming a partition of unity at
// every input luma — they sum to 1.0, so the composite output equals a weighted
// average of the three curves' outputs. Linear (not gaussian) so they exactly match
// PS Blend If's split-slider math, ensuring preview = applied output.

export interface MultiZoneFit {
  shadow: ChannelCurves;
  mid: ChannelCurves;
  highlight: ChannelCurves;
}

// Triangular partition-of-unity weights at a given luma, parameterized by three peak
// positions and outer extents. With `extents` matching the histogram bounds (e.g. lumaMin/
// lumaMax from lumaRange), pixels outside that range get zero band weight everywhere — they
// pass through unchanged in the composite, so the multi-zone curves only act on actual
// image data. Without `extents` (or fixed 0/255), bands cover the full luma range.
export function multiZoneWeights(
  luma: number,
  peaks: { shadow: number; mid: number; highlight: number } = { shadow: 0, mid: 128, highlight: 255 },
  extents: { min: number; max: number } = { min: 0, max: 255 },
): { shadow: number; mid: number; highlight: number } {
  const sP = Math.max(0, Math.min(253, peaks.shadow));
  const mP = Math.max(sP + 1, Math.min(254, peaks.mid));
  const hP = Math.max(mP + 1, Math.min(255, peaks.highlight));
  const eMin = Math.max(0, Math.min(sP, extents.min));
  const eMax = Math.max(hP, Math.min(255, extents.max));

  // Outside extents → all weights zero, no band application.
  if (luma < eMin || luma > eMax) return { shadow: 0, mid: 0, highlight: 0 };

  let shadow = 0, mid = 0, highlight = 0;
  // Shadow: ramp up from 0 at eMin to 1 at sP, then ramp down to 0 at mP.
  if (luma <= sP) shadow = sP === eMin ? 1 : (luma - eMin) / (sP - eMin);
  else if (luma <= mP) shadow = (mP - luma) / (mP - sP);

  if (luma <= sP) mid = 0;
  else if (luma <= mP) mid = (luma - sP) / (mP - sP);
  else if (luma <= hP) mid = (hP - luma) / (hP - mP);

  // Highlight: ramp up 0 at mP → 1 at hP, then ramp down 1 at hP → 0 at eMax.
  if (luma <= mP) highlight = 0;
  else if (luma <= hP) highlight = (luma - mP) / (hP - mP);
  else highlight = eMax === hP ? 1 : (eMax - luma) / (eMax - hP);

  // Don't normalize — sum can be < 1 inside extents near the edges (where shadow ramps up
  // from eMin and highlight ramps down toward eMax). The (1 - sum) portion passes through
  // unchanged in the composite, matching what Blend If does in PS.
  return { shadow: Math.max(0, shadow), mid: Math.max(0, mid), highlight: Math.max(0, highlight) };
}

// Compute histogram-adaptive band peaks for a target's luma distribution. Returns the
// percentile values [P10, P50, P90] so each band gets ~20% of pixel mass at its peak +
// equal sample size for fitting. Falls back to fixed 0/128/255 if the histogram is flat
// or percentiles collapse (e.g. P10 == P90 for a single-color image).
export function adaptiveBandPeaks(bins: LumaBins): { shadow: number; mid: number; highlight: number } {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins.count[i];
  if (total <= 0) return { shadow: 0, mid: 128, highlight: 255 };
  const percentile = (p: number) => {
    const target = total * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += bins.count[i];
      if (acc >= target) return i;
    }
    return 255;
  };
  const p10 = percentile(0.10);
  const p50 = percentile(0.50);
  const p90 = percentile(0.90);
  // Guard against degenerate cases (flat image, very tight histogram).
  if (p90 - p10 < 20) return { shadow: 0, mid: 128, highlight: 255 };
  return { shadow: p10, mid: p50, highlight: p90 };
}

// Build a per-channel histogram weighted by a luma-dependent function. Pixels
// contribute to the histogram in proportion to their band weight — so e.g. the
// shadow band's histogram is dominated by genuinely shadow pixels.
function buildHistogramByLuma(rgba: Uint8Array, channelOffset: 0 | 1 | 2, weightFn: (luma: number) => number): Float64Array {
  const h = new Float64Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const w = weightFn(luma);
    if (w <= 0) continue;
    h[rgba[i + channelOffset]] += w;
  }
  return h;
}

function fitOneBand(srcRgba: Uint8Array, tgtRgba: Uint8Array, weightFn: (l: number) => number): ChannelCurves {
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogramByLuma(srcRgba, off, weightFn);
    const tH = buildHistogramByLuma(tgtRgba, off, weightFn);
    out[name] = specifyChannel(cumulative(sH), cumulative(tH));
  }
  return out as ChannelCurves;
}

// Fit all three zone curves with peaks + extents. Pixels outside extents contribute zero
// to each band's histogram, so the curves are fit only on data within the histogram range.
export function fitMultiZone(
  srcRgba: Uint8Array, tgtRgba: Uint8Array,
  peaks: { shadow: number; mid: number; highlight: number } = { shadow: 0, mid: 128, highlight: 255 },
  extents: { min: number; max: number } = { min: 0, max: 255 },
): MultiZoneFit {
  return fitMultiZoneByMode("full", srcRgba, tgtRgba, peaks, extents);
}

// Mode-aware multi-zone fit. For each band, builds a luma-weighted histogram and applies
// the same shift/spec strategy as the single-curve `fitByMode` — so the matchMode dropdown
// (full / mean / median / percentile) actually affects the multi-zone Apply output too.
export function fitMultiZoneByMode(
  mode: MatchMode,
  srcRgba: Uint8Array, tgtRgba: Uint8Array,
  peaks: { shadow: number; mid: number; highlight: number } = { shadow: 0, mid: 128, highlight: 255 },
  extents: { min: number; max: number } = { min: 0, max: 255 },
): MultiZoneFit {
  const wAt = (l: number) => multiZoneWeights(l, peaks, extents);
  return {
    shadow:    fitOneBandByMode(mode, srcRgba, tgtRgba, l => wAt(l).shadow),
    mid:       fitOneBandByMode(mode, srcRgba, tgtRgba, l => wAt(l).mid),
    highlight: fitOneBandByMode(mode, srcRgba, tgtRgba, l => wAt(l).highlight),
  };
}

// Per-band, per-mode fitter. Builds weighted histograms for src+tgt limited to the band,
// then derives a Curves array per channel using the requested matchMode strategy.
function fitOneBandByMode(
  mode: MatchMode,
  srcRgba: Uint8Array, tgtRgba: Uint8Array,
  weightFn: (l: number) => number,
): ChannelCurves {
  if (mode === "full") return fitOneBand(srcRgba, tgtRgba, weightFn);
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogramByLuma(srcRgba, off, weightFn);
    const tH = buildHistogramByLuma(tgtRgba, off, weightFn);
    let arr: Uint8Array;
    if (mode === "mean") {
      const shift = histMean(sH) - histMean(tH);
      arr = new Uint8Array(256);
      for (let v = 0; v < 256; v++) arr[v] = Math.max(0, Math.min(255, Math.round(v + shift)));
    } else if (mode === "median") {
      const shift = histogramPercentile(sH, 0.5) - histogramPercentile(tH, 0.5);
      arr = new Uint8Array(256);
      for (let v = 0; v < 256; v++) arr[v] = Math.max(0, Math.min(255, Math.round(v + shift)));
    } else {
      // percentile: anchored piecewise-linear over [0.05, 0.25, 0.5, 0.75, 0.95].
      const ps = [0.05, 0.25, 0.5, 0.75, 0.95];
      const sV = ps.map(p => histogramPercentile(sH, p));
      const tV = ps.map(p => histogramPercentile(tH, p));
      const anchorsX = [0, ...tV, 255];
      const anchorsY = [0, ...sV, 255];
      arr = new Uint8Array(256);
      let i = 0;
      for (let v = 0; v < 256; v++) {
        while (i < anchorsX.length - 2 && v > anchorsX[i + 1]) i++;
        const xa = anchorsX[i], xb = anchorsX[i + 1];
        const ya = anchorsY[i], yb = anchorsY[i + 1];
        const span = (xb - xa) || 1;
        const t = (v - xa) / span;
        arr[v] = Math.max(0, Math.min(255, Math.round(ya + (yb - ya) * t)));
      }
    }
    out[name] = arr;
  }
  return out as ChannelCurves;
}

// Weighted-histogram mean. Returns 128 for empty histograms (graceful identity).
function histMean(h: Float64Array): number {
  let sum = 0, total = 0;
  for (let i = 0; i < 256; i++) { sum += i * h[i]; total += h[i]; }
  return total > 0 ? sum / total : 128;
}

// Simulate the multi-zone composite for the preview. Uses the same parameterized weights
// as fitMultiZone so preview = applied output. Non-normalized weights mean the remainder
// (1 - sum) passes through as identity — matches what Blend If / masks do in PS.
export function applyMultiZoneToRgba(
  tgtRgba: Uint8Array, fit: MultiZoneFit,
  peaks: { shadow: number; mid: number; highlight: number } = { shadow: 0, mid: 128, highlight: 255 },
  extents: { min: number; max: number } = { min: 0, max: 255 },
): Uint8Array {
  const out = new Uint8Array(tgtRgba.length);
  for (let i = 0; i < tgtRgba.length; i += 4) {
    const r = tgtRgba[i], g = tgtRgba[i + 1], b = tgtRgba[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const w = multiZoneWeights(luma, peaks, extents);
    const passthrough = Math.max(0, 1 - (w.shadow + w.mid + w.highlight));
    out[i]     = Math.max(0, Math.min(255, Math.round(w.shadow * fit.shadow.r[r] + w.mid * fit.mid.r[r] + w.highlight * fit.highlight.r[r] + passthrough * r)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(w.shadow * fit.shadow.g[g] + w.mid * fit.mid.g[g] + w.highlight * fit.highlight.g[g] + passthrough * g)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(w.shadow * fit.shadow.b[b] + w.mid * fit.mid.b[b] + w.highlight * fit.highlight.b[b] + passthrough * b)));
    out[i + 3] = tgtRgba[i + 3];
  }
  return out;
}

// Apply the same downstream pipeline (Color/Tone processing) to each of the three
// band curves in a MultiZoneFit. Zones and Envelope are skipped because they are
// themselves zone-based modulations and would double-apply over the multi-zone bands.
export function processMultiZoneFit(
  fit: MultiZoneFit,
  curveOpts: CurveProcessOpts,
  dimOpts: DimensionOpts,
): MultiZoneFit {
  const proc = (c: ChannelCurves): ChannelCurves => {
    const p = processChannelCurves(c, curveOpts);
    return applyDimensions(p, dimOpts);
  };
  return { shadow: proc(fit.shadow), mid: proc(fit.mid), highlight: proc(fit.highlight) };
}

// Dispatcher — picks the right fit function based on mode. Used by MatchTab so the
// UI can switch modes without the call site needing to know the algorithms.
export function fitByMode(mode: MatchMode, srcRgba: Uint8Array, tgtRgba: Uint8Array, colorSpace: "rgb" | "lab" = "rgb"): ChannelCurves {
  if (mode === "mean") return fitMatchMeanShift(srcRgba, tgtRgba);
  if (mode === "median") return fitMatchMedianShift(srcRgba, tgtRgba);
  if (mode === "percentile") return fitMatchPercentiles(srcRgba, tgtRgba);
  return colorSpace === "lab" ? fitHistogramCurvesLab(srcRgba, tgtRgba) : fitHistogramCurves(srcRgba, tgtRgba);
}

// ─── Lab-domain histogram match ────────────────────────────────────────
// Matches in perceptual L*a*b* (more natural than RGB for cross-cast cases),
// then samples per-channel R/G/B curves that approximate the resulting
// RGB→RGB transform via a 17×17×17 grid average.

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  const xn = X / 0.95047, yn = Y, zn = Z / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  return [116 * f(yn) - 16, 500 * (f(xn) - f(yn)), 200 * (f(yn) - f(zn))];
}
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const finv = (t: number) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = finv(fx) * 0.95047, Y = finv(fy), Z = finv(fz) * 1.08883;
  const R = X *  3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const G = X * -0.9692660 + Y *  1.8760108 + Z *  0.0415560;
  const B = X *  0.0556434 + Y * -0.2040259 + Z *  1.0572252;
  return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
}

// Lab channel ranges baked into 0..255 bins:
// L: 0..100 (clamped) → 0..255
// a, b: -128..127 → 0..255 (centered)
function buildLabHist(rgba: Uint8Array, channel: 0 | 1 | 2): Float64Array {
  const h = new Float64Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const [L, a, b] = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
    let bin = 0;
    if (channel === 0) bin = Math.max(0, Math.min(255, Math.round(L * 2.55)));
    else if (channel === 1) bin = Math.max(0, Math.min(255, Math.round(a + 128)));
    else bin = Math.max(0, Math.min(255, Math.round(b + 128)));
    h[bin]++;
  }
  return h;
}

export function fitHistogramCurvesLab(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  // Per-Lab-channel spec curves (0..255 indexed in their respective domain).
  const labMaps: Uint8Array[] = [];
  for (const ch of [0, 1, 2] as const) {
    labMaps.push(specifyChannel(cumulative(buildLabHist(srcRgba, ch)), cumulative(buildLabHist(tgtRgba, ch))));
  }
  // Sample curves from ACTUAL target pixels. For each tgt pixel, run through Lab→spec→Lab'→RGB',
  // bucket the (input, output) pair by input channel value, then average per bucket. This tailors
  // the per-channel curves to the colors that actually appear in the target — avoids the wild
  // distortions a synthetic 17³ grid produces because curves can't express cross-channel changes.
  const sumR = new Float64Array(256), sumG = new Float64Array(256), sumB = new Float64Array(256);
  const cntR = new Float64Array(256), cntG = new Float64Array(256), cntB = new Float64Array(256);
  for (let i = 0; i < tgtRgba.length; i += 4) {
    if (tgtRgba[i + 3] < 128) continue;
    const r = tgtRgba[i], g = tgtRgba[i + 1], b = tgtRgba[i + 2];
    const [L, A, B] = rgbToLab(r, g, b);
    const Lbin = Math.max(0, Math.min(255, Math.round(L * 2.55)));
    const Abin = Math.max(0, Math.min(255, Math.round(A + 128)));
    const Bbin = Math.max(0, Math.min(255, Math.round(B + 128)));
    const Lmapped = labMaps[0][Lbin] / 2.55;
    const Amapped = labMaps[1][Abin] - 128;
    const Bmapped = labMaps[2][Bbin] - 128;
    const [or, og, ob] = labToRgb(Lmapped, Amapped, Bmapped);
    sumR[r] += or; cntR[r]++;
    sumG[g] += og; cntG[g]++;
    sumB[b] += ob; cntB[b]++;
  }
  const finish = (sum: Float64Array, cnt: Float64Array): Uint8Array => {
    const out = new Uint8Array(256);
    // Pass 1: fill where we have data; for empty bins, hold last known value.
    let lastVal = 0; let haveAny = false;
    for (let v = 0; v < 256; v++) {
      if (cnt[v] > 0) { lastVal = sum[v] / cnt[v]; haveAny = true; }
      out[v] = haveAny ? Math.max(0, Math.min(255, Math.round(lastVal))) : v; // identity if no data at all
    }
    // Pass 2: linearly interpolate forward over runs of unfilled bins from the front.
    // (back-fill) Find first known and use it as the floor for earlier bins.
    let firstFilled = -1;
    for (let v = 0; v < 256; v++) if (cnt[v] > 0) { firstFilled = v; break; }
    if (firstFilled > 0) {
      const start = out[firstFilled];
      // Fill 0..firstFilled-1 by interpolating from 0 to start.
      for (let v = 0; v < firstFilled; v++) out[v] = Math.round((v / firstFilled) * start);
    }
    // Force monotonic.
    let m = out[0];
    for (let v = 0; v < 256; v++) { if (out[v] > m) m = out[v]; out[v] = m; }
    return out;
  };
  return { r: finish(sumR, cntR), g: finish(sumG, cntG), b: finish(sumB, cntB) };
}

// Lerp the fitted curve with identity by `amount` (0..1).
export function blendWithIdentity(curve: Uint8Array, amount: number): Uint8Array {
  const out = new Uint8Array(256);
  const a = Math.max(0, Math.min(1, amount));
  for (let v = 0; v < 256; v++) out[v] = Math.round(v + (curve[v] - v) * a);
  return out;
}

// Box-blur a 256-entry curve. Radius 0 = no-op. Reflects at edges to avoid endpoint pull-in.
export function smoothCurve(curve: Uint8Array, radius: number): Uint8Array {
  if (radius < 1) return curve;
  const r = Math.min(64, Math.floor(radius));
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let acc = 0, n = 0;
    for (let k = -r; k <= r; k++) {
      let i = v + k;
      if (i < 0) i = -i; else if (i > 255) i = 510 - i;
      acc += curve[i]; n++;
    }
    out[v] = Math.round(acc / n);
  }
  return out;
}

// Force non-decreasing (running max). Prevents inversions after smoothing.
export function enforceMonotonic(curve: Uint8Array): Uint8Array {
  const out = new Uint8Array(256);
  let m = curve[0];
  for (let v = 0; v < 256; v++) { if (curve[v] > m) m = curve[v]; out[v] = m; }
  return out;
}

// Soft slope cap via tanh saturation. Walks both directions and anchors at endpoints
// (default) or the histogram-data range (when `range` is provided).
//
// Why soft instead of hard: a hard cap (`if slope > cap, clamp`) makes the Stretch slider
// feel jumpy because each integer slider value either engages or doesn't engage at every
// input position. Soft saturation via `cap * tanh(slope / cap)` produces a continuous
// modulation: slopes well below cap pass through nearly unchanged (tanh ≈ identity for
// small inputs), at-the-cap slopes settle to ~76% of cap, and large slopes asymptote to
// cap without ever exceeding it. Net result: every slider increment continuously affects
// every input — no popping, no on/off transitions.
//
// Range parameter: when provided, the cap walks from the target's actual luma bounds
// rather than 0/255. Keeps the cap's influence consistent across bright vs dark sources.
export function capStretch(curve: Uint8Array, maxRatio: number, range?: { start: number; end: number }): Uint8Array {
  if (maxRatio <= 0) return curve;
  const out = new Uint8Array(curve);
  const start = Math.max(0, Math.min(254, range?.start ?? 0));
  const end = Math.max(start + 1, Math.min(255, range?.end ?? 255));
  // Forward pass anchored at `start` — soft-cap rises and drops symmetrically (tanh is odd).
  for (let v = start + 1; v <= end; v++) {
    const delta = out[v] - out[v - 1];
    const softDelta = maxRatio * Math.tanh(delta / maxRatio);
    out[v] = Math.max(0, Math.min(255, Math.round(out[v - 1] + softDelta)));
  }
  // Reverse pass anchored at `end` — handles compressive extremes the forward pass missed.
  for (let v = end - 1; v >= start; v--) {
    const delta = out[v] - out[v + 1];
    const softDelta = maxRatio * Math.tanh(delta / maxRatio);
    out[v] = Math.max(0, Math.min(255, Math.round(out[v + 1] + softDelta)));
  }
  return out;
}

export interface CurveProcessOpts {
  amount: number;       // 0..1
  smoothRadius: number; // 0..64
  maxStretch: number;   // local slope cap; 1 = identity-only, large = no cap
  stretchRange?: { start: number; end: number }; // anchor stretch at histogram bounds
}

// Full pipeline: stretch-cap → blend with identity by amount → smooth → enforce monotonic.
export function processCurve(raw: Uint8Array, opts: CurveProcessOpts): Uint8Array {
  let c = raw;
  if (opts.maxStretch > 0 && opts.maxStretch < 100) c = capStretch(c, opts.maxStretch, opts.stretchRange);
  c = blendWithIdentity(c, opts.amount);
  if (opts.smoothRadius > 0) c = smoothCurve(c, opts.smoothRadius);
  c = enforceMonotonic(c);
  return c;
}

export function processChannelCurves(raw: ChannelCurves, opts: CurveProcessOpts): ChannelCurves {
  return {
    r: processCurve(raw.r, opts),
    g: processCurve(raw.g, opts),
    b: processCurve(raw.b, opts),
  };
}

// ─── Post-fit dimension warps ─────────────────────────────────────────────
// Manipulate the fitted curves along perceptual axes without adding layers.
// All values expressed as percentages (100 = neutral / no change).

export interface DimensionOpts {
  value: number;       // 0..200, scales the luma delta part of each curve
  chroma: number;      // 0..200, scales the chroma delta (orthogonal to luma)
  hueShift: number;    // -180..180 degrees, rotates chroma vector around (1,1,1)
  contrast: number;    // 0..200, S-curve steepness applied after
  neutralize: number;  // 0..100, pins endpoints toward identity (quadratic rolloff from mid)
  separation: number;  // 0..200, stretches output values away from midpoint
}

export const DEFAULT_DIMENSIONS: DimensionOpts = {
  value: 100, chroma: 100, hueShift: 0, contrast: 100, neutralize: 0, separation: 100,
};

function clamp255(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// Gamma-based S-curve around 0.5. k=1 identity. k>1 steeper (more contrast). k<1 flatter.
function scurve(x01: number, k: number): number {
  const t = (x01 - 0.5) * 2;
  const sign = t < 0 ? -1 : 1;
  const mag = Math.abs(t);
  return 0.5 + sign * Math.pow(mag, 1 / k) * 0.5;
}

export function applyDimensions(curves: ChannelCurves, opts: DimensionOpts): ChannelCurves {
  const vAmt = opts.value / 100;
  const cAmt = opts.chroma / 100;
  const kAmt = opts.contrast / 100;
  const nAmt = Math.max(0, Math.min(1, opts.neutralize / 100));
  const sAmt = opts.separation / 100;
  const hAng = opts.hueShift * Math.PI / 180;
  const cosH = Math.cos(hAng), sinH = Math.sin(hAng);
  const k = 1 / Math.sqrt(3);

  const out: ChannelCurves = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };

  for (let v = 0; v < 256; v++) {
    let r = curves.r[v], g = curves.g[v], b = curves.b[v];
    const luma = (r + g + b) / 3;
    let dr = r - luma, dg = g - luma, db = b - luma;

    // Chroma scale.
    dr *= cAmt; dg *= cAmt; db *= cAmt;

    // Hue rotation around (1,1,1) axis (Rodrigues).
    if (hAng !== 0) {
      const dot = (dr + dg + db) * k * k;  // k·v projected onto axis, then axis·dot
      const cr = k * (dg - db), cg = k * (db - dr), cb = k * (dr - dg); // axis × v
      const nr = dr * cosH + cr * sinH + (dot) * (1 - cosH);
      const ng = dg * cosH + cg * sinH + (dot) * (1 - cosH);
      const nb = db * cosH + cb * sinH + (dot) * (1 - cosH);
      dr = nr; dg = ng; db = nb;
    }

    // Value scale on luma delta from input v.
    const newLuma = v + (luma - v) * vAmt;
    r = newLuma + dr; g = newLuma + dg; b = newLuma + db;

    // Neutralize endpoints (quadratic rolloff — stronger at v=0 and v=255, none at v=127).
    if (nAmt > 0) {
      const d = (v - 127.5) / 127.5;
      const pull = nAmt * d * d;
      r = r + (v - r) * pull;
      g = g + (v - g) * pull;
      b = b + (v - b) * pull;
    }

    // Tonal separation: stretch outputs away from midpoint.
    if (sAmt !== 1) {
      r = 127.5 + (r - 127.5) * sAmt;
      g = 127.5 + (g - 127.5) * sAmt;
      b = 127.5 + (b - 127.5) * sAmt;
    }

    // Contrast (S-curve).
    if (kAmt !== 1 && kAmt > 0) {
      r = scurve(Math.max(0, Math.min(255, r)) / 255, kAmt) * 255;
      g = scurve(Math.max(0, Math.min(255, g)) / 255, kAmt) * 255;
      b = scurve(Math.max(0, Math.min(255, b)) / 255, kAmt) * 255;
    }

    out.r[v] = clamp255(r);
    out.g[v] = clamp255(g);
    out.b[v] = clamp255(b);
  }

  // Keep curves monotonic after all the warping.
  out.r = enforceMonotonic(out.r);
  out.g = enforceMonotonic(out.g);
  out.b = enforceMonotonic(out.b);
  return out;
}

// ─── Zone-targeted weighting (Color Range fuzziness analog) ───────────────
// Modulates the matched-vs-identity blend by input value: shadows/mids/highlights
// each get an amount, with a single falloff controlling how much they overlap.

export interface ZoneOpts {
  shadows: number;            // 0..200, % strength
  shadowsAnchor: number;      // 0..255, where the shadow zone is centered
  shadowsFalloff: number;     // 0..100, how broad (sigma)
  shadowsBias: number;        // -100..100, competitive pressure (eats into neighbors at overlap)
  mids: number;
  midsAnchor: number;
  midsFalloff: number;
  midsBias: number;
  highlights: number;
  highlightsAnchor: number;
  highlightsFalloff: number;
  highlightsBias: number;
}

export const DEFAULT_ZONES: ZoneOpts = {
  shadows: 100,    shadowsAnchor: 42,    shadowsFalloff: 50,    shadowsBias: 0,
  mids: 100,       midsAnchor: 127,      midsFalloff: 50,       midsBias: 0,
  highlights: 100, highlightsAnchor: 212, highlightsFalloff: 50, highlightsBias: 0,
};

// Per-input weight in [0,1]: how strongly the matched curve replaces the identity at that input.
// When all three amounts = 100 and biases = 0, weight ≡ 1 by partition-of-unity normalization →
// identity behavior. Per-zone bias acts like softmax pressure: bumping a zone's bias makes it
// claim a larger share of the partition wherever it has any presence, eating into neighbors at
// the overlap regions (Color-Range-style "grow this range" behavior).
export function buildZoneWeights(opts: ZoneOpts): Float64Array {
  const w = new Float64Array(256);
  const sig = (f: number) => { const s = 18 + (f / 100) * 60; return 1 / (2 * s * s); };
  const sInv = sig(opts.shadowsFalloff), mInv = sig(opts.midsFalloff), hInv = sig(opts.highlightsFalloff);
  const sCtr = opts.shadowsAnchor, mCtr = opts.midsAnchor, hCtr = opts.highlightsAnchor;
  const s = opts.shadows / 100, m = opts.mids / 100, h = opts.highlights / 100;
  // bias/50 → exp gain in [exp(-2)≈0.135, exp(2)≈7.39] range. Felt good in testing.
  const bs = Math.exp((opts.shadowsBias ?? 0) / 50);
  const bm = Math.exp((opts.midsBias ?? 0) / 50);
  const bh = Math.exp((opts.highlightsBias ?? 0) / 50);
  for (let v = 0; v < 256; v++) {
    const ws = bs * Math.exp(-((v - sCtr) ** 2) * sInv);
    const wm = bm * Math.exp(-((v - mCtr) ** 2) * mInv);
    const wh = bh * Math.exp(-((v - hCtr) ** 2) * hInv);
    const sum = ws + wm + wh || 1;
    w[v] = (s * ws + m * wm + h * wh) / sum;
  }
  return w;
}

export function applyZoneWeights(curve: Uint8Array, weights: Float64Array): Uint8Array {
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    out[v] = Math.max(0, Math.min(255, Math.round(v + (curve[v] - v) * weights[v])));
  }
  return out;
}

// Build a 256-bin luma histogram of average RGB from RGBA pixels. Used to color the zone
// band swatches with the actual mean color of pixels at each luminance level.
export interface LumaBins {
  sumR: Float64Array; sumG: Float64Array; sumB: Float64Array; count: Uint32Array;
}
export function computeLumaBins(rgba: Uint8Array): LumaBins {
  const sumR = new Float64Array(256), sumG = new Float64Array(256), sumB = new Float64Array(256);
  const count = new Uint32Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 8) continue; // skip transparent
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    // Rec.709 luma
    const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    sumR[l] += r; sumG[l] += g; sumB[l] += b; count[l]++;
  }
  return { sumR, sumG, sumB, count };
}

// Find first/last luma bin with non-trivial pixel mass. Used by the stretch-anchor toggle so
// the slope cap walks from where the data actually starts/ends rather than 0/255.
// `minFraction` = ignore bins with fewer than this fraction of the peak count (rejects noise).
export function lumaRange(bins: LumaBins, minFraction = 0.005): { start: number; end: number } {
  let peak = 0;
  for (let i = 0; i < 256; i++) if (bins.count[i] > peak) peak = bins.count[i];
  const thresh = peak * minFraction;
  let start = 0, end = 255;
  for (let i = 0; i < 256; i++) { if (bins.count[i] > thresh) { start = i; break; } }
  for (let i = 255; i >= 0; i--) { if (bins.count[i] > thresh) { end = i; break; } }
  return { start, end: Math.max(start + 1, end) };
}

// Gaussian-weighted mean RGB color centered at `anchor` with the given falloff.
// Returns null if no pixels in range. Falloff scaling matches buildZoneWeights.
export function bandMeanColor(bins: LumaBins, anchor: number, falloff: number): { r: number; g: number; b: number } | null {
  const sigma = 18 + (falloff / 100) * 60;
  const inv2s2 = 1 / (2 * sigma * sigma);
  let R = 0, G = 0, B = 0, W = 0;
  for (let v = 0; v < 256; v++) {
    if (bins.count[v] === 0) continue;
    const w = Math.exp(-((v - anchor) ** 2) * inv2s2);
    const cw = w * bins.count[v];
    R += bins.sumR[v] * w;
    G += bins.sumG[v] * w;
    B += bins.sumB[v] * w;
    W += cw;
  }
  if (W < 1e-6) return null;
  return { r: R / W, g: G / W, b: B / W };
}

export function applyZoneWeightsToChannels(c: ChannelCurves, opts: ZoneOpts): ChannelCurves {
  const w = buildZoneWeights(opts);
  return {
    r: enforceMonotonic(applyZoneWeights(c.r, w)),
    g: enforceMonotonic(applyZoneWeights(c.g, w)),
    b: enforceMonotonic(applyZoneWeights(c.b, w)),
  };
}

// ─── Envelope: arbitrary-N piecewise-linear weight curve over input 0..255 ─────
// Generalizes the 3-zone gaussians: user places N points along the input axis,
// each with a strength 0..2. Linear interpolation between sorted points; clamped
// to the endpoint values outside [first,last]. Empty array → identity (no effect).
//
// Composes with zones by multiplication: w_final[v] = w_zone[v] * w_envelope[v].
// Default empty preserves prior behavior bit-exactly.

// `smooth` (optional, defaults to true): when both endpoints of a segment are smooth, the
// segment is interpolated with monotone cubic Hermite (Fritsch-Carlson). When either endpoint
// is a corner (smooth=false), the segment falls back to linear. Lets users mix sharp rolloffs
// and gentle curves in one envelope, like Photoshop's Curves dialog.
export interface EnvelopePoint { position: number; weight: number; smooth?: boolean; }

// Three identity-weight points (0, 127, 255 all at weight=1) — produces a flat line at the
// reference, mathematically a no-op until the user moves any handle. Picked over an empty
// default so the middle handle is immediately grabbable for bending.
export const DEFAULT_ENVELOPE: EnvelopePoint[] = [
  { position: 0,   weight: 1, smooth: true },
  { position: 127, weight: 1, smooth: true },
  { position: 255, weight: 1, smooth: true },
];

const isSmooth = (p: EnvelopePoint) => p.smooth !== false;

export function buildEnvelopeWeights(pts: EnvelopePoint[]): Float64Array {
  const w = new Float64Array(256);
  if (!pts || pts.length === 0) { w.fill(1); return w; }
  if (pts.length === 1) { w.fill(Math.max(0, pts[0].weight)); return w; }
  const sorted = [...pts].sort((a, b) => a.position - b.position);
  const n = sorted.length;
  const first = sorted[0], last = sorted[n - 1];

  // Fritsch-Carlson monotone cubic Hermite tangents. Computed once, used only for segments
  // where both endpoints are smooth — non-monotonic, no overshoot, well-behaved for weights.
  const x = sorted.map(p => p.position);
  const y = sorted.map(p => Math.max(0, p.weight));
  const d = new Array(n - 1);  // secant slopes
  for (let k = 0; k < n - 1; k++) {
    const dx = x[k + 1] - x[k] || 1;
    d[k] = (y[k + 1] - y[k]) / dx;
  }
  const m = new Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    // At peaks/valleys (sign change in adjacent secants), force tangent to 0 — this is
    // the Fritsch-Carlson rule that prevents overshoot at local extrema.
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else m[k] = (d[k - 1] + d[k]) / 2;
  }
  // Monotonicity correction.
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }

  let i = 0;
  for (let v = 0; v < 256; v++) {
    if (v <= first.position) { w[v] = Math.max(0, first.weight); continue; }
    if (v >= last.position) { w[v] = Math.max(0, last.weight); continue; }
    while (i < n - 2 && v > x[i + 1]) i++;
    const xa = x[i], xb = x[i + 1];
    const ya = y[i], yb = y[i + 1];
    const h = (xb - xa) || 1;
    const t = (v - xa) / h;
    let val: number;
    if (isSmooth(sorted[i]) && isSmooth(sorted[i + 1])) {
      // Cubic Hermite basis.
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      val = h00 * ya + h10 * h * m[i] + h01 * yb + h11 * h * m[i + 1];
    } else {
      val = ya + (yb - ya) * t;
    }
    w[v] = Math.max(0, val);
  }
  return w;
}

// Combined zone + envelope application. Multiplies the two weight arrays then applies
// the standard zone-weight blend per channel.
export function applyZoneAndEnvelopeToChannels(
  c: ChannelCurves, opts: ZoneOpts, envelope: EnvelopePoint[]
): ChannelCurves {
  const wz = buildZoneWeights(opts);
  const we = buildEnvelopeWeights(envelope);
  const w = new Float64Array(256);
  for (let i = 0; i < 256; i++) w[i] = wz[i] * we[i];
  return {
    r: enforceMonotonic(applyZoneWeights(c.r, w)),
    g: enforceMonotonic(applyZoneWeights(c.g, w)),
    b: enforceMonotonic(applyZoneWeights(c.b, w)),
  };
}

// Sample a 256-entry curve down to N control points evenly spaced on [0,255].
export function sampleControlPoints(curve: Uint8Array, n: number): { input: number; output: number }[] {
  const pts: { input: number; output: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((i / (n - 1)) * 255);
    pts.push({ input: x, output: curve[x] });
  }
  return pts;
}

export function applyChannelCurvesToRgba(rgba: Uint8Array, c: ChannelCurves): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i]     = c.r[rgba[i]];
    out[i + 1] = c.g[rgba[i + 1]];
    out[i + 2] = c.b[rgba[i + 2]];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// Simulate PS "Hue" blend mode: take H from mapped, keep S + L (Rec.709 luma) from original.
// Matches the visual effect of setting the Curves layer's blend mode to Hue in PS — which is
// what Color Smash uses for "Hue only" matching. Hue blend avoids the saturation inflation
// that per-channel curves naturally produce, so the result tracks the target's existing
// chroma rather than getting pumped up by the curve fit.
// Quick-select presets — 4 orthogonal "what aspect of source do I take" options.
//   color    : full per-channel match (default)
//   hue      : take chroma from match, keep target's luma + saturation
//   bw       : grayscale output, value-matched to source
//   contrast : take luma from match, keep target's chroma — opposite of hue
export type Preset = "color" | "hue" | "bw" | "contrast";

// Average R/G/B curves into one luma curve. bw + contrast both want a single tone-only
// response, no per-channel color shift, so they collapse here.
export function averageChannelCurves(c: ChannelCurves): ChannelCurves {
  const arr = new Uint8Array(256);
  for (let v = 0; v < 256; v++) arr[v] = Math.round((c.r[v] + c.g[v] + c.b[v]) / 3);
  return { r: arr, g: arr, b: arr };
}

// Per-preset curve transformation. Returns the curves to write into the Curves layer.
export function transformCurvesForPreset(c: ChannelCurves, preset: Preset): ChannelCurves {
  return preset === "bw" || preset === "contrast" ? averageChannelCurves(c) : c;
}

// JS-side post-processing for previews. PS Apply uses blend modes / extra layers to
// achieve the same visual result, but the preview pane needs the final pixel output.
export function applyPresetPostprocess(original: Uint8Array, mapped: Uint8Array, preset: Preset): Uint8Array {
  if (preset === "color") return mapped;
  if (preset === "hue") return applyChromaOnly(original, mapped);
  if (preset === "bw") {
    // Force grayscale: R=G=B=Rec.709 luma of mapped output. Saturation pinned to 0.
    const out = new Uint8Array(mapped.length);
    for (let i = 0; i < mapped.length; i += 4) {
      const luma = Math.round(0.2126 * mapped[i] + 0.7152 * mapped[i + 1] + 0.0722 * mapped[i + 2]);
      const v = Math.max(0, Math.min(255, luma));
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = mapped[i + 3];
    }
    return out;
  }
  // contrast: shift original RGB by (mapped luma - original luma). Preserves chroma,
  // applies the luma-curve change. Equivalent to Curves layer at Luminosity blend.
  const out = new Uint8Array(original.length);
  for (let i = 0; i < original.length; i += 4) {
    const oL = 0.2126 * original[i] + 0.7152 * original[i + 1] + 0.0722 * original[i + 2];
    const mL = 0.2126 * mapped[i]   + 0.7152 * mapped[i + 1]   + 0.0722 * mapped[i + 2];
    const d = mL - oL;
    out[i]     = Math.max(0, Math.min(255, Math.round(original[i]     + d)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(original[i + 1] + d)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(original[i + 2] + d)));
    out[i + 3] = original[i + 3];
  }
  return out;
}

export function applyChromaOnly(original: Uint8Array, mapped: Uint8Array): Uint8Array {
  const out = new Uint8Array(mapped.length);
  for (let i = 0; i < mapped.length; i += 4) {
    const [h] = rgbToHsl(mapped[i], mapped[i + 1], mapped[i + 2]);
    const [, sOrig] = rgbToHsl(original[i], original[i + 1], original[i + 2]);
    // Build candidate at (h_mapped, s_orig, l_HSL_orig) then re-impose Rec.709 luma
    // from the original. This is closer to PS's HSY-style Hue blend than pure HSL.
    const [, , lHsl] = rgbToHsl(original[i], original[i + 1], original[i + 2]);
    const [r0, g0, b0] = hslToRgb(h, sOrig, lHsl);
    const lumaOrig = 0.2126 * original[i] + 0.7152 * original[i + 1] + 0.0722 * original[i + 2];
    const lumaCand = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
    const delta = lumaOrig - lumaCand;
    out[i]     = Math.max(0, Math.min(255, Math.round(r0 + delta)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(g0 + delta)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(b0 + delta)));
    out[i + 3] = mapped[i + 3];
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1; else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}
