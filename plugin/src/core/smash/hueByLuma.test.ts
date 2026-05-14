import { describe, it, expect } from 'vitest';
import { buildHueByLumaLut, lookupHueByLuma } from './hueByLuma';
import type { PixelFeatures } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal PixelFeatures with only luma and oklab required; other fields are
 *  sentinel values that the build function never reads. */
function makeFeature(luma: number, a: number, b: number): PixelFeatures {
  return {
    luma,
    oklab: [luma, a, b],
    oklch: { L: luma, C: 0, h: 0 },
    hueAngle: 0,
    chroma: 0,
    saturation: 0,
    neutralScore: 0,
    accentScore: 0,
    bandId: 0,
    clusterId: 0,
    rgb: [0, 0, 0],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildHueByLumaLut + lookupHueByLuma', () => {
  // 1. Empty input: all-zero values, no NaN.
  it('empty input: returns all-zero LUT; lookup returns [0, 0]', () => {
    const lut = buildHueByLumaLut([]);
    expect(lut.lMin).toBe(0);
    expect(lut.lMax).toBe(1);
    for (let i = 0; i < lut.values.length; i++) {
      expect(lut.values[i]).toBe(0);
    }
    for (let i = 0; i < lut.sampleCounts.length; i++) {
      expect(lut.sampleCounts[i]).toBe(0);
    }
    const [a, b] = lookupHueByLuma(lut, 0.5);
    expect(isNaN(a)).toBe(false);
    expect(isNaN(b)).toBe(false);
    expect(a).toBe(0);
    expect(b).toBe(0);
  });

  // 2. Single-bucket / collapsed L: all features share the same L.
  it('collapsed L: all features at same luma return magnitude-preserved average', () => {
    const features = [
      makeFeature(0.5, 0.1, -0.2),
      makeFeature(0.5, 0.3, 0.4),
      makeFeature(0.5, -0.1, 0.0),
    ];
    const lut = buildHueByLumaLut(features, 32);
    // All features map to bucket 0 (lRange === 0).
    // Vector mean: avgA = 0.1, avgB = 0.0667, |vec| ≈ 0.1202.
    // Scalar chroma mean: avgC = (√0.05 + √0.25 + √0.01) / 3 ≈ 0.2745.
    // The LUT rescales the vector mean's DIRECTION to the scalar chroma
    // MAGNITUDE so mixed-hue buckets don't collapse to neutral.
    //   scale = avgC / |vec| ≈ 2.284
    //   a = 0.1   * 2.284 ≈ 0.2284
    //   b = 0.0667 * 2.284 ≈ 0.1524
    const [a, b] = lookupHueByLuma(lut, 0.5);
    expect(a).toBeCloseTo(0.2284, 3);
    expect(b).toBeCloseTo(0.1524, 3);

    // Sanity: the output direction matches the vector-mean direction.
    const inputAngle = Math.atan2(0.0667, 0.1);
    const outputAngle = Math.atan2(b, a);
    expect(Math.abs(inputAngle - outputAngle)).toBeLessThan(1e-3);
  });

  // 3. Two-color source at L=0.2 and L=0.8.
  it('two-color source: lookups near each anchor return correct (a,b)', () => {
    const features = [
      makeFeature(0.2, 0.1, -0.1),
      makeFeature(0.8, -0.05, 0.2),
    ];
    const lut = buildHueByLumaLut(features, 32);

    const [a02, b02] = lookupHueByLuma(lut, 0.2);
    expect(a02).toBeCloseTo(0.1, 1);
    expect(b02).toBeCloseTo(-0.1, 1);

    const [a08, b08] = lookupHueByLuma(lut, 0.8);
    expect(a08).toBeCloseTo(-0.05, 1);
    expect(b08).toBeCloseTo(0.2, 1);

    // Midpoint is interpolated between the two colors — should be between them.
    const [aMid, bMid] = lookupHueByLuma(lut, 0.5);
    expect(isFinite(aMid)).toBe(true);
    expect(isFinite(bMid)).toBe(true);
    const aLo = Math.min(0.1, -0.05);
    const aHi = Math.max(0.1, -0.05);
    const bLo = Math.min(-0.1, 0.2);
    const bHi = Math.max(-0.1, 0.2);
    expect(aMid).toBeGreaterThanOrEqual(aLo - 1e-6);
    expect(aMid).toBeLessThanOrEqual(aHi + 1e-6);
    expect(bMid).toBeGreaterThanOrEqual(bLo - 1e-6);
    expect(bMid).toBeLessThanOrEqual(bHi + 1e-6);
  });

  // 4. Empty-bucket fill: features only at L=0.1 and L=0.9.
  it('empty-bucket fill: middle buckets get non-NaN values from neighbor fill', () => {
    const features = [
      makeFeature(0.1, 0.2, 0.3),
      makeFeature(0.9, -0.1, -0.2),
    ];
    const lut = buildHueByLumaLut(features, 64);
    const [aMid, bMid] = lookupHueByLuma(lut, 0.5);

    expect(isFinite(aMid)).toBe(true);
    expect(isFinite(bMid)).toBe(true);
    expect(isNaN(aMid)).toBe(false);
    expect(isNaN(bMid)).toBe(false);

    // Result must be within the source color range.
    expect(aMid).toBeGreaterThanOrEqual(-0.1 - 1e-6);
    expect(aMid).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(bMid).toBeGreaterThanOrEqual(-0.2 - 1e-6);
    expect(bMid).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  // 5. Out-of-range clamping: no NaN/Inf, returns boundary bucket values.
  it('out-of-range clamping: L below lMin returns first bucket, above lMax returns last', () => {
    const features = [
      makeFeature(0.2, 0.1, -0.1),
      makeFeature(0.8, -0.05, 0.2),
    ];
    const lut = buildHueByLumaLut(features, 32);

    const [aLow, bLow] = lookupHueByLuma(lut, -1);
    const [aHigh, bHigh] = lookupHueByLuma(lut, 2);

    expect(isFinite(aLow)).toBe(true);
    expect(isFinite(bLow)).toBe(true);
    expect(isNaN(aLow)).toBe(false);
    expect(isNaN(bLow)).toBe(false);

    expect(isFinite(aHigh)).toBe(true);
    expect(isFinite(bHigh)).toBe(true);
    expect(isNaN(aHigh)).toBe(false);
    expect(isNaN(bHigh)).toBe(false);

    // Clamped-low matches first bucket exactly.
    expect(aLow).toBe(lut.values[0]);
    expect(bLow).toBe(lut.values[1]);

    // Clamped-high matches last bucket exactly.
    const last = (lut.bins - 1) * 2;
    expect(aHigh).toBe(lut.values[last]);
    expect(bHigh).toBe(lut.values[last + 1]);
  });

  // 6. Identity on (a, b): grayscale source always returns [0, 0].
  it('grayscale source: all (a,b)=(0,0) => lookups always return [0, 0]', () => {
    const features = [
      makeFeature(0.1, 0, 0),
      makeFeature(0.4, 0, 0),
      makeFeature(0.7, 0, 0),
      makeFeature(1.0, 0, 0),
    ];
    const lut = buildHueByLumaLut(features, 64);
    for (const L of [0.0, 0.2, 0.5, 0.8, 1.0]) {
      const [a, b] = lookupHueByLuma(lut, L);
      expect(a).toBeCloseTo(0, 6);
      expect(b).toBeCloseTo(0, 6);
    }
  });

  // 7. Monotonic source: a = L * 0.3, b = -L * 0.2 => lookup at 0.5 ≈ [0.15, -0.10].
  it('monotonic source: linearly-correlated (a,b) recovers expected values at midpoint', () => {
    const n = 100;
    const features: PixelFeatures[] = [];
    for (let i = 0; i < n; i++) {
      const L = i / (n - 1);
      features.push(makeFeature(L, L * 0.3, -L * 0.2));
    }
    const lut = buildHueByLumaLut(features, 64);
    const [a, b] = lookupHueByLuma(lut, 0.5);
    expect(a).toBeCloseTo(0.15, 1);
    expect(b).toBeCloseTo(-0.10, 1);
  });

  // 8. Bucket count tunables: bins=16 and bins=128 both produce valid LUTs.
  it('bucket count tunables: bins=16 and bins=128 both produce valid LUTs', () => {
    const features = [
      makeFeature(0.0, 0.2, -0.1),
      makeFeature(0.5, 0.0, 0.1),
      makeFeature(1.0, -0.2, 0.3),
    ];
    const lut16 = buildHueByLumaLut(features, 16);
    const lut128 = buildHueByLumaLut(features, 128);

    expect(lut16.bins).toBe(16);
    expect(lut16.values.length).toBe(32);
    expect(lut128.bins).toBe(128);
    expect(lut128.values.length).toBe(256);

    // All values finite; no NaN.
    for (let i = 0; i < lut16.values.length; i++) {
      expect(isFinite(lut16.values[i])).toBe(true);
      expect(isNaN(lut16.values[i])).toBe(false);
    }
    for (let i = 0; i < lut128.values.length; i++) {
      expect(isFinite(lut128.values[i])).toBe(true);
      expect(isNaN(lut128.values[i])).toBe(false);
    }

    // Both LUTs agree closely at the anchor L values (within bucket quantization).
    for (const L of [0.0, 0.5, 1.0]) {
      const [a16, b16] = lookupHueByLuma(lut16, L);
      const [a128, b128] = lookupHueByLuma(lut128, L);
      expect(Math.abs(a16 - a128)).toBeLessThan(0.05);
      expect(Math.abs(b16 - b128)).toBeLessThan(0.05);
    }
  });

  // 9. PixelFeatures shape compatibility: all fields populated; build only reads luma + oklab[1/2].
  it('PixelFeatures shape compatibility: fully-populated feature struct builds correctly', () => {
    const fullFeature: PixelFeatures = {
      rgb: [128, 64, 200],
      oklab: [0.6, 0.12, -0.08],
      oklch: { L: 0.6, C: 0.144, h: 326 },
      luma: 0.6,
      hueAngle: 326,
      chroma: 0.144,
      saturation: 0.75,
      neutralScore: 0.1,
      accentScore: 0.9,
      bandId: 2,
      clusterId: 4,
    };
    // Build should succeed and read luma=0.6, a=0.12, b=-0.08.
    const lut = buildHueByLumaLut([fullFeature], 32);
    const [a, b] = lookupHueByLuma(lut, 0.6);
    expect(a).toBeCloseTo(0.12, 4);
    expect(b).toBeCloseTo(-0.08, 4);
  });
});
