// Setup helper: create the Color Smash action set + named action programmatically, then surface
// clear instructions for the one manual recording step the user must do (Color Lookup's file
// picker is the only path PS will accept for loading a 3D LUT — token/path injection doesn't
// translate to a usable Lod3 step at play time).

import { executeAsModal, action as psAction } from "../services/photoshop";
import { installColorLookupAction } from "../services/installAction";

const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";
const LUT_FILENAME = "color-smash-current.cube";

async function ensureLutFileExists(): Promise<string> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  const text = [
    'TITLE "Color Smash Placeholder"',
    'LUT_3D_SIZE 2',
    '0 0 0', '1 0 0', '0 1 0', '1 1 0',
    '0 0 1', '1 0 1', '0 1 1', '1 1 1',
    '',
  ].join("\n");
  let file: any;
  try {
    file = await dataFolder.createFile(LUT_FILENAME, { overwrite: false });
  } catch {
    file = await dataFolder.getEntry(LUT_FILENAME);
  }
  try { await file.write(text, { format: uxp.storage.formats.utf8 }); } catch { /* ignore */ }
  return file.nativePath as string;
}

async function tryCreateActionSet(name: string): Promise<void> {
  try {
    await psAction.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "actionSet" }],
      using: { _obj: "actionSet", name },
    }], {});
  } catch (e: any) {
    if (!/already/i.test(e?.message ?? "")) throw e;
  }
}

async function tryCreateActionInSet(setName: string, actionName: string): Promise<void> {
  try {
    await psAction.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "action" }],
      using: { _obj: "action", name: actionName, parentName: setName },
    }], {});
  } catch (e: any) {
    if (!/already/i.test(e?.message ?? "")) throw e;
  }
}

export async function setupAction(): Promise<string> {
  return executeAsModal("Color Smash setup action", async () => {
    const cubePath = await ensureLutFileExists();
    await tryCreateActionSet(ACTION_SET);
    await tryCreateActionInSet(ACTION_SET, ACTION_NAME);

    return [
      `Set/Action created: "${ACTION_SET} → ${ACTION_NAME}".`,
      `LUT placeholder written to: ${cubePath}`,
      ``,
      `One manual step remaining (PS Color Lookup file load can't be scripted directly):`,
      `  1. Open Window → Actions.`,
      `  2. Find "${ACTION_SET}" → "${ACTION_NAME}".`,
      `  3. Click the red Record button at the bottom of the Actions panel.`,
      `  4. Layer → New Adjustment Layer → Color Lookup → OK.`,
      `  5. In the Properties panel, 3DLUT File → Load 3D LUT → navigate to the LUT path above and pick it.`,
      `  6. Click Stop (square) at the bottom of Actions panel.`,
      ``,
      `After recording, click "Apply LUT via Action" to use it. The plugin overwrites the same file each apply, so the recorded action keeps loading fresh content.`,
    ].join("\n");
  });
}

/**
 * Experimental: skip the manual recording step entirely by writing a
 * pre-built `.atn` file straight into PS's Presets/Actions folder. Depends on
 * `core/atnWriter.ts` being implemented (currently a scaffold).
 */
export async function setupActionAuto(): Promise<string> {
  return executeAsModal("Color Smash setup action (auto)", async () => {
    const cubePath = await ensureLutFileExists();
    try {
      const { written, needsReload } = await installColorLookupAction(cubePath);
      const reloadHint = needsReload
        ? "Restart Photoshop or use Actions panel > Load Actions to pick it up."
        : "PS should pick it up automatically.";
      return `Action auto-installed at ${written}. ${reloadHint}`;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/not ready|not implemented/i.test(msg)) {
        return "Auto-install pending atn writer — use manual setup for now.";
      }
      throw e;
    }
  });
}
