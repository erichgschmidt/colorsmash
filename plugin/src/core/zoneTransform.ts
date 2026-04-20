// Per-zone tonal-range color transform. Pure TS, used for both live preview and bake math.
// Each zone has a Blend-If-style trapezoidal weight along underlying luma, plus hue/sat/lift adjustments
// applied in HSL space.

export interface ZoneState {
  hue: number;          // -180..180
  sat: number;          // -100..100
  lift: number;         // -100..100  (output offset at the zone's L midpoint, scaled to ±0.4)
  tintR: number;        // 0..255 — RGB tint applied within zone, mixed by tintAmount
  tintG: number;
  tintB: number;
  tintAmount: number;   // 0..100 — how much of the tint color to mix in
  rangeStart: number;   // 0..100 (full-effect start, in % luma)
  rangeEnd: number;     // 0..100 (full-effect end)
  featherLeft: number;  // 0..100 (transition width on the low side)
  featherRight: number; // 0..100 (transition width on the high side)
}

export interface ZonesState {
  shadows: ZoneState;
  midtones: ZoneState;
  highlights: ZoneState;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

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

// Trapezoidal weight: 0 outside [a-fL, b+fR], 1 inside [a, b], linear ramp on each edge.
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

function applyZone(input: { r: number; g: number; b: number }, z: ZoneState, w: number) {
  if (w === 0) return input;
  const hsl = rgbToHsl(input.r, input.g, input.b);
  hsl.h = (hsl.h + (z.hue / 360) * w) % 1;
  if (hsl.h < 0) hsl.h += 1;
  hsl.s = clamp01(hsl.s * (1 + (z.sat / 100) * w));
  hsl.l = clamp01(hsl.l + (z.lift / 100) * 0.4 * w);
  let out = hslToRgb(hsl.h, hsl.s, hsl.l);
  // Tint: mix toward the picked color by tintAmount * weight, preserving original luma so the
  // tint colors a pixel without dragging it lighter/darker.
  if (z.tintAmount > 0) {
    const tA = (z.tintAmount / 100) * w;
    const tR = z.tintR / 255, tG = z.tintG / 255, tB = z.tintB / 255;
    const Lo = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
    const Lt = 0.2126 * tR  + 0.7152 * tG  + 0.0722 * tB;
    const k = Lt > 1e-6 ? Lo / Lt : 1; // scale tint to match luma
    out = {
      r: clamp01(out.r * (1 - tA) + tR * k * tA),
      g: clamp01(out.g * (1 - tA) + tG * k * tA),
      b: clamp01(out.b * (1 - tA) + tB * k * tA),
    };
  }
  return {
    r: input.r * (1 - w) + out.r * w,
    g: input.g * (1 - w) + out.g * w,
    b: input.b * (1 - w) + out.b * w,
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
