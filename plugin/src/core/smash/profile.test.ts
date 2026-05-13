// Tests for the DNA assembly and band pairing layer (profile.ts).
// Uses synthetic RGBA buffers to exercise extractSourceDNA, extractTargetStructure,
// and pairDNA without touching the filesystem.

import { describe, it, expect } from 'vitest';
import {
  extractSourceDNA,
  extractTargetStructure,
  pairDNA,
  VIABILITY_THRESHOLD,
} from './profile';
import { SMASH_SCHEMA_VERSION } from './types';
import type { BandStats, SourceDNA } from './types';

// ────────── helpers ──────────

/** Build a flat RGBA buffer filled with a single opaque color. */
function solidBuffer(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4]     = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/** Build a gradient buffer ramping from black to white left-to-right. */
function gradientBuffer(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 4;
      buf[i]     = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/**
 * Build a synthetic SourceDNA with a given band count, where one specific band
 * has sampleCount 0 (simulating a sparse band that will be weak).
 */
function syntheticDna(bandCount: 3 | 5 | 7, weakIndex: number): SourceDNA {
  const rgba = gradientBuffer(32, 32);
  const dna = extractSourceDNA(rgba, 32, 32, { bandCount });
  // Patch the weak band's sampleCount to 0 via object spread — types are readonly
  // so we reconstruct the bands array.
  const patchedBands = dna.bands.map((band, i): BandStats => {
    if (i !== weakIndex) return band;
    return { ...band, sampleCount: 0 };
  });
  return { ...dna, bands: patchedBands };
}

// ────────── extractSourceDNA ──────────

describe('extractSourceDNA', () => {
  it('returns version === SMASH_SCHEMA_VERSION for a uniform-gray 16x16 image', () => {
    const rgba = solidBuffer(16, 16, 128, 128, 128);
    const dna = extractSourceDNA(rgba, 16, 16);
    expect(dna.version).toBe(SMASH_SCHEMA_VERSION);
  });

  it('returns 3 bands by default for a uniform-gray 16x16 image', () => {
    const rgba = solidBuffer(16, 16, 128, 128, 128);
    const dna = extractSourceDNA(rgba, 16, 16);
    expect(dna.bands.length).toBe(3);
  });

  it('returns at least 1 cluster for a uniform-gray 16x16 image', () => {
    const rgba = solidBuffer(16, 16, 128, 128, 128);
    const dna = extractSourceDNA(rgba, 16, 16);
    expect(dna.clusters.length).toBeGreaterThanOrEqual(1);
  });

  it('medianOklab is a non-zero Vec3 for a uniform-gray image', () => {
    const rgba = solidBuffer(16, 16, 128, 128, 128);
    const dna = extractSourceDNA(rgba, 16, 16);
    // Mid-gray has a positive L component in Oklab.
    const [L] = dna.global.medianOklab;
    expect(L).toBeGreaterThan(0);
    expect(dna.global.medianOklab.length).toBe(3);
  });

  it('bandCount: 5 returns 5 bands', () => {
    const rgba = gradientBuffer(32, 32);
    const dna = extractSourceDNA(rgba, 32, 32, { bandCount: 5 });
    expect(dna.bands.length).toBe(5);
  });

  it('bandCount: 7 returns 7 bands', () => {
    const rgba = gradientBuffer(32, 32);
    const dna = extractSourceDNA(rgba, 32, 32, { bandCount: 7 });
    expect(dna.bands.length).toBe(7);
  });

  it('bandAxis: "hue" propagates the error from constructBands', () => {
    const rgba = solidBuffer(16, 16, 100, 100, 100);
    expect(() =>
      extractSourceDNA(rgba, 16, 16, { bandAxis: 'hue' }),
    ).toThrow('not yet supported');
  });

  it('preserves the thumbnail string when provided', () => {
    const rgba = solidBuffer(16, 16, 200, 100, 50);
    const thumb = 'data:image/png;base64,abc123';
    const dna = extractSourceDNA(rgba, 16, 16, { thumbnail: thumb });
    expect(dna.thumbnail).toBe(thumb);
  });

  it('does not set thumbnail when option is omitted', () => {
    const rgba = solidBuffer(16, 16, 200, 100, 50);
    const dna = extractSourceDNA(rgba, 16, 16);
    expect(dna.thumbnail).toBeUndefined();
  });

  it('capturedAt is a valid ISO-8601 timestamp', () => {
    const rgba = solidBuffer(16, 16, 128, 128, 128);
    const dna = extractSourceDNA(rgba, 16, 16);
    const t = new Date(dna.capturedAt).getTime();
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThan(0);
  });
});

// ────────── extractTargetStructure ──────────

describe('extractTargetStructure', () => {
  it('returns the same structural shape as extractSourceDNA for the same input', () => {
    const rgba = solidBuffer(16, 16, 80, 120, 200);
    const source = extractSourceDNA(rgba, 16, 16);
    const target = extractTargetStructure(rgba, 16, 16);

    expect(target.version).toBe(source.version);
    expect(target.bands.length).toBe(source.bands.length);
    expect(target.clusters.length).toBe(source.clusters.length);
    expect(target.global.medianOklab.length).toBe(3);
  });

  it('bandCount: 5 option produces 5 bands', () => {
    const rgba = gradientBuffer(32, 32);
    const target = extractTargetStructure(rgba, 32, 32, { bandCount: 5 });
    expect(target.bands.length).toBe(5);
  });

  it('capturedAt is a valid ISO-8601 timestamp', () => {
    const rgba = solidBuffer(16, 16, 50, 100, 150);
    const target = extractTargetStructure(rgba, 16, 16);
    const t = new Date(target.capturedAt).getTime();
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThan(0);
  });
});

// ────────── pairDNA ──────────

describe('pairDNA', () => {
  it('returns 3 BandPairs with correct ordering for two default bandCount=3 DNAs', () => {
    const srcRgba = gradientBuffer(32, 32);
    const tgtRgba = solidBuffer(32, 32, 200, 150, 100);
    const source = extractSourceDNA(srcRgba, 32, 32);
    const target = extractTargetStructure(tgtRgba, 32, 32);

    const profile = pairDNA(source, target);
    expect(profile.bands.length).toBe(3);
    // Verify pairing order: band[i].source === source.bands[i]
    for (let i = 0; i < 3; i++) {
      expect(profile.bands[i].source).toBe(source.bands[i]);
      expect(profile.bands[i].target).toBe(target.bands[i]);
    }
  });

  it('throws when source has bandCount=3 and target has bandCount=5', () => {
    const srcRgba = gradientBuffer(32, 32);
    const tgtRgba = gradientBuffer(32, 32);
    const source = extractSourceDNA(srcRgba, 32, 32, { bandCount: 3 });
    const target = extractTargetStructure(tgtRgba, 32, 32, { bandCount: 5 });
    expect(() => pairDNA(source, target)).toThrow('band counts differ');
  });

  it('throws when source has bandCount=5 and target has bandCount=3', () => {
    const srcRgba = gradientBuffer(32, 32);
    const tgtRgba = gradientBuffer(32, 32);
    const source = extractSourceDNA(srcRgba, 32, 32, { bandCount: 5 });
    const target = extractTargetStructure(tgtRgba, 32, 32, { bandCount: 3 });
    expect(() => pairDNA(source, target)).toThrow('band counts differ');
  });

  it('pairs from real gradient images have viable=true (all bands above threshold)', () => {
    // Gradient image distributes pixels across bands — all should exceed 16 samples.
    const rgba = gradientBuffer(64, 64);
    const source = extractSourceDNA(rgba, 64, 64);
    const target = extractTargetStructure(rgba, 64, 64);
    const profile = pairDNA(source, target);
    for (const pair of profile.bands) {
      expect(pair.viable).toBe(true);
    }
    expect(profile.weakBands.length).toBe(0);
  });

  it('a DNA with one zero-sampleCount band produces a weakBands entry for that index', () => {
    const rgba = gradientBuffer(64, 64);
    const weakIndex = 1;
    const source = syntheticDna(3, weakIndex);
    const target = extractTargetStructure(rgba, 64, 64, { bandCount: 3 });

    const profile = pairDNA(source, target);
    expect(profile.weakBands).toContain(weakIndex);
    expect(profile.bands[weakIndex].viable).toBe(false);
  });

  it('weakBands contains only valid band indices', () => {
    const source = syntheticDna(3, 0);
    const target = syntheticDna(3, 2);
    const profile = pairDNA(source, target);

    for (const idx of profile.weakBands) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(profile.bands.length);
    }
  });

  it('profile.source and profile.target reference the originals', () => {
    const srcRgba = gradientBuffer(32, 32);
    const tgtRgba = solidBuffer(32, 32, 100, 150, 200);
    const source = extractSourceDNA(srcRgba, 32, 32);
    const target = extractTargetStructure(tgtRgba, 32, 32);
    const profile = pairDNA(source, target);
    expect(profile.source).toBe(source);
    expect(profile.target).toBe(target);
  });

  it('VIABILITY_THRESHOLD is 16', () => {
    expect(VIABILITY_THRESHOLD).toBe(16);
  });
});
