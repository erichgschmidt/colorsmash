// Target-palette mask generation + attachment, shared between Curves Apply
// and LUT Apply paths. Same Lab cluster assignment + Lorentzian soft-blend
// the matched preview uses, just at full target resolution.
//
// Mathematical model:
//   For each target pixel:
//     - Convert sRGB → linear → XYZ → Lab
//     - softness == 0: nearest cluster (Euclidean Lab) → mask = clamp01(weight) × 255
//     - softness > 0:  Lorentzian falloff 1/(1+d²/σ²) over all clusters,
//                       weighted sum of weights normalized by sum of falloffs
//
// σ² = (softness/100)² × 5000 — matches SIGMA_BASE_2_APPLY in histogramMatch.
//
// MUST stay numerically identical to the preview path
// (palette.precomputeEffectiveWeights) — any drift causes the baked mask
// to attenuate the curves/LUT differently than the preview shows.

import { PaletteSwatch } from "../core/palette";
import { PixelBuffer, Rect } from "../services/photoshop";

export interface TargetPaletteSpec {
  swatches: PaletteSwatch[];
  weights: number[];
  softness?: number; // 0..100, default 0
}

/** Returns true iff the user has dialed at least one weight away from 1 ± 0.01. */
export function targetWeightsActive(tp: TargetPaletteSpec): boolean {
  return tp.weights.some(w => Math.abs(w - 1) > 0.01);
}

/**
 * Build a grayscale layer-mask buffer from the target pixels + palette spec.
 * One byte per pixel, where 255 = full effect (weight 1), 0 = no effect (weight 0).
 * Pixels with alpha < 128 produce mask=0 so the masked area matches transparent
 * regions.
 *
 * The output Uint8Array has length t.width * t.height.
 */
export function buildTargetPaletteMaskBytes(
  t: { data: Uint8Array | Uint8ClampedArray; width: number; height: number },
  tp: TargetPaletteSpec,
): Uint8Array {
  const k = tp.swatches.length;
  const softness = Math.max(0, Math.min(100, tp.softness ?? 0));
  const useSoft = softness > 0;
  const sigma2 = (softness / 100) * (softness / 100) * 5000;

  const wFloat = new Float32Array(k);
  const wByte = new Uint8Array(k);
  for (let i = 0; i < k; i++) {
    const w = Math.max(0, Math.min(1, tp.weights[i]));
    wFloat[i] = w;
    wByte[i] = Math.round(w * 255);
  }
  const cents = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    cents[i * 3]     = tp.swatches[i].labL;
    cents[i * 3 + 1] = tp.swatches[i].labA;
    cents[i * 3 + 2] = tp.swatches[i].labB;
  }
  const pxCount = t.width * t.height;
  const mask = new Uint8Array(pxCount);
  const srgbToLinear = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const f = (t0: number) => t0 > 0.008856 ? Math.cbrt(t0) : (7.787 * t0 + 16 / 116);
  const distBuf = new Float32Array(k);

  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    if (t.data[o + 3] < 128) { mask[i] = 0; continue; }
    const R = srgbToLinear(t.data[o]);
    const G = srgbToLinear(t.data[o + 1]);
    const B = srgbToLinear(t.data[o + 2]);
    const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
    const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
    const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
    const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
    const L = 116 * fy - 16, a = 500 * (fx - fy), b2 = 200 * (fy - fz);
    if (!useSoft) {
      // Hard nearest-cluster path.
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = L - cents[c * 3];
        const da = a - cents[c * 3 + 1];
        const db = b2 - cents[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      mask[i] = wByte[best];
    } else {
      // Soft Lorentzian blend over all clusters.
      let minD = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = L - cents[c * 3];
        const da = a - cents[c * 3 + 1];
        const db = b2 - cents[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        distBuf[c] = d;
        if (d < minD) minD = d;
      }
      const invS2 = 1 / sigma2;
      let sumG = 0, sumWG = 0;
      for (let c = 0; c < k; c++) {
        const g = 1 / (1 + (distBuf[c] - minD) * invS2);
        sumG += g;
        sumWG += g * wFloat[c];
      }
      const wf = sumG > 0 ? sumWG / sumG : 1;
      mask[i] = Math.max(0, Math.min(255, Math.round(wf * 255)));
    }
  }
  return mask;
}

/**
 * Attach a pre-computed mask byte array to a layer as its layer mask.
 * Uses imaging.putLayerMask which is the correct API for adjustment-layer
 * masks (imaging.putPixels targets pixel layers only).
 *
 * `bounds` should be the layer's bounds rect in document coordinates so PS
 * places the mask aligned to the layer.
 */
export async function attachLayerMask(
  docId: number,
  layerId: number,
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: Rect,
): Promise<void> {
  const { imaging } = require("photoshop");
  const maskImageData = await imaging.createImageDataFromBuffer(mask, {
    width, height, components: 1, chunky: true,
    colorProfile: "Gray Gamma 2.2", colorSpace: "Grayscale",
  });
  try {
    await imaging.putLayerMask({
      documentID: docId,
      layerID: layerId,
      imageData: maskImageData,
      targetBounds: bounds,
      replace: true,
    });
  } finally {
    if (maskImageData.dispose) maskImageData.dispose();
  }
}

/** Convenience: build + attach mask in one call. */
export async function applyTargetPaletteMaskToLayer(
  docId: number,
  layerId: number,
  t: PixelBuffer,
  tp: TargetPaletteSpec,
): Promise<void> {
  const mask = buildTargetPaletteMaskBytes(t, tp);
  await attachLayerMask(docId, layerId, mask, t.width, t.height, t.bounds);
}
