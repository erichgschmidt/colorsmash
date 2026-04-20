// Bake the zones state into a [Color Smash] zones group of native PS adjustment layers.
// Each non-default zone produces:
//   - Hue/Saturation layer (if hue or sat is non-zero) gated by Blend If to the zone's L range
//   - Curves layer (if lift is non-zero) for the lift, gated the same way

import {
  executeAsModal, getActiveDoc, action,
  makeHueSatLayer, makeCurvesLayer, setLayerBlendIf,
} from "../services/photoshop";
import { type ZonesState, type ZoneState, liftCurvePoints } from "../core/zoneTransform";

const GROUP_NAME = "[Color Smash] zones";

function zoneIsActive(z: ZoneState): boolean {
  return z.hue !== 0 || z.sat !== 0 || z.lift !== 0 || z.tintAmount !== 0;
}

// Convert zone range (0..100 percent) + feathers (0..100 percent) into Blend-If "underlying" splits in 0..255.
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

// Lift curve points are shared with the simulator via liftCurvePoints() in zoneTransform.

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

    // Replace any prior zones group cleanly.
    const prior = await findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }

    const group = await doc.createLayerGroup({ name: GROUP_NAME });
    let layersAdded = 0;
    const order: ["highlights", "midtones", "shadows"] = ["highlights", "midtones", "shadows"];
    // Build bottom-up so visual order is shadows on top → highlights on bottom (PS renders bottom→top, so order doesn't matter for additive adjustments — pick what's nicer to inspect).

    for (const zoneName of order) {
      const z = zones[zoneName];
      if (!zoneIsActive(z)) continue;
      const blend = blendIfFor(z);

      if (z.lift !== 0) {
        const cv = await makeCurvesLayer(`${zoneName} lift`, [
          { channel: "composite", points: liftCurvePoints(z) },
        ]);
        await cv.move(group, "placeInside");
        try { await setLayerBlendIf(cv, blend); } catch (e) { console.warn("blendIf failed:", e); }
        layersAdded++;
      }

      if (z.hue !== 0 || z.sat !== 0) {
        const hs = await makeHueSatLayer(`${zoneName} hue/sat`, {
          hue: z.hue,
          saturation: z.sat,
        });
        await hs.move(group, "placeInside");
        try { await setLayerBlendIf(hs, blend); } catch (e) { console.warn("blendIf failed:", e); }
        layersAdded++;
      }

      // Tint baked as a Solid Color fill layer in Color blend mode at tintAmount opacity.
      if (z.tintAmount > 0) {
        const ps = require("photoshop");
        const tintR = z.tintR, tintG = z.tintG, tintB = z.tintB;
        await ps.action.batchPlay([{
          _obj: "make",
          _target: [{ _ref: "contentLayer" }],
          using: {
            _obj: "contentLayer",
            name: `${zoneName} tint`,
            type: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: tintR, grain: tintG, blue: tintB } },
            mode: { _enum: "blendMode", _value: "color" },
            opacity: { _unit: "percentUnit", _value: z.tintAmount },
          },
        }], {});
        const tintLayer = doc.activeLayers?.[0];
        if (tintLayer) {
          await tintLayer.move(group, "placeInside");
          try { await setLayerBlendIf(tintLayer, blend); } catch (e) { console.warn("blendIf failed:", e); }
          layersAdded++;
        }
      }
    }

    void action; // suppress unused warning
    return layersAdded === 0
      ? "Nothing to bake — all zones at defaults."
      : `Baked ${layersAdded} layer(s) into ${GROUP_NAME}.`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
