// Tests for stochasticBands.ts (Phase 7) — per-L-bucket sample reservoir,
// the hash PRNG, and the per-pixel draw.

import { describe, it, expect } from 'vitest';
import {
  buildStochasticBands,
  sampleBandColor,
  hash2u,
  BAND_RESERVOIR_CAP,
} from './stochasticBands';
import { L_BUCKETS } from './conditionalCdf';
import type { PixelFeatures } from './types';

/** Minimal PixelFeatures — buildStochasticBands reads luma + oklab only. */
function feat(luma: number, a: number, b: number): PixelFeatures {
  return {
    rgb: [0, 0, 0],
    oklab: [luma, a, b],
    oklch: { L: luma, C: Math.hypot(a, b), h: Math.atan2(b, a) },
    luma,
    hueAngle: Math.atan2(b, a),
    chroma: Math.hypot(a, b),
    saturation: 0,
    neutralScore: 0,
    accentScore: 0,
    bandId: 0,
    clusterId: 0,
  };
}

describe('buildStochasticBands', () => {
  it('empty source → all-zero counts', () => {
    const sb = buildStochasticBands([]);
    expect(sb.buckets).toBe(L_BUCKETS);
    let total = 0;
    for (let i = 0; i < sb.counts.length; i++) total += sb.counts[i];
    expect(total).toBe(0);
  });

  it('single-L source (lRange = 0) → empty (degenerate guard)', () => {
    const src = Array.from({ length: 200 }, () => feat(0.5, 0.1, 0.0));
    const sb = buildStochasticBands(src);
    let total = 0;
    for (let i = 0; i < sb.counts.length; i++) total += sb.counts[i];
    expect(total).toBe(0);
  });

  it('a sub-cap bucket retains every pixel', () => {
    // 30 pixels spread across L so each lands in distinct buckets; well
    // under BAND_RESERVOIR_CAP, so all are kept.
    const src = Array.from({ length: 300 }, (_, i) => feat(i / 299, 0.05, 0.05));
    const sb = buildStochasticBands(src);
    let total = 0;
    for (let i = 0; i < sb.counts.length; i++) total += sb.counts[i];
    expect(total).toBe(300);
  });

  it('an over-cap bucket is reservoir-sampled down to the cap', () => {
    // 5000 pixels all in the same narrow L band → one bucket overflows.
    const src = Array.from({ length: 5000 }, (_, i) =>
      feat(0.5 + (i % 7) * 1e-4, 0.1, 0.05));
    const sb = buildStochasticBands(src);
    const max = Math.max(...Array.from(sb.counts));
    expect(max).toBe(BAND_RESERVOIR_CAP);
  });

  it('is deterministic — same features + seed → identical reservoirs', () => {
    const src = Array.from({ length: 6000 }, (_, i) =>
      feat((i % 997) / 996, ((i * 7) % 100) / 500, ((i * 13) % 100) / 500));
    const a = buildStochasticBands(src);
    const b = buildStochasticBands(src);
    for (let k = 0; k < L_BUCKETS; k++) {
      expect(a.counts[k]).toBe(b.counts[k]);
      expect(Array.from(a.samples[k])).toEqual(Array.from(b.samples[k]));
    }
  });
});

describe('hash2u', () => {
  it('same (x,y,seed) → identical uniform', () => {
    expect(hash2u(12, 34, 99)).toBe(hash2u(12, 34, 99));
  });

  it('different seed → decorrelated field (low correlation over a grid)', () => {
    let same = 0;
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        if (Math.abs(hash2u(x, y, 1) - hash2u(x, y, 2)) < 1e-6) same++;
      }
    }
    expect(same).toBeLessThan(8); // essentially no collisions
  });

  it('output is in [0, 1)', () => {
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        const u = hash2u(x, y, 7);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
    }
  });
});

describe('sampleBandColor', () => {
  it('returns a real (a,b) pair from the routed bucket', () => {
    const src = Array.from({ length: 2000 }, (_, i) => feat(i / 1999, 0.12, -0.04));
    const sb = buildStochasticBands(src);
    const drawn = sampleBandColor(sb, 0.5, 0.42);
    expect(drawn).not.toBeNull();
    expect(Number.isFinite(drawn!.a)).toBe(true);
    expect(Number.isFinite(drawn!.b)).toBe(true);
  });

  it('returns null when the bands are empty', () => {
    expect(sampleBandColor(buildStochasticBands([]), 0.5, 0.3)).toBeNull();
  });

  it('different u draws can yield different samples', () => {
    // A bucket with varied (a,b) so distinct u's index distinct pairs.
    const src = Array.from({ length: 2000 }, (_, i) =>
      feat(0.45 + (i % 30) * 0.003, (i % 50) / 200, ((i * 3) % 50) / 200));
    const sb = buildStochasticBands(src);
    const d1 = sampleBandColor(sb, 0.5, 0.05)!;
    const d2 = sampleBandColor(sb, 0.5, 0.95)!;
    expect(d1.a !== d2.a || d1.b !== d2.b).toBe(true);
  });
});
