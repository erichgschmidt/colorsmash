import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SmashRecipeSettings,
  deleteRecipe,
  listRecipes,
  renameRecipe,
  saveRecipe,
} from "./recipes";

// Minimal in-memory localStorage shim — Vitest's default environment is `node`,
// which doesn't ship `localStorage`. We back it with a Map so behavior matches
// the browser API closely enough for round-trip tests.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

function makeSettings(overrides: Partial<SmashRecipeSettings["segmentation"]> = {}): SmashRecipeSettings {
  return {
    segmentation: {
      poolCount: 6,
      edgePreservation: 50,
      regionCleanup: 30,
      colorVsValueBias: 50,
      neutralProtection: 25,
      subPaletteSize: 4,
      ...overrides,
    },
    transfer: {
      strength: 80,
      relax: 20,
      preserveLuminance: 60,
    },
  };
}

describe("recipes", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("returns an empty list when nothing has been saved", () => {
    expect(listRecipes()).toEqual([]);
  });

  it("saves a recipe and returns it from list (round-trip)", () => {
    const stored = saveRecipe("Punchy", makeSettings({ poolCount: 8 }));
    expect(stored.id).toBeTruthy();
    expect(stored.name).toBe("Punchy");
    expect(stored.segmentation.poolCount).toBe(8);
    expect(stored.createdAt).toBeGreaterThan(0);

    const all = listRecipes();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(stored.id);
    expect(all[0]!.transfer.strength).toBe(80);
  });

  it("trims whitespace and falls back when name is empty", () => {
    const named = saveRecipe("  Soft  ", makeSettings());
    expect(named.name).toBe("Soft");
    const blank = saveRecipe("   ", makeSettings());
    expect(blank.name).toBe("Untitled");
  });

  it("orders list newest-first", async () => {
    saveRecipe("Older", makeSettings());
    // Force a different createdAt — Date.now() resolution can collide in tight loops.
    await new Promise((r) => setTimeout(r, 2));
    saveRecipe("Newer", makeSettings());
    const list = listRecipes();
    expect(list.map((r) => r.name)).toEqual(["Newer", "Older"]);
  });

  it("delete removes the matching id and is a no-op for unknown ids", () => {
    const a = saveRecipe("A", makeSettings());
    const b = saveRecipe("B", makeSettings());
    deleteRecipe("does-not-exist");
    expect(listRecipes()).toHaveLength(2);
    deleteRecipe(a.id);
    const after = listRecipes();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(b.id);
  });

  it("rename updates the name in place and ignores unknown ids", () => {
    const a = saveRecipe("Old name", makeSettings());
    renameRecipe(a.id, "New name");
    expect(listRecipes()[0]!.name).toBe("New name");
    renameRecipe("ghost", "Whatever");
    expect(listRecipes()[0]!.name).toBe("New name");
  });

  it("rename keeps prior name when given blank input", () => {
    const a = saveRecipe("Keep me", makeSettings());
    renameRecipe(a.id, "   ");
    expect(listRecipes()[0]!.name).toBe("Keep me");
  });

  it("listRecipes recovers from corrupt JSON in localStorage", () => {
    globalThis.localStorage!.setItem("colorsmash.recipes.v1", "{not json");
    expect(listRecipes()).toEqual([]);
  });

  it("listRecipes skips malformed rows but keeps valid ones", () => {
    const good = saveRecipe("Good", makeSettings());
    // Inject a junk row alongside the good one.
    const raw = globalThis.localStorage!.getItem("colorsmash.recipes.v1")!;
    const arr = JSON.parse(raw);
    arr.push({ id: "junk", name: "missing fields" });
    globalThis.localStorage!.setItem("colorsmash.recipes.v1", JSON.stringify(arr));
    const list = listRecipes();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(good.id);
  });

  it("works gracefully when localStorage is missing entirely", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(listRecipes()).toEqual([]);
    // saveRecipe should still return a recipe object even if it can't persist.
    const r = saveRecipe("Ephemeral", makeSettings());
    expect(r.name).toBe("Ephemeral");
    // And subsequent reads still return [] since nothing persisted.
    expect(listRecipes()).toEqual([]);
  });
});
