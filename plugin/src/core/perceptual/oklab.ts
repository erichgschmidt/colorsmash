// Oklab and OkLCh color space conversions (Ottosson 2020).
// Preferred over CIE Lab for new Pro-tier math: more perceptually uniform and
// cheaper — no XYZ intermediate, no per-axis white-point normalization.
// sRGB transfer function sourced from core/color (IEC 61966-2-1) — same
// implementation used by palette.ts and histogramMatch.ts.
import { srgbToLinear, linearToSrgbByte } from '../color';

export type Vec3 = readonly [number, number, number];

// Cube root that preserves sign for negative LMS values, per Ottosson spec.
function cbrtSigned(x: number): number {
  return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3);
}

// ────────── sRGB byte → Oklab ──────────

/** Converts sRGB bytes (0..255) to Oklab. L is roughly 0..1; a, b roughly -0.4..+0.4. */
export function srgbByteToOklab(r: number, g: number, b: number): Vec3 {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  // M1: linear sRGB → LMS
  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

  // Cube-root (signed to handle any negative LMS from out-of-gamut values)
  const lp = cbrtSigned(l);
  const mp = cbrtSigned(m);
  const sp = cbrtSigned(s);

  // M2: LMS' → Oklab
  const L =  0.2104542553 * lp + 0.7936177850 * mp - 0.0040720468 * sp;
  const a =  1.9779984951 * lp - 2.4285922050 * mp + 0.4505937099 * sp;
  const ob = 0.0259040371 * lp + 0.7827717662 * mp - 0.8086757660 * sp;

  return [L, a, ob];
}

// ────────── Oklab → sRGB byte ──────────

/** Converts Oklab to sRGB bytes (0..255), clamped and rounded. */
export function oklabToSrgbByte(L: number, a: number, b: number): Vec3 {
  // Inverse M2: Oklab → LMS'
  const lp = L + 0.3963377774 * a + 0.2158037573 * b;
  const mp = L - 0.1055613458 * a - 0.0638541728 * b;
  const sp = L - 0.0894841775 * a - 1.2914855480 * b;

  // Cube (undo cube root, sign-aware for robustness)
  const l = lp * lp * lp;
  const m = mp * mp * mp;
  const s = sp * sp * sp;

  // Inverse M1: LMS → linear sRGB
  const rl =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [linearToSrgbByte(rl), linearToSrgbByte(gl), linearToSrgbByte(bl)];
}

// ────────── OkLCh (polar Oklab) ──────────

/** Converts Oklab to OkLCh. h is in radians, Math.atan2 convention: [-π, π). */
export function oklabToOklch(L: number, a: number, b: number): { L: number; C: number; h: number } {
  return { L, C: Math.sqrt(a * a + b * b), h: Math.atan2(b, a) };
}

/** Converts OkLCh back to Oklab. h in radians. */
export function oklchToOklab(L: number, C: number, h: number): Vec3 {
  return [L, C * Math.cos(h), C * Math.sin(h)];
}
