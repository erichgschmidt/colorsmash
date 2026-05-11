// ICC DeviceLink profile generator for Color Lookup adjustment layers.
//
// Background: PS's Color Lookup adjustment layer expects an ICC DeviceLink
// profile in its `profile` descriptor field for rendering. Without a valid
// profile the layer holds the LUT data but applies no visual transform.
// LUT3DFileData (raw cube bytes) alone isn't enough — PS only auto-parses
// cube→profile when loading via the menu, not via batchPlay `set`.
//
// We bypass PS's reader entirely by generating the ICC profile from scratch
// using a template extracted (one-time) from a known-good PS-exported ICC.
// The structure is:
//
//   PREFIX (372 bytes, fixed):
//     • ICC header (128 bytes — total size, CMM=ADBE, class=link, RGB→RGB)
//     • Tag table (3 tags: desc, pseq, A2B0)
//     • 'desc' tag (file description, 126 bytes — fixed string)
//     • 'pseq' tag (profile sequence, 12 bytes — empty)
//     • 'A2B0' mft2 header (52 bytes — 3 in, 3 out, 33 grid, identity matrix)
//     • Input tables (12 bytes — 2-entry linear [0..65535] per channel)
//
//   CLUT (215,622 bytes, variable):
//     33³ × 3 × uint16-BE. R outermost, B innermost. Filled from our curves.
//
//   SUFFIX (14 bytes, fixed):
//     Output tables (12 bytes — 2-entry linear identity) + 2 padding bytes.
//
// The total profile is always 372 + 215,622 + 14 = 216,008 bytes for a
// 33³ grid. We override the profile size field at offset 0 to match if
// it ever needs to change.

import { ChannelCurves, Preset, applyPresetPostprocess, averageChannelCurves, lerpCurvesTowardIdentity } from "../core/histogramMatch";

// Base64-encoded fixed chunks of the ICC profile, extracted from a real
// PS-exported reference. Imported as raw text so we can decode at runtime.
// The .txt files live next to this module; webpack inlines them via raw-loader
// at build time (configured below in the import statement form webpack picks
// up). If raw-loader isn't wired, fall back to embedding the strings inline.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ICC_PREFIX_B64 } from "./_iccTemplate";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ICC_SUFFIX_B64 } from "./_iccTemplate";

// Reference template was captured from a 33³ ICC export (215,622 byte CLUT,
// 216,008 byte total profile). For variable grid sizes we keep the same
// prefix + suffix layout — only three field-level patches differ between
// grids: total profile size, A2B0 tag length, and the grid byte inside the
// mft2 header. Offsets below pinpoint those.
//
// Byte offsets for the three grid-dependent field patches:
const PATCH_OFFSET_PROFILE_SIZE = 0;     // uint32 BE at file start
const PATCH_OFFSET_A2B0_LENGTH = 164;    // uint32 BE in tag table (A2B0 entry's length field)
const PATCH_OFFSET_GRID_BYTE = 0x13e;    // uint8 inside the mft2 header at A2B0+10
const A2B0_OVERHEAD = 52 + 12 + 12;      // mft2 header + input tables + output tables

/** Decode a base64 string to Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  // atob is available in UXP webview
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode Uint8Array to base64 string. */
function bytesToB64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack on large inputs.
  let latin1 = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    latin1 += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(latin1);
}

/**
 * Build the CLUT bytes from per-channel curves AND the preset's blend math.
 *
 * Each grid sample is:
 *   1. Pre-fold contrast preset's R=G=B luma curve (averageChannelCurves).
 *   2. Apply per-channel curves: orig → mapped.
 *   3. Run applyPresetPostprocess(orig, mapped, preset) to bake in any
 *      non-separable blend math (Color / Hue / Saturation / Luminosity).
 *   4. Scale 8-bit output to 16-bit BE.
 *
 * This is the same pipeline generateLutCube uses to write .cube text.
 * Keeping them in sync matters because PS renders from the ICC profile
 * (which buildClut produces), NOT from the cube text. v1.16.1 forgot the
 * preset step here, which caused all 5 presets to render identically in
 * LUT mode (only Full / "color" preset is a postprocess no-op).
 *
 * CLUT ordering per ICC mft2 spec: input channel that varies SLOWEST is
 * stored first. For RGB inputs that's R outermost, G middle, B innermost.
 * Within each entry, output channels are R, G, B in order.
 */
