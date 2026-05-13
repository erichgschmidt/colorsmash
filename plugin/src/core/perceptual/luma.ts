// Perceptual luma via Oklab L. Oklab's L is more uniform than sRGB luminance or
// CIE Lab L* — equal steps in L correspond more closely to equal perceived lightness
// differences. Used as the input signal for adaptive band-edge detection.

import { srgbByteToOklab } from "./oklab";

// Full srgbByteToOklab is called and L returned. A luma-only fast path could skip
// the a/b rows of M2 (saves 4 multiplies and 2 adds), but the bottleneck is the
// two Math.pow calls in srgbToLinear — skipping M2's a/b rows has negligible
// impact in practice. Keeping the full call avoids duplicated transform logic.

/** Returns Oklab L for an sRGB byte triple. Range roughly 0..1. */
export function perceptualLuma(r: number, g: number, b: number): number {
  return srgbByteToOklab(r, g, b)[0];
}
