// Ported from the CutWise plugin (plugin/src/core/islands.test.ts). Adapted to
// import the Cluster type from the local cutwise islands module.
import { describe, it, expect } from "vitest";
import { labelComponents, mergeSmallIslands } from "./islands";
import type { Cluster } from "./islands";

// 5x5 cluster-label map: all cluster 0 except the center pixel (cluster 1).
function speckLabels(): Int32Array {
  const labels = new Int32Array(25).fill(0);
  labels[12] = 1; // row 2, col 2
  return labels;
}

const CLUSTERS: Cluster[] = [
  { lab: [0, 0, 0], rgb: [0, 0, 0], count: 24 },
  { lab: [100, 0, 0], rgb: [255, 255, 255], count: 1 },
];

describe("labelComponents", () => {
  it("finds one region per connected same-cluster run", () => {
    const { regions, regionOf } = labelComponents(speckLabels(), 5, 5);
    expect(regions.length).toBe(2);
    expect(regions[0].size).toBe(24);
    expect(regions[1].size).toBe(1);
    expect(regionOf[12]).toBe(1);
  });
});

describe("mergeSmallIslands", () => {
  const params = {
    shapeSize: 1,
    simplification: 100,
    edgePreservation: 0,
    valuePreservation: 0,
  };

  it("keeps a small island alive inside a focal zone", () => {
    const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
    const priority = new Float32Array(25).fill(1); // focal everywhere
    const out = mergeSmallIslands(regionOf, regions, CLUSTERS, priority, 5, params);
    expect(out[12]).toBe(1); // speck survives
  });

  it("collapses a small island inside a low-priority zone", () => {
    const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
    const priority = new Float32Array(25).fill(0); // tertiary everywhere
    const out = mergeSmallIslands(regionOf, regions, CLUSTERS, priority, 5, params);
    expect(out[12]).toBe(0); // speck absorbed
    for (const v of out) expect(v).toBe(0);
  });

  it("edge preservation blocks merges across a strong color edge", () => {
    const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
    const priority = new Float32Array(25).fill(0); // would collapse...
    const out = mergeSmallIslands(
      regionOf, regions, CLUSTERS, priority, 5,
      { ...params, edgePreservation: 100 }, // ...but the edge is protected
    );
    expect(out[12]).toBe(1); // speck survives despite low priority
  });

  // Regression: with the focal end of the threshold anchored at 1 (not
  // shapeSize), an island larger than shapeSize must still survive in a focal
  // zone — otherwise focal anchors collapse detail just like everywhere else.
  it("a focal zone keeps an island larger than shapeSize", () => {
    // 9x9, with a 3x3 block (9 px) of cluster 1 in the centre.
    const labels = new Int32Array(81).fill(0);
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) labels[y * 9 + x] = 1;
    const { regionOf, regions } = labelComponents(labels, 9, 9);
    const big = {
      shapeSize: 20,
      simplification: 50,
      edgePreservation: 0,
      valuePreservation: 0,
    };

    const focal = mergeSmallIslands(
      regionOf, regions, CLUSTERS, new Float32Array(81).fill(1), 9, big,
    );
    expect(focal[4 * 9 + 4]).toBe(1); // 9-px block survives the focal zone

    const tertiary = mergeSmallIslands(
      regionOf, regions, CLUSTERS, new Float32Array(81).fill(0), 9, big,
    );
    expect(tertiary[4 * 9 + 4]).toBe(0); // same block collapses in a tertiary zone
  });

  // Value-contrast protection. CLUSTERS 0 and 1 differ maximally in L (0 vs
  // 100). A priority of 0.6 is focal enough to engage protection yet still
  // leaves the threshold above the 1-px speck, so size alone would merge it.
  describe("value preservation", () => {
    it("keeps a focal island with strong value contrast when valuePreservation is high", () => {
      const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
      const priority = new Float32Array(25).fill(0.6); // focal-ish, not fully focal
      const out = mergeSmallIslands(
        regionOf, regions, CLUSTERS, priority, 5,
        { ...params, valuePreservation: 100 },
      );
      expect(out[12]).toBe(1); // strong L step protected — speck survives
    });

    it("merges that same focal island when valuePreservation is 0", () => {
      const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
      const priority = new Float32Array(25).fill(0.6);
      const out = mergeSmallIslands(
        regionOf, regions, CLUSTERS, priority, 5,
        { ...params, valuePreservation: 0 },
      );
      expect(out[12]).toBe(0); // no value protection — speck absorbed
    });

    it("merges a tertiary island regardless of valuePreservation", () => {
      const { regionOf, regions } = labelComponents(speckLabels(), 5, 5);
      const priority = new Float32Array(25).fill(0); // tertiary — never protected
      const out = mergeSmallIslands(
        regionOf, regions, CLUSTERS, priority, 5,
        { ...params, valuePreservation: 100 },
      );
      expect(out[12]).toBe(0); // priority gates protection — speck absorbed
    });
  });
});
