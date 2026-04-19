// Phase 2 apply: build LUT, write to plugin data folder, install as Color Lookup adjustment layer
// inside the [Color Smash] group. Non-destructive editable stack.

import {
  readLayerPixels, executeAsModal,
  getActiveDoc, findExistingGroup, statsRectForLayer, GROUP_NAME,
  writeLutFile, createColorLookupLayer,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT } from "../core/lutGenerator";
import { writeCubeLUT } from "../core/cubeWriter";

const STATS_MAX_EDGE = 512;
const LUT_SIZE = 33;

export interface ApplyAsLutParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

export async function applyAsLut(params: ApplyAsLutParams): Promise<string> {
  // Stage 1 (modal): read pixels + compute stats.
  const stats = await executeAsModal("Color Smash read", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    if (source.id === target.id) throw new Error("Source and target must differ.");
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    return {
      src: computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data),
      tgt: computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data),
    };
  }).catch((e: any) => { throw new Error(e?.message ?? String(e)); });

  // Stage 2 (no modal): pure compute.
  const lut = generateReinhardLUT(LUT_SIZE, stats.src, stats.tgt, params.weights);
  const cubeText = writeCubeLUT(lut, "Color Smash");
  const cube = await writeLutFile(cubeText);

  // Stage 3 (modal): purge prior group, create new group + Color Lookup layer in it.
  return executeAsModal("Color Smash install LUT", async () => {
    const doc = getActiveDoc();

    // Replace prior group cleanly.
    const prior = findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }

    const group = await doc.createLayerGroup({ name: GROUP_NAME });
    const lutLayer = await createColorLookupLayer(cube, "Color Smash LUT");
    try { await lutLayer.move(group, "placeInside"); } catch { /* may already be top-level */ }
    return `LUT installed (${LUT_SIZE}³, ${(cube.bytes.length / 1024).toFixed(1)} KB)`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
