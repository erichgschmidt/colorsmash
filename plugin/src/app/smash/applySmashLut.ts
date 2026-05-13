// Install a Smash-baked 3D LUT as a Color Lookup adjustment layer.
//
// Mirrors applyLut.ts's tryLoadLutIntoActiveLayer descriptor (LUT3DFileData +
// ICC profile, batchPlay-installed) — but builds the ICC CLUT directly from
// the Smash engine's Float32Array LUT instead of from ChannelCurves. The
// ICC prefix/suffix bytes are reused verbatim from _iccTemplate.ts (Adobe's
// 33³ reference profile, captured 2026-04). No mask attachment, group
// placement, or selection composition — those are Phase 2 polish.
//
// 33³ only for v0 — the ICC prefix template bakes the grid size in.

import { action, executeAsModal } from "../../services/photoshop";
import { ICC_PREFIX_B64, ICC_SUFFIX_B64 } from "../_iccTemplate";
import { bakeSmashLut, serializeSmashCube, type SmashEngineOutput } from "../../core/smash";

const APPLY_LAYER_NAME = "Smash LUT";
const SMASH_GRID = 33;

export interface ApplySmashLutResult {
  ok: boolean;
  layerName?: string;
  error?: string;
}

/** Decode base64 to bytes. atob is exposed in UXP's panel JS runtime. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/** Build the full ICC DeviceLink profile bytes for a Smash LUT. */
function buildSmashIccBase64(values: Float32Array, n: number): string {
  if (n !== SMASH_GRID) {
    throw new Error(`Smash Apply currently locked to ${SMASH_GRID}³; got ${n}.`);
  }
  const prefix = b64ToBytes(ICC_PREFIX_B64);
  const suffix = b64ToBytes(ICC_SUFFIX_B64);
  const clut = buildSmashClut(values, n);
  const total = prefix.length + clut.length + suffix.length;
  const buf = new Uint8Array(total);
  buf.set(prefix, 0);
  buf.set(clut, prefix.length);
  buf.set(suffix, prefix.length + clut.length);
  return bytesToB64(buf);
}

/** Install the Smash transform as a Color Lookup adjustment layer above the
 *  currently-active layer. No group placement, no mask, no clipping — those
 *  arrive in Phase 2. Returns ok=true with layerName on success. */
export async function applySmashLut(engine: SmashEngineOutput): Promise<ApplySmashLutResult> {
  try {
    const lut = bakeSmashLut(engine, SMASH_GRID);
    const cubeText = serializeSmashCube(lut, APPLY_LAYER_NAME);
    const cubeB64 = bytesToB64(asciiStringToBytes(cubeText));
    const profileB64 = buildSmashIccBase64(lut.values, SMASH_GRID);
    const stamp = Date.now();
    const displayName = `${APPLY_LAYER_NAME}_${stamp}.cube`;

    return await executeAsModal("Color Smash apply LUT", async () => {
      // Step 1: create the empty (identity) Color Lookup adjustment layer.
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

      // Step 2: load the 3D LUT data + ICC profile into the new layer via batchPlay.
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

      return { ok: true, layerName: APPLY_LAYER_NAME };
    });
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
