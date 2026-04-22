// Installs the Color Smash Color-Lookup-load action by writing a generated
// .atn file directly into Photoshop's Presets/Actions folder. Pairs with
// `core/atnWriter.ts` (binary writer, currently a scaffold).

import { writeColorLookupLoadAtn } from "../core/atnWriter";

const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";
const ATN_FILENAME = "Color Smash.atn";

/**
 * Best-effort lookup of the active PS install's `Presets/Actions` folder.
 * Tries UXP's pluginDataFolder-relative resolution first; falls back to the
 * platform-conventional location built off `APPDATA` (Windows) or `HOME`
 * (macOS).
 *
 * NOTE: this picks one PS version. Multi-install machines may need a
 * version-picker UI later.
 */
async function resolveActionsFolderPath(): Promise<string> {
  // PS version is hard-coded for now; once we have a way to query the host
  // PS version via UXP we'll swap this out.
  const PS_VERSION_DIR = "Adobe Photoshop 2026";

  if (process.platform === "darwin" || (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? ""))) {
    const home = process.env.HOME ?? "";
    return `${home}/Library/Application Support/Adobe/${PS_VERSION_DIR}/Presets/Actions`;
  }

  const appData = process.env.APPDATA ?? "";
  return `${appData}\\Adobe\\${PS_VERSION_DIR}\\Presets\\Actions`;
}

/**
 * Generates a `.atn` for the Color Lookup load action and drops it into
 * Photoshop's Presets/Actions folder.
 *
 * @param cubePath absolute path to the `.cube` file the recorded action will load.
 * @returns `{ written, needsReload }` — `written` is the absolute .atn path,
 *          `needsReload` indicates whether PS must be restarted (or the user
 *          must manually click Actions panel → Load Actions) before the new
 *          set appears. We assume `true` until we confirm PS auto-rescans
 *          the Presets/Actions folder.
 *
 * @throws if the writer scaffold hasn't been implemented yet — the error
 *         message points at `core/atnWriter.ts` so the caller knows where
 *         the gap is.
 */
export async function installColorLookupAction(
  cubePath: string,
): Promise<{ written: string; needsReload: boolean }> {
  let bytes: Uint8Array;
  try {
    bytes = writeColorLookupLoadAtn({
      setName: ACTION_SET,
      actionName: ACTION_NAME,
      cubePath,
    });
  } catch (e) {
    throw new Error(
      `installColorLookupAction: atn writer not ready (see plugin/src/core/atnWriter.ts). Underlying: ${(e as Error).message}`,
    );
  }

  const folderPath = await resolveActionsFolderPath();
  const fullPath = `${folderPath}${folderPath.includes("\\") ? "\\" : "/"}${ATN_FILENAME}`;

  // UXP fs write. Kept best-effort: if the host doesn't expose
  // localFileSystem.getEntryWithUrl for an arbitrary path, the writer will
  // throw and the caller will surface the error.
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const folder = await fs.getEntryWithUrl(`file:${folderPath.replace(/\\/g, "/")}`);
  let file: any;
  try {
    file = await folder.createFile(ATN_FILENAME, { overwrite: true });
  } catch {
    file = await folder.getEntry(ATN_FILENAME);
  }
  await file.write(bytes, { format: uxp.storage.formats.binary });

  return { written: fullPath, needsReload: true };
}
