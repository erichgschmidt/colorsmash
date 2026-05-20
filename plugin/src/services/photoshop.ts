// All Photoshop DOM + batchPlay calls live here. Keeps the algorithm core pure-TS / testable.

import { app, action, imaging, core } from "photoshop";

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8Array;     // Always RGBA, tightly packed, top-left origin.
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Canonical name for the plugin's output group. v1.20.69 — was a const,
 * now mutable to support the Settings drawer's "Group name" preference.
 * Callsites import via `getGroupName()` (or read `GROUP_NAME` directly
 * — kept as `let` so existing imports still pick up the live value).
 * The MatchTab panel calls `setGroupName(...)` on init / change.
 *
 * For migration / backward compat with prior bakes named "[Color Smash]",
 * `getLegacyGroupName()` returns the canonical default. Recursive
 * find/consolidate helpers match BOTH the current name AND the legacy
 * name so users who rename mid-project don't orphan their existing
 * group.
 */
export const DEFAULT_GROUP_NAME = "[Color Smash]";
export let GROUP_NAME: string = DEFAULT_GROUP_NAME;
export function setGroupName(name: string): void {
  const trimmed = (name ?? "").trim();
  GROUP_NAME = trimmed.length > 0 ? trimmed : DEFAULT_GROUP_NAME;
}
/** Returns true if `name` should be recognized as a Color Smash group
 *  (matches either the current user-chosen name or the legacy default).
 *  Used by find/consolidate helpers so a user can rename without
 *  orphaning prior bakes. */
export function isColorSmashGroupName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === GROUP_NAME || name === DEFAULT_GROUP_NAME;
}

export function getActiveDoc() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No active document.");
  return doc;
}

export function getSelectionBounds(): Rect | null {
  const doc = getActiveDoc();
  const b = doc.selection?.bounds;
  if (!b) return null;
  if (b.right <= b.left || b.bottom <= b.top) return null;
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const r: Rect = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return (r.right > r.left && r.bottom > r.top) ? r : null;
}

// Returns the rect to use for stat sampling: intersection of layer bounds and active selection,
// or the full layer bounds if there's no selection (or no overlap).
export function statsRectForLayer(layer: any): Rect {
  const lb: Rect = { left: layer.bounds.left, top: layer.bounds.top, right: layer.bounds.right, bottom: layer.bounds.bottom };
  const sel = getSelectionBounds();
  if (!sel) return lb;
  return intersect(lb, sel) ?? lb;
}

export async function readLayerPixels(layer: any, sourceBounds?: Rect, documentId?: number): Promise<PixelBuffer> {
  if (!imaging || !imaging.getPixels) {
    throw new Error("Imaging API unavailable. Requires Photoshop 24.2+.");
  }
  // Always pass an explicit documentID. Falling back to getActiveDoc() is unsafe across
  // cross-doc operations — the layer may live in a doc that isn't currently active in PS.
  // Caller should pass documentId; if absent we infer from layer.parent or fall back to active.
  const docId = documentId
    ?? (layer?.parent && typeof layer.parent.id === "number" ? layer.parent.id : undefined)
    ?? app.activeDocument?.id;
  if (docId == null) throw new Error("Cannot determine document for layer pixel read.");
  const opts: any = {
    documentID: docId,
    layerID: layer.id,
    componentSize: 8,
    applyAlpha: false,
    colorSpace: "RGB",
  };
  if (sourceBounds) opts.sourceBounds = sourceBounds;
  const result = await imaging.getPixels(opts);
  const id = result.imageData;
  const raw = await id.getData();
  const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const w = id.width;
  const h = id.height;
  const components: number = id.components ?? (src.length / (w * h));
  const rgba = new Uint8Array(w * h * 4);
  if (components === 4) {
    rgba.set(src);
  } else if (components === 3) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      const o = i * 4;
      rgba[o] = src[j]; rgba[o + 1] = src[j + 1]; rgba[o + 2] = src[j + 2]; rgba[o + 3] = 255;
    }
  } else {
    throw new Error(`Unexpected components: ${components}`);
  }
  if (id.dispose) id.dispose();

  const lb = layer.bounds;
  const bounds = sourceBounds ?? { left: lb.left, top: lb.top, right: lb.right, bottom: lb.bottom };
  return { width: w, height: h, data: rgba, bounds };
}

