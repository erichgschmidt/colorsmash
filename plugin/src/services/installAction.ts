// Installs the Color Smash Color-Lookup-load action by writing a generated .atn file into the
// plugin's own data folder, then asking PS to load it into the Actions panel via batchPlay.
// Avoids the Presets/Actions auto-load path because it stacks duplicates on every PS restart
// without giving us a clean way to overwrite.

import { writeColorLookupLoadAtn } from "../core/atnWriter";
import { action as psAction } from "./photoshop";

const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";
const ATN_FILENAME = "color-smash.atn";

async function deleteExistingSet(): Promise<void> {
  try {
    await psAction.batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "actionSet", _name: ACTION_SET }],
    }], {});
  } catch { /* set didn't exist; fine */ }
}

export async function installColorLookupAction(
  cubePath: string,
): Promise<{ written: string; needsReload: boolean }> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;

  // Read the cube bytes from the plugin's own data folder.
  let cubeBytes: Uint8Array;
  try {
    const dataFolder = await fs.getDataFolder();
    const cubeFilename = cubePath.split(/[\\/]/).pop() ?? "color-smash-current.cube";
    const cubeEntry = await dataFolder.getEntry(cubeFilename);
    cubeBytes = new Uint8Array(await cubeEntry.read({ format: uxp.storage.formats.binary }));
  } catch (e: any) {
    throw new Error(`Couldn't read cube bytes from ${cubePath}. ${e?.message ?? e?.code ?? String(e)}`);
  }

  // Generate the .atn bytes.
  let bytes: Uint8Array;
  try {
    bytes = writeColorLookupLoadAtn({
      setName: ACTION_SET,
      actionName: ACTION_NAME,
      cubePath,
      cubeBytes,
    });
  } catch (e: any) {
    throw new Error(`atn writer failed. ${e?.message ?? e?.code ?? String(e)}`);
  }

  // Write into plugin data folder (no permissions needed).
  let atnNativePath: string;
  let atnTokenForBatchPlay: string;
  try {
    const dataFolder = await fs.getDataFolder();
    const file = await dataFolder.createFile(ATN_FILENAME, { overwrite: true });
    await file.write(bytes, { format: uxp.storage.formats.binary });
    atnNativePath = file.nativePath;
    atnTokenForBatchPlay = fs.createSessionToken(file);
  } catch (e: any) {
    throw new Error(`Couldn't write ${ATN_FILENAME} to plugin data folder. ${e?.message ?? e?.code ?? String(e)}`);
  }

  // Drop any existing copy of the set, then load the freshly-written .atn into the Actions panel.
  await deleteExistingSet();
  const loadAttempts: { name: string; descriptor: any }[] = [
    { name: "open null:_path", descriptor: { _obj: "open", null: { _path: atnTokenForBatchPlay } } },
    { name: "make actionSet using:_path", descriptor: { _obj: "make", _target: [{ _ref: "actionSet" }], using: { _path: atnTokenForBatchPlay } } },
    { name: "open _target:[_path]", descriptor: { _obj: "open", _target: [{ _path: atnTokenForBatchPlay }] } },
  ];
  let lastErr: any = null;
  let usedMethod: string | null = null;
  for (const attempt of loadAttempts) {
    try {
      await psAction.batchPlay([attempt.descriptor], {});
      usedMethod = attempt.name;
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr && !usedMethod) {
    throw new Error(`Wrote ${atnNativePath} but all PS load forms failed. Last: ${(lastErr as any)?.message ?? lastErr}`);
  }

  return { written: `${atnNativePath} (loaded via ${usedMethod})`, needsReload: false };
}
