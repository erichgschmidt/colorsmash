// Test Bake → real pixel layer.
//
// "Test Bake" renders the Smash engine's per-pixel ground truth (no 3D LUT,
// no trilinear interpolation, no grid quantization) and writes it as an
// actual "Smash Test Bake" pixel layer in the document — so the engine's
// true intent can be A/B'd on-canvas against an Apply'd "Smash LUT" Color
// Lookup layer.
//
// The layer is rendered at the target layer's FULL resolution and placed at
// the target's document bounds, so it overlays the target exactly. (The
// in-panel preview tile runs at preview-tier res; this layer is full-res.)

import { app, action, executeAsModal, readLayerPixels } from "../../services/photoshop";
import { applySmash, type SmashEngine } from "../../core/smash/engine";

const TEST_BAKE_LAYER_NAME = "Smash Test Bake";

export interface ApplySmashTestBakeResult {
  ok: boolean;
  layerName?: string;
  width?: number;
  height?: number;
  error?: string;
}

/** Find a layer by id anywhere in the doc tree (top-level + inside groups). */
function findLayerById(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (Array.isArray(l.layers)) {
      const found = findLayerById(l.layers, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Run applySmash on every opaque pixel of an RGBA buffer, with NO 3D LUT in
 * the path (no grid quantization, no interpolation). Returns a fresh RGBA
 * Uint8Array; transparent / near-transparent pixels pass through unchanged.
 */
function bakeTargetPerPixel(
  engine: SmashEngine,
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const total = width * height;
  if (rgba.length < total * 4) {
    throw new Error(
      `bakeTargetPerPixel: rgba length ${rgba.length} smaller than ${total * 4} (width=${width}, height=${height}).`,
    );
  }
  const out = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a < 128) {
      // Transparent / near-transparent — leave the pixel through unchanged.
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = a;
      continue;
    }
    const [r, g, b] = applySmash(engine, rgba[o], rgba[o + 1], rgba[o + 2]);
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

/**
 * Render the engine's per-pixel ground truth for the target layer at full
 * resolution and write it as a new pixel layer aligned to the target.
 */
export async function applySmashTestBake(
  engine: SmashEngine,
  docId: number,
  layerId: number,
): Promise<ApplySmashTestBakeResult> {
  try {
    const { imaging } = require("photoshop");
    if (!imaging || !imaging.putPixels || !imaging.createImageDataFromBuffer) {
      return { ok: false, error: "Imaging API unavailable (requires Photoshop 24.2+)." };
    }

    // Resolve the target document + layer (DOM read).
    let doc: any = null;
    try {
      const docs: any[] = Array.from((app?.documents as any) ?? []);
      doc = docs.find((d) => d && d.id === docId) ?? app?.activeDocument ?? null;
    } catch {
      doc = app?.activeDocument ?? null;
    }
    if (!doc || !Array.isArray(doc.layers)) {
      return { ok: false, error: "Could not resolve the target document." };
    }
    const layer = findLayerById(doc.layers, layerId);
    if (!layer) {
      return { ok: false, error: "Target layer not found (it may have been deleted)." };
    }

    return await executeAsModal("Color Smash test bake", async () => {
      // Full-res read of the (clean) target layer's own pixels.
      const buf = await readLayerPixels(layer, undefined, docId);
      const { data, width, height, bounds } = buf;

      // Per-pixel engine bake — no LUT, no interpolation, no quantization.
      // The v2 engine has a single deterministic path (no stochastic mode).
      const baked = bakeTargetPerPixel(engine, data, width, height);

      // Create an empty pixel layer (becomes the active layer).
      const makeResult = await action.batchPlay([{
        _obj: "make",
        _target: [{ _ref: "layer" }],
        using: { _obj: "layer", name: TEST_BAKE_LAYER_NAME },
      }], {});
      if (!makeResult || !makeResult[0] || makeResult[0].error) {
        return { ok: false, error: `make layer failed: ${makeResult?.[0]?.error ?? "unknown"}` };
      }
      const newLayer = doc.activeLayers?.[0];
      if (!newLayer || typeof newLayer.id !== "number") {
        return { ok: false, error: "Could not resolve the new Test Bake layer." };
      }

      // Write the baked pixels, placed at the target layer's document bounds
      // so the Test Bake layer overlays the target exactly.
      const imageData = await imaging.createImageDataFromBuffer(baked, {
        width,
        height,
        components: 4,
        chunky: true,
        colorProfile: "sRGB IEC61966-2.1",
        colorSpace: "RGB",
      });
      try {
        await imaging.putPixels({
          documentID: docId,
          layerID: newLayer.id,
          imageData,
          targetBounds: bounds,
          replace: true,
        });
      } finally {
        if (imageData && typeof imageData.dispose === "function") {
          imageData.dispose();
        }
      }

      return { ok: true, layerName: TEST_BAKE_LAYER_NAME, width, height };
    });
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