export async function executeAsModal<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return await core.executeAsModal(fn, { commandName: name });
}

type CurveChannel = "composite" | "red" | "green" | "blue";

export async function makeCurvesLayer(
  name: string,
  channels: { channel: CurveChannel; points: { input: number; output: number }[] }[],
): Promise<any> {
  const doc = getActiveDoc();
  await action.batchPlay([{
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: {
      _obj: "adjustmentLayer",
      name,
      type: {
        _obj: "curves",
        presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
        adjustment: channels.map(c => ({
          _obj: "curvesAdjustment",
          channel: { _ref: "channel", _enum: "channel", _value: c.channel },
          curve: c.points.map(p => ({ _obj: "paint", horizontal: p.input, vertical: p.output })),
        })),
      },
    },
  }], {});
  return doc.activeLayers?.[0] ?? doc.layers[0];
}

// Toggle clipping mask on a layer (Alt+Cmd+G equivalent). PS calls this "groupEvent".
export async function setClippingMask(layer: any, clip: boolean): Promise<void> {
  await action.batchPlay([
    { _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false },
    { _obj: clip ? "groupEvent" : "ungroup",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] },
  ], {});
}

/**
 * Read the active selection's per-pixel mask values as a Uint8Array sized to
 * the given bounds rect. Each byte = 0..255 (0 = fully outside selection, 255
 * = fully inside, intermediate values for feathered / anti-aliased edges).
 *
 * Returns null when there's no active selection or the imaging API rejects
 * the request — callers should treat null as "no selection mask available."
 *
 * Used by the Selection tristate (v1.18.0) to attach the marquee as a layer
 * mask at Apply time, optionally multiplied with the target-palette mask.
 */
/**
 * Returns selection mask bytes aligned to the requested `bounds` rect — one
 * byte per pixel, length = (right-left) * (bottom-top), row-major.
 *
 * v1.20.23 — fix for top-left-misalignment bug. `imaging.getSelection` does
 * NOT honor `sourceBounds` as a hard "fill this rect with mask"; it returns
 * the selection's OWN bounding box, sized to the selection (sometimes smaller
 * than the requested rect). Earlier versions blindly dumped the returned
 * bytes into the top-left of a width×height buffer, so a marquee on the
 * right side of the canvas showed up as a small strip in the top-left of
 * the preview.
 *
 * Now we read the selection at its own bounds (via `getSelectionBounds()`),
 * then paste those bytes into the requested-bounds output buffer at the
 * correct offset (with intersection clipping). Pixels outside the selection
 * bbox are 0 (= not selected), as expected.
 */
