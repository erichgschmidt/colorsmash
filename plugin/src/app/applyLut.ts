// Auto-apply 3D LUT as a Color Lookup adjustment layer in PS.
//
// Flow:
//   1. Generate the .cube text from the staged curves + preset (same generator
//      Export LUT uses, so output is bit-identical between the two paths).
//   2. Write to UXP plugin temp folder with a unique name.
//   3. Run a batchPlay 'make adjustmentLayer → colorLookup' descriptor that
//      points the layer at the temp file via a session token.
//   4. Move the new layer into the [Color Smash] group, name it, optionally clip.
//
// This is the auto-apply path — the existing Export LUT (file save dialog)
// remains as a portable fallback. If batchPlay descriptor fails on a given
// PS version, the caller should fall back to writing a copy and surfacing
// the path to the user.

import { ChannelCurves, generateLutCube, Preset, lerpCurvesTowardIdentity } from "../core/histogramMatch";
import {
  GROUP_NAME, action, app,
  executeAsModal, readLayerPixels, setClippingMask, PixelBuffer,
  readSelectionMaskBytes,
} from "../services/photoshop";
import { generateIccDeviceLinkBase64 } from "./iccGen";
import {
  TargetPaletteSpec, targetWeightsActive,
  buildTargetPaletteMaskBytes, attachLayerMask, composeWithSelection, fullMask,
} from "./targetMask";
import { LutLayerState, writeLutLayerState } from "./lutXmp";

const LUT_LAYER_PREFIX = "Match LUT";

export interface ApplyLutParams {
  curves: ChannelCurves;
  preset: Preset;
  size?: number;        // default 33 (also accepted via gridSize for clarity)
  /** Grid points per axis for the 3D LUT. 17 = draft, 33 = standard, 65 = high.
   *  Alias for `size`; one of the two should be passed. */
  gridSize?: number;
  /** 0..1 — lerps the generated LUT toward identity before bake. Survives
   *  portable export (.cube) because the lerp is baked INTO the LUT, unlike
   *  PS layer opacity. Default 1 (full strength). */
  strength?: number;
  /** PS colorLookup.dither field — inject noise to hide banding. Default true. */
  dither?: boolean;
  targetLayerId?: number | null; // if provided, clip the LUT layer to it
  overwritePrior?: boolean;      // delete prior 'Match LUT*' layers in [Color Smash] group
  /** If set, look for this existing Match LUT layer and update its LUT data
      in place instead of creating a new one. Used by Live LUT mode for
      continuous slider-driven updates without flickering / stack churn.
      If the layer no longer exists (deleted by user, doc switched, etc.) we
      fall back to creating a new one and the caller should update its ref. */
  updateExistingLayerId?: number | null;
  /** Target palette weights → grayscale mask attached to the LUT layer.
      When any weight is non-1, build the same Lorentzian-soft Lab cluster
      mask the Curves Apply path uses and attach via imaging.putLayerMask.
      Skipped when target is Merged (no layer bounds to align the mask). */
  targetPalette?: TargetPaletteSpec;
  /** True when target is the Merged-document sentinel — skips both clipping
      and per-cluster masking since neither has a meaningful spatial anchor. */
  targetIsMerged?: boolean;
  /** Marquee → layer mask (v1.18.0). When "focus", attach the active
      selection as the layer mask (LUT only applies inside marquee). When
      "exclude", attach the inverse. Composes with the target-palette mask
      when both are active. No-op when "off" or no selection exists. */
  selectionMode?: "off" | "focus" | "exclude";
  /** Panel state to embed in the layer's XMP metadata. When present, the
      layer carries enough info for the Restore button to rehydrate the
      panel UI from this layer later. Optional — apply works without it. */
  xmpState?: LutLayerState;
}

/** Multi-zone parameter bundle. Same shape applyMatch consumes — three
 *  per-channel curve sets (shadow / mid / highlight) plus the band peak +
 *  extent positions used to build the luma triangular masks at full target
 *  resolution. */
