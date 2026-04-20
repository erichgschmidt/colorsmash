// Per-zone tonal-range color transform. Pure TS, used for both live preview and bake math.
// The simulator mirrors the actual PS layer stack the bake produces, so preview matches output:
//   1. Lift  → Curves (composite, applied per RGB channel)
//   2. Hue/Sat → HSL space
//   3. Tint → Color blend mode (take H+S of tint, keep base L)
// All weighted by the zone's trapezoidal tonal mask, then blended back into the input.

export interface ZoneState {
  hue: number;
  sat: number;
  lift: number;
  tintR: number; tintG: number; tintB: number;
  tintAmount: number;
  rangeStart: number; rangeEnd: number;
  featherLeft: number; featherRight: number;
}

export interface ZonesState {
  shadows: ZoneState;
  midtones: ZoneState;
  highlights: ZoneState;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
const clamp255 = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v;

// ─── HSL helpers ─────────────────────────────────────────────────────────────
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

// ─── Lift: Curves (composite) — must match bakeZones exactly ──────
// Anchored at (0,0) and (255,255) so the curve only bumps near the zone midpoint.
// Combined with Blend If gating, lift stays inside the zone instead of bleeding outward.
export function liftCurvePoints(z: ZoneState) {
  const mid = Math.round(((z.rangeStart + z.rangeEnd) / 2) * 2.55);
  const shift = Math.round((z.lift / 100) * 100);
  return [
    { input: 0,   output: 0 },
    { input: mid, output: clamp255(mid + shift) },
    { input: 255, output: 255 },
  ];
}

function applyCurve(input: number, points: { input: number; output: number }[]): number {
  // Piecewise linear interp. PS's Curves spline differs but doesn't overshoot like a free-tangent
  // cubic does on sparse anchor points; linear is a closer fit on average.
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

// ─── One zone's full transform: simulates Curves → HueSat → ColorBlend, weighted ─
function applyZone(input: { r: number; g: number; b: number }, z: ZoneState, w: number) {
  if (w === 0) return input;

  // 1) Lift via Curves (composite, applied to each channel independently in 0..255 space).
  let r = input.r, g = input.g, b = input.b;
  if (z.lift !== 0) {
    const curve = liftCurvePoints(z);
    r = applyCurve(r * 255, curve) / 255;
    g = applyCurve(g * 255, curve) / 255;
    b = applyCurve(b * 255, curve) / 255;
  }

  // 2) Hue/Sat (master), HSL space.
  if (z.hue !== 0 || z.sat !== 0) {
    const hsl = rgbToHsl(r, g, b);
    hsl.h = (hsl.h + z.hue / 360) % 1;
    if (hsl.h < 0) hsl.h += 1;
    hsl.s = clamp01(hsl.s * (1 + z.sat / 100));
    const out = hslToRgb(hsl.h, hsl.s, hsl.l);
    r = out.r; g = out.g; b = out.b;
  }

  // 3) Tint via Color blend mode formula: take H+S of tint, keep base L.
  // Mixed by tintAmount opacity.
  if (z.tintAmount > 0) {
    const baseHsl = rgbToHsl(r, g, b);
    const tintHsl = rgbToHsl(z.tintR / 255, z.tintG / 255, z.tintB / 255);
    const colored = hslToRgb(tintHsl.h, tintHsl.s, baseHsl.l);
    const k = z.tintAmount / 100;
    r = r * (1 - k) + colored.r * k;
    g = g * (1 - k) + colored.g * k;
    b = b * (1 - k) + colored.b * k;
  }

  // Blend the zone's effect by its tonal weight.
  return {
    r: input.r * (1 - w) + r * w,
    g: input.g * (1 - w) + g * w,
    b: input.b * (1 - w) + b * w,
  };
}

export function applyZones(rgba: Uint8Array, zones: ZonesState): Uint8Array {
  const out = new Uint8Array(rgba.length);
  // Apply in stack order (bottom→top): shadows first, then midtones, then highlights.
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
