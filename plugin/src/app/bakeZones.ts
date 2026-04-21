// Bake zones (variable N) into a [Color Smash] zones group of native PS adjustment layers.

import {
  executeAsModal, getActiveDoc,
  makeCurvesLayer, makeLevelsLayer, setLayerBlendIf, setClippingMask,
} from "../services/photoshop";
import { type ZonesState, type ZoneState, colorShiftCurves, IDENTITY_TONAL, lutToCurvePoints } from "../core/zoneTransform";

const GROUP_NAME = "[Color Smash] zones";

function blendIfFor(z: ZoneState) {
  const a = Math.min(z.rangeStart, z.rangeEnd);
  const b = Math.max(z.rangeStart, z.rangeEnd);
  const fL = Math.max(0, z.featherLeft);
  const fR = Math.max(0, z.featherRight);
  const pct = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 2.55);
  return {
    blackMin: pct(a - fL), blackMax: pct(a),
    whiteMin: pct(b),      whiteMax: pct(b + fR),
  };
}

async function deleteRecursive(layer: any): Promise<void> {
  const children = [...(layer.layers ?? [])];
  for (const c of children) { try { await deleteRecursive(c); } catch { /* ignore */ } }
  try { await layer.delete(); } catch { /* ignore */ }
}

async function purgeAllZoneGroups(): Promise<number> {
  const doc = getActiveDoc();
  const targets = doc.layers.filter((l: any) => l.name === GROUP_NAME);
  for (const t of targets) await deleteRecursive(t);
  return targets.length;
}

function zoneLabel(idx: number, n: number): string {
  if (n === 3) return ["shadows", "midtones", "highlights"][idx];
  if (n === 5) return ["shadows", "low-mids", "mids", "high-mids", "highlights"][idx];
  return `zone ${idx + 1}`;
}

export async function bakeZones(zones: ZonesState): Promise<string> {
  return executeAsModal("Color Smash bake zones", async () => {
    const doc = getActiveDoc();
    await purgeAllZoneGroups();
    const group = await doc.createLayerGroup({ name: GROUP_NAME });

    const tonal = zones.tonal ?? IDENTITY_TONAL;
    let tonalLayer: any;
    if (tonal.matchPerChannel) {
      tonalLayer = await makeCurvesLayer("tonal (per-channel match)", [
        { channel: "red",   points: lutToCurvePoints(tonal.matchPerChannel.r, 17) },
        { channel: "green", points: lutToCurvePoints(tonal.matchPerChannel.g, 17) },
        { channel: "blue",  points: lutToCurvePoints(tonal.matchPerChannel.b, 17) },
      ]);
    } else if (tonal.matchCurve) {
      tonalLayer = await makeCurvesLayer("tonal (histogram match)", [
        { channel: "composite", points: lutToCurvePoints(tonal.matchCurve, 17) },
      ]);
    } else {
      tonalLayer = await makeLevelsLayer("tonal", tonal);
    }
    await tonalLayer.move(group, "placeInside");
    try { await setClippingMask(tonalLayer, true); } catch (e) { console.warn("clipping failed:", e); }
    let layersAdded = 1;

    const N = zones.zones.length;
    // Simplified: one Curves layer per zone, clipped + Blend-If gated. No subgroup, no Hue/Sat.
    for (let i = 0; i < N; i++) {
      const z = zones.zones[i];
      const blend = blendIfFor(z);

      const ccPoints = z.colorLUT
        ? { r: lutToCurvePoints(z.colorLUT.r, 17), g: lutToCurvePoints(z.colorLUT.g, 17), b: lutToCurvePoints(z.colorLUT.b, 17) }
        : colorShiftCurves(z);

      const cc = await makeCurvesLayer(zoneLabel(i, N), [
        { channel: "red",   points: ccPoints.r },
        { channel: "green", points: ccPoints.g },
        { channel: "blue",  points: ccPoints.b },
      ]);
      await cc.move(group, "placeInside");
      try { await setLayerBlendIf(cc, blend); } catch (e) { console.warn("blendIf failed:", e); }
      try { await setClippingMask(cc, true); } catch (e) { console.warn("clipping failed:", e); }
      layersAdded++;
    }

    return `Baked ${layersAdded} layers into ${GROUP_NAME} (${N} zones, 1 Curves layer each).`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
