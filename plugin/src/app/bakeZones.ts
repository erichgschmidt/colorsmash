// Bake zones into a [Color Smash] zones group of native PS adjustment layers.
// Each non-default zone produces:
//   - Curves (composite) for value shift                  — if value != 0
//   - Curves (R, G, B per-channel) for color shift        — if colorIntensity > 0
//   - Hue/Saturation                                      — if hue or sat != 0
// All gated by Blend If trapezoid matching the zone's range + feather.

import {
  executeAsModal, getActiveDoc,
  makeHueSatLayer, makeCurvesLayer, setLayerBlendIf, setClippingMask,
} from "../services/photoshop";
import { type ZonesState, type ZoneState, valueCurve, colorShiftCurves } from "../core/zoneTransform";

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

async function findExistingGroup(): Promise<any | null> {
  const doc = getActiveDoc();
  for (const l of doc.layers) {
    if (l.name === GROUP_NAME) return l;
  }
  return null;
}

export async function bakeZones(zones: ZonesState): Promise<string> {
  return executeAsModal("Color Smash bake zones", async () => {
    const doc = getActiveDoc();
    const prior = await findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }
    const group = await doc.createLayerGroup({ name: GROUP_NAME });

    // Create order: shadows → midtones → highlights. Each move with placeInside stacks on top
    // of existing children, so final stack (top→bottom) = highlights, midtones, shadows. PS
    // renders bottom→top, so shadows applies first, then midtones, then highlights — matching
    // the simulator's per-zone application order.
    // Within each zone: value → color → hue/sat (created in that order, ends with hue/sat on top
    // of the zone subgroup → applied last per the simulator).
    const zoneOrder: ("shadows" | "midtones" | "highlights")[] = ["shadows", "midtones", "highlights"];
    let layersAdded = 0;

    for (const zoneName of zoneOrder) {
      const z = zones[zoneName];
      const blend = blendIfFor(z);

      const addLayer = async (layer: any) => {
        await layer.move(group, "placeInside");
        try { await setLayerBlendIf(layer, blend); } catch (e) { console.warn("blendIf failed:", e); }
        try { await setClippingMask(layer, true); } catch (e) { console.warn("clipping failed:", e); }
        layersAdded++;
      };

      // Always create all 3 adjustment types per zone — identity values when zone is inactive.
      const cv = await makeCurvesLayer(`${zoneName} value`, [
        { channel: "composite", points: valueCurve(z) },
      ]);
      await addLayer(cv);

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

    return `Baked ${layersAdded} layers into ${GROUP_NAME} (consistent skeleton).`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
