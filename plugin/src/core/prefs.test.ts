import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "./prefs";

// Minimal in-memory localStorage shim — mirrors recipes.test.ts. Vitest's
// default node env doesn't ship `localStorage`, so we back it with a Map.
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

describe("prefs", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("returns DEFAULT_PREFS when nothing has been saved", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("round-trips a saved outputName", () => {
    savePrefs({ outputName: "Smash 2026" });
    expect(loadPrefs()).toEqual({ outputName: "Smash 2026" });
  });

  it("trims whitespace on save and falls back to default for blank input", () => {
    savePrefs({ outputName: "  Padded  " });
    expect(loadPrefs().outputName).toBe("Padded");

    savePrefs({ outputName: "   " });
    expect(loadPrefs().outputName).toBe(DEFAULT_PREFS.outputName);
  });

  it("recovers from corrupt JSON in localStorage", () => {
    globalThis.localStorage!.setItem("colorsmash.prefs.v1", "{not json");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("works gracefully when localStorage is missing entirely", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    // loadPrefs returns defaults; savePrefs is a no-op (no throw).
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs({ outputName: "X" })).not.toThrow();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});
