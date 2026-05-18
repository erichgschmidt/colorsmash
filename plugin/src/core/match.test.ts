import { describe, it, expect } from "vitest";
import type { Pool, PoolDescriptor, ValueBand } from "./clusters";
import { matchPools } from "./match";

// Minimal Pool builder — fills only the descriptor fields the matcher reads
// plus the required-but-unused structural fields.
function makePool(
  id: number,
  d: Partial<PoolDescriptor> & { valueBand: ValueBand },
): Pool {
  const descriptor: PoolDescriptor = {
    r: 0, g: 0, b: 0,
    labL: 50, labA: 0, labB: 0,
    chroma: 0,
    pixelCount: 100,
    weight: 0.25,
    compactness: 0.5,
    centroidX: 0.5, centroidY: 0.5,
    bboxX0: 0, bboxY0: 0, bboxX1: 1, bboxY1: 1,
    ...d,
  };
  return { id, descriptor, subPalette: [], noise: null, subPools: null };
}

describe("matchPools", () => {
  it("returns an empty correspondence for empty inputs", () => {
    expect(matchPools([], [])).toEqual({ matches: [], unmatchedSourceIds: [] });
    const src = [makePool(1, { valueBand: "mid" })];
    expect(matchPools(src, [])).toEqual({ matches: [], unmatchedSourceIds: [1] });
    expect(matchPools([], [makePool(2, { valueBand: "mid" })])).toEqual({
      matches: [],
      unmatchedSourceIds: [],
    });
  });

  it("matches a dark dominant target to a dark dominant source despite hue", () => {
    // Source: a dark dominant pool (warm/red hue) + a bright minor accent.
    const source = [
      makePool(10, {
        valueBand: "shadow", weight: 0.7, chroma: 20,
        labL: 20, labA: 40, labB: 30, // reddish
      }),
      makePool(11, {
        valueBand: "highlight", weight: 0.3, chroma: 60,
        labL: 80, labA: -20, labB: 50,
      }),
    ];
    // Target: a dark dominant pool that is currently BLUE — opposite hue.
    const target = [
      makePool(20, {
        valueBand: "shadow", weight: 0.72, chroma: 22,
        labL: 22, labA: -10, labB: -45, // bluish
      }),
      makePool(21, {
        valueBand: "highlight", weight: 0.28, chroma: 55,
        labL: 78, labA: 30, labB: -20,
      }),
    ];
    const { matches } = matchPools(source, target);
    const darkTarget = matches.find(m => m.targetPoolId === 20)!;
    // Despite the blue↔red hue clash, the dark dominant target maps to the
    // dark dominant source by structural role.
    expect(darkTarget.sourcePoolId).toBe(10);
  });

  it("matches a vivid accent to a vivid accent and a neutral to a neutral", () => {
    const source = [
      makePool(30, { valueBand: "mid", weight: 0.5, chroma: 5 }),   // neutral
      makePool(31, { valueBand: "mid", weight: 0.5, chroma: 110 }), // vivid
    ];
    const target = [
      makePool(40, { valueBand: "mid", weight: 0.5, chroma: 8 }),   // neutral
      makePool(41, { valueBand: "mid", weight: 0.5, chroma: 100 }), // vivid
    ];
    const { matches } = matchPools(source, target);
    expect(matches.find(m => m.targetPoolId === 40)!.sourcePoolId).toBe(30);
    expect(matches.find(m => m.targetPoolId === 41)!.sourcePoolId).toBe(31);
  });

  it("gives every target pool exactly one match", () => {
    const source = [
      makePool(1, { valueBand: "shadow", weight: 0.6 }),
      makePool(2, { valueBand: "highlight", weight: 0.4 }),
    ];
    const target = [
      makePool(101, { valueBand: "shadow", weight: 0.3 }),
      makePool(102, { valueBand: "mid", weight: 0.3 }),
      makePool(103, { valueBand: "highlight", weight: 0.2 }),
      makePool(104, { valueBand: "shadow", weight: 0.2 }),
    ];
    const { matches } = matchPools(source, target);
    expect(matches).toHaveLength(target.length);
    const targetIds = matches.map(m => m.targetPoolId).sort((a, b) => a - b);
    expect(targetIds).toEqual([101, 102, 103, 104]);
  });

  it("reuses source pools many-to-one and reports unmatched sources", () => {
    // Two shadow targets, one shadow source — the source is reused; the
    // highlight source is never picked.
    const source = [
      makePool(1, { valueBand: "shadow", weight: 0.5 }),
      makePool(2, { valueBand: "highlight", weight: 0.5 }),
    ];
    const target = [
      makePool(10, { valueBand: "shadow", weight: 0.5 }),
      makePool(11, { valueBand: "shadow", weight: 0.5 }),
    ];
    const { matches, unmatchedSourceIds } = matchPools(source, target);
    expect(matches.every(m => m.sourcePoolId === 1)).toBe(true);
    expect(unmatchedSourceIds).toEqual([2]);
  });

  it("prefers the same value band over a closer area in another band", () => {
    // A mid target: one mid source with a poor area fit, one shadow source
    // with a perfect area fit. Value band must win.
    const source = [
      makePool(1, { valueBand: "mid", weight: 0.1 }),
      makePool(2, { valueBand: "shadow", weight: 0.5 }),
    ];
    const target = [makePool(10, { valueBand: "mid", weight: 0.5 })];
    const { matches } = matchPools(source, target);
    expect(matches[0].sourcePoolId).toBe(1);
  });
});
