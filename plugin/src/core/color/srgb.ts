// sRGB transfer function helpers (IEC 61966-2-1), byte-domain.
// Canonical source for all sRGB linearization in this codebase — palette.ts,
// histogramMatch.ts, and core/perceptual/oklab.ts all import from here.

/** sRGB byte (0..255) to linear-light value (0..1). */
export function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Linear-light value (0..1) to sRGB byte (0..255), clamped + rounded. */
export function linearToSrgbByte(c: number): number {
  const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
