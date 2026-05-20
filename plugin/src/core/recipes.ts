// Smash recipes — named bundles of the Smash tab's global controls (segmentation +
// transfer knobs). Per-image data (manual pool→pool remaps, focal anchor positions)
// is intentionally NOT included: those reference segmentation-specific pool ids and
// don't transfer meaningfully to a different image.
//
// Storage: localStorage under a single versioned key. We use localStorage (not the
// UXP fs-based persistence in ui/persistence.ts) per spec — recipes are small,
// synchronous, and benefit from instant read on mount. All access is wrapped to
// degrade gracefully if localStorage is unavailable or the stored blob is corrupt.

const STORAGE_KEY = "colorsmash.recipes.v1";

export interface SmashRecipeSettings {
  segmentation: {
    poolCount: number;
    edgePreservation: number;
    regionCleanup: number;
    colorVsValueBias: number;
    neutralProtection: number;
    subPaletteSize: number;
  };
  transfer: {
    strength: number;
    relax: number;
    preserveLuminance: number;
  };
}

export interface SmashRecipe extends SmashRecipeSettings {
  id: string;
  name: string;
  createdAt: number;
}

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

function readAll(): SmashRecipe[] {
  const ls = getStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Loose validation — accept anything that looks like a recipe shape and
    // skip rows that don't, so a partially-corrupt blob doesn't nuke the list.
    return parsed.filter(isRecipe);
  } catch {
    return [];
  }
}

function writeAll(recipes: SmashRecipe[]): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(recipes));
  } catch {
    /* swallow — quota / disabled storage */
  }
}

function isRecipe(value: unknown): value is SmashRecipe {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return false;
  if (typeof r.createdAt !== "number") return false;
  const seg = r.segmentation as Record<string, unknown> | undefined;
  const tx = r.transfer as Record<string, unknown> | undefined;
  if (!seg || !tx) return false;
  const segKeys: (keyof SmashRecipeSettings["segmentation"])[] = [
    "poolCount", "edgePreservation", "regionCleanup",
    "colorVsValueBias", "neutralProtection", "subPaletteSize",
  ];
  const txKeys: (keyof SmashRecipeSettings["transfer"])[] = [
    "strength", "relax", "preserveLuminance",
  ];
  for (const k of segKeys) if (typeof seg[k] !== "number") return false;
  for (const k of txKeys) if (typeof tx[k] !== "number") return false;
  return true;
}

// ---- id minting ------------------------------------------------------------

function mintId(): string {
  // Timestamp prefix keeps ids loosely sortable; random suffix avoids collisions
  // when two saves happen in the same millisecond.
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${suffix}`;
}

// ---- public API ------------------------------------------------------------

// Newest first.
export function listRecipes(): SmashRecipe[] {
  const all = readAll();
  return all.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function saveRecipe(name: string, settings: SmashRecipeSettings): SmashRecipe {
  const recipe: SmashRecipe = {
    id: mintId(),
    name: name.trim() || "Untitled",
    createdAt: Date.now(),
    segmentation: { ...settings.segmentation },
    transfer: { ...settings.transfer },
  };
  const next = readAll();
  next.push(recipe);
  writeAll(next);
  return recipe;
}

export function deleteRecipe(id: string): void {
  const all = readAll();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return;
  writeAll(next);
}

export function renameRecipe(id: string, name: string): void {
  const all = readAll();
  let changed = false;
  const next = all.map((r) => {
    if (r.id !== id) return r;
    changed = true;
    return { ...r, name: name.trim() || r.name };
  });
  if (!changed) return;
  writeAll(next);
}
