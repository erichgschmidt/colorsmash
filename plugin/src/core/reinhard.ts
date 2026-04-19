// Reinhard et al. 2001 — Color Transfer between Images, with per-axis weighting.

import { Lab, rgbToLab, labToRgb } from "./lab";

export interface LabStats { muL: number; muA: number; muB: number; sL: number; sA: number; sB: number; }

export interface TransferWeights {
  amount: number;       // 0..1 master fade
  luminance: number;    // 0..1 strength of L transfer
  chroma: number;       // 0..1 strength of a/b transfer (Color Intensity)
  neutralize: number;   // 0..1 pull a/b mean toward 0 (gray-world)
}

export const DEFAULT_WEIGHTS: TransferWeights = {
  amount: 1, luminance: 1, chroma: 1, neutralize: 0,
};

export function computeLabStats(rgba: Uint8Array): LabStats {
  let n = 0, sumL = 0, sumA = 0, sumB = 0, sum2L = 0, sum2A = 0, sum2B = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const lab = rgbToLab({ r: rgba[i] / 255, g: rgba[i + 1] / 255, b: rgba[i + 2] / 255 });
    sumL += lab.L; sumA += lab.a; sumB += lab.b;
    sum2L += lab.L * lab.L; sum2A += lab.a * lab.a; sum2B += lab.b * lab.b;
    n++;
  }
  if (n === 0) throw new Error("No opaque pixels.");
  const muL = sumL / n, muA = sumA / n, muB = sumB / n;
  const vL = Math.max(0, sum2L / n - muL * muL);
  const vA = Math.max(0, sum2A / n - muA * muA);
  const vB = Math.max(0, sum2B / n - muB * muB);
  return { muL, muA, muB, sL: Math.sqrt(vL), sA: Math.sqrt(vA), sB: Math.sqrt(vB) };
}

const EPS = 1e-6;

// Per-axis transfer with weights. Each weight blends between identity and full Reinhard for that axis.
export function transferLab(target: Lab, src: LabStats, tgt: LabStats, w: TransferWeights): Lab {
  const fullL = (target.L - tgt.muL) * (src.sL / Math.max(EPS, tgt.sL)) + src.muL;
  const fullA = (target.a - tgt.muA) * (src.sA / Math.max(EPS, tgt.sA)) + src.muA;
  const fullB = (target.b - tgt.muB) * (src.sB / Math.max(EPS, tgt.sB)) + src.muB;

  const L = lerp(target.L, fullL, w.luminance);
  let a = lerp(target.a, fullA, w.chroma);
  let b = lerp(target.b, fullB, w.chroma);

  // Neutralize: pull current pixel a/b mean toward 0 by `neutralize` strength.
  // Simplest: shift by -muA/-muB of the *current* (post-transfer) mean estimate, here using src means as proxy.
  if (w.neutralize > 0) {
    a -= src.muA * w.neutralize;
    b -= src.muB * w.neutralize;
  }

  return { L, a, b };
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

export function applyReinhard(targetRgba: Uint8Array, src: LabStats, tgt: LabStats, w: TransferWeights = DEFAULT_WEIGHTS): void {
  const amt = Math.max(0, Math.min(1, w.amount));
  for (let i = 0; i < targetRgba.length; i += 4) {
    const orig = { r: targetRgba[i] / 255, g: targetRgba[i + 1] / 255, b: targetRgba[i + 2] / 255 };
    const lab = rgbToLab(orig);
    const out = transferLab(lab, src, tgt, w);
    const rgb = labToRgb(out);
    targetRgba[i]     = clamp8(lerp(orig.r, rgb.r, amt) * 255);
    targetRgba[i + 1] = clamp8(lerp(orig.g, rgb.g, amt) * 255);
    targetRgba[i + 2] = clamp8(lerp(orig.b, rgb.b, amt) * 255);
  }
}

function clamp8(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}