export async function readSelectionMaskBytes(
  documentId: number,
  bounds: Rect,
): Promise<Uint8Array | null> {
  if (!imaging || !imaging.getSelection) return null;
  const reqW = bounds.right - bounds.left;
  const reqH = bounds.bottom - bounds.top;
  if (reqW <= 0 || reqH <= 0) return null;
  // Use the selection's own bbox as sourceBounds — imaging.getSelection
  // reliably returns bytes sized to whatever rect actually contains the
  // selection mask. Intersect with the requested rect so out-of-range
  // selections degrade gracefully.
  const selBox = getSelectionBounds();
  if (!selBox) return null;
  const isect = intersect(selBox, bounds);
  if (!isect) {
    // Selection is entirely outside the requested rect — return a buffer
    // of zeros so callers can compose without special-casing.
    return new Uint8Array(reqW * reqH);
  }
  try {
    const sel = await imaging.getSelection({
      documentID: documentId,
      sourceBounds: isect,
      kind: "selection",
    });
    const raw = await sel.imageData.getData();
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const actualW = sel.imageData.width;
    const actualH = sel.imageData.height;
    try { sel.imageData.dispose?.(); } catch { /* ignore */ }
    // Paste the selection slice into the requested-bounds output buffer
    // at (isect.left - bounds.left, isect.top - bounds.top).
    const out = new Uint8Array(reqW * reqH);
    const offX = isect.left - bounds.left;
    const offY = isect.top  - bounds.top;
    const copyW = Math.min(actualW, reqW - offX);
    const copyH = Math.min(actualH, reqH - offY);
    for (let y = 0; y < copyH; y++) {
      const srcRow = y * actualW;
      const dstRow = (offY + y) * reqW + offX;
      out.set(bytes.subarray(srcRow, srcRow + copyW), dstRow);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * v1.20.26 — delete the layer mask channel from the given layer (or no-op
 * if there isn't one). Used to strip the auto-applied selection-as-mask
 * that Photoshop attaches to a freshly-created adjustment layer when a
 * marquee is active — the plugin manages masking explicitly at the sub-
 * group level, so the inner layer's auto-mask is always wrong (either
 * redundant with our group mask, or contradicting it in exclude mode).
 */
export async function deleteLayerMask(layerId: number): Promise<void> {
  try {
    await action.batchPlay([{
      _obj: "delete",
      _target: [
        { _ref: "channel", _enum: "channel", _value: "mask" },
        { _ref: "layer", _id: layerId },
      ],
    }], {});
  } catch { /* layer may have had no mask; ignore */ }
}

/**
 * v1.20.26 — save the current marquee into a temporary alpha channel so it
 * survives operations that would otherwise consume or modify it (notably
 * PS auto-applying selection-as-mask on adjustment-layer creation). Returns
 * the saved channel name, or null if there's no selection. Pair with
 * restoreSelectionFromChannel + deleteChannel for the full round-trip.
 */
const SEL_SNAPSHOT_NAME = "__cs_sel_snapshot__";
export async function snapshotSelectionToChannel(): Promise<string | null> {
  const sel = getSelectionBounds();
  if (!sel) return null;
  try {
    // v1.20.28 — corrected batchPlay shape. The "Save Selection" descriptor
    // is `duplicate channel(selection) → to channel(<name>)`; the previous
    // version's `name: <name>` field was a no-op in some PS versions, so
    // the snapshot was never actually created (and restore was a no-op),
    // which meant the live marquee was still active during the bake and
    // PS auto-applied it as the layer mask — exactly the bug users hit.
    await action.batchPlay([{
      _obj: "duplicate",
      _target: [{ _ref: "channel", _property: "selection" }],
      name: SEL_SNAPSHOT_NAME,
      to: { _ref: "channel", _name: SEL_SNAPSHOT_NAME },
      _options: { dialogOptions: "dontDisplay" },
    }], {});
    return SEL_SNAPSHOT_NAME;
  } catch { return null; }
}

/**
 * v1.20.28 — drop the active marquee without affecting saved alpha channels.
 * Pair with snapshotSelectionToChannel + restoreSelectionFromChannel for
 * "temporarily disable selection for the bake, restore afterward."
 */
export async function deselectAll(): Promise<void> {
  try {
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: { _enum: "ordinal", _value: "none" },
      _options: { dialogOptions: "dontDisplay" },
    }], {});
  } catch { /* ignore */ }
}

/**
 * v1.20.26 — re-load a saved alpha channel back into the active marquee
 * selection. No-op if the channel doesn't exist.
 */
export async function restoreSelectionFromChannel(name: string): Promise<void> {
  try {
    // v1.20.28 — the "Load Selection" descriptor format.
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: { _ref: "channel", _name: name },
      _options: { dialogOptions: "dontDisplay" },
    }], {});
  } catch { /* ignore */ }
}

/**
 * v1.20.26 — delete a named alpha channel. Cleanup pair for
 * snapshotSelectionToChannel.
 */
export async function deleteChannel(name: string): Promise<void> {
  try {
    await action.batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "channel", _name: name }],
    }], {});
  } catch { /* ignore */ }
}

/**
 * v1.20.69 — set the Photoshop layer-panel color tag on a group/layer.
 * Helps the [Color Smash] group stand out visually in the Layers panel.
 * PS's fixed color set: "none" | "red" | "orange" | "yellow" | "green"
 * | "blue" | "violet" | "gray". We tag the canonical group orange to
 * match the panel's amber accent palette.
 *
 * Implemented via batchPlay set descriptor — `layer.color` isn't on
 * the UXP DOM directly. Silent on failure: the color is decorative, not
 * functional.
 */
