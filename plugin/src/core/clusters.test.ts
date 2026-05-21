import { describe, it, expect } from "vitest";
import {
  segmentImage, expandPool, collapsePool,
  applySplits, buildPoolsFromLabels, buildSplitBlendWeight,
  refineMacros, keptRegionMask,
  SPLIT_ID_BASE, SPLIT_ID_STRIDE,
  MACRO_REFINE_BASE, MACRO_REFINE_STRIDE,
  EXCL_ID_BASE, EXCL_ID_STRIDE,
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

describe("polygon (lasso) splits", () => {
  const OPTS = {
    poolCount: 1, edgePreservation: 0.5, regionCleanup: 0.2,
    colorVsValueBias: 0.5, subPaletteSize: 3, neutralProtection: 0,
    poolContinuity: 0,
  };

  it("applySplits relabels pixels INSIDE the polygon, not outside", () => {
    const W = 64, H = 64;
    // Two near-shadow halves fused at poolCount=1 (same as the circle test).
    const img = makeImage(W, H, (x) => (x < W / 2 ? [60, 58, 70] : [58, 64, 60]));
    const base = segmentImage(img, W, H, OPTS);
    expect(base.pools.length).toBe(1);

    // A polygon covering only the LEFT-CENTRE area (a diamond around (0.25,0.5)).
    const edit: SplitEdit = {
      id: "poly1", nx: 0.25, ny: 0.5, radius: 0, partCount: 2,
      baseId: SPLIT_ID_BASE,
      points: [
        { x: 0.10, y: 0.5 }, { x: 0.25, y: 0.30 },
        { x: 0.40, y: 0.5 }, { x: 0.25, y: 0.70 },
      ],
    };
    const out = applySplits(base, img, [edit], OPTS);

    // A pixel well inside the diamond got a split-range id…
    const insideIdx = (H / 2) * W + Math.round(0.25 * W);
    expect(out.labels[insideIdx]).toBeGreaterThanOrEqual(SPLIT_ID_BASE);
    // …a pixel far outside (right half) kept its base id.
    const outsideIdx = (H / 2) * W + Math.round(0.85 * W);
    expect(out.labels[outsideIdx]).toBeLessThan(SPLIT_ID_BASE);
    // Pool weights still sum to ~1.
    const total = out.pools.reduce((s, p) => s + p.descriptor.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("buildSplitBlendWeight gives a polygon split an inward feather (1 core → 0 edge → 0 outside)", () => {
    const W = 100, H = 100;
    const edit: SplitEdit = {
      id: "poly1", nx: 0.5, ny: 0.5, radius: 0, partCount: 2,
      baseId: SPLIT_ID_BASE, feather: 0.6,
      // Big centred square [0.2..0.8].
      points: [
        { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 },
      ],
    };
    const w = buildSplitBlendWeight(W, H, [edit])!;
    expect(w).not.toBeNull();
    const at = (x: number, y: number) => w[y * W + x];
    // Deep centre → full split.
    expect(at(50, 50)).toBeCloseTo(1, 5);
    // Just inside an edge → partial (feathered).
    const nearEdge = at(50, 78);
    expect(nearEdge).toBeGreaterThanOrEqual(0);
    expect(nearEdge).toBeLessThan(1);
    // Outside the polygon → base (0).
    expect(at(50, 95)).toBeCloseTo(0, 5);
  });
});

describe("refineMacros", () => {
  // A full SegmentOptions object — every field present so merged overrides only
  // change what they intend to.
  const OPTS = {
    poolCount: 2, edgePreservation: 0.5, regionCleanup: 0.2,
    colorVsValueBias: 0.5, subPaletteSize: 3, neutralProtection: 0,
    poolContinuity: 0,
  };

  // 64×64 image with four clearly-distinct coloured quadrants — rich internal
  // colour structure for a refine pass to subdivide.
  function quadImage() {
    const W = 64, H = 64;
    const img = makeImage(W, H, (x, y) => {
      const right = x >= W / 2, bottom = y >= H / 2;
      if (!right && !bottom) return [220, 40, 40];   // red
      if (right && !bottom) return [40, 220, 40];    // green
      if (!right && bottom) return [40, 40, 220];    // blue
      return [220, 220, 40];                         // yellow
    });
    return { img, W, H };
  }

  // The reserved refined-id range for a given macro id.
  const refineLo = (macroId: number) => MACRO_REFINE_BASE + macroId * MACRO_REFINE_STRIDE;
  const refineHi = (macroId: number) => refineLo(macroId) + MACRO_REFINE_STRIDE;
  const inRefineRange = (id: number, macroId: number) =>
    id >= refineLo(macroId) && id < refineHi(macroId);

  it("empty perMacroOpts returns the SAME base object and the same macros (identity)", () => {
    const { img, W, H } = quadImage();
    const base = segmentImage(img, W, H, OPTS);
    const macros = [{ id: 0, poolIds: base.pools.map((p) => p.id) }];

    const out = refineMacros(base, img, macros, OPTS, new Map());
    expect(out.result).toBe(base);          // identity — no copy made
    expect(out.macros).toBe(macros);        // macros passed straight through
  });

  it("a poolCount override re-segments ONLY that macro's pixels into more pools", () => {
    const { img, W, H } = quadImage();
    // Base at poolCount 2 → the four quadrants collapse into 2 pools.
    const base = segmentImage(img, W, H, OPTS);
    const basePoolIds = base.pools.map((p) => p.id);

    // One macro covering EVERYTHING.
    const macros = [{ id: 0, poolIds: [...basePoolIds] }];
    const before = macros[0].poolIds.length;

    // Refine macro 0 with a higher pool count → it should resolve more pools.
    const perMacroOpts = new Map([[0, { poolCount: 4 }]]);
    const out = refineMacros(base, img, macros, OPTS, perMacroOpts);

    const m0 = out.macros.find((m) => m.id === 0)!;
    // More pool ids than before, ≥3 of them, all in macro 0's reserved range.
    expect(m0.poolIds.length).toBeGreaterThan(before);
    expect(m0.poolIds.length).toBeGreaterThanOrEqual(3);
    for (const id of m0.poolIds) expect(inRefineRange(id, 0)).toBe(true);

    // The pool descriptors in the result that belong to macro 0 are also in range.
    const refinedPools = out.result.pools.filter((p) => inRefineRange(p.id, 0));
    expect(refinedPools.length).toBeGreaterThanOrEqual(3);

    // A NEW result object, not the base.
    expect(out.result).not.toBe(base);
  });

  it("refined pixels get reserved ids; pixels outside the refined macro are unchanged", () => {
    const { img, W, H } = quadImage();
    // Base at poolCount 4 so every quadrant is its own pool.
    const base = segmentImage(img, W, H, { ...OPTS, poolCount: 4 });

    // Macro 0 = the RED quadrant (top-left) only. Find which base pool owns it.
    const redIdx = (H / 4) * W + (W / 4);
    const redPoolId = base.labels[redIdx];
    expect(redPoolId).toBeGreaterThanOrEqual(0);

    // Macro 1 = a different quadrant (green, top-right) — left untouched.
    const greenIdx = (H / 4) * W + (3 * W / 4);
    const greenPoolId = base.labels[greenIdx];

    const macros = [
      { id: 0, poolIds: [redPoolId] },
      { id: 1, poolIds: [greenPoolId] },
    ];
    const perMacroOpts = new Map([[0, { poolCount: 2 }]]);
    const out = refineMacros(base, img, macros, OPTS, perMacroOpts);

    // The red pixel's label is now a refined id in macro 0's range.
    expect(inRefineRange(out.result.labels[redIdx], 0)).toBe(true);

    // The green pixel (outside the refined macro) keeps its original base id.
    expect(out.result.labels[greenIdx]).toBe(greenPoolId);

    // Macro 1, which had no override, keeps its poolIds unchanged.
    const m1 = out.macros.find((m) => m.id === 1)!;
    expect(m1.poolIds).toEqual([greenPoolId]);

    // Every pixel that was NOT red is byte-for-byte unchanged from the base.
    for (let i = 0; i < base.labels.length; i++) {
      if (base.labels[i] === redPoolId) continue;
      expect(out.result.labels[i]).toBe(base.labels[i]);
    }
  });

  it("the result's pool weights still sum to ~1", () => {
    const { img, W, H } = quadImage();
    const base = segmentImage(img, W, H, OPTS);
    const macros = [{ id: 0, poolIds: base.pools.map((p) => p.id) }];
    const out = refineMacros(base, img, macros, OPTS, new Map([[0, { poolCount: 4 }]]));

    const total = out.result.pools.reduce((s, p) => s + p.descriptor.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("preserves split pools inside a refined macro (split ids are not re-segmented)", () => {
    const { img, W, H } = quadImage();
    const base = segmentImage(img, W, H, { ...OPTS, poolCount: 4 });

    // Carve a split inside the RED quadrant (top-left) — a small circle.
    const edit: SplitEdit = {
      id: "s1", nx: 0.25, ny: 0.25, radius: 0.12, partCount: 2,
      baseId: SPLIT_ID_BASE,
    };
    const withSplit = applySplits(base, img, [edit], { ...OPTS, poolCount: 4 });

    // Collect the split pool ids that landed (≥ SPLIT_ID_BASE) and a sample
    // pixel that belongs to a split pool.
    const splitIds = withSplit.pools
      .filter((p) => p.id >= SPLIT_ID_BASE)
      .map((p) => p.id);
    expect(splitIds.length).toBeGreaterThanOrEqual(1);
    let splitPixel = -1;
    for (let i = 0; i < withSplit.labels.length; i++) {
      if (withSplit.labels[i] >= SPLIT_ID_BASE) { splitPixel = i; break; }
    }
    expect(splitPixel).toBeGreaterThanOrEqual(0);

    // Macro 0 owns the red quadrant's base pools PLUS the split pools.
    // Base pool ids still present in the red region (some pixels weren't covered
    // by the split circle, so the red base pool typically survives too).
    const redBaseIds = new Set<number>();
    for (let y = 0; y < H / 2; y++) {
      for (let x = 0; x < W / 2; x++) {
        const id = withSplit.labels[y * W + x];
        if (id >= 0 && id < SPLIT_ID_BASE) redBaseIds.add(id);
      }
    }
    const macros = [{
      id: 0,
      poolIds: [...redBaseIds, ...splitIds],
    }];

    const out = refineMacros(withSplit, img, macros, { ...OPTS, poolCount: 4 },
      new Map([[0, { poolCount: 3 }]]));

    // The split pixel is still owned by a split-range id (NOT re-segmented).
    expect(out.result.labels[splitPixel]).toBeGreaterThanOrEqual(SPLIT_ID_BASE);

    // Every split id stays in macro 0's poolIds.
    const m0 = out.macros.find((m) => m.id === 0)!;
    for (const sid of splitIds) expect(m0.poolIds).toContain(sid);
    // …and macro 0 also gained refined-range pools for its non-split pixels.
    expect(m0.poolIds.some((id) => inRefineRange(id, 0))).toBe(true);

    // No split pixel anywhere was relabelled out of the split range.
    for (let i = 0; i < withSplit.labels.length; i++) {
      if (withSplit.labels[i] >= SPLIT_ID_BASE) {
        expect(out.result.labels[i]).toBe(withSplit.labels[i]);
      }
    }
  });

  it("a macro NOT in perMacroOpts keeps its poolIds unchanged", () => {
    const { img, W, H } = quadImage();
    const base = segmentImage(img, W, H, { ...OPTS, poolCount: 4 });

    const redIdx = (H / 4) * W + (W / 4);
    const greenIdx = (H / 4) * W + (3 * W / 4);
    const redPoolId = base.labels[redIdx];
    const greenPoolId = base.labels[greenIdx];

    const macros = [
      { id: 0, poolIds: [redPoolId] },
      { id: 1, poolIds: [greenPoolId] },
    ];
    // Only macro 0 is refined.
    const out = refineMacros(base, img, macros, { ...OPTS, poolCount: 4 },
      new Map([[0, { poolCount: 2 }]]));

    const m1 = out.macros.find((m) => m.id === 1)!;
    expect(m1.poolIds).toEqual([greenPoolId]);
    // The input macros array was not mutated.
    expect(macros[1].poolIds).toEqual([greenPoolId]);
  });
});

describe("colour exclusion (subtract a colour from a region)", () => {
  const OPTS = {
    poolCount: 1, edgePreservation: 0.5, regionCleanup: 0.2,
    colorVsValueBias: 0.5, subPaletteSize: 3, neutralProtection: 0,
    poolContinuity: 0,
  };

  // Left half red, right half blue — a lasso over the whole image, excluding red.
  function twoToneImage() {
    const W = 64, H = 64;
    const img = makeImage(W, H, (x) => (x < W / 2 ? [200, 40, 40] : [40, 40, 200]));
    return { img, W, H };
  }

  it("relabels excluded pixels into the exclusion id range, keeps the rest", () => {
    const { img, W, H } = twoToneImage();
    const base = segmentImage(img, W, H, { ...OPTS, poolCount: 1 });
    // Lab of red ≈ the left half. Exclude colours near red.
    const redLab = (() => { const o = (32 * W + 16) * 4; return img.slice(o, o + 3); })();
    // crude rgb→approx not needed; use a wide tol around the pool's mean via segment.
    const split: SplitEdit = {
      id: "r1", nx: 0.5, ny: 0.5, radius: 0, partCount: 2, baseId: SPLIT_ID_BASE,
      points: [ { x: 0.02, y: 0.02 }, { x: 0.98, y: 0.02 }, { x: 0.98, y: 0.98 }, { x: 0.02, y: 0.98 } ],
      colorExclusions: [
        // Red in Lab ≈ L53 a61 b46 (200,40,40). Use a generous tolerance.
        { id: "ex1", labL: 53, labA: 61, labB: 46, tol: 40, exclBaseId: EXCL_ID_BASE, macroId: 1 },
      ],
    };
    const out = applySplits(base, img, [split], OPTS);

    // A left (red) pixel → excluded range; a right (blue) pixel → split range.
    const leftIdx = 32 * W + 12;
    const rightIdx = 32 * W + 52;
    expect(out.labels[leftIdx]).toBeGreaterThanOrEqual(EXCL_ID_BASE);
    expect(out.labels[leftIdx]).toBeLessThan(EXCL_ID_BASE + EXCL_ID_STRIDE);
    expect(out.labels[rightIdx]).toBeGreaterThanOrEqual(SPLIT_ID_BASE);
    expect(out.labels[rightIdx]).toBeLessThan(SPLIT_ID_BASE + SPLIT_ID_STRIDE);
    void redLab;
  });

  it("keptRegionMask drops the excluded colour and keeps the rest", () => {
    const { img, W, H } = twoToneImage();
    const split: SplitEdit = {
      id: "r1", nx: 0.5, ny: 0.5, radius: 0, partCount: 2, baseId: SPLIT_ID_BASE,
      points: [ { x: 0.02, y: 0.02 }, { x: 0.98, y: 0.02 }, { x: 0.98, y: 0.98 }, { x: 0.02, y: 0.98 } ],
      colorExclusions: [
        { id: "ex1", labL: 53, labA: 61, labB: 46, tol: 40, exclBaseId: EXCL_ID_BASE, macroId: 1 },
      ],
    };
    const mask = keptRegionMask(split, img, W, H);
    expect(mask[32 * W + 12]).toBe(0); // red → excluded → not kept
    expect(mask[32 * W + 52]).toBe(1); // blue → kept
  });
});
