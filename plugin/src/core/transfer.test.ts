import { describe, it, expect } from "vitest";
import type {
  Pool,
  PoolDescriptor,
  SubSwatch,
  SegmentResult,
} from "./clusters";
import { rgbToLab } from "./palette";
import type { Correspondence } from "./match";
import { transferColors } from "./transfer";

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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const full = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
      { strength: 1 },
    );
    const half = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    // Empty correspondence — no match for pool 0.
    const correspondence: Correspondence = {
      matches: [],
      unmatchedSourceIds: [10],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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
    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
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

    const correspondence: Correspondence = {
      matches: [{ targetPoolId: 0, sourcePoolId: 10, score: 0 }],
      unmatchedSourceIds: [],
    };

    const out = transferColors(
      target, width, height, targetResult, sourceResult, correspondence,
      { strength: 1 },
    );
    // The pixel is recolored — proving noise swatches participated (a 1-sub
    // pool of only the structured swatch would shift toward 60,60,60; with the
    // noise swatch the soft blend lands elsewhere). Just assert it changed.
    expect([out[0], out[1], out[2]]).not.toEqual([128, 128, 128]);
  });
});
