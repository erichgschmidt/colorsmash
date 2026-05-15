// Tests for the cluster adapter (clusters.ts).
// Uses synthetic RGBA buffers to exercise extractClusters and the pure
// helpers without touching the filesystem.

import { describe, it, expect } from 'vitest';
import {
  extractClusters,
  applyClusterMultipliers,
  lockCluster,
  anchorCluster,
} from './clusters';

// ────────── helpers ──────────

/** Build a flat RGBA buffer filled with a single opaque color. */
function solidBuffer(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/** Build a buffer where the left half is one color and the right half another. */
function halvedBuffer(
  width: number,
  height: number,
  leftR: number, leftG: number, leftB: number,
  rightR: number, rightG: number, rightB: number,
): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const isLeft = x < width / 2;
      buf[i] = isLeft ? leftR : rightR;
      buf[i + 1] = isLeft ? leftG : rightG;
      buf[i + 2] = isLeft ? leftB : rightB;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ────────── extractClusters ──────────

describe('extractClusters', () => {
  it('solid red 32x32 yields at least one cluster close to [255, 0, 0]', () => {
    const rgba = solidBuffer(32, 32, 255, 0, 0);
    const clusters = extractClusters(rgba, 32, 32);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const [r, g, b] = clusters[0].rgb;
    expect(r).toBeGreaterThanOrEqual(250);
    expect(g).toBeLessThanOrEqual(5);
    expect(b).toBeLessThanOrEqual(5);
  });

  it('half-red half-blue 64x32 with k=3 yields <= 3 clusters; top 2 are red and blue', () => {
    const rgba = halvedBuffer(64, 32, 255, 0, 0, 0, 0, 255);
    const clusters = extractClusters(rgba, 64, 32, 3);
    // k=3 is requested but dead clusters are dropped, so we may get 2 or 3.
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters.length).toBeLessThanOrEqual(3);

    // The two highest-weight clusters should approximate red and blue.
    const top2 = clusters.slice(0, 2);
    const hasRed = top2.some(c => c.rgb[0] > 200 && c.rgb[1] < 55 && c.rgb[2] < 55);
    const hasBlue = top2.some(c => c.rgb[0] < 55 && c.rgb[1] < 55 && c.rgb[2] > 200);
    expect(hasRed).toBe(true);
    expect(hasBlue).toBe(true);
  });

  it('cluster id equals its array index', () => {
    const rgba = halvedBuffer(64, 32, 255, 0, 0, 0, 0, 255);
    const clusters = extractClusters(rgba, 64, 32, 3);
    clusters.forEach((c, i) => {
      expect(c.id).toBe(i);
    });
  });

  it('all clusters start with multiplier 1, locked false, anchor false', () => {
    const rgba = solidBuffer(32, 32, 100, 150, 200);
    const clusters = extractClusters(rgba, 32, 32);
    for (const c of clusters) {
      expect(c.multiplier).toBe(1);
      expect(c.locked).toBe(false);
      expect(c.anchor).toBe(false);
    }
  });

  it('centroidOklab[0] (L) is in [0, 1.05] for all clusters', () => {
    const rgba = halvedBuffer(64, 32, 255, 200, 50, 30, 80, 200);
    const clusters = extractClusters(rgba, 64, 32, 3);
    for (const c of clusters) {
      expect(c.centroidOklab[0]).toBeGreaterThanOrEqual(0);
      expect(c.centroidOklab[0]).toBeLessThanOrEqual(1.05);
    }
  });

  it('k below 3 or above 32 throws (Phase 4.5j widened from {3,5,7} to [3, 32])', () => {
    const rgba = solidBuffer(32, 32, 100, 100, 100);
    expect(() => extractClusters(rgba, 32, 32, 2)).toThrow();
    expect(() => extractClusters(rgba, 32, 32, 33)).toThrow();
    expect(() => extractClusters(rgba, 32, 32, 0)).toThrow();
    expect(() => extractClusters(rgba, 32, 32, -1)).toThrow();
    expect(() => extractClusters(rgba, 32, 32, 4.5)).toThrow(); // non-integer
  });

  it('k=4, 8, 16, 32 are accepted (Phase 4.5j widened range)', () => {
    const rgba = halvedBuffer(64, 32, 255, 200, 50, 30, 80, 200);
    for (const k of [4, 8, 16, 32]) {
      const clusters = extractClusters(rgba, 64, 32, k);
      expect(clusters.length).toBeLessThanOrEqual(k);
      expect(clusters.length).toBeGreaterThan(0);
    }
  });

  it('k=3 returns at most 3 clusters', () => {
    const rgba = solidBuffer(32, 32, 80, 120, 200);
    const clusters = extractClusters(rgba, 32, 32, 3);
    expect(clusters.length).toBeLessThanOrEqual(3);
  });

  it('1x1 fully transparent buffer yields zero clusters', () => {
    const rgba = new Uint8Array([128, 0, 0, 0]); // alpha = 0
    const clusters = extractClusters(rgba, 1, 1);
    expect(clusters.length).toBe(0);
  });
});

