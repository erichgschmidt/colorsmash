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

import { ChannelCurves } from "../core/histogramMatch";

// Base64-encoded fixed chunks of the ICC profile, extracted from a real
// PS-exported reference. Imported as raw text so we can decode at runtime.
// The .txt files live next to this module; webpack inlines them via raw-loader
// at build time (configured below in the import statement form webpack picks
// up). If raw-loader isn't wired, fall back to embedding the strings inline.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ICC_PREFIX_B64 } from "./_iccTemplate";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ICC_SUFFIX_B64 } from "./_iccTemplate";

const GRID = 33;
const CLUT_SIZE = GRID * GRID * GRID * 3 * 2; // 215,622 bytes
const TOTAL_PROFILE_SIZE = 216008;

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
 * Build the CLUT bytes from per-channel curves. For each input grid point
 * (r, g, b) in 33³, look up the corresponding output value through each
 * channel's curve and pack as uint16-BE.
 *
 * Curves are 256-entry Uint8Array (0..255 → 0..255). We sample at the input
 * grid points (33 steps across 0..255) and scale to uint16 (0..65535).
 *
 * CLUT ordering per ICC mft2 spec: input channel that varies SLOWEST is
 * stored first. For RGB inputs that's R outermost, G middle, B innermost.
 * Within each entry, output channels are R, G, B in order.
 */
function buildClut(curves: ChannelCurves): Uint8Array {
  const out = new Uint8Array(CLUT_SIZE);
  let p = 0;
  for (let ri = 0; ri < GRID; ri++) {
    const rInput = Math.round((ri / (GRID - 1)) * 255);
    const rOut = curves.r[rInput];
    for (let gi = 0; gi < GRID; gi++) {
      const gInput = Math.round((gi / (GRID - 1)) * 255);
      const gOut = curves.g[gInput];
      for (let bi = 0; bi < GRID; bi++) {
        const bInput = Math.round((bi / (GRID - 1)) * 255);
        const bOut = curves.b[bInput];
        // Scale 8-bit (0..255) → 16-bit (0..65535). Pure mul by 257 ensures
        // 255 maps exactly to 65535 (vs a /255 × 65535 which has rounding).
        const r16 = rOut * 257;
        const g16 = gOut * 257;
        const b16 = bOut * 257;
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

/**
 * Generate an ICC DeviceLink profile from per-channel curves.
 * Returns the base64-encoded profile bytes ready to drop into a batchPlay
 * descriptor's `profile._data` field.
 */
export function generateIccDeviceLinkBase64(curves: ChannelCurves): string {
  const prefix = b64ToBytes(ICC_PREFIX_B64);
  const suffix = b64ToBytes(ICC_SUFFIX_B64);
  const clut = buildClut(curves);
  if (prefix.length + clut.length + suffix.length !== TOTAL_PROFILE_SIZE) {
    throw new Error(
      `ICC profile size mismatch: prefix=${prefix.length} + clut=${clut.length} ` +
      `+ suffix=${suffix.length} ≠ ${TOTAL_PROFILE_SIZE}`,
    );
  }
  const out = new Uint8Array(TOTAL_PROFILE_SIZE);
  out.set(prefix, 0);
  out.set(clut, prefix.length);
  out.set(suffix, prefix.length + clut.length);
  // Profile size field at offset 0 (uint32 BE).
  out[0] = (TOTAL_PROFILE_SIZE >> 24) & 0xff;
  out[1] = (TOTAL_PROFILE_SIZE >> 16) & 0xff;
  out[2] = (TOTAL_PROFILE_SIZE >> 8) & 0xff;
  out[3] = TOTAL_PROFILE_SIZE & 0xff;
  return bytesToB64(out);
}
