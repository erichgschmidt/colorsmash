// Ported from the CutWise plugin (plugin/src/core/contour.test.ts). Faithful
// copy of the contour-vectorization test suite; imports adapted to the local
// cutwise module path.
import { describe, it, expect } from "vitest";
import { vectorizeLabels, rdpSimplify, simplifyPolygon } from "./contour";

// Count pixels carrying a given cluster index in a label map.
function countCluster(map: Int32Array, cluster: number): number {
  let n = 0;
  for (const v of map) if (v === cluster) n++;
  return n;
}

describe("rdpSimplify", () => {
  it("collapses a collinear run to its endpoints", () => {
    const line = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    ];
    expect(rdpSimplify(line, 0.5)).toEqual([
      { x: 0, y: 0 }, { x: 3, y: 0 },
    ]);
  });

  it("keeps a vertex that deviates beyond epsilon", () => {
    const path = [
      { x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 0 },
    ];
    expect(rdpSimplify(path, 1).length).toBe(3);
  });
});

describe("simplifyPolygon", () => {
  it("a coarser epsilon never yields more vertices than a fine one", () => {
    // A 16-gon approximating a circle.
    const ring = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ring.push({ x: Math.cos(a) * 50, y: Math.sin(a) * 50 });
    }
    const fine = simplifyPolygon(ring, 0.5);
    const coarse = simplifyPolygon(ring, 12);
    expect(coarse.length).toBeLessThanOrEqual(fine.length);
    expect(coarse.length).toBeGreaterThanOrEqual(3);
  });
});

describe("vectorizeLabels", () => {
  it("rasterizes a solid square at the output resolution", () => {
    // 10x10 working map, all cluster 0.
    const labels = new Int32Array(100).fill(0);
    const out = vectorizeLabels(labels, 10, 10, 40, 40, 0);

    expect(out.length).toBe(40 * 40);
    // The whole square is one region — every output pixel is cluster 0.
    expect(countCluster(out, 0)).toBe(40 * 40);
    // Interior sample.
    expect(out[20 * 40 + 20]).toBe(0);
  });

  it("keeps transparent input pixels transparent in the output", () => {
    // A centred 6x6 opaque block inside a 10x10 transparent field.
    const labels = new Int32Array(100).fill(-1);
    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) labels[y * 10 + x] = 0;
    }
    const out = vectorizeLabels(labels, 10, 10, 50, 50, 0);

    // Corners of the output stay transparent.
    expect(out[0]).toBe(-1);
    expect(out[49]).toBe(-1);
    expect(out[49 * 50]).toBe(-1);
    expect(out[50 * 50 - 1]).toBe(-1);
    // Centre is filled.
    expect(out[25 * 50 + 25]).toBe(0);
    // The opaque block covers roughly (6/10)^2 of the output.
    const filled = out.length - countCluster(out, -1);
    expect(filled).toBeGreaterThan(0.25 * out.length);
    expect(filled).toBeLessThan(0.55 * out.length);
  });

  it("rasterizes two regions of different clusters", () => {
    // 10x10: left half cluster 0, right half cluster 1.
    const labels = new Int32Array(100);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) labels[y * 10 + x] = x < 5 ? 0 : 1;
    }
    const out = vectorizeLabels(labels, 10, 10, 30, 30, 0);

    expect(countCluster(out, 0)).toBeGreaterThan(0);
    expect(countCluster(out, 1)).toBeGreaterThan(0);
    expect(countCluster(out, -1)).toBe(0);
    // Far-left sample is cluster 0, far-right is cluster 1.
    expect(out[15 * 30 + 1]).toBe(0);
    expect(out[15 * 30 + 28]).toBe(1);
  });

  it("low simplicity preserves a disc's area; raising it coarsens the shape", () => {
    // A large solid disc of cluster 1 on a cluster-0 field.
    const W = 64;
    const cx = 32, cy = 32, r = 22;
    const labels = new Int32Array(W * W).fill(0);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) labels[y * W + x] = 1;
      }
    }
    // At simplicity 0 the polygon hugs the pixel boundary: the rasterized disc
    // should match the true disc area closely (within 10%).
    const trueArea = countCluster(labels, 1) * 16; // scaled 4x in each axis
    const fine = vectorizeLabels(labels, W, W, 256, 256, 0);
    expect(Math.abs(countCluster(fine, 1) - trueArea)).toBeLessThan(0.1 * trueArea);

    // Raising simplicity facets the circle into a coarse polygon — the result
    // changes, while still covering a substantial part of the disc.
    const coarse = vectorizeLabels(labels, W, W, 256, 256, 100);
    let diff = 0;
    for (let i = 0; i < fine.length; i++) if (fine[i] !== coarse[i]) diff++;
    expect(diff).toBeGreaterThan(0);
    expect(countCluster(coarse, 1)).toBeGreaterThan(0.5 * countCluster(fine, 1));
  });

  it("simplification monotonically reduces the polygon vertex count", () => {
    // Trace the disc's boundary directly and run RDP at increasing epsilons:
    // a coarser epsilon must never yield more vertices.
    const cx = 32, cy = 32, r = 22;
    const ring: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      ring.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    const counts = [0.5, 2, 6, 12].map((eps) => simplifyPolygon(ring, eps).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeLessThan(counts[0]);
    expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(3);
  });
});
