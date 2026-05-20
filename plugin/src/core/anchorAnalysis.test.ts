import { describe, it, expect } from "vitest";
import { analyzeAnchor } from "./anchorAnalysis";
import type { SegmentOptions } from "./clusters";

// Default segmentation opts — same as the SmashTab defaults, sized down so the
// tiny synthetic images don't fight the SLIC / island machinery.
const baseSegmentOpts: SegmentOptions = {
  poolCount: 4,
  edgePreservation: 0.55,
  regionCleanup: 0.4,
  colorVsValueBias: 0.5,
  subPaletteSize: 4,
  neutralProtection: 0,
  poolContinuity: 0,
};

// Build a small RGBA image whose left half is one colour and right half is
// another. Gives the segmenter two clearly distinct sub-regions to find when
// it analyses the whole image, and one homogeneous region when only half is
// covered by the falloff.
function twoHalvesRgba(
  width: number,
  height: number,
  left: [number, number, number],
  right: [number, number, number],
): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  const mid = width >> 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = x < mid ? left : right;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

describe("analyzeAnchor", () => {
  it("produces a localTargetLabels map that is -1 outside the radius and >= 0 inside", () => {
    const width = 64;
    const height = 64;
    const source = twoHalvesRgba(width, height, [200, 30, 30], [30, 30, 200]);
    const target = twoHalvesRgba(width, height, [80, 200, 80], [200, 200, 80]);

    const analysis = analyzeAnchor({
      sourceRgba: source,
      sourceWidth: width,
      sourceHeight: height,
      sourceX: 0.5, sourceY: 0.5,
      targetRgba: target,
      targetWidth: width,
      targetHeight: height,
      targetX: 0.5, targetY: 0.5,
      radius: 0.25,
      baseSegmentOpts,
      detail: 0.5,
    });

    expect(analysis.localTargetLabels.length).toBe(width * height);

    // A pixel near the edge of the image is outside a 0.25-radius circle.
    const corner = 0;
    expect(analysis.localTargetLabels[corner]).toBe(-1);

    // A pixel at the centre of the target is inside the circle and should
    // carry a valid (>=0) local pool id.
    const centerPixel = (height >> 1) * width + (width >> 1);
    expect(analysis.localTargetLabels[centerPixel]).toBeGreaterThanOrEqual(0);

    // At least one local mapping was produced.
    expect(analysis.localMappingsByPool.size).toBeGreaterThan(0);

    // Every key in localMappingsByPool should be a label that actually
    // appears in localTargetLabels.
    const labelSet = new Set<number>();
    for (let i = 0; i < analysis.localTargetLabels.length; i++) {
      const v = analysis.localTargetLabels[i];
      if (v >= 0) labelSet.add(v);
    }
    for (const id of analysis.localMappingsByPool.keys()) {
      expect(labelSet.has(id)).toBe(true);
    }

    // Rich-path tables — exist, and at least one matched local target pool
    // carries non-empty target-L and donor-Lab sample arrays. These power
    // anchor-aware richness in transferColors; an empty bucket would let the
    // per-pixel code silently fall back to the compressed delta.
    expect(analysis.localDonorLabSamples).toBeInstanceOf(Map);
    expect(analysis.localTargetLValues).toBeInstanceOf(Map);
    expect(analysis.localDonorLabSamples.size).toBeGreaterThan(0);
    expect(analysis.localTargetLValues.size).toBeGreaterThan(0);
    let foundNonEmpty = false;
    for (const id of analysis.localMappingsByPool.keys()) {
      const ls = analysis.localTargetLValues.get(id);
      const ss = analysis.localDonorLabSamples.get(id);
      if (ls && ss && ls.length > 0 && ss.length > 0) {
        foundNonEmpty = true;
        // Sorted ascending — required by the rank-match path in transferColors.
        for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThanOrEqual(ls[i - 1]);
        for (let i = 1; i < ss.length; i++) expect(ss[i].L).toBeGreaterThanOrEqual(ss[i - 1].L);
      }
    }
    expect(foundNonEmpty).toBe(true);
  });

  it("returns an empty analysis when the falloff covers too few pixels", () => {
    const width = 8;
    const height = 8;
    const source = twoHalvesRgba(width, height, [200, 30, 30], [30, 30, 200]);
    const target = twoHalvesRgba(width, height, [80, 200, 80], [200, 200, 80]);

    // A tiny radius on a tiny image gives < MIN_PIXELS opaque pixels.
    const analysis = analyzeAnchor({
      sourceRgba: source,
      sourceWidth: width,
      sourceHeight: height,
      sourceX: 0.5, sourceY: 0.5,
      targetRgba: target,
      targetWidth: width,
      targetHeight: height,
      targetX: 0.5, targetY: 0.5,
      radius: 0.02,
      baseSegmentOpts,
      detail: 0.5,
    });

    expect(analysis.localMappingsByPool.size).toBe(0);
    // The label map is still target-sized and all -1.
    expect(analysis.localTargetLabels.length).toBe(width * height);
    for (let i = 0; i < analysis.localTargetLabels.length; i++) {
      expect(analysis.localTargetLabels[i]).toBe(-1);
    }
    // Rich-path tables are empty too — degenerate analysis carries nothing.
    expect(analysis.localDonorLabSamples.size).toBe(0);
    expect(analysis.localTargetLValues.size).toBe(0);
  });
});
