// Per-dimension palette reduction in HSL. Each axis quantizes independently so heavy value
// posterization can coexist with smooth hue, etc. Operates on RGBA pixel buffers.
// Cannot be expressed as Curves (non-monotonic, cross-channel), so apply-side must bake to pixels.

export interface PaletteReduceOpts {
  valueSteps: number;   // 0 = off; otherwise quantize L to this many levels (2..32)
  hueBins: number;      // 0 = off; otherwise snap H to this many evenly-spaced bins
  chromaSteps: number;  // 0 = off; otherwise quantize S to this many levels
  outlierCullPct: number; // 0..50; drop hue bins with population below this %, snap to nearest kept
}

export const DEFAULT_PALETTE_REDUCE: PaletteReduceOpts = {
  valueSteps: 0, hueBins: 0, chromaSteps: 0, outlierCullPct: 0,
};

export function isPaletteReduceActive(o: PaletteReduceOpts): boolean {
  return o.valueSteps > 0 || o.hueBins > 0 || o.chromaSteps > 0 || o.outlierCullPct > 0;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1; else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

function quantize(v: number, steps: number): number {
  if (steps <= 1) return v;
  const i = Math.round(v * (steps - 1));
  return i / (steps - 1);
}

// Snap hue to nearest of N evenly-spaced bins on the circle.
function quantizeHue(h: number, bins: number): number {
  if (bins <= 1) return h;
  const idx = Math.round(h * bins) % bins;
  return idx / bins;
}

// Build a hue-population histogram (HUE_HIST_BINS bins) and return a remap from each fine bin
// to a "kept" bin (or itself if its population >= cutoff). Cutoff is a fraction of total pixels.
const HUE_HIST_BINS = 60;
function buildHueRemap(rgba: Uint8Array, cutoffFrac: number): Uint16Array {
  const counts = new Uint32Array(HUE_HIST_BINS);
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const [h, s] = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (s < 0.05) continue; // skip near-grays
    const bin = Math.floor(h * HUE_HIST_BINS) % HUE_HIST_BINS;
    counts[bin]++;
    total++;
  }
  const cutoff = total * cutoffFrac;
  const remap = new Uint16Array(HUE_HIST_BINS);
  // For each bin, find nearest kept bin (counts >= cutoff). Distance is circular.
  for (let i = 0; i < HUE_HIST_BINS; i++) {
    if (counts[i] >= cutoff) { remap[i] = i; continue; }
    let best = i, bestDist = HUE_HIST_BINS;
    for (let j = 0; j < HUE_HIST_BINS; j++) {
      if (counts[j] < cutoff) continue;
      const d = Math.min(Math.abs(j - i), HUE_HIST_BINS - Math.abs(j - i));
      if (d < bestDist) { bestDist = d; best = j; }
    }
    remap[i] = best;
  }
  return remap;
}

export function applyPaletteReduce(rgba: Uint8Array, opts: PaletteReduceOpts): Uint8Array {
  if (!isPaletteReduceActive(opts)) return rgba;

  const out = new Uint8Array(rgba.length);
  const useCull = opts.outlierCullPct > 0;
  const remap = useCull ? buildHueRemap(rgba, opts.outlierCullPct / 100) : null;

  for (let i = 0; i < rgba.length; i += 4) {
    let [h, s, l] = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);

    if (remap && s >= 0.05) {
      const bin = Math.floor(h * HUE_HIST_BINS) % HUE_HIST_BINS;
      const target = remap[bin];
      if (target !== bin) h = (target + 0.5) / HUE_HIST_BINS;
    }
    if (opts.hueBins > 0)     h = quantizeHue(h, opts.hueBins);
    if (opts.chromaSteps > 0) s = quantize(s, opts.chromaSteps);
    if (opts.valueSteps > 0)  l = quantize(l, opts.valueSteps);

    const [r, g, b] = hslToRgb(h, s, l);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = rgba[i + 3];
  }
  return out;
}
