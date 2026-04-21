// Per-zone tonal-range color transform. Pure TS; mirrors the bake stack so preview matches output.
//
// Per-zone operations applied bottom-up (matching the bake stack inside [Color Smash] zones):
//   1. Value (composite Curves) — brightness shift at zone midpoint
//   2. Color shift (per-channel R/G/B Curves) — pull this zone toward a target color
//   3. Hue/Sat (master) — hue rotation + saturation scale
// Each zone weighted by trapezoidal tonal mask, blended into input.

export interface ZoneState {
  hue: number;            // -180..180
  sat: number;            // -100..100
  colorR: number;         // 0..255 — target color for the per-channel shift
  colorG: number;
  colorB: number;
  colorIntensity: number; // 0..100 — how strongly to push channels toward the target
  rangeStart: number;     // 0..100 (full-effect start)
  rangeEnd: number;       // 0..100 (full-effect end)
  featherLeft: number;    // 0..100
  featherRight: number;   // 0..100
}

export interface TonalState {
  blackPoint: number;        // 0..255 — input level mapped to outputBlack
  whitePoint: number;        // 0..255 — input level mapped to outputWhite
  gamma: number;             // 0.1..3.0 — midpoint shift (1.0 = identity)
  outputBlack: number;       // 0..255 — destination floor (source's darkest)
  outputWhite: number;       // 0..255 — destination ceiling (source's brightest)
}

export const IDENTITY_TONAL: TonalState = {
  blackPoint: 0, whitePoint: 255, gamma: 1.0,
  outputBlack: 0, outputWhite: 255,
};

export interface ZonesState {
  tonal: TonalState;
  shadows: ZoneState;
  midtones: ZoneState;
  highlights: ZoneState;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
const clamp255 = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v;

// ─── HSL helpers ────────────────────────────────────────────────────────────
function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) return { r: l, g: l, b: l };
  const hue2 = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2(p, q, h + 1/3), g: hue2(p, q, h), b: hue2(p, q, h - 1/3) };
}

// ─── Curves ─────────────────────────────────────────────────────────────────
// Anchor at (0,0), (mid, mid+shift), (255,255). Used for both composite (value)
// and per-channel (color shift) curves. Linear interpolation matches PS Curves
// closely enough for a 3-anchor curve.
export function shiftCurvePoints(zoneMidL: number, shift: number) {
  const mid = Math.round(zoneMidL * 2.55);
  return [
    { input: 0,   output: 0 },
    { input: mid, output: clamp255(mid + shift) },
    { input: 255, output: 255 },
  ];
}

function applyCurve(input: number, points: { input: number; output: number }[]): number {
  const sorted = [...points].sort((a, b) => a.input - b.input);
  if (input <= sorted[0].input) return sorted[0].output;
  if (input >= sorted[sorted.length - 1].input) return sorted[sorted.length - 1].output;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (input >= a.input && input <= b.input) {
      const t = (input - a.input) / Math.max(1e-9, b.input - a.input);
      return a.output + t * (b.output - a.output);
    }
  }
  return input;
}

// ─── Color shift: per-channel curves derived from target color + intensity ──
// Each channel gets shifted toward (target - 128) * (intensity/100) * scale.
// scale of 1.0 means at intensity=100, full target shift (127 max).
export function colorShiftCurves(z: ZoneState) {
  const mid = (z.rangeStart + z.rangeEnd) / 2;
  const intensity = z.colorIntensity / 100;
  const rShift = Math.round((z.colorR - 128) * intensity);
  const gShift = Math.round((z.colorG - 128) * intensity);
  const bShift = Math.round((z.colorB - 128) * intensity);
  return {
    r: shiftCurvePoints(mid, rShift),
    g: shiftCurvePoints(mid, gShift),
    b: shiftCurvePoints(mid, bShift),
  };
}

