// Mode-aware visibility sync for Color Smash output layers.
//
// When the user flips between RGB/Lab (Curves output) and LUT (Color Lookup
// output), make the corresponding layer(s) in the [Color Smash] group
// visible and hide the other type. Lets the user A/B compare Curves vs LUT
// outputs without manually toggling eye icons.
//
// Layer naming (from applyMatch.ts + applyLut.ts):
//   Curves output: "Match Curves" (single-curve mode) OR a sub-group named
//                  "Match Curves" containing "Match Curves [Shadows|Mids|Highlights]"
//                  for multi-zone.
//   LUT output:    "Match LUT [<preset>]" — single Color Lookup layer per Apply.
//                  May be in a sub-group when target-palette mask is active.
//
// We match by name prefix so all variants are caught regardless of multi-
// zone / mask sub-grouping.

import { GROUP_NAME, app, action, executeAsModal } from "../services/photoshop";

// v1.20.62 — per-colorSpace prefixes after the v1.20.57 rename. Each mode
// has its own layer family; visibility sync needs to know all three plus
// the legacy "Match Curves" name for backward compat with old PSDs.
const RGB_PREFIX = "Match RGB";
const LAB_PREFIX = "Match Lab";
const LUT_PREFIX = "Match LUT";
const LEGACY_CURVES_PREFIX = "Match Curves"; // pre-v1.20.57 bakes

interface LayerNode { id: number; name: string; layers?: LayerNode[]; visible?: boolean }

/** Recursively collect every layer whose name matches a prefix, including
 *  the sub-groups (so we can toggle the group itself, which is cheaper
 *  than walking every descendant). */
function collectByPrefix(root: { layers?: LayerNode[] }, prefix: string, out: LayerNode[]) {
  for (const l of root.layers ?? []) {
    if (typeof l.name === "string" && (l.name === prefix || l.name.startsWith(prefix))) {
      // v1.20.64 — stop recursion at the first match. Toggling visibility
      // on a parent group implicitly governs its descendants; recursing
      // and pushing every child too caused duplicate toggles per node
      // (harmless today since both ranks want the same state, but risky
      // for any future case where band-level visibility should diverge
      // from the group's). Tree order is preserved by stopping here.
      out.push(l);
      continue;
    }
    if (l.layers) collectByPrefix(l, prefix, out);
  }
}

/** Find the [Color Smash] group at the document root. Returns null if not
 *  present — visibility sync is a no-op when no Color Smash output exists. */
function findColorSmashGroup(doc: any): any | null {
  const search = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l?.name === GROUP_NAME && (l.kind === "group" || Array.isArray(l.layers))) return l;
      if (Array.isArray(l.layers)) {
        const found = search(l.layers);
        if (found) return found;
      }
    }
    return null;
  };
  return search(doc.layers ?? []);
}

/** Set visibility on a single layer by id via batchPlay. Doesn't touch
 *  selection so the active layer stays where it was. */
async function setLayerVisible(layerId: number, visible: boolean): Promise<void> {
  await action.batchPlay([{
    _obj: visible ? "show" : "hide",
    null: [{ _ref: "layer", _id: layerId }],
  }], {});
}

/**
 * Sync output-layer visibility to the active output mode.
 *
 * - mode === "lut" → Match LUT layers visible, Match Curves layers hidden
 * - mode === "rgb" | "lab" → Match Curves layers visible, Match LUT hidden
 *
 * No-op when there's no active document, no [Color Smash] group, or no
 * matching layers to toggle. Wraps PS mutations in executeAsModal so the
 * caller doesn't need to.
 */
export async function syncOutputVisibilityToMode(mode: "rgb" | "lab" | "lut"): Promise<void> {
  const doc = app.activeDocument;
  if (!doc) return;
  const group = findColorSmashGroup(doc);
  if (!group) return;
  const rgb: LayerNode[] = [];
  const lab: LayerNode[] = [];
  const luts: LayerNode[] = [];
  const legacy: LayerNode[] = [];
  collectByPrefix(group, RGB_PREFIX, rgb);
  collectByPrefix(group, LAB_PREFIX, lab);
  collectByPrefix(group, LUT_PREFIX, luts);
  collectByPrefix(group, LEGACY_CURVES_PREFIX, legacy);
  if (rgb.length === 0 && lab.length === 0 && luts.length === 0 && legacy.length === 0) return;

  // Per-mode visibility plan:
  //   rgb mode → show "Match RGB" + legacy "Match Curves"; hide Lab + LUT.
  //   lab mode → show "Match Lab"; hide RGB + legacy + LUT.
  //   lut mode → show LUT; hide every Curves family.
  const wantRgbVisible    = mode === "rgb";
  const wantLabVisible    = mode === "lab";
  const wantLutVisible    = mode === "lut";
  const wantLegacyVisible = mode === "rgb"; // legacy bakes most likely RGB-default

  await executeAsModal("Color Smash sync output visibility", async () => {
    for (const layer of rgb)    { try { await setLayerVisible(layer.id, wantRgbVisible);    } catch { /* ignore */ } }
    for (const layer of lab)    { try { await setLayerVisible(layer.id, wantLabVisible);    } catch { /* ignore */ } }
    for (const layer of luts)   { try { await setLayerVisible(layer.id, wantLutVisible);    } catch { /* ignore */ } }
    for (const layer of legacy) { try { await setLayerVisible(layer.id, wantLegacyVisible); } catch { /* ignore */ } }
  });
}

/**
 * Reposition the [Color Smash] group so it sits directly above the given
 * target layer in the layer stack. Called when the user switches the target
 * in the plugin so existing Curves / LUT outputs (which are clipped to or
 * sit above the target) re-anchor to the new destination.
 *
 * No-op when:
 *   - No active document
 *   - No [Color Smash] group exists yet
 *   - Target layer can't be resolved
 *   - The group is already in the right place (saves a modal scope)
 */
export async function repositionGroupAboveTarget(targetLayerId: number): Promise<void> {
  const doc = app.activeDocument;
  if (!doc) return;
  const group = findColorSmashGroup(doc);
  if (!group) return;
  // Find target by recursive id lookup (target may live inside a group).
  const findById = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l?.id === targetLayerId) return l;
      if (Array.isArray(l.layers)) {
        const found = findById(l.layers);
        if (found) return found;
      }
    }
    return null;
  };
  const target = findById(doc.layers ?? []);
  if (!target) return;
  await executeAsModal("Color Smash reposition group", async () => {
    // PS's layer.move(reference, "placeBefore") puts the moved layer just
    // above the reference. "placeBefore" in PS API means "in front of in
    // the stack order" = higher in the Layers panel.
    try { await group.move(target, "placeBefore"); } catch { /* ignore */ }
  });
}
