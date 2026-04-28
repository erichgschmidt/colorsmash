// Histogram-match Apply: fits per-channel R/G/B curves so target's histograms match source's,
// then creates ONE Curves adjustment layer (clipped to target). Single editable node.

import {
  readLayerPixels, executeAsModal, statsRectForLayer,
  makeCurvesLayer, setClippingMask, GROUP_NAME, action, app,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  sampleControlPoints, processChannelCurves, applyDimensions,
  applyZoneAndEnvelopeToChannels, MERGED_LAYER_ID,
  ChannelCurves, DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
  EnvelopePoint, DEFAULT_ENVELOPE,
  fitByMode, MatchMode,
  fitMultiZone, processMultiZoneFit,
} from "../core/histogramMatch";

const STATS_MAX_EDGE = 512;
const CONTROL_POINTS = 12;
const RESULT_LAYER_NAME = "Match Curves";

// Recursive layer lookup — layers may live inside groups (auto-grouping plugins, normal usage).
function findLayerById(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (Array.isArray(l.layers)) {
      const found = findLayerById(l.layers, id);
      if (found) return found;
    }
  }
  return null;
}

function getDocById(docId: number): any {
  const doc = (app.documents ?? []).find((d: any) => d.id === docId);
  if (!doc) throw new Error(`Document ${docId} not found (was it closed?).`);
  return doc;
}

export interface ApplyMatchParams {
  srcDocId: number;       // doc that holds the source layer (may differ from tgtDocId)
  tgtDocId: number;       // doc that holds the target layer + receives the Curves layer
  sourceLayerId: number;
  targetLayerId: number;
  amount: number;        // 0..1
  smoothRadius?: number; // 0..64
  maxStretch?: number;   // local slope cap; large = no cap
  stretchRange?: { start: number; end: number }; // anchor cap at histogram bounds
  chromaOnly?: boolean;  // set the Curves layer to "Hue" blend mode (preserves target sat+luma)
  dimensions?: DimensionOpts;
  zones?: ZoneOpts;
  envelope?: EnvelopePoint[];
  matchMode?: MatchMode;       // full / mean / median / percentile (default full)
  multiZone?: boolean;         // emit 3 stacked Curves layers w/ Blend If instead of one
  sourcePixelsOverride?: Uint8Array; // if set, use these RGBA pixels instead of reading source layer
  sourceLabel?: string; // optional name shown in result message
  colorSpace?: "rgb" | "lab";
  deselectFirst?: boolean;     // drop active marquee before creating layer (default true)
  overwritePrior?: boolean;    // delete prior Match Curves (true) or hide them (false) (default true)
}

export async function fitMatchCurves(params: ApplyMatchParams): Promise<ChannelCurves> {
  return executeAsModal("Color Smash fit match curves", async () => {
    const srcDoc = getDocById(params.srcDocId);
    const tgtDoc = getDocById(params.tgtDocId);
    const source = findLayerById(srcDoc.layers, params.sourceLayerId);
    const target = findLayerById(tgtDoc.layers, params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source), srcDoc.id),
      readLayerPixels(target, statsRectForLayer(target), tgtDoc.id),
    ]);
    const raw = fitByMode(
      params.matchMode ?? "full",
      downsampleToMaxEdge(s, STATS_MAX_EDGE).data,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
      params.colorSpace ?? "rgb",
    );
    const processed = processChannelCurves(raw, {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
      stretchRange: params.stretchRange,
    });
    const dim = applyDimensions(processed, params.dimensions ?? DEFAULT_DIMENSIONS);
    return applyZoneAndEnvelopeToChannels(dim, params.zones ?? DEFAULT_ZONES, params.envelope ?? DEFAULT_ENVELOPE);
  });
}

