// Smash tab user preferences — small, synchronous settings persisted to
// localStorage. Today this is just the output layer/group base name so users
// can run multiple Smashes into one document without the result layers
// colliding ("Color Smash", "Color Smash 2", "Color Smash 3"…).
//
// Storage choice mirrors core/recipes.ts: localStorage, single versioned
// key, all access wrapped to degrade gracefully if storage is unavailable
// or the stored blob is corrupt.

const STORAGE_KEY = "colorsmash.prefs.v1";

export interface SmashPrefs {
  outputName: string; // base name for the output single layer / group
}

export const DEFAULT_PREFS: SmashPrefs = {
  outputName: "Color Smash",
};

// ---- storage primitives ----------------------------------------------------

// Read the raw localStorage instance, or null if running somewhere it isn't
// available (SSR-ish contexts, locked-down environments, etc).
function getStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Touch a probe key — some hosts expose `localStorage` but throw on access.
    const probe = "__colorsmash_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

// ---- public API ------------------------------------------------------------

// Read prefs from localStorage. Missing or corrupt → DEFAULT_PREFS.
export function loadPrefs(): SmashPrefs {
  const ls = getStorage();
  if (!ls) return { ...DEFAULT_PREFS };
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFS };
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.outputName === "string" ? obj.outputName.trim() : "";
    return {
      outputName: name.length > 0 ? name : DEFAULT_PREFS.outputName,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// Persist prefs. Trims `outputName`; falls back to default if blank.
export function savePrefs(prefs: SmashPrefs): void {
  const ls = getStorage();
  if (!ls) return;
  const trimmed = (prefs.outputName ?? "").trim();
  const normalized: SmashPrefs = {
    outputName: trimmed.length > 0 ? trimmed : DEFAULT_PREFS.outputName,
  };
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* swallow — quota / disabled storage */
  }
}
