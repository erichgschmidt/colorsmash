// Persist panel settings across reloads. Stored as a JSON file in UXP's plugin data folder
// (per-user, per-plugin). The "remember" toggle controls whether saves happen; the toggle
// itself is always saved/loaded so users don't have to re-enable it every session.
//
// Why a file instead of localStorage: UXP's localStorage support is patchy across PS versions
// and can silently fail. The plugin data folder (storage.localFileSystem.getDataFolder())
// is documented and reliable. Synchronous save isn't possible — we debounce so the file is
// written at most every 500ms during interactive editing.

const FILE_NAME = "color-smash-settings.json";

export interface PersistedSettings {
  remember: boolean;
  // Match controls
  amount?: number;
  smooth?: number;
  stretch?: number;
  anchorStretchToHist?: boolean;
  chromaOnly?: boolean;
  colorSpace?: "rgb" | "lab";
  // Apply behavior
  deselectOnApply?: boolean;
  overwriteOnApply?: boolean;
  // Sections
  openSection?: "basic" | "dims" | "zones" | "envelope" | null;
  // Match algorithm
  matchMode?: "full" | "mean" | "median" | "percentile";
  // Multi-zone output (beta)
  multiZone?: boolean;
  // Zone targeting
  zones?: any;
  lockZoneTotal?: boolean;
  // Dimensions
  dimensions?: any;
  // Envelope
  envelope?: any[];
}

async function readSettingsFile(): Promise<PersistedSettings | null> {
  try {
    const { storage } = require("uxp");
    const folder = await storage.localFileSystem.getDataFolder();
    const entries = await folder.getEntries();
    const file = entries.find((e: any) => e.name === FILE_NAME);
    if (!file) return null;
    const text = await file.read({ format: storage.formats.utf8 });
    if (!text) return null;
    return JSON.parse(text) as PersistedSettings;
  } catch {
    return null;
  }
}

async function writeSettingsFile(settings: PersistedSettings): Promise<void> {
  try {
    const { storage } = require("uxp");
    const folder = await storage.localFileSystem.getDataFolder();
    const file = await folder.createFile(FILE_NAME, { overwrite: true });
    await file.write(JSON.stringify(settings), { format: storage.formats.utf8 });
  } catch {
    /* swallow — persistence is best-effort, not critical */
  }
}

export async function loadSettings(): Promise<PersistedSettings | null> {
  return readSettingsFile();
}

// Delete the persisted settings file (used by the ✕ "reset to defaults" button).
export async function clearSettings(): Promise<void> {
  try {
    const { storage } = require("uxp");
    const folder = await storage.localFileSystem.getDataFolder();
    const entries = await folder.getEntries();
    const file = entries.find((e: any) => e.name === FILE_NAME);
    if (file && file.delete) await file.delete();
  } catch { /* swallow */ }
}

// Debounced save factory. Returns a function you call on every state change; the actual write
// happens at most every `delayMs` and only if `remember` is true. The first arg becomes the
// new full state to persist (caller provides current snapshot each call).
export function makeDebouncedSaver(delayMs = 500): (settings: PersistedSettings) => void {
  let pending: PersistedSettings | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending) { writeSettingsFile(pending); pending = null; }
  };
  return (settings: PersistedSettings) => {
    pending = settings;
    if (timer) return;
    timer = setTimeout(flush, delayMs);
  };
}
