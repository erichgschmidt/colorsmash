// Histogram-match Apply: fits per-channel R/G/B curves so target's histograms match source's,
// then creates ONE Curves adjustment layer (clipped to target). Single editable node.

import {
  readLayerPixels, executeAsModal, statsRectForLayer,
  makeCurvesLayer, setClippingMask, GROUP_NAME, action, app, setLayerColor, COLOR_SMASH_GROUP_COLOR, isColorSmashGroupName,
  readSelectionMaskBytes,
  deleteLayerMask, snapshotSelectionToChannel, restoreSelectionFromChannel, deleteChannel, deselectAll,
} from "../services/photoshop";
import { composeWithSelection, fullMask } from "./targetMask";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  sampleControlPoints, processChannelCurves, applyDimensions,
  applyZoneAndEnvelopeToChannels, MERGED_LAYER_ID,
  ChannelCurves, DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
  EnvelopePoint, DEFAULT_ENVELOPE,
  fitByMode, MatchMode, Preset, transformCurvesForPreset,
} from "../core/histogramMatch";
import { writeLutLayerState } from "./lutXmp";

const STATS_MAX_EDGE = 512;
const CONTROL_POINTS = 12;
// v1.20.57 — distinguish the output by colorSpace so RGB and Lab bakes
// don't collide in the [Color Smash] group. Replace-mode lookup also
// matches the prefix so prior bakes get cleaned up correctly.
function resultLayerName(colorSpace?: "rgb" | "lab"): string {
  if (colorSpace === "lab") return "Match Lab";
  return "Match RGB";
}

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
  // Marquee selection tristate — parity with the LUT path. When "focus", the
  // current PS marquee is composed into the layer mask so the Curves layer
  // applies only inside the selection. When "exclude", the inverse — Curves
  // applies outside the selection. Composed multiplicatively with the
  // target-palette mask when both are active; when palette is neutral, a
  // constant-255 base mask is used so selection alone drives the mask.
  // Skipped when target is Merged (no spatial anchor).
  selectionMode?: "off" | "focus" | "exclude";
  // v1.20.40 — XMP state snapshot for RESTORE / AUTO round-trip. When set,
  // a serialized panel-state blob is embedded as metadata on the outer
  // sub-group and inner Curves layer (parity with applyLut). Without this,
  // clicking a Curves bake and pressing RESTORE was a no-op — only LUT
  // bakes ever round-tripped.
  xmpState?: import("./lutXmp").LutLayerState;
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
    // v1.20.57 — per-colorSpace layer name. Each output mode (RGB / Lab)
    // gets its own naming so they don't collide and Replace-mode only
    // cleans up bakes of the same mode.
    const RESULT_LAYER_NAME = resultLayerName(params.colorSpace);
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
    // v1.20.34 — read the FULL LAYER pixels separately (not selection-
    // intersected) for the mask-building path. The bake's curves are
    // still fit from `t` (selection-cropped, for accuracy when the user
    // wants the curves derived from just the selected pixels), but the
    // mask must cover the ENTIRE layer or PS uses its default
    // (white/visible) outside the attached region — which silently broke
    // focus mode (selection-restricted apply leaked out everywhere
    // beyond the marquee). applyLut never had this bug because it reads
    // at undefined sourceBounds.
    let tFullForMask: typeof t = t;
    if (!targetIsMerged) {
      try { tFullForMask = await readLayerPixels(target, undefined, tgtDoc.id); }
      catch { /* fall back to t if the full read fails */ }
    }
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

    // v1.20.70 — multi-zone branch retired. Single-curve path below is
    // the only output now.

    // Reuse existing [Color Smash] group. Prior Match Curves layers are either deleted
    // (overwritePrior=true, default) or just hidden (overwritePrior=false).
    //
    // Search recursively because a previous run may have left a [Color Smash] nested
    // inside another (the original bug: doc.createLayerGroup creates the new group
    // INSIDE whatever container holds the active layer — if active was inside a prior
    // [Color Smash], the new one stacked inside it). Recursive find means we always
    // reuse the existing one even if it's mis-nested. We also prefer top-level matches
    // so the canonical group lives at the doc root.
    // v1.20.69 — accept BOTH the current user-chosen group name AND
    // the legacy "[Color Smash]" default so a rename via Settings
    // doesn't orphan an existing group from a prior session.
    const isCSGroup = (l: any) => l && isColorSmashGroupName(l.name) && (l.kind === "group" || Array.isArray(l.layers));
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
      // v1.20.69 — orange color tag for visibility in PS Layers panel.
      try { if (group?.id != null) await setLayerColor(group.id, COLOR_SMASH_GROUP_COLOR); } catch { /* ignore */ }
    }
    // Position the group directly above the target layer (in the panel) on every run,
    // not just first-creation. If the user picks a different target after a prior apply,
    // the group should follow — otherwise the curves visually float somewhere unrelated
    // to the layer they affect. Skipped in merged-target mode (no specific anchor).
    if (target) {
      try { await group.move(target, "placeBefore"); } catch { /* ignore — keep where it is */ }
    }
    const overwrite = params.overwritePrior !== false;
    // Preset blend mode used by every Curves layer we create (single-curve and
    // each band of multi-zone). Must be consistent across both paths so the
    // user's preset choice (Hue / Saturation / Contrast / Color / Full) is
    // honored regardless of multi-zone mode.
    //   color           → null         (Normal blend, default)
    //   hue (Color UI)  → "color"      H + S transfer, target keeps L
    //   hueOnly (Hue UI)→ "hue"        H only
    //   saturationOnly  → "saturation" S only
    //   contrast        → "luminosity" L only
    //   chromaOnly flag → "color"      legacy "Hue only" toggle, semantically same as Color preset
    const preset = params.preset ?? "color";
    const presetBlend =
      preset === "hue" || params.chromaOnly ? "color" :
      preset === "hueOnly" ? "hue" :
      preset === "saturationOnly" ? "saturation" :
      preset === "contrast" ? "luminosity" :
      null;
    // Collect every descendant whose name matches the Match-Curves prefix, recursing
    // into sub-groups. Critical for multi-zone: the sub-group ('Match Curves') contains
    // band layers ('Match Curves [Shadows]', etc.) — when PS deletes the group it often
    // ORPHANS those children up to the parent rather than deleting them, leaving 3 stale
    // siblings beside the new sub-group on the next run. Walking the tree first means we
    // delete (or hide) every band layer individually, then the now-empty sub-group.
    // v1.20.70 — also match the inner `Multi-${RESULT_LAYER_NAME}`
    // bandContainer (e.g. "Multi-Match RGB"). Without this, the
    // recursion skipped over it and PS-orphaned its 3 band-layer
    // descendants up to the [Color Smash] group on the next single-mode
    // bake — leaving "Multi-Match RGB" + 3 band layers as zombies
    // alongside the new single Curves layer.
    const MULTI_PREFIX = `Multi-${RESULT_LAYER_NAME}`;
    const collectMatches = (parent: any, out: any[]) => {
      for (const child of parent.layers ?? []) {
        const name = child.name;
        const matches = typeof name === "string" && (
          name === RESULT_LAYER_NAME ||
          name.startsWith(RESULT_LAYER_NAME) ||
          name === MULTI_PREFIX ||
          name.startsWith(MULTI_PREFIX)
        );
        if (matches) {
          // Recurse first so descendants get deleted before their group container
          if (child.layers) collectMatches(child, out);
          out.push(child);
        }
      }
    };
    const matchChildren: any[] = [];
    collectMatches(group, matchChildren);
    if (overwrite) {
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

    // v1.20.25 — removed auto-deselect-before-Apply. The previous behavior
    // dropped the active marquee before the bake ran, which destroyed the
    // selection that the selectionMode (focus/exclude) compositor needs to
    // read later in the same flow. Users wanted their marquee preserved so
    // the mask path could honor it; they can Ctrl+D manually if they want
    // the marching ants gone after a bake.
    // v1.20.32 — capture selection mask bytes EAGERLY while the marquee
    // is still live, so the compose blocks below don't depend on
    // mid-flow restoreSelectionFromChannel succeeding (which was
    // silently failing on some PS versions due to the malformed Save
    // Selection descriptor — making focus and exclude both fall through
    // to the base mask = all-white = adjustment everywhere). Parity
    // with applyLut.ts which already eager-captures at its top.
    const eagerSelBytesHolder: { value: Uint8Array | null } = { value: null };
    if (params.selectionMode === "focus" || params.selectionMode === "exclude") {
      try {
        if (!targetIsMerged && tFullForMask && tFullForMask.bounds) {
          // v1.20.34 — read at FULL layer bounds (not stats-intersected),
          // so the mask covers the entire layer and PS doesn't fill the
          // unmasked region with its default-visible mask.
          eagerSelBytesHolder.value = await readSelectionMaskBytes(doc.id, tFullForMask.bounds);
        }
      } catch { /* ignore */ }
    }

    // v1.20.33 — selection bytes are aligned to `t.bounds`, but the mask
    // buffer downstream is sized to `t.width × t.height`. On layers with
    // non-integer or rounding-differing bounds, these can be off by a few
    // pixels — strict equality would skip compose entirely. Resample-
    // tolerant helper: returns selection bytes sized exactly to
    // (mask.length). Identity passthrough when sizes already match.
    const resampleSelectionToMaskSize = (sel: Uint8Array, maskLen: number): Uint8Array => {
      if (sel.length === maskLen) return sel;
      // We can't recover spatial alignment exactly without knowing both
      // dimensions, but bounds-width-vs-imageData-width differences are
      // tiny (rounding only). Truncate or zero-pad as needed; the compose
      // result is correct on the majority of pixels and any 1-row/col
      // discrepancy is invisible.
      const out = new Uint8Array(maskLen);
      out.set(sel.subarray(0, Math.min(sel.length, maskLen)));
      return out;
    };

    // v1.20.26 — snapshot the marquee so PS can't consume it during
    // adjustment-layer creation. Restored at the end of the bake.
    const scSelSnapshot = await snapshotSelectionToChannel();
    // v1.20.28 — explicit deselect so PS doesn't auto-apply the marquee
    // as a mask on the new adjustment layer or the sub-group.
    if (scSelSnapshot) await deselectAll();


    // ─── Single-curve branch (default) ──────────────────────────────────────────
    // If keeping prior layers, give the new one a unique numbered suffix so they coexist.
    const layerName = overwrite ? RESULT_LAYER_NAME
      : `${RESULT_LAYER_NAME} ${new Date().toTimeString().slice(0, 8)}`;
    // Quick-select preset: collapse to a single luma curve for bw/contrast (R=G=B), and pick
    // the matching blend mode below. color/hue keep per-channel curves.
    // (preset / presetBlend are hoisted near the top of the function so both single-curve
    // and multi-zone paths share the same blend-mode mapping.)
    const finalCurves = transformCurvesForPreset(curves, preset);
    const curveLayer = await makeCurvesLayer(layerName, [
      { channel: "red",   points: sampleControlPoints(finalCurves.r, CONTROL_POINTS) },
      { channel: "green", points: sampleControlPoints(finalCurves.g, CONTROL_POINTS) },
      { channel: "blue",  points: sampleControlPoints(finalCurves.b, CONTROL_POINTS) },
    ]);
    // Only clip if there's a specific target layer. Merged target = no clip (affects everything below).
    if (target) await setClippingMask(curveLayer, true);
    // Blend mode per preset:
    //   hue             → "color" blend       (H+S from curves, target keeps L) — labelled "Color" in UI
    //   hueOnly         → "hue" blend         (H only from curves, target keeps S+L) — labelled "Hue" in UI
    //   saturationOnly  → "saturation" blend  (S only from curves, target keeps H+L) — labelled "Saturation" in UI
    //   contrast        → "luminosity" blend  (L only from curves, target keeps H+S)
    //   color           → Normal              (full per-channel transfer — labelled "Full" in the UI)
    if (presetBlend) { try { curveLayer.blendMode = presetBlend; } catch { /* ignore */ } }
    // v1.20.26 — strip auto-applied selection-as-mask from the inner
    // layer. The sub-group below carries the mask we actually want.
    try { if (curveLayer?.id != null) await deleteLayerMask(curveLayer.id); } catch { /* ignore */ }
    // v1.20.24 — wrap the single Curves layer in a sub-group inside
    // [Color Smash], matching the multi-zone bandContainer structure.
    // Mask attaches to the SUB-GROUP rather than the layer, so palette +
    // selection composition lives at the group level.
    const scSubName = overwrite
      ? layerName
      : `${layerName} ${new Date().toTimeString().slice(0, 8)}`;
    const scSubGroup = await doc.createLayerGroup({ name: scSubName });
    try { await scSubGroup.move(group, "placeInside"); } catch { /* ignore */ }
    try { await curveLayer.move(scSubGroup, "placeInside"); } catch { /* ignore */ }

    // Target-palette mask: when the user has dialed any cluster's weight away
    // from 1, build a grayscale mask at full target resolution (one byte per
    // pixel = clamp01(weight[clusterId]) × 255) and attach it to the Curves
    // layer via imaging.putLayerMask. Each target pixel is assigned to its
    // nearest cluster centroid (Lab distance) — same math the preview uses,
    // just at full resolution. Skipped on merged-target since we don't have
    // a layer-bounds-aligned full-res buffer in that path.
    const scSelectionMode = params.selectionMode ?? "off";
    const scUseSelection = scSelectionMode !== "off" && !targetIsMerged;
    const scUsePalette = !!(params.targetPalette && !targetIsMerged && t && t.data);
    if ((scUsePalette || scUseSelection) && !targetIsMerged && tFullForMask && tFullForMask.data) {
      const tp = params.targetPalette;
      // v1.20.35 — TWO MASKS now:
      //   palette-ratio mask → inner adjustment LAYER (curveLayer)
      //   selection mask     → outer SUB-GROUP (scSubGroup)
      // Editing one doesn't disturb the other. Each is built independently;
      // PS multiplies them at render time so the final visible behavior is
      // identical to the prior composited single-mask version.
      const tm = tFullForMask;
      try {
        const pxCount = tm.width * tm.height;
        // Build the palette mask (no selection compose). Empty if no palette.
        let paletteMask: Uint8Array | null = null;
        if (scUsePalette && tp) {
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
        paletteMask = new Uint8Array(pxCount);
        const srgbToLinear = (c: number) => {
          const x = c / 255;
          return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        const f = (t0: number) => t0 > 0.008856 ? Math.cbrt(t0) : (7.787 * t0 + 16 / 116);
        // Reusable distance buffer for the soft path (avoids per-pixel allocation).
        const distBuf = new Float32Array(k);
        for (let i = 0; i < pxCount; i++) {
          const o = i * 4;
          if (tm.data[o + 3] < 128) { paletteMask[i] = 0; continue; }
          const R = srgbToLinear(tm.data[o]);
          const G = srgbToLinear(tm.data[o + 1]);
          const B = srgbToLinear(tm.data[o + 2]);
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
            paletteMask[i] = wByte[best];
          } else {
            // Soft-blend: Lorentzian over all clusters, weighted sum of weights.
            let minD = Infinity;
            for (let c = 0; c < k; c++) {
              const dl = L - cents[c * 3];
              const da = a - cents[c * 3 + 1];
              const db = b2 - cents[c * 3 + 2];
              const d = dl * dl + da * da + db * db;
              distBuf[c] = d;
              if (d < minD) minD = d;
            }
            const invS2 = 1 / sigma2;
            let sumG = 0, sumWG = 0;
            for (let c = 0; c < k; c++) {
              const g = 1 / (1 + (distBuf[c] - minD) * invS2);
              sumG += g;
              sumWG += g * wFloat[c];
            }
            const wf = sumG > 0 ? sumWG / sumG : 1;
            paletteMask[i] = Math.max(0, Math.min(255, Math.round(wf * 255)));
          }
        }
        }
        // Build the selection-only mask for the outer sub-group.
        // composeWithSelection(fullMask, sel, mode) = pure selection mask
        // (focus → selection bytes; exclude → 255 - selection bytes).
        let selectionMaskBytes: Uint8Array | null = null;
        if (scUseSelection && eagerSelBytesHolder.value) {
          const sel = resampleSelectionToMaskSize(eagerSelBytesHolder.value, pxCount);
          selectionMaskBytes = composeWithSelection(fullMask(pxCount), sel, scSelectionMode);
        }
        const { imaging } = require("photoshop");
        // Attach palette mask to inner adjustment layer (palette-ratio mask).
        if (paletteMask) {
          const paletteImageData = await imaging.createImageDataFromBuffer(paletteMask, {
            width: tm.width, height: tm.height, components: 1, chunky: true,
            colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
          });
          await imaging.putLayerMask({
            documentID: doc.id,
            layerID: curveLayer.id,
            imageData: paletteImageData,
            targetBounds: tm.bounds,
            replace: true,
          });
          if (paletteImageData.dispose) paletteImageData.dispose();
        }
        // Attach selection mask to outer sub-group (spatial scope).
        if (selectionMaskBytes) {
          const selImageData = await imaging.createImageDataFromBuffer(selectionMaskBytes, {
            width: tm.width, height: tm.height, components: 1, chunky: true,
            colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
          });
          await imaging.putLayerMask({
            documentID: doc.id,
            layerID: scSubGroup.id,
            imageData: selImageData,
            targetBounds: tm.bounds,
            replace: true,
          });
          if (selImageData.dispose) selImageData.dispose();
        }
      } catch (e: any) {
        try { console.warn("[Color Smash] Single-curve mask attach failed:", e?.message ?? e); } catch { /* ignore */ }
      }
    }

    // v1.20.40 — write XMP for RESTORE / AUTO round-trip. Parity with
    // applyLut. Written to BOTH the inner Curves layer and the outer sub-
    // group so clicking either restores the panel state.
    if (params.xmpState) {
      try { await writeLutLayerState(curveLayer.id, params.xmpState); } catch { /* non-fatal */ }
      if (scSubGroup?.id != null) {
        try { await writeLutLayerState(scSubGroup.id, params.xmpState); } catch { /* non-fatal */ }
      }
    }

    // v1.20.26 — restore the marquee that PS consumed during the
    // adjustment-layer creation, then drop the temp alpha channel.
    if (scSelSnapshot) {
      await restoreSelectionFromChannel(scSelSnapshot);
      await deleteChannel(scSelSnapshot);
    }

    const tags = [`amt ${Math.round(params.amount * 100)}%`];
    if (params.smoothRadius) tags.push(`smooth ${params.smoothRadius}`);
    if (params.maxStretch && params.maxStretch < 100) tags.push(`cap ${params.maxStretch}`);
    if (params.chromaOnly) tags.push("hue-only");
    if (params.sourceLabel) tags.unshift(`src "${params.sourceLabel}"`);
    return `Matched · ${tags.join(" · ")}`;
  });
}