export async function setLayerColor(
  layerId: number,
  color: "none" | "red" | "orange" | "yellow" | "green" | "blue" | "violet" | "gray",
): Promise<void> {
  try {
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _id: layerId }],
      to: { _obj: "layer", color: { _enum: "color", _value: color } },
      _options: { dialogOptions: "dontDisplay" },
    }], {});
  } catch { /* non-fatal — decorative only */ }
}

/** v1.20.69 — color used for the [Color Smash] group. */
export const COLOR_SMASH_GROUP_COLOR = "orange" as const;

/**
 * v1.20.69 — consolidate stray [Color Smash] groups into a single
 * canonical group at the doc root.
 *
 * Background: JUMP / ISOLATE / user clicking around in the Layers panel
 * change PS's "insertion point" — `doc.createLayerGroup` parents the
 * new group at the current selection's container. Combined with the
 * `findCSGroupRecursive` lookup's "prefer top-level" rule, this means
 * stray nested [Color Smash] groups can accumulate over time if a bake
 * ran while the selection was inside a sub-group.
 *
 * This helper finds ALL [Color Smash] groups (exact name match, at any
 * depth — NOT the renamed _NN archives created by branchColorSmashGroup).
 * If more than one exists, all children are moved into the top-most
 * (or first-found) instance and the duplicates are deleted. Returns the
 * surviving canonical group, or null if none existed.
 *
 * Idempotent — safe to call on every Apply.
 */
export async function consolidateColorSmashGroups(docId: number): Promise<void> {
  try {
    const doc = (app.documents ?? []).find((d: any) => d.id === docId);
    if (!doc) return;
    const found: Array<{ group: any; depth: number }> = [];
    const walk = (layers: any[], depth: number) => {
      for (const l of layers) {
        if (!l) continue;
        // v1.20.69 — match BOTH the current (user-chosen) group name AND
        // the legacy "[Color Smash]" default, so renaming the group via
        // Settings doesn't orphan prior bakes.
        if (isColorSmashGroupName(l.name) && Array.isArray(l.layers)) {
          found.push({ group: l, depth });
        }
        if (Array.isArray(l.layers)) walk(l.layers, depth + 1);
      }
    };
    walk(doc.layers ?? [], 0);
    if (found.length === 0) return;
    // Pick the canonical group: prefer the SHALLOWEST (top-level if
    // any), then the first-found at that depth.
    found.sort((a, b) => a.depth - b.depth);
    const canonical = found[0].group;
    if (found.length > 1) {
      // Move every child of every duplicate INTO the canonical group,
      // then delete the now-empty duplicate.
      for (let i = 1; i < found.length; i++) {
        const dup = found[i].group;
        const children = Array.isArray(dup.layers) ? [...dup.layers] : [];
        for (const child of children) {
          try { await child.move(canonical, "placeInside"); } catch { /* ignore */ }
        }
        try { await dup.delete(); } catch { /* ignore */ }
      }
    }
    // v1.20.69 — rename the canonical group to the user's current chosen
    // name if it differs (e.g. they renamed via Settings while a legacy
    // "[Color Smash]" group already existed). Idempotent if names match.
    if (canonical && canonical.name !== GROUP_NAME) {
      try { canonical.name = GROUP_NAME; } catch { /* ignore */ }
    }
    // v1.20.69 — tag the canonical group with the panel's accent color
    // so it stands out in the Layers panel. Runs on every Apply so any
    // older groups (created before this version) also get colored.
    try { if (canonical?.id != null) await setLayerColor(canonical.id, COLOR_SMASH_GROUP_COLOR); } catch { /* ignore */ }
  } catch { /* non-fatal */ }
}

/**
 * v1.20.58 — "branch off" the current [Color Smash] working group.
 * Renames the active [Color Smash] to [Color Smash _<NN>] with NN being
 * the next sequence number (scans the doc for existing archived groups,
 * picks highest + 1), and sets visible=false. The next Apply spawns a
 * fresh [Color Smash] for the new session.
 *
 * Numbering is zero-padded to 2 digits (_01, _02, ...) up to 99, then
 * grows naturally (_100, etc.). Each iteration is identifiable at a
 * glance in the PS Layers panel.
 *
 * No-op when there's no active [Color Smash] group yet.
 */
