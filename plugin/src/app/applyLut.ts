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

import { ChannelCurves, generateLutCube, Preset } from "../core/histogramMatch";
import { GROUP_NAME, action, app } from "../services/photoshop";
import { executeAsModal } from "../services/photoshop";

const LUT_LAYER_PREFIX = "Match LUT";

export interface ApplyLutParams {
  curves: ChannelCurves;
  preset: Preset;
  size?: number;        // default 33
  targetLayerId?: number | null; // if provided, clip the LUT layer to it
  overwritePrior?: boolean;      // delete prior 'Match LUT*' layers in [Color Smash] group
  /** If set, look for this existing Match LUT layer and update its LUT data
      in place instead of creating a new one. Used by Live LUT mode for
      continuous slider-driven updates without flickering / stack churn.
      If the layer no longer exists (deleted by user, doc switched, etc.) we
      fall back to creating a new one and the caller should update its ref. */
  updateExistingLayerId?: number | null;
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
 * Set the active adjustment layer to be a 3D LUT with cube data embedded
 * inline as base64. Mirrors the descriptor PS itself records when the user
 * loads a .cube via the menu — `LUT3DFileData` carries the payload, the
 * filename is just a cosmetic label shown in the layer properties panel.
 */
async function tryLoadLutIntoActiveLayer(
  cubeText: string, displayName: string,
): Promise<{ ok: boolean; lastErr: any }> {
  const b64 = cubeToBase64(cubeText);
  // Primary descriptor: LUT3DFileData + LUTFormat. Most PS versions accept
  // this shape — it's what Listener records for "Load 3D LUT" menu action.
  const primary = {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "colorLookup",
      lookupType: { _enum: "colorLookupType", _value: "lookup3DLUT" },
      lookup3DLUTName: displayName,
      LUT3DFileData: b64,
      LUTFormat: ".cube",
    },
  };
  // Variant: lower-case 'lut3DFileData' / no leading dot in format. Some PS
  // versions normalize differently — try both if primary fails.
  const variant1 = {
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "colorLookup",
      lookupType: { _enum: "colorLookupType", _value: "lookup3DLUT" },
      lookup3DLUTName: displayName,
      lut3DFileData: b64,
      LUTFormat: "cube",
    },
  };
  const attempts = [primary, variant1];
  let lastErr: any = null;
  for (const desc of attempts) {
    try {
      const result = await action.batchPlay([desc as any], {});
      if (result && result[0] && !result[0].error) return { ok: true, lastErr: null };
      lastErr = result?.[0]?.error;
    } catch (e) { lastErr = e; }
  }
  return { ok: false, lastErr };
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
  const uxp = require("uxp");
  const size = params.size ?? 33;

  // 1. Generate cube text (same generator the Export LUT button uses).
  const cubeText = generateLutCube(params.curves, params.preset, size, "Color Smash");

  // 2. Write to UXP plugin temp folder. Unique filename per call so PS reads
  //    fresh data each time — unique name avoids any caching of the previous
  //    LUT contents under the same path.
  const tempFolder = await uxp.storage.localFileSystem.getTemporaryFolder();
  const stamp = Date.now();
  const presetTag = params.preset === "color" ? "full"
                  : params.preset === "hue" ? "color"
                  : params.preset === "hueOnly" ? "hue"
                  : params.preset === "saturationOnly" ? "saturation"
                  : "contrast";
  const fileName = `colorsmash_${presetTag}_${stamp}.cube`;
  const file = await tempFolder.createFile(fileName, { overwrite: true });
  await file.write(cubeText, { format: uxp.storage.formats.utf8 });

  return await executeAsModal("Color Smash apply LUT", async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No active document.");

    const layerName = `${LUT_LAYER_PREFIX} [${presetTag}]`;

    // ─── Update-in-place path (Live LUT) ───────────────────────────────────
    // If a target layer ID was passed AND it still exists, just select it and
    // re-issue the same `set` descriptor — PS replaces the LUT data inside
    // the existing Color Lookup layer. No make, no move, no flicker, layer
    // identity preserved across many rapid updates.
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
        const { ok, lastErr } = await tryLoadLutIntoActiveLayer(cubeText, file.name);
        if (!ok) throw new Error(`Live LUT update failed: ${lastErr?.message ?? lastErr ?? "unknown"}`);
        // Keep the name in sync (preset may have changed since creation).
        try { existing.name = layerName; } catch { /* ignore */ }
        return { layerName, layerId: existing.id };
      }
      // Fall through to create path if the layer was deleted/missing —
      // caller will pick up the new id from the result.
    }

    // ─── Create path (Apply LUT button, or fallback from missing live layer) ──
    // Reuse / create [Color Smash] group; clean up prior Match LUT layers.
    const group = await getOrCreateColorSmashGroup(doc);
    if (params.overwritePrior !== false) {
      const prior: any[] = [];
      collectMatches(group, LUT_LAYER_PREFIX, prior);
      for (const p of prior) {
        try { await p.delete(); } catch { /* ignore */ }
      }
    }

    // If we have a target layer, select it so the new adjustment lands above it.
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
    const { ok, lastErr } = await tryLoadLutIntoActiveLayer(cubeText, file.name);
    if (!ok) {
      // Don't leave an identity layer behind.
      try {
        const stray = doc.activeLayers?.[0];
        if (stray && typeof stray.delete === "function") await stray.delete();
      } catch { /* ignore */ }
      throw new Error(`Could not load 3D LUT into Color Lookup layer: ${lastErr?.message ?? lastErr ?? "unknown"}`);
    }

    // Rename + move into the group, capture the layer id for caller (Live LUT).
    const newLayer = doc.activeLayers?.[0] ?? doc.layers?.[0];
    let newLayerId: number | null = null;
    if (newLayer) {
      try { newLayer.name = layerName; } catch { /* ignore */ }
      try { await newLayer.move(group, "placeInside"); } catch { /* ignore */ }
      try { newLayerId = newLayer.id; } catch { /* ignore */ }
    }

    return { layerName, layerId: newLayerId };
  });
}
