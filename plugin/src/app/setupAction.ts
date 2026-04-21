// Prototype: programmatically create the "Load Color Smash LUT" action.
// We try several forms of injecting a "Load 3D LUT" step into a freshly-made action.
// If PS rejects all of them, we surface the error + fall back to guided manual setup.

import { executeAsModal, action as psAction } from "../services/photoshop";

const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";
const LUT_FILENAME = "color-smash-current.cube";

async function ensureLutFileExists(): Promise<string> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  // Tiny identity .cube so the path has real content.
  const text = [
    'TITLE "Color Smash Placeholder"',
    'LUT_3D_SIZE 2',
    '0 0 0', '1 0 0', '0 1 0', '1 1 0',
    '0 0 1', '1 0 1', '0 1 1', '1 1 1',
    '',
  ].join("\n");
  const file = await dataFolder.createFile(LUT_FILENAME, { overwrite: false }).catch(async () => {
    return await dataFolder.getEntry(LUT_FILENAME);
  });
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
    // Already exists? PS errors with "The command failed because the result is already in use."
    // We swallow and proceed.
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

// Try several descriptors to inject a "load LUT" step into the action. Returns the form that stuck.
async function tryInjectLoadStep(cubePath: string): Promise<string> {
  const attempts: { name: string; run: () => Promise<void> }[] = [
    {
      name: "A:make command in action",
      run: async () => {
        await psAction.batchPlay([{
          _obj: "make",
          _target: [
            { _ref: "command" },
            { _ref: "action", _name: ACTION_NAME },
            { _ref: "actionSet", _name: ACTION_SET },
          ],
          using: {
            _obj: "command",
            commandInfo: {
              _obj: "Lod3",
              _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
              using: { _path: cubePath },
            },
          },
        }], {});
      },
    },
    {
      name: "B:set action with recordedCommands",
      run: async () => {
        await psAction.batchPlay([{
          _obj: "set",
          _target: [
            { _ref: "action", _name: ACTION_NAME },
            { _ref: "actionSet", _name: ACTION_SET },
          ],
          to: {
            _obj: "action",
            recordedCommands: [
              {
                _obj: "Lod3",
                _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
                using: { _path: cubePath },
              },
            ],
          },
        }], {});
      },
    },
    {
      name: "C:start-stop record with direct play",
      run: async () => {
        // Some PS versions expose record start/stop via actionSelect + recordEvent.
        await psAction.batchPlay([
          { _obj: "select", _target: [{ _ref: "action", _name: ACTION_NAME }, { _ref: "actionSet", _name: ACTION_SET }] },
          { _obj: "start", _target: [{ _ref: "action", _enum: "ordinal", _value: "targetEnum" }] },
          { _obj: "Lod3", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }], using: { _path: cubePath } },
          { _obj: "stop", _target: [{ _ref: "action", _enum: "ordinal", _value: "targetEnum" }] },
        ], {});
      },
    },
  ];

  const errors: string[] = [];
  for (const a of attempts) {
    try {
      await a.run();
      return a.name;
    } catch (e: any) {
      errors.push(`${a.name}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`All injection forms failed.\n${errors.join("\n")}`);
}

export async function setupAction(): Promise<string> {
  return executeAsModal("Color Smash setup action", async () => {
    const cubePath = await ensureLutFileExists();
    await tryCreateActionSet(ACTION_SET);
    await tryCreateActionInSet(ACTION_SET, ACTION_NAME);
    try {
      const method = await tryInjectLoadStep(cubePath);
      return `Action created via ${method}. Path: ${cubePath}`;
    } catch (e: any) {
      return `Set/Action created, but step injection failed. Record manually: Actions panel → "${ACTION_SET}/${ACTION_NAME}" → red Record → Image > Adjustments > Color Lookup > Load 3D LUT > "${cubePath}" → Stop. Detail: ${e?.message ?? e}`;
    }
  });
}
