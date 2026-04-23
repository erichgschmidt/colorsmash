// Transfer via Color Lookup layer using a recorded PS Action.
// Each apply: generate fresh cube → rebuild the .atn with embedded fresh bytes → reinstall the
// action → create the layer → play the action. The .atn embeds LUT3DFileData (PS uses the
// embedded bytes, not the file path), so it MUST be regenerated each time.

import {
  readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
  action as psAction,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT } from "../core/lutGenerator";
import { writeCubeLUT } from "../core/cubeWriter";
import { writeColorLookupLoadAtn } from "../core/atnWriter";
import { patchLutData, readTemplateAtn } from "../services/patchTemplateAtn";

const STATS_MAX_EDGE = 512;
const LUT_SIZE = 33;
const LUT_FILENAME = "color-smash-current.cube";
const ATN_FILENAME = "color-smash.atn";
const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";

export interface ApplyLutViaActionParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

export async function applyLutViaAction(params: ApplyLutViaActionParams): Promise<string> {
  return executeAsModal("Color Smash apply LUT (action)", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");

    // 1. Compute LUT.
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    const srcStats = computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data);
    const tgtStats = computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data);
    const lut = generateReinhardLUT(LUT_SIZE, srcStats, tgtStats, params.weights);
    const cubeText = writeCubeLUT(lut, "Color Smash");
    const cubeBytes = stringToUtf8Bytes(cubeText);

    // 2. Write the .cube to plugin data folder (path used by LUT3DFileName for display).
    const uxp = require("uxp");
    const fs = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();
    const cubeFile = await dataFolder.createFile(LUT_FILENAME, { overwrite: true });
    await cubeFile.write(cubeText, { format: uxp.storage.formats.utf8 });

    // 3. Patch user's working template .atn with fresh cube bytes (writer can't produce a
    //    valid ICC profile blob, so we use the template's profile + replace only LUT3DFileData).
    let atnBytes: Uint8Array;
    try {
      const template = await readTemplateAtn();
      atnBytes = patchLutData(template, cubeBytes);
    } catch (e: any) {
      // Fallback to from-scratch writer (currently produces a .atn PS won't fully apply).
      console.warn("Template patch failed, falling back to scratch writer:", e?.message);
      atnBytes = writeColorLookupLoadAtn({
        setName: ACTION_SET,
        actionName: ACTION_NAME,
        cubePath: cubeFile.nativePath,
        cubeBytes,
        targetLayerName: "ColorSmashLUT_active",
      });
    }
    const atnFile = await dataFolder.createFile(ATN_FILENAME, { overwrite: true });
    await atnFile.write(atnBytes, { format: uxp.storage.formats.binary });

    // 4. Replace the action set in PS with the freshly-built one.
    try { await psAction.batchPlay([{ _obj: "delete", _target: [{ _ref: "actionSet", _name: ACTION_SET }] }], {}); }
    catch { /* set didn't exist */ }
    const atnToken = fs.createSessionToken(atnFile);
    await psAction.batchPlay([{ _obj: "open", null: { _path: atnToken } }], {});

    // 5. Remove any prior ColorSmashLUT_active layer so we don't accumulate duplicates.
    const TARGET_LAYER_NAME = "ColorSmashLUT_active";
    for (const l of [...doc.layers]) {
      if (l.name === TARGET_LAYER_NAME) {
        try { await l.delete(); } catch { /* ignore */ }
      }
    }
    try {
      await psAction.batchPlay([{
        _obj: "make",
        _target: [{ _ref: "adjustmentLayer" }],
        using: { _obj: "adjustmentLayer", type: { _class: "colorLookup" } },
      }], {});
    } catch (e: any) {
      return `Failed to create Color Lookup layer. ${e?.message ?? e}`;
    }

    const activeLayer = doc.activeLayers?.[0];
    const newLayerId = activeLayer?.id ?? null;
    const newLayerKind = activeLayer?.kind ?? "?";
    if (activeLayer) {
      try { activeLayer.name = TARGET_LAYER_NAME; } catch { /* ignore */ }
    }

    // 6. Play the action.
    try {
      await psAction.batchPlay([{
        _obj: "play",
        _target: [
          { _ref: "action", _name: ACTION_NAME },
          { _ref: "actionSet", _name: ACTION_SET },
        ],
      }], {});
      return `LUT installed: layer ${newLayerId} (${newLayerKind}) + Action set ${cubeBytes.length}-byte LUT.`;
    } catch (e: any) {
      return `Layer ${newLayerId} created, Action play failed. ${e?.message ?? e}`;
    }
  });
}

function stringToUtf8Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}