export interface ApplyMultiZoneLutParams extends Omit<ApplyLutParams, "curves"> {
  /** Three already-fitted ChannelCurves, one per luma band. Caller computes
   *  these upstream via fitMultiZoneByMode + processMultiZoneFit. */
  multiZoneFit: {
    shadow: ChannelCurves;
    mid: ChannelCurves;
    highlight: ChannelCurves;
  };
  multiZonePeaks?: { shadow: number; mid: number; highlight: number };
  multiZoneExtents?: { min: number; max: number };
}

export interface ApplyLutResult {
  layerName: string;
  layerId: number | null;
}

/** Recursively collect every descendant whose name matches the prefix. */
function collectMatches(parent: any, prefix: string, out: any[]) {
  for (const child of parent.layers ?? []) {
    const name = child.name;
    if (typeof name === "string" && (name === prefix || name.startsWith(prefix))) {
      if (child.layers) collectMatches(child, prefix, out);
      out.push(child);
    }
  }
}

/** Find or create the [Color Smash] group at the doc root. */
async function getOrCreateColorSmashGroup(doc: any): Promise<any> {
  const findCS = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l && l.name === GROUP_NAME && (l.kind === "group" || Array.isArray(l.layers))) return l;
      if (Array.isArray(l.layers)) { const found = findCS(l.layers); if (found) return found; }
    }
    return null;
  };
  const existing = findCS(doc.layers ?? []);
  if (existing) return existing;
  return await doc.createLayerGroup({ name: GROUP_NAME });
}

/** Recursive layer search by id (handles nesting in groups). */
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

/**
 * Encode the cube text as base64. PS's set descriptor accepts the full LUT
 * payload INLINE via the `LUT3DFileData` field — no file path resolution,
 * no UXP sandbox boundary issues. This is what PS itself emits to its action
 * journal when the user picks "Load 3D LUT" from the menu: the file is read
 * once, embedded as base64, and the layer carries the data internally.
 *
 * Using btoa() works because .cube files are pure ASCII text.
 */
function cubeToBase64(cubeText: string): string {
  // btoa() only accepts Latin-1 — it throws InvalidCharacterError on any
  // codepoint > 0xFF. The .cube generator may emit non-ASCII characters in
  // comment headers (e.g. em-dashes, unicode quotes), so we first UTF-8
  // encode the string to a byte array, then base64 the bytes. This is the
  // canonical "btoa for unicode" pattern.
  const bytes = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(cubeText)
    : utf8EncodeFallback(cubeText);

  // Build a Latin-1 string from the bytes. btoa accepts that.
  // (A single big String.fromCharCode.apply call risks call-stack limits on
  // large inputs — chunk to 0x8000 bytes per call.)
  let latin1 = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    latin1 += String.fromCharCode.apply(null, Array.from(slice));
  }
  if (typeof btoa === "function") return btoa(latin1);
  return base64EncodeLatin1Fallback(latin1);
}

