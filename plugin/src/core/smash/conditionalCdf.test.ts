// Tests for buildConditionalCdf() in conditionalCdf.ts (Phase 5).
// Builds PixelFeatures directly — the builder only reads luma / chroma /
// hueAngle, so the other fields get harmless placeholder values.

import { describe, it, expect } from 'vitest';
import { buildConditionalCdf, L_BUCKETS, SUB_CDF_BINS } from './conditionalCdf';
import { lookupCdfMatch } from './cdfMatch';
import type { PixelFeatures } from './types';

const VIABILITY = 16;
const HUE_FILTER = 0.02;

/** Minimal PixelFeatures with the three fields the builder reads; the rest
 *  are placeholders. */
function feat(luma: number, chroma: number, hueAngle: number): PixelFeatures {
  return {
    rgb: [0, 0, 0],
    oklab: [luma, 0, 0],
    oklch: { L: luma, C: chroma, h: hueAngle },
    luma,
    hueAngle,
    chroma,
    saturation: 0,
    neutralScore: 0,
    accentScore: 0,
    bandId: 0,
    clusterId: 0,
  };
}

describe('buildConditionalCdf — degenerate inputs', () => {
  it('empty input → all-null buckets, default L range, zeroed sampleCounts', () => {
    const cc = buildConditionalCdf([], [], VIABILITY, HUE_FILTER);
    expect(cc.buckets).toBe(L_BUCKETS);
    expect(cc.lMin).toBe(0);
    expect(cc.lMax).toBe(1);
    expect(cc.chroma.length).toBe(L_BUCKETS);
    expect(cc.hue.length).toBe(L_BUCKETS);
    expect(cc.chroma.every((x) => x === null)).toBe(true);
    expect(cc.hue.every((x) => x === null)).toBe(true);
    let sum = 0;
    for (let i = 0; i < cc.sampleCounts.length; i++) sum += cc.sampleCounts[i];
    expect(sum).toBe(0);
  });

  it('degenerate single-L source (lMax === lMin) → all-null buckets', () => {
    const src = Array.from({ length: 200 }, () => feat(0.5, 0.1, 0.3));
    const tgt = Array.from({ length: 200 }, (_, i) => feat(i / 199, 0.1, 0.3));
    const cc = buildConditionalCdf(src, tgt, VIABILITY, HUE_FILTER);
    expect(cc.chroma.every((x) => x === null)).toBe(true);
    expect(cc.hue.every((x) => x === null)).toBe(true);
  });
});

describe('buildConditionalCdf — bucket partitioning', () => {
  it('L→chroma gradient source: low buckets map to low chroma, high to high', () => {
    // Source: luma ramps 0→1, chroma proportional to luma (0 → 0.2).
    const src = Array.from({ length: 1200 }, (_, i) => {
      const l = i / 1199;
      return feat(l, l * 0.2, 0.5);
    });
    // Target: luma ramps 0→1, uniform mid chroma so every bucket is viable.
    const tgt = Array.from({ length: 1200 }, (_, i) => feat(i / 1199, 0.1, 0.5));

    const cc = buildConditionalCdf(src, tgt, VIABILITY, HUE_FILTER);
    // All buckets should be viable (1200/12 = 100 samples each side).
    expect(cc.chroma.every((x) => x !== null)).toBe(true);

    const lowLut = cc.chroma[0]!;
    const highLut = cc.chroma[L_BUCKETS - 1]!;
    expect(lowLut.bins).toBe(SUB_CDF_BINS);
    // A mid-chroma probe maps to a small value in the dark bucket and a
    // large value in the bright bucket — the per-L conditioning at work.
    const lowOut = lookupCdfMatch(lowLut, 0.1);
    const highOut = lookupCdfMatch(highLut, 0.1);
    expect(lowOut).toBeLessThan(highOut);
    expect(lowOut).toBeLessThan(0.06);
    expect(highOut).toBeGreaterThan(0.14);
  });

  it('sampleCounts sums to the source feature count', () => {
    const src = Array.from({ length: 743 }, (_, i) => feat(i / 742, 0.1, 0.2));
    const tgt = Array.from({ length: 743 }, (_, i) => feat(i / 742, 0.1, 0.2));
    const cc = buildConditionalCdf(src, tgt, VIABILITY, HUE_FILTER);
    let sum = 0;
    for (let i = 0; i < cc.sampleCounts.length; i++) sum += cc.sampleCounts[i];
    expect(sum).toBe(743);
  });
});

describe('buildConditionalCdf — sparse fallback', () => {
  it('buckets thin on the target side are null; populated buckets are non-null', () => {
    // Source spans the full L range; target is squeezed into the low half,
    // so high-L buckets get zero target samples → null.
    const src = Array.from({ length: 1200 }, (_, i) => feat(i / 1199, 0.1, 0.4));
    const tgt = Array.from({ length: 1200 }, (_, i) => feat((i / 1199) * 0.4, 0.1, 0.4));
    const cc = buildConditionalCdf(src, tgt, VIABILITY, HUE_FILTER);
    // Lowest bucket is well-populated on both sides.
    expect(cc.chroma[0]).not.toBeNull();
    // Highest bucket has no target samples → sparse → null.
    expect(cc.chroma[L_BUCKETS - 1]).toBeNull();
  });

  it('near-neutral bucket (chroma < hueFilter) produces a null hue sub-CDF', () => {
    // Every pixel is below the hue chroma filter, so no hue samples survive
    // even though the chroma sub-CDFs are viable.
    const src = Array.from({ length: 600 }, (_, i) => feat(i / 599, 0.005, 0.3));
    const tgt = Array.from({ length: 600 }, (_, i) => feat(i / 599, 0.005, 0.3));
    const cc = buildConditionalCdf(src, tgt, VIABILITY, HUE_FILTER);
    expect(cc.chroma.some((x) => x !== null)).toBe(true);
    expect(cc.hue.every((x) => x === null)).toBe(true);
  });
});
