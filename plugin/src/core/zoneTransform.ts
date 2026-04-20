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
  value: number;          // -100..100  (composite Curves output offset at zone midpoint)
  colorR: number;         // 0..255 — target color for the per-channel shift
  colorG: number;
  colorB: number;
  colorIntensity: number; // 0..100 — how strongly to push channels toward the target
  rangeStart: number;     // 0..100 (full-effect start)
  rangeEnd: number;       // 0..100 (full-effect end)
  featherLeft: number;    // 0..100
  featherRight: number;   // 0..100
}

export interface ZonesState {
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

export function valueCurve(z: ZoneState) {
  return shiftCurvePoints((z.rangeStart + z.rangeEnd) / 2, Math.round(z.value));
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

// ─── One zone's full transform ──────────────────────────────────────────────
function applyZone(input: { r: number; g: number; b: number }, z: ZoneState, w: number) {
  if (w === 0) return input;

  let r = input.r, g = input.g, b = input.b;

  // 1) Value (composite Curves).
  if (z.value !== 0) {
    const c = valueCurve(z);
    r = applyCurve(r * 255, c) / 255;
    g = applyCurve(g * 255, c) / 255;
    b = applyCurve(b * 255, c) / 255;
  }

  // 2) Color shift (per-channel Curves).
  if (z.colorIntensity > 0) {
    const cc = colorShiftCurves(z);
    r = applyCurve(r * 255, cc.r) / 255;
    g = applyCurve(g * 255, cc.g) / 255;
    b = applyCurve(b * 255, cc.b) / 255;
  }

  // 3) Hue/Sat (HSL space).
  if (z.hue !== 0 || z.sat !== 0) {
    const hsl = rgbToHsl(r, g, b);
    hsl.h = (hsl.h + z.hue / 360) % 1;
    if (hsl.h < 0) hsl.h += 1;
    hsl.s = clamp01(hsl.s * (1 + z.sat / 100));
    const out = hslToRgb(hsl.h, hsl.s, hsl.l);
    r = out.r; g = out.g; b = out.b;
  }

  // Blend by zone weight.
  return {
    r: input.r * (1 - w) + r * w,
    g: input.g * (1 - w) + g * w,
    b: input.b * (1 - w) + b * w,
  };
}

export function applyZones(rgba: Uint8Array, zones: ZonesState): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    let pixel = { r: rgba[i] / 255, g: rgba[i + 1] / 255, b: rgba[i + 2] / 255 };
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