export async function branchColorSmashGroup(docId: number): Promise<void> {
  try {
    const doc = (app.documents ?? []).find((d: any) => d.id === docId);
    if (!doc) return;
    let active: any | null = null;
    let highest = 0;
    // v1.20.69 — accept BOTH the current user-chosen name and the legacy
    // default for finding the active group. Archive numbering uses
    // whichever name the group ACTUALLY had at the time, so we match
    // either pattern when scanning for the next sequence number.
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numReCurrent = new RegExp(`^${escape(GROUP_NAME)} _(\\d+)`);
    const numReLegacy = new RegExp(`^${escape(DEFAULT_GROUP_NAME)} _(\\d+)`);
    const walk = (layers: any[]) => {
      for (const l of layers) {
        if (!l) continue;
        if (isColorSmashGroupName(l.name) && Array.isArray(l.layers) && !active) {
          active = l;
        } else if (typeof l.name === "string") {
          const m = l.name.match(numReCurrent) ?? l.name.match(numReLegacy);
          if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > highest) highest = n;
          }
        }
        if (Array.isArray(l.layers)) walk(l.layers);
      }
    };
    walk(doc.layers ?? []);
    if (!active) return;
    const next = (highest + 1).toString().padStart(2, "0");
    try { active.name = `${GROUP_NAME} _${next}`; } catch { /* ignore */ }
    try { active.visible = false; } catch { /* ignore */ }
  } catch { /* non-fatal */ }
}

/**
 * Write a tightly-packed RGBA pixel buffer into the document identified by
 * `documentId` as a NEW pixel layer named `layerName`, landing at the
 * document's top-left origin (0,0) at full size width×height.
 *
 * This is the WRITE counterpart to `readLayerPixels` — the plugin has only
 * ever created adjustment layers before, so this is the first raw-pixel
 * write path. It uses the UXP Imaging API (`createImageDataFromBuffer` +
 * `putPixels`), which — like `readLayerPixels` — requires Photoshop 24.2+.
 *
 * All document mutation runs inside a single `executeAsModal` block:
 *   1. Make the target document active (cross-doc safety — the caller may
 *      pass a documentId that isn't the currently-active doc).
 *   2. Create an empty pixel layer via a batchPlay "make layer" descriptor
 *      and read back its layer id from the play result.
 *   3. Build an ImageData from the RGBA buffer and `putPixels` it into the
 *      new layer with `replace: true`.
 *   4. Dispose the ImageData to free memory.
 *
 * CANNOT be unit-tested (no Photoshop in vitest) — verify inside Photoshop.
 *
 * @param documentId  Target document id (not necessarily the active doc).
 * @param layerName   Name for the newly-created pixel layer.
 * @param rgba        Tightly-packed RGBA bytes, length === width*height*4.
 * @param width       Pixel width of the buffer / new layer.
 * @param height      Pixel height of the buffer / new layer.
 */
