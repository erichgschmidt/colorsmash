// All Photoshop DOM + batchPlay calls live here. Keeps the algorithm core pure-TS / testable.

import { app, action, imaging, core } from "photoshop";

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8Array;     // Always RGBA, tightly packed, top-left origin.
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface Rect { left: number; top: number; right: number; bottom: number }

export const GROUP_NAME = "[Color Smash]";

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

export { action, app };
