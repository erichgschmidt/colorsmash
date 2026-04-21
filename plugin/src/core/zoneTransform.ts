// Per-zone tonal-range color transform. Pure TS; mirrors the bake stack so preview matches output.
//
// Per-zone operations applied bottom-up (matching the bake stack inside [Color Smash] zones):
//   1. Value (composite Curves) — brightness shift at zone midpoint
//   2. Color shift (per-channel R/G/B Curves) — pull this zone toward a target color
//   3. Hue/Sat (master) — hue rotation + saturation scale
// Each zone weighted by trapezoidal tonal mask, blended into input.

export interface ZoneState {
  hue: number;
  sat: number;
  colorR: number;
  colorG: number;
  colorB: number;
  colorIntensity: number;
  rangeStart: number;
  rangeEnd: number;
  featherLeft: number;
  featherRight: number;
  // Optional per-zone Lab-fitted per-channel LUTs. When present, override the color picker delta.
  colorLUT?: { r: number[]; g: number[]; b: number[] };
}

export interface TonalState {
  blackPoint: number;
  whitePoint: number;
  gamma: number;
  outputBlack: number;
  outputWhite: number;
  matchCurve?: number[];                                    // composite LUT (legacy single-channel match)
  matchPerChannel?: { r: number[]; g: number[]; b: number[] };  // per-channel match (preferred for transfer)
}

export const IDENTITY_TONAL: TonalState = {
  blackPoint: 0, whitePoint: 255, gamma: 1.0,
  outputBlack: 0, outputWhite: 255,
};