/** UTF-8 encode without TextEncoder (defensive — should never be needed in UXP). */
function utf8EncodeFallback(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0xd800 || c >= 0xe000) { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else {
      // surrogate pair
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/** Base64-encode a Latin-1 string (one char per byte). Fallback if no btoa. */
function base64EncodeLatin1Fallback(s: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
    const trip = (a << 16) | (b << 8) | c;
    out += chars[(trip >> 18) & 0x3f];
    out += chars[(trip >> 12) & 0x3f];
    out += i + 1 < s.length ? chars[(trip >> 6) & 0x3f] : "=";
    out += i + 2 < s.length ? chars[trip & 0x3f] : "=";
  }
  return out;
}

/**
 * Set the active adjustment layer to load a 3D LUT from a file path.
 *
 * Diagnostic comparison (v1.11.5) showed: PS's manual "Load 3D LUT" menu
 * action stores `name` as the full native path, and PS internally reads
 * the file from that path and populates `profile` (parsed binary LUT) +
 * `LUT3DFileData` (raw cube bytes) afterward.
 *
 * The trigger is therefore `name: <native path>` in the set descriptor.
 * PS reads the file when it sees that field and self-populates the rest.
 * Inline-data approaches (LUT3DFileData base64) don't work because that
 * field is a result, not an input.
 */
async function tryLoadLutIntoActiveLayer(
  cubeText: string, displayName: string, curves: ChannelCurves, preset: Preset,
  gridSize: number = 33, strength: number = 1, dither: boolean = true,
): Promise<{ ok: boolean; lastErr: any }> {
  // Diagnostic dump of a working manual-load layer (v1.12.1) revealed:
  //   - LUT3DFileData is an ArrayBuffer holding the RAW BYTES of the original
  //     .cube/.look file (NOT a base64 string — that's why v1.11.3-v1.11.4
  //     silently failed; we passed a string where PS expects binary)
  //   - profile is an ICC DeviceLink color profile (PS's parsed internal form)
  //   - name is the file path/label
  //   - LUTFormat tells PS which parser to use
  //
  // Provide LUT3DFileData as ArrayBuffer + LUTFormat. PS parses it directly,
  // populates `profile` itself, and the LUT applies — no file read required.
  // This is the load mechanism PS's menu uses internally; the file path was
  // a red herring.
  // Action Recording → Copy as JavaScript (PS's own emitted descriptor) revealed
  // the correct binary-data wrapper: PS expects an object with shape
  //   { _data: "<base64-encoded bytes>", _rawData: "base64" }
  // NOT a raw ArrayBuffer or Uint8Array (those silently fail in batchPlay's
  // serializer — explains every previous attempt). The wrapper signals to
  // PS's descriptor engine that the field is a binary payload encoded as
  // base64 in JSON.
  //
  // The recorded action also includes a `profile` field with PS's parsed ICC
  // DeviceLink form. We only send `LUT3DFileData` (raw cube text bytes)
  // and let PS parse it itself — if PS regenerates `profile` from the cube
  // data, we're done; if it requires the profile to be pre-baked too, we'd
  // need to generate ICC DeviceLink bytes (next iteration).
  const cubeB64 = cubeToBase64(cubeText);
  // Generate the ICC DeviceLink profile from current curves. PS uses `profile`
  // (the parsed binary form) for rendering — without it the layer holds cube
  // data but applies nothing. We bypass PS's reader entirely by handing it a
  // valid ICC profile we built from the ChannelCurves directly. See iccGen.ts
  // for the template-based generator (one-time captured boilerplate + freshly
  // computed 33³ CLUT bytes).
  const profileB64 = generateIccDeviceLinkBase64(curves, preset, gridSize, strength);
  const setDesc = {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "colorLookup",
      lookupType: { _enum: "colorLookupType", _value: "3DLUT" },
      LUT3DFileData: { _data: cubeB64, _rawData: "base64" },
      LUTFormat: { _enum: "LUTFormatType", _value: "LUTFormatCUBE" },
      LUT3DFileName: displayName,
      name: displayName,
      profile: { _data: profileB64, _rawData: "base64" },
      dither,
    },
  };
  try {
    const result = await action.batchPlay([setDesc as any], {});
    if (result && result[0] && !result[0].error) return { ok: true, lastErr: null };
    return { ok: false, lastErr: result?.[0]?.error };
  } catch (e) {
    return { ok: false, lastErr: e };
  }
}

/**
 * Bake LUT to plugin temp + create (or update in place) a Color Lookup
 * adjustment layer. Returns the layer name + id on success.
 *
 * Two paths:
 *   - updateExistingLayerId set + layer found → load new LUT into existing
 *     layer (no flicker, preserves layer identity for Live LUT mode).
 *   - otherwise → make a fresh adjustment layer + load LUT.
 *
 * On any LUT-load failure we throw with a diagnostic and (in the create
 * path) clean up the orphan identity layer so the user isn't left with
 * an empty Color Lookup layer alongside the error.
 */
