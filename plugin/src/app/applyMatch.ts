// Histogram-match Apply: fits per-channel R/G/B curves so target's histograms match source's,
// then creates ONE Curves adjustment layer (clipped to target). Single editable node.

import {
  readLayerPixels, writeLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
  makeCurvesLayer, setClippingMask, GROUP_NAME, action,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  fitHistogramCurves, sampleControlPoints, processChannelCurves, applyDimensions,
  applyChannelCurvesToRgba, applyChromaOnly,
  ChannelCurves, DimensionOpts, DEFAULT_DIMENSIONS,
} from "../core/histogramMatch";
import {
  applyPaletteReduce, isPaletteReduceActive, PaletteReduceOpts, DEFAULT_PALETTE_REDUCE,
} from "../core/paletteReduce";

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
  dimensions?: DimensionOpts;
  paletteReduce?: PaletteReduceOpts;
}

const BAKED_LAYER_NAME = "Match Baked";

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
    const processed = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });
    return applyDimensions(processed, params.dimensions ?? DEFAULT_DIMENSIONS);
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
    const processed = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });
    const curves: ChannelCurves = applyDimensions(processed, params.dimensions ?? DEFAULT_DIMENSIONS);

    // Reuse existing [Color Smash] group; remove any prior Match output to avoid stacking.
    const findGroup = () => doc.layers.find((l: any) => l.name === GROUP_NAME && l.layers);
    let group = findGroup();
    if (!group) group = await doc.createLayerGroup({ name: GROUP_NAME });
    for (const child of [...(group.layers ?? [])]) {
      if (child.name === RESULT_LAYER_NAME || child.name === BAKED_LAYER_NAME) {
        try { await child.delete(); } catch { /* ignore */ }
      }
    }

    const paletteOpts = params.paletteReduce ?? DEFAULT_PALETTE_REDUCE;
    const reduceActive = isPaletteReduceActive(paletteOpts);

    if (!reduceActive) {
      // Curves-layer path (single editable adjustment node).
      await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false }], {});
      const curveLayer = await makeCurvesLayer(RESULT_LAYER_NAME, [
        { channel: "red",   points: sampleControlPoints(curves.r, CONTROL_POINTS) },
        { channel: "green", points: sampleControlPoints(curves.g, CONTROL_POINTS) },
        { channel: "blue",  points: sampleControlPoints(curves.b, CONTROL_POINTS) },
      ]);
      await setClippingMask(curveLayer, true);
      if (params.chromaOnly) { try { curveLayer.blendMode = "color"; } catch { /* ignore */ } }
      try { await curveLayer.move(group, "placeInside"); } catch { /* ignore */ }
    } else {
      // Baked-pixel path: read full target pixels, apply curves + chroma + reduction, write to layer.
      const tgtBuf = await readLayerPixels(target);
      let pixels = applyChannelCurvesToRgba(tgtBuf.data, curves);
      if (params.chromaOnly) pixels = applyChromaOnly(tgtBuf.data, pixels);
      pixels = applyPaletteReduce(pixels, paletteOpts);
      const baked = await target.duplicate(group, "placeInside");
      try { baked.name = BAKED_LAYER_NAME; } catch { /* ignore */ }
      await writeLayerPixels(baked, { ...tgtBuf, data: pixels });
    }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("chroma-only");
    if (reduceActive) {
      const r = paletteOpts;
      const bits: string[] = [];
      if (r.valueSteps)     bits.push(`V${r.valueSteps}`);
      if (r.hueBins)        bits.push(`H${r.hueBins}`);
      if (r.chromaSteps)    bits.push(`C${r.chromaSteps}`);
      if (r.outlierCullPct) bits.push(`cull${r.outlierCullPct}%`);
      tags.push(`reduce[${bits.join("/")}]`);
    }
    return `Matched (${reduceActive ? "baked" : "curves"}) · ${tags.join(" · ")}`;
  });
}
