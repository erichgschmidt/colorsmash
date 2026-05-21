import { describe, it, expect } from "vitest";
import {
  segmentImage, expandPool, collapsePool,
  applySplits, buildPoolsFromLabels, buildSplitBlendWeight,
  SPLIT_ID_BASE, SPLIT_ID_STRIDE,
} from "./clusters";
import type { SplitEdit } from "./clusters";

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
      colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
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
      poolCount: 2, edgePreservation: 0, regionCleanup: 1, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
    });
    // High edge preservation: the strong color edge blocks the merge.
    const tight = segmentImage(img, W, H, {
      poolCount: 2, edgePreservation: 1, regionCleanup: 1, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
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
      poolCount: 2, edgePreservation: 0.5, regionCleanup: 0, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
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
      poolCount: 3, edgePreservation: 0.6, regionCleanup: 0.2, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
    });
    const ids1 = r1.pools.map((p) => p.id);
    expect(r1.pools.length).toBe(3);

    // Re-segment with a changed control, warm-started from r1.
    const r2 = segmentImage(img, W, H, {
      poolCount: 3, edgePreservation: 0.6, regionCleanup: 0.6, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
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
      poolCount: 2, edgePreservation: 0.6, regionCleanup: 0.3, colorVsValueBias: 0.5, subPaletteSize: 3,
      neutralProtection: 0, poolContinuity: 0,
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

  it("poolContinuity unifies chromatically-near clusters across spatial separation", () => {
    const W = 96, H = 32;
    // Three vertical bands: similar red | gray sash | similar red.
    // With continuity = 0, k=3 should produce 3 distinct pools.
    // With continuity > 0 high enough to fold the two reds together, the
    // result should drop to 2 pools — one unified red (spanning both ends)
    // and the gray sash. The dress-under-sash test.
    const img = makeImage(W, H, (x) => {
      if (x < W / 3) return [200, 60, 60];        // red half A
      if (x < 2 * W / 3) return [150, 150, 150];  // gray sash
      return [205, 65, 55];                       // red half B (very similar)
    });

    const optsBase = {
      poolCount: 3, edgePreservation: 0.5, regionCleanup: 0.2,
      colorVsValueBias: 0.5, subPaletteSize: 3, neutralProtection: 0,
    };

    const noUnify = segmentImage(img, W, H, { ...optsBase, poolContinuity: 0 });
    const withUnify = segmentImage(img, W, H, { ...optsBase, poolContinuity: 0.6 });

    expect(noUnify.pools.length).toBe(3);
    // The two reds collapse → 2 pools (one large unified red + gray).
    expect(withUnify.pools.length).toBeLessThan(noUnify.pools.length);
    // The biggest pool covers >50% of the image (the two red bands together).
    expect(withUnify.pools[0].descriptor.weight).toBeGreaterThan(0.5);
  });
});