export async function applyLutAsAdjustmentLayer(params: ApplyLutParams): Promise<ApplyLutResult> {
  // v1.17.0 LUT knobs: `gridSize` (17/33/65) replaces the legacy `size`
  // alias (kept for back-compat); `strength` (0..1) bakes a partial-effect
  // lerp into the LUT bytes themselves; `dither` controls PS's noise-
  // injection field on the Color Lookup layer.
  const size = params.gridSize ?? params.size ?? 33;
  const strength = Math.max(0, Math.min(1, params.strength ?? 1));
  const dither = params.dither ?? true;
  // Apply strength lerp BEFORE generating cube/ICC so both consumers see the
  // same dialed-back curves. Generator side applies preset postprocess on
  // top of these — order matters: identity-lerp first, preset blend math
  // second.
  const effectiveCurves = strength >= 1 ? params.curves : lerpCurvesTowardIdentity(params.curves, strength);

  // Generate the cube text + ICC profile entirely in memory. Both ride inside
  // the batchPlay descriptor (LUT3DFileData carries the cube bytes,
  // profile carries the ICC DeviceLink) so no file ever touches disk and no
  // folder picker prompts. PS reads everything out of the descriptor itself.
  const cubeText = generateLutCube(effectiveCurves, params.preset, size, "Color Smash");
  const presetTag = params.preset === "color" ? "full"
                  : params.preset === "hue" ? "color"
                  : params.preset === "hueOnly" ? "hue"
                  : params.preset === "saturationOnly" ? "saturation"
                  : "contrast";
  // Cosmetic label shown in the layer's Properties panel — purely descriptive,
  // not a real file path. Including the preset + timestamp keeps each baked
  // LUT identifiable in the descriptor inspector.
  const stamp = Date.now();
  const fileName = `colorsmash_${presetTag}_${stamp}.cube`;

  // Decide whether to attach a layer mask. Three independent inputs:
  //   - target-palette weights (when non-neutral → cluster-soft mask)
  //   - selection tristate (focus / exclude → marquee → mask)
  //   - target is real layer (not Merged — no spatial anchor otherwise)
  // Composed as: cluster_mask × selection_factor.
  // Skipped entirely when target is Merged.
  const selectionMode = params.selectionMode ?? "off";
  const wantPaletteMask = !!(
    params.targetPalette
    && !params.targetIsMerged
    && params.targetLayerId != null
    && targetWeightsActive(params.targetPalette)
  );
  const wantSelectionMask = selectionMode !== "off" && !params.targetIsMerged && params.targetLayerId != null;
  const wantAnyMask = wantPaletteMask || wantSelectionMask;

  return await executeAsModal("Color Smash apply LUT", async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No active document.");

    const layerName = `${LUT_LAYER_PREFIX} [${presetTag}]`;

    // Read target pixels once if we'll need the mask. Same readLayerPixels
    // call applyMatch.ts uses, so the mask is computed against the same
    // full-resolution buffer either path produces.
    let targetBuf: PixelBuffer | null = null;
    let selectionMaskBytes: Uint8Array | null = null;
    if (wantAnyMask) {
      const targetLayer = findLayerById(doc.layers ?? [], params.targetLayerId!);
      if (targetLayer) {
        try {
          targetBuf = await readLayerPixels(targetLayer, undefined, doc.id);
        } catch { /* mask becomes a no-op if read fails */ }
      }
      if (wantSelectionMask && targetBuf) {
        selectionMaskBytes = await readSelectionMaskBytes(doc.id, targetBuf.bounds);
        // Null means no marquee active or imaging API rejected — treat as
        // mode = off for this bake. (Don't surface as an error; the user
        // may have deselected by now.)
      }
    }

    // Single helper for "attach the mask to layer X" so create and update
    // paths share it. Builds the appropriate mask (palette × selection)
    // and attaches via imaging.putLayerMask.
    const attachMaskIfRequested = async (layerId: number) => {
      if (!wantAnyMask || !targetBuf) return;
      const px = targetBuf.width * targetBuf.height;
      // Start from the target-palette mask if active, otherwise a full mask.
      let mask: Uint8Array;
      if (wantPaletteMask && params.targetPalette) {
        mask = buildTargetPaletteMaskBytes(targetBuf, params.targetPalette);
      } else {
        mask = fullMask(px);
      }
      // Compose with selection if active.
      if (selectionMaskBytes && selectionMode !== "off") {
        mask = composeWithSelection(mask, selectionMaskBytes, selectionMode);
      }
      try {
        await attachLayerMask(doc.id, layerId, mask, targetBuf.width, targetBuf.height, targetBuf.bounds);
      } catch { /* non-fatal */ }
    };

    // ─── Update-in-place path (Live LUT) ───────────────────────────────────
    if (params.updateExistingLayerId != null) {
      const existing = findLayerById(doc.layers ?? [], params.updateExistingLayerId);
      if (existing) {
        try {
          await action.batchPlay([{
            _obj: "select",
            _target: [{ _ref: "layer", _id: existing.id }],
            makeVisible: false,
          }], {});
        } catch { /* ignore */ }
        const { ok, lastErr } = await tryLoadLutIntoActiveLayer(cubeText, fileName, effectiveCurves, params.preset, size, 1 /* already lerped */, dither);
        if (!ok) throw new Error(`Live LUT update failed: ${lastErr?.message ?? lastErr ?? "unknown"}`);
        try { existing.name = layerName; } catch { /* ignore */ }
        // Refresh the mask too — weights may have changed between commits.
        await attachMaskIfRequested(existing.id);
        // Re-stamp the XMP — preset/palette weights may have moved since the
        // layer was first authored, so Restore should pick up the latest.
        if (params.xmpState) {
          try { await writeLutLayerState(existing.id, params.xmpState); }
          catch { /* non-fatal */ }
        }
        return { layerName, layerId: existing.id };
      }
    }

    // ─── Create path ──────────────────────────────────────────────────────
    const group = await getOrCreateColorSmashGroup(doc);
    if (params.overwritePrior !== false) {
      const prior: any[] = [];
      collectMatches(group, LUT_LAYER_PREFIX, prior);
      for (const p of prior) {
        try { await p.delete(); } catch { /* ignore */ }
      }
    }

    // Select the target layer so the new adjustment lands above it.
    if (params.targetLayerId != null) {
      try {
        await action.batchPlay([{
          _obj: "select",
          _target: [{ _ref: "layer", _id: params.targetLayerId }],
          makeVisible: false,
        }], {});
      } catch { /* ignore */ }
    }

    // Step 1: make the empty (identity) Color Lookup layer.
    const makeResult = await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        type: { _obj: "colorLookup" },
      },
    }], {});
    if (!makeResult || !makeResult[0] || makeResult[0].error) {
      throw new Error(`make adjustmentLayer (colorLookup) failed: ${makeResult?.[0]?.error ?? "unknown"}`);
    }

    // Step 2: load the 3D LUT into the new layer.
    const { ok, lastErr } = await tryLoadLutIntoActiveLayer(cubeText, fileName, params.curves, params.preset);
    if (!ok) {
      try {
        const stray = doc.activeLayers?.[0];
        if (stray && typeof stray.delete === "function") await stray.delete();
      } catch { /* ignore */ }
      throw new Error(`Could not load 3D LUT into Color Lookup layer: ${lastErr?.message ?? lastErr ?? "unknown"}`);
    }

    // Step 3: clip to the target layer (skipped for merged target — clipping
    // would do nothing since there's no specific layer underneath).
    const newLayer = doc.activeLayers?.[0] ?? doc.layers?.[0];
    if (newLayer && params.targetLayerId != null && !params.targetIsMerged) {
      try { await setClippingMask(newLayer, true); } catch { /* ignore */ }
    }

    // Rename + move into the group, capture id, attach mask if needed.
    let newLayerId: number | null = null;
    if (newLayer) {
      try { newLayer.name = layerName; } catch { /* ignore */ }
      try { await newLayer.move(group, "placeInside"); } catch { /* ignore */ }
      try { newLayerId = newLayer.id; } catch { /* ignore */ }
      if (newLayerId != null) await attachMaskIfRequested(newLayerId);
      if (newLayerId != null && params.xmpState) {
        try { await writeLutLayerState(newLayerId, params.xmpState); }
        catch { /* non-fatal */ }
      }
    }

    return { layerName, layerId: newLayerId };
  });
}