export async function applyMatch(params: ApplyMatchParams): Promise<string> {
  return executeAsModal("Color Smash match", async () => {
    const srcDoc = getDocById(params.srcDocId);
    const tgtDoc = getDocById(params.tgtDocId);
    // PS DOM operations (createLayerGroup, layer.move, etc.) implicitly target the active doc.
    // Activate the TARGET doc so the Curves layer lands in the correct document.
    if (app.activeDocument?.id !== tgtDoc.id) app.activeDocument = tgtDoc;
    const targetIsMerged = params.targetLayerId === MERGED_LAYER_ID;
    const target = targetIsMerged ? null : findLayerById(tgtDoc.layers, params.targetLayerId);
    if (!targetIsMerged && !target) throw new Error("Target layer no longer exists.");
    // Local alias used by the rest of the function for the doc that holds Curves layers,
    // groups, etc. (always the target doc).
    const doc = tgtDoc;

    const readMergedPixelsOf = async (d: any) => {
      const { imaging } = require("photoshop");
      const r = await imaging.getPixels({ documentID: d.id, componentSize: 8, applyAlpha: false, colorSpace: "RGB" });
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
    } else if (params.sourceLayerId === MERGED_LAYER_ID) {
      const merged = await readMergedPixelsOf(srcDoc);
      srcPixels = downsampleToMaxEdge(merged, STATS_MAX_EDGE).data;
    } else {
      const source = findLayerById(srcDoc.layers, params.sourceLayerId);
      if (!source) throw new Error("Source layer no longer exists.");
      const s = await readLayerPixels(source, statsRectForLayer(source), srcDoc.id);
      srcPixels = downsampleToMaxEdge(s, STATS_MAX_EDGE).data;
    }
    const t = targetIsMerged ? await readMergedPixelsOf(tgtDoc) : await readLayerPixels(target, statsRectForLayer(target), tgtDoc.id);
    const raw = fitByMode(
      params.matchMode ?? "full",
      srcPixels,
      downsampleToMaxEdge(t, STATS_MAX_EDGE).data,
      params.colorSpace ?? "rgb",
    );
    const curveOpts = {
      amount: params.amount,
      smoothRadius: params.smoothRadius ?? 0,
      maxStretch: params.maxStretch ?? 999,
      stretchRange: params.stretchRange,
    };
    const dimOpts = params.dimensions ?? DEFAULT_DIMENSIONS;
    const processed = processChannelCurves(raw, curveOpts);
    const dim = applyDimensions(processed, dimOpts);
    const curves: ChannelCurves = applyZoneAndEnvelopeToChannels(dim, params.zones ?? DEFAULT_ZONES, params.envelope ?? DEFAULT_ENVELOPE);

    // Multi-zone path needs its own per-band fit (the global `raw` above is for single-curve).
    // We refit because the band weights are luma-conditional; single-curve fitter doesn't bin by luma.
    const multiZoneFit = params.multiZone
      ? processMultiZoneFit(fitMultiZone(srcPixels, downsampleToMaxEdge(t, STATS_MAX_EDGE).data), curveOpts, dimOpts)
      : null;

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
      // Delete every prior Match Curves layer in the group. Predictable and avoids the
      // multi-zone footgun where deleting only the topmost would leave stale band-layers.
      for (const child of matchChildren) {
        try { await child.delete(); } catch { /* ignore */ }
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

    // ─── Multi-zone branch: emit 3 stacked Curves layers + luminosity masks ──────
    if (multiZoneFit) {
      // Strategy: for each band, create a Curves layer, then build a luminosity mask in
      // two batchPlay steps:
      //   1. Apply Image to fill the layer's mask channel from the doc's composite gray
      //      (giving us per-pixel underlying luminance directly in the mask, full resolution)
      //   2. Apply a Curves remap to that mask to shape it into the band's triangular weight
      //      (input luma → output mask alpha = band weight × 255)
      // Triangular weights match the preview simulator exactly. PS handles all resolution
      // and alignment. The masks are user-paintable for fine refinement.

      // Curves descriptors that remap a gray-scale mask (input luma → output band weight × 255).
      // Each is a 3-point curve that produces the triangular partition-of-unity weights.
      const bandCurves: Record<"shadow" | "mid" | "highlight", { horizontal: number; vertical: number }[]> = {
        shadow:    [{ horizontal: 0, vertical: 255 }, { horizontal: 128, vertical: 0   }, { horizontal: 255, vertical: 0   }],
        mid:       [{ horizontal: 0, vertical: 0   }, { horizontal: 128, vertical: 255 }, { horizontal: 255, vertical: 0   }],
        highlight: [{ horizontal: 0, vertical: 0   }, { horizontal: 128, vertical: 0   }, { horizontal: 255, vertical: 255 }],
      };

      const bands: Array<{ key: "shadow" | "mid" | "highlight"; suffix: string }> = [
        { key: "shadow",    suffix: "Shadows"    },
        { key: "mid",       suffix: "Mids"       },
        { key: "highlight", suffix: "Highlights" },
      ];

      for (const band of bands) {
        const baseName = `${RESULT_LAYER_NAME} [${band.suffix}]`;
        const layerName = overwrite ? baseName
          : `${baseName} ${new Date().toTimeString().slice(0, 8)}`;
        const c = multiZoneFit[band.key];
        const layer = await makeCurvesLayer(layerName, [
          { channel: "red",   points: sampleControlPoints(c.r, CONTROL_POINTS) },
          { channel: "green", points: sampleControlPoints(c.g, CONTROL_POINTS) },
          { channel: "blue",  points: sampleControlPoints(c.b, CONTROL_POINTS) },
        ]);
        if (target) { try { await setClippingMask(layer, true); } catch { /* ignore */ } }
        if (params.chromaOnly) { try { layer.blendMode = "hue"; } catch { /* ignore */ } }
        try { await layer.move(group, "placeInside"); } catch { /* ignore */ }

        try {
          // Select this layer + its mask channel. Subsequent edits target the mask.
          await action.batchPlay([
            { _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false },
            { _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] },
          ], {});

          // Fill the mask from the document composite (gray channel = perceptual luminance).
          // After this, the mask = composite luminance per pixel.
          await action.batchPlay([{
            _obj: "applyImageEvent",
            with: {
              _obj: "calculation",
              to: {
                _ref: [
                  { _ref: "channel", _enum: "channel", _value: "gray" },
                  { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
                ],
              },
              calculation: { _enum: "calculationType", _value: "normal" },
            },
          }], {});

          // Remap the mask via a 3-point Curves into the band's triangular weight curve.
          await action.batchPlay([{
            _obj: "curves",
            presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
            adjustment: [{
              _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "composite" },
              curve: bandCurves[band.key].map(p => ({ _obj: "paint", ...p })),
            }],
          }], {});

          // Re-select the RGB composite so we leave the layer in a normal editing state.
          await action.batchPlay([{
            _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }],
          }], {});
        } catch (e: any) {
          // If any of these fail, the layer still applies as a global Curves — user can
          // add their own mask manually. Continue with the other bands.
          console?.warn?.(`Multi-zone mask build failed for ${band.suffix}: ${e?.message ?? e}`);
        }
      }
      const tags = [`multi-zone (${bands.length} layers)`];
      if (params.amount && params.amount < 1) tags.push(`amt ${Math.round(params.amount * 100)}%`);
      if (params.chromaOnly) tags.push("hue-only");
      if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
      return `Matched · ${tags.join(" · ")}`;
    }

    // ─── Single-curve branch (default) ──────────────────────────────────────────
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
      // Hue blend (not Color): per-channel curves inflate saturation; Color blend propagates
      // that inflation, Hue blend keeps target's S+L and only takes H from the curves output.
      try { curveLayer.blendMode = "hue"; } catch { /* ignore */ }
    }
    try { await curveLayer.move(group, "placeInside"); } catch { /* ignore */ }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("hue-only");
    if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
    return `Matched · ${tags.join(" · ")}`;
  });
}
