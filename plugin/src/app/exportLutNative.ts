// Export LUT via PS's NATIVE Expr (charID) event, mirroring File > Export > Color Lookup Tables.
// Discovered from disassembling Adobe's ExportColorLookupTables.jsx — two native events:
//   - "3grd" renders an identity LUT grid into the active layer (key "grdP" = grid points)
//   - "Expr" with Usng={_obj:"lut "} writes .CUBE/.3DL/.CSP/.ICC to disk
//
// Flow: build temp doc → render identity grid → bake our LUT onto those pixels → Expr to file.
// Hypothesis: a .cube produced by Expr is "registered" by PS (vs a hand-written file dropped in
// the folder), so it should appear in the Color Lookup adjustment layer's 3DLUT dropdown.

import { app, action as psAction, core, imaging } from "photoshop";
import {
  readLayerPixels, getActiveDoc, statsRectForLayer,
} from "../services/photoshop";
import { computeLabStats, TransferWeights } from "../core/reinhard";
import { downsampleToMaxEdge } from "../core/downsample";
import { generateReinhardLUT, LUT3D } from "../core/lutGenerator";

const STATS_MAX_EDGE = 512;
const GRID_POINTS = 32;
const TOKEN_FILE = "lut-output-folder-token.json";

export interface ExportLutNativeParams {
  sourceLayerId: number;
  targetLayerId: number;
  weights: TransferWeights;
  filenameBase?: string;
}

function lutSampleTrilinear(lut: LUT3D, r01: number, g01: number, b01: number): [number, number, number] {
  const N = lut.size;
  const fr = r01 * (N - 1), fg = g01 * (N - 1), fb = b01 * (N - 1);
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, N - 1), g1 = Math.min(g0 + 1, N - 1), b1 = Math.min(b0 + 1, N - 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const idx = (ri: number, gi: number, bi: number) => (ri + gi * N + bi * N * N) * 3;
  const d = lut.data;
  const c000 = idx(r0, g0, b0), c100 = idx(r1, g0, b0);
  const c010 = idx(r0, g1, b0), c110 = idx(r1, g1, b0);
  const c001 = idx(r0, g0, b1), c101 = idx(r1, g0, b1);
  const c011 = idx(r0, g1, b1), c111 = idx(r1, g1, b1);
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const x00 = d[c000 + ch] * (1 - dr) + d[c100 + ch] * dr;
    const x10 = d[c010 + ch] * (1 - dr) + d[c110 + ch] * dr;
    const x01 = d[c001 + ch] * (1 - dr) + d[c101 + ch] * dr;
    const x11 = d[c011 + ch] * (1 - dr) + d[c111 + ch] * dr;
    const y0 = x00 * (1 - dg) + x10 * dg;
    const y1 = x01 * (1 - dg) + x11 * dg;
    out[ch] = y0 * (1 - db) + y1 * db;
  }
  return out;
}

async function pickOutputFolder(): Promise<{ folder: any; nativePath: string }> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();

  let folder: any = null;
  try {
    const tokenEntry = await dataFolder.getEntry(TOKEN_FILE);
    const tokenJson = await tokenEntry.read({ format: uxp.storage.formats.utf8 });
    const stored = JSON.parse(tokenJson)?.token;
    if (stored) folder = await fs.getEntryForPersistentToken(stored).catch(() => null);
  } catch { /* no token */ }

  if (!folder) {
    folder = await fs.getFolder().catch(() => null);
    if (!folder) throw new Error("Cancelled — pick an output folder (e.g. %APPDATA%\\Adobe\\Adobe Photoshop 2026\\Presets\\3DLUTs).");
    try {
      const token = await fs.createPersistentToken(folder);
      const tokenFile = await dataFolder.createFile(TOKEN_FILE, { overwrite: true });
      await tokenFile.write(JSON.stringify({ token, savedFolder: folder.nativePath ?? "" }), { format: uxp.storage.formats.utf8 });
    } catch { /* persistence optional */ }
  }
  return { folder, nativePath: folder.nativePath ?? "" };
}

export async function resetLutOutputFolder(): Promise<string> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  try {
    const entry = await dataFolder.getEntry(TOKEN_FILE);
    await entry.delete();
    return "Output folder cleared. Next export will prompt.";
  } catch {
    return "No saved output folder.";
  }
}

