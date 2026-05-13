// Tests for bakeSmashLut() and serializeSmashCube() in lut.ts.
// Uses synthetic RGBA buffers mirroring transform.test.ts's fixtures.

import { describe, it, expect } from 'vitest';
import { extractSourceDNA, extractTargetStructure, pairDNA } from './profile';
import { extractFeatures } from './features';
import { smash } from './transform';
import type { SmashEngineOutput } from './transform';
import type { ImagePairProfile } from './types';
import { bakeSmashLut, serializeSmashCube } from './lut';

// ────────── buffer helpers (mirrors transform.test.ts) ──────────

function gradientBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const v = Math.round((i / (total - 1)) * 255);
    buf[i * 4]     = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function coolBlueBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    buf[i * 4]     = Math.round(t * 30);
    buf[i * 4 + 1] = Math.round(t * 80);
    buf[i * 4 + 2] = Math.round(100 + t * 155);
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function warmOrangeBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    buf[i * 4]     = Math.round(80  + t * 175);
    buf[i * 4 + 1] = Math.round(40  + t * 140);
    buf[i * 4 + 2] = Math.round(t * 40);
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

// ────────── helper: profile + smash output ──────────

function buildOutput(
  srcRgba: Uint8Array,
  tgtRgba: Uint8Array,
  bandCount: 3 | 5 | 7 = 3,
): SmashEngineOutput {
  const src = extractSourceDNA(srcRgba, 32, 32, { bandCount, sampleStride: 1 });
  const tgt = extractTargetStructure(tgtRgba, 32, 32, { bandCount, sampleStride: 1 });
  const profile = pairDNA(src, tgt);
  const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
  const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);
  return smash(srcFeatures, tgtFeatures, profile);
}

/**
 * Build a SmashEngineOutput where all band transforms have fellBack=true.
 * Uses an empty profile (bands: []) which routes through the degenerate path
 * in applyTransform — identity passthrough before ACES compression.
 */
function buildFallbackOutput(): SmashEngineOutput {
  const rgba = gradientBuffer32();
  const src = extractSourceDNA(rgba, 32, 32, { bandCount: 3, sampleStride: 1 });
  const emptyProfile: ImagePairProfile = {
    source: src,
    target: src,
    bands: [],
    weakBands: [],
  };
  const features = extractFeatures(rgba, 32, 32, 1);
  return smash(features, features, emptyProfile);
}

// ────────── 1. Basic shape ──────────

describe('bakeSmashLut() basic shape', () => {
  it('returns SmashLut with size=17 and values.length=17³×3=14739', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output, 17);

    expect(lut.size).toBe(17);
    expect(lut.values.length).toBe(17 * 17 * 17 * 3);
    expect(lut.values.length).toBe(14739);
    expect(lut.source).toBe(output);
  });
});

// ────────── 2. Default size ──────────

describe('bakeSmashLut() default size', () => {
  it('omitting size produces a 33³ LUT with values.length=107811', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output);

    expect(lut.size).toBe(33);
    expect(lut.values.length).toBe(33 * 33 * 33 * 3);
    expect(lut.values.length).toBe(107811);
  });
});

// ────────── 3. Identity-ish LUT (all bands fellBack) ──────────

describe('bakeSmashLut() near-identity when all bands fell back', () => {
  it('grid point near [0.5, 0.5, 0.5] is within ±0.10 per channel', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output, 17);

    // Grid point index for r=8, g=8, b=8 (mid-point of 17-grid, index 8 in each dim).
    // Layout: offset = (b * size * size + g * size + r) * 3
    const size = 17;
    const mid = 8; // index 8 of 0..16 → 0.5
    const offset = (mid * size * size + mid * size + mid) * 3;

    const outR = lut.values[offset];
    const outG = lut.values[offset + 1];
    const outB = lut.values[offset + 2];

    expect(Math.abs(outR - 0.5)).toBeLessThanOrEqual(0.10);
    expect(Math.abs(outG - 0.5)).toBeLessThanOrEqual(0.10);
    expect(Math.abs(outB - 0.5)).toBeLessThanOrEqual(0.10);
  });
});

// ────────── 4. Non-identity shifts ──────────

describe('bakeSmashLut() non-identity for different source/target', () => {
  it('at least one grid point differs from identity by >0.05 in some channel', () => {
    const srcRgba = coolBlueBuffer32();
    const tgtRgba = warmOrangeBuffer32();
    const output = buildOutput(srcRgba, tgtRgba);
    const lut = bakeSmashLut(output, 17);

    const size = 17;
    let maxDeviation = 0;

    for (let bi = 0; bi < size; bi++) {
      for (let gi = 0; gi < size; gi++) {
        for (let ri = 0; ri < size; ri++) {
          const offset = (bi * size * size + gi * size + ri) * 3;
          const inputR = ri / (size - 1);
          const inputG = gi / (size - 1);
          const inputB = bi / (size - 1);

          const devR = Math.abs(lut.values[offset]     - inputR);
          const devG = Math.abs(lut.values[offset + 1] - inputG);
          const devB = Math.abs(lut.values[offset + 2] - inputB);

          maxDeviation = Math.max(maxDeviation, devR, devG, devB);
        }
      }
    }

    expect(maxDeviation).toBeGreaterThan(0.05);
  });
});

