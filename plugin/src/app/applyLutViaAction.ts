// Transfer via Color Lookup layer using a pre-recorded PS Action.
// The user records an Action once that loads a .cube from a fixed path; the plugin overwrites
// that file each apply and replays the action to install the Color Lookup adjustment layer.
//
// Expected Action naming (case-sensitive, user-side setup):
//   Action set:   "Color Smash"
//   Action name:  "Load Color Smash LUT"
//   Action body:  Image > Adjustments > Color Lookup > Load 3D LUT > pick the path below
//
// Path the user must pick during recording:
//   [plugin data folder]/color-smash-current.cube
//
// The plugin writes there before each apply, then plays the action.

import { readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer, action as psAction } from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT } from "../core/lutGenerator";
import { writeCubeLUT } from "../core/cubeWriter";

const STATS_MAX_EDGE = 512;
const LUT_SIZE = 33;
const LUT_FILENAME = "color-smash-current.cube";
const ACTION_SET = "Color Smash";
const ACTION_NAME = "Load Color Smash LUT";

export interface ApplyLutViaActionParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
}

export async function applyLutViaAction(params: ApplyLutViaActionParams): Promise<string> {
  // Stage 1: compute stats + generate LUT + write to fixed path.
  const cubePath = await executeAsModal("Color Smash write LUT", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    const srcStats = computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data);
    const tgtStats = computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data);
    const lut = generateReinhardLUT(LUT_SIZE, srcStats, tgtStats, params.weights);
    const text = writeCubeLUT(lut, "Color Smash");

    const uxp = require("uxp");
    const fs = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();
    const file = await dataFolder.createFile(LUT_FILENAME, { overwrite: true });
    await file.write(text, { format: uxp.storage.formats.utf8 });
    return file.nativePath as string;
  });

  // Stage 2: play the recorded action to load the LUT.
  return executeAsModal("Color Smash play action", async () => {
    try {
      await psAction.batchPlay([{
        _obj: "play",
        _target: [
          { _ref: "action", _name: ACTION_NAME },
          { _ref: "actionSet", _name: ACTION_SET },
        ],
      }], {});
      return `LUT installed via Action. Wrote: ${cubePath}`;
    } catch (e: any) {
      return `Action play failed — is an Action named "${ACTION_NAME}" inside set "${ACTION_SET}" installed? Record one that does Image → Adjustments → Color Lookup → Load 3D LUT from ${cubePath}. Error: ${e?.message ?? e}`;
    }
  });
}
