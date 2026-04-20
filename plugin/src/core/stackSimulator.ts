// Pure-TS simulator of the adjustment-layer stack. Given input RGB + params, returns the
// approximate RGB that PS would produce. Used by the fitter to score candidate param sets.
//
// Modeled layers (must match the stack order in applyAsStack.ts):
//   1. Hue/Saturation (master sat scale, applied first)
//   2. Color Balance (shadows/mids/highlights cast)
//   3. Selective Color (skipped in simulation — only fine-tuning)
//   4. Curves master (luminance, applied last)

import type { StackParams } from "./reinhardToStack";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ── Curves: piecewise linear interpolation between control points (PS uses spline; close enough). ──
function applyCurve(input: number, points: { input: number; output: number }[]): number {
  // input/output here are 0..255.
  if (points.length === 0) return input;
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

// ── Hue/Sat master saturation (HSL space). ──
function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = ((b - r) / d + 2);
    else h = ((r - g) / d + 4);
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) return { r: l, g: l, b: l };
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1/3), g: hue2rgb(p, q, h), b: hue2rgb(p, q, h - 1/3) };
}
function applyHueSat(rgb: { r: number; g: number; b: number }, satPct: number) {
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  hsl.s = clamp01(hsl.s * (1 + satPct / 100));
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

// ── Color Balance per zone. ──
// Empirical model derived from PS measurements at slider=+50, sampled at L=0,64,128,192,255.
// The observed shifts: zone-specific tonal envelope, single-axis (no cross-channel mixing),
// approximately linear in slider value within ±100 range.
//
// Table entries: shift in 0..255 RGB units when slider=+50 for the matching axis.
// Channel mapping is one-to-one: cyanRed→R, magentaGreen→G, yellowBlue→B.
const CB_PROFILE_AT_50: Record<"shadows" | "midtones" | "highlights", number[]> = {
  // Indexed at L = 0, 64, 128, 192, 255
  shadows:    [0, 16, 15,  0,  0],
  midtones:   [0, 32, 28, 17,  0],
  highlights: [0,  0, 43, 43,  0],
};
const CB_PROFILE_L = [0, 64, 128, 192, 255];

function interpProfile(profile: number[], L255: number): number {
  // L255 in 0..255. Linear interp across the 5 keypoints.
  if (L255 <= CB_PROFILE_L[0]) return profile[0];
  if (L255 >= CB_PROFILE_L[CB_PROFILE_L.length - 1]) return profile[profile.length - 1];
  for (let i = 0; i < CB_PROFILE_L.length - 1; i++) {
    if (L255 >= CB_PROFILE_L[i] && L255 <= CB_PROFILE_L[i + 1]) {
      const t = (L255 - CB_PROFILE_L[i]) / (CB_PROFILE_L[i + 1] - CB_PROFILE_L[i]);
      return profile[i] + t * (profile[i + 1] - profile[i]);
    }
  }
  return 0;
}

function applyColorBalance(rgb: { r: number; g: number; b: number }, cb: StackParams["colorBalance"]) {
  // Tonal zone selection uses Rec. 709 luma. PS likely uses something similar.
  const L255 = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) * 255;

  // For each zone × axis: shift = (slider / 50) * profile_at_L  (linear in slider).
  const shiftForAxis = (axisKey: "cyanRed" | "magentaGreen" | "yellowBlue") => {
    let total = 0;
    total += (cb.shadows[axisKey]    / 50) * interpProfile(CB_PROFILE_AT_50.shadows,    L255);
    total += (cb.midtones[axisKey]   / 50) * interpProfile(CB_PROFILE_AT_50.midtones,   L255);
    total += (cb.highlights[axisKey] / 50) * interpProfile(CB_PROFILE_AT_50.highlights, L255);
    return total / 255; // back to 0..1 RGB
  };

  return {
    r: clamp01(rgb.r + shiftForAxis("cyanRed")),
    g: clamp01(rgb.g + shiftForAxis("magentaGreen")),
    b: clamp01(rgb.b + shiftForAxis("yellowBlue")),
  };
}

export function simulateStack(input: { r: number; g: number; b: number }, p: StackParams): { r: number; g: number; b: number } {
  // Apply bottom-to-top (matches PS render order).
  let rgb = applyHueSat(input, p.hueSat.saturation);
  rgb = applyColorBalance(rgb, p.colorBalance);
  // Selective Color skipped in simulation (small fine-tune; including it would need a full impl).
  // Apply master Curves (composite).
  const r = applyCurve(rgb.r * 255, p.curvesMaster) / 255;
  const g = applyCurve(rgb.g * 255, p.curvesMaster) / 255;
  const b = applyCurve(rgb.b * 255, p.curvesMaster) / 255;
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
}
