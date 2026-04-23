// Patch a working PS .atn template by replacing the LUT3DFileData chunk + paths.
// Bypasses our from-scratch writer (which can't produce a valid ICC profile blob).
// User records the action once (Color Lookup load); plugin patches that template per apply.

const TEMPLATE_FILENAME = "Load Color Smash LUT.ATN";

/**
 * Find the LUT3DFileData tdta chunk in the .atn bytes and replace its payload with newBytes.
 * Returns a new Uint8Array with the patched .atn.
 *
 * Locates the marker `LUT3DFileData` (length-prefixed PascalString: 4-byte length 13 + ASCII)
 * followed by `tdta` OSType, then a uint32 length, then the data.
 */
export function patchLutData(atn: Uint8Array, newBytes: Uint8Array): Uint8Array {
  const marker = "LUT3DFileData";
  const tdtaTag = "tdta";
  // Look for the length-prefix uint32(13) + marker bytes.
  const targetPattern = new Uint8Array(4 + marker.length);
  targetPattern[0] = 0; targetPattern[1] = 0; targetPattern[2] = 0; targetPattern[3] = marker.length;
  for (let i = 0; i < marker.length; i++) targetPattern[4 + i] = marker.charCodeAt(i);

  let idx = -1;
  for (let i = 0; i < atn.length - targetPattern.length; i++) {
    let match = true;
    for (let j = 0; j < targetPattern.length; j++) {
      if (atn[i + j] !== targetPattern[j]) { match = false; break; }
    }
    if (match) { idx = i; break; }
  }
  if (idx < 0) throw new Error("LUT3DFileData marker not found in template .atn");

  // After marker, expect "tdta" OSType (4 bytes), then uint32 length, then data.
  const tdtaOffset = idx + targetPattern.length;
  for (let i = 0; i < tdtaTag.length; i++) {
    if (atn[tdtaOffset + i] !== tdtaTag.charCodeAt(i)) {
      throw new Error(`Expected 'tdta' after LUT3DFileData marker at offset ${tdtaOffset}, found different bytes`);
    }
  }
  const lengthOffset = tdtaOffset + tdtaTag.length;
  const oldLength = (atn[lengthOffset] << 24) | (atn[lengthOffset + 1] << 16) | (atn[lengthOffset + 2] << 8) | atn[lengthOffset + 3];
  const dataOffset = lengthOffset + 4;

  // Build patched array: header (up to dataOffset) + new length + new data + tail (after old data).
  const tailOffset = dataOffset + oldLength;
  const newLength = newBytes.length;
  const out = new Uint8Array(dataOffset + 4 - 4 + newLength + (atn.length - tailOffset));
  // Copy header up to length field (exclusive)
  out.set(atn.subarray(0, lengthOffset), 0);
  // Write new length as uint32 BE
  out[lengthOffset]     = (newLength >>> 24) & 0xff;
  out[lengthOffset + 1] = (newLength >>> 16) & 0xff;
  out[lengthOffset + 2] = (newLength >>> 8) & 0xff;
  out[lengthOffset + 3] = newLength & 0xff;
  // Write new data
  out.set(newBytes, dataOffset);
  // Copy tail
  out.set(atn.subarray(tailOffset), dataOffset + newLength);
  return out;
}

/**
 * Read the template .atn from the plugin data folder. Throws if missing — user must record
 * the action manually first (one-time setup).
 */
export async function readTemplateAtn(): Promise<Uint8Array> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  let entry: any;
  try {
    entry = await dataFolder.getEntry(TEMPLATE_FILENAME);
  } catch {
    throw new Error(
      `Template "${TEMPLATE_FILENAME}" not found in plugin data folder. ` +
      `Record one once: Actions panel > new action "Load Color Smash LUT" in set "Color Smash" > ` +
      `record Layer > New Adjustment Layer > Color Lookup > Load 3D LUT (any .cube) > stop. ` +
      `Then save the action set as "${TEMPLATE_FILENAME}" via Actions panel flyout > Save Actions, ` +
      `placing it in the plugin data folder.`
    );
  }
  return new Uint8Array(await entry.read({ format: uxp.storage.formats.binary }));
}
