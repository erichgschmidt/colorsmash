// The "smash" — pool-wise color transfer.
//
// Given a SOURCE image and a TARGET image both broken into color pools, plus a
// correspondence pairing each target pool with a source donor pool, recolor the
// target so every region adopts its donor's color character.
//
// Design — sub-swatch-level transfer. Matching whole pools by their mean color
// would flatten internal variation. Instead each pool is split into its
// sub-colors (the structured sub-palette plus any noise swatches), the target's
// sub-colors are paired with the donor's by LIGHTNESS RANK, and each pair
// yields a Lab delta. Per pixel we blend those deltas by inverse Lab distance
// so there is no hard banding at sub-swatch boundaries.

import type { SegmentResult, Pool, SubSwatch } from "./clusters";
import { labToRgb } from "./clusters";
import { rgbToLab } from "./palette";
import type { Correspondence } from "./match";

export interface TransferOptions {
  strength: number; // 0..1 — blend between the original and the fully transferred result
}

// A 3-component CIE Lab delta to add to a pixel's Lab value.
interface LabDelta {
  dL: number;
  dA: number;
  dB: number;
}

// One target sub-color paired with its lightness-ranked donor.
interface SubMapping {
  // Target sub-color Lab — the anchor used for inverse-distance weighting.
  labL: number;
  labA: number;
  labB: number;
  delta: LabDelta; // donor Lab − target Lab
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Combined sub-color list for a pool: structured sub-palette + noise swatches.
function poolSubColors(pool: Pool): SubSwatch[] {
  const list = pool.subPalette.slice();
  if (pool.noise) list.push(...pool.noise.swatches);
  return list;
}

// Sort a sub-color list by lightness (labL) ascending. Returns a new array.
function sortByLightness(swatches: SubSwatch[]): SubSwatch[] {
  return swatches.slice().sort((a, b) => a.labL - b.labL);
}

// Pair every target sub-color with a donor sub-color by lightness RANK.
//
// When the two lists are the same length this is rank i → rank i. When they
// differ, the target rank is normalized to 0..1 (targetRank/(Tlen−1)) and that
// position is projected onto the donor list, picking the nearest donor rank —
// so every target sub-color always gets a donor, dark→dark and light→light.
function buildSubMappings(
  targetSubs: SubSwatch[],
  sourceSubs: SubSwatch[],
): SubMapping[] {
  const t = sortByLightness(targetSubs);
  const s = sortByLightness(sourceSubs);
  if (t.length === 0 || s.length === 0) return [];

  const tLen = t.length;
  const sLen = s.length;
  const mappings: SubMapping[] = [];
  for (let i = 0; i < tLen; i++) {
    // Normalized rank position of this target sub-color, 0..1.
    const pos = tLen === 1 ? 0 : i / (tLen - 1);
    // Nearest donor rank at the same normalized position.
    const sIdx =
      sLen === 1 ? 0 : Math.round(pos * (sLen - 1));
    const ts = t[i];
    const ss = s[sIdx];
    mappings.push({
      labL: ts.labL,
      labA: ts.labA,
      labB: ts.labB,
      delta: {
        dL: ss.labL - ts.labL,
        dA: ss.labA - ts.labA,
        dB: ss.labB - ts.labB,
      },
    });
  }
  return mappings;
}

// Soft-weighted Lab delta for a pixel: each target sub-color's delta is weighted
// by inverse Lab distance (1/(1+d²)) from the pixel to that sub-color, then the
// weighted deltas are normalized and summed. This avoids hard banding at
// sub-swatch boundaries — a pixel halfway between two sub-colors gets a smooth
// blend of their two deltas.
function softDelta(
  L: number,
  a: number,
  b: number,
  mappings: SubMapping[],
): LabDelta {
  let wSum = 0;
  let dL = 0;
  let dA = 0;
  let dB = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const ddl = L - m.labL;
    const dda = a - m.labA;
    const ddb = b - m.labB;
    const d2 = ddl * ddl + dda * dda + ddb * ddb;
    const w = 1 / (1 + d2);
    wSum += w;
    dL += w * m.delta.dL;
    dA += w * m.delta.dA;
    dB += w * m.delta.dB;
  }
  if (wSum <= 0) return { dL: 0, dA: 0, dB: 0 };
  return { dL: dL / wSum, dA: dA / wSum, dB: dB / wSum };
}

// Recolor the target image. Both `targetRgba` and `targetResult.labels` are at
// the SAME resolution (the segmentation resolution). Returns a new recolored
// RGBA buffer of the same dimensions; alpha is preserved everywhere.
export function transferColors(
  targetRgba: Uint8Array,
  width: number,
  height: number,
  targetResult: SegmentResult,
  sourceResult: SegmentResult,
  correspondence: Correspondence,
  opts: TransferOptions,
): Uint8Array {
  const out = targetRgba.slice();
  const strength = opts.strength < 0 ? 0 : opts.strength > 1 ? 1 : opts.strength;

  // Index source pools by id for donor lookup.
  const sourceById = new Map<number, Pool>();
  for (const p of sourceResult.pools) sourceById.set(p.id, p);

  // Index donor source pool id by target pool id.
  const donorByTarget = new Map<number, number>();
  for (const m of correspondence.matches) {
    donorByTarget.set(m.targetPoolId, m.sourcePoolId);
  }

  // Precompute per-target-pool sub-color mappings. A pool with no usable match
  // or no donor sub-colors gets an empty mapping list → identity (unchanged).
  const mappingsByPool = new Map<number, SubMapping[]>();
  for (const targetPool of targetResult.pools) {
    const donorId = donorByTarget.get(targetPool.id);
    if (donorId === undefined) {
      mappingsByPool.set(targetPool.id, []);
      continue;
    }
    const donor = sourceById.get(donorId);
    if (!donor) {
      mappingsByPool.set(targetPool.id, []);
      continue;
    }
    mappingsByPool.set(
      targetPool.id,
      buildSubMappings(poolSubColors(targetPool), poolSubColors(donor)),
    );
  }

  // Strength 0 is a pure pass-through; skip the per-pixel work entirely.
  if (strength === 0) return out;

  const labels = targetResult.labels;
  const pxCount = width * height;
  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    const alpha = targetRgba[o + 3];
    const poolId = labels[i];

    // Transparent pixels (label −1 or low alpha) pass through unchanged.
    if (poolId < 0 || alpha < 128) continue;

    const mappings = mappingsByPool.get(poolId);
    if (!mappings || mappings.length === 0) continue; // no transfer for this pool

    const r0 = targetRgba[o];
    const g0 = targetRgba[o + 1];
    const b0 = targetRgba[o + 2];

    const [L, a, b] = rgbToLab(r0, g0, b0);
    const d = softDelta(L, a, b, mappings);
    const [tr, tg, tb] = labToRgb(L + d.dL, a + d.dA, b + d.dB);

    // Blend original → transferred by strength.
    out[o] = clamp255(Math.round(r0 + (tr - r0) * strength));
    out[o + 1] = clamp255(Math.round(g0 + (tg - g0) * strength));
    out[o + 2] = clamp255(Math.round(b0 + (tb - b0) * strength));
    // out[o + 3] already equals the original alpha (out is a copy).
  }

  return out;
}
