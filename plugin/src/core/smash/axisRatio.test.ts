// Tests for axisRatio.ts (Phase 6) — source-axis ratio reweighting.

import { describe, it, expect } from 'vitest';
import {
  isNeutralRatio,
  naturalBandWeights,
  reweightSourceByBands,
} from './axisRatio';

/** Sorted Float32Array of `n` values evenly spanning [0, 1]. */
function evenSorted(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i / (n - 1);
  return a;
}

describe('isNeutralRatio', () => {
  it('undefined multipliers → neutral', () => {
    expect(isNeutralRatio(undefined, 5)).toBe(true);
  });
  it('length mismatch → neutral (stale array must not corrupt)', () => {
    expect(isNeutralRatio([1, 1, 1], 5)).toBe(true);
  });
  it('all-1 array → neutral', () => {
    expect(isNeutralRatio([1, 1, 1, 1, 1], 5)).toBe(true);
  });
  it('any band off 1 → not neutral', () => {
    expect(isNeutralRatio([1, 1, 2, 1, 1], 5)).toBe(false);
    expect(isNeutralRatio([0, 1, 1, 1, 1], 5)).toBe(false);
  });
  it('a non-finite entry → not neutral', () => {
    expect(isNeutralRatio([1, 1, NaN, 1, 1], 5)).toBe(false);
  });
});

describe('naturalBandWeights', () => {
  it('empty input → uniform weights summing to 1', () => {
    const w = naturalBandWeights(new Float32Array(0), 5);
    expect(w.length).toBe(5);
    let sum = 0;
    for (const x of w) { sum += x; expect(x).toBeCloseTo(0.2, 6); }
    expect(sum).toBeCloseTo(1, 6);
  });

  it('evenly-spread source → roughly uniform band weights, sum 1', () => {
    const w = naturalBandWeights(evenSorted(1000), 5);
    expect(w.length).toBe(5);
    let sum = 0;
    for (const x of w) {
      sum += x;
      expect(x).toBeGreaterThan(0.15);
      expect(x).toBeLessThan(0.25);
    }
    expect(sum).toBeCloseTo(1, 5);
  });

  it('shadow-heavy source → band 0 weight dominates', () => {
    // 800 dark values in [0, 0.2), 200 spread across [0.2, 1].
    const vals: number[] = [];
    for (let i = 0; i < 800; i++) vals.push((i / 799) * 0.19);
    for (let i = 0; i < 200; i++) vals.push(0.2 + (i / 199) * 0.8);
    const w = naturalBandWeights(Float32Array.from(vals), 5);
    expect(w[0]).toBeGreaterThan(0.7);
    expect(w[0]).toBeGreaterThan(w[4]);
  });
});

describe('reweightSourceByBands', () => {
  it('neutral multipliers → returns an unchanged copy', () => {
    const src = evenSorted(500);
    const out = reweightSourceByBands(src, 5, [1, 1, 1, 1, 1]);
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i], 6);
  });

  it('empty input → empty output', () => {
    expect(reweightSourceByBands(new Float32Array(0), 5, [2, 1, 1, 1, 1]).length).toBe(0);
  });

  it('all-zero multipliers → returns an unchanged copy (degenerate, no-op)', () => {
    const src = evenSorted(300);
    const out = reweightSourceByBands(src, 5, [0, 0, 0, 0, 0]);
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i], 6);
  });

  it('zeroing band 0 removes that L range from the output', () => {
    const out = reweightSourceByBands(evenSorted(1000), 5, [0, 1, 1, 1, 1]);
    // Band 0 spans [0, 0.2); with weight 0 the output should start at ~0.2.
    expect(out[0]).toBeGreaterThanOrEqual(0.19);
    expect(out.length).toBeGreaterThan(0);
  });

  it('boosting band 0 increases its share of the output distribution', () => {
    const src = evenSorted(1000);
    const neutral = reweightSourceByBands(src, 5, [1, 1, 1, 1, 1]);
    const boosted = reweightSourceByBands(src, 5, [4, 1, 1, 1, 1]);
    const countBelow = (a: Float32Array, t: number) => {
      let c = 0;
      for (const v of a) if (v < t) c++;
      return c;
    };
    // Band 0 = [0, 0.2). Neutral ≈ 200/1000; boosted should be far more.
    expect(countBelow(neutral, 0.2)).toBeLessThan(300);
    expect(countBelow(boosted, 0.2)).toBeGreaterThan(350);
  });

  it('output stays sorted ascending', () => {
    const out = reweightSourceByBands(evenSorted(800), 6, [3, 0.5, 1, 2, 0.2, 1]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    }
  });

  it('output length stays close to the input length', () => {
    const out = reweightSourceByBands(evenSorted(1000), 5, [2, 1, 3, 1, 0.5]);
    // Rounding drift is at most a few samples per band.
    expect(Math.abs(out.length - 1000)).toBeLessThanOrEqual(5);
  });
});
