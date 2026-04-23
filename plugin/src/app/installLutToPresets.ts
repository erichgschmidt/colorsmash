// Write the generated .cube into PS's user 3DLUTs preset folder so it appears as a selectable
// preset in the Color Lookup adjustment layer dropdown. After PS restart, the LUT shows up
// alongside built-ins (Candlelight, Crisp_Warm, etc) and can be selected via batchPlay.

import {
  readLayerPixels, executeAsModal, getActiveDoc, statsRectForLayer,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT } from "../core/lutGenerator";
import { writeCubeLUT } from "../core/cubeWriter";

const STATS_MAX_EDGE = 512;
const LUT_SIZE = 33;

export interface InstallLutParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
  filename?: string;
}

function lutsFolderPaths(): string[] {
  const PS_VER = "Adobe Photoshop 2026";
  const isMac = (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? ""));
  if (isMac) {
    const home = process.env.HOME ?? "";
    return [`${home}/Library/Application Support/Adobe/${PS_VER}/Presets/3DLUTs`];
  }
  const appData = process.env.APPDATA ?? "";
  // User folder always works (per-user); install folder may need admin rights.
  return [`${appData}\\Adobe\\${PS_VER}\\Presets\\3DLUTs`];
}

const TOKEN_FILE = "luts-folder-token.json";

export async function resetLutFolder(): Promise<string> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  try {
    const entry = await dataFolder.getEntry(TOKEN_FILE);
    await entry.delete();
    return "Saved LUT folder cleared. Next install will prompt for a folder.";
  } catch {
    return "No saved LUT folder to clear.";
  }
}

export async function installLutToPresets(params: InstallLutParams): Promise<string> {
  return executeAsModal("Install LUT to PS Presets", async () => {
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

    const filename = params.filename ?? "ColorSmash.cube";
    const uxp = require("uxp");
    const fs = uxp.storage.localFileSystem;

    // Try a stored persistent token for the LUTs folder; prompt once otherwise.
    const dataFolder = await fs.getDataFolder();
    let folder: any = null;
    try {
      const tokenEntry = await dataFolder.getEntry(TOKEN_FILE);
      const tokenJson = await tokenEntry.read({ format: uxp.storage.formats.utf8 });
      const stored = JSON.parse(tokenJson)?.token;
      if (stored) folder = await fs.getEntryForPersistentToken(stored).catch(() => null);
    } catch { /* no token yet */ }

    if (!folder) {
      const expected = lutsFolderPaths()[0];
      folder = await fs.getFolder().catch(() => null);
      if (!folder) throw new Error(`Cancelled. Pick: ${expected}`);
      try {
        const token = await fs.createPersistentToken(folder);
        const tokenFile = await dataFolder.createFile(TOKEN_FILE, { overwrite: true });
        await tokenFile.write(JSON.stringify({ token, savedFolder: folder.nativePath ?? "" }), { format: uxp.storage.formats.utf8 });
      } catch { /* persistence optional */ }
    }

    let file: any;
    try { file = await folder.createFile(filename, { overwrite: true }); }
    catch { file = await folder.getEntry(filename); }
    await file.write(text, { format: uxp.storage.formats.utf8 });

    return `Wrote ${filename} (${(text.length / 1024).toFixed(0)} KB) to ${folder.nativePath}.\nRESTART Photoshop, then check the Color Lookup adjustment layer 3DLUT dropdown for "${filename.replace(/\.cube$/i, "")}". If it appears, the auto-install path works and we can wire up batchPlay selection by name.`;
  });
}
