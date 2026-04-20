// Map Reinhard Lab stats → PS adjustment-layer parameters. Pure TS, testable.
//
// 6-layer stack (top→bottom = applied last→first by PS):
//   1. Curves master    — luminance affine (L mean + slope)
//   2. Color Balance    — shadows/mids/highlights cast shifts
//   3. Hue/Saturation   — master chroma σ scale
//   4. Selective Color  — per-family hue refinement (catches what CB+HueSat miss)
//
// All weights blend identity → full Reinhard.

import { rgbToLab } from "./lab";
import type { LabStats, TransferWeights } from "./reinhard";

export interface StackParams {
  curvesMaster: { input: number; output: number }[];
  colorBalance: {
    shadows:    { cyanRed: number; magentaGreen: number; yellowBlue: number };
    midtones:   { cyanRed: number; magentaGreen: number; yellowBlue: number };
    highlights: { cyanRed: number; magentaGreen: number; yellowBlue: number };
  };
  hueSat: { saturation: number };
  selective: {
    reds:     { cyan: number; magenta: number; yellow: number; black: number };
    yellows:  { cyan: number; magenta: number; yellow: number; black: number };
    greens:   { cyan: number; magenta: number; yellow: number; black: number };
    cyans:    { cyan: number; magenta: number; yellow: number; black: number };
    blues:    { cyan: number; magenta: number; yellow: number; black: number };
    magentas: { cyan: number; magenta: number; yellow: number; black: number };
    neutrals: { cyan: number; magenta: number; yellow: number; black: number };
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function zoneCB(targetL: number, src: LabStats, tgt: LabStats, w: TransferWeights) {
  const wC = w.chroma * w.amount;
  const aOut = lerp(tgt.muA, src.muA, wC);
  const bOut = lerp(tgt.muB, src.muB, wC);
  const aDelta = aOut - tgt.muA;
  const bDelta = bOut - tgt.muB;
  const t = clamp(targetL / 100, 0, 1);
  const zoneWeight = 0.5 + 0.5 * Math.cos(Math.PI * Math.abs(t - 0.5) * 2);
  return {
    cyanRed:      clamp(Math.round(aDelta * 1.2 * zoneWeight), -100, 100),
    magentaGreen: 0,
    yellowBlue:   clamp(Math.round(-bDelta * 1.2 * zoneWeight), -100, 100),
  };
}

// For each color family, derive Selective Color CMYK adjustments based on the residual
// chroma shift Reinhard wants to apply within that hue range. Family hue centers are in
// Lab a/b angle (0=red, 90=yellow, 180=green, 270=blue clockwise).
function selectiveColorRow(familyHueDeg: number, src: LabStats, tgt: LabStats, w: TransferWeights) {
  const wC = w.chroma * w.amount;
  // Reinhard's net a/b shift toward source mean.
  const aShift = (src.muA - tgt.muA) * wC;
  const bShift = (src.muB - tgt.muB) * wC;

  // Project shift onto the family hue direction. Familys aligned with shift get more correction.
  const hueRad = (familyHueDeg * Math.PI) / 180;
  const familyA = Math.cos(hueRad);
  const familyB = Math.sin(hueRad);
  const projection = aShift * familyA + bShift * familyB;
  const align = clamp(projection / 50, -1, 1); // normalize: ~50 Lab units = full strength

  // Convert to CMYK adjustments (heuristic, scaled small to act as fine-tuning).
  // Positive align = pulling this family TOWARD where source is in Lab a/b.
  const strength = Math.round(align * 15); // cap at ±15% so it's a tweak, not a sledgehammer
  return {
    cyan:    -strength,             // less cyan = more red
    magenta: Math.round(bShift * -0.3),
    yellow:  Math.round(bShift * 0.5),
    black:   0,
  };
}

export function mapToStack(src: LabStats, tgt: LabStats, w: TransferWeights): StackParams {
  const wL = w.luminance * w.amount;
  const wC = w.chroma * w.amount;

  // Master Curves — luminance affine.
  const slopeL = lerp(1, src.sL / Math.max(1e-3, tgt.sL), wL);
  const muLt255 = clamp(tgt.muL * 2.55, 0, 255);
  const muLs255 = clamp(lerp(tgt.muL, src.muL, wL) * 2.55, 0, 255);
  const out = (input: number) => clamp((input - muLt255) * slopeL + muLs255, 0, 255);
  const curvesMaster = [
    { input: 0,                   output: Math.round(out(0)) },
    { input: Math.round(muLt255), output: Math.round(out(muLt255)) },
    { input: 255,                 output: Math.round(out(255)) },
  ];

  const chromaRatioFull = ((src.sA + src.sB) / 2) / Math.max(1e-3, (tgt.sA + tgt.sB) / 2);
  const chromaRatio = lerp(1, chromaRatioFull, wC);

  // Avoid lint warning on unused import while keeping it for future per-pixel sampling.
  void rgbToLab;

  return {
    curvesMaster,
    colorBalance: {
      shadows:    zoneCB(25, src, tgt, w),
      midtones:   zoneCB(50, src, tgt, w),
      highlights: zoneCB(75, src, tgt, w),
    },
    hueSat: {
      saturation: clamp(Math.round((chromaRatio - 1) * 100), -100, 100),
    },
    selective: {
      reds:     selectiveColorRow(0,   src, tgt, w),
      yellows:  selectiveColorRow(90,  src, tgt, w),
      greens:   selectiveColorRow(180, src, tgt, w),
      cyans:    selectiveColorRow(180, src, tgt, w),
      blues:    selectiveColorRow(270, src, tgt, w),
      magentas: selectiveColorRow(315, src, tgt, w),
      neutrals: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
    },
  };
}
