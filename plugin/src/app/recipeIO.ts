// Recipe export / import. v1.20.65.
//
// Recipes are HistoryEntry objects (defined in recentHistory.ts) but for
// portability we wrap them in a versioned envelope:
//   {
//     format: "color-smash-recipes",
//     version: 1,
//     exportedAt: <ISO date>,
//     pluginVersion: "1.20.65",
//     entries: [HistoryEntry, ...]
//   }
//
// The envelope lets us evolve the file format without breaking older imports.
// On import: validate envelope shape → reuse pruneHistory's per-entry sanitizer
// (drops malformed/empty entries silently) → return the valid set.
//
// Cross-machine portability is the goal:
//   - Each imported entry gets a FRESH id (so imports never collide with
//     existing entries via id), and is marked pinned (so it sits at the
//     front of the history and survives ring-buffer eviction).
//   - Source/target doc/layer ids in the entry's state are MEANINGLESS on
//     another machine — they reference docs the other user doesn't have.
//     Stripped at export so they don't leak (or get re-applied on RESTORE
//     and confuse the importer).

import { HistoryEntry, pruneHistory } from "./recentHistory";

/** Wrap a set of entries in the export envelope. */
export interface RecipeExportFile {
  format: "color-smash-recipes";
  version: 1;
  exportedAt: string;            // ISO 8601
  pluginVersion?: string;
  entries: HistoryEntry[];
}

const FORMAT_TAG = "color-smash-recipes";
const FORMAT_VERSION = 1;

/** Build the exportable envelope from a set of entries.
 *  - Strips source/target doc + layer ids from each entry's state (those
 *    reference local docs and confuse cross-machine imports).
 *  - Strips the `pinned` flag (importer always pins fresh imports).
 *  - Preserves customName and signature so the entry restores cleanly. */
export function serializeRecipes(entries: HistoryEntry[], pluginVersion?: string): string {
  const stripped: HistoryEntry[] = entries.map(e => ({
    ...e,
    pinned: undefined,
    state: {
      ...e.state,
      sourceDocId: null,
      sourceLayerId: null,
      targetDocId: null,
      targetLayerId: null,
    },
  }));
  const file: RecipeExportFile = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion,
    entries: stripped,
  };
  return JSON.stringify(file, null, 2);
}

/** Parse + validate a recipe export file. Returns the entries if valid,
 *  or an error message string explaining why parsing failed.
 *  - Wrong/missing format tag → error
 *  - Wrong version → error (caller can decide whether to attempt
 *    backward-compat or surface to the user)
 *  - Per-entry validation reuses pruneHistory's isValidEntry by piping
 *    the entries through it; malformed entries are dropped silently. */
export function parseRecipes(text: string): { entries: HistoryEntry[] } | { error: string } {
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch (e: any) { return { error: `Not valid JSON: ${e?.message ?? e}` }; }
  if (!parsed || typeof parsed !== "object") return { error: "File is not a recipe export." };
  if (parsed.format !== FORMAT_TAG) return { error: `Wrong format tag: expected ${FORMAT_TAG}, got ${parsed.format}` };
  if (typeof parsed.version !== "number") return { error: "Missing or invalid version." };
  if (parsed.version > FORMAT_VERSION) {
    return { error: `File is from a newer plugin version (format v${parsed.version}). Update the plugin to import.` };
  }
  if (!Array.isArray(parsed.entries)) return { error: "Missing entries array." };
  // pruneHistory drops invalid entries via isValidEntry and applies the
  // cap. We don't want capping at parse time (caller decides the merge),
  // so pass a high cap.
  const valid = pruneHistory(parsed.entries, 999);
  return { entries: valid };
}

/** Generate a fresh id for an imported entry (same shape as the
 *  internal makeId() but exposed here so the importer can rewrite
 *  collisions). */
export function freshRecipeId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Merge imported entries into an existing history list. Strategy:
 *  - Each imported entry gets a fresh id (no collisions ever)
 *  - Each imported entry is auto-pinned (so it doesn't get evicted)
 *  - Already-imported entries with the same dedupKey are skipped to
 *    avoid duplicates (returns the skipped count)
 *  - Order: imports prepend to the front of the pinned section
 *
 *  Uses dedupKey from recentHistory.ts (re-exported below for testability). */
export function mergeImportedRecipes(
  existing: HistoryEntry[],
  imported: HistoryEntry[],
  dedupFn: (state: HistoryEntry["state"]) => string,
): { merged: HistoryEntry[]; added: number; skipped: number } {
  const existingKeys = new Set(existing.map(e => dedupFn(e.state)));
  let added = 0, skipped = 0;
  const additions: HistoryEntry[] = [];
  for (const imp of imported) {
    const key = dedupFn(imp.state);
    if (existingKeys.has(key)) { skipped++; continue; }
    additions.push({
      ...imp,
      id: freshRecipeId(),
      timestamp: Date.now(),
      pinned: true,
    });
    existingKeys.add(key);
    added++;
  }
  return { merged: [...additions, ...existing], added, skipped };
}
