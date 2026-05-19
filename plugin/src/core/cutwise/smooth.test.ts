// Ported from the CutWise plugin (plugin/src/core/smooth.test.ts).
import { describe, it, expect } from "vitest";
import { smoothLabels } from "./smooth";

describe("smoothLabels", () => {
  it("dissolves a stray single pixel into the surrounding label", () => {
    const labels = new Int32Array(25).fill(0);
    labels[12] = 1; // lone pixel, centre of a 5x5
    const out = smoothLabels(labels, 5, 5, 1);
    expect(out[12]).toBe(0);
  });

  it("leaves a solid region unchanged", () => {
    const labels = new Int32Array(16).fill(3);
    const out = smoothLabels(labels, 4, 4, 2);
    for (const v of out) expect(v).toBe(3);
  });

  it("returns the input untouched when passes is 0", () => {
    const labels = new Int32Array([0, 1, 0, 1]);
    const out = smoothLabels(labels, 2, 2, 0);
    expect(out).toBe(labels);
  });

  it("keeps transparent pixels transparent", () => {
    const labels = new Int32Array(9).fill(0);
    labels[4] = -1;
    const out = smoothLabels(labels, 3, 3, 1);
    expect(out[4]).toBe(-1);
  });
});
