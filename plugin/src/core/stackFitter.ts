// Numerical fit: tune StackParams to minimize ΔE between simulated stack output and exact Reinhard.
// Uses coordinate descent on a fixed set of free parameters, starting from the heuristic params.

import { rgbToLab, labToRgb, deltaE76 } from "./lab";
import { transferLab, type LabStats, type TransferWeights } from "./reinhard";
import { simulateStack } from "./stackSimulator";
import type { StackParams } from "./reinhardToStack";

// Compute exact Reinhard output for an input RGB with the given weights (matches applyReinhard).
function exactReinhard(input: { r: number; g: number; b: number }, src: LabStats, tgt: LabStats, w: TransferWeights) {
  const lab = rgbToLab(input);
  const out = transferLab(lab, src, tgt, w);
  const rgb = labToRgb(out);
  const lerp = (a: number, b: number) => a + (b - a) * w.amount;
  return { r: lerp(input.r, rgb.r), g: lerp(input.g, rgb.g), b: lerp(input.b, rgb.b) };
}

// Halton-quasi-random RGB samples for a smooth, low-discrepancy coverage of the cube.
function haltonSamples(n: number): { r: number; g: number; b: number }[] {
  const halton = (i: number, base: number) => {
    let f = 1, r = 0;
    while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
    return r;
  };
  const out: { r: number; g: number; b: number }[] = [];
  for (let i = 1; i <= n; i++) out.push({ r: halton(i, 2), g: halton(i, 3), b: halton(i, 5) });
  return out;
}

function cost(samples: { r: number; g: number; b: number }[], targets: { L: number; a: number; b: number }[], params: StackParams): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sim = simulateStack(samples[i], params);
    const labSim = rgbToLab(sim);
    sum += deltaE76(labSim, targets[i]);
  }
  return sum / samples.length;
}

// Coordinate descent: for each tunable scalar, try ±step, accept the better. Halve step on plateau.
export function fitStack(
  initial: StackParams,
  src: LabStats,
  tgt: LabStats,
  w: TransferWeights,
  opts: { samples?: number; maxIters?: number; minStep?: number } = {},
): { params: StackParams; before: number; after: number; iters: number } {
  const N = opts.samples ?? 80;
  const maxIters = opts.maxIters ?? 40;
  const minStep = opts.minStep ?? 0.5;

  const samples = haltonSamples(N);
  const targets = samples.map(s => rgbToLab(exactReinhard(s, src, tgt, w)));

  // Tunables: index into a flattened param vector. Each entry has a scale (for stepping).
  const tunables: { get: () => number; set: (v: number) => void; step: number; lo: number; hi: number }[] = [];

  // Curves master: tweak each output value.
  for (let i = 0; i < initial.curvesMaster.length; i++) {
    const idx = i;
    tunables.push({
      get: () => initial.curvesMaster[idx].output,
      set: v => initial.curvesMaster[idx].output = Math.round(Math.max(0, Math.min(255, v))),
      step: 8, lo: 0, hi: 255,
    });
  }
  // Color Balance: each channel of each zone.
  for (const zone of ["shadows", "midtones", "highlights"] as const) {
    for (const ch of ["cyanRed", "magentaGreen", "yellowBlue"] as const) {
      tunables.push({
        get: () => initial.colorBalance[zone][ch],
        set: v => initial.colorBalance[zone][ch] = Math.round(Math.max(-100, Math.min(100, v))),
        step: 6, lo: -100, hi: 100,
      });
    }
  }
  // Hue/Sat saturation.
  tunables.push({
    get: () => initial.hueSat.saturation,
    set: v => initial.hueSat.saturation = Math.round(Math.max(-100, Math.min(100, v))),
    step: 5, lo: -100, hi: 100,
  });

  const before = cost(samples, targets, initial);
  let current = before;
  let iter = 0;
  let stepScale = 1.0;

  while (iter < maxIters) {
    iter++;
    let improved = false;
    for (const t of tunables) {
      const orig = t.get();
      const step = t.step * stepScale;
      if (step < minStep) continue;
      // Try +step
      t.set(orig + step);
      const upCost = cost(samples, targets, initial);
      // Try -step
      t.set(orig - step);
      const downCost = cost(samples, targets, initial);
      // Pick best
      if (upCost < current && upCost <= downCost) { t.set(orig + step); current = upCost; improved = true; }
      else if (downCost < current) { t.set(orig - step); current = downCost; improved = true; }
      else { t.set(orig); }
    }
    if (!improved) {
      stepScale *= 0.5;
      if (stepScale * Math.max(...tunables.map(t => t.step)) < minStep) break;
    }
  }

  return { params: initial, before, after: current, iters: iter };
}
