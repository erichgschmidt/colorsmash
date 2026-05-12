// Live update path for the Match Curves adjustment layer (RGB/Lab modes).
//
// Mirrors what LIVE LUT does for Color Lookup layers: find the existing
// Match Curves layer in [Color Smash] and update its curves descriptor in
// place via batchPlay `set`. No layer recreation, no flicker, no palette-
// mask regeneration (mask is whatever Apply set it to — it stays in sync
// because palette mask only changes when target weights change, and LIVE
// re-bakes the mask via the same effect path... well, except not yet —
// for v1.16.4 the mask is whatever Apply produced last. Re-baking the
// mask live is a follow-up if users notice it lagging).
//
// Why a separate file from applyMatch.ts: applyMatch is a full-pipeline
// dispatcher (pixel reads, palette mask, multi-zone, blend-if, etc).
// Live updates skip all that and just push new curve control points to
// an existing layer's descriptor.

import {
  ChannelCurves, Preset, sampleControlPoints, transformCurvesForPreset,
} from "../core/histogramMatch";
import { GROUP_NAME, action, app, executeAsModal } from "../services/photoshop";

// v1.20.57 — Curves bakes now use per-colorSpace names: 'Match RGB' and
// 'Match Lab'. We match either prefix for the LIVE update path.
const CURVES_LAYER_PREFIXES = ["Match RGB", "Match Lab", "Match Curves"];
function isCurvesLayerName(name: string | undefined): boolean {
  return typeof name === "string" && CURVES_LAYER_PREFIXES.some(p => name.startsWith(p));
}
const CONTROL_POINTS = 12;

interface LayerNode { id: number; name: string; kind?: string; layers?: LayerNode[] }

/** Find the single non-group Match Curves layer (i.e., single-curve mode's
 *  output, not a multi-zone band layer). Returns null if not found. */
function findSingleMatchCurvesLayer(parent: { layers?: LayerNode[] }): LayerNode | null {
  for (const l of parent.layers ?? []) {
    // Skip groups — those are the multi-zone sub-groups, which need different
    // handling (3 separate layers). Single-curve mode produces a flat layer.
    const isGroup = l.kind === "group" || Array.isArray(l.layers);
    if (isGroup) {
      // Recurse into groups (which includes the [Color Smash] group itself).
      const found = findSingleMatchCurvesLayer(l);
      if (found) return found;
      continue;
    }
    if (isCurvesLayerName(l.name)) {
      return l;
    }
  }
  return null;
}

/** Locate the [Color Smash] group; return null if absent. */
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

/**
 * Preset → layer blend mode mapping. Matches what applyMatch sets at Apply
 * time so LIVE keeps the blend mode in sync if the user toggles presets
 * after seeding the layer.
 */
function presetBlendMode(preset: Preset): string {
  switch (preset) {
    case "hue":            return "color";       // user-facing "Color" preset
    case "hueOnly":        return "hue";
    case "saturationOnly": return "saturation";
    case "contrast":       return "luminosity";
    default:               return "normal";      // "color" preset (user-facing "Full")
  }
}

/**
 * Update an existing Match Curves layer's curves descriptor + blend mode
 * in place. Returns true on success, false if the layer can't be found or
 * the descriptor call fails.
 *
 * No-op if there's no [Color Smash] group, no single-curve Match Curves
 * layer (e.g. user hasn't hit Apply yet, OR they're in multi-zone mode
 * which produces a sub-group of band layers instead).
 */
export async function updateMatchCurvesLayerInPlace(
  curves: ChannelCurves,
  preset: Preset,
): Promise<{ ok: boolean; layerId: number | null }> {
  const doc = app.activeDocument;
  if (!doc) return { ok: false, layerId: null };
  const group = findColorSmashGroup(doc);
  if (!group) return { ok: false, layerId: null };
  const layer = findSingleMatchCurvesLayer(group);
  if (!layer) return { ok: false, layerId: null };

  // Apply preset's curve transformation (contrast = R=G=B average; others
  // keep per-channel). Same as applyMatch does at Apply time.
  const finalCurves = transformCurvesForPreset(curves, preset);
  const r = sampleControlPoints(finalCurves.r, CONTROL_POINTS);
  const g = sampleControlPoints(finalCurves.g, CONTROL_POINTS);
  const b = sampleControlPoints(finalCurves.b, CONTROL_POINTS);

  const layerId = layer.id;
  return await executeAsModal("Color Smash live curves update", async () => {
    try {
      // batchPlay 'set' on the adjustment layer's curves descriptor.
      // Mirrors makeCurvesLayer's shape but with 'set' verb on existing layer.
      await action.batchPlay([{
        _obj: "set",
        _target: [{ _ref: "adjustmentLayer", _id: layerId }],
        to: {
          _obj: "curves",
          presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
          adjustment: [
            { _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "red" },
              curve: r.map(p => ({ _obj: "paint", horizontal: p.input, vertical: p.output })) },
            { _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "green" },
              curve: g.map(p => ({ _obj: "paint", horizontal: p.input, vertical: p.output })) },
            { _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "blue" },
              curve: b.map(p => ({ _obj: "paint", horizontal: p.input, vertical: p.output })) },
          ],
        },
      }], {});
      // Also keep blend mode in sync — preset may have changed since the
      // layer was first authored, and applyMatch sets blendMode on Apply.
      try {
        const blend = presetBlendMode(preset);
        await action.batchPlay([{
          _obj: "set",
          _target: [{ _ref: "layer", _id: layerId }],
          to: { _obj: "layer", mode: { _enum: "blendMode", _value: blend } },
        }], {});
      } catch { /* non-fatal — blend mode update isn't critical for live preview */ }
      return { ok: true, layerId };
    } catch {
      return { ok: false, layerId: null };
    }
  });
}
