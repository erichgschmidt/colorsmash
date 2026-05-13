import { describe, it, expect } from 'vitest';
import { srgbToLinear, linearToSrgbByte } from './srgb';

describe('srgbToLinear', () => {
  it('maps 0 to 0', () => {
    expect(srgbToLinear(0)).toBe(0);
  });

  it('maps 255 to 1', () => {
    expect(srgbToLinear(255)).toBeCloseTo(1, 10);
  });

  it('uses the linear segment below 0.04045', () => {
    // byte 1 → x = 1/255 ≈ 0.00392, which is <= 0.04045, so linear: x/12.92
    const x = 1 / 255;
    expect(srgbToLinear(1)).toBeCloseTo(x / 12.92, 12);
  });

  it('uses the power curve above 0.04045', () => {
    const x = 128 / 255; // ~0.502, well above threshold
    expect(srgbToLinear(128)).toBeCloseTo(Math.pow((x + 0.055) / 1.055, 2.4), 12);
  });
});

describe('linearToSrgbByte', () => {
  it('maps 0 to 0', () => {
    expect(linearToSrgbByte(0)).toBe(0);
  });

  it('maps 1 to 255', () => {
    expect(linearToSrgbByte(1)).toBe(255);
  });

  it('clamps negative values to 0', () => {
    expect(linearToSrgbByte(-0.1)).toBe(0);
  });

  it('clamps values > 1 to 255', () => {
    expect(linearToSrgbByte(1.5)).toBe(255);
  });
});

describe('round trip: linearToSrgbByte(srgbToLinear(b)) === b', () => {
  const samples = [0, 32, 64, 128, 192, 255];
  for (const b of samples) {
    it(`byte ${b}`, () => {
      expect(linearToSrgbByte(srgbToLinear(b))).toBe(b);
    });
  }
});
