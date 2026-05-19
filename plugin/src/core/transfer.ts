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
//
// The transfer runs in three phases (see transferColors):
//   1. Build a per-pixel Lab DELTA FIELD instead of applying deltas inline.
//   2. Optionally BLUR that field (the `relax` control) so adjacent pools'
//      transforms cross-fade smoothly instead of meeting at a hard seam.
//   3. APPLY the (blurred) delta, optionally preserving the target's original
//      lightness (the `preserveLuminance` control), then blend by `strength`.

import type { SegmentResult, Pool, SubSwatch } from "./clusters";
import { labToRgb } from "./clusters";
import { rgbToLab } from "./palette";
import type { Correspondence } from "./match";

export interface TransferOptions {
  strength: number; // 0..1 — blend between the original and the fully transferred result
  relax?: number; // 0..1 — boundary softness; blurs the delta field (default 0 = hard pool edges)
  preserveLuminance?: number; // 0..1 — keep the target's original L; only a/b shift (default 0)
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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// relax 0..1 → box-blur radius in pixels. 0 means "no blur" (handled before
// this is consulted). The radius scales with image size so the relax softness
// looks the same at any resolution: at the 256px preference it lands at 14 px
// (the original tuning — 256·(14/256)=14, byte-identical to the old behavior),
// and a full-resolution image blurs by a proportionally larger amount. After
// three box passes 14 px gives an effective Gaussian sigma of ~12–16 px.
const BLUR_RADIUS_PER_EDGE = 14 / 256;
const BLUR_PASSES = 3;

// Nearest-neighbour upscale of a pool-label map. The segmentation runs at a
// small working resolution; to recolor an image at its real resolution the
// label map must be projected up to that size. For each full-res pixel (x,y)
// the matching segmentation pixel is `(floor(x·segW/fullW), floor(y·segH/fullH))`.
export function upscaleLabels(
  labels: Int32Array,
  segW: number,
  segH: number,
  fullW: number,
  fullH: number,
): Int32Array {
  const out = new Int32Array(fullW * fullH);
  for (let y = 0; y < fullH; y++) {
    const sy = Math.min(segH - 1, Math.floor((y * segH) / fullH));
    const srcRow = sy * segW;
    const dstRow = y * fullW;
    for (let x = 0; x < fullW; x++) {
      const sx = Math.min(segW - 1, Math.floor((x * segW) / fullW));
      out[dstRow + x] = labels[srcRow + sx];
    }
  }
  return out;
}

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

// One horizontal pass of an alpha-weighted box blur.
//
// `src`/`dst` are width*height channel buffers; `mask` is 1 for opaque pixels
// and 0 for transparent ones. Only opaque samples are averaged in, and the
// running window count is itself a sum of mask values — so transparent pixels
// neither contribute zero deltas nor pull the average toward the figure edge.
// Transparent pixels in `dst` are left at 0. O(width*height) per pass.
function boxBlurH(
  src: Float32Array,
  dst: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    // Prime the window over [−radius, radius], clamping to the row edges.
    for (let x = -radius; x <= radius; x++) {
      const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
      const m = mask[row + cx];
      sum += src[row + cx] * m;
      count += m;
    }
    for (let x = 0; x < width; x++) {
      dst[row + x] = count > 0 ? sum / count : 0;
      // Slide the window: drop the leftmost sample, add the next on the right.
      const outX = x - radius;
      const inX = x + radius + 1;
      const cOut = outX < 0 ? 0 : outX >= width ? width - 1 : outX;
      const cIn = inX < 0 ? 0 : inX >= width ? width - 1 : inX;
      const mOut = mask[row + cOut];
      const mIn = mask[row + cIn];
      sum += src[row + cIn] * mIn - src[row + cOut] * mOut;
      count += mIn - mOut;
    }
  }
}

