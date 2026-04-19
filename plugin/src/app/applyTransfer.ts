// Phase 1 apply: Reinhard with per-axis sliders + selection-aware stats. Reuses [Color Smash] group/layer.

import {
  readLayerPixels, writeLayerPixels, executeAsModal,
  getActiveDoc, findExistingGroup, statsRectForLayer, GROUP_NAME,
} from "../services/photoshop";
import { computeLabStats, applyReinhard, TransferWeights, LabStats } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";

const STATS_MAX_EDGE = 512;
const RESULT_LAYER_NAME = "Result";

export interface ApplyParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

async function readStatsBuffer(layer: any) {
  const rect = statsRectForLayer(layer);
  const buf = await readLayerPixels(layer, rect);
  return downsampleToMaxEdge(buf, STATS_MAX_EDGE).data;
}

export async function applyTransfer(params: ApplyParams): Promise<string> {
  return executeAsModal("Color Smash apply", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    if (source.id === target.id) throw new Error("Source and target must differ.");

    // Parallel: read full target buffer + both stat samples concurrently.
    const [tgtBuf, srcStatsData, tgtStatsData] = await Promise.all([
      readLayerPixels(target),
      readStatsBuffer(source),
      readStatsBuffer(target),
    ]);

    const srcStats: LabStats = computeLabStats(srcStatsData);
    const tgtStats: LabStats = computeLabStats(tgtStatsData);

    applyReinhard(tgtBuf.data, srcStats, tgtStats, params.weights);

    let group = findExistingGroup();
    let resultLayer = group?.layers?.find((l: any) => l.name === RESULT_LAYER_NAME);

    const sameShape = resultLayer
      && resultLayer.bounds
      && (resultLayer.bounds.right - resultLayer.bounds.left) === tgtBuf.width
      && (resultLayer.bounds.bottom - resultLayer.bounds.top) === tgtBuf.height;

    if (!sameShape) {
      if (group) {
        for (const c of [...(group.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
        try { await group.delete(); } catch { /* ignore */ }
      }
      group = await doc.createLayerGroup({ name: GROUP_NAME });
      resultLayer = await target.duplicate(group, "placeInside");
      try { resultLayer.name = RESULT_LAYER_NAME; } catch { /* ignore */ }
    }

    await writeLayerPixels(resultLayer, tgtBuf);

    const selUsed = statsRectForLayer(source).right - statsRectForLayer(source).left !== source.bounds.right - source.bounds.left
                  || statsRectForLayer(target).right - statsRectForLayer(target).left !== target.bounds.right - target.bounds.left;
    return `Applied (${sameShape ? "reused" : "created"})${selUsed ? " · selection" : ""} amt=${Math.round(params.weights.amount * 100)}%`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
