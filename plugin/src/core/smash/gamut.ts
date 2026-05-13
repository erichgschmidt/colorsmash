// ACES Gamut Compression Operator for Pro Smash LUT generation.
// Softly maps out-of-gamut pixel values back toward the sRGB boundary along
// lines of constant hue, preventing the hard-clipping artifacts that raw LUT
// output would otherwise produce. Reference: ACES / OCIO 2.x implementation.

import type { Vec3 } from './types';

// ────────── ACES defaults ──────────

/** ACES default per-channel thresholds (cyan, magenta, yellow distances). */
export const ACES_DEFAULT_THRESHOLD: Vec3 = [0.815, 0.803, 0.880];

/** ACES default per-channel limits: the input distance that maps to output 1.0. */
export const ACES_DEFAULT_LIMIT: Vec3 = [1.147, 1.264, 1.312];

/** ACES default knee power — controls transition softness above the threshold. */
export const ACES_DEFAULT_POWER = 1.2;

// ────────── per-channel compression function ──────────

/**
 * Applies the ACES saturating compression to a single channel distance.
 *
 * Below threshold `t` the value is returned unchanged. Above it, the OCIO
 * reference form is used: the normalized excess is folded through a power
 * saturator that asymptotes to 1 as `d` → Infinity, so the result always
 * stays in [t, l] with no division-by-zero risk.
 *
 * @param d - distance from the achromatic axis for one channel
 * @param t - threshold below which no compression is applied
 * @param l - input distance that maps to compressed output of 1.0
 * @param p - knee power (higher = harder knee)
 */
function compress(d: number, t: number, l: number, p: number): number {
  if (d < t) return d;
  const cd = (d - t) / (l - t);
  const compressedCd = cd / Math.pow(1 + Math.pow(cd, p), 1 / p);
  return t + compressedCd * (l - t);
}

// ────────── linear interpolation helper ──────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ────────── public API ──────────

/**
 * ACES Gamut Compression with linear strength blend.
 *
 * Operates on linear-light floats where [0, 1] is the sRGB gamut boundary.
 * Values above 1 represent out-of-gamut content produced by LUT processing.
 * The algorithm compresses each channel toward the achromatic axis (constant
 * hue) rather than clipping, preserving perceived color relationships.
 *
 * @param rgb     floats in [0..1] nominally; values above 1 are out-of-gamut
 * @param strength 0 = pass-through, 1 = full ACES compression. Default 1.
 * @returns       RGB floats with out-of-gamut content softly pulled back in
 */
export function acesGamutCompress(rgb: Vec3, strength = 1): Vec3 {
  const [r, g, b] = rgb;

  // Achromatic axis value — the maximum channel determines the neutral anchor.
  const ach = Math.max(r, g, b);
  if (ach === 0) return [0, 0, 0];

  // Per-channel distances from the achromatic axis. In-gamut: [0, 1].
  // Out-of-gamut: can exceed 1.  The ACES convention maps cyan to the R
  // channel's complement, magenta to G, yellow to B.
  const distR = (ach - r) / ach;
  const distG = (ach - g) / ach;
  const distB = (ach - b) / ach;

  const [t0, t1, t2] = ACES_DEFAULT_THRESHOLD;
  const [l0, l1, l2] = ACES_DEFAULT_LIMIT;
  const p = ACES_DEFAULT_POWER;

  const cdR = compress(distR, t0, l0, p);
  const cdG = compress(distG, t1, l1, p);
  const cdB = compress(distB, t2, l2, p);

  // Reconstruct RGB from achromatic value and compressed distances.
  const outR = ach - cdR * ach;
  const outG = ach - cdG * ach;
  const outB = ach - cdB * ach;

  // Blend between identity and full compression according to strength.
  return [
    lerp(r, outR, strength),
    lerp(g, outG, strength),
    lerp(b, outB, strength),
  ];
}

/**
 * ACES Gamut Compression applied in-place to an RGBA byte buffer.
 *
 * Alpha channels are preserved exactly. RGB bytes are dequantized to [0, 1]
 * floats for the compression math then re-quantized with round + clamp to
 * [0, 255]. The same strength blend as `acesGamutCompress` applies.
 *
 * @param rgba     RGBA interleaved byte buffer, mutated in-place
 * @param strength 0 = pass-through, 1 = full ACES compression. Default 1.
 */
export function acesGamutCompressRgba(rgba: Uint8Array, strength = 1): void {
  const len = rgba.length;
  for (let i = 0; i < len; i += 4) {
    const r = rgba[i] / 255;
    const g = rgba[i + 1] / 255;
    const b = rgba[i + 2] / 255;

    const [cr, cg, cb] = acesGamutCompress([r, g, b], strength);

    rgba[i]     = Math.max(0, Math.min(255, Math.round(cr * 255)));
    rgba[i + 1] = Math.max(0, Math.min(255, Math.round(cg * 255)));
    rgba[i + 2] = Math.max(0, Math.min(255, Math.round(cb * 255)));
    // rgba[i + 3] alpha — preserved unchanged
  }
}
