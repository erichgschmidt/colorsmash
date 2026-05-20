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
import { vectorizeLabels } from "./cutwise/contour";

export interface TransferOptions {
  strength: number; // 0..1 — blend between the original and the fully transferred result
  relax?: number; // 0..1 — boundary softness; blurs the delta field (default 0 = hard pool edges)
  preserveLuminance?: number; // 0..1 — keep the target's original L; only a/b shift (default 0)
  anchors?: TransferAnchor[]; // pre-analysed focal anchors — see `TransferAnchor` below
  richness?: number; // 0..1 — 0 = sub-swatch averaged transfer (today, default),
                    //          1 = per-pixel sample-rank match against the donor
                    //              pool's actual source pixels. Pulls the donor's
                    //              raw a/b chroma variation into the target
                    //              instead of the few sub-swatch averages.
}

// A focal anchor is a pre-analysed local correspondence over a small region
// of the target image. Each anchor was produced by running a mini-Smash on
// the source pixels inside its falloff and the target pixels inside its
// falloff (see core/anchorAnalysis.ts) — so it carries its own per-pixel
// local target labels and its own per-local-pool sub-mappings. At transfer
// time, inside the anchor's falloff the local result REPLACES the global
// delta. The smoothstep falloff is now purely a SPATIAL GATE (where the
// local applies → smooth transition to global at the edge), not a colour
// blend with a single donor pool.
export interface TransferAnchor {
  targetX: number;      // 0..1 normalized over target width
  targetY: number;      // 0..1 normalized over target height
  radius: number;       // 0..1 normalized to max(width, height)
  // Per-pixel local target labels at TARGET resolution. -1 outside the
  // anchor's reach OR transparent. Inside the falloff, holds a local target
  // pool id (its own id space, independent of the global pool ids).
  localTargetLabels: Int32Array;
  // Local-target-pool id → sub-mappings to its matched local donor pool.
  // Used exactly like the global mappingsByPool inside the per-pixel loop.
  localMappingsByPool: Map<number, SubMapping[]>;
  // Per LOCAL target pool id → strided Lab samples from the matched local
  // DONOR pool, sorted ascending by L. Powers the anchor-aware rich path
  // (opts.richness > 0): a pixel under this anchor's dominance projects its
  // local lightness rank onto these samples instead of the auto donor's.
  // Optional + absent/empty map is treated as "no rich data" → the per-pixel
  // code falls back to the compressed sub-swatch delta.
  localDonorLabSamples?: Map<number, LabSample[]>;
  // Per LOCAL target pool id → strided pixel L values from that local TARGET
  // pool, sorted ascending. Used to rank a pixel's lightness inside the
  // local pool before projecting onto the local donor distribution above.
  localTargetLValues?: Map<number, Float32Array>;
}

// A 3-component CIE Lab delta to add to a pixel's Lab value.
interface LabDelta {
  dL: number;
  dA: number;
  dB: number;
}

// A single Lab triple — used by the rich sample-rank path below.
interface LabSample {
  L: number;
  a: number;
  b: number;
}

// One target sub-color paired with its lightness-ranked donor.
// Exported so anchor analysis can build local mappings consistently.
export interface SubMapping {
  // Target sub-color Lab — the anchor used for inverse-distance weighting.
  labL: number;
  labA: number;
  labB: number;
  delta: LabDelta; // donor Lab − target Lab
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Smoothstep on 0..1: cubic ease, zero derivative at both ends. Used to fade
// the anchor's influence from 1 at its center to 0 at its radius.
function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

// Anchor falloff weight for a target pixel: 1 at the anchor center, 0 at the
// anchor radius and beyond, smoothstep in between.
function anchorFalloff(x: number, y: number, cx: number, cy: number, radiusPx: number): number {
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= radiusPx) return 0;
  return smoothstep01(1 - dist / radiusPx);
}

// relax 0..1 → box-blur radius in pixels. 0 means "no blur" (handled before
// this is consulted). The radius scales with image size so the relax softness
// looks the same at any resolution: at the 256px preference it lands at 14 px
// (the original tuning — 256·(14/256)=14, byte-identical to the old behavior),
// and a full-resolution image blurs by a proportionally larger amount. After
// three box passes 14 px gives an effective Gaussian sigma of ~12–16 px.
const BLUR_RADIUS_PER_EDGE = 14 / 256;
const BLUR_PASSES = 3;

