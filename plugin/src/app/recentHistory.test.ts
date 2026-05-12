import { describe, it, expect } from "vitest";
import {
  buildPaletteSignature,
  buildHistoryLabel,
  dedupKey,
  pushHistoryEntry,
  pruneHistory,
  makeHistoryEntry,
  HistoryEntry,
} from "./recentHistory";
import { LutLayerState, SerializedSwatch } from "./lutXmp";

function mkState(over: Partial<LutLayerState> = {}): LutLayerState {
  return {
    xmpVersion: 1,
    preset: "color",
    outputMode: "rgb",
    paletteCount: 5,
    sourcePaletteWeights: [1, 1, 1, 1, 1],
    targetPaletteWeights: [1, 1, 1, 1, 1],
    sourceSoftness: 0,
    targetSoftness: 0,
    ...over,
  };
}

function mkSwatch(r: number, g: number, b: number, weight = 0.2): SerializedSwatch {
  return { r, g, b, weight, labL: 0, labA: 0, labB: 0 };
}

describe("buildPaletteSignature", () => {
  it("handles empty/undefined gracefully with #888 fallback", () => {
    expect(buildPaletteSignature(undefined)).toEqual({ colors: [0x888888], weights: [100] });
    expect(buildPaletteSignature([])).toEqual({ colors: [0x888888], weights: [100] });
  });

  it("packs RGB into 0xRRGGBB and weights × 100 rounded", () => {
    const sig = buildPaletteSignature([mkSwatch(255, 0, 0, 0.5), mkSwatch(0, 255, 0, 0.25)]);
    expect(sig.colors).toEqual([0xff0000, 0x00ff00]);
    expect(sig.weights).toEqual([50, 25]);
  });

  it("clamps out-of-range bytes", () => {
    const sig = buildPaletteSignature([mkSwatch(-10, 300, 128, 1)]);
    expect(sig.colors).toEqual([(0 << 16) | (255 << 8) | 128]);
  });
});

describe("buildHistoryLabel", () => {
  it("formats mode/preset/swatch count", () => {
    const l = buildHistoryLabel(mkState({ outputMode: "lut", preset: "color", paletteCount: 5 }));
    expect(l).toMatch(/LUT/);
    expect(l).toMatch(/Color/);
    expect(l).toMatch(/5 swatches/);
  });

  it("appends Multi when multiZone is true", () => {
    const l = buildHistoryLabel(mkState({ multiZone: true }));
    expect(l).toMatch(/Multi/);
  });

  it("stays under 40 chars", () => {
    const l = buildHistoryLabel(
      mkState({ preset: "verylongpresetnamethatshouldgettruncated", multiZone: true }),
    );
    expect(l.length).toBeLessThanOrEqual(40);
  });
});

describe("pushHistoryEntry", () => {
  it("evicts oldest when exceeding max", () => {
    let h: HistoryEntry[] = [];
    for (let i = 0; i < 7; i++) {
      h = pushHistoryEntry(h, makeHistoryEntry(mkState({ preset: `p${i}` })), 5);
    }
    expect(h.length).toBe(5);
    expect(h[0].state.preset).toBe("p6");
    expect(h[4].state.preset).toBe("p2");
  });

  it("dedupes immediate duplicate (same dedupKey as history[0])", () => {
    const s = mkState({ preset: "color" });
    const e1 = makeHistoryEntry(s);
    const e2 = makeHistoryEntry(s);
    let h = pushHistoryEntry([], e1, 5);
    h = pushHistoryEntry(h, e2, 5);
    expect(h.length).toBe(1);
    expect(h[0].id).toBe(e1.id);
  });

  it("does NOT dedupe non-adjacent duplicate (A -> B -> A)", () => {
    const a = makeHistoryEntry(mkState({ preset: "alpha" }));
    const b = makeHistoryEntry(mkState({ preset: "beta" }));
    const a2 = makeHistoryEntry(mkState({ preset: "alpha" }));
    let h = pushHistoryEntry([], a, 5);
    h = pushHistoryEntry(h, b, 5);
    h = pushHistoryEntry(h, a2, 5);
    expect(h.length).toBe(3);
    expect(h[0].state.preset).toBe("alpha");
    expect(h[1].state.preset).toBe("beta");
    expect(h[2].state.preset).toBe("alpha");
  });

  it("returns new array (doesn't mutate input)", () => {
    const orig: HistoryEntry[] = [];
    const next = pushHistoryEntry(orig, makeHistoryEntry(mkState()), 5);
    expect(next).not.toBe(orig);
    expect(orig.length).toBe(0);
  });
});

describe("dedupKey", () => {
  it("changes when palette weights change", () => {
    const k1 = dedupKey(mkState({ sourcePaletteWeights: [1, 1, 1, 1, 1] }));
    const k2 = dedupKey(mkState({ sourcePaletteWeights: [1, 1, 0.5, 1, 1] }));
    expect(k1).not.toBe(k2);
  });

  it("is stable for identical state", () => {
    expect(dedupKey(mkState())).toBe(dedupKey(mkState()));
  });
});

describe("pruneHistory", () => {
  it("drops entries missing required fields", () => {
    // v1.20.65 — tightened isValidEntry: empty `state: {}` is no longer
    // considered restorable (would silently apply defaults on click).
    // The entry below with state:{} is now correctly dropped along with
    // null / undefined / structurally-malformed candidates.
    const good = makeHistoryEntry(mkState());
    const dirty = [
      good,
      null,
      undefined,
      { id: "x" },
      { id: "y", timestamp: 1, label: "l", state: {}, signature: { colors: [1], weights: [1] } },
      { id: "", timestamp: 1, label: "l", state: {}, signature: { colors: [], weights: [] } },
    ];
    const out = pruneHistory(dirty, 10);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe(good.id);
  });

  it("returns empty array for non-array input", () => {
    expect(pruneHistory(null)).toEqual([]);
    expect(pruneHistory(undefined)).toEqual([]);
    expect(pruneHistory("nope" as any)).toEqual([]);
  });

  it("clamps to max", () => {
    const entries = Array.from({ length: 10 }, () => makeHistoryEntry(mkState()));
    expect(pruneHistory(entries, 3).length).toBe(3);
  });
});
