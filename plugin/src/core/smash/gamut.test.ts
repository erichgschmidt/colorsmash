// Tests for the ACES Gamut Compression Operator.
// Verifies identity preservation for in-gamut inputs, correct soft compression
// of out-of-gamut inputs, linear strength blending, and the byte-buffer path.

import { describe, it, expect } from 'vitest';
import { acesGamutCompress, acesGamutCompressRgba } from './gamut';
import type { Vec3 } from './types';

// ────────── helpers ──────────

function expectVec3Close(actual: Vec3, expected: Vec3, tol: number, label?: string): void {
  const msg = (i: number) => label ? `${label}[${i}]` : `channel[${i}]`;
  expect(actual[0], msg(0)).toBeCloseTo(expected[0], -Math.log10(tol));
  expect(actual[1], msg(1)).toBeCloseTo(expected[1], -Math.log10(tol));
  expect(actual[2], msg(2)).toBeCloseTo(expected[2], -Math.log10(tol));
}

// ────────── strength=0 is identity ──────────

describe('acesGamutCompress — strength=0 is identity', () => {
  const cases: [string, Vec3][] = [
    ['in-gamut neutral', [0.5, 0.4, 0.3]],
    ['in-gamut saturated', [0.9, 0.1, 0.2]],
    ['out-of-gamut red', [1.5, 0.0, 0.0]],
    ['out-of-gamut high all channels', [1.3, 1.1, 0.8]],
    ['black', [0, 0, 0]],
    ['white', [1, 1, 1]],
    ['achromatic mid', [0.5, 0.5, 0.5]],
  ];

  for (const [label, rgb] of cases) {
    it(label, () => {
      const result = acesGamutCompress(rgb, 0);
      expectVec3Close(result, rgb, 1e-9, label);
    });
  }
});

// ────────── identity inputs at strength=1 ──────────

describe('acesGamutCompress — special identities at strength=1', () => {
  it('in-gamut color [0.5, 0.4, 0.3] is unchanged', () => {
    const rgb: Vec3 = [0.5, 0.4, 0.3];
    const result = acesGamutCompress(rgb, 1);
    expectVec3Close(result, rgb, 1e-6, 'in-gamut');
  });

  it('achromatic gray [0.5, 0.5, 0.5] is identity', () => {
    const gray: Vec3 = [0.5, 0.5, 0.5];
    const result = acesGamutCompress(gray, 1);
    expectVec3Close(result, gray, 1e-9, 'gray');
  });

  it('black [0, 0, 0] is identity', () => {
    const black: Vec3 = [0, 0, 0];
    const result = acesGamutCompress(black, 0);
    expectVec3Close(result, black, 1e-9, 'black strength=0');

    const result1 = acesGamutCompress(black, 1);
    expectVec3Close(result1, black, 1e-9, 'black strength=1');
  });

  it('white [1, 1, 1] is identity', () => {
    const white: Vec3 = [1, 1, 1];
    const result0 = acesGamutCompress(white, 0);
    expectVec3Close(result0, white, 1e-9, 'white strength=0');

    const result1 = acesGamutCompress(white, 1);
    expectVec3Close(result1, white, 1e-9, 'white strength=1');
  });
});

// ────────── out-of-gamut compression ──────────

