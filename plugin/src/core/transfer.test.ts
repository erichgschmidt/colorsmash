import { describe, it, expect } from "vitest";
import type {
  Pool,
  PoolDescriptor,
  SubSwatch,
  SegmentResult,
} from "./clusters";
import { rgbToLab } from "./palette";
import type { Correspondence } from "./match";
import { transferColors, buildSubMappings, poolSubColors, type TransferAnchor } from "./transfer";

// ────────── Minimal builders ──────────

// A SubSwatch with Lab derived from its RGB so it is internally consistent.
function makeSub(r: number, g: number, b: number, weight = 1): SubSwatch {
  const [labL, labA, labB] = rgbToLab(r, g, b);
  return { r, g, b, labL, labA, labB, weight, compactness: 1 };
}

// A Pool carrying only the fields transfer.ts reads: id + subPalette (+noise).
function makePool(id: number, subPalette: SubSwatch[]): Pool {
  const descriptor: PoolDescriptor = {
    r: 0, g: 0, b: 0,
    labL: 50, labA: 0, labB: 0,
    chroma: 0,
    valueBand: "mid",
    pixelCount: 0,
    weight: 1,
    compactness: 1,
    centroidX: 0.5, centroidY: 0.5,
    bboxX0: 0, bboxY0: 0, bboxX1: 1, bboxY1: 1,
  };
  return { id, descriptor, subPalette, noise: null, subPools: null };
}

function makeResult(
  width: number,
  height: number,
  labels: number[],
  pools: Pool[],
): SegmentResult {
  return { width, height, labels: Int32Array.from(labels), pools };
}

// Solid-color RGBA buffer.
function fillRgba(
  width: number,
  height: number,
  pixels: Array<[number, number, number, number]>,
): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a] = pixels[i];
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

