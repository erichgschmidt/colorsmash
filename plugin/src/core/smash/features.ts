// Per-pixel Oklab feature extraction for the Smash Engine.
// Converts sRGB samples to OkLCh and derives perceptual scores (neutral, accent)
// used by band construction and cluster analysis downstream.

import type { PixelFeatures } from './types';

// ── Inline Oklab conversion ──────────────────────────────────────────────────
// TODO: replace with import from 'core/perceptual/oklab' once that module lands.
// Math source: Ottosson 2020 — https://bottosson.github.io/posts/oklab/
// srgbToLinear matches palette.ts exactly (IEC 61966-2-1 transfer function).

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToOklab(r: number, g: number, b: number): readonly [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);

  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;

  // Cube root with sign preservation (sign(x)*|x|^(1/3)).
  const lp = l >= 0 ? Math.cbrt(l) : -Math.cbrt(-l);
  const mp = m >= 0 ? Math.cbrt(m) : -Math.cbrt(-m);
  const sp = s >= 0 ? Math.cbrt(s) : -Math.cbrt(-s);

  const L = 0.2104542553 * lp + 0.7936177850 * mp - 0.0040720468 * sp;
  const a = 1.9779984951 * lp - 2.4285922050 * mp + 0.4505937099 * sp;
  const bk = 0.0259040371 * lp + 0.7827717662 * mp - 0.8086757660 * sp;

  return [L, a, bk];
}

// ── Public API ───────────────────────────────────────────────────────────────

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

    const [L, a, bk] = rgbToOklab(r, g, b);

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
