// Starter recipe pack. v1.20.66.
//
// Bundled set of curated recipes loaded ONCE on first run when the user's
// history is empty. Each recipe focuses on a specific tonal/preset character
// (contrast, faded, warm, mono) rather than a specific palette — they're
// meant as starting points the user fine-tunes against their actual source.
//
// Implementation note: these recipes use NEUTRAL grayscale source swatches
// so the cluster identities don't conflict with real source palettes the
// user extracts later. The transform character lives in the preset choice +
// dimensions/zones/envelope sliders, not in the palette swatches.
//
// On first run (history empty + remember=true never triggered yet), MatchTab
// will pre-populate history with these entries, marked pinned + customName-d
// so they appear at the front and survive eviction.

import { HistoryEntry } from "./recentHistory";

/** Build a neutral 5-swatch grayscale palette (matches paletteCount default).
 *  Each swatch has equal prevalence (0.2) and Lab values approximating its
 *  grayscale level. */
function neutralPalette() {
  const lums = [25, 70, 128, 185, 230]; // shadows → highlights
  return lums.map(g => ({
    r: g, g: g, b: g,
    weight: 0.2,
    labL: (g / 255) * 100,
    labA: 0,
    labB: 0,
  }));
}

interface StarterRecipeSpec {
  customName: string;
  label: string;
  preset: "color" | "hue" | "hueOnly" | "saturationOnly" | "contrast";
  outputMode: "rgb" | "lab" | "lut";
  // Per-cluster user weights (5 entries, defaults to all 1).
  weights?: number[];
  // Envelope control points — luma input → output mapping curves.
  envelope?: Array<{ x: number; y: number }>;
  // Optional dimensions / zones tweaks.
  dimensions?: Record<string, any>;
  zones?: Record<string, any>;
}

const SPECS: StarterRecipeSpec[] = [
  {
    customName: "Punch — Contrast Lift",
    label: "RGB · Contrast · 5 swatches",
    preset: "contrast",
    outputMode: "rgb",
    // S-curve envelope: deepens shadows + brightens highlights.
    envelope: [
      { x: 0,   y: 0   },
      { x: 64,  y: 48  },
      { x: 128, y: 128 },
      { x: 192, y: 208 },
      { x: 255, y: 255 },
    ],
  },
  {
    customName: "Faded — Lifted Shadows",
    label: "RGB · Color · 5 swatches",
    preset: "color",
    outputMode: "rgb",
    // Crushed-blacks look popular in film emulation — shadows raise to a soft
    // gray instead of going pure black.
    envelope: [
      { x: 0,   y: 24  },
      { x: 64,  y: 70  },
      { x: 128, y: 130 },
      { x: 192, y: 200 },
      { x: 255, y: 248 },
    ],
  },
  {
    customName: "Warm Midtones",
    label: "RGB · Hue · 5 swatches",
    preset: "hue",
    outputMode: "rgb",
    // Bias the mids toward warmer ratios via cluster weights.
    weights: [0.7, 1.0, 1.2, 1.2, 0.9],
  },
  {
    customName: "Mono — Contrast B&W",
    label: "RGB · Contrast · 5 swatches",
    preset: "contrast",
    outputMode: "rgb",
    // Same S-curve as Punch but the preset's grayscale enforcement turns
    // the result into a punchy black-and-white.
    envelope: [
      { x: 0,   y: 0   },
      { x: 64,  y: 40  },
      { x: 128, y: 128 },
      { x: 192, y: 220 },
      { x: 255, y: 255 },
    ],
  },
];

/** Convert spec → HistoryEntry suitable for pushing into recentHistory.
 *  Uses a deterministic id seed so successive first-runs don't accumulate
 *  duplicates if the user clears + reinstalls. */
export function buildStarterRecipes(): HistoryEntry[] {
  return SPECS.map((spec, i) => {
    const swatches = neutralPalette();
    const colors = swatches.map(s => (s.r << 16) | (s.g << 8) | s.b);
    const weights = (spec.weights ?? [1, 1, 1, 1, 1]).map(w => Math.round(w * 100));
    return {
      id: `starter-${i + 1}`,
      timestamp: 0, // sentinel for "starter recipe" — sorted to back by recency
      label: spec.label,
      customName: spec.customName,
      pinned: true, // pinned so they survive ring-buffer eviction
      state: {
        xmpVersion: 1,
        toolVersion: "starter",
        preset: spec.preset,
        outputMode: spec.outputMode,
        colorSpace: spec.outputMode === "lab" ? "lab" : "rgb",
        paletteCount: 5,
        sourcePaletteSwatches: swatches,
        sourcePaletteWeights: spec.weights ?? [1, 1, 1, 1, 1],
        sourceSoftness: 0,
        // Recipes are source-only — leave target side empty.
        targetPaletteSwatches: [],
        targetPaletteWeights: [],
        targetSoftness: 0,
        selectionMode: "off",
        matchMode: "full",
        paletteAdaptive: false,
        envelope: spec.envelope,
        dimensions: spec.dimensions,
        zones: spec.zones,
        sourceDocId: null,
        sourceLayerId: null,
        targetDocId: null,
        targetLayerId: null,
      },
      signature: { colors, weights },
    } as HistoryEntry;
  });
}
