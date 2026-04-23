// Persistent source presets. Each preset stores a small RGBA snapshot of a source — used
// later as the histogram source against any target. Lives in plugin data folder.

const PRESETS_FILE = "match-source-presets.json";

export interface SourcePreset {
  id: string;
  name: string;
  createdAt: number;
  w: number;
  h: number;
  pixelsB64: string;  // base64 of RGBA Uint8Array
}

export interface SourcePresetSnapshot {
  width: number;
  height: number;
  data: Uint8Array;
  name: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function getDataFolder(): Promise<any> {
  const uxp = require("uxp");
  return uxp.storage.localFileSystem.getDataFolder();
}

async function readPresetsFile(): Promise<SourcePreset[]> {
  try {
    const uxp = require("uxp");
    const folder = await getDataFolder();
    const entry = await folder.getEntry(PRESETS_FILE);
    const text = await entry.read({ format: uxp.storage.formats.utf8 });
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writePresetsFile(presets: SourcePreset[]): Promise<void> {
  const uxp = require("uxp");
  const folder = await getDataFolder();
  const file = await folder.createFile(PRESETS_FILE, { overwrite: true });
  await file.write(JSON.stringify(presets), { format: uxp.storage.formats.utf8 });
}

export async function listPresets(): Promise<SourcePreset[]> {
  const all = await readPresetsFile();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function savePreset(snap: SourcePresetSnapshot): Promise<SourcePreset> {
  const all = await readPresetsFile();
  const preset: SourcePreset = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: snap.name,
    createdAt: Date.now(),
    w: snap.width,
    h: snap.height,
    pixelsB64: bytesToBase64(snap.data),
  };
  all.push(preset);
  // Cap at 30 most-recent to avoid unbounded growth.
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  await writePresetsFile(sorted);
  return preset;
}

export async function deletePreset(id: string): Promise<void> {
  const all = await readPresetsFile();
  await writePresetsFile(all.filter(p => p.id !== id));
}

export function loadPresetSnap(p: SourcePreset): SourcePresetSnapshot {
  return { width: p.w, height: p.h, data: base64ToBytes(p.pixelsB64), name: p.name };
}
