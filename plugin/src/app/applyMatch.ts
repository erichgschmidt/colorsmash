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
  fitByMode, MatchMode, Preset, transformCurvesForPreset,
  fitMultiZoneByMode, processMultiZoneFit,
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
  multiZone?: boolean;         // emit 3 stacked Curves layers w/ band limiting instead of one
  multiZoneLimit?: "mask" | "blendIf" | "both"; // how to limit each band layer (default mask)
  multiZonePeaks?: { shadow: number; mid: number; highlight: number }; // band peak luma positions
  multiZoneExtents?: { min: number; max: number }; // outer histogram bounds for the bands
  sourcePixelsOverride?: Uint8Array; // if set, use these RGBA pixels instead of reading source layer
  sourceLabel?: string; // optional name shown in result message
  colorSpace?: "rgb" | "lab";
  deselectFirst?: boolean;     // drop active marquee before creating layer (default true)
  overwritePrior?: boolean;    // delete prior Match Curves (true) or hide them (false) (default true)
  preset?: Preset;             // quick-select variant: color (default) | hue | bw | contrast
  // Target-palette mask: when present, the Curves adjustment layer is masked so
  // pixels in each cluster get the curves applied at strength = clamp01(weight).
  // The full-res target pixels are clustered against `swatches` (Lab nearest-
  // centroid), and a grayscale mask is generated where mask[pixel] =
  // softWeight(weights, distances, softness) × 255. Curves layer is created
  // with that mask attached. Skipped when all weights ≈ 1.
  targetPalette?: {
    swatches: Array<{ labL: number; labA: number; labB: number; r: number; g: number; b: number; weight: number }>;
    weights: number[];
    // Softness 0..100. 0 = hard nearest-cluster (sharp mask boundaries),
    // >0 = gaussian-soft blend across all clusters (smooth gradients).
    softness?: number;
  };
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
      ? processMultiZoneFit(fitMultiZoneByMode(params.matchMode ?? "full", srcPixels, downsampleToMaxEdge(t, STATS_MAX_EDGE).data, params.multiZonePeaks, params.multiZoneExtents), curveOpts, dimOpts)
      : null;

    // Reuse existing [Color Smash] group. Prior Match Curves layers are either deleted
    // (overwritePrior=true, default) or just hidden (overwritePrior=false).
    //
    // Search recursively because a previous run may have left a [Color Smash] nested
    // inside another (the original bug: doc.createLayerGroup creates the new group
    // INSIDE whatever container holds the active layer — if active was inside a prior
    // [Color Smash], the new one stacked inside it). Recursive find means we always
    // reuse the existing one even if it's mis-nested. We also prefer top-level matches
    // so the canonical group lives at the doc root.
    const isCSGroup = (l: any) => l && l.name === GROUP_NAME && (l.kind === "group" || Array.isArray(l.layers));
    function findCSGroupRecursive(layers: any[]): any | null {
      // Prefer top-level match
      for (const l of layers) if (isCSGroup(l)) return l;
      // Then descend into any sub-groups
      for (const l of layers) {
        if (l && Array.isArray(l.layers)) {
          const found = findCSGroupRecursive(l.layers);
          if (found) return found;
        }
      }
      return null;
    }
    let group = findCSGroupRecursive(doc.layers);
    if (!group) {
      // No existing group anywhere. Ensure the new one is created at the DOC ROOT, not
      // inside whatever group currently contains the active layer. selectNoLayers clears
      // the insertion-point context so PS creates the group at the top level.
      try {
        await action.batchPlay([{ _obj: "selectNoLayers", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
      } catch { /* not critical */ }
      group = await doc.createLayerGroup({ name: GROUP_NAME });
    }
    // Position the group directly above the target layer (in the panel) on every run,
    // not just first-creation. If the user picks a different target after a prior apply,
    // the group should follow — otherwise the curves visually float somewhere unrelated
    // to the layer they affect. Skipped in merged-target mode (no specific anchor).
    if (target) {
      try { await group.move(target, "placeBefore"); } catch { /* ignore — keep where it is */ }
    }
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
      // Use imaging.putLayerMask (the proper API for writing layer masks; imaging.putPixels
      // targets pixel layers, not adjustment-layer masks). Compute the three triangular
      // band-weight masks in JS from the document composite, then write each as a layer
      // mask. If putLayerMask fails for any band, we fall back to a Blend If batchPlay
      // descriptor on that layer. If BOTH approaches fail, we report it in the return tag
      // so the user knows the result wasn't band-limited (and the Layers panel will show
      // 3 unrestricted Curves layers — visible enough that the user can fix manually).

      const { imaging } = require("photoshop");

      // Read full-res document composite for mask computation. Request 4-component output
      // so we get alpha — needed to zero out mask values in transparent areas (otherwise
      // the highlight mask reads outside-image pixels as full-white luma and ends up white
      // in the border, applying the highlight Curves to nothing visible but polluting the
      // mask thumbnail).
      const compResult = await imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: false });
      const compId = compResult.imageData;
      const compRaw = await compId.getData();
      const compSrc = compRaw instanceof Uint8Array ? compRaw : new Uint8Array(compRaw);
      const compW = compId.width, compH = compId.height;
      const compComps = compId.components ?? (compSrc.length / (compW * compH));
      const hasAlpha = compComps === 4;

      // Band peak luma positions + outer extents. Adaptive (from target histogram) when
      // caller passes them, fixed at 0/128/255 + 0/255 otherwise.
      const peaks = params.multiZonePeaks ?? { shadow: 0, mid: 128, highlight: 255 };
      const extents = params.multiZoneExtents ?? { min: 0, max: 255 };
      const sP = Math.max(0, Math.min(253, peaks.shadow));
      const mP = Math.max(sP + 1, Math.min(254, peaks.mid));
      const hP = Math.max(mP + 1, Math.min(255, peaks.highlight));
      const eMin = Math.max(0, Math.min(sP, extents.min));
      const eMax = Math.max(hP, Math.min(255, extents.max));

      // Triangular band-weight masks (one byte per pixel = weight × 255). Multiplied by
      // alpha when present so transparent pixels get mask value 0 across all bands.
      // Pixels outside [eMin, eMax] get zero across all bands → identity passthrough.
      const pxCount = compW * compH;
      const shadowMask = new Uint8Array(pxCount);
      const midMask = new Uint8Array(pxCount);
      const highlightMask = new Uint8Array(pxCount);
      for (let i = 0, j = 0; i < pxCount; i++, j += compComps) {
        const a = hasAlpha ? compSrc[j + 3] / 255 : 1;
        if (a < 1 / 255) {
          shadowMask[i] = 0; midMask[i] = 0; highlightMask[i] = 0;
          continue;
        }
        const r = compSrc[j], g = compSrc[j + 1], b = compSrc[j + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma < eMin || luma > eMax) {
          shadowMask[i] = 0; midMask[i] = 0; highlightMask[i] = 0;
          continue;
        }
        // Linear ramps anchored at peaks AND extents (shadow ramps up from eMin to sP,
        // highlight ramps down from hP to eMax — matches the visual histogram bounds).
        const sw = luma <= sP ? (sP === eMin ? 1 : (luma - eMin) / (sP - eMin))
                              : (luma <= mP ? (mP - luma) / (mP - sP) : 0);
        const mw = luma <= sP ? 0 : (luma <= mP ? (luma - sP) / (mP - sP) : (luma <= hP ? (hP - luma) / (hP - mP) : 0));
        const hw = luma <= mP ? 0 : (luma <= hP ? (luma - mP) / (hP - mP)
                                                 : (eMax === hP ? 1 : (eMax - luma) / (eMax - hP)));
        shadowMask[i]    = Math.max(0, Math.min(255, Math.round(a * sw * 255)));
        midMask[i]       = Math.max(0, Math.min(255, Math.round(a * mw * 255)));
        highlightMask[i] = Math.max(0, Math.min(255, Math.round(a * hw * 255)));
      }
      if (compId.dispose) compId.dispose();

      // Blend If fallback ranges — outer slider positions match the histogram extents
      // (eMin / eMax) instead of always 0 / 255, so the slider visualization is honest.
      const bands: Array<{
        key: "shadow" | "mid" | "highlight"; suffix: string; mask: Uint8Array;
        destBlackMin: number; destBlackMax: number; destWhiteMin: number; destWhiteMax: number;
      }> = [
        // Sliders mirror the partition-of-unity triangular weights (peaks at sP/mP/hP):
        //   Shadow:    fade in eMin→sP, full sP, fade out sP→mP, off mP+
        //   Mid:       off below sP, fade in sP→mP, full mP, fade out mP→hP, off hP+
        //   Highlight: off below mP, fade in mP→hP, full hP, fade out hP→eMax, off eMax+
        { key: "shadow",    suffix: "Shadows",    mask: shadowMask,    destBlackMin: eMin, destBlackMax: sP,  destWhiteMin: sP,  destWhiteMax: mP  },
        { key: "mid",       suffix: "Mids",       mask: midMask,       destBlackMin: sP,   destBlackMax: mP,  destWhiteMin: mP,  destWhiteMax: hP  },
        { key: "highlight", suffix: "Highlights", mask: highlightMask, destBlackMin: mP,   destBlackMax: hP,  destWhiteMin: hP,  destWhiteMax: eMax },
      ];

      const failures: string[] = [];
      const limitMode = params.multiZoneLimit ?? "mask"; // 'mask' | 'blendIf' | 'both'

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
        // No clipping mask in multi-zone — the per-band luminosity mask (or Blend If) is
        // the spatial limiter. User can manually clip if they want layer-specific restriction.
        if (params.chromaOnly) { try { layer.blendMode = "hue"; } catch { /* ignore */ } }
        // Move into the group BEFORE Blend If attempts — recent testing shows the layer.move
        // call after a successful blendRange set may revert the destWhiteMax field back to
        // default. Doing the move first means subsequent Blend If is the final state.
        try { await layer.move(group, "placeInside"); } catch { /* ignore */ }

        // Try the user-preferred limiting method(s). 'mask' uses putLayerMask only (clean
        // single approach). 'blendIf' uses batchPlay-set descriptor only. 'both' applies
        // BOTH for maximum reliability — the layer ends up double-limited (mask × blendIf)
        // which is fine because both encode the same triangular weights, so the product
        // is just a slightly squarer version of the same band.
        let maskOk = false, blendIfOk = false;
        const wantMask = limitMode === "mask" || limitMode === "both";
        const wantBlendIf = limitMode === "blendIf" || limitMode === "both";

        let maskErr: any = null;
        if (wantMask) {
          try {
            const maskImageData = await imaging.createImageDataFromBuffer(band.mask, {
              width: compW, height: compH, components: 1, chunky: true, colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
            });
            await imaging.putLayerMask({
              documentID: doc.id,
              layerID: layer.id,
              imageData: maskImageData,
              targetBounds: { left: 0, top: 0, right: compW, bottom: compH },
              replace: true,
            });
            if (maskImageData.dispose) maskImageData.dispose();
            maskOk = true;
          } catch (e: any) { maskErr = e; }
        }

        let blendIfErr: any = null;
        if (wantBlendIf || (limitMode === "mask" && !maskOk)) {
          // Try multiple Blend If descriptor formats, verifying each by reading back the
          // layer's blendRange property. The set call doesn't throw on bad descriptors —
          // it accepts and silently ignores. Without readback, we can't know it worked.
          // Per UXP-forum example, the channel descriptor needs `_ref: "channel"` AND
          // a `desaturate` field is included in working examples. This is a more faithful
          // mirror of the Action Manager descriptor than my previous attempts.
          // KEY FIX: Photoshop's Action Manager descriptor uses `desaturate` (not
          // `destWhiteMax`) for the white-side split's RIGHT position. So setting
          // `desaturate: 255` always pinned the white max to 255 regardless of what we
          // tried to set in destWhiteMax. The fix is to set `desaturate: band.destWhiteMax`
          // and drop the destWhiteMax field entirely (it's silently ignored anyway).
          const grayEntry = {
            _obj: "blendRange",
            channel: { _ref: "channel", _enum: "channel", _value: "gray" },
            srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
            destBlackMin: band.destBlackMin, destBlackMax: band.destBlackMax,
            destWhiteMin: band.destWhiteMin,
            desaturate: band.destWhiteMax, // ← actual white-side max field
          };
          const buildBlendRange = () => [grayEntry];
          // All-channels variant — gray + R/G/B each as defaults (no band limiting on the
          // per-channel sliders, since we only care about composite luma for multi-zone).
          const buildAllChannelsBlendRange = () => [
            grayEntry,
            { _obj: "blendRange", channel: { _ref: "channel", _enum: "channel", _value: "red" },
              srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
              destBlackMin: 0, destBlackMax: 0, destWhiteMin: 255, desaturate: 255 },
            { _obj: "blendRange", channel: { _ref: "channel", _enum: "channel", _value: "green" },
              srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
              destBlackMin: 0, destBlackMax: 0, destWhiteMin: 255, desaturate: 255 },
            { _obj: "blendRange", channel: { _ref: "channel", _enum: "channel", _value: "blue" },
              srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
              destBlackMin: 0, destBlackMax: 0, destWhiteMin: 255, desaturate: 255 },
          ];

          // Variants to try in order. Each performs a `set`, then reads back the layer's
          // blendRange to verify all four dest values actually stuck.
          const variants: Array<{ name: string; cmds: () => any[] }> = [
            // 1. Minimal: bare layer wrapper with blendRange only. No _isCommand, no
            //    knockout/blendInteriorElements/layerMaskAsGlobalMask fluff that might
            //    be triggering PS's "partial update" behavior.
            { name: "minimal by-id",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: { _obj: "layer", blendRange: buildBlendRange() },
              }],
            },
            // 2. Same minimal shape but via select+targetEnum.
            { name: "minimal select+targetEnum",
              cmds: () => [
                { _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false },
                { _obj: "set",
                  _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                  to: { _obj: "layer", blendRange: buildBlendRange() },
                },
              ],
            },
            // 3. With wrapping fields (the previous default — kept as fallback).
            { name: "with wrapping fields",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: {
                  _obj: "layer",
                  blendInteriorElements: false,
                  knockout: { _enum: "knockout", _value: "none" },
                  layerMaskAsGlobalMask: false,
                  blendRange: buildBlendRange(),
                },
                _isCommand: true,
              } as any],
            },
            // 4. blendingOptions wrapper (audit suggestion).
            { name: "blendingOptions wrapper",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: { _obj: "layer", blendingOptions: { _obj: "blendingOptions", blendRange: buildBlendRange() } },
              }],
            },
            // 5. All four channels (gray + R + G + B). PS may require the full descriptor.
            { name: "all-channels by-id",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: { _obj: "layer", blendRange: buildAllChannelsBlendRange() },
              }],
            },
          ];

          for (const variant of variants) {
            try {
              await action.batchPlay(variant.cmds(), {});

              // Readback verification — get blendRange and compare.
              const readResult = await action.batchPlay([{
                _obj: "get",
                _target: [
                  { _ref: "property", _property: "blendRange" },
                  { _ref: "layer", _id: layer.id },
                ],
              }], { synchronousExecution: false });
              const allRanges = readResult?.[0]?.blendRange ?? [];
              // Find the gray channel entry (or fall back to first entry).
              const got = allRanges.find((e: any) => e?.channel?._value === "gray") ?? allRanges[0];
              // Note: white-side max is stored as `desaturate` in the descriptor — that's
              // what we set, that's what we read back. PS's `destWhiteMax` field is unused.
              const gotWhiteMax = got?.desaturate ?? got?.destWhiteMax;
              if (got &&
                  got.destBlackMin === band.destBlackMin && got.destBlackMax === band.destBlackMax &&
                  got.destWhiteMin === band.destWhiteMin && gotWhiteMax === band.destWhiteMax) {
                blendIfOk = true;
                break;
              }
              blendIfErr = new Error(`'${variant.name}' wanted dest=${band.destBlackMin}/${band.destBlackMax}/${band.destWhiteMin}/${band.destWhiteMax} got ${got?.destBlackMin}/${got?.destBlackMax}/${got?.destWhiteMin}/${gotWhiteMax} (${allRanges.length} entries)`);
            } catch (e: any) {
              blendIfErr = new Error(`Variant '${variant.name}' threw: ${e?.message ?? e}`);
            }
          }
        }

        if (!maskOk && !blendIfOk) {
          const reasons: string[] = [];
          if (maskErr) reasons.push(`mask: ${maskErr?.message ?? maskErr}`);
          if (blendIfErr) reasons.push(`blendIf: ${blendIfErr?.message ?? blendIfErr}`);
          failures.push(`${band.suffix} (${reasons.join("; ")})`);
        }
        // Move into [Color Smash] group AFTER mask/blend if attempts so layer descriptor
        // readback isn't confused by group nesting (per audit suggestion #1).
        try { await layer.move(group, "placeInside"); } catch { /* ignore */ }
      }

      const adaptive = (eMin > 0 || eMax < 255 || sP > 0 || hP < 255);
      const tags = [`multi-zone (${bands.length} layers, ${adaptive ? "adaptive" : "fixed"} ${eMin}-${sP}-${mP}-${hP}-${eMax})`];
      if (params.amount && params.amount < 1) tags.push(`amt ${Math.round(params.amount * 100)}%`);
      if (params.chromaOnly) tags.push("hue-only");
      if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
      if (failures.length > 0) {
        // Surface the failure to the user instead of silently returning success.
        return `Matched (PARTIAL) · ${tags.join(" · ")} · ⚠ ${failures.length}/${bands.length} band(s) lack mask: ${failures.join("; ")}`;
      }
      return `Matched · ${tags.join(" · ")}`;
    }

    // ─── Single-curve branch (default) ──────────────────────────────────────────
    // If keeping prior layers, give the new one a unique numbered suffix so they coexist.
    const layerName = overwrite ? RESULT_LAYER_NAME
      : `${RESULT_LAYER_NAME} ${new Date().toTimeString().slice(0, 8)}`;
    // Quick-select preset: collapse to a single luma curve for bw/contrast (R=G=B), and pick
    // the matching blend mode below. color/hue keep per-channel curves.
    const preset = params.preset ?? "color";
    const finalCurves = transformCurvesForPreset(curves, preset);
    const curveLayer = await makeCurvesLayer(layerName, [
      { channel: "red",   points: sampleControlPoints(finalCurves.r, CONTROL_POINTS) },
      { channel: "green", points: sampleControlPoints(finalCurves.g, CONTROL_POINTS) },
      { channel: "blue",  points: sampleControlPoints(finalCurves.b, CONTROL_POINTS) },
    ]);
    // Only clip if there's a specific target layer. Merged target = no clip (affects everything below).
    if (target) await setClippingMask(curveLayer, true);
    // Blend mode per preset:
    //   hue       → "color" blend (H+S from curves, target keeps luma) — formerly
    //               "hue" blend; user-facing label is now "Color" since color blend
    //               transfers saturation too which is what users actually want
    //   contrast  → Luminosity blend (luma from curves, target keeps colors entirely)
    //   color     → Normal (full per-channel transfer — labelled "Full" in the UI)
    const presetBlend =
      preset === "hue" || params.chromaOnly ? "color" :
      preset === "contrast" ? "luminosity" :
      null;
    if (presetBlend) { try { curveLayer.blendMode = presetBlend; } catch { /* ignore */ } }
    try { await curveLayer.move(group, "placeInside"); } catch { /* ignore */ }

    // Target-palette mask: when the user has dialed any cluster's weight away
    // from 1, build a grayscale mask at full target resolution (one byte per
    // pixel = clamp01(weight[clusterId]) × 255) and attach it to the Curves
    // layer via imaging.putLayerMask. Each target pixel is assigned to its
    // nearest cluster centroid (Lab distance) — same math the preview uses,
    // just at full resolution. Skipped on merged-target since we don't have
    // a layer-bounds-aligned full-res buffer in that path.
    if (params.targetPalette && !targetIsMerged && t && t.data) {
      const tp = params.targetPalette;
      try {
        const k = tp.swatches.length;
        const softness = Math.max(0, Math.min(100, tp.softness ?? 0));
        const useSoft = softness > 0;
        const sigma2 = (softness / 100) * (softness / 100) * 5000; // matches histogramMatch SIGMA_BASE_2_APPLY
        // Per-cluster weights as float [0,1] (used in soft path) and as
        // pre-rounded byte values (used in hard path).
        const wFloat = new Float32Array(k);
        const wByte = new Uint8Array(k);
        for (let i = 0; i < k; i++) {
          const w = Math.max(0, Math.min(1, tp.weights[i]));
          wFloat[i] = w;
          wByte[i] = Math.round(w * 255);
        }
        const cents = new Float32Array(k * 3);
        for (let i = 0; i < k; i++) {
          cents[i * 3] = tp.swatches[i].labL;
          cents[i * 3 + 1] = tp.swatches[i].labA;
          cents[i * 3 + 2] = tp.swatches[i].labB;
        }
        const pxCount = t.width * t.height;
        const mask = new Uint8Array(pxCount);
        const srgbToLinear = (c: number) => {
          const x = c / 255;
          return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        const f = (t0: number) => t0 > 0.008856 ? Math.cbrt(t0) : (7.787 * t0 + 16 / 116);
        // Reusable distance buffer for the soft path (avoids per-pixel allocation).
        const distBuf = new Float32Array(k);
        for (let i = 0; i < pxCount; i++) {
          const o = i * 4;
          if (t.data[o + 3] < 128) { mask[i] = 0; continue; }
          const R = srgbToLinear(t.data[o]);
          const G = srgbToLinear(t.data[o + 1]);
          const B = srgbToLinear(t.data[o + 2]);
          const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
          const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
          const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
          const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
          const L = 116 * fy - 16, a = 500 * (fx - fy), b2 = 200 * (fy - fz);
          if (!useSoft) {
            // Hard nearest-cluster path: bit-for-bit same as previous behavior.
            let best = 0, bestDist = Infinity;
            for (let c = 0; c < k; c++) {
              const dl = L - cents[c * 3];
              const da = a - cents[c * 3 + 1];
              const db = b2 - cents[c * 3 + 2];
              const d = dl * dl + da * da + db * db;
              if (d < bestDist) { bestDist = d; best = c; }
            }
            mask[i] = wByte[best];
          } else {
            // Soft-blend: gaussian over all clusters, weighted sum of weights.
            let minD = Infinity;
            for (let c = 0; c < k; c++) {
              const dl = L - cents[c * 3];
              const da = a - cents[c * 3 + 1];
              const db = b2 - cents[c * 3 + 2];
              const d = dl * dl + da * da + db * db;
              distBuf[c] = d;
              if (d < minD) minD = d;
            }
            let sumG = 0, sumWG = 0;
            for (let c = 0; c < k; c++) {
              const g = Math.exp(-(distBuf[c] - minD) / sigma2);
              sumG += g;
              sumWG += g * wFloat[c];
            }
            const wf = sumG > 0 ? sumWG / sumG : 1;
            mask[i] = Math.max(0, Math.min(255, Math.round(wf * 255)));
          }
        }
        const { imaging } = require("photoshop");
        const maskImageData = await imaging.createImageDataFromBuffer(mask, {
          width: t.width, height: t.height, components: 1, chunky: true,
          colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
        });
        await imaging.putLayerMask({
          documentID: doc.id,
          layerID: curveLayer.id,
          imageData: maskImageData,
          targetBounds: t.bounds,
          replace: true,
        });
        if (maskImageData.dispose) maskImageData.dispose();
      } catch { /* mask attach is best-effort; if it fails, the curves still apply unmasked */ }
    }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("hue-only");
    if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
    return `Matched · ${tags.join(" · ")}`;
  });
}
