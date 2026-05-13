// Tests for recipeIO.ts — format v2 schema evolution + backward compat.
//
// Uses plain object literals for HistoryEntry construction to avoid
// importing LutLayerState directly from lutXmp.ts. The state field is
// given a plausible shape with at least one key so isValidEntry passes.
//
// Test coverage:
//   1. Round-trip v2 with thumbnail + kind
//   2. Round-trip v2 without optional fields
//   3. Loader accepts v1 files (backward compat — critical)
//   4. Loader rejects v3 files (from-the-future)
//   5. Loader rejects malformed JSON
//   6. Loader rejects wrong format tag
//   7. Mixed v1 + v2 entries in one serialized file

import { describe, it, expect } from "vitest";
import { serializeRecipes, parseRecipes, freshRecipeId } from "./recipeIO";
import { HistoryEntry } from "./recentHistory";

/** Minimal valid HistoryEntry factory. State has at least one key so
 *  isValidEntry's empty-state guard passes. */
function mkEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: freshRecipeId(),
    timestamp: Date.now(),
    label: "RGB · Color · 5 swatches",
    state: { preset: "color", paletteCount: 5 } as any,
    signature: { colors: [0xff0000, 0x00ff00], weights: [50, 50] },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Round-trip v2 with thumbnail + kind