export interface ZonesState {
  tonal: TonalState;
  zones: ZoneState[];   // N zones, ordered from shadow to highlight along L
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

// Levels-style global tonal mapping with optional histogram-match LUT override.
// Note: per-channel match isn't applied here (each channel needs its own LUT). Sim handles it
// in applyZones by checking matchPerChannel directly.
export function applyTonal(input: number, t: TonalState): number {
  if (t.matchCurve) {
    const i = Math.max(0, Math.min(255, Math.round(input)));
    return t.matchCurve[i];
  }
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

  // Per-zone colorLUT (Lab-fitted per-channel) overrides the delta-encoded color shift.
  if (z.colorLUT) {
    r = z.colorLUT.r[Math.max(0, Math.min(255, Math.round(r * 255)))] / 255;
    g = z.colorLUT.g[Math.max(0, Math.min(255, Math.round(g * 255)))] / 255;
    b = z.colorLUT.b[Math.max(0, Math.min(255, Math.round(b * 255)))] / 255;
  } else if (z.colorIntensity > 0) {
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
  const pc = t.matchPerChannel;
  for (let i = 0; i < rgba.length; i += 4) {
    let r: number, g: number, b: number;
    if (pc) {
      r = pc.r[Math.max(0, Math.min(255, rgba[i]))]     / 255;
      g = pc.g[Math.max(0, Math.min(255, rgba[i + 1]))] / 255;
      b = pc.b[Math.max(0, Math.min(255, rgba[i + 2]))] / 255;
    } else {
      r = applyTonal(rgba[i],     t) / 255;
      g = applyTonal(rgba[i + 1], t) / 255;
      b = applyTonal(rgba[i + 2], t) / 255;
    }
    let pixel = { r, g, b };

    const L100 = (0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b) * 100;
    for (const zone of zones.zones) {
      pixel = applyZone(pixel, zone, zoneWeight(L100, zone));
    }

    out[i]     = Math.round(clamp01(pixel.r) * 255);
    out[i + 1] = Math.round(clamp01(pixel.g) * 255);
    out[i + 2] = Math.round(clamp01(pixel.b) * 255);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

// Derive N-zone ranges and feathers from a boundaries array.
// boundaries.length = 2 * (N-1); ordered [core_end_0, core_start_1, core_end_1, core_start_2, ...]
// pads.length = N - 1; pad[i] extends the feather between zone i and i+1 outward.
export function boundariesToZoneRanges(boundaries: number[], pads: number[]): { rangeStart: number; rangeEnd: number; featherLeft: number; featherRight: number }[] {
  const N = boundaries.length / 2 + 1;
  const out: { rangeStart: number; rangeEnd: number; featherLeft: number; featherRight: number }[] = [];
  for (let i = 0; i < N; i++) {
    const coreStart = i === 0 ? 0 : boundaries[2 * i - 1];
    const coreEnd   = i === N - 1 ? 100 : boundaries[2 * i];
    const featherL = i === 0 ? 0 :
      (boundaries[2 * i - 1] - boundaries[2 * i - 2]) + 2 * (pads[i - 1] ?? 0);
    const featherR = i === N - 1 ? 0 :
      (boundaries[2 * i + 1] - boundaries[2 * i]) + 2 * (pads[i] ?? 0);
    out.push({ rangeStart: coreStart, rangeEnd: coreEnd, featherLeft: featherL, featherRight: featherR });
  }
  return out;
}

// Default boundaries for N evenly-distributed zones. For N=3: [25, 40, 60, 75].
// For N=5: [12, 24, 36, 48, 60, 72] (wait we need 2*(N-1) = 8 values). Let me recompute.
// 2*(N-1) boundaries define N zones. For N=5: 8 values. Core ends/starts split at 1/N intervals.
export function defaultBoundaries(n: number): { boundaries: number[]; pads: number[] } {
  const boundaries: number[] = [];
  const transitionWidth = 15 / Math.max(1, n - 1); // narrower transitions with more zones
  for (let i = 0; i < n - 1; i++) {
    const center = ((i + 1) / n) * 100;
    boundaries.push(Math.round(center - transitionWidth / 2));
    boundaries.push(Math.round(center + transitionWidth / 2));
  }
  const pads = Array(n - 1).fill(0);
  return { boundaries, pads };
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

// Per-zone Lab-correlation LUT: same conditional-expectation fitting but restricted to pixels
// whose L falls within the zone's L range (with soft inclusion via the trapezoidal weight).
// Yields tighter, zone-specific RGB curves that carry source's palette for that tonal band.
export function buildLabCorrelationLUTInBand(
  targetRgba: Uint8Array,
  sourceRgba: Uint8Array,
  tgtLowL100: number, tgtHighL100: number,
  srcLowL100: number, srcHighL100: number,
): { r: number[]; g: number[]; b: number[] } {
  const L_MAX = 100, AB_OFF = 128;
  const quantL = (L: number) => Math.max(0, Math.min(255, Math.round(L / L_MAX * 255)));
  const quantAB = (v: number) => Math.max(0, Math.min(255, Math.round(v + AB_OFF)));

  const tLHist = new Uint32Array(256), tAHist = new Uint32Array(256), tBHist = new Uint32Array(256);
  const sLHist = new Uint32Array(256), sAHist = new Uint32Array(256), sBHist = new Uint32Array(256);
  let tN = 0, sN = 0;
  for (let i = 0; i < targetRgba.length; i += 4) {
    if (targetRgba[i + 3] === 0) continue;
    const L100 = (0.2126 * targetRgba[i] + 0.7152 * targetRgba[i + 1] + 0.0722 * targetRgba[i + 2]) / 255 * 100;
    if (L100 < tgtLowL100 || L100 > tgtHighL100) continue;
    const lab = rgb2lab({ r: targetRgba[i] / 255, g: targetRgba[i + 1] / 255, b: targetRgba[i + 2] / 255 });
    tLHist[quantL(lab.L)]++; tAHist[quantAB(lab.a)]++; tBHist[quantAB(lab.b)]++; tN++;
  }
  for (let i = 0; i < sourceRgba.length; i += 4) {
    if (sourceRgba[i + 3] === 0) continue;
    const L100 = (0.2126 * sourceRgba[i] + 0.7152 * sourceRgba[i + 1] + 0.0722 * sourceRgba[i + 2]) / 255 * 100;
    if (L100 < srcLowL100 || L100 > srcHighL100) continue;
    const lab = rgb2lab({ r: sourceRgba[i] / 255, g: sourceRgba[i + 1] / 255, b: sourceRgba[i + 2] / 255 });
    sLHist[quantL(lab.L)]++; sAHist[quantAB(lab.a)]++; sBHist[quantAB(lab.b)]++; sN++;
  }
  if (tN === 0 || sN === 0) {
    const id = Array.from({ length: 256 }, (_, i) => i);
    return { r: id, g: id, b: id };
  }

  const cdfMatch = (tgtHist: Uint32Array, srcHist: Uint32Array): number[] => {
    const tCDF = new Float64Array(256), sCDF = new Float64Array(256);
    let cT = 0, cS = 0;
    for (let v = 0; v < 256; v++) { cT += tgtHist[v]; cS += srcHist[v]; tCDF[v] = cT / tN; sCDF[v] = cS / sN; }
    const lut = new Array<number>(256);
    let u = 0;
    for (let v = 0; v < 256; v++) {
      const t = tCDF[v];
      while (u < 255 && sCDF[u] < t) u++;
      lut[v] = u;
    }
    return lut;
  };
  const lutL = cdfMatch(tLHist, sLHist);
  const lutA = cdfMatch(tAHist, sAHist);
  const lutB = cdfMatch(tBHist, sBHist);

  const rSum = new Float64Array(256), rCount = new Uint32Array(256);
  const gSum = new Float64Array(256), gCount = new Uint32Array(256);
  const bSum = new Float64Array(256), bCount = new Uint32Array(256);
  for (let i = 0; i < targetRgba.length; i += 4) {
    if (targetRgba[i + 3] === 0) continue;
    const r = targetRgba[i], g = targetRgba[i + 1], b = targetRgba[i + 2];
    const L100 = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * 100;
    if (L100 < tgtLowL100 || L100 > tgtHighL100) continue;
    const lab = rgb2lab({ r: r / 255, g: g / 255, b: b / 255 });
    const Lout = lutL[quantL(lab.L)] / 255 * L_MAX;
    const aOut = lutA[quantAB(lab.a)] - AB_OFF;
    const bOut = lutB[quantAB(lab.b)] - AB_OFF;
    const rgbOut = lab2rgb({ L: Lout, a: aOut, b: bOut });
    const ro = Math.max(0, Math.min(255, Math.round(rgbOut.r * 255)));
    const go = Math.max(0, Math.min(255, Math.round(rgbOut.g * 255)));
    const bo = Math.max(0, Math.min(255, Math.round(rgbOut.b * 255)));
    rSum[r] += ro; rCount[r]++;
    gSum[g] += go; gCount[g]++;
    bSum[b] += bo; bCount[b]++;
  }

  const finalize = (sum: Float64Array, count: Uint32Array): number[] => {
    const lut = new Array<number>(256);
    for (let v = 0; v < 256; v++) lut[v] = count[v] > 0 ? Math.round(sum[v] / count[v]) : v;
    let lastFilled = -1;
    for (let v = 0; v < 256; v++) {
      if (count[v] > 0) {
        if (lastFilled >= 0 && v - lastFilled > 1) {
          for (let k = lastFilled + 1; k < v; k++) {
            const t = (k - lastFilled) / (v - lastFilled);
            lut[k] = Math.round(lut[lastFilled] * (1 - t) + lut[v] * t);
          }
        }
        lastFilled = v;
      }
    }
    return lut;
  };
  return { r: finalize(rSum, rCount), g: finalize(gSum, gCount), b: finalize(bSum, bCount) };
}

// Lab-correlation LUT: build per-channel R/G/B LUTs that best approximate a Lab-space
// histogram match via conditional expectation fitting. The process:
//   1. Build CDF-match LUTs for each Lab axis (L, a, b) between target and source.
//   2. For every target pixel, compute its "true" Lab-matched output RGB.
//   3. Per channel: bin by input value 0..255, average the observed outputs → that bin's LUT value.
// Resulting LUTs preserve hue much better than naive per-channel RGB match (avoids opponent-color
// crossover like yellow→green) and still bake as standard RGB Curves — no per-pixel rendering.
import { rgbToLab as rgb2lab, labToRgb as lab2rgb } from "./lab";
export function buildLabCorrelationLUT(targetRgba: Uint8Array, sourceRgba: Uint8Array): { r: number[]; g: number[]; b: number[] } {
  // Axis histograms: quantize L to 0..255 (scaled from 0..100), a and b to 0..255 (clamped from −128..127).
  const L_MAX = 100;
  const AB_OFF = 128; // a, b shifted into 0..255 range for histogram buckets
  const AB_MAX = 255;

  const tLHist = new Uint32Array(256);
  const tAHist = new Uint32Array(256);
  const tBHist = new Uint32Array(256);
  const sLHist = new Uint32Array(256);
  const sAHist = new Uint32Array(256);
  const sBHist = new Uint32Array(256);

  const quantL = (L: number) => Math.max(0, Math.min(255, Math.round(L / L_MAX * 255)));
  const quantAB = (v: number) => Math.max(0, Math.min(255, Math.round(v + AB_OFF)));

  let tN = 0, sN = 0;
  for (let i = 0; i < targetRgba.length; i += 4) {
    if (targetRgba[i + 3] === 0) continue;
    const lab = rgb2lab({ r: targetRgba[i] / 255, g: targetRgba[i + 1] / 255, b: targetRgba[i + 2] / 255 });
    tLHist[quantL(lab.L)]++; tAHist[quantAB(lab.a)]++; tBHist[quantAB(lab.b)]++; tN++;
  }
  for (let i = 0; i < sourceRgba.length; i += 4) {
    if (sourceRgba[i + 3] === 0) continue;
    const lab = rgb2lab({ r: sourceRgba[i] / 255, g: sourceRgba[i + 1] / 255, b: sourceRgba[i + 2] / 255 });
    sLHist[quantL(lab.L)]++; sAHist[quantAB(lab.a)]++; sBHist[quantAB(lab.b)]++; sN++;
  }
  if (tN === 0 || sN === 0) {
    const id = Array.from({ length: 256 }, (_, i) => i);
    return { r: id, g: id, b: id };
  }

  // CDF-based LUT for each axis.
  const cdfMatch = (tgtHist: Uint32Array, srcHist: Uint32Array): number[] => {
    const tCDF = new Float64Array(256);
    const sCDF = new Float64Array(256);
    let cT = 0, cS = 0;
    for (let v = 0; v < 256; v++) { cT += tgtHist[v]; cS += srcHist[v]; tCDF[v] = cT / tN; sCDF[v] = cS / sN; }
    const lut = new Array<number>(256);
    let u = 0;
    for (let v = 0; v < 256; v++) {
      const t = tCDF[v];
      while (u < 255 && sCDF[u] < t) u++;
      lut[v] = u;
    }
    return lut;
  };
  const lutL = cdfMatch(tLHist, sLHist);
  const lutA = cdfMatch(tAHist, sAHist);
  const lutB = cdfMatch(tBHist, sBHist);

  // Now pass each target pixel through the Lab transform and accumulate per-channel (input → output) pairs.
  const rSum = new Float64Array(256), rCount = new Uint32Array(256);
  const gSum = new Float64Array(256), gCount = new Uint32Array(256);
  const bSum = new Float64Array(256), bCount = new Uint32Array(256);
  for (let i = 0; i < targetRgba.length; i += 4) {
    if (targetRgba[i + 3] === 0) continue;
    const r = targetRgba[i], g = targetRgba[i + 1], b = targetRgba[i + 2];
    const lab = rgb2lab({ r: r / 255, g: g / 255, b: b / 255 });
    const Lout = lutL[quantL(lab.L)] / 255 * L_MAX;
    const aOut = lutA[quantAB(lab.a)] - AB_OFF;
    const bOut = lutB[quantAB(lab.b)] - AB_OFF;
    const rgbOut = lab2rgb({ L: Lout, a: aOut, b: bOut });
    const ro = Math.max(0, Math.min(255, Math.round(rgbOut.r * 255)));
    const go = Math.max(0, Math.min(255, Math.round(rgbOut.g * 255)));
    const bo = Math.max(0, Math.min(255, Math.round(rgbOut.b * 255)));
    rSum[r] += ro; rCount[r]++;
    gSum[g] += go; gCount[g]++;
    bSum[b] += bo; bCount[b]++;
    void AB_MAX;
  }

  const finalize = (sum: Float64Array, count: Uint32Array): number[] => {
    const lut = new Array<number>(256);
    // Fill bins with data. Identity for empty bins.
    for (let v = 0; v < 256; v++) lut[v] = count[v] > 0 ? Math.round(sum[v] / count[v]) : v;
    // Smooth empty bins between neighbors via linear interp across runs.
    let lastFilled = -1;
    for (let v = 0; v < 256; v++) {
      if (count[v] > 0) {
        if (lastFilled >= 0 && v - lastFilled > 1) {
          for (let k = lastFilled + 1; k < v; k++) {
            const t = (k - lastFilled) / (v - lastFilled);
            lut[k] = Math.round(lut[lastFilled] * (1 - t) + lut[v] * t);
          }
        }
        lastFilled = v;
      }
    }
    return lut;
  };
  return { r: finalize(rSum, rCount), g: finalize(gSum, gCount), b: finalize(bSum, bCount) };
}

// Per-channel histogram match. For each of R, G, B independently, compute the CDF of target
// and source, then map target's channel value to the source intensity at the same CDF. This is
// the gold-standard color transfer technique (see Reinhard et al. follow-ups, OpenCV docs).
// Returns three independent LUTs.
export function buildHistogramMatchLUTPerChannel(targetRgba: Uint8Array, sourceRgba: Uint8Array): { r: number[]; g: number[]; b: number[] } {
  const buildOne = (channelOffset: number): number[] => {
    const tgtHist = new Uint32Array(256);
    const srcHist = new Uint32Array(256);
    let tN = 0, sN = 0;
    for (let i = 0; i < targetRgba.length; i += 4) {
      if (targetRgba[i + 3] === 0) continue;
      tgtHist[targetRgba[i + channelOffset]]++; tN++;
    }
    for (let i = 0; i < sourceRgba.length; i += 4) {
      if (sourceRgba[i + 3] === 0) continue;
      srcHist[sourceRgba[i + channelOffset]]++; sN++;
    }
    if (tN === 0 || sN === 0) return Array.from({ length: 256 }, (_, i) => i);
    const tCDF = new Float64Array(256);
    const sCDF = new Float64Array(256);
    let cT = 0, cS = 0;
    for (let v = 0; v < 256; v++) { cT += tgtHist[v]; cS += srcHist[v]; tCDF[v] = cT / tN; sCDF[v] = cS / sN; }
    const lut = new Array<number>(256);
    let u = 0;
    for (let v = 0; v < 256; v++) {
      const t = tCDF[v];
      while (u < 255 && sCDF[u] < t) u++;
      lut[v] = u;
    }
    return lut;
  };
  return { r: buildOne(0), g: buildOne(1), b: buildOne(2) };
}

// Fade a LUT toward identity by k (0=identity, 1=full match).
export function fadeLUT(lut: number[], k: number): number[] {
  return lut.map((u, v) => Math.round(v * (1 - k) + u * k));
}

// Histogram match: build a 256-entry LUT that, when applied to target's L, produces an output
// distribution whose CDF matches source's CDF — i.e., output's histogram looks like source's
// histogram. This is the canonical histogram-specification algorithm.
export function buildHistogramMatchLUT(targetRgba: Uint8Array, sourceRgba: Uint8Array): number[] {
  const tgtHist = new Uint32Array(256);
  const srcHist = new Uint32Array(256);
  let tgtN = 0, srcN = 0;
  for (let i = 0; i < targetRgba.length; i += 4) {
    if (targetRgba[i + 3] === 0) continue;
    const L = Math.round(0.2126 * targetRgba[i] + 0.7152 * targetRgba[i + 1] + 0.0722 * targetRgba[i + 2]);
    tgtHist[Math.max(0, Math.min(255, L))]++;
    tgtN++;
  }
  for (let i = 0; i < sourceRgba.length; i += 4) {
    if (sourceRgba[i + 3] === 0) continue;
    const L = Math.round(0.2126 * sourceRgba[i] + 0.7152 * sourceRgba[i + 1] + 0.0722 * sourceRgba[i + 2]);
    srcHist[Math.max(0, Math.min(255, L))]++;
    srcN++;
  }
  if (tgtN === 0 || srcN === 0) return Array.from({ length: 256 }, (_, i) => i);

  // Normalized CDFs.
  const tgtCDF = new Float64Array(256);
  const srcCDF = new Float64Array(256);
  let cT = 0, cS = 0;
  for (let v = 0; v < 256; v++) { cT += tgtHist[v]; cS += srcHist[v]; tgtCDF[v] = cT / tgtN; srcCDF[v] = cS / srcN; }

  // For each target value v, find smallest u where srcCDF[u] >= tgtCDF[v]. That u is the matched output.
  const lut = new Array<number>(256);
  let u = 0;
  for (let v = 0; v < 256; v++) {
    const t = tgtCDF[v];
    while (u < 255 && srcCDF[u] < t) u++;
    lut[v] = u;
  }
  return lut;
}

// Subsample the 256-entry LUT down to N anchor points for a Curves layer. PS Curves supports
// up to ~16 anchors comfortably; 17 evenly spaced points capture most of the LUT shape.
export function lutToCurvePoints(lut: number[], anchors = 17): { input: number; output: number }[] {
  const out: { input: number; output: number }[] = [];
  for (let i = 0; i < anchors; i++) {
    const x = Math.round((i / (anchors - 1)) * 255);
    out.push({ input: x, output: Math.max(0, Math.min(255, lut[x])) });
  }
  return out;
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
