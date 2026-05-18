// Install a Smash-baked 3D LUT as a Color Lookup adjustment layer.
//
// Mirrors applyLut.ts's tryLoadLutIntoActiveLayer descriptor (LUT3DFileData +
// ICC profile, batchPlay-installed). The ICC DeviceLink profile — which is
// what PS actually RENDERS from — is assembled by iccGen's shared
// assembleIccDeviceLink, the exact same prefix/CLUT/suffix wrapper +
// header-field patching the proven free Match path uses; only the CLUT bytes
// are Smash-specific (built from the engine's Float32Array LUT instead of
// from ChannelCurves). No mask attachment, group placement, or selection
// composition — those are Phase 2 polish.
//
// 33³ only for v0 — the ICC prefix template bakes the grid size in.

import { action, app, executeAsModal } from "../../services/photoshop";
import { assembleIccDeviceLink } from "../iccGen";
import { serializeSmashCube } from "../../core/smash";
import { bakeEngineLut, type SmashEngine } from "../../core/smash/engine";

const APPLY_LAYER_NAME = "Smash LUT";
const SMASH_GRID = 33;

export interface ApplySmashLutOptions {
  /** When set, update this existing Color Lookup layer's LUT data in place
   *  instead of creating a new layer. Default Apply uses this so repeated
   *  Apply clicks don't spam the Layers panel. If the layer no longer exists
   *  (user deleted it, doc switched), falls back to creating a new layer. */
  readonly replaceLayerId?: number | null;
  /** When provided, sets each id's visibility to false after the new layer
   *  is created. The "+" fork mode uses this to auto-hide prior Smash LUT
   *  variations so the most recent one shows alone but the older ones are
   *  preserved for A/B compare. */
  readonly hidePriorIds?: readonly number[];
}

export interface ApplySmashLutResult {
  ok: boolean;
  layerName?: string;
  /** The id of the layer that now holds the Smash LUT. Caller should track
   *  this so the next Apply can replace in place via replaceLayerId. */
  layerId?: number;
  /** True iff the apply was a successful in-place update (vs a fresh create).
   *  Just a diagnostic — callers don't need to act on it. */
  replacedInPlace?: boolean;
  error?: string;
}

function bytesToB64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

/** Encode a pure-ASCII string (.cube content) to bytes without TextEncoder.
 *  TextEncoder isn't reliably exposed in UXP across PS versions — applyLut.ts
 *  has the same defensive pattern. .cube text is ASCII-only (numbers, keywords,
 *  quotes around the title) so charCode-per-byte is exact. */
function asciiStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Build the ICC CLUT block from a Smash float LUT (Float32Array, N³ × 3,
 *  r-fastest .cube order). Output: N³ × 6 bytes (16-bit BE RGB per entry),
 *  iterated in ICC's r-slowest order. */
function buildSmashClut(values: Float32Array, n: number): Uint8Array {
  const out = new Uint8Array(n * n * n * 3 * 2);
  let p = 0;
  for (let ri = 0; ri < n; ri++) {
    for (let gi = 0; gi < n; gi++) {
      for (let bi = 0; bi < n; bi++) {
        // Smash order: r fastest, b slowest. Reverse-index back into the float buffer.
        const smashOff = (bi * n * n + gi * n + ri) * 3;
        const fr = Math.max(0, Math.min(1, values[smashOff] ?? 0));
        const fg = Math.max(0, Math.min(1, values[smashOff + 1] ?? 0));
        const fb = Math.max(0, Math.min(1, values[smashOff + 2] ?? 0));
        const u16r = Math.round(fr * 65535);
        const u16g = Math.round(fg * 65535);
        const u16b = Math.round(fb * 65535);
        out[p++] = (u16r >>> 8) & 0xff; out[p++] = u16r & 0xff;
        out[p++] = (u16g >>> 8) & 0xff; out[p++] = u16g & 0xff;
        out[p++] = (u16b >>> 8) & 0xff; out[p++] = u16b & 0xff;
      }
    }
  }
  return out;
}

/** Find a layer by id anywhere in the doc tree (top-level + inside groups). */
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

/** Install the Smash transform as a Color Lookup adjustment layer.
 *
 * Default behavior: if `options.replaceLayerId` points at an existing layer
 * in the active doc, load the new LUT data into that layer in place — no
 * flicker, no new layer added. Otherwise create a fresh Color Lookup layer
 * above the currently-active layer.
 *
 * `options.hidePriorIds` is honored after a successful apply (used by the
 * "+" fork mode to auto-hide prior Smash variations).
 */