// ────────── 5. Float range ──────────

describe('bakeSmashLut() float range', () => {
  it('every value in lut.values is in [0, 1]', () => {
    const output = buildOutput(coolBlueBuffer32(), warmOrangeBuffer32());
    const lut = bakeSmashLut(output, 17);

    for (let i = 0; i < lut.values.length; i++) {
      const v = lut.values[i];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ────────── 6. serializeSmashCube structure ──────────

describe('serializeSmashCube() basic structure', () => {
  it('starts with TITLE, contains LUT_3D_SIZE 33, has 33³+5 non-empty lines + trailing newline', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output, 33);
    const cube = serializeSmashCube(lut);

    // Must start with TITLE.
    expect(cube.startsWith('TITLE')).toBe(true);

    // Must contain the size declaration.
    expect(cube).toContain('LUT_3D_SIZE 33');

    // Split on newlines. The file ends with \n so the last element is ''.
    const lines = cube.split('\n');
    // Last element is empty due to trailing newline.
    expect(lines[lines.length - 1]).toBe('');

    // Non-empty lines: TITLE + LUT_3D_SIZE + DOMAIN_MIN + DOMAIN_MAX + blank + 33³ entries.
    const nonEmpty = lines.filter(l => l.length > 0);
    // header lines: TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX = 4
    // data lines: 33*33*33 = 35937
    expect(nonEmpty.length).toBe(4 + 33 * 33 * 33);
  });
});

// ────────── 7. Round-trip via parser ──────────

describe('serializeSmashCube() round-trip', () => {
  it('parsed grid values match lut.values within float32 precision', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output, 17);
    const cube = serializeSmashCube(lut);

    const lines = cube.split('\n').filter(l => l.length > 0);

    // Find LUT_3D_SIZE line to locate data start.
    const sizeLineIdx = lines.findIndex(l => l.startsWith('LUT_3D_SIZE'));
    expect(sizeLineIdx).toBeGreaterThanOrEqual(0);

    // Data lines start after the header (TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX) + blank.
    // The blank is filtered out, so we skip the 4 header lines.
    const dataLines = lines.slice(sizeLineIdx + 3); // DOMAIN_MIN, DOMAIN_MAX, then data
    expect(dataLines.length).toBe(17 * 17 * 17);

    for (let i = 0; i < dataLines.length; i++) {
      const parts = dataLines[i].split(' ');
      expect(parts.length).toBe(3);

      const parsedR = parseFloat(parts[0]);
      const parsedG = parseFloat(parts[1]);
      const parsedB = parseFloat(parts[2]);

      // toFixed(6) introduces at most 5e-7 error vs the Float32 stored value.
      expect(Math.abs(parsedR - lut.values[i * 3])).toBeLessThan(1e-5);
      expect(Math.abs(parsedG - lut.values[i * 3 + 1])).toBeLessThan(1e-5);
      expect(Math.abs(parsedB - lut.values[i * 3 + 2])).toBeLessThan(1e-5);
    }
  });
});

// ────────── 8. Custom title ──────────

describe('serializeSmashCube() custom title', () => {
  it('passing title="Test Look" produces TITLE "Test Look" in the output', () => {
    const output = buildFallbackOutput();
    const lut = bakeSmashLut(output, 17);
    const cube = serializeSmashCube(lut, 'Test Look');

    const firstLine = cube.split('\n')[0];
    expect(firstLine).toBe('TITLE "Test Look"');
  });
});

// ────────── 9. Empty bands ──────────

describe('bakeSmashLut() empty bandTransforms', () => {
  it('SmashEngineOutput with bandTransforms:[] bakes to a near-identity LUT (±0.10)', () => {
    const output = buildFallbackOutput();
    // Confirm we actually have zero bands.
    expect(output.bandTransforms).toHaveLength(0);

    const lut = bakeSmashLut(output, 17);

    // Check several grid points against identity (input value == output value).
    const size = 17;
    const checkIndices = [0, 4, 8, 12, 16];

    for (const ri of checkIndices) {
      for (const gi of checkIndices) {
        for (const bi of checkIndices) {
          const offset = (bi * size * size + gi * size + ri) * 3;
          const inputR = ri / (size - 1);
          const inputG = gi / (size - 1);
          const inputB = bi / (size - 1);

          expect(Math.abs(lut.values[offset]     - inputR)).toBeLessThanOrEqual(0.10);
          expect(Math.abs(lut.values[offset + 1] - inputG)).toBeLessThanOrEqual(0.10);
          expect(Math.abs(lut.values[offset + 2] - inputB)).toBeLessThanOrEqual(0.10);
        }
      }
    }
  });
});
