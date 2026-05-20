import { describe, it, expect } from "vitest";
import { slic } from "./slic";

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

function allIndices(w: number, h: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < w * h; i++) idx.push(i);
  return idx;
}

describe("slic", () => {
  it("respects a strong color boundary — no superpixel straddles the seam", () => {
    const W = 64, H = 64;
    // Left half red, right half blue.
    const img = makeImage(W, H, (x) => (x < W / 2 ? [220, 30, 30] : [30, 30, 220]));

    const res = slic(img, W, H, allIndices(W, H), { K: 16, compactness: 15, iterations: 10 });

    // Every superpixel should be predominantly on one side of the seam — define
    // "predominant" as >= 95% pixels on one side. This is the meaningful test:
    // a SLIC that straddles strong boundaries is broken.
    const counts = new Map<number, { left: number; right: number }>();
    for (let p = 0; p < res.labels.length; p++) {
      const c = res.labels[p];
      if (c < 0) continue;
      const x = p % W;
      let e = counts.get(c);
      if (!e) { e = { left: 0, right: 0 }; counts.set(c, e); }
      if (x < W / 2) e.left++; else e.right++;
    }
    for (const [, e] of counts) {
      const tot = e.left + e.right;
      const dominantFrac = Math.max(e.left, e.right) / tot;
      expect(dominantFrac).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("on a uniform image produces roughly K equally-sized superpixels", () => {
    const W = 64, H = 64;
    const img = makeImage(W, H, () => [128, 128, 128]);

    const K = 16;
    const res = slic(img, W, H, allIndices(W, H), { K, compactness: 20, iterations: 10 });

    // Should be within 2× of requested K (SLIC's actual count varies a bit
    // with grid step rounding and the connectivity sweep).
    expect(res.centers.length).toBeGreaterThanOrEqual(Math.floor(K / 2));
    expect(res.centers.length).toBeLessThanOrEqual(K * 2);

    // Every center should be non-empty and roughly equal in size — the largest
    // shouldn't dwarf the average by more than ~4×.
    const total = W * H;
    const avg = total / res.centers.length;
    let maxCount = 0;
    for (const c of res.centers) {
      expect(c.count).toBeGreaterThan(0);
      if (c.count > maxCount) maxCount = c.count;
    }
    expect(maxCount).toBeLessThan(avg * 4);

    // Labels cover every pixel.
    let assigned = 0;
    for (let p = 0; p < res.labels.length; p++) if (res.labels[p] >= 0) assigned++;
    expect(assigned).toBe(W * H);
  });

  it("excludes pixels not in the indices set (sets their label to -1)", () => {
    const W = 32, H = 32;
    const img = makeImage(W, H, () => [200, 100, 50]);
    // Only include the left half.
    const indices: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W / 2; x++) indices.push(y * W + x);
    }

    const res = slic(img, W, H, indices, { K: 8, compactness: 15 });
    for (let p = 0; p < res.labels.length; p++) {
      const x = p % W;
      if (x < W / 2) expect(res.labels[p]).toBeGreaterThanOrEqual(0);
      else expect(res.labels[p]).toBe(-1);
    }
  });

  it("returns an empty result for an empty index set", () => {
    const W = 16, H = 16;
    const img = makeImage(W, H, () => [0, 0, 0]);
    const res = slic(img, W, H, [], { K: 4, compactness: 10 });
    expect(res.centers.length).toBe(0);
    for (let p = 0; p < res.labels.length; p++) expect(res.labels[p]).toBe(-1);
  });
});
