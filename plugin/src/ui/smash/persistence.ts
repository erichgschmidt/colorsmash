// Pro Smash state persistence — separate JSON file from the free PersistedSettings
// because the free saver builds its snapshot from its own field list, which would
// wipe any Pro fields we tried to piggyback. Same pattern as ui/persistence.ts
// (plugin data folder, debounced write) but scoped to the Smash mode.
//
// Stored at:  <pluginData>/color-smash-smash.json

const FILE_NAME = "color-smash-smash.json";

export interface SmashPersisted {
  /** Global Smash Amount, 0..1. */
  amount?: number;
  /** Doc id of the last picked source layer. Reset to null when doc changes. */
  sourceDocId?: number | null;
  /** Layer id within sourceDocId. */
  sourceLayerId?: number | null;
  /** Doc id of the last picked target layer. */
  targetDocId?: number | null;
  /** Layer id within targetDocId. */
  targetLayerId?: number | null;
  /** v1.21 Phase 2 — six trait amounts in [0, 1]. Stored as a partial
   *  Record so older save files without traits still load cleanly; missing
   *  keys fall back to DEFAULT_TRAIT_AMOUNTS on read. */
  traits?: {
    value?: number;
    hue?: number;
    saturation?: number;
    chroma?: number;
    neutral?: number;
    accent?: number;
  };
  /** v1.21 Phase 4.5+ — cross-dimensional colorization toggle state. Partial
   *  so older save files without it fall back to DEFAULT_COLORIZATION_TOGGLES
   *  on read. */
  colorization?: {
    hueByLuma?: boolean;
    liftNeutrals?: boolean;
    paletteSnap?: boolean;
    // Future toggles slot in here as Phase 5+ ships them.
  };
  /** v1.21 Phase 4.5c — how many times applyTransform iterates per pixel
   *  during the LUT bake. Clamped to [1, 4] on load. Default 1. */
  passes?: number;
  /** v1.21 Phase 4.5g — proportion match strength [0, 1]. 1 = tight (per-L
   *  lift floor, mirrors source's structure). 0 = loose (global median lift,
   *  uniform colorization). Default 1. */
  proportionMatch?: number;
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
