// Tests for the macro-group layer (core/macro.ts).
//
// macro.ts sits above pools: it clusters top-level pools into a handful of
// semantic "macro" groups (skin / shirt / BG), matches source macros to target
// macros by role, then runs the per-pool donor search CONSTRAINED to the
// matched source macro. These tests build synthetic Pool fixtures (no image
// pipeline) and assert the robust invariants — coverage, membership,
// determinism, weight-weighted aggregation, and the macro-constraint — plus a
// few targeted semantic cases (colour families, role matching).

import { describe, it, expect } from "vitest";
import type { Pool, PoolDescriptor, ValueBand } from "./clusters";
import {
  seedMacroGroups,
  macroDescriptor,
  macroInfoMap,
  matchMacros,
  buildMacroConstrainedCorrespondence,
  macroSuggestions,
  nearestMacroFor,
  reconcileMacros,
  reconcileMacroMatch,
} from "./macro";
import type { MacroGroup } from "./macro";
import { matchPools } from "./match";

// ────────── fixtures ──────────

// Value-band cuts mirror clusters.ts (private there).
const bandOf = (L: number): ValueBand =>
  L < 33 ? "shadow" : L > 66 ? "highlight" : "mid";

interface PoolSpec {
  labL: number;
  labA: number;
  labB: number;
  weight: number;
  // optional descriptor overrides (centroid, bbox, pixelCount, compactness…)
  [k: string]: number | undefined;
}

// Build a fully-populated Pool from a terse spec. Chroma is derived from a,b;
// valueBand from L; spatial defaults centred 0.5/0.5 with a full-frame bbox.
function makePool(id: number, spec: PoolSpec): Pool {
  const { labL, labA, labB, weight, ...overrides } = spec;
  const descriptor: PoolDescriptor = {
    r: 128,
    g: 128,
    b: 128,
    labL,
    labA,
    labB,
    chroma: Math.sqrt(labA * labA + labB * labB),
    valueBand: bandOf(labL),
    pixelCount: Math.round(weight * 10000),
    weight,
    compactness: 0.5,
    centroidX: 0.5,
    centroidY: 0.5,
    bboxX0: 0,
    bboxY0: 0,
    bboxX1: 1,
    bboxY1: 1,
    ...overrides,
  };
  return { id, descriptor, subPalette: [], noise: null, subPools: null };
}

// Union of all member pool ids across a set of macros (sorted).
const allIds = (macros: { poolIds: number[] }[]): number[] =>
  macros.flatMap((m) => m.poolIds).sort((a, b) => a - b);

// Find which macro a given pool id landed in (its index in the macro array).
const groupOf = (macros: { poolIds: number[] }[], poolId: number): number =>
  macros.findIndex((m) => m.poolIds.includes(poolId));

// ────────── 1. seedMacroGroups: structural invariants ──────────

