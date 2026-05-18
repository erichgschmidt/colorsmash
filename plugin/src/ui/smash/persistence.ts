// Pro Smash state persistence — separate JSON file from the free PersistedSettings
// because the free saver builds its snapshot from its own field list, which would
// wipe any Pro fields we tried to piggyback. Same pattern as ui/persistence.ts
// (plugin data folder, debounced write) but scoped to the Smash mode.
//
// v2 — the Smash redesign. State is the four per-aspect band-transfer controls
// (Value / Hue / Saturation / Chroma). The ratio bands themselves are absolute
// distributions tied to the current images, so they're re-seeded from the
// extracted histograms each session — only each aspect's slice count, borrow
// amount, softness, and drag mode are persisted.
//
// Stored at:  <pluginData>/color-smash-smash.json

const FILE_NAME = "color-smash-smash.json";

/** One aspect's persisted control state. `binCount` is the number of slices;
 *  `amount` is the borrow/smash strength [0,1]; `softness` [0,1] smooths the
 *  band transitions; `rankBy` is the cross-feed axis ("auto"/"value"/"hue"/
 *  "saturation"/"chroma"); `adaptive` is the drag mode. Every field optional
 *  so older / partial save files load cleanly. The bands themselves are not
 *  persisted — they're re-seeded from the image histograms each session. */
export interface PersistedAspect {
  binCount?: number;
  amount?: number;
  softness?: number;
  rankBy?: string;
  adaptive?: boolean;
}

/** Persisted Pro Smash state (v2 — per-aspect band transfer). */
export interface SmashPersisted {
  aspects?: {
    value?: PersistedAspect;
    hue?: PersistedAspect;
    saturation?: PersistedAspect;
    chroma?: PersistedAspect;
  };
}

async function getDataFolder(): Promise<any | null> {
  try {
    const uxp = await import("uxp");
    const fs = (uxp as any).default?.storage?.localFileSystem
      ?? (uxp as any).storage?.localFileSystem;
    if (!fs?.getDataFolder) return null;
    return await fs.getDataFolder();
  } catch {
    return null;
  }
}

export async function loadSmashSettings(): Promise<SmashPersisted | null> {
  try {
    const folder = await getDataFolder();
    if (!folder) return null;
    const exists = await folder.getEntry(FILE_NAME).catch(() => null);
    if (!exists) return null;
    const text = await exists.read();
    if (!text || typeof text !== "string") return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SmashPersisted;
  } catch {
    return null;
  }
}

async function writeSmashSettings(settings: SmashPersisted): Promise<void> {
  const folder = await getDataFolder();
  if (!folder) return;
  const entry = await folder.createFile(FILE_NAME, { overwrite: true });
  if (!entry) return;
  await entry.write(JSON.stringify(settings, null, 2));
}

/**
 * Returns a debounced saver. Each call resets the timer; only the most recent
 * settings get written after `delayMs` of quiet. Mirrors the pattern in
 * ui/persistence.ts so Pro and free behave the same way under interactive
 * edits.
 */
export function makeSmashSaver(delayMs = 500): (settings: SmashPersisted) => void {
  let timer: any = null;
  let latest: SmashPersisted | null = null;
  return (settings: SmashPersisted) => {
    latest = settings;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const s = latest;
      latest = null;
      if (s) writeSmashSettings(s).catch(() => { /* best-effort */ });
    }, delayMs);
  };
}
