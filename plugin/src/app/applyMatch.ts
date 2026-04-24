// Histogram-match Apply: fits per-channel R/G/B curves so target's histograms match source's,
// then creates ONE Curves adjustment layer (clipped to target). Single editable node.

import {
  readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
  makeCurvesLayer, setClippingMask, GROUP_NAME, action,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  fitHistogramCurves, fitHistogramCurvesLab, sampleControlPoints, processChannelCurves, applyDimensions,
  applyZoneWeightsToChannels,
  ChannelCurves, DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
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
  dimensions?: DimensionOpts;
  zones?: ZoneOpts;
  sourcePixelsOverride?: Uint8Array; // if set, use these RGBA pixels instead of reading source layer
  sourceLabel?: string; // optional name shown in result message
  colorSpace?: "rgb" | "lab";
  deselectFirst?: boolean;     // drop active marquee before creating layer (default true)
  overwritePrior?: boolean;    // delete prior Match Curves (true) or hide them (false) (default true)
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
    const fit = params.colorSpace === "lab" ? fitHistogramCurvesLab : fitHistogramCurves;
    const raw = fit(
      downsampleToMaxEdge(s, STATS_MAX_EDGE).data,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
    );
    const processed = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });
    const dim = applyDimensions(processed, params.dimensions ?? DEFAULT_DIMENSIONS);
    return applyZoneWeightsToChannels(dim, params.zones ?? DEFAULT_ZONES);
  });
}

export async function applyMatch(params: ApplyMatchParams): Promise<string> {
  return executeAsModal("Color Smash match", async () => {
    const doc = getActiveDoc();
    const targetIsMerged = params.targetLayerId === -2;
    const target = targetIsMerged ? null : doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!targetIsMerged && !target) throw new Error("Target layer no longer exists.");

    const readMergedPixels = async () => {
      const { imaging } = require("photoshop");
      const r = await imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: false, colorSpace: "RGB" });
      const id = r.imageData;
      const raw = await id.getData();
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const w = id.width, h = id.height;
      const components = id.components ?? (src.length / (w * h));
      const data = new Uint8Array(w * h * 4);
      if (components === 4) data.set(src);
      else for (let i = 0, j = 0; i < w * h; i++, j += 3) { const o = i * 4; data[o] = src[j]; data[o + 1] = src[j + 1]; data[o + 2] = src[j + 2]; data[o + 3] = 255; }
      if (id.dispose) id.dispose();
      return { width: w, height: h, data, bounds: { left: 0, top: 0, right: w, bottom: h } };
    };

    let srcPixels: Uint8Array;
    if (params.sourcePixelsOverride) {
      srcPixels = params.sourcePixelsOverride;
    } else if (params.sourceLayerId === -2) {
      const merged = await readMergedPixels();
      srcPixels = downsampleToMaxEdge(merged, STATS_MAX_EDGE).data;
    } else {
      const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
      if (!source) throw new Error("Source layer no longer exists.");
      const s = await readLayerPixels(source, statsRectForLayer(source));
      srcPixels = downsampleToMaxEdge(s, STATS_MAX_EDGE).data;
    }
    const t = targetIsMerged ? await readMergedPixels() : await readLayerPixels(target, statsRectForLayer(target));
    const fit2 = params.colorSpace === "lab" ? fitHistogramCurvesLab : fitHistogramCurves;
    const raw = fit2(
      srcPixels,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
    );
    const processed = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
    });
    const dim = applyDimensions(processed, params.dimensions ?? DEFAULT_DIMENSIONS);
    const curves: ChannelCurves = applyZoneWeightsToChannels(dim, params.zones ?? DEFAULT_ZONES);

    // Reuse existing [Color Smash] group. Prior Match Curves layers are either deleted
    // (overwritePrior=true, default) or just hidden (overwritePrior=false, so user can keep
    // alternatives stacked).
    const findGroup = () => doc.layers.find((l: any) => l.name === GROUP_NAME && l.layers);
    let group = findGroup();
    if (!group) group = await doc.createLayerGroup({ name: GROUP_NAME });
    const overwrite = params.overwritePrior !== false;
    const matchChildren = [...(group.layers ?? [])].filter((c: any) =>
      c.name === RESULT_LAYER_NAME || (typeof c.name === "string" && c.name.startsWith(RESULT_LAYER_NAME))
    );
    if (overwrite) {
      // Overwrite ONLY the most recent (topmost) Match Curves layer; keep older ones intact.
      // Prefer the user-selected one if it's a Match Curves layer; else top of group.
      const selectedId = doc.activeLayers?.[0]?.id;
      const selectedMatch = selectedId != null ? matchChildren.find((c: any) => c.id === selectedId) : undefined;
      const target = selectedMatch ?? matchChildren[0];
      if (target) {
        try { await target.delete(); } catch { /* ignore */ }
      }
    } else {
      // Hide all prior matches so the new one doesn't compete.
      for (const child of matchChildren) {
        try { child.visible = false; } catch { /* ignore */ }
      }
    }

    // For a layer target, select it first so the new Curves goes above it. For Merged target,
    // the Curves layer goes at the top of the stack (selecting top-most existing layer, no clip).
    if (target) {
      await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: target.id }], makeVisible: false }], {});
    } else {
      // Merged target: select topmost layer in doc so new Curves goes above everything.
      const top = doc.layers[0];
      if (top) await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: top.id }], makeVisible: false }], {});
    }

    // Optionally deselect (so curves apply to the full target, not masked to the marquee).
    if (params.deselectFirst !== false) {
      try { await action.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }], {}); }
      catch { /* ignore */ }
    }

    // If keeping prior layers, give the new one a unique numbered suffix so they coexist.
    const layerName = overwrite ? RESULT_LAYER_NAME
      : `${RESULT_LAYER_NAME} ${new Date().toTimeString().slice(0, 8)}`;
    const curveLayer = await makeCurvesLayer(layerName, [
      { channel: "red",   points: sampleControlPoints(curves.r, CONTROL_POINTS) },
      { channel: "green", points: sampleControlPoints(curves.g, CONTROL_POINTS) },
      { channel: "blue",  points: sampleControlPoints(curves.b, CONTROL_POINTS) },
    ]);
    // Only clip if there's a specific target layer. Merged target = no clip (affects everything below).
    if (target) await setClippingMask(curveLayer, true);
    if (params.chromaOnly) {
      try { curveLayer.blendMode = "color"; } catch { /* ignore */ }
    }
    try { await curveLayer.move(group, "placeInside"); } catch { /* ignore */ }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("chroma-only");
    if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
    return `Matched · ${tags.join(" · ")}`;
  });
}