export async function applySmashLut(
  engine: SmashEngine,
  options: ApplySmashLutOptions = {},
): Promise<ApplySmashLutResult> {
  try {
    const lut = bakeEngineLut(engine, SMASH_GRID);
    const cubeText = serializeSmashCube(lut, APPLY_LAYER_NAME);
    const cubeB64 = bytesToB64(asciiStringToBytes(cubeText));
    // Build the ICC DeviceLink profile that PS actually renders from. Routes
    // through iccGen's shared assembleIccDeviceLink — the SAME assembly +
    // header-field patching the proven free Match path uses — so the Smash
    // ICC can't drift from the working free one. (The previous hand-rolled
    // path skipped the size / A2B0-length / grid-byte patches, which made PS
    // reject the profile and apply nothing → the dull, untransformed look.)
    const profileB64 = assembleIccDeviceLink(buildSmashClut(lut.values, SMASH_GRID), SMASH_GRID);
    const stamp = Date.now();
    const displayName = `${APPLY_LAYER_NAME}_${stamp}.cube`;

    // Resolve whether the requested replace target still exists in the active
    // doc. If not, we'll fall through to the create-new path. This decision
    // happens OUTSIDE executeAsModal because we only need the DOM read.
    let willReplaceId: number | null = null;
    if (options.replaceLayerId != null) {
      try {
        const doc = app?.activeDocument;
        if (doc && Array.isArray(doc.layers)) {
          const found = findLayerById(doc.layers, options.replaceLayerId);
          if (found) willReplaceId = options.replaceLayerId;
        }
      } catch { /* fall through to create-new */ }
    }

    return await executeAsModal("Color Smash apply LUT", async () => {
      let targetLayerId: number | null = null;

      if (willReplaceId != null) {
        // Select the existing Smash LUT layer so the subsequent `set` descriptor
        // (which uses `targetEnum`) lands on it. Wrapped in try/catch in case
        // the layer was deleted between our DOM check and the modal entry.
        try {
          await action.batchPlay([{
            _obj: "select",
            _target: [{ _ref: "layer", _id: willReplaceId }],
            makeVisible: false,
          }], {});
          targetLayerId = willReplaceId;
        } catch (e: any) {
          // Layer vanished; fall through to create path below.
          targetLayerId = null;
        }
      }

      if (targetLayerId == null) {
        // Create-new path. Make an empty Color Lookup adjustment layer.
        const makeResult = await action.batchPlay([{
          _obj: "make",
          _target: [{ _ref: "adjustmentLayer" }],
          using: {
            _obj: "adjustmentLayer",
            type: { _obj: "colorLookup" },
          },
        }], {});
        if (!makeResult || !makeResult[0] || makeResult[0].error) {
          return {
            ok: false,
            error: `make adjustmentLayer (colorLookup) failed: ${makeResult?.[0]?.error ?? "unknown"}`,
          };
        }
        // After make, the new layer is the active layer — grab its id so we
        // can return it to the caller for future in-place updates.
        try {
          const doc = app?.activeDocument;
          const active = doc?.activeLayers?.[0];
          if (active && typeof active.id === "number") {
            targetLayerId = active.id;
          }
        } catch { /* */ }
      }

      // Step 2 (shared by both paths): load the 3D LUT data + ICC profile
      // into the now-selected layer via batchPlay.
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
          dither: true,
        },
      };
      const setResult = await action.batchPlay([setDesc as any], {});
      if (!setResult || !setResult[0] || setResult[0].error) {
        return {
          ok: false,
          error: `load 3D LUT into Color Lookup layer failed: ${setResult?.[0]?.error ?? "unknown"}`,
        };
      }

      // Hide prior Smash LUT layers (the "+" fork-mode auto-hide). Done after
      // the new layer is in place so the user's view doesn't briefly go to
      // "nothing visible." Each hide is independent; one failing doesn't
      // block the others.
      if (options.hidePriorIds && options.hidePriorIds.length > 0) {
        for (const id of options.hidePriorIds) {
          if (id === targetLayerId) continue; // don't hide the one we just landed on
          try {
            await action.batchPlay([{
              _obj: "hide",
              null: [{ _ref: "layer", _id: id }],
            }], {});
          } catch { /* layer may have been deleted by user; ignore */ }
        }
      }

      return {
        ok: true,
        layerName: APPLY_LAYER_NAME,
        layerId: targetLayerId ?? undefined,
        replacedInPlace: willReplaceId != null && willReplaceId === targetLayerId,
      };
    });
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
