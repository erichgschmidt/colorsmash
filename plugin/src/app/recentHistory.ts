// Recent History ring buffer (v1.20.0).
//
// Pure-data module: every successful Apply (Curves / LUT bake) pushes a
// snapshot of the panel state here. The UI renders the most-recent N entries
// as small palette-color thumbnail strips near the Apply button and lets the
// user click any of them to restore the panel to that state.
//
// No React, no Photoshop API, no I/O — just types + functions over plain
// objects. Persistence (loading/saving via PersistedSettings) is wired up by
// the UI layer; this module just provides the operations.

import { LutLayerState, SerializedSwatch } from "./lutXmp";

const DEFAULT_MAX = 5;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

/** Compact visual signature for a history entry — the source palette
 *  swatches as raw RGB bytes. Used to render the small thumbnail strip
 *  in the UI without re-running k-means or storing pixel data. */
export interface PaletteSignature {
  /** Up to 7 swatch colors as packed 0xRRGGBB. Order matches paletteSwatches dark→light. */
  colors: number[];
  /** Per-swatch weight × 100, rounded. Drives segment widths in the
   *  thumbnail strip so the signature visually communicates the palette
   *  prevalence + user weighting. */
  weights: number[];
}

/** A single history entry — one row in the ring buffer. */
export interface HistoryEntry {
  /** UUID-ish id — timestamp + random suffix; used for React keys + dedupe. */
  id: string;
  /** Date.now() at the time of capture. */
  timestamp: number;
  /** Auto-generated label like "RGB · Color · 5 swatches". */
  label: string;
  /** Full panel state to restore to. Mirrors the XMP payload format. */
  state: LutLayerState;
  /** Palette colors + weights for the thumbnail strip. */
  signature: PaletteSignature;
  /** v1.20.1 — when true, this entry is preserved across ring-buffer evictions.
   *  Pinned entries sort to the front of the list and stay regardless of the
   *  `max` cap (they count toward total length but the cap protects them
   *  from being trimmed). */
  pinned?: boolean;
  /** v1.20.3 — user-supplied display name. When present, overrides the
   *  auto-generated `label` in the UI. Only available on pinned entries
   *  (the rename UI surfaces a text input alongside the star). Empty string
   *  reverts to the auto label. */
  customName?: string;
  /** v1.21 — optional base64-encoded PNG thumbnail of the matched preview.
   *  Lightroom-style: lets a preset gallery render itself without re-running
   *  k-means or re-applying the transform. Capped at ~80KB in practice
   *  (256² PNG of the preview tile). Old presets omit this field. */
  thumbnail?: string;
  /** v1.21 — categorizes the preset's authoring origin.
   *  - 'match' (default) — produced by the current Color Match workflow.
   *  - 'smash' — produced by the Pro Smash Engine (Source DNA + traits).
   *  Field is omitted from older presets, in which case the loader assumes 'match'. */
  kind?: 'match' | 'smash';
}

/** Set or clear the customName on an entry by id. Returns a NEW array;
 *  missing ids leave the array unchanged. Empty/whitespace name clears
 *  the override (entry falls back to its auto-generated label). */
export function renameHistoryEntry(
  history: HistoryEntry[],
  id: string,
  customName: string,
): HistoryEntry[] {
  if (!Array.isArray(history)) return [];
  const trimmed = (customName || "").trim();
  let found = false;
  const next = history.map(e => {
    if (e && e.id === id) {
      found = true;
      return { ...e, customName: trimmed.length > 0 ? trimmed : undefined };
    }
    return e;
  });
  return found ? next : history.slice();
}

