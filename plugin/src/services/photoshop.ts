// All Photoshop DOM + batchPlay calls live here. Keeps the algorithm core pure-TS / testable.

import { app, action, imaging, core } from "photoshop";

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8Array;     // Always RGBA, tightly packed, top-left origin.
  bounds: { left: number; top: number; right: number; bottom: number };
}

export function getActiveDoc() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No active document.");
  return doc;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

export function getSelectionBounds(): Rect | null {
  const doc = getActiveDoc();
  const sel = doc.selection;
  // sel.bounds may be undefined when no marching-ants selection exists.
  const b = sel?.bounds;
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
  // Free the native ImageData buffer.
  if (id.dispose) id.dispose();

  const lb = layer.bounds;
  const bounds = sourceBounds ?? { left: lb.left, top: lb.top, right: lb.right, bottom: lb.bottom };
  return { width: w, height: h, data: rgba, bounds };
}

// Returns the rect to use for stat sampling: intersection of layer bounds and active selection,
// or the full layer bounds if there's no selection (or no overlap).
export function statsRectForLayer(layer: any): Rect {
  const lb: Rect = { left: layer.bounds.left, top: layer.bounds.top, right: layer.bounds.right, bottom: layer.bounds.bottom };
  const sel = getSelectionBounds();
  if (!sel) return lb;
  return intersect(lb, sel) ?? lb;
}

export async function writeLayerPixels(layer: any, buf: PixelBuffer): Promise<void> {
  const imageData = await imaging.createImageDataFromBuffer(buf.data, {
    width: buf.width,
    height: buf.height,
    components: 4,
    colorSpace: "RGB",
    colorProfile: "sRGB IEC61966-2.1",
  });
  await imaging.putPixels({
    documentID: getActiveDoc().id,
    layerID: layer.id,
    imageData,
    targetBounds: buf.bounds,
  });
  if (imageData.dispose) imageData.dispose();
}

export async function executeAsModal<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return await core.executeAsModal(fn, { commandName: name });
}

export const GROUP_NAME = "[Color Smash]";

export function findExistingGroup(): any | null {
  const doc = getActiveDoc();
  const walk = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l.name === GROUP_NAME) return l;
      if (l.layers && l.layers.length) {
        const hit = walk(l.layers);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(doc.layers);
}

export async function deleteLayer(layer: any): Promise<void> {
  await layer.delete();
}

// Wraps a layer into a new group named GROUP_NAME using the DOM API (more reliable than batchPlay).
export async function groupLayer(layer: any): Promise<any> {
  const doc = getActiveDoc();
  const group = await doc.createLayerGroup({ name: GROUP_NAME });
  // Move the layer into the group. ElementPlacement.PLACEINSIDE = "placeInside".
  await layer.move(group, "placeInside");
  return group;
}

// Delete every [Color Smash] group AND its children. Some UXP versions orphan children
// when a group is deleted — explicitly delete children first.
export async function purgeColorSmashArtifacts(): Promise<number> {
  const doc = getActiveDoc();
  let n = 0;
  const collect = (layers: any[], out: any[]) => {
    for (const l of layers) {
      if (l.name === GROUP_NAME) out.push(l);
      else if (l.layers && l.layers.length) collect(l.layers, out);
    }
  };
  const groups: any[] = [];
  collect(doc.layers, groups);
  for (const g of groups) {
    try {
      const children = [...(g.layers ?? [])];
      for (const c of children) { try { await c.delete(); } catch { /* ignore */ } }
      await g.delete();
      n++;
    } catch { /* ignore */ }
  }
  return n;
}

export { action, app };

// Write a .cube file into the plugin's data folder. Returns the path + raw bytes — Color Lookup
// batchPlay needs both (file path for display + inline bytes as Uint8Array).
export async function writeLutFile(text: string, filename = "color-smash.cube"): Promise<{ path: string; bytes: Uint8Array }> {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  const file = await dataFolder.createFile(filename, { overwrite: true });
  await file.write(text, { format: uxp.storage.formats.utf8 });
  return { path: file.nativePath, bytes: stringToUtf8(text) };
}

function stringToUtf8(s: string): Uint8Array {
  // Cube files are pure ASCII, so charCodeAt is safe and fast.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

// Create a Color Lookup adjustment layer, then set it with the inline LUT bytes.
// Targets the new layer by ID to avoid ambiguity in `targetEnum`.
export async function createColorLookupLayer(cube: { path: string; bytes: Uint8Array }, name = "Color Smash LUT"): Promise<any> {
  const doc = getActiveDoc();

  await action.batchPlay([{
    _obj: "make",
    _target: [{ _ref: "adjustmentLayer" }],
    using: { _obj: "adjustmentLayer", type: { _obj: "colorLookup" }, name },
  }], {});

  const newLayer = doc.activeLayers?.[0] ?? doc.layers[0];
  if (!newLayer) throw new Error("Could not locate newly created Color Lookup layer.");

  const setResult = await action.batchPlay([{
    _obj: "set",
    _target: [{ _ref: "adjustmentLayer", _id: newLayer.id }],
    to: {
      _obj: "colorLookup",
      lookupType: { _enum: "colorLookupType", _value: "3DLUT" },
      LUTFormat: { _enum: "LUTFormatType", _value: "LUTFormatCUBE" },
      dataOrder: { _enum: "colorLookupOrder", _value: "rgbOrder" },
      tableOrder: { _enum: "colorLookupOrder", _value: "bgrOrder" },
      LUT3DFileName: cube.path,
      LUT3DFileData: cube.bytes.buffer,
      name: cube.path,
      dither: true,
    },
  }], {});
  // Surface what PS returned for diagnostics.
  console.log("ColorSmash set result:", JSON.stringify(setResult));
  return newLayer;
}
