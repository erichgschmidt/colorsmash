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
  it("segments a two-tone image into 2 pools", () => {
    const W = 64, H = 64;
    // Left half pure red, right half pure blue.
    const img = makeImage(W, H, (x) => (x < W / 2 ? [220, 30, 30] : [30, 30, 220]));

    const res = segmentImage(img, W, H, {
      poolCount: 2,
      edgePreservation: 0.5,
      regionCleanup: 0.4,
      subPaletteSize: 3,
    });

    expect(res.width).toBe(W);
    expect(res.height).toBe(H);
    expect(res.labels.length).toBe(W * H);
    expect(res.pools.length).toBe(2);

    for (const pool of res.pools) {
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

  it("edge preservation protects a small high-contrast region from merging", () => {
    const W = 48, H = 48;
    // A dark field with a small 5×5 bright-red block — strong color contrast.
    const img = makeImage(W, H, (x, y) =>
      (x < 5 && y < 5) ? [230, 40, 40] : [50, 50, 50],
    );

    // Low edge preservation: the tiny block is absorbed into the field.
    const loose = segmentImage(img, W, H, {
      poolCount: 2, edgePreservation: 0, regionCleanup: 1, subPaletteSize: 3,
    });
    // High edge preservation: the strong color edge blocks the merge.
    const tight = segmentImage(img, W, H, {
      poolCount: 2, edgePreservation: 1, regionCleanup: 1, subPaletteSize: 3,
    });

    expect(tight.pools.length).toBeGreaterThan(loose.pools.length);
  });

  it("keeps a localized blob as its own pool at low region cleanup", () => {
    const W = 64, H = 64;
    // Small 8×8 bright square in the corner against a dark background.
    const img = makeImage(W, H, (x, y) =>
      x < 8 && y < 8 ? [250, 250, 250] : [20, 20, 20],
    );

    // Region cleanup 0 → the despeckle floor (12px); the 64px blob survives.
    const res = segmentImage(img, W, H, {
      poolCount: 2, edgePreservation: 0.5, regionCleanup: 0, subPaletteSize: 3,
    });

    expect(res.pools.length).toBe(2);
    // The blob is the smaller pool, occupying a tiny corner → tightly localized.
    const blob = res.pools[res.pools.length - 1];
    expect(blob.descriptor.pixelCount).toBeGreaterThan(40);
    expect(blob.descriptor.compactness).toBeGreaterThan(0.85);
  });

  it("keeps pool ids stable when warm-started across a control change", () => {
    const W = 60, H = 48;
    // Three vertical color stripes.
    const img = makeImage(W, H, (x) =>
      x < 20 ? [210, 40, 40] : x < 40 ? [40, 170, 40] : [40, 40, 210],
    );

    const r1 = segmentImage(img, W, H, {
      poolCount: 3, edgePreservation: 0.6, regionCleanup: 0.2, subPaletteSize: 3,
    });
    const ids1 = r1.pools.map((p) => p.id);
    expect(r1.pools.length).toBe(3);

    // Re-segment with a changed control, warm-started from r1.
    const r2 = segmentImage(img, W, H, {
      poolCount: 3, edgePreservation: 0.6, regionCleanup: 0.6, subPaletteSize: 3,
    }, r1);

    // The original pool ids are carried forward by the warm-start match.
    for (const id of ids1) {
      expect(r2.pools.some((p) => p.id === id)).toBe(true);
    }
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
    const opts = {
      poolCount: 2, edgePreservation: 0.6, regionCleanup: 0.3, subPaletteSize: 3,
    };

    const base = segmentImage(img, W, H, opts);
    const targetId = base.pools[0].id;
    const baseMaxId = Math.max(...base.pools.map((p) => p.id));

    const expanded = expandPool(base, img, targetId, opts);
    const target = expanded.pools.find((p) => p.id === targetId)!;
    expect(target.subPools).not.toBeNull();
    expect(target.subPools!.length).toBeGreaterThanOrEqual(1);
    // Child ids are fresh — past every id in the base result.
    for (const c of target.subPools!) expect(c.id).toBeGreaterThan(baseMaxId);

    // Collapsing folds the children back and restores the parent labeling.
    const collapsed = collapsePool(expanded, targetId);
    expect(collapsed.pools.find((p) => p.id === targetId)!.subPools).toBeNull();
    expect(Array.from(collapsed.labels)).toEqual(Array.from(base.labels));
  });
});