/** Clamp a numeric byte channel to 0..255. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

/** Clamp max to allowed range. */
function clampMax(max: number | undefined): number {
  if (typeof max !== "number" || !Number.isFinite(max)) return DEFAULT_MAX;
  if (max < MIN_LIMIT) return MIN_LIMIT;
  if (max > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(max);
}

/** Build a palette signature from the SerializedSwatch array used in
 *  LutLayerState.sourcePaletteSwatches. Falls back to a 1-color #888 signature
 *  if swatches is empty/undefined (so the thumbnail still renders something).
 *
 *  v1.20.15 — accepts the user's per-cluster weight multipliers
 *  (`userWeights`, from state.sourcePaletteWeights). The signature's bar
 *  widths are now `clusterPrevalence × userMultiplier`, mirroring exactly
 *  what PaletteStrip renders in the live UI. Without the multipliers, all
 *  thumbnails looked like the default k-means prevalence regardless of how
 *  the user had dragged the sliders before Apply — so users perceived the
 *  history as "not baking my ratio changes." */
export function buildPaletteSignature(
  swatches: SerializedSwatch[] | undefined,
  userWeights?: number[],
): PaletteSignature {
  if (!swatches || !Array.isArray(swatches) || swatches.length === 0) {
    return { colors: [0x888888], weights: [100] };
  }
  const colors: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < swatches.length; i++) {
    const s = swatches[i];
    if (!s || typeof s !== "object") continue;
    const r = clampByte((s as any).r);
    const g = clampByte((s as any).g);
    const b = clampByte((s as any).b);
    colors.push((r << 16) | (g << 8) | b);
    const prevalence = typeof s.weight === "number" && Number.isFinite(s.weight) ? s.weight : 0;
    const mult = userWeights && typeof userWeights[i] === "number" && Number.isFinite(userWeights[i])
      ? Math.max(0, userWeights[i])
      : 1;
    weights.push(Math.round(prevalence * mult * 100));
  }
  if (colors.length === 0) {
    return { colors: [0x888888], weights: [100] };
  }
  return { colors, weights };
}

/** Title-case a short identifier ("color" -> "Color"). */
function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Build the auto-label string for a history entry.
 *  Format: "<MODE> · <Preset> · <N> swatches" with optional " · Multi" suffix. */
export function buildHistoryLabel(state: LutLayerState): string {
  const modeRaw =
    (typeof state.outputMode === "string" && state.outputMode) ||
    (typeof state.colorSpace === "string" && state.colorSpace) ||
    "rgb";
  const mode = modeRaw.toLowerCase() === "lut" ? "LUT" : modeRaw.toUpperCase();
  const preset = titleCase(state.preset || "Custom");
  const n =
    typeof state.paletteCount === "number" && Number.isFinite(state.paletteCount)
      ? state.paletteCount
      : (state.sourcePaletteSwatches?.length ?? 0);
  let label = `${mode} · ${preset} · ${n} swatches`;
  if (state.multiZone) label += " · Multi";
  if (label.length > 40) label = label.slice(0, 39) + "…";
  return label;
}

/** Stable content hash for dedupe — combines preset, output mode, multi-zone,
 *  and a hash of the palette weights. */
export function dedupKey(state: LutLayerState): string {
  const mode =
    (typeof state.outputMode === "string" && state.outputMode) ||
    (typeof state.colorSpace === "string" && state.colorSpace) ||
    "rgb";
  const preset = state.preset || "";
  const multi = state.multiZone ? "1" : "0";
  const n = state.paletteCount ?? 0;
  const srcW = (state.sourcePaletteWeights || [])
    .map((w) => (typeof w === "number" ? Math.round(w * 1000) : 0))
    .join(",");
  const ss = state.sourceSoftness ?? 0;
  // v1.20.17 — recipes are source-only; target fields are stripped before
  // entries land in history, so the dedupe key only needs source identity.
  const srcSig = (state.sourcePaletteSwatches || [])
    .map((s: any) => `${s?.r ?? 0},${s?.g ?? 0},${s?.b ?? 0}`)
    .join(";");
  return `${mode}|${preset}|${multi}|${n}|${srcW}|${ss}|${srcSig}`;
}

/** Push a new entry onto the front of the history. Dedupes against the
 *  most recent entry only. Returns a NEW array (immutable).
 *
 *  v1.20.1 — pinned entries are preserved across cap-trim: when the buffer
 *  would overflow, only non-pinned entries from the tail are evicted.
 *  Pinned entries can themselves grow past `max` (the cap only governs
 *  non-pinned recents). The first non-duplicate top entry of either kind
 *  triggers the dedupe check.
 */
