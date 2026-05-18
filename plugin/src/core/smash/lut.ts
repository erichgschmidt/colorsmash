// Pro Smash Engine — 3D LUT bake and .cube serialization.
// Samples applyTransform across an N³ grid and emits Adobe .cube text.
// Output is portable to PS Color Lookup, Premiere, Resolve, and any
// standards-compliant LUT consumer (R varies fastest, per the .cube spec).
//
// Also exports bakeTargetPerPixel — a diagnostic utility that runs
// applyTransform directly on every target pixel without the intervening
// LUT (no grid quantization, no interpolation). Used by the panel's
// "Test Bake" button to show the engine's ground-truth output, for
// side-by-side comparison against the LUT-applied canvas in PS.

import { applyTransform } from './transform';
import type { SmashEngineOutput } from './transform';
import { hash2u } from './stochasticBands';

// ────────── types ──────────

/** Supported LUT grid resolutions. 33 is the shipped product default. */
export type LutGridSize = 17 | 33 | 65;

/** Result of baking a Smash transform into a 3D LUT. */
export interface SmashLut {
  /** Grid resolution (17, 33, or 65). */
  readonly size: LutGridSize;
  /**
   * Flat row-major RGB float values in [0, 1].
   * Length is size³ × 3. Layout: r varies fastest, then g, then b.
   * (Matches .cube file format index order.)
   */
  readonly values: Float32Array;
  /** Reference to the SmashEngineOutput that produced this LUT. Optional —
   *  the v2 engine's bakeEngineLut result carries only `{ size, values }`,
   *  and serializeSmashCube never reads this field. */
  readonly source?: SmashEngineOutput;
}

// ────────── bake ──────────

/**
 * Bake a SmashEngineOutput to an N³ LUT by sampling applyTransform at every
 * grid point. Defaults to 33³ (the shipped product's standard).
 *
 * Performance: a 33³ bake samples 35937 grid points. Each sample is one
 * applyTransform call (typically <50µs). Total bake time: ~1-2 seconds on
 * a typical machine.
 */
export function bakeSmashLut(
  output: SmashEngineOutput,
  size: LutGridSize = 33,
): SmashLut {
  const total = size * size * size;
  const values = new Float32Array(total * 3);

  let offset = 0;
  // .cube order: r varies fastest (inner), then g, then b (outer).
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const rByte = Math.round((ri / (size - 1)) * 255);
        const gByte = Math.round((gi / (size - 1)) * 255);
        const bByte = Math.round((bi / (size - 1)) * 255);

        const [outR, outG, outB] = applyTransform(output, rByte, gByte, bByte);

        values[offset]     = Math.max(0, Math.min(1, outR / 255));
        values[offset + 1] = Math.max(0, Math.min(1, outG / 255));
        values[offset + 2] = Math.max(0, Math.min(1, outB / 255));
        offset += 3;
      }
    }
  }

  return { size, values, source: output };
}

// ────────── serialization ──────────

/**
 * Diagnostic / ground-truth bake: run applyTransform on every pixel of an
 * RGBA snap, with NO 3D LUT in the path. Returns a fresh RGBA Uint8Array
 * with the per-pixel transform output. Alpha is preserved as-is (skipped
 * pixels stay alpha-low; opaque pixels get the engine's exact output).
 *
 * Use case: side-by-side comparison against the LUT-applied PS canvas to
 * see whether the LUT's grid quantization + interpolation are losing
 * detail compared to the engine's intent. If "Test Bake" and the LUT
 * apply visibly differ, the difference is in LUT fidelity (resolution,
 * trilinear vs tetrahedral, ICC encoding) — not the engine math.
 *
 * Cost: O(width × height) applyTransform calls. At preview-tier 256² and
 * passes=1, ~50ms; at passes=4, ~200ms. Acceptable for an explicit
 * button click.
 */
export function bakeTargetPerPixel(
  engine: SmashEngineOutput,
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
      out[o]     = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = a;
      continue;
    }
    const [r, g, b] = applyTransform(engine, rgba[o], rgba[o + 1], rgba[o + 2]);
    out[o]     = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

/**
 * Phase 7 — per-pixel STOCHASTIC bake. Like bakeTargetPerPixel, but every
 * opaque pixel gets a per-pixel uniform `u = hash(x, y, seed)` threaded into
 * applyTransform, so the output carries the source's within-L grain instead
 * of the deterministic CDF rank-map. This is NOT a LUT — same RGB at
 * different coordinates produces different output — so there is no f(R,G,B)
 * to serialize to a .cube. `seed` (from the engine's stochastic control)
 * makes the grain reproducible and spatially stable.
 *
 * Cost: O(width × height) applyTransform calls — same order as
 * bakeTargetPerPixel. Use for the preview-tier render, not per slider frame.
 */
export function bakeTargetStochastic(
  engine: SmashEngineOutput,
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const total = width * height;
  if (rgba.length < total * 4) {
    throw new Error(
      `bakeTargetStochastic: rgba length ${rgba.length} smaller than ${total * 4} (width=${width}, height=${height}).`,
    );
  }
  const seed = engine.controls.colorization?.stochastic?.seed ?? 0xc01015;
  const out = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a < 128) {
      out[o]     = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = a;
      continue;
    }
    const x = i % width;
    const y = (i / width) | 0;
    const u = hash2u(x, y, seed);
    const [r, g, b] = applyTransform(engine, rgba[o], rgba[o + 1], rgba[o + 2], u);
    out[o]     = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

/**
 * Serialize a SmashLut to an Adobe .cube format string. Returns the text
 * content of a valid .cube file (caller writes it to disk).
 *
 * Note: core/histogramMatch.ts's generateLutCube requires a ChannelCurves
 * object and a Preset discriminant — neither is available here since Smash
 * applies arbitrary per-band blended transforms. We serialize directly.
 *
 * Format:
 *   TITLE "ColorSmash"
 *   LUT_3D_SIZE <N>
 *   DOMAIN_MIN 0 0 0
 *   DOMAIN_MAX 1 1 1
 *   <r> <g> <b>           (one line per grid point, N³ lines)
 *   ...
 */
export function serializeSmashCube(
  lut: { size: number; values: Float32Array },
  title = 'ColorSmash',
): string {
  const { size, values } = lut;
  const lines: string[] = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${size}`,
    `DOMAIN_MIN 0.0 0.0 0.0`,
    `DOMAIN_MAX 1.0 1.0 1.0`,
    '',
  ];

  const total = size * size * size;
  for (let i = 0; i < total; i++) {
    const r = values[i * 3].toFixed(6);
    const g = values[i * 3 + 1].toFixed(6);
    const b = values[i * 3 + 2].toFixed(6);
    lines.push(`${r} ${g} ${b}`);
  }

  return lines.join('\n') + '\n';
}
