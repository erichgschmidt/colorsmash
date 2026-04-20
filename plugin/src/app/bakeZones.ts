// Bake zones into a [Color Smash] zones group of native PS adjustment layers.
// Each non-default zone produces:
//   - Curves (composite) for value shift                  — if value != 0
//   - Curves (R, G, B per-channel) for color shift        — if colorIntensity > 0
//   - Hue/Saturation                                      — if hue or sat != 0
// All gated by Blend If trapezoid matching the zone's range + feather.

import {
  executeAsModal, getActiveDoc,
  makeHueSatLayer, makeCurvesLayer, setLayerBlendIf,
} from "../services/photoshop";
import { type ZonesState, type ZoneState, valueCurve, colorShiftCurves } from "../core/zoneTransform";

const GROUP_NAME = "[Color Smash] zones";

function zoneIsActive(z: ZoneState): boolean {
  return z.hue !== 0 || z.sat !== 0 || z.value !== 0 || z.colorIntensity > 0;
}

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
    let layersAdded = 0;
    const order: ["highlights", "midtones", "shadows"] = ["highlights", "midtones", "shadows"];

    for (const zoneName of order) {
      const z = zones[zoneName];
      if (!zoneIsActive(z)) continue;
      const blend = blendIfFor(z);

      if (z.value !== 0) {
        const cv = await makeCurvesLayer(`${zoneName} value`, [
          { channel: "composite", points: valueCurve(z) },
        ]);
        await cv.move(group, "placeInside");
        try { await setLayerBlendIf(cv, blend); } catch (e) { console.warn("blendIf failed:", e); }
        layersAdded++;
      }

      if (z.colorIntensity > 0) {
        const cs = colorShiftCurves(z);
        const cc = await makeCurvesLayer(`${zoneName} color`, [
          { channel: "red",   points: cs.r },
          { channel: "green", points: cs.g },
          { channel: "blue",  points: cs.b },
        ]);
        await cc.move(group, "placeInside");
        try { await setLayerBlendIf(cc, blend); } catch (e) { console.warn("blendIf failed:", e); }
        layersAdded++;
      }

      if (z.hue !== 0 || z.sat !== 0) {
        const hs = await makeHueSatLayer(`${zoneName} hue/sat`, { hue: z.hue, saturation: z.sat });
        await hs.move(group, "placeInside");
        try { await setLayerBlendIf(hs, blend); } catch (e) { console.warn("blendIf failed:", e); }
        layersAdded++;
      }
    }

    return layersAdded === 0
      ? "Nothing to bake — all zones at defaults."
      : `Baked ${layersAdded} layer(s) into ${GROUP_NAME}.`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