// ─── Multi-zone LUT ─────────────────────────────────────────────────────────
// When the user has Multi on + outputMode = LUT, emit 3 stacked Color Lookup
// adjustment layers in a sub-group, each carrying one band's LUT (shadow /
// mid / highlight) and the band's triangular luma weight mask. Mirrors the
// Curves multi-zone structure but with LUT layers instead of Curves layers.
// Target-palette mask, if active, attaches to the sub-group itself.
//
// Reuses multiZoneCommon helpers shared with applyMatch's Curves multi-zone
// branch so the band-mask math stays in lockstep across both output modes.

import {
  clampBandRange, readCompositeForBands, buildLumaBandMasks,
} from "./multiZoneCommon";

export async function applyMultiZoneLutAsLayers(
  params: ApplyMultiZoneLutParams,
): Promise<ApplyLutResult> {
  const size = params.gridSize ?? params.size ?? 33;
  const strength = Math.max(0, Math.min(1, params.strength ?? 1));
  const dither = params.dither ?? true;
  const presetTag = params.preset === "color" ? "full"
                  : params.preset === "hue" ? "color"
                  : params.preset === "hueOnly" ? "hue"
                  : params.preset === "saturationOnly" ? "saturation"
                  : "contrast";

  // (presetBlend used to be set here per band, but LUT-mode bakes preset math
  // into the LUT bytes themselves via applyPresetPostprocess in generateLutCube —
  // setting a layer blendMode would double-apply. Curves multi-zone in
  // applyMatch.ts handles preset blend modes because Curves CAN'T represent
  // non-separable math without them.)

  // Pre-generate cube + ICC for each band on the worker side so we don't sit
  // inside the modal scope doing CPU work. Each is ~200KB so the three combined
  // are ~600KB of base64 — well within batchPlay limits.
  const bandsData = (["shadow", "mid", "highlight"] as const).map(key => {
    const rawBandCurves = params.multiZoneFit[key];
    // Per-band strength lerp (same scale across all three bands so the
    // multi-zone composite still aggregates to the user's intended dial).
    const curves = strength >= 1 ? rawBandCurves : lerpCurvesTowardIdentity(rawBandCurves, strength);
    const cubeText = generateLutCube(curves, params.preset, size, `Color Smash ${key}`);
    const cubeB64 = cubeToBase64(cubeText);
    const profileB64 = generateIccDeviceLinkBase64(curves, params.preset, size, 1 /* already lerped */);
    return { key, cubeText, cubeB64, profileB64 };
  });

  // Sub-group mask composition: target-palette mask × selection mask (focus
  // or exclude). Same flags as single-LUT, just attached to the sub-group
  // instead of a single layer.
  const selectionMode = params.selectionMode ?? "off";
  const wantPaletteMask = !!(
    params.targetPalette
    && !params.targetIsMerged
    && params.targetLayerId != null
    && targetWeightsActive(params.targetPalette)
  );
  const wantSelectionMask = selectionMode !== "off" && !params.targetIsMerged && params.targetLayerId != null;
  const wantSubGroupMask = wantPaletteMask || wantSelectionMask;

  return await executeAsModal("Color Smash apply multi-zone LUT", async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No active document.");

    // 1. Find or create [Color Smash] group + clean up any prior Match LUT.
    const group = await getOrCreateColorSmashGroup(doc);
    if (params.overwritePrior !== false) {
      const prior: any[] = [];
      collectMatches(group, LUT_LAYER_PREFIX, prior);
      for (const p of prior) {
        try { await p.delete(); } catch { /* ignore */ }
      }
    }

    // 2. Determine target layer + select it so new layers stack above.
    const targetLayer = params.targetLayerId != null
      ? findLayerById(doc.layers ?? [], params.targetLayerId)
      : null;
    if (targetLayer) {
      try {
        await action.batchPlay([{
          _obj: "select",
          _target: [{ _ref: "layer", _id: targetLayer.id }],
          makeVisible: false,
        }], {});
      } catch { /* ignore */ }
    }

    // 3. Read the target composite for band masks + palette mask.
    //    readCompositeForBands reads the FULL document composite (matches
    //    applyMatch's Curves multi-zone path). All masks we build live in
    //    that composite coordinate system, so putLayerMask must use the
    //    composite's full extent as targetBounds — using the target layer's
    //    smaller bounds here would tell PS to squeeze a doc-sized mask into
    //    a layer-sized rect, producing an askew/cropped result.
    const { composite, dispose } = await readCompositeForBands(doc.id, undefined);
    const compositeBounds = {
      left: 0, top: 0,
      right: composite.width, bottom: composite.height,
    };
    try {
      // 4. Adjusted peaks + extents + the 3 band triangle masks.
      const range = clampBandRange(
        params.multiZonePeaks ?? { shadow: 0, mid: 128, highlight: 255 },
        params.multiZoneExtents ?? { min: 0, max: 255 },
      );
      const bandMasks = buildLumaBandMasks(composite, range);

      // 5. Create the sub-group that will house the 3 band layers + carry the
      //    optional target-palette mask. Names match Curves multi-zone:
      //    sub-group "Match LUT" (timestamped if not overwriting) containing
      //    "Match LUT [Shadows]", "Match LUT [Mids]", "Match LUT [Highlights]".
      try {
        await action.batchPlay([{ _obj: "selectNoLayers",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
      } catch { /* ignore */ }
      const subName = params.overwritePrior !== false
        ? LUT_LAYER_PREFIX
        : `${LUT_LAYER_PREFIX} ${new Date().toTimeString().slice(0, 8)}`;
      const bandContainer = await doc.createLayerGroup({ name: subName });
      try { await bandContainer.move(group, "placeInside"); } catch { /* ignore */ }

      // 6. For each band: make Color Lookup → load LUT → attach band mask →
      //    set blend mode → move into sub-group.
      const bandSpecs = [
        { key: "shadow"    as const, suffix: "Shadows",   mask: bandMasks.shadow },
        { key: "mid"       as const, suffix: "Mids",      mask: bandMasks.mid },
        { key: "highlight" as const, suffix: "Highlights", mask: bandMasks.highlight },
      ];
      const bandLayerIds: number[] = [];

      for (const { key, suffix, mask } of bandSpecs) {
        const layerName = `${LUT_LAYER_PREFIX} [${suffix}]`;
        const data = bandsData.find(b => b.key === key)!;

        // 6a. Make empty Color Lookup layer.
        const makeResult = await action.batchPlay([{
          _obj: "make",
          _target: [{ _ref: "adjustmentLayer" }],
          using: {
            _obj: "adjustmentLayer",
            type: { _obj: "colorLookup" },
          },
        }], {});
        if (!makeResult || !makeResult[0] || makeResult[0].error) {
          throw new Error(`make adjustmentLayer (${suffix}) failed: ${makeResult?.[0]?.error ?? "unknown"}`);
        }

        // 6b. Load the LUT — same { _data, _rawData } wrapper format
        //     single-LUT uses, plus the ICC profile for actual rendering.
        const setDesc = {
          _obj: "set",
          _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
          to: {
            _obj: "colorLookup",
            lookupType: { _enum: "colorLookupType", _value: "3DLUT" },
            LUT3DFileData: { _data: data.cubeB64, _rawData: "base64" },
            LUTFormat: { _enum: "LUTFormatType", _value: "LUTFormatCUBE" },
            LUT3DFileName: `colorsmash_${presetTag}_${key}.cube`,
            name: `colorsmash_${presetTag}_${key}.cube`,
            profile: { _data: data.profileB64, _rawData: "base64" },
            dither,
          },
        };
        const loadRes = await action.batchPlay([setDesc as any], {});
        if (!loadRes || !loadRes[0] || loadRes[0].error) {
          throw new Error(`LUT load (${suffix}) failed: ${loadRes?.[0]?.error ?? "unknown"}`);
        }

        // 6c. The new layer is the active layer. Capture it + rename.
        const bandLayer = doc.activeLayers?.[0] ?? doc.layers?.[0];
        if (!bandLayer) continue;
        try { bandLayer.name = layerName; } catch { /* ignore */ }

        // 6d. Blend mode stays Normal in LUT mode. The preset's blend math
        //     (Color / Hue / Saturation / Luminosity) was baked into the
        //     LUT bytes by generateLutCube → applyPresetPostprocess. Setting
        //     the layer's blendMode here would double-apply the effect.
        //     Curves mode is the inverse: blend mode does the work because
        //     Curves can't represent non-separable transforms.

        // 6e. Attach the band luma mask. Done BEFORE moving into the sub-group
        //     because mask attachment can fail on a freshly-moved layer in some
        //     PS versions (race on layer DB state). targetBounds uses the
        //     composite's full extent — the mask buffer is doc-sized.
        try {
          const { imaging } = require("photoshop");
          const maskImageData = await imaging.createImageDataFromBuffer(mask, {
            width: composite.width, height: composite.height, components: 1,
            chunky: true, colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
          });
          await imaging.putLayerMask({
            documentID: doc.id,
            layerID: bandLayer.id,
            imageData: maskImageData,
            targetBounds: compositeBounds,
            replace: true,
          });
          if (maskImageData.dispose) maskImageData.dispose();
        } catch { /* non-fatal: layer still applies LUT, just unmasked */ }

        // 6f. Move into the sub-group. Layer stays selected so the next make
        //     stacks above it within the group.
        try { await bandLayer.move(bandContainer, "placeInside"); } catch { /* ignore */ }
        try { bandLayerIds.push(bandLayer.id); } catch { /* ignore */ }
      }

      // 7. Attach target-palette mask to the sub-group itself if requested.
      //    Same composite-bounds note as the band masks above: the mask
      //    buffer is doc-sized, so its targetBounds must be the composite's
      //    full extent, NOT the (possibly smaller) target layer's bounds.
      if (wantSubGroupMask && bandContainer?.id != null) {
        try {
          const t = {
            data: composite.data, width: composite.width, height: composite.height,
            bounds: compositeBounds,
          };
          const px = t.width * t.height;
          // Build the base mask: target-palette cluster mask if active,
          // otherwise a full-intensity (255) array so selection mode alone
          // can still mask the sub-group.
          let mask = (wantPaletteMask && params.targetPalette)
            ? buildTargetPaletteMaskBytes(t, params.targetPalette)
            : fullMask(px);
          // Compose with selection if active. Selection mask is read at
          // composite bounds so the byte arrays align.
          if (wantSelectionMask) {
            const sel = await readSelectionMaskBytes(doc.id, compositeBounds);
            if (sel) mask = composeWithSelection(mask, sel, selectionMode);
          }
          await attachLayerMask(doc.id, bandContainer.id, mask, t.width, t.height, t.bounds);
        } catch { /* non-fatal */ }
      }

      // 8. Clip the sub-group to the target so the multi-zone trio only
      //    affects the target layer (matches Curves multi-zone behavior).
      if (targetLayer && !params.targetIsMerged && bandContainer) {
        try { await setClippingMask(bandContainer, true); } catch { /* ignore */ }
      }

      // 9. XMP fingerprint on the first band layer (consumed by RESTORE on
      //    any layer in the sub-group via shared prefix). For simplicity we
      //    only stamp the topmost — Restore reads from whatever's active.
      if (params.xmpState && bandLayerIds.length > 0) {
        try { await writeLutLayerState(bandLayerIds[0], params.xmpState); }
        catch { /* non-fatal */ }
      }

      return { layerName: subName, layerId: bandContainer.id ?? null };
    } finally {
      try { dispose(); } catch { /* ignore */ }
    }
  });
}
