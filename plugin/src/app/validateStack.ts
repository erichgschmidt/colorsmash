// Validation harness: builds the stack, reads PS-rendered output, compares against simulator
// prediction pixel-by-pixel. Reports ΔE76 stats so we know how wrong the simulator is and where.

import {
  readLayerPixels, executeAsModal, getActiveDoc,
  findExistingGroup, statsRectForLayer, GROUP_NAME,
  makeCurvesLayer, makeColorBalanceLayer, makeHueSatLayer,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { mapToStack } from "../core/reinhardToStack";
import { simulateStack } from "../core/stackSimulator";
import { rgbToLab, deltaE76 } from "../core/lab";

const STATS_MAX_EDGE = 512;

export interface ValidateParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

export async function validateStack(p: ValidateParams): Promise<string> {
  // Stage 1: stats.
  const stats = await executeAsModal("Color Smash analyze", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === p.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === p.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    return {
      src: computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data),
      tgt: computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data),
      target,
      targetBuf: t,
    };
  }).catch((e: any) => { throw new Error(e?.message ?? String(e)); });

  const stack = mapToStack(stats.src, stats.tgt, p.weights);

  // Stage 2: build the stack, read result, compute simulator residuals.
  const result = await executeAsModal("Color Smash validate", async () => {
    const doc = getActiveDoc();
    const prior = findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }
    const group = await doc.createLayerGroup({ name: GROUP_NAME });
    const hs = await makeHueSatLayer("Chroma σ", stack.hueSat);
    await hs.move(group, "placeInside");
    const cb = await makeColorBalanceLayer("Color cast", stack.colorBalance);
    await cb.move(group, "placeInside");
    const cv = await makeCurvesLayer("Luminance", [{ channel: "composite", points: stack.curvesMaster }]);
    await cv.move(group, "placeInside");

    // Flatten visible to a temp pixel layer just below, so we can read what PS rendered.
    // Trick: stamp visible (Ctrl+Alt+Shift+E equivalent) via batchPlay.
    const probeLayer = await doc.createLayer({ name: "[CS Probe]" });
    // mergeVisible into the probe layer is tricky in batchPlay; simpler: read the pixels
    // by temporarily duplicating the target and applying Apply Image or just snapshotting.
    // Easiest path: create a new pixel layer that captures the composite via stamp.
    // Use action.batchPlay for "Stamp visible" merge.
    const ps = require("photoshop");
    await ps.action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "layer", _id: probeLayer.id }],
      makeVisible: true,
    }, {
      _obj: "mergeVisible",
      duplicate: true,
    }], {});

    // The merged result becomes the active layer, replacing probeLayer.
    const merged = doc.activeLayers?.[0];
    if (!merged) throw new Error("merge failed");
    const mergedBuf = await readLayerPixels(merged);
    // Cleanup: delete the merged probe.
    try { await merged.delete(); } catch { /* ignore */ }
    try { await probeLayer.delete(); } catch { /* ignore */ }
    return mergedBuf;
  }).catch((e: any) => { throw new Error(e?.message ?? String(e)); });

  // Stage 3: compare PS-actual vs simulator at sampled pixels.
  const psBuf = result;
  const tgBuf = stats.targetBuf;
  // Sample up to 1000 pixels uniformly.
  const total = Math.min(psBuf.data.length / 4, tgBuf.data.length / 4);
  const N = Math.min(1000, total);
  const stride = Math.max(1, Math.floor(total / N));
  let sumDE = 0, maxDE = 0, count = 0;
  for (let pi = 0; pi < total; pi += stride) {
    const i = pi * 4;
    const inRGB = { r: tgBuf.data[i] / 255, g: tgBuf.data[i + 1] / 255, b: tgBuf.data[i + 2] / 255 };
    const psRGB = { r: psBuf.data[i] / 255, g: psBuf.data[i + 1] / 255, b: psBuf.data[i + 2] / 255 };
    const simRGB = simulateStack(inRGB, stack);
    const labPS = rgbToLab(psRGB);
    const labSim = rgbToLab(simRGB);
    const de = deltaE76(labPS, labSim);
    sumDE += de;
    if (de > maxDE) maxDE = de;
    count++;
  }
  const meanDE = sumDE / count;
  return `Simulator residual: mean ΔE ${meanDE.toFixed(2)} | max ΔE ${maxDE.toFixed(2)} (${count} px)`;
}