// Levels-style global tonal mapping: input black→outputBlack, input white→outputWhite,
// with gamma midpoint. Identity = 0/255 input, 0/255 output, gamma 1.
export function applyTonal(input: number, t: TonalState): number {
  if (t.blackPoint === 0 && t.whitePoint === 255 && t.gamma === 1.0
      && t.outputBlack === 0 && t.outputWhite === 255) return input;
  const black = Math.max(0, Math.min(254, t.blackPoint));
  const white = Math.max(black + 1, Math.min(255, t.whitePoint));
  let normalized = (input - black) / (white - black);
  normalized = clamp01(normalized);
  if (t.gamma !== 1.0) normalized = Math.pow(normalized, 1 / Math.max(0.01, t.gamma));
  const outBlack = Math.max(0, Math.min(255, t.outputBlack));
  const outWhite = Math.max(outBlack, Math.min(255, t.outputWhite));
  return clamp255(outBlack + normalized * (outWhite - outBlack));
}

// Build a 5-point Curves spline that approximates the Levels (black/white/gamma) operation.
// Used by bakeZones to emit a Curves layer matching the simulator's tonal pass.
export function tonalCurvePoints(t: TonalState) {
  return [
    { input: 0,                                       output: 0 },
    { input: t.blackPoint,                            output: 0 },
    { input: Math.round((t.blackPoint + t.whitePoint) / 2), output: Math.round(applyTonal((t.blackPoint + t.whitePoint) / 2, t)) },
    { input: t.whitePoint,                            output: 255 },
    { input: 255,                                     output: 255 },
  ];
}

// ─── Trapezoidal zone weight ────────────────────────────────────────────────
function zoneWeight(L100: number, z: ZoneState): number {
  const a = Math.min(z.rangeStart, z.rangeEnd);
  const b = Math.max(z.rangeStart, z.rangeEnd);
  const fL = Math.max(0, z.featherLeft);
  const fR = Math.max(0, z.featherRight);
  if (L100 < a - fL || L100 > b + fR) return 0;
  if (L100 < a) return fL === 0 ? 1 : (L100 - (a - fL)) / fL;
  if (L100 > b) return fR === 0 ? 1 : ((b + fR) - L100) / fR;
  return 1;
}

// ─── One zone's full transform (color + hue/sat only — value is global) ─────
function applyZone(input: { r: number; g: number; b: number }, z: ZoneState, w: number) {
  if (w === 0) return input;
  let r = input.r, g = input.g, b = input.b;

  if (z.colorIntensity > 0) {
    const cc = colorShiftCurves(z);
    r = applyCurve(r * 255, cc.r) / 255;
    g = applyCurve(g * 255, cc.g) / 255;
    b = applyCurve(b * 255, cc.b) / 255;
  }

  if (z.hue !== 0 || z.sat !== 0) {
    const hsl = rgbToHsl(r, g, b);
    hsl.h = (hsl.h + z.hue / 360) % 1;
    if (hsl.h < 0) hsl.h += 1;
    hsl.s = clamp01(hsl.s * (1 + z.sat / 100));
    const out = hslToRgb(hsl.h, hsl.s, hsl.l);
    r = out.r; g = out.g; b = out.b;
  }

  return {
    r: input.r * (1 - w) + r * w,
    g: input.g * (1 - w) + g * w,
    b: input.b * (1 - w) + b * w,
  };
}

