// Phase 0 spike: read bottom + top layer, compute Reinhard, write a flat result layer.

import { app } from "photoshop";
import { readLayerPixels, writeLayerPixels, executeAsModal, getActiveDoc } from "../services/photoshop";
import { computeLabStats, applyReinhard } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";

const STATS_MAX_EDGE = 512;

export async function runSpike(): Promise<string> {
  return executeAsModal("Color Smash spike", async () => {
    const doc = getActiveDoc();
    const layers = doc.layers;
    if (layers.length < 2) throw new Error("Need at least 2 layers.");
    const source = layers[layers.length - 1]; // bottom
    const target = layers[0];                  // top

    const srcBuf = await readLayerPixels(source);
    const tgtBuf = await readLayerPixels(target);

    const srcStats = computeLabStats(downsampleToMaxEdge(srcBuf, STATS_MAX_EDGE).data);
    const tgtStats = computeLabStats(downsampleToMaxEdge(tgtBuf, STATS_MAX_EDGE).data);

    applyReinhard(tgtBuf.data, srcStats, tgtStats);

    // Duplicate the target layer so the new layer has matching pixel bounds, then overwrite.
    const dup = await target.duplicate();
    dup.name = "[Color Smash] Result";
    await writeLayerPixels(dup, tgtBuf);
    void app;
    return `Done. ${tgtBuf.width}×${tgtBuf.height} pixels.`;
  });
}