export async function writePixelLayer(
  documentId: number,
  layerName: string,
  rgba: Uint8Array,
  width: number,
  height: number,
  left = 0,
  top = 0,
): Promise<void> {
  if (!imaging || !imaging.putPixels || !imaging.createImageDataFromBuffer) {
    throw new Error("Imaging API unavailable. Requires Photoshop 24.2+.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`writePixelLayer: invalid dimensions ${width}x${height}.`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
      `writePixelLayer: rgba length ${rgba.length} does not match width*height*4 (${expected}).`,
    );
  }

  await executeAsModal("Write Pixel Layer", async () => {
    // 1. Target the requested document. The caller may pass a doc that isn't
    //    currently active — make it active so the subsequent "make layer"
    //    batchPlay (which targets the document ordinal) lands in the right
    //    place. Verify it actually exists first.
    const targetDoc = (app.documents ?? []).find((d: any) => d.id === documentId);
    if (!targetDoc) {
      throw new Error(`writePixelLayer: no open document with id ${documentId}.`);
    }
    if (app.activeDocument?.id !== documentId) {
      app.activeDocument = targetDoc;
    }

    // 2. Create an empty pixel layer via a batchPlay "make layer" descriptor,
    //    consistent with makeCurvesLayer's descriptor style. A freshly-made
    //    layer becomes the active layer; we read its id back from the play
    //    result (and fall back to the doc's active layer if the result
    //    descriptor doesn't surface an id).
    const makeResult = await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "layer" }],
      using: { _obj: "layer", name: layerName },
      _options: { dialogOptions: "dontDisplay" },
    }], {});

    let layerId: number | undefined =
      (makeResult?.[0]?.layerID as number | undefined)
      ?? (makeResult?.[0]?.layerSectionStart as number | undefined);
    if (typeof layerId !== "number") {
      // Fallback: the just-created layer is the active layer.
      layerId = targetDoc.activeLayers?.[0]?.id ?? targetDoc.layers?.[0]?.id;
    }
    if (typeof layerId !== "number") {
      throw new Error("writePixelLayer: could not determine new layer id.");
    }

    // 3. Build an ImageData from the RGBA buffer and write it into the new
    //    layer. `replace: true` overwrites the (empty) layer's pixels.
    //    `targetBounds` is placed at (left, top) so the result lands directly
    //    over the source region rather than at the document's top-left corner.
    const imageData = await imaging.createImageDataFromBuffer(rgba, {
      width,
      height,
      components: 4,
      chunky: true,
      colorProfile: "sRGB IEC61966-2.1",
      colorSpace: "RGB",
    });
    try {
      await imaging.putPixels({
        documentID: documentId,
        layerID: layerId,
        imageData,
        replace: true,
        targetBounds: { left, top, right: left + width, bottom: top + height },
      });
    } finally {
      // 4. Dispose the ImageData to free its backing buffer.
      try { imageData.dispose?.(); } catch { /* ignore */ }
    }
  });
}

/**
 * Per-pool layer payload for `writePoolGroupLayers`. Each entry becomes
 * one pixel layer inside the group, named `name`, with the pool's pixels
 * at full alpha and all other pixels transparent.
 */
export interface PoolLayerData {
  /** Pool id — informational only; not stamped into PS (we name the layer). */
  poolId?: number;
  /** Layer name shown in the Photoshop Layers panel. */
  name: string;
  /** Tightly-packed RGBA, length === width*height*4. Pool pixels at α=255,
   *  all other pixels (0,0,0,0). */
  rgba: Uint8Array;
}

/**
 * Write the smash result as a Photoshop layer group containing one pixel
 * layer per pool. Each layer carries that pool's recolored pixels at full
 * alpha; everywhere else is transparent. The layers are created top → bottom
 * in array order — i.e. `layers[0]` ends up at the TOP of the group, so the
 * caller should pass smaller / more specific pools FIRST and larger swaths
 * LAST so the big pool sits at the bottom and the small ones overlay it.
 *
 * Sister of `writePixelLayer`. Same UXP Imaging API requirements (Photoshop
 * 24.2+). All work happens inside a single `executeAsModal`:
 *   1. Make `documentId` the active document (cross-doc safety).
 *   2. Create an empty layer group ("layerSection") with `groupName`.
 *      After this call the group is the active selection, so newly-made
 *      layers land INSIDE it automatically.
 *   3. For each pool entry, in order:
 *        a. Create a pixel layer via batchPlay "make layer".
 *        b. Capture its layerID (same fallback as writePixelLayer).
 *        c. Build an ImageData with createImageDataFromBuffer.
 *        d. putPixels into the layer with replace:true at (left,top).
 *        e. Set the layer's name via batchPlay set.
 *        f. Dispose the ImageData (try/finally).
 *
 * CANNOT be unit-tested (no Photoshop in vitest). Things to verify by hand:
 *   - A new group `groupName` appears at the top of the doc's layer stack.
 *   - The group contains one pixel layer per pool entry, top→bottom in
 *     array order.
 *   - Each layer's pool pixels are visible, surrounding pixels transparent.
 *   - Toggling layer visibility hides only that pool's contribution.
 *   - Re-running output a second time creates a SECOND group (this function
 *     never reuses an existing group — that's by design).
 *   - All layers/group remain after the modal scope completes (no PS undo
 *     fold-back).
 *   - Works when the target document isn't the currently-active document.
 *
 * @param documentId  Target document id (not necessarily the active doc).
 * @param groupName   Name for the new layer group ("layerSection").
 * @param layers      Per-pool layers in top→bottom render order.
 * @param width       Pixel width — every `layers[i].rgba` must be this wide.
 * @param height      Pixel height — every `layers[i].rgba` must be this tall.
 * @param left        Document x of the buffer's top-left (offset for putPixels).
 * @param top         Document y of the buffer's top-left.
 */
