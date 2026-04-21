// Bake zones into a [Color Smash] zones group of native PS adjustment layers.
// Each non-default zone produces:
//   - Curves (composite) for value shift                  — if value != 0
//   - Curves (R, G, B per-channel) for color shift        — if colorIntensity > 0
//   - Hue/Saturation                                      — if hue or sat != 0
// All gated by Blend If trapezoid matching the zone's range + feather.

import {
  executeAsModal, getActiveDoc,
  makeHueSatLayer, makeCurvesLayer, makeLevelsLayer, setLayerBlendIf, setClippingMask,
} from "../services/photoshop";
import { type ZonesState, type ZoneState, colorShiftCurves, IDENTITY_TONAL, lutToCurvePoints } from "../core/zoneTransform";

const GROUP_NAME = "[Color Smash] zones";

// Always emit the same layer skeleton so the user can compare results across edits without
// the structure changing. Inactive zones produce identity layers (no visual effect).
function blendIfFor(z: ZoneState) {
  const a = Math.min(z.rangeStart, z.rangeEnd);
  const b = Math.max(z.rangeStart, z.rangeEnd);
  const fL = Math.max(0, z.featherLeft);
  const fR = Math.max(0, z.featherRight);
  const pct = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 2.55);
  return {
    blackMin: pct(a - fL),
    blackMax: pct(a),
    whiteMin: pct(b),
    whiteMax: pct(b + fR),
  };
}

async function deleteRecursive(layer: any): Promise<void> {
  // UXP can orphan children when deleting a group, so always nuke children first.
  const children = [...(layer.layers ?? [])];
  for (const c of children) {
    try { await deleteRecursive(c); } catch { /* ignore */ }
  }
  try { await layer.delete(); } catch { /* ignore */ }
}

async function purgeAllZoneGroups(): Promise<number> {
  const doc = getActiveDoc();
  // Collect every top-level [Color Smash] zones group; could be more than one if a prior bake
  // somehow duplicated. Delete them all.
  const targets = doc.layers.filter((l: any) => l.name === GROUP_NAME);
  for (const t of targets) await deleteRecursive(t);
  return targets.length;
}

export async function bakeZones(zones: ZonesState): Promise<string> {
  return executeAsModal("Color Smash bake zones", async () => {
    const doc = getActiveDoc();
    const purged = await purgeAllZoneGroups();
    void purged;
    const group = await doc.createLayerGroup({ name: GROUP_NAME });

    // Global tonal layer — applied first by PS (bottom of group).
    // If we have a histogram-match LUT, emit it as a Curves layer (17 anchors) since Levels
    // can't express a non-linear lookup. Otherwise use a Levels layer with the affine params.
    const tonal = zones.tonal ?? IDENTITY_TONAL;
    let tonalLayer: any;
    if (tonal.matchCurve) {
      tonalLayer = await makeCurvesLayer("tonal (histogram match)", [
        { channel: "composite", points: lutToCurvePoints(tonal.matchCurve, 17) },
      ]);
    } else {
      tonalLayer = await makeLevelsLayer("tonal", tonal);
    }
    await tonalLayer.move(group, "placeInside");
    try { await setClippingMask(tonalLayer, true); } catch (e) { console.warn("clipping failed:", e); }
    let layersAdded = 1;

    // Per-zone subgroups, created shadows → midtones → highlights so highlights ends at top.
    const zoneOrder: ("shadows" | "midtones" | "highlights")[] = ["shadows", "midtones", "highlights"];

    for (const zoneName of zoneOrder) {
      const z = zones[zoneName];
      const blend = blendIfFor(z);

      const subGroup = await doc.createLayerGroup({ name: zoneName });
      await subGroup.move(group, "placeInside");

      const addLayer = async (layer: any) => {
        await layer.move(subGroup, "placeInside");
        try { await setLayerBlendIf(layer, blend); } catch (e) { console.warn("blendIf failed:", e); }
        try { await setClippingMask(layer, true); } catch (e) { console.warn("clipping failed:", e); }
        layersAdded++;
      };

      // Create order within zone: color → hue/sat. Each placeInside puts on top of subgroup.
      const cs = colorShiftCurves(z);
      const cc = await makeCurvesLayer(`${zoneName} color`, [
        { channel: "red",   points: cs.r },
        { channel: "green", points: cs.g },
        { channel: "blue",  points: cs.b },
      ]);
      await addLayer(cc);

      const hs = await makeHueSatLayer(`${zoneName} hue/sat`, { hue: z.hue, saturation: z.sat });
      await addLayer(hs);
    }

    return `Baked ${layersAdded} layers into ${GROUP_NAME} (3 zone subgroups).`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