// ────────── applyClusterMultipliers ──────────

describe('applyClusterMultipliers', () => {
  function makeClusters(k: 3 | 5 | 7 = 3) {
    const rgba = halvedBuffer(64, 32, 255, 0, 0, 0, 0, 255);
    return extractClusters(rgba, 64, 32, k);
  }

  it('all-ones multipliers: weights equal naturals', () => {
    const clusters = makeClusters(3);
    const ones = clusters.map(() => 1);
    const result = applyClusterMultipliers(clusters, ones);
    result.forEach((c, i) => {
      expect(c.weight).toBeCloseTo(clusters[i].natural, 10);
    });
  });

  it('first multiplier 2: cluster 0 weight is 2x natural, others unchanged', () => {
    const clusters = makeClusters(3);
    const mults = clusters.map((_, i) => i === 0 ? 2 : 1);
    const result = applyClusterMultipliers(clusters, mults);
    expect(result[0].weight).toBeCloseTo(clusters[0].natural * 2, 10);
    for (let i = 1; i < clusters.length; i++) {
      expect(result[i].weight).toBeCloseTo(clusters[i].natural, 10);
    }
  });

  it('length mismatch throws', () => {
    const clusters = makeClusters(3);
    // clusters may have 2 or 3 entries; use a length that will never match (0).
    expect(() => applyClusterMultipliers(clusters, [])).toThrow('multipliers length does not match clusters');
  });

  it('original array is not mutated', () => {
    const clusters = makeClusters(3);
    const originalWeights = clusters.map(c => c.weight);
    applyClusterMultipliers(clusters, clusters.map(() => 99));
    clusters.forEach((c, i) => {
      expect(c.weight).toBe(originalWeights[i]);
    });
  });
});

// ────────── lockCluster ──────────

describe('lockCluster', () => {
  function makeClusters() {
    const rgba = halvedBuffer(64, 32, 255, 0, 0, 0, 0, 255);
    return extractClusters(rgba, 64, 32, 3);
  }

  it('returns a new array (reference differs)', () => {
    const clusters = makeClusters();
    const result = lockCluster(clusters, 0, true);
    expect(result).not.toBe(clusters);
  });

  it('original cluster 0 stays unlocked after lock call', () => {
    const clusters = makeClusters();
    lockCluster(clusters, 0, true);
    expect(clusters[0].locked).toBe(false);
  });

  it('new cluster 0 has locked=true', () => {
    const clusters = makeClusters();
    const result = lockCluster(clusters, 0, true);
    expect(result[0].locked).toBe(true);
  });

  it('other clusters are unchanged', () => {
    const clusters = makeClusters();
    const result = lockCluster(clusters, 0, true);
    for (let i = 1; i < clusters.length; i++) {
      expect(result[i]).toBe(clusters[i]);
    }
  });

  it('out-of-range index throws', () => {
    const clusters = makeClusters();
    expect(() => lockCluster(clusters, clusters.length, true)).toThrow();
    expect(() => lockCluster(clusters, -1, true)).toThrow();
  });

  it('can unlock a previously locked cluster', () => {
    const clusters = makeClusters();
    const locked = lockCluster(clusters, 1, true);
    const unlocked = lockCluster(locked, 1, false);
    expect(unlocked[1].locked).toBe(false);
  });
});

// ────────── anchorCluster ──────────

describe('anchorCluster', () => {
  function makeClusters() {
    const rgba = halvedBuffer(64, 32, 255, 0, 0, 0, 0, 255);
    return extractClusters(rgba, 64, 32, 3);
  }

  it('returns a new array (reference differs)', () => {
    const clusters = makeClusters();
    const result = anchorCluster(clusters, 0, true);
    expect(result).not.toBe(clusters);
  });

  it('original cluster 0 stays unanchored after anchor call', () => {
    const clusters = makeClusters();
    anchorCluster(clusters, 0, true);
    expect(clusters[0].anchor).toBe(false);
  });

  it('new cluster 0 has anchor=true', () => {
    const clusters = makeClusters();
    const result = anchorCluster(clusters, 0, true);
    expect(result[0].anchor).toBe(true);
  });

  it('other clusters are unchanged', () => {
    const clusters = makeClusters();
    const result = anchorCluster(clusters, 0, true);
    for (let i = 1; i < clusters.length; i++) {
      expect(result[i]).toBe(clusters[i]);
    }
  });

  it('out-of-range index throws', () => {
    const clusters = makeClusters();
    expect(() => anchorCluster(clusters, clusters.length, true)).toThrow();
    expect(() => anchorCluster(clusters, -1, true)).toThrow();
  });

  it('can unanchor a previously anchored cluster', () => {
    const clusters = makeClusters();
    // Use index 1 which always exists (red+blue image yields >=2 clusters).
    const anchored = anchorCluster(clusters, 1, true);
    const unanchored = anchorCluster(anchored, 1, false);
    expect(unanchored[1].anchor).toBe(false);
  });
});