describe("seedMacroGroups — invariants", () => {
  const pools = [
    makePool(0, { labL: 50, labA: 10, labB: 10, weight: 0.4 }),
    makePool(1, { labL: 20, labA: -5, labB: -20, weight: 0.3 }),
    makePool(2, { labL: 70, labA: 0, labB: 5, weight: 0.2 }),
    makePool(3, { labL: 40, labA: 30, labB: 25, weight: 0.1 }),
  ];

  it("returns min(k, n) groups", () => {
    expect(seedMacroGroups(pools, 2)).toHaveLength(2);
    expect(seedMacroGroups(pools, 3)).toHaveLength(3);
    expect(seedMacroGroups(pools, 4)).toHaveLength(4);
  });

  it("k > n clamps to n (each pool its own group)", () => {
    const macros = seedMacroGroups(pools, 99);
    expect(macros).toHaveLength(pools.length);
    for (const m of macros) expect(m.poolIds).toHaveLength(1);
  });

  it("k = 1 → a single group containing every pool", () => {
    const macros = seedMacroGroups(pools, 1);
    expect(macros).toHaveLength(1);
    expect(macros[0].poolIds.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("k <= 0 is treated as 1", () => {
    expect(seedMacroGroups(pools, 0)).toHaveLength(1);
    expect(seedMacroGroups(pools, -5)).toHaveLength(1);
  });

  it("covers every input id exactly once (no dupes, no omissions)", () => {
    for (const k of [1, 2, 3, 4, 7]) {
      const macros = seedMacroGroups(pools, k);
      const ids = allIds(macros);
      expect(ids).toEqual([0, 1, 2, 3]); // sorted union == all inputs
      // no duplicates: flat length == unique length
      const flat = macros.flatMap((m) => m.poolIds);
      expect(new Set(flat).size).toBe(flat.length);
    }
  });

  it("returns groups sorted by aggregate weight descending, ids 0..m-1", () => {
    const macros = seedMacroGroups(pools, 4); // one pool each → weights known
    const weights = macros.map((m) =>
      m.poolIds.reduce(
        (t, id) => t + pools.find((p) => p.id === id)!.descriptor.weight,
        0,
      ),
    );
    const sorted = [...weights].sort((a, b) => b - a);
    expect(weights).toEqual(sorted);
    expect(macros.map((m) => m.id)).toEqual([0, 1, 2, 3]);
    expect(macros.map((m) => m.name)).toEqual([
      "Macro 1",
      "Macro 2",
      "Macro 3",
      "Macro 4",
    ]);
  });

  it("empty pools → []", () => {
    expect(seedMacroGroups([], 3)).toEqual([]);
  });

  it("is deterministic — same input yields identical groupings twice", () => {
    const a = seedMacroGroups(pools, 2);
    const b = seedMacroGroups(pools, 2);
    const norm = (macros: { poolIds: number[] }[]) =>
      macros.map((m) => [...m.poolIds].sort((x, y) => x - y));
    expect(norm(a)).toEqual(norm(b));
  });
});

// ────────── 2. seedMacroGroups: colour-family semantics ──────────

describe("seedMacroGroups — colour families", () => {
  // 3 dark-red pools (positive a, positive b, low L) + 3 blue pools (negative
  // a, strongly negative b), far apart in Lab. k=2 must split along the family.
  const reds = [0, 1, 2];
  const blues = [3, 4, 5];
  const pools = [
    makePool(0, { labL: 28, labA: 45, labB: 30, weight: 0.18 }),
    makePool(1, { labL: 32, labA: 50, labB: 28, weight: 0.16 }),
    makePool(2, { labL: 25, labA: 40, labB: 35, weight: 0.14 }),
    makePool(3, { labL: 45, labA: -15, labB: -50, weight: 0.2 }),
    makePool(4, { labL: 50, labA: -10, labB: -45, weight: 0.17 }),
    makePool(5, { labL: 40, labA: -20, labB: -55, weight: 0.15 }),
  ];

  it("k=2 keeps the three reds together and the three blues together", () => {
    const macros = seedMacroGroups(pools, 2);
    expect(macros).toHaveLength(2);

    // The three reds share a group; the three blues share a (different) group.
    const redGroup = groupOf(macros, reds[0]);
    const blueGroup = groupOf(macros, blues[0]);
    expect(redGroup).not.toBe(-1);
    expect(blueGroup).not.toBe(-1);
    expect(redGroup).not.toBe(blueGroup);

    for (const id of reds) expect(groupOf(macros, id)).toBe(redGroup);
    for (const id of blues) expect(groupOf(macros, id)).toBe(blueGroup);
  });
});

// ────────── 3. macroDescriptor: weight-weighted aggregation ──────────

describe("macroDescriptor", () => {
  it("equal weights → plain mean Lab", () => {
    const a = makePool(0, { labL: 40, labA: 20, labB: -10, weight: 0.25 });
    const b = makePool(1, { labL: 60, labA: -20, labB: 30, weight: 0.25 });
    const byId = new Map([
      [0, a],
      [1, b],
    ]);
    const d = macroDescriptor([0, 1], byId);
    expect(d.labL).toBeCloseTo(50, 6);
    expect(d.labA).toBeCloseTo(0, 6);
    expect(d.labB).toBeCloseTo(10, 6);
    // chroma derives from the aggregate a,b
    expect(d.chroma).toBeCloseTo(Math.sqrt(0 * 0 + 10 * 10), 6);
  });

  it("unequal weights bias the mean toward the heavier pool", () => {
    const light = makePool(0, { labL: 20, labA: 0, labB: 0, weight: 0.1 });
    const heavy = makePool(1, { labL: 80, labA: 0, labB: 0, weight: 0.3 });
    const byId = new Map([
      [0, light],
      [1, heavy],
    ]);
    const d = macroDescriptor([0, 1], byId);
    // weighted mean = (20*0.1 + 80*0.3) / 0.4 = 26/0.4 = 65
    expect(d.labL).toBeCloseTo(65, 6);
  });

  it("sums weight and pixelCount across members", () => {
    const a = makePool(0, { labL: 30, labA: 0, labB: 0, weight: 0.2 });
    const b = makePool(1, { labL: 30, labA: 0, labB: 0, weight: 0.3 });
    const byId = new Map([
      [0, a],
      [1, b],
    ]);
    const d = macroDescriptor([0, 1], byId);
    expect(d.weight).toBeCloseTo(0.5, 6);
    expect(d.pixelCount).toBe(a.descriptor.pixelCount + b.descriptor.pixelCount);
  });

  it("valueBand reflects the aggregate mean L, not the per-pool bands", () => {
    // A shadow pool (L=20) and a mid pool (L=40): the MEAN L (30) is shadow,
    // so the macro's band is "shadow" even though one member was a mid.
    const shadow = makePool(0, { labL: 20, labA: 0, labB: 0, weight: 0.25 });
    const mid = makePool(1, { labL: 40, labA: 0, labB: 0, weight: 0.25 });
    const byId = new Map([
      [0, shadow],
      [1, mid],
    ]);
    const d = macroDescriptor([0, 1], byId);
    expect(d.labL).toBeCloseTo(30, 6);
    expect(d.valueBand).toBe("shadow");
  });

  it("unions the member bounding boxes", () => {
    const a = makePool(0, {
      labL: 30,
      labA: 0,
      labB: 0,
      weight: 0.2,
      bboxX0: 0.1,
      bboxY0: 0.1,
      bboxX1: 0.4,
      bboxY1: 0.4,
    });
    const b = makePool(1, {
      labL: 30,
      labA: 0,
      labB: 0,
      weight: 0.2,
      bboxX0: 0.5,
      bboxY0: 0.6,
      bboxX1: 0.9,
      bboxY1: 0.95,
    });
    const byId = new Map([
      [0, a],
      [1, b],
    ]);
    const d = macroDescriptor([0, 1], byId);
    expect(d.bboxX0).toBeCloseTo(0.1, 6);
    expect(d.bboxY0).toBeCloseTo(0.1, 6);
    expect(d.bboxX1).toBeCloseTo(0.9, 6);
    expect(d.bboxY1).toBeCloseTo(0.95, 6);
  });
});

// ────────── 4. macroInfoMap ──────────

describe("macroInfoMap", () => {
  const pools = [
    makePool(0, { labL: 50, labA: 0, labB: 0, weight: 0.3 }),
    makePool(1, { labL: 50, labA: 0, labB: 0, weight: 0.2 }),
    makePool(2, { labL: 20, labA: 0, labB: 0, weight: 0.5 }),
  ];

  it("emits one entry per macro with matching poolCount and weight", () => {
    const macros = [
      { id: 0, name: "Macro 1", poolIds: [0, 1] },
      { id: 1, name: "Macro 2", poolIds: [2] },
    ];
    const info = macroInfoMap(macros, pools);

    expect(info.size).toBe(2);

    const m0 = info.get(0)!;
    expect(m0.poolCount).toBe(2);
    expect(m0.weight).toBeCloseTo(0.5, 6); // 0.3 + 0.2

    const m1 = info.get(1)!;
    expect(m1.poolCount).toBe(1);
    expect(m1.weight).toBeCloseTo(0.5, 6);

    // r,g,b are present and in range.
    for (const m of [m0, m1]) {
      for (const c of [m.r, m.g, m.b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});

// ────────── 5. matchMacros: role matching ──────────

describe("matchMacros", () => {
  // Each side has a "skin" macro (warm mid, large) and a "BG" macro (dark,
  // large). Roles must match across sides: warm→warm, dark→dark, regardless of
  // the exact ids. Source ids and target ids are deliberately different.
  const sourcePools = [
    makePool(10, { labL: 60, labA: 18, labB: 22, weight: 0.5 }), // src skin
    makePool(11, { labL: 18, labA: 2, labB: -3, weight: 0.5 }), // src BG (dark)
  ];
  const targetPools = [
    makePool(20, { labL: 58, labA: 16, labB: 20, weight: 0.5 }), // tgt skin
    makePool(21, { labL: 15, labA: 1, labB: -2, weight: 0.5 }), // tgt BG (dark)
  ];

  const sourceMacros = [
    { id: 0, name: "Macro 1", poolIds: [10] }, // skin
    { id: 1, name: "Macro 2", poolIds: [11] }, // BG
  ];
  const targetMacros = [
    { id: 0, name: "Macro 1", poolIds: [20] }, // skin
    { id: 1, name: "Macro 2", poolIds: [21] }, // BG
  ];

  it("maps warm→warm and dark→dark, one entry per target macro", () => {
    const m = matchMacros(
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
    );
    expect(m.size).toBe(targetMacros.length);

    // Target skin macro (id 0) → source skin macro (id 0); BG → BG (id 1).
    expect(m.get(0)).toBe(0);
    expect(m.get(1)).toBe(1);
  });

  it("returns an empty map when either side has no macros", () => {
    expect(matchMacros([], sourcePools, targetMacros, targetPools).size).toBe(0);
    expect(matchMacros(sourceMacros, sourcePools, [], targetPools).size).toBe(0);
  });
});

// ────────── 6. buildMacroConstrainedCorrespondence ──────────

describe("buildMacroConstrainedCorrespondence", () => {
  // Construct a scenario where an UNCONSTRAINED match would cross macros.
  //
  // matchPools scores mostly on value band + area + chroma (NOT hue). The
  // target skin pool is a mid; its nearest GLOBAL donor by value/area would be
  // a BG-family pool that happens to also be a mid (a decoy), not the source
  // skin pool. The macro constraint must keep the skin target inside the
  // matched source skin macro.
  //
  // Source macros:
  //   SKIN macro {100}: one warm mid pool, large.
  //   BG   macro {110, 111}: a dark pool + a "decoy" mid pool that, globally,
  //                          would out-score the skin donor for the skin target.
  // The decoy (111) lives in the BG macro but is a MID with area + chroma very
  // close to the skin target — so by matchPools' value/area/chroma score (hue
  // is ignored) it actually OUT-SCORES the true skin donor (100) for the skin
  // target. Only the macro constraint keeps the skin target off it.
  const sourcePools = [
    makePool(100, { labL: 55, labA: 20, labB: 22, weight: 0.45 }), // src skin (mid)
    makePool(110, { labL: 15, labA: 0, labB: 0, weight: 0.45 }), // src BG dark
    makePool(111, { labL: 53, labA: -18, labB: 25, weight: 0.56 }), // BG decoy (mid, big area)
  ];
  // Target macros:
  //   SKIN macro {200}: warm mid pool.
  //   BG   macro {210}: dark pool.
  const targetPools = [
    makePool(200, { labL: 54, labA: 19, labB: 21, weight: 0.6 }), // tgt skin (mid)
    makePool(210, { labL: 16, labA: 0, labB: 0, weight: 0.4 }), // tgt BG dark
  ];

  const sourceMacros = [
    { id: 0, name: "Macro 1", poolIds: [100] }, // skin
    { id: 1, name: "Macro 2", poolIds: [110, 111] }, // BG (+ decoy)
  ];
  const targetMacros = [
    { id: 0, name: "Macro 1", poolIds: [200] }, // skin
    { id: 1, name: "Macro 2", poolIds: [210] }, // BG
  ];

  // skin→skin (macro 0→0), BG→BG (macro 1→1).
  const macroMatch = new Map<number, number>([
    [0, 0],
    [1, 1],
  ]);

  it("covers every target pool exactly once", () => {
    const corr = buildMacroConstrainedCorrespondence(
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
      macroMatch,
    );
    const tgtIds = corr.matches.map((m) => m.targetPoolId).sort((a, b) => a - b);
    expect(tgtIds).toEqual([200, 210]);
    expect(new Set(tgtIds).size).toBe(tgtIds.length); // no duplicates
  });

  it("keeps each target pool's donor inside its macro's matched source macro", () => {
    const corr = buildMacroConstrainedCorrespondence(
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
      macroMatch,
    );
    const skinMatch = corr.matches.find((m) => m.targetPoolId === 200)!;
    const bgMatch = corr.matches.find((m) => m.targetPoolId === 210)!;

    // Skin target's donor must be the (only) source skin member, NOT the decoy.
    expect(skinMatch.sourcePoolId).toBe(100);
    // BG target's donor must come from the BG macro {110, 111}.
    expect([110, 111]).toContain(bgMatch.sourcePoolId);
  });

  it("the constraint actually changed the outcome (decoy wins UNCONSTRAINED)", () => {
    // Prove the scenario is non-trivial: run the GLOBAL matcher with no macro
    // constraint and confirm the skin target would WRONGLY pick the cross-macro
    // decoy (111) instead of the true skin donor (100). The constrained result
    // above (which picks 100) is therefore solely due to the macro constraint.
    const skinTarget = targetPools.find((p) => p.id === 200)!;
    const unconstrained = matchPools(sourcePools, [skinTarget]);
    const wrong = unconstrained.matches.find((m) => m.targetPoolId === 200)!;
    expect(wrong.sourcePoolId).toBe(111); // decoy beats the true skin donor
    expect(wrong.sourcePoolId).not.toBe(100);
  });

  it("reports source pools no target drew from in unmatchedSourceIds", () => {
    const corr = buildMacroConstrainedCorrespondence(
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
      macroMatch,
    );
    const used = new Set(corr.matches.map((m) => m.sourcePoolId));
    for (const p of sourcePools) {
      if (used.has(p.id)) {
        expect(corr.unmatchedSourceIds).not.toContain(p.id);
      } else {
        expect(corr.unmatchedSourceIds).toContain(p.id);
      }
    }
    // The decoy (111) is in the BG macro but the only BG target (dark) should
    // pick the dark donor (110), leaving 111 unused.
    expect(corr.unmatchedSourceIds).toContain(111);
  });

  it("falls back to the full source set when a target macro has no match", () => {
    const noMatch = new Map<number, number>(); // empty → every target falls back
    const corr = buildMacroConstrainedCorrespondence(
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
      noMatch,
    );
    // Still total: every target pool covered exactly once.
    const tgtIds = corr.matches.map((m) => m.targetPoolId).sort((a, b) => a - b);
    expect(tgtIds).toEqual([200, 210]);
  });
});

describe("macroSuggestions / nearestMacroFor", () => {
  // Macro 0 = two heavy reds + one light BLUE outlier (contamination).
  // Macro 1 = a red-ish pool (belongs near macro 0) + a heavy blue.
  const pools: Pool[] = [
    makePool(1, { labL: 50, labA: 40, labB: 25, weight: 0.30 }),  // red (m0)
    makePool(2, { labL: 52, labA: 38, labB: 22, weight: 0.30 }),  // red (m0)
    makePool(3, { labL: 45, labA: -5, labB: -35, weight: 0.04 }), // blue outlier (m0)
    makePool(10, { labL: 50, labA: 41, labB: 24, weight: 0.10 }), // red-ish (m1) — should belong to m0
    makePool(11, { labL: 40, labA: -8, labB: -38, weight: 0.30 }),// blue (m1)
  ];
  const macros: MacroGroup[] = [
    { id: 0, name: "M0", poolIds: [1, 2, 3] },
    { id: 1, name: "M1", poolIds: [10, 11] },
  ];

  it("flags a far member as contaminating and a near foreign pool as a candidate", () => {
    const sug = macroSuggestions(0, macros, pools);
    // The blue outlier (3) is far from the red aggregate → contaminating; the
    // two reds are not.
    expect(sug.contaminating).toContain(3);
    expect(sug.contaminating).not.toContain(1);
    expect(sug.contaminating).not.toContain(2);
    // The red-ish pool 10 (currently in macro 1) sits near macro 0 → candidate.
    expect(sug.candidates.map((c) => c.poolId)).toContain(10);
    const cand = sug.candidates.find((c) => c.poolId === 10)!;
    expect(cand.fromMacroId).toBe(1);
    // The blue pool 11 is NOT near macro 0 → not a candidate.
    expect(sug.candidates.map((c) => c.poolId)).not.toContain(11);
  });

  it("macroSuggestions returns empty for an unknown macro id", () => {
    const sug = macroSuggestions(99, macros, pools);
    expect(sug.contaminating).toEqual([]);
    expect(sug.candidates).toEqual([]);
  });

  it("nearestMacroFor rehomes a pool to the closest OTHER macro", () => {
    // Pool 10 is red; excluding its own macro (1), the nearest is the red M0.
    expect(nearestMacroFor(10, macros, pools, 1)).toBe(0);
    // The blue outlier 3, removed from M0, is nearest to the blue-heavy M1.
    expect(nearestMacroFor(3, macros, pools, 0)).toBe(1);
  });

  it("nearestMacroFor returns null when there is no other macro", () => {
    const single: MacroGroup[] = [{ id: 0, name: "Only", poolIds: [1, 2, 3] }];
    expect(nearestMacroFor(1, single, pools, 0)).toBeNull();
  });
});

// ────────── 7. reconcileMacros: carry macros across re-segmentation ──────────

describe("reconcileMacros", () => {
  // Two well-separated families: a warm/red "Skin" macro (pools 1,2) and a dark
  // "BG" macro (pool 3). Colours kept far apart so nearest-macro is unambiguous.
  const warm1 = { labL: 60, labA: 35, labB: 28, weight: 0.3 };
  const warm2 = { labL: 58, labA: 38, labB: 25, weight: 0.25 };
  const dark3 = { labL: 12, labA: 2, labB: -3, weight: 0.2 };

  const basePools = (): Pool[] => [
    makePool(1, warm1),
    makePool(2, warm2),
    makePool(3, dark3),
  ];
  const prevSkinBG = (): MacroGroup[] => [
    { id: 0, name: "Skin", poolIds: [1, 2] },
    { id: 1, name: "BG", poolIds: [3] },
  ];

  it("empty prev → falls back to seedMacroGroups (length, full coverage)", () => {
    const pools = basePools();
    const seeded = seedMacroGroups(pools, 2);
    const reconciled = reconcileMacros([], pools, 2);
    expect(reconciled).toHaveLength(seeded.length);
    expect(reconciled.length).toBe(Math.min(2, pools.length));
    expect(allIds(reconciled)).toEqual([1, 2, 3]); // every pool covered
  });

  it("keeps macro names + ids and membership when pools are unchanged", () => {
    const macros = reconcileMacros(prevSkinBG(), basePools(), 2);
    expect(macros.map((m) => m.id)).toEqual([0, 1]);
    expect(macros.map((m) => m.name)).toEqual(["Skin", "BG"]);
    const skin = macros.find((m) => m.id === 0)!;
    const bg = macros.find((m) => m.id === 1)!;
    expect([...skin.poolIds].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(bg.poolIds).toEqual([3]);
  });

  it("drops a vanished pool from its macro", () => {
    // Pool 2 is gone from the re-segmentation.
    const pools = [makePool(1, warm1), makePool(3, dark3)];
    const macros = reconcileMacros(prevSkinBG(), pools, 2);
    const skin = macros.find((m) => m.id === 0)!;
    expect(skin.poolIds).toEqual([1]); // 2 dropped
    // Total membership equals the set of present pools.
    expect(allIds(macros)).toEqual([1, 3]);
  });

  it("assigns a new red orphan to Skin and a new dark orphan to BG", () => {
    const pools = [
      ...basePools(),
      makePool(9, { labL: 59, labA: 36, labB: 27, weight: 0.05 }), // red orphan
      makePool(8, { labL: 14, labA: 1, labB: -2, weight: 0.05 }), // dark orphan
    ];
    const macros = reconcileMacros(prevSkinBG(), pools, 2);
    const skin = macros.find((m) => m.id === 0)!;
    const bg = macros.find((m) => m.id === 1)!;
    expect(skin.poolIds).toContain(9); // red → Skin
    expect(bg.poolIds).toContain(8); // dark → BG
    expect(skin.poolIds).not.toContain(8);
    expect(bg.poolIds).not.toContain(9);
  });

  it("drops an emptied macro while other macros remain", () => {
    // All of BG's pools (3) vanish; the warm pools survive, so Skin remains and
    // the now-empty BG macro is removed.
    const pools = [makePool(1, warm1), makePool(2, warm2)];
    const macros = reconcileMacros(prevSkinBG(), pools, 2);
    expect(macros.map((m) => m.id)).toEqual([0]); // only Skin survives
    expect(macros.find((m) => m.id === 1)).toBeUndefined();
    expect(allIds(macros)).toEqual([1, 2]); // remaining macro covers all present
  });

  it("every present pool appears in exactly one macro (coverage + no dupes)", () => {
    // Mixed case: a dropped pool (2), a surviving pool, plus two orphans.
    const pools = [
      makePool(1, warm1),
      makePool(3, dark3),
      makePool(9, { labL: 59, labA: 36, labB: 27, weight: 0.05 }), // red orphan
      makePool(8, { labL: 14, labA: 1, labB: -2, weight: 0.05 }), // dark orphan
    ];
    const macros = reconcileMacros(prevSkinBG(), pools, 2);
    const flat = macros.flatMap((m) => m.poolIds);
    expect(new Set(flat).size).toBe(flat.length); // no duplicates
    expect([...flat].sort((a, b) => a - b)).toEqual([1, 3, 8, 9]); // all present covered
  });

  it("fresh seed when every prior pool vanished", () => {
    // None of prev's pools (1,2,3) survive; only brand-new pools remain.
    const pools = [
      makePool(50, { labL: 50, labA: 0, labB: 0, weight: 0.5 }),
      makePool(51, { labL: 20, labA: 0, labB: 0, weight: 0.5 }),
    ];
    const macros = reconcileMacros(prevSkinBG(), pools, 2);
    const seeded = seedMacroGroups(pools, 2);
    expect(macros).toHaveLength(seeded.length);
    expect(allIds(macros)).toEqual([50, 51]); // fresh coverage of the new pools
  });
});

// ────────── 8. reconcileMacroMatch: carry donor mapping across re-seg ──────────

describe("reconcileMacroMatch", () => {
  // Source macros: skin (warm) id 5, BG (dark) id 6 — non-zero ids on purpose.
  const sourcePools = [
    makePool(500, { labL: 60, labA: 20, labB: 22, weight: 0.5 }), // src skin
    makePool(600, { labL: 16, labA: 1, labB: -2, weight: 0.5 }), // src BG dark
  ];
  const sourceMacros: MacroGroup[] = [
    { id: 5, name: "Src Skin", poolIds: [500] },
    { id: 6, name: "Src BG", poolIds: [600] },
  ];
  // Target macros: skin id 0, BG id 1.
  const targetPools = [
    makePool(200, { labL: 58, labA: 18, labB: 20, weight: 0.5 }), // tgt skin
    makePool(210, { labL: 15, labA: 1, labB: -2, weight: 0.5 }), // tgt BG dark
  ];
  const targetMacros: MacroGroup[] = [
    { id: 0, name: "Tgt Skin", poolIds: [200] },
    { id: 1, name: "Tgt BG", poolIds: [210] },
  ];

  it("keeps a valid prev donor and re-matches an invalid one", () => {
    // Target 0 → source 5 is valid (both exist) → kept.
    // Target 1 → source 99 is invalid (no such source macro) → re-matched.
    const prev = new Map<number, number>([
      [0, 5],
      [1, 99],
    ]);
    const out = reconcileMacroMatch(
      prev,
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
    );
    expect(out.get(0)).toBe(5); // kept verbatim
    const donor1 = out.get(1)!;
    expect([5, 6]).toContain(donor1); // re-matched to a real source macro
    expect(donor1).not.toBe(99); // the stale donor is gone
    // The dark BG target should auto-match the dark BG source (id 6).
    expect(donor1).toBe(6);
  });

  it("returns exactly one entry per target macro", () => {
    const prev = new Map<number, number>([[0, 5]]); // target 1 left to auto-match
    const out = reconcileMacroMatch(
      prev,
      sourceMacros,
      sourcePools,
      targetMacros,
      targetPools,
    );
    expect(out.size).toBe(targetMacros.length);
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
    for (const donor of out.values()) {
      expect([5, 6]).toContain(donor); // every donor is a real source macro
    }
  });
});
