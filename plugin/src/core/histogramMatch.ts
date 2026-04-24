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

// Clamp local slope so |Δoutput / Δinput| ≤ maxRatio. Walks both directions to anchor the
// midpoint so caps don't drag everything toward 0 or 255. maxRatio < 1 means flatten.
export function capStretch(curve: Uint8Array, maxRatio: number): Uint8Array {
  if (maxRatio <= 0) return curve;
  const out = new Uint8Array(curve);
  // Forward pass.
  for (let v = 1; v < 256; v++) {
    const maxJump = Math.max(1, Math.round(maxRatio));
    if (out[v] > out[v - 1] + maxJump) out[v] = out[v - 1] + maxJump;
  }
  // Reverse pass to handle compressive (negative-slope-direction) extremes too.
  for (let v = 254; v >= 0; v--) {
    const maxDrop = Math.max(1, Math.round(maxRatio));
    if (out[v] < out[v + 1] - maxDrop) out[v] = out[v + 1] - maxDrop;
  }
  return out;
}

export interface CurveProcessOpts {
  amount: number;       // 0..1
  smoothRadius: number; // 0..64
  maxStretch: number;   // local slope cap; 1 = identity-only, large = no cap
}

// Full pipeline: stretch-cap → blend with identity by amount → smooth → enforce monotonic.
export function processCurve(raw: Uint8Array, opts: CurveProcessOpts): Uint8Array {
  let c = raw;
  if (opts.maxStretch > 0 && opts.maxStretch < 100) c = capStretch(c, opts.maxStretch);
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
  mids: number;
  midsAnchor: number;
  midsFalloff: number;
  highlights: number;
  highlightsAnchor: number;
  highlightsFalloff: number;
}

export const DEFAULT_ZONES: ZoneOpts = {
  shadows: 100,    shadowsAnchor: 42,    shadowsFalloff: 50,
  mids: 100,       midsAnchor: 127,      midsFalloff: 50,
  highlights: 100, highlightsAnchor: 212, highlightsFalloff: 50,
};

// Per-input weight in [0,1]: how strongly the matched curve replaces the identity at that input.
// When all three amounts = 100, weight ≡ 1 by partition-of-unity normalization → identity behavior.
export function buildZoneWeights(opts: ZoneOpts): Float64Array {
  const w = new Float64Array(256);
  const sig = (f: number) => { const s = 18 + (f / 100) * 60; return 1 / (2 * s * s); };
  const sInv = sig(opts.shadowsFalloff), mInv = sig(opts.midsFalloff), hInv = sig(opts.highlightsFalloff);
  const sCtr = opts.shadowsAnchor, mCtr = opts.midsAnchor, hCtr = opts.highlightsAnchor;
  const s = opts.shadows / 100, m = opts.mids / 100, h = opts.highlights / 100;
  for (let v = 0; v < 256; v++) {
    const ws = Math.exp(-((v - sCtr) ** 2) * sInv);
    const wm = Math.exp(-((v - mCtr) ** 2) * mInv);
    const wh = Math.exp(-((v - hCtr) ** 2) * hInv);
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

export function applyZoneWeightsToChannels(c: ChannelCurves, opts: ZoneOpts): ChannelCurves {
  const w = buildZoneWeights(opts);
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

// Simulate PS "Color" blend mode: keep target's HSL Lightness, take H+S from mapped pixels.
// Matches the visual effect of setting the Curves layer's blend mode to Color in PS.
export function applyChromaOnly(original: Uint8Array, mapped: Uint8Array): Uint8Array {
  const out = new Uint8Array(mapped.length);
  for (let i = 0; i < mapped.length; i += 4) {
    const [h, s] = rgbToHsl(mapped[i], mapped[i + 1], mapped[i + 2]);
    const [, , l] = rgbToHsl(original[i], original[i + 1], original[i + 2]);
    const [r, g, b] = hslToRgb(h, s, l);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = mapped[i + 3];
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