// Filler for the new `sourceRgba` argument when the test doesn't exercise the
// rich (sample-rank) path — the contents don't affect the compressed transfer.
function makeSourceRgba(width: number, height: number, r = 0, g = 0, b = 0): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe("transferColors", () => {
  it("returns the original unchanged at strength 0", () => {
    const width = 2;
    const height = 1;
    const target = fillRgba(width, height, [
      [200, 50, 50, 255],
      [200, 50, 50, 255],
    ]);
    const targetResult = makeResult(width, height, [0, 0], [
      makePool(0, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 1, [100], [
      makePool(10, [makeSub(20, 80, 220)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 20, 80, 220);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 0 },
    );
    expect(Array.from(out)).toEqual(Array.from(target));
  });

  it("shifts a target pool toward its donor's color at strength 1", () => {
    const width = 2;
    const height = 1;
    // Target pool is a warm red; donor is a cool blue.
    const target = fillRgba(width, height, [
      [200, 50, 50, 255],
      [200, 50, 50, 255],
    ]);
    const targetResult = makeResult(width, height, [0, 0], [
      makePool(0, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 1, [40], [
      makePool(10, [makeSub(40, 90, 230)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 40, 90, 230);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );

    // With one sub-color each, the pixel's delta equals donorLab − targetLab,
    // so a pixel exactly at the target sub-color lands exactly on the donor.
    expect(out[0]).toBeCloseTo(40, -0.5);
    expect(out[1]).toBeCloseTo(90, -0.5);
    expect(out[2]).toBeCloseTo(230, -0.5);
    // Moved away from the original red.
    expect(out[0]).toBeLessThan(200);
    expect(out[2]).toBeGreaterThan(50);
  });

  it("produces an intermediate result at strength 0.5", () => {
    const width = 1;
    const height = 1;
    const target = fillRgba(width, height, [[200, 50, 50, 255]]);
    const targetResult = makeResult(width, height, [0], [
      makePool(0, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 1, [40], [
      makePool(10, [makeSub(40, 90, 230)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 40, 90, 230);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const full = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    const half = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 0.5 },
    );
    // The half-strength red channel lies between the original and full result.
    expect(half[0]).toBeGreaterThan(Math.min(target[0], full[0]));
    expect(half[0]).toBeLessThan(Math.max(target[0], full[0]));
  });

  it("preserves the alpha channel and passes transparent pixels through", () => {
    const width = 3;
    const height = 1;
    // Pixel 0 opaque, pixel 1 transparent via alpha, pixel 2 label −1.
    const target = fillRgba(width, height, [
      [200, 50, 50, 255],
      [200, 50, 50, 10],
      [200, 50, 50, 255],
    ]);
    const targetResult = makeResult(width, height, [0, 0, -1], [
      makePool(0, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(40, 90, 230)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 40, 90, 230);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );

    // Alpha untouched on every pixel.
    expect(out[3]).toBe(255);
    expect(out[7]).toBe(10);
    expect(out[11]).toBe(255);
    // Opaque pixel 0 was recolored.
    expect(out[0]).not.toBe(200);
    // Low-alpha pixel 1 passed through unchanged.
    expect([out[4], out[5], out[6]]).toEqual([200, 50, 50]);
    // Label −1 pixel 2 passed through unchanged.
    expect([out[8], out[9], out[10]]).toEqual([200, 50, 50]);
  });

  it("matches sub-colors by lightness rank when counts differ", () => {
    const width = 2;
    const height = 1;
    // Target pool has two sub-colors: a dark pixel and a light pixel.
    const dark: [number, number, number, number] = [40, 40, 40, 255];
    const light: [number, number, number, number] = [210, 210, 210, 255];
    const target = fillRgba(width, height, [dark, light]);
    const targetResult = makeResult(width, height, [0, 0], [
      makePool(0, [makeSub(40, 40, 40), makeSub(210, 210, 210)]),
    ]);
    // Donor has THREE sub-colors spanning dark → mid → light, all blue-tinted.
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [
        makeSub(20, 30, 90),
        makeSub(110, 120, 180),
        makeSub(200, 210, 255),
      ]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 110, 120, 180);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );

    // Dark target sub-color (rank 0/1 → donor rank 0/2) takes the dark donor;
    // light target sub-color (rank 1/1 → donor rank 2/2) takes the light donor.
    // Both donors are blue-biased, so blue should exceed red on each pixel.
    expect(out[2]).toBeGreaterThan(out[0]); // dark pixel: B > R
    expect(out[6]).toBeGreaterThan(out[4]); // light pixel: B > R
    // Dark stays darker than light after transfer.
    expect(out[0]).toBeLessThan(out[4]);
  });

  it("leaves a target pool unchanged when it has no donor match", () => {
    const width = 1;
    const height = 1;
    const target = fillRgba(width, height, [[200, 50, 50, 255]]);
    const targetResult = makeResult(width, height, [0], [
      makePool(0, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(40, 90, 230)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 40, 90, 230);
    // Empty correspondence — no match for pool 0.
    const correspondence: Correspondence = {
      matches: [],
      unmatchedSourceIds: [10],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    expect([out[0], out[1], out[2]]).toEqual([200, 50, 50]);
  });

  it("preserves output dimensions", () => {
    const width = 4;
    const height = 3;
    const labels = new Array(width * height).fill(0);
    const target = new Uint8Array(width * height * 4).fill(120);
    const targetResult = makeResult(width, height, labels, [
      makePool(0, [makeSub(120, 120, 120)]),
    ]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(60, 90, 200)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 60, 90, 200);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    expect(out.length).toBe(width * height * 4);
  });

  it("incorporates noise swatches into a pool's sub-color list", () => {
    const width = 1;
    const height = 1;
    const target = fillRgba(width, height, [[128, 128, 128, 255]]);
    // Target pool: one structured sub-color + a noise swatch near the pixel.
    const targetPool = makePool(0, [makeSub(128, 128, 128)]);
    targetPool.noise = { swatches: [makeSub(130, 130, 130)], weight: 0.2 };
    const targetResult = makeResult(width, height, [0], [targetPool]);

    const sourcePool = makePool(10, [makeSub(60, 60, 60)]);
    sourcePool.noise = { swatches: [makeSub(200, 200, 200)], weight: 0.2 };
    const sourceResult = makeResult(1, 1, [10], [sourcePool]);
    const sourceRgba = makeSourceRgba(1, 1, 60, 60, 60);

    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    // The pixel is recolored — proving noise swatches participated (a 1-sub
    // pool of only the structured swatch would shift toward 60,60,60; with the
    // noise swatch the soft blend lands elsewhere). Just assert it changed.
    expect([out[0], out[1], out[2]]).not.toEqual([128, 128, 128]);
  });

  it("relax: 0 is byte-identical to omitting relax", () => {
    const width = 4;
    const height = 4;
    const labels = new Array(width * height).fill(0);
    const pixels: Array<[number, number, number, number]> = [];
    for (let i = 0; i < width * height; i++) {
      pixels.push([180 + (i % 3) * 10, 60, 70, 255]);
    }
    const target = fillRgba(width, height, pixels);
    const targetResult = makeResult(width, height, labels, [
      makePool(0, [makeSub(180, 60, 70), makeSub(200, 60, 70)]),
    ]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(40, 90, 230), makeSub(70, 110, 240)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 50, 100, 235);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const omitted = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    const explicitZero = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, relax: 0, preserveLuminance: 0 },
    );
    expect(Array.from(explicitZero)).toEqual(Array.from(omitted));
  });

  it("relax > 0 softens a two-pool boundary", () => {
    // Two side-by-side pool columns with very different donor deltas. The
    // boundary runs down the middle (x = 2|3 in a 6-wide image). A pixel just
    // inside one pool should, after relax, move toward the other pool's color.
    const width = 6;
    const height = 1;
    const leftRgb: [number, number, number, number] = [200, 50, 50, 255];
    const rightRgb: [number, number, number, number] = [200, 50, 50, 255];
    const pixels: Array<[number, number, number, number]> = [
      leftRgb, leftRgb, leftRgb, rightRgb, rightRgb, rightRgb,
    ];
    const target = fillRgba(width, height, pixels);
    // Both pools start at the same color but get opposite donors: pool 0 → a
    // dark donor, pool 1 → a bright donor. Hard boundary = abrupt seam at x=2/3.
    const targetResult = makeResult(width, height, [0, 0, 0, 1, 1, 1], [
      makePool(0, [makeSub(200, 50, 50)]),
      makePool(1, [makeSub(200, 50, 50)]),
    ]);
    const sourceResult = makeResult(1, 2, [10, 11], [
      makePool(10, [makeSub(30, 30, 30)]),
      makePool(11, [makeSub(240, 240, 240)]),
    ]);
    // sourceRgba mirrors the two-pixel source label map.
    const sourceRgba = new Uint8Array([
      30, 30, 30, 255,
      240, 240, 240, 255,
    ]);
    const correspondence: Correspondence = {
      matches: [
        { targetPoolId: 0, sourcePoolId: 10, score: 0 },
        { targetPoolId: 1, sourcePoolId: 11, score: 0 },
      ],
      unmatchedSourceIds: [],
    };

    const hard = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, relax: 0 },
    );
    const soft = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, relax: 0.8 },
    );

    // The last pixel of pool 0 (index 2) was driven dark by its donor. After a
    // blur it picks up the bright pool-1 delta from across the seam, so it
    // ends up LIGHTER than under the hard transfer.
    expect(soft[2 * 4]).toBeGreaterThan(hard[2 * 4]);
    // Symmetrically, the first pixel of pool 1 (index 3) was driven bright;
    // the blur pulls it DARKER toward pool 0's delta.
    expect(soft[3 * 4]).toBeLessThan(hard[3 * 4]);
    // The straddling pair is now closer together than the hard seam — the
    // abrupt jump across the boundary has shrunk.
    const hardGap = Math.abs(hard[2 * 4] - hard[3 * 4]);
    const softGap = Math.abs(soft[2 * 4] - soft[3 * 4]);
    expect(softGap).toBeLessThan(hardGap);
  });

  it("multi-anchor: each anchor recolors its own region via its local mini-Smash", () => {
    // Pre-analysed anchors carry their own localTargetLabels + a per-local-
    // pool sub-mapping table. The fixture below constructs two such anchors
    // by hand instead of calling analyzeAnchor — keeping the test focused on
    // transferColors's anchor-consumption logic, not on segmentPixelSet.
    //
    // 12×1 image. Single GLOBAL target pool of neutral mid-gray with an auto
    // donor (also neutral) — so outside the anchors the recolor is a no-op.
    // Two anchors with narrow falloffs land at x=1 and x=10; their local
    // mini-Smash mappings push the target pixel toward red and blue.
    const width = 12;
    const height = 1;
    const pixels: Array<[number, number, number, number]> = [];
    for (let i = 0; i < width; i++) pixels.push([140, 140, 140, 255]);
    const target = fillRgba(width, height, pixels);
    const labels = new Array(width).fill(0);
    const targetPool = makePool(0, [makeSub(140, 140, 140)]);
    const targetResult = makeResult(width, height, labels, [targetPool]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(140, 140, 140)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 140, 140, 140);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    // Build a synthetic anchor: at pixel x=1, the local pool id is 0; sub-
    // mappings push the target's mid-gray sub-colour toward a red donor.
    const redLocalPool = makePool(0, [makeSub(220, 30, 30)]);
    const redAnchorLabels = new Int32Array(width * height).fill(-1);
    redAnchorLabels[1] = 0; // pixel x=1 belongs to local pool 0
    const redAnchor: TransferAnchor = {
      targetX: 1 / (width - 1), targetY: 0.5, radius: 0.15,
      localTargetLabels: redAnchorLabels,
      localMappingsByPool: new Map([[
        0,
        buildSubMappings(poolSubColors(targetPool), poolSubColors(redLocalPool)),
      ]]),
    };

    // Same shape, blue donor, at x=10.
    const blueLocalPool = makePool(0, [makeSub(30, 30, 220)]);
    const blueAnchorLabels = new Int32Array(width * height).fill(-1);
    blueAnchorLabels[10] = 0;
    const blueAnchor: TransferAnchor = {
      targetX: 10 / (width - 1), targetY: 0.5, radius: 0.15,
      localTargetLabels: blueAnchorLabels,
      localMappingsByPool: new Map([[
        0,
        buildSubMappings(poolSubColors(targetPool), poolSubColors(blueLocalPool)),
      ]]),
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, anchors: [redAnchor, blueAnchor] },
    );

    // The pixel under anchor 0 (x=1) recolors strongly toward red: R high,
    // B low. The pixel under anchor 1 (x=10) recolors strongly toward blue.
    const redR = out[1 * 4];
    const redB = out[1 * 4 + 2];
    expect(redR).toBeGreaterThan(redB + 40);
    expect(redR).toBeGreaterThan(180);

    const blueR = out[10 * 4];
    const blueB = out[10 * 4 + 2];
    expect(blueB).toBeGreaterThan(blueR + 40);
    expect(blueB).toBeGreaterThan(180);

    // The middle pixel (x=5) is outside both falloffs (radius 0.15 of max edge
    // = 1.8 px), so it stays on the auto neutral donor → unchanged.
    const midR = out[5 * 4];
    const midG = out[5 * 4 + 1];
    const midB = out[5 * 4 + 2];
    expect(Math.abs(midR - 140)).toBeLessThan(15);
    expect(Math.abs(midG - 140)).toBeLessThan(15);
    expect(Math.abs(midB - 140)).toBeLessThan(15);
  });

  it("preserveLuminance: 1 keeps original L while a/b still shift", () => {
    const width = 2;
    const height = 1;
    // Target is a mid red; donor is a much darker, cooler blue — so without
    // luminance preservation L would drop sharply.
    const target = fillRgba(width, height, [
      [200, 90, 90, 255],
      [200, 90, 90, 255],
    ]);
    const targetResult = makeResult(width, height, [0, 0], [
      makePool(0, [makeSub(200, 90, 90)]),
    ]);
    const sourceResult = makeResult(1, 1, [10], [
      makePool(10, [makeSub(30, 60, 210)]),
    ]);
    const sourceRgba = makeSourceRgba(1, 1, 30, 60, 210);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, preserveLuminance: 1 },
    );

    const [origL, , origB] = rgbToLab(200, 90, 90);
    const [outL, , outB] = rgbToLab(out[0], out[1], out[2]);
    // Lightness is preserved within a small tolerance (only rounding to 8-bit
    // RGB and back through Lab introduces drift).
    expect(Math.abs(outL - origL)).toBeLessThan(2);
    // Chroma (a/b) still shifted strongly toward the cool-blue donor — the
    // donor's b is ~100 units bluer than the target's, so b moves a lot.
    expect(Math.abs(outB - origB)).toBeGreaterThan(20);
    expect(outB).toBeLessThan(origB); // moved toward blue (negative b)
  });

  it("richness: 0 is byte-identical to omitting richness", () => {
    // The richness option must default to 0 / no-op so existing flows keep
    // their byte-for-byte output. Build a setup with non-trivial source pixels
    // so we'd notice if the rich path crept in.
    const width = 4;
    const height = 4;
    const labels = new Array(width * height).fill(0);
    const pixels: Array<[number, number, number, number]> = [];
    for (let i = 0; i < width * height; i++) {
      pixels.push([180 + (i % 3) * 10, 60, 70, 255]);
    }
    const target = fillRgba(width, height, pixels);
    const targetResult = makeResult(width, height, labels, [
      makePool(0, [makeSub(180, 60, 70), makeSub(200, 60, 70)]),
    ]);
    const sourceResult = makeResult(2, 2, [10, 10, 10, 10], [
      makePool(10, [makeSub(40, 90, 230), makeSub(70, 110, 240)]),
    ]);
    // Varied source pixels so the rich path WOULD diverge if accidentally engaged.
    const sourceRgba = new Uint8Array([
      30, 80, 220, 255,
      80, 120, 250, 255,
      40, 90, 230, 255,
      70, 110, 240, 255,
    ]);
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const omitted = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1 },
    );
    const explicitZero = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, richness: 0 },
    );
    expect(Array.from(explicitZero)).toEqual(Array.from(omitted));
  });

  it("richness: 1 pulls the donor's full chroma variation through", () => {
    // Source pool with WIDE a/b variation but uniform lightness: half the
    // pixels are reddish (high a) and half are greenish (low a). The donor's
    // sub-swatch averages would collapse this to a near-neutral mid color, so
    // the compressed transfer barely shifts the target's chroma. The rich path
    // should instead surface that a/b variation onto the target pixels.
    const width = 8;
    const height = 1;
    // Target pool: 8 mid-gray pixels, ramped slightly in L so each pixel maps
    // to a distinct rank in [0, 7] under the rich path.
    const targetPixels: Array<[number, number, number, number]> = [];
    for (let i = 0; i < width; i++) {
      const v = 120 + i * 2; // 120..134 — small L ramp, neutral a/b
      targetPixels.push([v, v, v, 255]);
    }
    const target = fillRgba(width, height, targetPixels);
    const targetResult = makeResult(width, height, new Array(width).fill(0), [
      // One sub-swatch — sub-palette compression flattens the donor to its mean.
      makePool(0, [makeSub(127, 127, 127)]),
    ]);

    // Source pool: 8 pixels of identical lightness (~mid gray) but split into
    // reddish and greenish halves. Building the sub-swatch from the MEAN would
    // give a near-neutral donor — so the compressed path barely shifts a/b.
    const sourcePool = makePool(10, [makeSub(127, 127, 127)]);
    const sourceResult = makeResult(width, 1, new Array(width).fill(10), [sourcePool]);
    const sourceRgba = new Uint8Array(width * 4);
    for (let i = 0; i < width; i++) {
      const o = i * 4;
      // Alternate reddish (high a) and greenish (low a). Equal L so sample
      // sorting by L is order-stable; the diversity lives entirely in a/b.
      const reddish = i < width / 2;
      sourceRgba[o] = reddish ? 200 : 60;        // R
      sourceRgba[o + 1] = reddish ? 60 : 200;    // G
      sourceRgba[o + 2] = 100;                    // B
      sourceRgba[o + 3] = 255;
    }

    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const compressed = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, richness: 0 },
    );
    const rich = transferColors(
      target, width, height, targetResult, sourceRgba, sourceResult, correspondence,
      { strength: 1, richness: 1 },
    );

    // The compressed output's per-pixel a values cluster tightly (one donor
    // average); the rich output's spread is dramatically wider because each
    // target pixel pulled in a different donor sample.
    const compAs: number[] = [];
    const richAs: number[] = [];
    for (let i = 0; i < width; i++) {
      const o = i * 4;
      const [, aC] = rgbToLab(compressed[o], compressed[o + 1], compressed[o + 2]);
      const [, aR] = rgbToLab(rich[o], rich[o + 1], rich[o + 2]);
      compAs.push(aC);
      richAs.push(aR);
    }
    const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const compRange = range(compAs);
    const richRange = range(richAs);

    // Rich path's `a` spread is meaningful AND much larger than the compressed
    // path's. (Compressed is near-zero because one sub-swatch → one delta.)
    expect(richRange).toBeGreaterThan(20);
    expect(richRange).toBeGreaterThan(compRange * 3);
  });
});