export function pushHistoryEntry(
  history: HistoryEntry[],
  entry: HistoryEntry,
  max: number = DEFAULT_MAX,
): HistoryEntry[] {
  const cap = clampMax(max);
  const cur = Array.isArray(history) ? history : [];
  // Dedupe against the most-recent NON-pinned entry — pinned items can sit
  // at the top of the list (sorted to front by the UI), but they shouldn't
  // block a new bake from being recorded.
  // v1.20.10 — dedupe is now a SHORT TIME WINDOW (2s) against the most-recent
  // non-pinned entry. Previously dedupKey covered only a subset of state
  // fields (preset/weights/softness/swatches) so Applying with different
  // dimensions/zones/envelope/LUT options still matched the previous key
  // and was silently rejected — users saw "only 2 entries ever save."
  // Time-window dedupe protects against double-click spam without trying
  // to keep an exhaustive field list in sync forever.
  const firstNonPinned = cur.find(e => !e?.pinned);
  if (
    firstNonPinned &&
    firstNonPinned.state &&
    entry.timestamp - firstNonPinned.timestamp < 2000 &&
    dedupKey(firstNonPinned.state) === dedupKey(entry.state)
  ) {
    return cur.slice();
  }
  // Insert new entry at the front. Then trim the NON-pinned suffix to the cap.
  const next = [entry, ...cur];
  const pinned = next.filter(e => e?.pinned);
  const recents = next.filter(e => !e?.pinned).slice(0, cap);
  // Preserve relative order: pinned first (already sorted by recency), then
  // recents. The UI re-sorts visually but the underlying array order is
  // pinned→recent for predictable persistence.
  return [...pinned, ...recents];
}

/** Toggle the pinned state on a single entry, addressed by id. Returns a
 *  NEW array; missing ids leave the array unchanged. */
export function togglePinnedEntry(history: HistoryEntry[], id: string): HistoryEntry[] {
  if (!Array.isArray(history)) return [];
  let found = false;
  const next = history.map(e => {
    if (e && e.id === id) {
      found = true;
      return { ...e, pinned: !e.pinned };
    }
    return e;
  });
  return found ? next : history.slice();
}

/** Generate a short unique id for a history entry. */
function makeId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Build a brand-new HistoryEntry from a state object. */
export function makeHistoryEntry(state: LutLayerState): HistoryEntry {
  return {
    id: makeId(),
    timestamp: Date.now(),
    label: buildHistoryLabel(state),
    state,
    signature: buildPaletteSignature(state.sourcePaletteSwatches, state.sourcePaletteWeights),
  };
}

/** Type guard: is value a plausible HistoryEntry?
 *  v1.20.65 — also rejects empty-state entries (state === {} would pass
 *  the structural typeof check but apply nothing on restore, looking
 *  like a bug to the user). Requires at least one identifying key on
 *  state so corrupted/partial snapshots get dropped at load. */
function isValidEntry(v: any): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.timestamp !== "number" || !Number.isFinite(v.timestamp)) return false;
  if (typeof v.label !== "string") return false;
  if (!v.state || typeof v.state !== "object") return false;
  if (!v.signature || typeof v.signature !== "object") return false;
  if (!Array.isArray(v.signature.colors)) return false;
  if (!Array.isArray(v.signature.weights)) return false;
  // Reject empty/partial state — at minimum the entry needs a preset
  // or palette swatches to be meaningfully restorable. Anything less
  // would silently apply defaults on click and surface as a bug.
  if (Object.keys(v.state).length === 0) return false;
  return true;
}

/** Defensive clamp — used when loading from PersistedSettings.
 *  v1.20.1 — keeps ALL valid pinned entries regardless of cap; only the
 *  non-pinned tail is trimmed. */
export function pruneHistory(history: any, max: number = DEFAULT_MAX): HistoryEntry[] {
  const cap = clampMax(max);
  if (!Array.isArray(history)) return [];
  const valid = history.filter(isValidEntry);
  const pinned = valid.filter(e => e.pinned);
  const recents = valid.filter(e => !e.pinned).slice(0, cap);
  return [...pinned, ...recents];
}