describe("applySplits", () => {
  const OPTS = {
    poolCount: 1, edgePreservation: 0.5, regionCleanup: 0.2,
    colorVsValueBias: 0.5, subPaletteSize: 3, neutralProtection: 0,
    poolContinuity: 0,
  };

  // A 64×64 image whose left half is one near-shadow colour and right half a
  // slightly different near-shadow colour — the "two things fused into one
  // pool" case. Segmented at poolCount=1 they merge; a split should separate.
  function fusedShadowImage() {
    const W = 64, H = 64;
    const img = makeImage(W, H, (x) =>
      x < W / 2 ? [60, 58, 70] : [58, 64, 60],
    );
    return { img, W, H };
  }

  it("no edits returns the base result unchanged", () => {
    const { img, W, H } = fusedShadowImage();
    const base = segmentImage(img, W, H, OPTS);
    const out = applySplits(base, img, [], OPTS);
    expect(out).toBe(base);
  });

  it("splits a fused pool into edge-following parts within the circle", () => {
    const { img, W, H } = fusedShadowImage();
    const base = segmentImage(img, W, H, OPTS);
    expect(base.pools.length).toBe(1); // the two halves fused at poolCount=1

    const edit: SplitEdit = {
      id: "e1", nx: 0.5, ny: 0.5, radius: 0.6, partCount: 2,
      baseId: SPLIT_ID_BASE,
    };
    const out = applySplits(base, img, [edit], OPTS);

    // The split introduced new pools in the reserved id range.
    expect(out.pools.length).toBeGreaterThan(base.pools.length);
    const splitPools = out.pools.filter((p) => p.id >= SPLIT_ID_BASE);
    expect(splitPools.length).toBeGreaterThanOrEqual(2);

    // A pixel on the left vs right (both inside the circle) land in different
    // pools now — the fused colours were separated along the real edge.
    const leftIdx = (H / 2) * W + (W / 2 - 8);
    const rightIdx = (H / 2) * W + (W / 2 + 8);
    expect(out.labels[leftIdx]).not.toBe(out.labels[rightIdx]);
    expect(out.labels[leftIdx]).toBeGreaterThanOrEqual(SPLIT_ID_BASE);
    expect(out.labels[rightIdx]).toBeGreaterThanOrEqual(SPLIT_ID_BASE);

    // Pool weights still sum to ~1 after the rebuild.
    const totalWeight = out.pools.reduce((s, p) => s + p.descriptor.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);
  });

  it("keeps split-part ids stable across a re-segmentation (persistence)", () => {
    const { img, W, H } = fusedShadowImage();
    const edit: SplitEdit = {
      id: "e1", nx: 0.5, ny: 0.5, radius: 0.6, partCount: 2,
      baseId: SPLIT_ID_BASE,
    };

    // Two different base segmentations (different control), same edit.
    const baseA = segmentImage(img, W, H, OPTS);
    const baseB = segmentImage(img, W, H, { ...OPTS, regionCleanup: 0.6 });

    const outA = applySplits(baseA, img, [edit], OPTS);
    const outB = applySplits(baseB, img, [edit], { ...OPTS, regionCleanup: 0.6 });

    const idsA = outA.pools.filter((p) => p.id >= SPLIT_ID_BASE).map((p) => p.id).sort();
    const idsB = outB.pools.filter((p) => p.id >= SPLIT_ID_BASE).map((p) => p.id).sort();
    // The reserved id range is deterministic, so the split's part ids are the
    // same set both times — a donor mapping to a split survives the re-segment.
    expect(idsA).toEqual(idsB);
    expect(idsA.every((id) => id >= SPLIT_ID_BASE && id < SPLIT_ID_BASE + SPLIT_ID_STRIDE)).toBe(true);
  });

  it("gives separate edits non-overlapping id ranges", () => {
    const W = 96, H = 48;
    // Two distinct fused regions, one on each side.
    const img = makeImage(W, H, (x) =>
      x < W / 2
        ? (x < W / 4 ? [60, 58, 70] : [58, 64, 60])
        : (x < 3 * W / 4 ? [120, 70, 70] : [120, 80, 64]),
    );
    const base = segmentImage(img, W, H, { ...OPTS, poolCount: 2 });

    const edits: SplitEdit[] = [
      { id: "a", nx: 0.25, ny: 0.5, radius: 0.3, partCount: 2, baseId: SPLIT_ID_BASE },
      { id: "b", nx: 0.75, ny: 0.5, radius: 0.3, partCount: 2, baseId: SPLIT_ID_BASE + SPLIT_ID_STRIDE },
    ];
    const out = applySplits(base, img, edits, { ...OPTS, poolCount: 2 });

    const aIds = out.pools.filter((p) => p.id >= SPLIT_ID_BASE && p.id < SPLIT_ID_BASE + SPLIT_ID_STRIDE);
    const bIds = out.pools.filter((p) => p.id >= SPLIT_ID_BASE + SPLIT_ID_STRIDE);
    expect(aIds.length).toBeGreaterThanOrEqual(1);
    expect(bIds.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildPoolsFromLabels", () => {
  it("rebuilds pools keyed by the ids present in the label map", () => {
    const W = 32, H = 32;
    const img = makeImage(W, H, (x) => (x < W / 2 ? [200, 40, 40] : [40, 40, 200]));
    // Hand-built label map: left half id 5, right half id 9.
    const labels = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        labels[y * W + x] = x < W / 2 ? 5 : 9;
      }
    }
    const pools = buildPoolsFromLabels(img, W, H, labels, 3);
    expect(pools.map((p) => p.id).sort((a, b) => a - b)).toEqual([5, 9]);
    const total = pools.reduce((s, p) => s + p.descriptor.weight, 0);
    expect(total).toBeCloseTo(1, 5);
    for (const p of pools) {
      expect(p.descriptor.pixelCount).toBe((W * H) / 2);
    }
  });

  it("drops ids that have no pixels and ignores -1 (transparent)", () => {
    const W = 16, H = 16;
    const img = makeImage(W, H, () => [128, 128, 128]);
    const labels = new Int32Array(W * H).fill(-1);
    // Only a few pixels carry id 3; everything else transparent.
    for (let i = 0; i < 10; i++) labels[i] = 3;
    const pools = buildPoolsFromLabels(img, W, H, labels, 3);
    expect(pools.length).toBe(1);
    expect(pools[0].id).toBe(3);
    expect(pools[0].descriptor.pixelCount).toBe(10);
  });
});

describe("buildSplitBlendWeight", () => {
  it("returns null when no split has feather", () => {
    const edits: SplitEdit[] = [
      { id: "a", nx: 0.5, ny: 0.5, radius: 0.3, partCount: 2, baseId: SPLIT_ID_BASE },
      { id: "b", nx: 0.2, ny: 0.2, radius: 0.2, partCount: 2, baseId: SPLIT_ID_BASE + SPLIT_ID_STRIDE, feather: 0 },
    ];
    expect(buildSplitBlendWeight(32, 32, edits)).toBeNull();
  });

  it("is 1 in the core, ramps 1→0 across the band, and 0 outside", () => {
    const W = 100, H = 100;
    // Centred split, radius 0.4 of maxEdge (=40px), feather 0.5 → inner 20px.
    const edits: SplitEdit[] = [
      { id: "a", nx: 0.5, ny: 0.5, radius: 0.4, partCount: 2, baseId: SPLIT_ID_BASE, feather: 0.5 },
    ];
    const w = buildSplitBlendWeight(W, H, edits)!;
    expect(w).not.toBeNull();

    const at = (x: number, y: number) => w[y * W + x];
    const cx = 50, cy = 50;
    // Core (d=0 and d≈18, inside inner 20px) → fully use the split result.
    expect(at(cx, cy)).toBeCloseTo(1, 5);
    expect(at(cx + 18, cy)).toBeCloseTo(1, 5);
    // Mid band (d≈30px) → partial blend.
    const mid = at(cx + 30, cy);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Outside the outer radius (d≈45px) → use the base (no-split) result.
    expect(at(cx + 45, cy)).toBeCloseTo(0, 5);
  });
});
