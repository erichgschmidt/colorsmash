// Editable adjustment-layer stack approximating Reinhard.
// Stack order in [Color Smash] group (top→bottom = applied last→first):
//   1. Luminance Curves
//   2. Selective Color (per-family hue refinement)
//   3. Color Balance (shadows/mids/highlights cast)
//   4. Hue/Saturation (chroma scale)

import {
  readLayerPixels, executeAsModal,
  getActiveDoc, findExistingGroup, statsRectForLayer, GROUP_NAME,
  makeCurvesLayer, makeColorBalanceLayer, makeHueSatLayer, makeSelectiveColorLayer,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { mapToStack } from "../core/reinhardToStack";
import { fitStack } from "../core/stackFitter";

const STATS_MAX_EDGE = 512;

export interface ApplyAsStackParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

export async function applyAsStack(params: ApplyAsStackParams): Promise<string> {
  const stats = await executeAsModal("Color Smash analyze", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    if (source.id === target.id) throw new Error("Source and target must differ.");
    const [s, t, tFull] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
      readLayerPixels(target),
    ]);
    return {
      src: computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data),
      tgt: computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data),
      targetPixels: downsampleToMaxEdge(tFull, 256).data,
    };
  }).catch((e: any) => { throw new Error(e?.message ?? String(e)); });

  const initial = mapToStack(stats.src, stats.tgt, params.weights);
  const fit = fitStack(initial, stats.src, stats.tgt, params.weights, stats.targetPixels);
  const stack = fit.params;

  return executeAsModal("Color Smash build stack", async () => {
    const doc = getActiveDoc();
    const prior = findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }
    const group = await doc.createLayerGroup({ name: GROUP_NAME });

    // Build bottom-up (first created → bottom of group).
    const hs = await makeHueSatLayer("Chroma σ", stack.hueSat);
    await hs.move(group, "placeInside");

    const cb = await makeColorBalanceLayer("Color cast", stack.colorBalance);
    await cb.move(group, "placeInside");

    const sc = await makeSelectiveColorLayer("Per-family tweaks", stack.selective);
    await sc.move(group, "placeInside");

    const cv = await makeCurvesLayer("Luminance", [{ channel: "composite", points: stack.curvesMaster }]);
    await cv.move(group, "placeInside");

    return `Fit: ΔE ${fit.before.toFixed(2)} → ${fit.after.toFixed(2)} (${fit.iters} iters)`;
  }).catch((e: any) => `Error: ${e?.message ?? e}`);
}
