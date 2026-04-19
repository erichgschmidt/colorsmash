// Generate a 3D LUT that bakes the Reinhard transfer (with weights) as a function of input RGB.
// Sampling on an N×N×N grid in sRGB[0..1]. Output is row-major with R as the fastest-varying axis,
// matching the .cube spec convention.

import { rgbToLab, labToRgb } from "./lab";
import { transferLab, LabStats, TransferWeights } from "./reinhard";

export interface LUT3D {
  size: number;       // edge length (e.g. 33)
  data: Float32Array; // length = size^3 * 3, ordered as [r0,g0,b0,r1,g1,b1,...] with R fastest
}

export function generateReinhardLUT(
  size: number,
  src: LabStats,
  tgt: LabStats,
  w: TransferWeights,
): LUT3D {
  if (size < 2 || size > 65) throw new Error(`LUT size ${size} out of range`);
  const data = new Float32Array(size * size * size * 3);
  const amt = clamp01(w.amount);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    const b = bi / (size - 1);
    for (let gi = 0; gi < size; gi++) {
      const g = gi / (size - 1);
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1);
        const lab = rgbToLab({ r, g, b });
        const out = transferLab(lab, src, tgt, w);
        const rgb = labToRgb(out);
        data[i++] = clamp01(lerp(r, rgb.r, amt));
        data[i++] = clamp01(lerp(g, rgb.g, amt));
        data[i++] = clamp01(lerp(b, rgb.b, amt));
      }
    }
  }
  return { size, data };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
