// Transfer via Color Lookup layer: plugin does the heavy lifting, Action only loads the file.
//
// Pipeline:
//   1. Read source + target pixels, compute Reinhard stats.
//   2. Generate 33³ LUT, write to [plugin data folder]/color-smash-current.cube.
//   3. Create an empty Color Lookup adjustment layer via batchPlay.
//   4. Play the pre-recorded Action which contains just the Lod3 step — loads the LUT into
//      the freshly-created layer (which is targetEnum after the make call).
//
// One-time setup: Setup LUT Action button creates set/action and injects the Lod3 step.

import {
  readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
  action as psAction,
} from "../services/photoshop";
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
  return executeAsModal("Color Smash apply LUT (action)", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");

    // 1-2: stats + LUT + write file.
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

    // 3: create an empty Color Lookup adjustment layer (now the targetEnum).
    await psAction.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: { _obj: "adjustmentLayer", name: ACTION_NAME, type: { _obj: "colorLookup" } },
    }], {});

    // 4: play the recorded action — loads the LUT into the new Color Lookup layer via Lod3.
    try {
      await psAction.batchPlay([{
        _obj: "play",
        _target: [
          { _ref: "action", _name: ACTION_NAME },
          { _ref: "actionSet", _name: ACTION_SET },
        ],
      }], {});
      return `LUT installed via batchPlay (layer) + Action (Lod3 load).`;
    } catch (e: any) {
      return `Layer created, but Action play failed. Run "Setup LUT Action" first. Error: ${e?.message ?? e}`;
    }
  });
}
