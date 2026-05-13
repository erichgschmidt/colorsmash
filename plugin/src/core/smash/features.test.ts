// Tests for per-pixel Oklab feature extraction.
// Verifies score ranges, alpha filtering, stride decimation, and color accuracy.

import { describe, it, expect } from 'vitest';
import { extractFeatures } from './features';

// Build a flat RGBA Uint8Array for an N×M image with a single RGBA color.
function solidImage(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

// Build a gradient image: pixel i gets luma-equivalent gray from 0→255 linearly.
function gradientImage(count: number): Uint8Array {
  const buf = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = Math.round((i / (count - 1)) * 255);
    buf[i * 4] = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe('extractFeatures', () => {
  it('returns [] for empty image (width=0, height=0)', () => {
    const result = extractFeatures(new Uint8Array(0), 0, 0);
    expect(result).toEqual([]);
  });

  it('skips fully transparent pixels (alpha=0)', () => {
    const buf = solidImage(4, 4, 255, 0, 0, 0);
    const result = extractFeatures(buf, 4, 4, 1);
    expect(result.length).toBe(0);
  });

  it('skips pixels with alpha < 128', () => {
    // alpha=127 should be skipped
    const buf = solidImage(8, 8, 255, 0, 0, 127);
    const result = extractFeatures(buf, 8, 8, 1);
    expect(result.length).toBe(0);
  });

  it('solid red: all features have chroma > 0.15, accentScore > 0.5, neutralScore < 0.3', () => {
    const buf = solidImage(4, 4, 255, 0, 0);
    const result = extractFeatures(buf, 4, 4, 1);
    expect(result.length).toBeGreaterThan(0);
    for (const f of result) {
      expect(f.chroma).toBeGreaterThan(0.15);
      expect(f.accentScore).toBeGreaterThan(0.5);
      expect(f.neutralScore).toBeLessThan(0.3);
    }
  });

  it('solid red: all features have similar oklab[0] (same luma)', () => {
    const buf = solidImage(4, 4, 255, 0, 0);
    const result = extractFeatures(buf, 4, 4, 1);
    expect(result.length).toBeGreaterThan(0);
    const lumaValues = result.map(f => f.oklab[0]);
    const min = Math.min(...lumaValues);
    const max = Math.max(...lumaValues);
    expect(max - min).toBeLessThan(1e-9);
  });

  it('solid black: all features have luma close to 0, chroma close to 0, neutralScore close to 1', () => {
    const buf = solidImage(4, 4, 0, 0, 0);
    const result = extractFeatures(buf, 4, 4, 1);
    expect(result.length).toBeGreaterThan(0);
    for (const f of result) {
      expect(f.luma).toBeCloseTo(0, 5);
      expect(f.chroma).toBeCloseTo(0, 5);
      expect(f.neutralScore).toBeCloseTo(1, 5);
    }
  });

  it('sampleStride=2 yields roughly half the samples of stride=1', () => {
    const buf = gradientImage(100);
    const stride1 = extractFeatures(buf, 100, 1, 1);
    const stride2 = extractFeatures(buf, 100, 1, 2);
    // stride=2 should give about half, allow ±1 for rounding
    expect(Math.abs(stride2.length - stride1.length / 2)).toBeLessThanOrEqual(1);
  });

  it('all scores are in valid ranges', () => {
    const buf = gradientImage(64);
    const result = extractFeatures(buf, 64, 1, 1);
    for (const f of result) {
      expect(f.neutralScore).toBeGreaterThanOrEqual(0);
      expect(f.neutralScore).toBeLessThanOrEqual(1);
      expect(f.accentScore).toBeGreaterThanOrEqual(0);
      expect(f.accentScore).toBeLessThanOrEqual(1);
      expect(f.saturation).toBeGreaterThanOrEqual(0);
      expect(f.hueAngle).toBeGreaterThanOrEqual(-Math.PI);
      expect(f.hueAngle).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('bandId and clusterId are -1 (not yet assigned)', () => {
    const buf = solidImage(2, 2, 128, 64, 200);
    const result = extractFeatures(buf, 2, 2, 1);
    for (const f of result) {
      expect(f.bandId).toBe(-1);
      expect(f.clusterId).toBe(-1);
    }
  });

  it('oklch.C equals chroma and oklch.h equals hueAngle', () => {
    const buf = solidImage(1, 1, 100, 150, 200);
    const result = extractFeatures(buf, 1, 1, 1);
    expect(result.length).toBe(1);
    const f = result[0];
    expect(f.oklch.C).toBeCloseTo(f.chroma, 10);
    expect(f.oklch.h).toBeCloseTo(f.hueAngle, 10);
    expect(f.oklch.L).toBeCloseTo(f.luma, 10);
  });
});
