// Per-pixel Oklab feature extraction for the Smash Engine.
// Converts sRGB samples to OkLCh and derives perceptual scores (neutral, accent)
// used by band construction and cluster analysis downstream.

import type { PixelFeatures } from './types';
import { srgbByteToOklab } from '../perceptual/oklab';

/**
 * Extract per-pixel Oklab feature vectors from RGBA pixel data.
 * Pixels with alpha < 128 (transparent) are skipped.
 * sampleStride controls decimation: stride=4 yields ~16k features on a 256²
 * image, keeping extraction under 100ms at preview resolution.
 */
export function extractFeatures(
  rgba: Uint8Array,
  width: number,
  height: number,
  sampleStride = 4,
): PixelFeatures[] {
  const total = width * height;
  if (total === 0) return [];

  const out: PixelFeatures[] = [];

  for (let i = 0; i < total; i += sampleStride) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;

    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];

    const [L, a, bk] = srgbByteToOklab(r, g, b);

    const C = Math.sqrt(a * a + bk * bk);
    const h = Math.atan2(bk, a);

    // saturation: chroma normalized by lightness, clamped to [0, 2].
    const saturation = Math.min(2, C / Math.max(L, 1e-6));

    // neutralScore: near-zero chroma → 1.0; saturated → 0.
    const neutralScore = 1 - Math.min(1, Math.max(0, C / 0.15));

    // accentScore: below C=0.10 → 0; above C=0.25 → 1.
    const accentScore = Math.min(1, Math.max(0, (C - 0.10) / 0.15));

    out.push({
      rgb: [r, g, b],
      oklab: [L, a, bk],
      oklch: { L, C, h },
      luma: L,
      hueAngle: h,
      chroma: C,
      saturation,
      neutralScore,
      accentScore,
      bandId: -1,
      clusterId: -1,
    });
  }

  return out;
}
