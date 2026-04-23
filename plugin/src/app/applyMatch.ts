// Histogram-match Apply: fits per-channel R/G/B curves so target's histograms match source's,
// then creates ONE Curves adjustment layer (clipped to target). Single editable node.

import {
  readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
  makeCurvesLayer, setClippingMask, GROUP_NAME, action,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  fitHistogramCurves, sampleControlPoints, processChannelCurves, ChannelCurves,
} from "../core/histogramMatch";

const STATS_MAX_EDGE = 512;
const CONTROL_POINTS = 12;
const RESULT_LAYER_NAME = "Match Curves";

export interface ApplyMatchParams {
  sourceLayerId: number;
  targetLayerId: number;
  amount: number;        // 0..1
  smoothRadius?: number; // 0..64
  maxStretch?: number;   // local slope cap; large = no cap
  chromaOnly?: boolean;  // set the Curves layer to "Color" blend mode
}

export async function fitMatchCurves(params: ApplyMatchParams): Promise<ChannelCurves> {
  return executeAsModal("Color Smash fit match curves", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    const raw = fitHistogramCurves(
      downsampleToMaxEdge(s, STATS_MAX_EDGE).data,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
    );
    return processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });
  });
}

export async function applyMatch(params: ApplyMatchParams): Promise<string> {
  return executeAsModal("Color Smash match", async () => {
    const doc = getActiveDoc();
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!target) throw new Error("Target layer no longer exists.");
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    if (!source) throw new Error("Source layer no longer exists.");

    // Fit curves (re-read inside modal so stats are fresh).
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    const raw = fitHistogramCurves(
      downsampleToMaxEdge(s, STATS_MAX_EDGE).data,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
    );
    const curves: ChannelCurves = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });

    // Reuse existing [Color Smash] group; remove any prior Match layer to avoid stacking.
    const findGroup = () => doc.layers.find((l: any) => l.name === GROUP_NAME && l.layers);
    let group = findGroup();
    if (!group) group = await doc.createLayerGroup({ name: GROUP_NAME });
    for (const child of [...(group.layers ?? [])]) {
      if (child.name === RESULT_LAYER_NAME) {
        try { await child.delete(); } catch { /* ignore */ }
      }
    }

    // Select target so the new adjustment layer is created above it (then we clip + move into group).
    await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false }], {});

    const curveLayer = await makeCurvesLayer(RESULT_LAYER_NAME, [
      { channel: "red",   points: sampleControlPoints(curves.r, CONTROL_POINTS) },
      { channel: "green", points: sampleControlPoints(curves.g, CONTROL_POINTS) },
      { channel: "blue",  points: sampleControlPoints(curves.b, CONTROL_POINTS) },
    ]);
    await setClippingMask(curveLayer, true);
    if (params.chromaOnly) {
      try { curveLayer.blendMode = "color"; } catch { /* ignore */ }
    }
    try { await curveLayer.move(group, "placeInside"); } catch { /* ignore */ }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("chroma-only");
    return `Matched · ${tags.join(" · ")}`;
  });
}
