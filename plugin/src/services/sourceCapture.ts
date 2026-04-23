// Source-acquisition helpers: pull pixel snapshots into the Match tab from clipboard
// (via PS paste) and from a screenshot folder (via PS open/close). Both produce small
// downsampled RGBA buffers suitable for histogram fitting.

import { app, action } from "photoshop";
import { readLayerPixels, executeAsModal, getActiveDoc } from "./photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import { SourcePresetSnapshot } from "./sourcePresets";

const SOURCE_MAX_EDGE = 256;
const FOLDER_TOKEN_FILE = "screenshot-folder-token.json";
const IMAGE_EXT_RE = /\.(png|jpe?g|bmp|tiff?|gif|webp)$/i;

// ─── Clipboard: paste into active doc as a new layer, read it, delete ──────
export async function snapshotFromClipboard(): Promise<SourcePresetSnapshot> {
  return executeAsModal("Snapshot clipboard", async () => {
    const doc = getActiveDoc();
    const beforeIds = new Set(doc.layers.map((l: any) => l.id));

    try {
      await action.batchPlay([{ _obj: "paste", as: { _class: "pixel" } }], {});
    } catch (e: any) {
      throw new Error(`Paste failed — clipboard may not contain image data. (${e?.message ?? e})`);
    }

    const newLayer = doc.layers.find((l: any) => !beforeIds.has(l.id));
    if (!newLayer) throw new Error("Pasted layer not found.");

    try {
      const buf = await readLayerPixels(newLayer);
      const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
      const t = new Date();
      const name = `Clipboard ${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`;
      return { width: small.width, height: small.height, data: small.data, name };
    } finally {
      try { await newLayer.delete(); } catch { /* ignore */ }
    }
  });
}

// ─── Screenshot folder: pick once, then import N most-recent images ────────
async function getStoredFolder(): Promise<any | null> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  try {
    const tokenEntry = await dataFolder.getEntry(FOLDER_TOKEN_FILE);
    const tokenJson = await tokenEntry.read({ format: uxp.storage.formats.utf8 });
    const stored = JSON.parse(tokenJson)?.token;
    if (stored) return await fs.getEntryForPersistentToken(stored).catch(() => null);
  } catch { /* none */ }
  return null;
}

export async function getOrPickScreenshotFolder(): Promise<{ folder: any; nativePath: string }> {
  let folder = await getStoredFolder();
  if (!folder) {
    const uxp = require("uxp");
    const fs = uxp.storage.localFileSystem;
    folder = await fs.getFolder().catch(() => null);
    if (!folder) throw new Error("Cancelled — pick a screenshot folder.");
    try {
      const dataFolder = await fs.getDataFolder();
      const token = await fs.createPersistentToken(folder);
      const tokenFile = await dataFolder.createFile(FOLDER_TOKEN_FILE, { overwrite: true });
      await tokenFile.write(JSON.stringify({ token, savedFolder: folder.nativePath ?? "" }), { format: uxp.storage.formats.utf8 });
    } catch { /* persistence optional */ }
  }
  return { folder, nativePath: folder.nativePath ?? "" };
}

export async function resetScreenshotFolder(): Promise<string> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  try {
    const entry = await dataFolder.getEntry(FOLDER_TOKEN_FILE);
    await entry.delete();
    return "Screenshot folder cleared. Next import will prompt.";
  } catch {
    return "No saved screenshot folder.";
  }
}

export async function importRecentScreenshots(
  n: number,
  existingNames: Set<string>,
): Promise<SourcePresetSnapshot[]> {
  const { folder } = await getOrPickScreenshotFolder();
  const entries = await folder.getEntries();
  const imageEntries = entries.filter((e: any) => e.isFile && IMAGE_EXT_RE.test(e.name));
  // Sort by mtime desc.
  const withMeta = await Promise.all(imageEntries.map(async (e: any) => ({
    entry: e,
    mtime: (await e.getMetadata().catch(() => null))?.dateModified?.getTime?.() ?? 0,
  })));
  withMeta.sort((a, b) => b.mtime - a.mtime);

  const results: SourcePresetSnapshot[] = [];
  const uxp = require("uxp");
  for (const { entry } of withMeta) {
    if (results.length >= n) break;
    if (existingNames.has(entry.name)) continue;

    try {
      const snap = await executeAsModal(`Import ${entry.name}`, async () => {
        const token = uxp.storage.localFileSystem.createSessionToken(entry);
        const beforeDocId = app.activeDocument?.id ?? null;
        await action.batchPlay([{ _obj: "open", null: { _path: token } }], {});
        const opened = app.activeDocument;
        if (!opened || opened.id === beforeDocId) throw new Error("Open did not produce a new doc.");
        const bgLayer = opened.backgroundLayer ?? opened.layers[opened.layers.length - 1];
        const buf = await readLayerPixels(bgLayer);
        const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
        const data: SourcePresetSnapshot = { width: small.width, height: small.height, data: small.data, name: entry.name };
        try { await opened.closeWithoutSaving(); } catch { /* ignore */ }
        return data;
      });
      results.push(snap);
    } catch { /* skip on error */ }
  }
  return results;
}
