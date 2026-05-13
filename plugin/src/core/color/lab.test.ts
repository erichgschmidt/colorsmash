import { describe, it, expect } from 'vitest';
import { rgbByteToLab, labToRgbByte } from './lab';

// Colors for round-trip testing: [r, g, b] triples.
const ROUND_TRIP_COLORS: Array<[number, number, number]> = [
  [0,   0,   0],    // black
  [255, 255, 255],  // white
  [128, 128, 128],  // mid gray
  [255, 0,   0],    // red primary
  [0,   255, 0],    // green primary
  [0,   0,   255],  // blue primary
  [255, 255, 0],    // yellow
  [0,   255, 255],  // cyan
  [255, 0,   255],  // magenta
  [64,  128, 192],  // arbitrary blue-ish
];

describe('rgbByteToLab', () => {
  it('white returns L~100, a~0, b~0', () => {
    const [L, a, b] = rgbByteToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 0);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });

  it('black returns L~0, a~0, b~0', () => {
    const [L, a, b] = rgbByteToLab(0, 0, 0);
    expect(L).toBeCloseTo(0, 0);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });

  it('mid gray (128,128,128) has a and b within 0.5 of 0', () => {
    const [, a, b] = rgbByteToLab(128, 128, 128);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });

  it('returns a tuple of three numbers for all sample colors', () => {
    for (const [r, g, b] of ROUND_TRIP_COLORS) {
      const result = rgbByteToLab(r, g, b);
      expect(result).toHaveLength(3);
      expect(result.every(v => typeof v === 'number' && isFinite(v))).toBe(true);
    }
  });
});

describe('labToRgbByte round-trip within ±2 per channel', () => {
  for (const [r, g, b] of ROUND_TRIP_COLORS) {
    it(`[${r}, ${g}, ${b}]`, () => {
      const lab = rgbByteToLab(r, g, b);
      const [ro, go, bo] = labToRgbByte(...lab);
      expect(Math.abs(ro - r)).toBeLessThanOrEqual(2);
      expect(Math.abs(go - g)).toBeLessThanOrEqual(2);
      expect(Math.abs(bo - b)).toBeLessThanOrEqual(2);
    });
  }
});