export function applyZones(rgba: Uint8Array, zones: ZonesState): Uint8Array {
  const out = new Uint8Array(rgba.length);
  const t = zones.tonal;
  for (let i = 0; i < rgba.length; i += 4) {
    // 1) Global tonal pass (Levels-style) applied to each channel.
    let r = applyTonal(rgba[i],     t) / 255;
    let g = applyTonal(rgba[i + 1], t) / 255;
    let b = applyTonal(rgba[i + 2], t) / 255;
    let pixel = { r, g, b };

    // 2) Per-zone color + hue/sat, gated by tonal weights computed from the post-tonal L.
    const L100 = (0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b) * 100;
    pixel = applyZone(pixel, zones.shadows,    zoneWeight(L100, zones.shadows));
    pixel = applyZone(pixel, zones.midtones,   zoneWeight(L100, zones.midtones));
    pixel = applyZone(pixel, zones.highlights, zoneWeight(L100, zones.highlights));

    out[i]     = Math.round(clamp01(pixel.r) * 255);
    out[i + 1] = Math.round(clamp01(pixel.g) * 255);
    out[i + 2] = Math.round(clamp01(pixel.b) * 255);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// Compute Lab statistics (mean + chroma stddev) of pixels within an L band.
// Returns null if the band is empty. Uses approximate sRGB→Lab via Y for L and a quick a/b proxy.
import { rgbToLab } from "./lab";
export function labStatsInBand(rgba: Uint8Array, lowL100: number, highL100: number): { muL: number; muA: number; muB: number; sA: number; sB: number; meanRGB: { r: number; g: number; b: number }; n: number } | null {
  let sumL = 0, sumA = 0, sumB = 0, sum2A = 0, sum2B = 0;
  let sumR = 0, sumG = 0, sumBl = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * 100;
    if (L < lowL100 || L > highL100) continue;
    const lab = rgbToLab({ r: r / 255, g: g / 255, b: b / 255 });
    sumL += lab.L; sumA += lab.a; sumB += lab.b;
    sum2A += lab.a * lab.a; sum2B += lab.b * lab.b;
    sumR += r; sumG += g; sumBl += b;
    n++;
  }
  if (n === 0) return null;
  const muA = sumA / n, muB = sumB / n;
  const sA = Math.sqrt(Math.max(0, sum2A / n - muA * muA));
  const sB = Math.sqrt(Math.max(0, sum2B / n - muB * muB));
  return {
    muL: sumL / n, muA, muB, sA, sB,
    meanRGB: { r: Math.round(sumR / n), g: Math.round(sumG / n), b: Math.round(sumBl / n) },
    n,
  };
}

// Compute mean RGB of pixels within [lowL100, highL100] luminance range. Returns null if the band is empty.
export function meanColorInBand(rgba: Uint8Array, lowL100: number, highL100: number): { r: number; g: number; b: number } | null {
  let sumR = 0, sumG = 0, sumB = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const L = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255 * 100;
    if (L < lowL100 || L > highL100) continue;
    sumR += rgba[i]; sumG += rgba[i + 1]; sumB += rgba[i + 2]; n++;
  }
  if (n === 0) return null;
  return { r: Math.round(sumR / n), g: Math.round(sumG / n), b: Math.round(sumB / n) };
}

// Compute global L mean + stddev (in 0..255 RGB-byte units) from a pixel buffer.
// This is what we feed into Reinhard's L-axis affine to derive Levels black/white points
// that exactly reproduce target's distribution remapped to source's distribution.
export function lMeanStddev(rgba: Uint8Array): { mean: number; stddev: number; n: number } {
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const L = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    sum += L; sumSq += L * L; n++;
  }
  if (n === 0) return { mean: 128, stddev: 1, n: 0 };
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean, stddev: Math.sqrt(variance), n };
}

// Compute L percentile cutoffs (each in 0..100 scale) from a pixel buffer.
// Returns the L value (in 0..100) at each requested percentile.
export function lPercentiles(rgba: Uint8Array, percentiles: number[]): number[] {
  const histogram = new Uint32Array(101); // L bucket 0..100
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const L = Math.min(100, Math.max(0, Math.round((0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255 * 100)));
    histogram[L]++;
    total++;
  }
  const result: number[] = [];
  if (total === 0) return percentiles.map(() => 50);
  for (const pct of percentiles) {
    const target = total * (pct / 100);
    let cum = 0, found = 100;
    for (let v = 0; v <= 100; v++) {
      cum += histogram[v];
      if (cum >= target) { found = v; break; }
    }
    result.push(found);
  }
  return result;
}

// Auto-detect black/white points from a pixel buffer using percentile clipping.
export function autoDetectTonal(rgba: Uint8Array, lowPct = 0.5, highPct = 99.5): { blackPoint: number; whitePoint: number } {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const L = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
    histogram[L]++;
    total++;
  }
  if (total === 0) return { blackPoint: 0, whitePoint: 255 };
  const lowTarget = total * (lowPct / 100);
  const highTarget = total * (highPct / 100);
  let cum = 0, blackPoint = 0, whitePoint = 255;
  for (let v = 0; v < 256; v++) {
    cum += histogram[v];
    if (cum >= lowTarget && blackPoint === 0) blackPoint = v;
    if (cum >= highTarget) { whitePoint = v; break; }
  }
  return { blackPoint, whitePoint: Math.max(blackPoint + 1, whitePoint) };
}