export async function writePoolGroupLayers(
  documentId: number,
  groupName: string,
  layers: PoolLayerData[],
  width: number,
  height: number,
  left = 0,
  top = 0,
): Promise<void> {
  if (!imaging || !imaging.putPixels || !imaging.createImageDataFromBuffer) {
    throw new Error("Imaging API unavailable. Requires Photoshop 24.2+.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`writePoolGroupLayers: invalid dimensions ${width}x${height}.`);
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error("writePoolGroupLayers: no pool layers to write.");
  }
  const expected = width * height * 4;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l || !l.rgba || l.rgba.length !== expected) {
      throw new Error(
        `writePoolGroupLayers: layer[${i}] rgba length ${l?.rgba?.length} does not match width*height*4 (${expected}).`,
      );
    }
    if (typeof l.name !== "string" || l.name.length === 0) {
      throw new Error(`writePoolGroupLayers: layer[${i}] missing name.`);
    }
  }

  await executeAsModal("Color Smash group", async () => {
    // 1. Target the requested document. Mirror writePixelLayer's safety:
    //    we may be called with a doc that isn't currently active.
    const targetDoc = (app.documents ?? []).find((d: any) => d.id === documentId);
    if (!targetDoc) {
      throw new Error(`writePoolGroupLayers: no open document with id ${documentId}.`);
    }
    if (app.activeDocument?.id !== documentId) {
      app.activeDocument = targetDoc;
    }

    // 2. Make an empty layer group ("layerSection"). After this call the
    //    group exists at the top of the layer stack AND is the active
    //    selection — so any layers we create next land INSIDE the group
    //    automatically (Photoshop's standard "new layer into the active
    //    container" behaviour).
    await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "layerSection" }],
      using: { _obj: "layerSection", name: groupName },
      _options: { dialogOptions: "dontDisplay" },
    }], {});

    // 3. Build each pool layer inside the group, top→bottom in array order.
    //    Each "make layer" call lands a fresh layer INSIDE the group because
    //    the group is the active container. The newly-made layer becomes the
    //    active layer; we capture its id from the play result (with the same
    //    activeLayers fallback writePixelLayer uses).
    for (const entry of layers) {
      const makeResult = await action.batchPlay([{
        _obj: "make",
        _target: [{ _ref: "layer" }],
        using: { _obj: "layer", name: entry.name },
        _options: { dialogOptions: "dontDisplay" },
      }], {});

      let layerId: number | undefined =
        (makeResult?.[0]?.layerID as number | undefined)
        ?? (makeResult?.[0]?.layerSectionStart as number | undefined);
      if (typeof layerId !== "number") {
        layerId = targetDoc.activeLayers?.[0]?.id ?? targetDoc.layers?.[0]?.id;
      }
      if (typeof layerId !== "number") {
        throw new Error(`writePoolGroupLayers: could not determine layer id for "${entry.name}".`);
      }

      const imageData = await imaging.createImageDataFromBuffer(entry.rgba, {
        width,
        height,
        components: 4,
        chunky: true,
        colorProfile: "sRGB IEC61966-2.1",
        colorSpace: "RGB",
      });
      try {
        await imaging.putPixels({
          documentID: documentId,
          layerID: layerId,
          imageData,
          replace: true,
          targetBounds: { left, top, right: left + width, bottom: top + height },
        });
        // Re-affirm the layer name via batchPlay set. The "make layer"
        // descriptor above already includes the name, but some PS builds
        // ignore the `using.name` field for raw pixel layers — the explicit
        // set is the defensive fix.
        try {
          await action.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "layer", _id: layerId }],
            to: { _obj: "layer", name: entry.name },
            _options: { dialogOptions: "dontDisplay" },
          }], {});
        } catch { /* non-fatal — name is decorative */ }
      } finally {
        try { imageData.dispose?.(); } catch { /* ignore */ }
      }
    }
  });
}

export { action, app };
