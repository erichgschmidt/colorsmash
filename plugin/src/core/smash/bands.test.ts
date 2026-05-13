// Tests for adaptive band construction over the Smash feature set.
// Covers value-axis bucketing, label correctness, histogram shape, and
// error-throwing for unimplemented axes.

import { describe, it, expect } from 'vitest';
import { constructBands } from './bands';
import { extractFeatures } from './features';

// Build a flat RGBA Uint8Array for N pixels with a single RGBA color.
function solidImage(count: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const buf = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

// Build a linear grayscale gradient with `count` pixels from gray=0 to gray=255.
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

describe('constructBands — value axis', () => {
  it('3-band on uniform luma ramp: sampleCount sums to total', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    const bands = constructBands(features, 'value', 3);
    const totalSamples = bands.reduce((acc, b) => acc + b.sampleCount, 0);
    expect(totalSamples).toBe(features.length);
  });

  it('3-band on uniform luma ramp: bands roughly evenly populated', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    const bands = constructBands(features, 'value', 3);
    // Each band should have at least 1 sample and not exceed 2× fair share
    const fair = features.length / 3;
    for (const band of bands) {
      expect(band.sampleCount).toBeGreaterThanOrEqual(1);
      expect(band.sampleCount).toBeLessThanOrEqual(Math.ceil(fair * 2));
    }
  });

  it('3-band on uniform luma ramp: centers are monotonically increasing', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    const bands = constructBands(features, 'value', 3);
    expect(bands[0].center).toBeLessThan(bands[1].center);
    expect(bands[1].center).toBeLessThan(bands[2].center);
  });

  it('3-band on all-black: bands[0].sampleCount === total, others === 0', () => {
    const buf = solidImage(20, 0, 0, 0);
    const features = extractFeatures(buf, 20, 1, 1);
    const bands = constructBands(features, 'value', 3);
    const total = features.length;
    expect(bands[0].sampleCount).toBe(total);
    expect(bands[1].sampleCount).toBe(0);
    expect(bands[2].sampleCount).toBe(0);
  });

  it('3-band on all-white: bands[2].sampleCount === total', () => {
    const buf = solidImage(20, 255, 255, 255);
    const features = extractFeatures(buf, 20, 1, 1);
    const bands = constructBands(features, 'value', 3);
    const total = features.length;
    expect(bands[2].sampleCount).toBe(total);
    expect(bands[0].sampleCount).toBe(0);
    expect(bands[1].sampleCount).toBe(0);
  });

  it('count=5 produces 5 bands with correct labels', () => {
    const buf = gradientImage(50);
    const features = extractFeatures(buf, 50, 1, 1);
    const bands = constructBands(features, 'value', 5);
    expect(bands.length).toBe(5);
    expect(bands.map(b => b.label)).toEqual(['Deep', 'Shadow', 'Mid', 'Light', 'Highlight']);
  });

  it('count=7 produces 7 bands with correct labels', () => {
    const buf = gradientImage(70);
    const features = extractFeatures(buf, 70, 1, 1);
    const bands = constructBands(features, 'value', 7);
    expect(bands.length).toBe(7);
    expect(bands.map(b => b.label)).toEqual([
      'Deep', 'Shadow', 'Low Mid', 'Mid', 'High Mid', 'Light', 'Highlight',
    ]);
  });

  it('each band histogram has exactly 32 entries', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    for (const count of [3, 5, 7] as const) {
      const bands = constructBands(features, 'value', count);
      for (const band of bands) {
        expect(band.histogram.length).toBe(32);
      }
    }
  });

  it('bands are returned in ascending center order', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    for (const count of [3, 5, 7] as const) {
      const bands = constructBands(features, 'value', count);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].center).toBeGreaterThanOrEqual(bands[i - 1].center);
      }
    }
  });

  it('empty band has valid bounds, center, label, and zeroed sampleCount', () => {
    // All-black image → bands 1 and 2 are empty.
    const buf = solidImage(16, 0, 0, 0);
    const features = extractFeatures(buf, 16, 1, 1);
    const bands = constructBands(features, 'value', 3);
    expect(bands[1].sampleCount).toBe(0);
    expect(bands[1].label).toBe('Mids');
    expect(bands[1].histogram.length).toBe(32);
    expect(bands[1].pixelRatio).toBe(0);
    expect(bands[1].neutralDensity).toBe(0);
  });

  it('pixelRatio sums to 1 on a full-coverage gradient', () => {
    const buf = gradientImage(30);
    const features = extractFeatures(buf, 30, 1, 1);
    const bands = constructBands(features, 'value', 3);
    const sum = bands.reduce((acc, b) => acc + b.pixelRatio, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('3-band: each band index matches its array position', () => {
    const buf = gradientImage(32);
    const features = extractFeatures(buf, 32, 1, 1);
    const bands = constructBands(features, 'value', 3);
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i].index).toBe(i);
    }
  });
});

describe('constructBands — unsupported axes', () => {
  it("axis='hue' throws with message containing 'not yet supported'", () => {
    expect(() => constructBands([], 'hue', 3)).toThrow('not yet supported');
  });

  it("axis='saturation' throws", () => {
    expect(() => constructBands([], 'saturation', 3)).toThrow('not yet supported');
  });

  it("axis='chroma' throws", () => {
    expect(() => constructBands([], 'chroma', 3)).toThrow('not yet supported');
  });
});
