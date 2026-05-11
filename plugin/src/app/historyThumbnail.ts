// History strip thumbnail helper: render a small color-signature gradient for
// a Match LUT history entry. We don't have the full ChannelCurves stored in
// XMP (only palette swatches + weights + zones/envelope), so this is a CRUDE
// approximation: sweep 32 grays and map each to the swatch with the closest
// Lab-L value. Result reads visually as "what hues/values this LUT shifts
// toward" — fine for a thumbnail; nobody expects bit-perfect previews here.

import { LutLayerState, SerializedSwatch } from "./lutXmp";
import { applyPresetPostprocess, Preset } from "../core/histogramMatch";

const STOPS = 32;

function clamp255(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/** Pick the swatch whose Lab L-channel is closest to the target L value. */
function nearestSwatchByL(swatches: SerializedSwatch[], targetL: number): SerializedSwatch | null {
  let best: SerializedSwatch | null = null;
  let bestDist = Infinity;
  for (const s of swatches) {
    const L = Number.isFinite(s.labL) ? s.labL : 0;
    const d = Math.abs(L - targetL);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * Build a CSS linear-gradient string that previews this entry's transform.
 * See module docstring for the approximation strategy.
 */
export function lutGradientCSS(state: LutLayerState): string {
  // Prefer target swatches (the "output palette" the LUT pushes toward); fall
  // back to source swatches; fall back to grayscale passthrough.
  const palette: SerializedSwatch[] =
    (state.targetPaletteSwatches && state.targetPaletteSwatches.length > 0)
      ? state.targetPaletteSwatches
      : (state.sourcePaletteSwatches && state.sourcePaletteSwatches.length > 0)
        ? state.sourcePaletteSwatches
        : [];

  const preset: Preset = ((state.preset as Preset) || "color");

  // Build two pixel arrays: the original gray sweep, and the per-channel
  // palette-mapped sweep. applyPresetPostprocess wants both so blend math
  // (Color/Hue/Sat/Contrast) can use original L/S where the preset demands.
  const original = new Uint8Array(STOPS * 4);
  const mapped = new Uint8Array(STOPS * 4);
  for (let i = 0; i < STOPS; i++) {
    const g = Math.round((i / (STOPS - 1)) * 255);
    const targetL = (g / 255) * 100; // approximate Lab L from gray
    let r = g, gg = g, b = g;
    if (palette.length > 0) {
      const s = nearestSwatchByL(palette, targetL);
      if (s) {
        r = clamp255(s.r);
        gg = clamp255(s.g);
        b = clamp255(s.b);
      }
    }
    const o = i * 4;
    original[o] = g; original[o + 1] = g; original[o + 2] = g; original[o + 3] = 255;
    mapped[o] = r; mapped[o + 1] = gg; mapped[o + 2] = b; mapped[o + 3] = 255;
  }

  // Run preset blend math. For "color" this is a no-op passthrough; for
  // hue/saturationOnly/contrast it folds in the original luma/chroma.
  let out: Uint8Array;
  try {
    out = applyPresetPostprocess(original, mapped, preset);
  } catch {
    out = mapped;
  }

  const parts: string[] = [];
  for (let i = 0; i < STOPS; i++) {
    const o = i * 4;
    const pct = ((i / (STOPS - 1)) * 100).toFixed(6);
    parts.push(`rgb(${out[o]},${out[o + 1]},${out[o + 2]}) ${pct}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