// One vertical pass of an alpha-weighted box blur — mirror of boxBlurH.
function boxBlurV(
  src: Float32Array,
  dst: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y <= radius; y++) {
      const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
      const m = mask[cy * width + x];
      sum += src[cy * width + x] * m;
      count += m;
    }
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = count > 0 ? sum / count : 0;
      const outY = y - radius;
      const inY = y + radius + 1;
      const cOut = outY < 0 ? 0 : outY >= height ? height - 1 : outY;
      const cIn = inY < 0 ? 0 : inY >= height ? height - 1 : inY;
      const mOut = mask[cOut * width + x];
      const mIn = mask[cIn * width + x];
      sum += src[cIn * width + x] * mIn - src[cOut * width + x] * mOut;
      count += mIn - mOut;
    }
  }
}

// Alpha-weighted separable blur, run BLUR_PASSES times (a fast Gaussian
// approximation). `field` is mutated in place. A scratch buffer of the same
// length is allocated once and reused across passes.
function blurField(
  field: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  const scratch = new Float32Array(field.length);
  for (let p = 0; p < BLUR_PASSES; p++) {
    boxBlurH(field, scratch, mask, width, height, radius);
    boxBlurV(scratch, field, mask, width, height, radius);
  }
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
  const strength = clamp01(opts.strength);
  const relax = clamp01(opts.relax ?? 0);
  const preserveLuminance = clamp01(opts.preserveLuminance ?? 0);

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

  // ── Phase 1: build the per-pixel Lab delta field. ──
  // deltaL/A/B hold the soft-weighted sub-color delta for every opaque pixel
  // (0 for transparent pixels and pixels in pools with no donor). `opaque`
  // doubles as the alpha-weight mask for the blur in phase 2.
  const deltaL = new Float32Array(pxCount);
  const deltaA = new Float32Array(pxCount);
  const deltaB = new Float32Array(pxCount);
  const opaque = new Uint8Array(pxCount);

  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    const alpha = targetRgba[o + 3];
    const poolId = labels[i];

    // Transparent pixels (label −1 or low alpha) get a zero delta and are
    // excluded from the blur mask.
    if (poolId < 0 || alpha < 128) continue;
    opaque[i] = 1;

    const mappings = mappingsByPool.get(poolId);
    if (!mappings || mappings.length === 0) continue; // no transfer for this pool

    const [L, a, b] = rgbToLab(targetRgba[o], targetRgba[o + 1], targetRgba[o + 2]);
    const d = softDelta(L, a, b, mappings);
    deltaL[i] = d.dL;
    deltaA[i] = d.dA;
    deltaB[i] = d.dB;
  }

  // ── Phase 2: blur the delta field by `relax`. ──
  // relax 0 skips the blur entirely → byte-identical to the pre-relax behavior.
  if (relax > 0) {
    const radius = Math.max(
      1,
      Math.round(relax * Math.max(width, height) * BLUR_RADIUS_PER_EDGE),
    );
    blurField(deltaL, opaque, width, height, radius);
    blurField(deltaA, opaque, width, height, radius);
    blurField(deltaB, opaque, width, height, radius);
  }

  // ── Phase 3: apply the (blurred) delta and blend by strength. ──
  // preserveLuminance scales down the lightness delta only: =1 keeps the
  // target's original L (color-only shift), =0 applies the full L delta.
  const lScale = 1 - preserveLuminance;
  for (let i = 0; i < pxCount; i++) {
    if (opaque[i] === 0) continue; // transparent pixels pass through unchanged
    const o = i * 4;

    const r0 = targetRgba[o];
    const g0 = targetRgba[o + 1];
    const b0 = targetRgba[o + 2];

    const [L, a, b] = rgbToLab(r0, g0, b0);
    const [tr, tg, tb] = labToRgb(
      L + deltaL[i] * lScale,
      a + deltaA[i],
      b + deltaB[i],
    );

    // Blend original → transferred by strength.
    out[o] = clamp255(Math.round(r0 + (tr - r0) * strength));
    out[o + 1] = clamp255(Math.round(g0 + (tg - g0) * strength));
    out[o + 2] = clamp255(Math.round(b0 + (tb - b0) * strength));
    // out[o + 3] already equals the original alpha (out is a copy).
  }

  return out;
}
