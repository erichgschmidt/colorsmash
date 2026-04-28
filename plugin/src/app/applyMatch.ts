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
  multiZone?: boolean;         // emit 3 stacked Curves layers w/ band limiting instead of one
  multiZoneLimit?: "mask" | "blendIf" | "both"; // how to limit each band layer (default mask)
  multiZonePeaks?: { shadow: number; mid: number; highlight: number }; // band peak luma positions
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
      ? processMultiZoneFit(fitMultiZone(srcPixels, downsampleToMaxEdge(t, STATS_MAX_EDGE).data, params.multiZonePeaks), curveOpts, dimOpts)
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

      // Band peak luma positions — adaptive (P10/P50/P90 of target) when caller passes them,
      // fixed at 0/128/255 otherwise. Bands are linear ramps anchored at these peaks.
      const peaks = params.multiZonePeaks ?? { shadow: 0, mid: 128, highlight: 255 };
      const sP = Math.max(0, Math.min(253, peaks.shadow));
      const mP = Math.max(sP + 1, Math.min(254, peaks.mid));
      const hP = Math.max(mP + 1, Math.min(255, peaks.highlight));

      // Triangular band-weight masks (one byte per pixel = weight × 255). Multiplied by
      // alpha when present so transparent pixels get mask value 0 across all bands.
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
        // Linear ramps based on the (possibly adaptive) peak positions.
        const sw = luma <= sP ? 1 : (luma <= mP ? (mP - luma) / (mP - sP) : 0);
        const mw = luma <= sP ? 0 : (luma <= mP ? (luma - sP) / (mP - sP) : (luma <= hP ? (hP - luma) / (hP - mP) : 0));
        const hw = luma <= mP ? 0 : (luma <= hP ? (luma - mP) / (hP - mP) : 1);
        shadowMask[i]    = Math.max(0, Math.min(255, Math.round(a * sw * 255)));
        midMask[i]       = Math.max(0, Math.min(255, Math.round(a * mw * 255)));
        highlightMask[i] = Math.max(0, Math.min(255, Math.round(a * hw * 255)));
      }
      if (compId.dispose) compId.dispose();

      // Blend If fallback ranges — derived from peak positions so they match the masks.
      // dest sliders define the underlying-layer luma ranges where the layer is visible.
      const bands: Array<{
        key: "shadow" | "mid" | "highlight"; suffix: string; mask: Uint8Array;
        destBlackMin: number; destBlackMax: number; destWhiteMin: number; destWhiteMax: number;
      }> = [
        // Blend If sliders matching the triangular weights at peaks (sP, mP, hP):
        //   Shadow:    full 0..sP, fade sP→mP, off mP+
        //   Mid:       off 0..sP, fade in sP→mP, full at mP, fade out mP→hP, off hP+
        //   Highlight: off 0..mP, fade in mP→hP, full hP..255
        { key: "shadow",    suffix: "Shadows",    mask: shadowMask,    destBlackMin: 0,   destBlackMax: 0,   destWhiteMin: sP,  destWhiteMax: mP  },
        { key: "mid",       suffix: "Mids",       mask: midMask,       destBlackMin: sP,  destBlackMax: mP,  destWhiteMin: mP,  destWhiteMax: hP  },
        { key: "highlight", suffix: "Highlights", mask: highlightMask, destBlackMin: mP,  destBlackMax: hP,  destWhiteMin: 255, destWhiteMax: 255 },
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
        // the spatial limiter. Each band layer applies wherever its mask is non-zero,
        // independent of which underlying layer is below. User can manually clip if they
        // want to restrict to a specific underlying layer.
        if (params.chromaOnly) { try { layer.blendMode = "hue"; } catch { /* ignore */ } }
        // NOTE: Blend If attempts run BEFORE moving into the group — per audit feedback,
        // layer descriptor readback can get weird when the layer is nested in a group.

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
          const buildBlendRange = () => [{
            _obj: "blendRange",
            channel: { _ref: "channel", _enum: "channel", _value: "gray" },
            srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
            destBlackMin: band.destBlackMin, destBlackMax: band.destBlackMax,
            destWhiteMin: band.destWhiteMin, destWhiteMax: band.destWhiteMax,
            desaturate: 255,
          }];

          // Variants to try in order. Each performs a `set`, then reads back the
          // layer's blendRange property to verify the values actually stuck (PS often
          // accepts an ill-shaped descriptor without throwing, then ignores it).
          const variants: Array<{ name: string; cmds: () => any[] }> = [
            // 1. Forum-style descriptor with _ref:"channel" + desaturate + _isCommand.
            //    Targets active layer via targetEnum (forum example pattern).
            { name: "forum-shape (select+targetEnum, _ref channel, desaturate)",
              cmds: () => [
                { _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false },
                {
                  _obj: "set",
                  _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                  to: { _obj: "layer", blendRange: buildBlendRange() },
                  _isCommand: true,
                } as any,
              ],
            },
            // 2. Same shape but targeting layer by id directly.
            { name: "by-id, _ref channel, desaturate",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: { _obj: "layer", blendRange: buildBlendRange() },
                _isCommand: true,
              } as any],
            },
            // 3. Wrapped in blendingOptions (per audit suggestion #2).
            { name: "layer.blendingOptions.blendRange",
              cmds: () => [{
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: { _obj: "layer", blendingOptions: { _obj: "blendingOptions", blendRange: buildBlendRange() } },
                _isCommand: true,
              } as any],
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
              const got = readResult?.[0]?.blendRange?.[0];
              if (got &&
                  got.destBlackMin === band.destBlackMin && got.destBlackMax === band.destBlackMax &&
                  got.destWhiteMin === band.destWhiteMin && got.destWhiteMax === band.destWhiteMax) {
                blendIfOk = true;
                break;
              }
              blendIfErr = new Error(`Variant '${variant.name}' set accepted but readback shows defaults`);
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

      const tags = [`multi-zone (${bands.length} layers)`];
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
