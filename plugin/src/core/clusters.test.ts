import { describe, it, expect } from "vitest";
import { segmentImage, expandPool, collapsePool } from "./clusters";

// Build a w×h RGBA buffer (alpha = 255) from a per-pixel color function.
function makeImage(
  w: number,
  h: number,
  color: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [r, g, b] = color(x, y);
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

describe("segmentImage", () => {
  it("segments a two-tone image into 2 compact pools", () => {
    const W = 64, H = 64;
    // Left half pure red, right half pure blue.
    const img = makeImage(W, H, (x) => (x < W / 2 ? [220, 30, 30] : [30, 30, 220]));

    const res = segmentImage(img, W, H, {
      poolCount: 2,
      spatialWeight: 0.6,
      subPaletteSize: 3,
    });

    expect(res.width).toBe(W);
    expect(res.height).toBe(H);
    expect(res.labels.length).toBe(W * H);
    expect(res.pools.length).toBe(2);

    // Each half is a contiguous block. x is confined to half the frame but y
    // still spans the full height, so compactness lands around 0.37 — clearly
    // localized, well above the scattered-noise floor checked below (~0).
    for (const pool of res.pools) {
      expect(pool.descriptor.compactness).toBeGreaterThan(0.3);
      expect(pool.descriptor.pixelCount).toBeGreaterThan(0);
      // A solid-color pool yields a dominant structured swatch, no noise.
      expect(pool.subPalette.length).toBeGreaterThan(0);
      expect(pool.noise).toBeNull();
    }

    // Roughly even split, weights sum to ~1.
    const totalWeight = res.pools.reduce((s, p) => s + p.descriptor.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);
    expect(res.pools[0].descriptor.weight).toBeCloseTo(0.5, 1);

    // Pools sorted by weight descending; cold start assigns ids 0..1.
    expect(res.pools[0].descriptor.weight).toBeGreaterThanOrEqual(res.pools[1].descriptor.weight);
    expect([...res.pools.map((p) => p.id)].sort()).toEqual([0, 1]);

    // A left-side pixel and a right-side pixel land in different pools.
    expect(res.labels[0]).not.toBe(res.labels[W - 1]);
  });

  it("yields low compactness for a spatially-scattered color", () => {
    const W = 64, H = 64;
    // Checkerboard of two colors: each color is scattered across the whole
    // frame, so pools cannot be spatially localized.
    const img = makeImage(W, H, (x, y) =>
      (x + y) % 2 === 0 ? [240, 240, 240] : [15, 15, 15],
    );

    const res = segmentImage(img, W, H, {
      poolCount: 2,
      spatialWeight: 0, // pure color clustering — spatial axis off
      subPaletteSize: 3,
    });

    expect(res.pools.length).toBe(2);
    // Members of each pool are strewn evenly → variance ≈ uniform baseline,
    // so compactness collapses toward 0.
    for (const pool of res.pools) {
      expect(pool.descriptor.compactness).toBeLessThan(0.2);
    }
  });

  it("reports near-1 compactness for a tight blob vs. its background", () => {
    const W = 64, H = 64;
    // Small 8×8 bright square in the corner against a dark background.
    const img = makeImage(W, H, (x, y) =>
      x < 8 && y < 8 ? [250, 250, 250] : [20, 20, 20],
    );

    // Pure color clustering (spatialWeight 0) so the blob pool is exactly the
    // 64 bright pixels — no nearby background pixels pulled in by proximity.
    const res = segmentImage(img, W, H, {
      poolCount: 2,
      spatialWeight: 0,
      subPaletteSize: 3,
    });

    expect(res.pools.length).toBe(2);
    // The tiny blob is the smaller pool (lower weight) and occupies a tiny
    // corner of the frame → tightly localized, compactness near 1.
    const blob = res.pools[res.pools.length - 1];
    expect(blob.descriptor.pixelCount).toBe(64);
    expect(blob.descriptor.compactness).toBeGreaterThan(0.9);
  });

  it("keeps pool ids stable when warm-started across a control change", () => {
    const W = 64, H = 64;
    const img = makeImage(W, H, (x) => (x < W / 2 ? [220, 30, 30] : [30, 30, 220]));

    const r1 = segmentImage(img, W, H, {
      poolCount: 2, spatialWeight: 0.5, subPaletteSize: 3,
    });
    const ids1 = r1.pools.map((p) => p.id);

    // Re-segment with one extra pool, warm-started from r1.
    const r2 = segmentImage(img, W, H, {
      poolCount: 3, spatialWeight: 0.5, subPaletteSize: 3,
    }, r1);

    expect(r2.pools.length).toBe(3);
    // The two original pool ids survive into the warm-started result, and the
    // freshly-split pool gets a new id past the previous maximum.
    for (const id of ids1) {
      expect(r2.pools.some((p) => p.id === id)).toBe(true);
    }
    expect(Math.max(...r2.pools.map((p) => p.id))).toBeGreaterThanOrEqual(2);
  });

  it("expandPool drills a pool into child pools, collapsePool restores it", () => {
    const W = 64, H = 64;
    // Four colored quadrants, so a macro pool has internal structure to find.
    const img = makeImage(W, H, (x, y) => {
      const right = x >= W / 2, bottom = y >= H / 2;
      if (!right && !bottom) return [220, 40, 40];
      if (right && !bottom) return [40, 220, 40];
      if (!right && bottom) return [40, 40, 220];
      return [220, 220, 40];
    });
    const opts = { poolCount: 2, spatialWeight: 0.4, subPaletteSize: 3 };

    const base = segmentImage(img, W, H, opts);
    const targetId = base.pools[0].id;
    const baseMaxId = Math.max(...base.pools.map((p) => p.id));

    const expanded = expandPool(base, img, targetId, opts);
    const target = expanded.pools.find((p) => p.id === targetId)!;
    expect(target.subPools).not.toBeNull();
    expect(target.subPools!.length).toBeGreaterThanOrEqual(2);
    // Child ids are fresh — past every id in the base result.
    for (const c of target.subPools!) expect(c.id).toBeGreaterThan(baseMaxId);
    // Some pixels now carry child ids instead of the parent's.
    expect(Array.from(expanded.labels)).not.toEqual(Array.from(base.labels));

    // Collapsing folds the children back and restores the parent labeling.
    const collapsed = collapsePool(expanded, targetId);
    expect(collapsed.pools.find((p) => p.id === targetId)!.subPools).toBeNull();
    expect(Array.from(collapsed.labels)).toEqual(Array.from(base.labels));
  });
});
