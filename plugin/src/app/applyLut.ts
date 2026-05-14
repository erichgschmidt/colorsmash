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
  GROUP_NAME, action, app, setLayerColor, COLOR_SMASH_GROUP_COLOR, isColorSmashGroupName,
  executeAsModal, readLayerPixels, setClippingMask, PixelBuffer,
  readSelectionMaskBytes,
  deleteLayerMask, snapshotSelectionToChannel, restoreSelectionFromChannel, deleteChannel, deselectAll,
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

export interface ApplyLutResult {
  layerName: string;
  layerId: number | null;
}

/** Recursively collect every descendant whose name matches the prefix.
 *  v1.20.70 — also match the `Multi-${prefix}` inner bandContainer so
 *  multi→single rebakes don't leave the bandContainer + its 3 band
 *  layers orphaned in the [Color Smash] group. */
function collectMatches(parent: any, prefix: string, out: any[]) {
  const multiPrefix = `Multi-${prefix}`;
  for (const child of parent.layers ?? []) {
    const name = child.name;
    const isMatch = typeof name === "string" && (
      name === prefix || name.startsWith(prefix) ||
      name === multiPrefix || name.startsWith(multiPrefix)
    );
    if (isMatch) {
      if (child.layers) collectMatches(child, prefix, out);
      out.push(child);
    }
  }
}

/** Find or create the [Color Smash] group at the doc root.
 *  v1.20.69 — when creating fresh, clear the layer selection first
 *  via selectNoLayers so PS doesn't nest the new group inside whatever
 *  sub-group currently owns the active layer (e.g. after JUMP set the
 *  insertion point inside an existing group). */
async function getOrCreateColorSmashGroup(doc: any): Promise<any> {
  const findCS = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l && isColorSmashGroupName(l.name) && (l.kind === "group" || Array.isArray(l.layers))) return l;
      if (Array.isArray(l.layers)) { const found = findCS(l.layers); if (found) return found; }
    }
    return null;
  };
  const existing = findCS(doc.layers ?? []);
  if (existing) return existing;
  try {
    await action.batchPlay([{ _obj: "selectNoLayers", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
  } catch { /* not critical */ }
  const group = await doc.createLayerGroup({ name: GROUP_NAME });
  // v1.20.69 — orange color tag for visibility in PS Layers panel.
  try { if (group?.id != null) await setLayerColor(group.id, COLOR_SMASH_GROUP_COLOR); } catch { /* ignore */ }
  return group;
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
        } catch (e: any) {
          try { console.warn("[Color Smash] Target pixel read for mask failed:", e?.message ?? e); } catch { /* ignore */ }
        }
      }
      if (wantSelectionMask && targetBuf) {
        selectionMaskBytes = await readSelectionMaskBytes(doc.id, targetBuf.bounds);
        // Null means no marquee active or imaging API rejected — treat as
        // mode = off for this bake. (Don't surface as an error; the user
        // may have deselected by now.)
      }
    }

    // v1.20.35 — two mask attach helpers. Palette-ratio mask goes on the
    // inner adjustment layer; selection-shaped mask goes on the outer
    // sub-group. PS multiplies them at render time so the net visible
    // behavior is identical to the old composited single-mask version,
    // but each is independently editable.
    const attachPaletteMaskToLayer = async (layerId: number) => {
      if (!wantPaletteMask || !targetBuf || !params.targetPalette) return;
      const mask = buildTargetPaletteMaskBytes(targetBuf, params.targetPalette);
      try {
        await attachLayerMask(doc.id, layerId, mask, targetBuf.width, targetBuf.height, targetBuf.bounds);
      } catch { /* non-fatal */ }
    };
    const attachSelectionMaskToGroup = async (groupId: number) => {
      if (!wantSelectionMask || !targetBuf || !selectionMaskBytes) return;
      const px = targetBuf.width * targetBuf.height;
      let sel = selectionMaskBytes;
      if (sel.length !== px) {
        const padded = new Uint8Array(px);
        padded.set(sel.subarray(0, Math.min(sel.length, px)));
        sel = padded;
      }
      // Selection-only mask: focus → selection bytes, exclude → inverted.
      const mask = composeWithSelection(fullMask(px), sel, selectionMode);
      try {
        await attachLayerMask(doc.id, groupId, mask, targetBuf.width, targetBuf.height, targetBuf.bounds);
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
        // v1.20.35 — refresh both masks (palette on inner, selection on
        // parent sub-group). weights/selection may have changed since
        // the previous bake.
        await attachPaletteMaskToLayer(existing.id);
        try {
          const parentId = existing.parent?.id;
          if (typeof parentId === "number") await attachSelectionMaskToGroup(parentId);
        } catch { /* ignore */ }
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

    // v1.20.26 — snapshot the active marquee before the adjustment-layer
    // make. PS auto-applies any active selection as the new layer's mask,
    // which both consumes the selection (it's no longer visible) AND
    // produces a mask we don't want at the layer level. We restore the
    // selection after the layer + mask cleanup, so the user's marquee
    // survives the bake regardless of selectionMode.
    const selSnapshot = await snapshotSelectionToChannel();
    // v1.20.28 — deselect after the snapshot so PS doesn't auto-apply the
    // marquee as a layer/group mask during the bake. Restored at the end.
    if (selSnapshot) await deselectAll();

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

    // v1.20.24 — wrap the single adjustment layer in a sub-group inside
    // [Color Smash], mirroring the multi-zone structure. Mask attaches to
    // the SUB-GROUP (so palette + selection composition lives at the group
    // level, just like multi-zone's bandContainer). XMP is written to both
    // the inner layer (for Live LUT / Replace lookup) and the sub-group
    // (so AUTO restore works whether the user clicks the layer or its
    // containing group).
    let newLayerId: number | null = null;
    if (newLayer) {
      try { newLayer.name = layerName; } catch { /* ignore */ }
      try { newLayerId = newLayer.id; } catch { /* ignore */ }
      // v1.20.26 — strip the auto-applied selection-as-mask. We manage
      // masking explicitly at the sub-group level, so the inner layer's
      // PS-attached mask is always wrong.
      if (newLayerId != null) await deleteLayerMask(newLayerId);
      const subName = params.overwritePrior !== false
        ? layerName
        : `${layerName} ${new Date().toTimeString().slice(0, 8)}`;
      const subGroup = await doc.createLayerGroup({ name: subName });
      try { await subGroup.move(group, "placeInside"); } catch { /* ignore */ }
      try { await newLayer.move(subGroup, "placeInside"); } catch { /* ignore */ }
      // v1.20.35 — split masks: palette → inner adj layer, selection → sub-group.
      if (newLayerId != null) await attachPaletteMaskToLayer(newLayerId);
      if (subGroup?.id != null) await attachSelectionMaskToGroup(subGroup.id);
      if (params.xmpState) {
        if (newLayerId != null) {
          try { await writeLutLayerState(newLayerId, params.xmpState); } catch { /* non-fatal */ }
        }
        try { await writeLutLayerState(subGroup.id, params.xmpState); } catch { /* non-fatal */ }
      }
    }

    // v1.20.26 — restore the marquee that PS consumed during adjustment-
    // layer creation, then drop the temp alpha channel we used to ferry it.
    if (selSnapshot) {
      await restoreSelectionFromChannel(selSnapshot);
      await deleteChannel(selSnapshot);
    }

    return { layerName, layerId: newLayerId };
  });
}