// ---------------------------------------------------------------------------
describe("serializeRecipes / parseRecipes — v2 with thumbnail + kind", () => {
  it("serializes version 2 in the JSON envelope", () => {
    const entry = mkEntry({ thumbnail: "data:image/png;base64,iVBORw0KGgo=", kind: "smash" });
    const text = serializeRecipes([entry]);
    const raw = JSON.parse(text);
    expect(raw.version).toBe(2);
    expect(raw.format).toBe("color-smash-recipes");
  });

  it("round-trips thumbnail and kind exactly", () => {
    const THUMB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
    const entry = mkEntry({ thumbnail: THUMB, kind: "smash" });
    const text = serializeRecipes([entry]);
    const result = parseRecipes(text);
    if ("error" in result) throw new Error(`parseRecipes failed: ${result.error}`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].thumbnail).toBe(THUMB);
    expect(result.entries[0].kind).toBe("smash");
  });

  it("round-trips kind: 'match' exactly", () => {
    const entry = mkEntry({ kind: "match" });
    const text = serializeRecipes([entry]);
    const result = parseRecipes(text);
    if ("error" in result) throw new Error(`parseRecipes failed: ${result.error}`);
    expect(result.entries[0].kind).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip v2 without optional fields
// ---------------------------------------------------------------------------
describe("serializeRecipes / parseRecipes — v2 without optional fields", () => {
  it("valid entry without thumbnail/kind round-trips cleanly", () => {
    const entry = mkEntry();  // no thumbnail, no kind
    const text = serializeRecipes([entry]);
    const result = parseRecipes(text);
    if ("error" in result) throw new Error(`parseRecipes failed: ${result.error}`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].thumbnail).toBeUndefined();
    expect(result.entries[0].kind).toBeUndefined();
  });

  it("does not stamp defaults onto missing optional fields", () => {
    const entry = mkEntry();
    const text = serializeRecipes([entry]);
    const result = parseRecipes(text);
    if ("error" in result) throw new Error(`parseRecipes failed: ${result.error}`);
    // Neither field should be present (even as null or empty string)
    expect("thumbnail" in result.entries[0]).toBe(false);
    expect("kind" in result.entries[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Loader accepts v1 files (backward compat — critical)
// ---------------------------------------------------------------------------
describe("parseRecipes — backward compat: v1 files", () => {
  it("loads a hand-written v1 file without error", () => {
    const v1Json = JSON.stringify({
      format: "color-smash-recipes",
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      pluginVersion: "1.20.65",
      entries: [
        {
          id: "abc123-def456",
          timestamp: 1704067200000,
          label: "RGB · Color · 5 swatches",
          state: { preset: "color", paletteCount: 5 },
          signature: { colors: [0xff0000], weights: [100] },
        },
      ],
    });
    const result = parseRecipes(v1Json);
    if ("error" in result) throw new Error(`v1 file rejected: ${result.error}`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("abc123-def456");
    // New optional fields must be absent — not stamped with defaults
    expect(result.entries[0].thumbnail).toBeUndefined();
    expect(result.entries[0].kind).toBeUndefined();
  });

  it("loads a v1 file with multiple entries", () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      id: `entry-${i}`,
      timestamp: 1704067200000 + i * 1000,
      label: `RGB · Color · ${i + 1} swatches`,
      state: { preset: "full", paletteCount: i + 1 },
      signature: { colors: [0x888888], weights: [100] },
    }));
    const v1Json = JSON.stringify({
      format: "color-smash-recipes",
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      entries,
    });
    const result = parseRecipes(v1Json);
    if ("error" in result) throw new Error(`v1 multi-entry file rejected: ${result.error}`);
    expect(result.entries).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Loader rejects v3 (from-the-future)
// ---------------------------------------------------------------------------
describe("parseRecipes — future version rejection", () => {
  it("returns an error object for version 3", () => {
    const futureJson = JSON.stringify({
      format: "color-smash-recipes",
      version: 3,
      exportedAt: "2030-01-01T00:00:00.000Z",
      entries: [],
    });
    const result = parseRecipes(futureJson);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/newer plugin version/i);
      expect(result.error).toContain("3");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Loader rejects malformed JSON
// ---------------------------------------------------------------------------
describe("parseRecipes — malformed JSON", () => {
  it("returns an error for completely invalid JSON", () => {
    const result = parseRecipes("not json at all {{{{");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/not valid json/i);
    }
  });

  it("returns an error for truncated JSON", () => {
    const result = parseRecipes('{"format": "color-smash-recipes", "version":');
    expect("error" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Loader rejects wrong format tag
// ---------------------------------------------------------------------------
describe("parseRecipes — wrong format tag", () => {
  it("rejects a file with the wrong format field", () => {
    const badTag = JSON.stringify({
      format: "other-plugin-recipes",
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      entries: [],
    });
    const result = parseRecipes(badTag);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/wrong format tag/i);
    }
  });

  it("rejects a file missing the format field entirely", () => {
    const noTag = JSON.stringify({
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      entries: [],
    });
    const result = parseRecipes(noTag);
    expect("error" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Mixed v1 + v2 entries: load v1, add thumbnail, serialize as v2, re-parse
// ---------------------------------------------------------------------------
describe("parseRecipes — mixed v1 + v2 entries round-trip", () => {
  it("coexists entries with and without thumbnail after serializing as v2", () => {
    // Step 1: load a v1 file with two entries
    const v1Json = JSON.stringify({
      format: "color-smash-recipes",
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      entries: [
        {
          id: "entry-a",
          timestamp: 1704067200000,
          label: "RGB · Color · 5 swatches",
          state: { preset: "color", paletteCount: 5 },
          signature: { colors: [0xff0000], weights: [100] },
        },
        {
          id: "entry-b",
          timestamp: 1704067201000,
          label: "RGB · Full · 3 swatches",
          state: { preset: "full", paletteCount: 3 },
          signature: { colors: [0x0000ff], weights: [100] },
        },
      ],
    });
    const loadResult = parseRecipes(v1Json);
    if ("error" in loadResult) throw new Error(`v1 load failed: ${loadResult.error}`);
    expect(loadResult.entries).toHaveLength(2);

    // Step 2: add thumbnail to the first entry programmatically
    const THUMB = "data:image/png;base64,iVBORw0KGgo=";
    const enriched: HistoryEntry[] = [
      { ...loadResult.entries[0], thumbnail: THUMB, kind: "smash" as const },
      loadResult.entries[1], // unchanged — no thumbnail, no kind
    ];

    // Step 3: serialize as v2
    const v2Text = serializeRecipes(enriched);
    const v2Raw = JSON.parse(v2Text);
    expect(v2Raw.version).toBe(2);

    // Step 4: re-parse the v2 file
    const reParseResult = parseRecipes(v2Text);
    if ("error" in reParseResult) throw new Error(`v2 re-parse failed: ${reParseResult.error}`);
    expect(reParseResult.entries).toHaveLength(2);

    // Entry with thumbnail/kind preserved
    const withThumb = reParseResult.entries.find(e => e.id === "entry-a");
    expect(withThumb).toBeDefined();
    expect(withThumb!.thumbnail).toBe(THUMB);
    expect(withThumb!.kind).toBe("smash");

    // Entry without thumbnail/kind remains clean
    const withoutThumb = reParseResult.entries.find(e => e.id === "entry-b");
    expect(withoutThumb).toBeDefined();
    expect(withoutThumb!.thumbnail).toBeUndefined();
    expect(withoutThumb!.kind).toBeUndefined();
  });
});