// Vectorized upscale of a pool-label map. The segmentation runs at a small
// working resolution; to recolor an image at its real resolution the label
// map must be projected up to that size. A plain nearest-neighbour upscale
// stamps each segmentation pixel as a hard rectangle, so pool boundaries come
// out stair-stepped at full res. Instead this traces each pool region's
// boundary into a polygon (via the CutWise contour module ported to
// ColorSmash) and rasterizes those polygons at (fullW, fullH), giving clean
// straight-faceted pool edges.
//
// `vectorizeLabels(labels, width, height, outWidth, outHeight, simplicity)`
// returns an Int32Array of length outWidth*outHeight, preserving -1 for
// transparent/unlabeled pixels. A simplicity of 0 keeps the polygon hugging
// the pixel boundary — boundaries are de-stair-stepped without otherwise
// reshaping the pools, so pool areas stay faithful to the segmentation.
export function vectorizeUpscaleLabels(
  labels: Int32Array,
  segW: number,
  segH: number,
  fullW: number,
  fullH: number,
): Int32Array {
  return vectorizeLabels(labels, segW, segH, fullW, fullH, 0);
}

// Combined sub-color list for a pool: structured sub-palette + noise swatches.
// Exported so anchor-analysis builds local sub-mapping inputs the same way.
export function poolSubColors(pool: Pool): SubSwatch[] {
  const list = pool.subPalette.slice();
  if (pool.noise) list.push(...pool.noise.swatches);
  return list;
}

// Sort a sub-color list by lightness (labL) ascending. Returns a new array.
// Exported so anchor analysis can sort consistently.
export function sortByLightness(swatches: SubSwatch[]): SubSwatch[] {
  return swatches.slice().sort((a, b) => a.labL - b.labL);
}

