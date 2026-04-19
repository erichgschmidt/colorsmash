// Export the current Reinhard transfer as a .cube 3D LUT to a user-picked location.
// Once saved the user can load it via PS: Image > Adjustments > Color Lookup > 3DLUT File > Load.

import { readLayerPixels, getActiveDoc, executeAsModal, statsRectForLayer } from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT } from "../core/lutGenerator";
import { writeCubeLUT } from "../core/cubeWriter";

const STATS_MAX_EDGE = 512;

export interface ExportCubeParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
  size: number; // 17, 25, 33, 49, 65 typical
}

export async function exportCube(params: ExportCubeParams): Promise<string> {
  // 1) Read pixels and compute stats inside modal.
  const { srcStats, tgtStats } = await executeAsModal("Color Smash export LUT", async () => {
    const doc = getActiveDoc();
    const source = doc.layers.find((l: any) => l.id === params.sourceLayerId);
    const target = doc.layers.find((l: any) => l.id === params.targetLayerId);
    if (!source || !target) throw new Error("Picked layer no longer exists.");

    const [srcBuf, tgtBuf] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    return {
      srcStats: computeLabStats(downsampleToMaxEdge(srcBuf, STATS_MAX_EDGE).data),
      tgtStats: computeLabStats(downsampleToMaxEdge(tgtBuf, STATS_MAX_EDGE).data),
    };
  });

  // 2) Build LUT + cube text outside modal (pure compute).
  const lut = generateReinhardLUT(params.size, srcStats, tgtStats, params.weights);
  const text = writeCubeLUT(lut, "Color Smash");

  // 3) Save dialog. Uses uxp local file system; user picks destination.
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const file = await fs.getFileForSaving(`color-smash-${params.size}.cube`, { types: ["cube"] });
  if (!file) return "Export cancelled.";
  await file.write(text, { format: uxp.storage.formats.utf8 });
  return `Saved ${params.size}³ LUT (${(text.length / 1024).toFixed(1)} KB)`;
}