describe('acesGamutCompress — out-of-gamut inputs are compressed', () => {
  it('pure-red [1.5, 0.0, 0.0] at strength=1: achromatic max channel preserved, G/B lifted', () => {
    // ACES compresses distance-from-achromatic, not the achromatic value itself.
    // For [1.5, 0, 0], R is the max (achromatic), so its distance is 0 and it
    // stays at 1.5. G and B have distance 1.0, which is above threshold, so they
    // are lifted toward the achromatic axis (compressed distances < 1 → outG/outB > 0).
    // The algorithm's job is preventing the ugly "crushed to zero" artefact on
    // the complement channels — it does not reduce the luminance of the max channel.
    const result = acesGamutCompress([1.5, 0.0, 0.0], 1);
    // R stays at the achromatic value.
    expect(result[0]).toBeCloseTo(1.5, 9);
    // G and B get lifted above 0 (distance compressed from 1.0 to ~0.955 / 0.982).
    expect(result[1]).toBeGreaterThan(0.0);
    expect(result[2]).toBeGreaterThan(0.0);
    // All output channels are non-negative.
    expect(result[0]).toBeGreaterThanOrEqual(0.0);
    expect(result[1]).toBeGreaterThanOrEqual(0.0);
    expect(result[2]).toBeGreaterThanOrEqual(0.0);
  });

  it('pure-red boundary [1.0, 0.0, 0.0] at strength=1: R preserved, G/B lifted slightly', () => {
    // R = max = 1.0 (at the gamut boundary). Its achromatic distance is 0 → no change.
    // G and B have distance 1.0 > thresholds (0.803, 0.880), so they are lifted.
    // The ACES algorithm maps the excess saturation, not the luminance boundary.
    const result = acesGamutCompress([1.0, 0.0, 0.0], 1);
    expect(result[0]).toBeCloseTo(1.0, 9);
    // G/B get lifted a small but non-zero amount.
    expect(result[1]).toBeGreaterThan(0.0);
    expect(result[2]).toBeGreaterThan(0.0);
    expect(result[1]).toBeLessThan(0.1); // stays relatively small
    expect(result[2]).toBeLessThan(0.1);
  });
});

// ────────── strength interpolation ──────────

describe('acesGamutCompress — strength blending', () => {
  it('[1.5, 0.0, 0.0] at strength=0.5 is midpoint of identity and full compression', () => {
    const rgb: Vec3 = [1.5, 0.0, 0.0];
    const identity = acesGamutCompress(rgb, 0);
    const full = acesGamutCompress(rgb, 1);
    const half = acesGamutCompress(rgb, 0.5);

    const TOL = 1e-9;
    for (let ch = 0; ch < 3; ch++) {
      const expected = identity[ch] + (full[ch] - identity[ch]) * 0.5;
      expect(half[ch]).toBeCloseTo(expected, -Math.log10(TOL));
    }
  });
});

// ────────── byte buffer path ──────────

describe('acesGamutCompressRgba', () => {
  it('strength=0 leaves the buffer unchanged', () => {
    // 4 pixels, mix of in-gamut and arbitrary values
    const original = new Uint8Array([
      255, 128,   0, 255,   // saturated orange, fully opaque
       50,  50,  50, 200,   // dark gray, semi-transparent
        0, 255, 128, 128,   // green-cyan, semi-transparent
      200,   0,  80, 255,   // pink-magenta, fully opaque
    ]);
    const buf = new Uint8Array(original);
    acesGamutCompressRgba(buf, 0);
    expect(buf).toEqual(original);
  });

  it('result bytes are in [0, 255] and alpha is preserved exactly', () => {
    // Mix of in-gamut and challenging colors; alpha values vary.
    const buf = new Uint8Array([
      255,   0,   0, 255,   // pure red
        0, 255,   0,  64,   // pure green, low alpha
        0,   0, 255, 128,   // pure blue
      255, 255, 255, 200,   // white
       10,  20,  30,   0,   // near-black, transparent
      220, 180,  60, 255,   // warm yellow
      100, 200, 240,  80,   // sky-blue, semi-transparent
        0,   0,   0, 255,   // black
    ]);
    const alphas = Array.from({ length: buf.length / 4 }, (_, i) => buf[i * 4 + 3]);

    acesGamutCompressRgba(buf, 1);

    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeGreaterThanOrEqual(0);
      expect(buf[i]).toBeLessThanOrEqual(255);
    }
    // Alpha channels preserved exactly.
    for (let i = 0; i < buf.length / 4; i++) {
      expect(buf[i * 4 + 3]).toBe(alphas[i]);
    }
  });
});