// Pair every target sub-color with a donor sub-color by lightness RANK.
//
// When the two lists are the same length this is rank i → rank i. When they
// differ, the target rank is normalized to 0..1 (targetRank/(Tlen−1)) and that
// position is projected onto the donor list, picking the nearest donor rank —
// so every target sub-color always gets a donor, dark→dark and light→light.
// Exported so anchor analysis builds local sub-mappings the same way.
export function buildSubMappings(
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

// Stride used when sampling pool pixels for the rich sample-rank path. Matches
// the cadence used elsewhere in the file for sub-sampling — keeps the cost
// linear in pool size while still capturing the full chroma distribution.
const RICHNESS_SAMPLE_STRIDE = 4;

// Collect a strided Lab sample of one pool's pixels from an rgba buffer, sorted
// ascending by L. Used by the rich sample-rank path to rebuild the donor pool's
// FULL color distribution (not just its sub-swatch averages). Returns null if
// the pool has no usable pixels at the sample stride.
function collectPoolLabSamples(
  rgba: Uint8Array,
  labels: Int32Array,
  poolId: number,
): LabSample[] | null {
  const n = labels.length;
  const out: LabSample[] = [];
  // Stride by RICHNESS_SAMPLE_STRIDE pixels through the label map. We accept
  // any opaque pixel whose label matches; transparent / mislabeled pixels are
  // skipped so they don't contribute zero-Lab samples.
  for (let i = 0; i < n; i += RICHNESS_SAMPLE_STRIDE) {
    if (labels[i] !== poolId) continue;
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    out.push({ L, a, b });
  }
  // Fallback: if striding missed every pixel of a small pool, walk every pixel
  // so we still capture something rather than returning null.
  if (out.length === 0) {
    for (let i = 0; i < n; i++) {
      if (labels[i] !== poolId) continue;
      const o = i * 4;
      if (rgba[o + 3] < 128) continue;
      const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
      out.push({ L, a, b });
    }
    if (out.length === 0) return null;
  }
  out.sort((p, q) => p.L - q.L);
  return out;
}

// Strided list of a target pool's pixel L values, sorted ascending. Used to
// rank a pixel's lightness within its pool so the rich path can project it
// onto the donor's distribution. Same stride / fallback strategy as above.
function collectPoolLValues(
  rgba: Uint8Array,
  labels: Int32Array,
  poolId: number,
): Float32Array | null {
  const n = labels.length;
  const tmp: number[] = [];
  for (let i = 0; i < n; i += RICHNESS_SAMPLE_STRIDE) {
    if (labels[i] !== poolId) continue;
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const [L] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    tmp.push(L);
  }
  if (tmp.length === 0) {
    for (let i = 0; i < n; i++) {
      if (labels[i] !== poolId) continue;
      const o = i * 4;
      if (rgba[o + 3] < 128) continue;
      const [L] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
      tmp.push(L);
    }
    if (tmp.length === 0) return null;
  }
  tmp.sort((a, b) => a - b);
  return Float32Array.from(tmp);
}

// Find the rank of value `v` within an ascending-sorted array via binary
// search — returned as an integer index in [0, arr.length - 1]. When `v` falls
// between two entries we pick the closer of the two, so two pixels with very
// similar L land on adjacent ranks instead of all collapsing to one bucket.
function rankInSorted(arr: Float32Array, v: number): number {
  const n = arr.length;
  if (n <= 1) return 0;
  if (v <= arr[0]) return 0;
  if (v >= arr[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  return v - arr[lo] <= arr[hi] - v ? lo : hi;
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
// the SAME resolution (the segmentation resolution). `sourceRgba` is the
// source-map pixels at sourceResult.{width,height} — only consulted when
// `opts.richness > 0`, where it supplies the donor pools' raw Lab samples for
// the per-pixel sample-rank match. Returns a new recolored RGBA buffer of the
// same dimensions; alpha is preserved everywhere.
//
// NOTE TO CALLERS: this signature added a required `sourceRgba` parameter in
// front of `sourceResult`. The UI caller (SmashTab.tsx) must thread the source
// pool map's rgba pixels through alongside its existing sourceResult.
export function transferColors(
  targetRgba: Uint8Array,
  width: number,
  height: number,
  targetResult: SegmentResult,
  sourceRgba: Uint8Array,
  sourceResult: SegmentResult,
  correspondence: Correspondence,
  opts: TransferOptions,
): Uint8Array {
  const out = targetRgba.slice();
  const strength = clamp01(opts.strength);
  const relax = clamp01(opts.relax ?? 0);
  const preserveLuminance = clamp01(opts.preserveLuminance ?? 0);
  const richness = clamp01(opts.richness ?? 0);

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

  // Pre-analysed anchors. Each anchor carries its own local target labels
  // and its own local-pool sub-mappings (the result of a mini-Smash inside
  // the anchor's falloff — see core/anchorAnalysis.ts). Only anchors whose
  // analysis actually produced non-empty mappings are kept active; the rest
  // are effectively no-ops.
  const anchorList: TransferAnchor[] = opts.anchors ? [...opts.anchors] : [];
  const activeAnchors: TransferAnchor[] = anchorList.filter(
    a => a.localMappingsByPool.size > 0 && a.localTargetLabels.length === width * height,
  );

  // ── Lazy precompute for the rich sample-rank path (richness > 0). ──
  // For each donor source pool referenced by `correspondence`, collect a
  // strided, lightness-sorted list of its actual source-pixel Lab samples.
  // For each target pool with an auto donor, collect a strided, sorted list of
  // its target-pixel L values — used to rank each pixel's lightness within its
  // pool's distribution. Both maps stay empty when richness is 0 so the
  // existing path is byte-for-byte unchanged in that case.
  //
  // Anchor donors get their OWN rich-path data when analyzeAnchor populates
  // `localDonorLabSamples` / `localTargetLValues` on each anchor; the per-pixel
  // loop blends that anchor-local rich shift in alongside the local delta when
  // an anchor dominates. The maps below are the AUTO path's data only.
  const donorLabSamplesByPool = new Map<number, LabSample[]>();
  const targetLValuesByPool = new Map<number, Float32Array>();
  if (richness > 0) {
    const donorIds = new Set<number>();
    for (const m of correspondence.matches) donorIds.add(m.sourcePoolId);
    for (const id of donorIds) {
      const samples = collectPoolLabSamples(sourceRgba, sourceResult.labels, id);
      if (samples) donorLabSamplesByPool.set(id, samples);
    }
    for (const targetPool of targetResult.pools) {
      if (!donorByTarget.has(targetPool.id)) continue;
      const lValues = collectPoolLValues(targetRgba, targetResult.labels, targetPool.id);
      if (lValues) targetLValuesByPool.set(targetPool.id, lValues);
    }
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

  // Anchor geometry per anchor, in pixel units of this transfer's resolution.
  // Each anchor's `localTargetLabels` was produced at (width, height), so
  // pixel-index lookups into it are direct.
  const anchorCount = activeAnchors.length;
  const anchorCx = new Float32Array(anchorCount);
  const anchorCy = new Float32Array(anchorCount);
  const anchorR = new Float32Array(anchorCount);
  for (let k = 0; k < anchorCount; k++) {
    const a = activeAnchors[k];
    anchorCx[k] = a.targetX * Math.max(0, width - 1);
    anchorCy[k] = a.targetY * Math.max(0, height - 1);
    anchorR[k] = Math.max(1, a.radius * Math.max(width, height));
  }

  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    const alpha = targetRgba[o + 3];
    const poolId = labels[i];

    // Transparent pixels (label −1 or low alpha) get a zero delta and are
    // excluded from the blur mask.
    if (poolId < 0 || alpha < 128) continue;
    opaque[i] = 1;

    const autoMappings = mappingsByPool.get(poolId);
    const hasAuto = !!(autoMappings && autoMappings.length > 0);

    // Find the dominant anchor covering this pixel — the one with the highest
    // smoothstep falloff. The local mini-Smash result REPLACES the auto delta
    // weighted by that anchor's falloff; the smoothstep gates spatially, not
    // chromatically. Overlapping anchors are resolved by max-falloff (cleanest
    // — keeps each anchor's local structure crisp). Multi-anchor blending is a
    // future extension.
    let bestAnchor = -1;
    let bestFall = 0;
    if (anchorCount > 0) {
      const x = i % width;
      const y = (i / width) | 0;
      for (let k = 0; k < anchorCount; k++) {
        const f = anchorFalloff(x, y, anchorCx[k], anchorCy[k], anchorR[k]);
        if (f > bestFall) {
          bestFall = f;
          bestAnchor = k;
        }
      }
    }

    if (!hasAuto && bestAnchor < 0) continue; // no transfer for this pixel

    const [L, a, b] = rgbToLab(targetRgba[o], targetRgba[o + 1], targetRgba[o + 2]);

    // Auto delta from the global correspondence — used both outside any
    // anchor and as the "edge" of the lerp inside an anchor.
    let autoDL = 0, autoDA = 0, autoDB = 0;
    if (hasAuto) {
      const d = softDelta(L, a, b, autoMappings!);
      autoDL = d.dL;
      autoDA = d.dA;
      autoDB = d.dB;
    }

    // Local delta from the dominant anchor's mini-Smash. Looked up by this
    // pixel's local target label inside the anchor (which can be -1 even
    // when the falloff is > 0, e.g. transparent pixels or pixels whose
    // segmented sample was excluded); in that case we fall back to auto.
    let dL: number, dA: number, dB: number;
    if (bestAnchor >= 0) {
      const anchor = activeAnchors[bestAnchor];
      const localLabel = anchor.localTargetLabels[i];
      let localMappings: SubMapping[] | undefined;
      if (localLabel >= 0) {
        localMappings = anchor.localMappingsByPool.get(localLabel);
      }
      if (localMappings && localMappings.length > 0) {
        // Compressed sub-swatch local delta — the baseline anchor behaviour.
        const ld = softDelta(L, a, b, localMappings);
        let ldL = ld.dL, ldA = ld.dA, ldB = ld.dB;

        // Anchor-aware richness: when richness > 0 AND this anchor carries
        // rank-match data for the pixel's LOCAL target pool, replace the
        // compressed local delta with one biased toward the anchor's LOCAL
        // donor distribution. Mirrors the auto path's rich shift but rooted
        // in the anchor's own mini-Smash rather than the global donor.
        // Anchors without rich tables (or with an empty bucket for this
        // local pool) silently fall back to the compressed delta.
        if (richness > 0 && localLabel >= 0 && anchor.localTargetLValues && anchor.localDonorLabSamples) {
          const localLs = anchor.localTargetLValues.get(localLabel);
          const localSamples = anchor.localDonorLabSamples.get(localLabel);
          if (localLs && localSamples && localLs.length > 0 && localSamples.length > 0) {
            const r = rankInSorted(localLs, L);
            const denom = Math.max(1, localLs.length - 1);
            const srcIdx = Math.round((r / denom) * (localSamples.length - 1));
            const rs = localSamples[srcIdx];
            // Rich local delta: move from (L,a,b) straight toward the sample.
            const richDL = rs.L - L;
            const richDA = rs.a - a;
            const richDB = rs.b - b;
            // Blend compressed → rich by `richness`. richness 0 keeps the
            // existing byte-identical anchor behaviour; richness 1 fully
            // adopts the rank-matched local donor sample.
            ldL = (1 - richness) * ld.dL + richness * richDL;
            ldA = (1 - richness) * ld.dA + richness * richDA;
            ldB = (1 - richness) * ld.dB + richness * richDB;
          }
        }

        // Spatial lerp: at centre f=1 → pure local, at edge f=0 → pure auto.
        const f = bestFall;
        const inv = 1 - f;
        dL = autoDL * inv + ldL * f;
        dA = autoDA * inv + ldA * f;
        dB = autoDB * inv + ldB * f;
      } else {
        dL = autoDL;
        dA = autoDA;
        dB = autoDB;
      }
    } else {
      dL = autoDL;
      dA = autoDA;
      dB = autoDB;
    }

    // Rich sample-rank blend. The compressed path above gave us a per-pixel
    // delta from the auto donor's averaged sub-swatches (and any dominant
    // anchor). The rich path replaces the auto donor's contribution with that
    // donor pool's actual Lab sample at this pixel's lightness rank, pulling
    // the donor's full a/b chroma variation through instead of the few
    // averages.
    //
    // SIMPLIFICATION: rich-Lab is computed from the AUTO donor only; any
    // anchor contribution stays in the sub-swatch delta path. To express
    // that, the rich blend's weight is scaled by (1 − bestFall) — outside
    // any anchor the auto is fully replaced; deeper inside an anchor the
    // rich shift fades out and the local mini-Smash dominates.
    const autoWeight = 1 - bestFall; // 1 outside anchors, 0 at anchor centre
    if (richness > 0 && hasAuto && autoWeight > 0) {
      const donorId = donorByTarget.get(poolId);
      if (donorId !== undefined) {
        const donorSamples = donorLabSamplesByPool.get(donorId);
        const targetLs = targetLValuesByPool.get(poolId);
        if (donorSamples && targetLs && donorSamples.length > 0 && targetLs.length > 0) {
          // Rank this pixel's L within its target pool's L distribution, then
          // project that rank onto the donor pool's sample list.
          const r = rankInSorted(targetLs, L);
          const denom = Math.max(1, targetLs.length - 1);
          const srcIdx = Math.round((r / denom) * (donorSamples.length - 1));
          const richSample = donorSamples[srcIdx];

          // Recompute the auto donor's compressed delta so we can swap it for
          // the rich shift. The running dL/A/B is (autoDelta*(1−f) +
          // localDelta*f), so the auto's contribution is autoD * autoWeight.
          const autoD = softDelta(L, a, b, autoMappings!);
          const autoShiftL = autoD.dL * autoWeight;
          const autoShiftA = autoD.dA * autoWeight;
          const autoShiftB = autoD.dB * autoWeight;
          // Rich shift: move toward richSample by the same auto weight.
          const richShiftL = (richSample.L - L) * autoWeight;
          const richShiftA = (richSample.a - a) * autoWeight;
          const richShiftB = (richSample.b - b) * autoWeight;
          // Blend the auto slice toward the rich slice by `richness`.
          const newAutoL = (1 - richness) * autoShiftL + richness * richShiftL;
          const newAutoA = (1 - richness) * autoShiftA + richness * richShiftA;
          const newAutoB = (1 - richness) * autoShiftB + richness * richShiftB;
          dL = dL - autoShiftL + newAutoL;
          dA = dA - autoShiftA + newAutoA;
          dB = dB - autoShiftB + newAutoB;
        }
      }
    }

    deltaL[i] = dL;
    deltaA[i] = dA;
    deltaB[i] = dB;
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
