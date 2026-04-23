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

export async function readLayerPixels(layer: any, sourceBounds?: Rect): Promise<PixelBuffer> {
  if (!imaging || !imaging.getPixels) {
    throw new Error("Imaging API unavailable. Requires Photoshop 24.2+.");
  }
  const opts: any = {
    documentID: getActiveDoc().id,
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

export { action, app };
