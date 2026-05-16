// Test Bake → real pixel layer.
//
// "Test Bake" renders the Smash engine's per-pixel ground truth (no 3D LUT,
// no trilinear interpolation, no grid quantization). Previously it only fed
// the small in-panel preview tile; this writes it as an actual pixel layer
// in the document so the user can compare it on-canvas against an Apply'd
// "Smash LUT" Color Lookup layer — a definitive A/B of the engine's intent
// vs the LUT path.
//
// The layer is written at the PREVIEW-tier resolution (the snapshot the
// engine ran on), so it lands at the document origin sized to that snapshot
// — a diagnostic artifact, not a full-res render. Named "Smash Test Bake"
// so it's unmistakable and easy to delete.

import { app, action, executeAsModal } from "../../services/photoshop";

const TEST_BAKE_LAYER_NAME = "Smash Test Bake";

export interface ApplySmashTestBakeResult {
  ok: boolean;
  layerName?: string;
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Create a new pixel layer and write `rgba` (tightly-packed RGBA, top-left
 * origin) into it via the UXP imaging API. Mirrors `targetMask.ts`'s
 * `createImageDataFromBuffer` usage and `applySmashLut.ts`'s executeAsModal
 * layer-creation pattern.
 */
export async function applySmashTestBake(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<ApplySmashTestBakeResult> {
  try {
    // imaging is fetched the same way targetMask.ts does — it isn't on the
    // photoshop.ts wrapper's export surface.
    const { imaging } = require("photoshop");
    if (!imaging || !imaging.putPixels || !imaging.createImageDataFromBuffer) {
      return { ok: false, error: "Imaging API unavailable (requires Photoshop 24.2+)." };
    }
    if (rgba.length < width * height * 4) {
      return { ok: false, error: "test bake buffer smaller than width×height×4." };
    }

    return await executeAsModal("Color Smash test bake", async () => {
      const doc = app?.activeDocument;
      if (!doc || typeof doc.id !== "number") {
        return { ok: false, error: "No active document." };
      }

      // Create an empty pixel layer (becomes the active layer).
      const makeResult = await action.batchPlay([{
        _obj: "make",
        _target: [{ _ref: "layer" }],
        using: { _obj: "layer", name: TEST_BAKE_LAYER_NAME },
      }], {});
      if (!makeResult || !makeResult[0] || makeResult[0].error) {
        return {
          ok: false,
          error: `make layer failed: ${makeResult?.[0]?.error ?? "unknown"}`,
        };
      }

      const layer = doc.activeLayers?.[0];
      if (!layer || typeof layer.id !== "number") {
        return { ok: false, error: "Could not resolve the new Test Bake layer." };
      }

      // Build an ImageData view over the RGBA buffer and write it into the
      // layer. `chunky: true` = interleaved RGBA; sRGB / RGB to match the
      // 8-bit bytes the engine produced.
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
          documentID: doc.id,
          layerID: layer.id,
          imageData,
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
