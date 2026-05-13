// Pro Smash Engine — 3D LUT bake and .cube serialization.
// Samples applyTransform across an N³ grid and emits Adobe .cube text.
// Output is portable to PS Color Lookup, Premiere, Resolve, and any
// standards-compliant LUT consumer (R varies fastest, per the .cube spec).

import { applyTransform } from './transform';
import type { SmashEngineOutput } from './transform';

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
  /** Reference to the SmashEngineOutput that produced this LUT. */
  readonly source: SmashEngineOutput;
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
export function serializeSmashCube(lut: SmashLut, title = 'ColorSmash'): string {
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