function buildClut(curves: ChannelCurves, preset: Preset, gridSize: number): Uint8Array {
  const N = gridSize;
  const out = new Uint8Array(N * N * N * 3 * 2);
  // Same contrast-collapse generateLutCube does: contrast preset uses one
  // luma curve replicated across R/G/B so there's no per-channel color shift.
  const finalCurves = preset === "contrast" ? averageChannelCurves(curves) : curves;
  const orig = new Uint8Array(4); orig[3] = 255;
  const mapped = new Uint8Array(4); mapped[3] = 255;
  let p = 0;
  for (let ri = 0; ri < N; ri++) {
    const rInput = Math.round((ri / (N - 1)) * 255);
    for (let gi = 0; gi < N; gi++) {
      const gInput = Math.round((gi / (N - 1)) * 255);
      for (let bi = 0; bi < N; bi++) {
        const bInput = Math.round((bi / (N - 1)) * 255);
        orig[0] = rInput; orig[1] = gInput; orig[2] = bInput;
        mapped[0] = finalCurves.r[rInput];
        mapped[1] = finalCurves.g[gInput];
        mapped[2] = finalCurves.b[bInput];
        const post = applyPresetPostprocess(orig, mapped, preset);
        // Scale 8-bit (0..255) → 16-bit (0..65535). Mul by 257 ensures
        // 255 maps exactly to 65535 (vs a /255 × 65535 which has rounding).
        const r16 = post[0] * 257;
        const g16 = post[1] * 257;
        const b16 = post[2] * 257;
        out[p++] = (r16 >> 8) & 0xff;
        out[p++] = r16 & 0xff;
        out[p++] = (g16 >> 8) & 0xff;
        out[p++] = g16 & 0xff;
        out[p++] = (b16 >> 8) & 0xff;
        out[p++] = b16 & 0xff;
      }
    }
  }
  return out;
}

/** Write a uint32 BE into a Uint8Array at the given offset. */
function writeUint32BE(buf: Uint8Array, off: number, v: number) {
  buf[off]     = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8)  & 0xff;
  buf[off + 3] = v          & 0xff;
}

/**
 * Generate an ICC DeviceLink profile from per-channel curves + active preset
 * + grid size + strength. Returns the base64-encoded profile bytes ready to
 * drop into a batchPlay descriptor's `profile._data` field.
 *
 * Grid size: 17 / 33 / 65 (any positive int works; PS handles arbitrary
 * grid sizes via the mft2 header byte). The same template prefix + suffix
 * is reused for all grids — we just patch three byte-level fields:
 *   - profile size (file size, offset 0, uint32 BE)
 *   - A2B0 tag length (in tag table, offset 164, uint32 BE)
 *   - grid byte (mft2 header, offset 0x13e, uint8)
 *
 * Strength: 0..1. Lerps the curves toward identity by (1 - strength) before
 * baking into the CLUT, so the exported .cube / Color Lookup profile
 * carries the dialed-back transform.
 *
 * Preset: same as before — non-separable blend math (Color / Hue / etc.)
 * gets folded into each CLUT sample via applyPresetPostprocess.
 */
export function generateIccDeviceLinkBase64(
  curves: ChannelCurves,
  preset: Preset = "color",
  gridSize: number = 33,
  strength: number = 1,
): string {
  if (gridSize < 2 || gridSize > 256) {
    throw new Error(`Invalid LUT grid size ${gridSize}; expected 2..256.`);
  }
  // Apply strength lerp ONCE up front — both buildClut and any future
  // postprocess in the profile will see the lerped curves.
  const effectiveCurves = strength >= 1 ? curves : lerpCurvesTowardIdentity(curves, strength);
  const prefix = b64ToBytes(ICC_PREFIX_B64); // 372 bytes — captured from 33³ reference
  const suffix = b64ToBytes(ICC_SUFFIX_B64); // 14 bytes — output tables + padding
  const clut = buildClut(effectiveCurves, preset, gridSize);
  const totalSize = prefix.length + clut.length + suffix.length;
  const a2b0Length = clut.length + A2B0_OVERHEAD; // mft2 + tables + CLUT
  const out = new Uint8Array(totalSize);
  out.set(prefix, 0);
  out.set(clut, prefix.length);
  out.set(suffix, prefix.length + clut.length);
  // Patch grid-dependent fields:
  writeUint32BE(out, PATCH_OFFSET_PROFILE_SIZE, totalSize);
  writeUint32BE(out, PATCH_OFFSET_A2B0_LENGTH, a2b0Length);
  out[PATCH_OFFSET_GRID_BYTE] = gridSize & 0xff;
  return bytesToB64(out);
}