export async function exportLutNative(params: ExportLutNativeParams): Promise<string> {
  // 1. Compute LUT from active doc's source/target layers BEFORE we swap the active doc.
  const userDoc = getActiveDoc();
  const userDocId = userDoc.id;
  const source = userDoc.layers.find((l: any) => l.id === params.sourceLayerId);
  const target = userDoc.layers.find((l: any) => l.id === params.targetLayerId);
  if (!source || !target) throw new Error("Picked layer no longer exists.");

  // 2. Pick output folder (persistent token).
  const { nativePath: folderPath } = await pickOutputFolder();
  const filenameBase = params.filenameBase ?? "ColorSmash";
  const cubeFilename = `${filenameBase}.CUBE`;

  return core.executeAsModal(async () => {
    const [s, t] = await Promise.all([
      readLayerPixels(source, statsRectForLayer(source)),
      readLayerPixels(target, statsRectForLayer(target)),
    ]);
    const srcStats = computeLabStats(downsampleToMaxEdge(s, STATS_MAX_EDGE).data);
    const tgtStats = computeLabStats(downsampleToMaxEdge(t, STATS_MAX_EDGE).data);
    const lut = generateReinhardLUT(GRID_POINTS, srcStats, tgtStats, params.weights);

    // 3. Create a temp doc N²×N, RGB, 16-bit, sRGB via DOM API (more reliable than batchPlay make).
    const W = GRID_POINTS * GRID_POINTS;
    const H = GRID_POINTS;
    let tempDoc: any;
    try {
      tempDoc = await (app.documents as any).add({
        width: W,
        height: H,
        resolution: 72,
        mode: "RGBColorMode",
        fill: "white",
        depth: 16,
        colorProfile: "sRGB IEC61966-2.1",
        name: "ColorSmash LUT temp",
      });
    } catch (e: any) {
      throw new Error(`documents.add failed: ${e?.message ?? e}`);
    }
    if (!tempDoc || tempDoc.id === userDocId) {
      throw new Error(`Temp doc not created (active doc id=${app.activeDocument?.id}, userDocId=${userDocId}).`);
    }

    try {
      // 4. Render identity LUT grid into background.
      await psAction.batchPlay([{
        _obj: "3grd",
        grdP: GRID_POINTS,
      }], {});

      // 5. Read BG pixels, apply LUT (each pixel's color IS its input coord).
      const bgLayer = tempDoc.backgroundLayer ?? tempDoc.layers[tempDoc.layers.length - 1];
      const buf = await readLayerPixels(bgLayer);
      const px = buf.data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = lutSampleTrilinear(lut, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
        px[i]     = Math.max(0, Math.min(255, Math.round(r * 255)));
        px[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
        px[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      }
      // Write back via imaging API directly (BG layer needs RGB, not RGBA strictly, but our writer handles 4-comp).
      const newImg = await imaging.createImageDataFromBuffer(px, {
        width: buf.width,
        height: buf.height,
        components: 4,
        colorSpace: "RGB",
        colorProfile: "sRGB IEC61966-2.1",
      });
      await imaging.putPixels({
        documentID: tempDoc.id,
        layerID: bgLayer.id,
        imageData: newImg,
        targetBounds: buf.bounds,
      });
      if (newImg.dispose) newImg.dispose();

      // 6. Call native Expr with Usng={_obj:"lut "} to write .CUBE.
      // fpth is base path WITHOUT extension; PS appends per-format extensions.
      const sep = folderPath.includes("\\") ? "\\" : "/";
      const basePathNoExt = `${folderPath}${sep}${filenameBase}`;
      // Modern batchPlay can't reach the LUT-export "Expr" pathway. Fall back to inline
      // ExtendScript via AdobeScriptAutomation Scripts — classic executeAction works fine.
      const jsxPath = basePathNoExt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const jsxSrc = `
        try {
          var d = new ActionDescriptor();
          var d2 = new ActionDescriptor();
          d2.putString(charIDToTypeID('fpth'), "${jsxPath}");
          d2.putString(charIDToTypeID('dscr'), "${filenameBase.replace(/"/g, '\\"')}");
          d2.putInteger(charIDToTypeID('gPts'), ${GRID_POINTS});
          d2.putBoolean(charIDToTypeID('wICC'), false);
          d2.putBoolean(charIDToTypeID('w3DL'), false);
          d2.putBoolean(charIDToTypeID('wCUB'), true);
          d2.putBoolean(charIDToTypeID('wCSP'), false);
          d2.putBoolean(charIDToTypeID('lcFE'), false);
          d2.putString(charIDToTypeID('Cpyr'), "");
          d.putObject(charIDToTypeID('Usng'), charIDToTypeID('lut '), d2);
          executeAction(charIDToTypeID('Expr'), d, DialogModes.NO);
          "OK";
        } catch (e) {
          "ERR: " + (e.message || e) + " #" + (e.number || "?");
        }
      `;
      const exprResult = await psAction.batchPlay([{
        _obj: "AdobeScriptAutomation Scripts",
        javaScript: jsxSrc,
        javaScriptMessage: "OK",
      }], {});
      console.log("Expr result:", JSON.stringify(exprResult));
      const r0 = exprResult?.[0];
      if (r0 && r0._obj === "error") {
        throw new Error(`Expr returned error: ${r0.message ?? "(no message)"} (code ${r0.result ?? "?"})`);
      }
    } finally {
      // 7. Close temp doc without saving + restore user's doc as active.
      try { await tempDoc.closeWithoutSaving(); } catch { /* ignore */ }
      try {
        const restored = app.documents.find((d: any) => d.id === userDocId);
        if (restored) app.activeDocument = restored;
      } catch { /* ignore */ }
    }

    return `Wrote ${cubeFilename} to ${folderPath} via native Expr.\nRESTART Photoshop, then check Color Lookup adjustment layer 3DLUT dropdown for "${filenameBase}".`;
  }, { commandName: "Color Smash export LUT (native)" });
}
