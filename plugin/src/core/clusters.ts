// Content-following hierarchical color segmentation.
//
// Pass 1 (macro): the k-means quantize runs in an LCh polar feature space
// [L·vw, C·cw, sin(H)·hw·gate, cos(H)·hw·gate] so value, chroma magnitude and
// hue identity are independently weightable. The hue terms are gated by
// chroma so near-neutral pixels don't get spurious hue separation. A single
// "Color vs Value bias" slider tilts vw against (cw, hw). Then connected-
// component "islands" supply the spatial structure and small islands are
// merged into neighbours with edge protection (CutWise's island logic).
// Because no spatial term is mixed into the clustering, pool boundaries
// follow real image content instead of forming convex tiles.
// Pass 2 (per pool): each pool's pixels are sub-clustered into a sub-palette;
// sub-colors that are spatially diffuse within the pool are split off as a
// separate noise component.
//
// Optional drill-down: a pool can be recursively re-segmented into child
// pools (expandPool / collapsePool) — depth 2, opt-in per pool.
//
// Re-segmentation can be warm-started from a previous result: centroids are
// seeded from the prior pools and pool ids are matched forward, so identity
// and the partition stay stable while a user drags the controls.

import { rgbToLab, extractPalette } from "./palette";
import { labelComponents, mergeSmallIslands } from "./cutwise/islands";
import type { Cluster, MergeParams } from "./cutwise/islands";
import { smoothLabels } from "./cutwise/smooth";
import { slic } from "./slic";

// ────────── Public interface ──────────

export type ValueBand = "shadow" | "mid" | "highlight";

// A single color within a pool's sub-palette (or noise component).
export interface SubSwatch {
  r: number; g: number; b: number;            // display color, 0..255
  labL: number; labA: number; labB: number;   // CIE Lab centroid
  weight: number;                             // fraction of the parent pool, 0..1
  compactness: number;                        // 0..1 — spatial localization within the pool
}

// Rich pool descriptor — carries enough features to drive source↔target pool
// matching ("correspondence") in the eventual transfer step.
export interface PoolDescriptor {
  r: number; g: number; b: number;            // mean display color, 0..255
  labL: number; labA: number; labB: number;   // mean CIE Lab
  chroma: number;                             // sqrt(a²+b²) — colorfulness
  valueBand: ValueBand;                       // tonal band of the mean L
  pixelCount: number;
  weight: number;                             // fraction of the parent set, 0..1
  compactness: number;                        // 0..1 — 1 = localized, 0 = diffuse
  centroidX: number; centroidY: number;       // normalized 0..1 spatial center
  bboxX0: number; bboxY0: number;             // normalized 0..1 bounding box
  bboxX1: number; bboxY1: number;
}

// The diffuse / speckled component split out of a pool's sub-palette.
export interface NoiseProfile {
  swatches: SubSwatch[];   // sub-colors found scattered across the pool
  weight: number;          // fraction of the pool that is noise-like, 0..1
}

// One color pool. subPalette + noise are the always-on color read; subPools is
// the optional spatial drill-down (null until the pool is expanded).
export interface Pool {
  id: number;                  // STABLE across re-segmentation when warm-started
  descriptor: PoolDescriptor;
  subPalette: SubSwatch[];     // structured (localized) sub-colors, weight desc
  noise: NoiseProfile | null;  // diffuse component, null if none detected
  subPools: Pool[] | null;     // child pools, null unless expanded (depth ≤ 2)
}

export interface SegmentOptions {
  poolCount: number;          // k for the color quantize, e.g. 2..12
  edgePreservation: number;   // 0..1 — refuse island merges across strong color edges
  regionCleanup: number;      // 0..1 — how aggressively small islands are absorbed
  colorVsValueBias: number;   // 0..1 — 0 = color/chroma identity dominates,
                              // 0.5 = balanced (≈ Lab), 1 = value/lightness dominates
  subPaletteSize: number;     // k for each pool's sub-palette, e.g. 3..7
  neutralProtection: number;  // 0..1 — refuses merges across strong chroma steps
                              // (defends against gray shadows swallowing chromatic neighbours)
  poolContinuity: number;     // 0..1 — color-range unification pass: clusters whose
                              // mean Lab distance falls below `continuity·UNIFY_MAX_LAB`
                              // get merged into one pool. Lets chromatically-related
                              // regions split by an intervening colour (e.g. a dress
                              // under a sash) become a single pool with one donor and
                              // one transform. 0 = no unification (default).
}

export interface SegmentResult {
  width: number;
  height: number;
  labels: Int32Array;       // length width*height, id of the MOST-SPECIFIC pool
                            // assigned to each pixel (-1 = transparent)
  pools: Pool[];            // top-level pools, sorted by descriptor.weight desc
}

// A manual "intelligent split" edit applied AFTER segmentation: re-cluster the
// raw pixels under a circle into `partCount` edge-aware sub-pools, so a janky
// merge (e.g. face-in-shadow fused with collar-in-shadow) can be hand-divided
// and each part mapped to its own donor.
//
// The edit is pure geometry — normalized centre + radius — so it's resolution-
// and segmentation-independent: re-applying it after the user moves a control
// just re-clusters the same physical pixels. `baseId` reserves a stable id
// range for this edit's parts so a correspondence mapping to a split survives a
// re-segmentation (part ids don't churn). Allocate baseIds with SPLIT_ID_BASE /
// SPLIT_ID_STRIDE so they never collide with normal pool ids or each other.
export interface SplitEdit {
  id: string;          // UI key (not the pool id space)
  nx: number;          // normalized circle centre X, 0..1
  ny: number;          // normalized circle centre Y, 0..1
  radius: number;      // normalized radius as a fraction of max(width,height), 0..1
  partCount: number;   // how many sub-pools to split the covered pixels into (≥2)
  baseId: number;      // start of this edit's reserved pool-id range
  // Soft edge, 0..1 (optional, default 0 = hard). The split still relabels every
  // pixel inside the full radius; feather only attenuates the RECOLOR in an outer
  // band [radius·(1−feather), radius] so the split fades into the original toward
  // its rim instead of swapping donor abruptly. See buildSplitFeatherMask.
  feather?: number;
}

// Stable id space for split parts — far above normal pool ids (which stay small
// even with drill-downs). Each edit gets baseId = SPLIT_ID_BASE + k·STRIDE; the
// stride dwarfs any realistic partCount so edits never overlap.
export const SPLIT_ID_BASE = 1_000_000;
export const SPLIT_ID_STRIDE = 1_000;

// ────────── Tuning constants ──────────

// Pool k-means runs over SLIC superpixels, not raw pixels — this is the unit
// of clustering. Each superpixel is a small, color-coherent, edge-aware region
// produced by slic.ts; macro-pool k-means then groups superpixels into the
// final pool count. Far stabler partitions than per-pixel clustering on real
// photographs, with no change to the downstream merge / smooth / pool-building
// pipeline (those still see a per-pixel cluster-label map).
//
// SLIC_K_PER_POOL: target superpixel count scales with the requested pool
// count — more pools deserve a finer base partition. The floor (SLIC_K_MIN)
// keeps small images from degenerating into one giant superpixel per cluster.
const SLIC_K_PER_POOL = 80;
const SLIC_K_MIN = 64;
// Compactness in the SLIC distance metric. 15 trades the spatial term firmly
// against color so superpixels respect edges but stay roughly tile-shaped.
const SLIC_COMPACTNESS = 15;
const SLIC_ITERATIONS = 10;

const MAX_ITERATIONS = 16;
const CONVERGENCE_THRESHOLD = 0.5; // mean centroid shift below which we stop

// Base island area (px) absorbed at zero Region cleanup — the despeckle floor.
// Region cleanup scales the merge threshold up from here.
const SHAPE_SIZE = 12;
// Majority-filter passes that clean the merged label map's contours.
const SMOOTH_PASSES = 2;

// Hue is unreliable at low chroma; below this Lab-chroma threshold the hue
// contribution to clustering distance is faded out so near-neutral pixels
// don't get spurious hue separation.
const CHROMA_GATE = 5;
// How far the colorVsValueBias slider tilts the V vs (C, H) weights apart.
// At bias 0.5 all three weights are 1; at 0 / 1 they spread by ±BIAS_K/2.
const BIAS_K = 1.5;

// Maximum mean-Lab distance considered for color-range unification, in Lab
// Euclidean units. At poolContinuity=1, cluster pairs within this distance
// are eligible to merge into one pool. ~30 covers loose colour families
// (neighbouring warms, neighbouring blues) without crossing identity lines.
const UNIFY_MAX_LAB = 30;

// A sub-color counts as noise when it is spread almost as widely as its whole
// parent pool (relativeSpread above the threshold) yet is only a minority
// share — i.e. speckle sprinkled across the pool, not a localized block.
// Judging spread RELATIVE to the pool keeps the split stable regardless of the
// cluster-sharpness / sub-palette-size controls.
const NOISE_RELATIVE_SPREAD = 0.8;
const NOISE_MAX_WEIGHT = 0.6;
// "Noise within a region" is only meaningful for a reasonably coherent pool;
// pools more diffuse than this get no noise split at all.
const DIFFUSE_POOL_FLOOR = 0.3;

// Value-band cuts on the L axis.
const SHADOW_MAX_L = 33;
const HIGHLIGHT_MIN_L = 66;

// ────────── Internal types ──────────

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Map the user-facing 0..1 bias onto value / chroma / hue axis weights.
// bias < 0.5 → chroma & hue count more (color identity dominates).
// bias > 0.5 → value counts more (classic luminance-driven cutout).
function biasWeights(bias: number): { vw: number; cw: number; hw: number } {
  const b = clamp01(bias) - 0.5;
  const vw = Math.max(0.1, 1 + b * BIAS_K);
  const cw = Math.max(0.1, 1 - b * BIAS_K);
  return { vw, cw, hw: cw };
}

// Write the 4D LCh polar feature for a Lab pixel into `out` at offset `off`.
// Hue is encoded as (sin H, cos H) so it's continuous across the 0°/360° wrap;
// both terms are gated by chroma so near-neutral pixels collapse onto the L/C
// plane and don't pollute the partition with meaningless hue noise.
function buildFeature(
  L: number, a: number, b: number,
  vw: number, cw: number, hw: number,
  out: Float32Array, off: number,
): void {
  const C = Math.sqrt(a * a + b * b);
  const H = Math.atan2(b, a);
  const gate = C < CHROMA_GATE ? C / CHROMA_GATE : 1;
  out[off]     = L * vw;
  out[off + 1] = C * cw;
  out[off + 2] = Math.sin(H) * hw * gate;
  out[off + 3] = Math.cos(H) * hw * gate;
}

// ────────── Top-level + drill-down API ──────────

// Segment a whole image into macro pools.
export function segmentImage(
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: SegmentOptions,
  prev?: SegmentResult,
): SegmentResult {
  const pxCount = width * height;
  const indices: number[] = [];
  for (let i = 0; i < pxCount; i++) {
    if (rgba[i * 4 + 3] >= 128) indices.push(i);
  }
  const { pools, assignment } = segmentPixelSet(
    rgba, width, height, indices, opts, 0, prev?.pools,
  );
  const labels = new Int32Array(pxCount).fill(-1);
  for (let j = 0; j < indices.length; j++) labels[indices[j]] = assignment[j];
  return { width, height, labels, pools };
}

// Re-segment a single top-level pool into child pools (depth-2 drill-down).
// Returns a new result; child pool ids continue past the current maximum so
// the whole tree shares one stable id space.
export function expandPool(
  result: SegmentResult,
  rgba: Uint8Array,
  poolId: number,
  opts: SegmentOptions,
): SegmentResult {
  const i = result.pools.findIndex(p => p.id === poolId);
  if (i < 0 || result.pools[i].subPools) return result; // not top-level / already expanded

  const indices: number[] = [];
  for (let p = 0; p < result.labels.length; p++) {
    if (result.labels[p] === poolId) indices.push(p);
  }
  if (indices.length < 2) return result;

  const { pools: children, assignment } = segmentPixelSet(
    rgba, result.width, result.height, indices, opts, maxPoolId(result.pools) + 1,
  );
  if (children.length === 0) return result;

  const labels = result.labels.slice();
  for (let j = 0; j < indices.length; j++) labels[indices[j]] = assignment[j];
  const pools = result.pools.map(p => (p.id === poolId ? { ...p, subPools: children } : p));
  return { width: result.width, height: result.height, labels, pools };
}

// Fold an expanded pool back up: its child pixels are relabeled to the parent.
export function collapsePool(result: SegmentResult, poolId: number): SegmentResult {
  const i = result.pools.findIndex(p => p.id === poolId);
  if (i < 0 || !result.pools[i].subPools) return result;

  const childIds = new Set(result.pools[i].subPools!.map(c => c.id));
  const labels = result.labels.slice();
  for (let p = 0; p < labels.length; p++) {
    if (childIds.has(labels[p])) labels[p] = poolId;
  }
  const pools = result.pools.map(p => (p.id === poolId ? { ...p, subPools: null } : p));
  return { width: result.width, height: result.height, labels, pools };
}

// Highest pool id anywhere in the tree — the next free id is maxPoolId + 1.
function maxPoolId(pools: Pool[]): number {
  let m = -1;
  for (const p of pools) {
    if (p.id > m) m = p.id;
    if (p.subPools) for (const c of p.subPools) if (c.id > m) m = c.id;
  }
  return m;
}

// ────────── manual split edits (selection refine) ──────────

// Rebuild a flat Pool[] from an arbitrary label map, KEYED BY the ids already
// present in `labels` (so existing pool identity is preserved and split parts
// keep their reserved ids). Descriptors/sub-palettes/noise are recomputed
// image-wide so weights, centroids and bboxes are correct after splits have
// moved pixels between pools. Pools that lost all their pixels simply vanish.
//
// This mirrors the descriptor + analyzePool build inside segmentPixelSet, but
// driven by final label ids rather than transient cluster indices — kept
// separate so the proven segmentation hot path stays untouched.
export function buildPoolsFromLabels(
  rgba: Uint8Array,
  width: number,
  height: number,
  labels: Int32Array,
  subPaletteSize: number,
): Pool[] {
  const byId = new Map<number, number[]>();
  let total = 0;
  let setMinX = width, setMaxX = -1, setMinY = height, setMaxY = -1;
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (id < 0) continue;
    let arr = byId.get(id);
    if (!arr) { arr = []; byId.set(id, arr); }
    arr.push(i);
    total++;
    const x = i % width, y = (i / width) | 0;
    if (x < setMinX) setMinX = x;
    if (x > setMaxX) setMaxX = x;
    if (y < setMinY) setMinY = y;
    if (y > setMaxY) setMaxY = y;
  }
  if (total === 0) return [];

  const refW = Math.max(0, setMaxX - setMinX);
  const refH = Math.max(0, setMaxY - setMinY);
  const refVar = (refW * refW + refH * refH) / 12;
  const xDen = width > 1 ? width - 1 : 1;
  const yDen = height > 1 ? height - 1 : 1;

  const pools: Pool[] = [];
  for (const [id, idx] of byId) {
    const cnt = idx.length;
    let Ls = 0, As = 0, Bs = 0, Xs = 0, Ys = 0, XXs = 0, YYs = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (const i of idx) {
      const o = i * 4;
      const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
      const x = i % width, y = (i / width) | 0;
      Ls += L; As += a; Bs += b;
      Xs += x; Ys += y; XXs += x * x; YYs += y * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const meanL = Ls / cnt, meanA = As / cnt, meanB = Bs / cnt;
    const [mr, mg, mb] = labToRgb(meanL, meanA, meanB);
    const mx = Xs / cnt, my = Ys / cnt;
    const varX = Math.max(0, XXs / cnt - mx * mx);
    const varY = Math.max(0, YYs / cnt - my * my);
    const compactness = refVar > 1e-6 ? clamp01(1 - (varX + varY) / refVar) : 1;

    const descriptor: PoolDescriptor = {
      r: mr, g: mg, b: mb,
      labL: meanL, labA: meanA, labB: meanB,
      chroma: Math.sqrt(meanA * meanA + meanB * meanB),
      valueBand: meanL < SHADOW_MAX_L ? "shadow" : meanL > HIGHLIGHT_MIN_L ? "highlight" : "mid",
      pixelCount: cnt,
      weight: cnt / total,
      compactness,
      centroidX: clamp01(mx / xDen),
      centroidY: clamp01(my / yDen),
      bboxX0: clamp01(minX / xDen),
      bboxY0: clamp01(minY / yDen),
      bboxX1: clamp01(maxX / xDen),
      bboxY1: clamp01(maxY / yDen),
    };
    const { subPalette, noise } = analyzePool(
      idx, rgba, width, varX + varY, compactness, subPaletteSize,
    );
    pools.push({ id, descriptor, subPalette, noise, subPools: null });
  }

  pools.sort((a, b) => b.descriptor.weight - a.descriptor.weight);
  return pools;
}

// Re-apply a list of manual split edits onto a base segmentation. For each
// edit we gather the opaque pixels under its circle, re-run the full edge-aware
// segmenter on JUST those pixels (so the split follows the real colour edge,
// not a hard disc), and relabel them into the edit's reserved id range. After
// all edits land we rebuild every pool descriptor from the final labels so the
// downstream match/transfer see correct image-wide statistics.
//
// Deterministic for a fixed (base, pixels, edits, opts) — which is what makes
// the edits persist across re-segmentation: the caller just re-runs this on the
// freshly segmented base and the same physical pixels split the same way.
export function applySplits(
  base: SegmentResult,
  rgba: Uint8Array,
  edits: SplitEdit[],
  opts: SegmentOptions,
): SegmentResult {
  if (!edits || edits.length === 0) return base;
  const { width, height } = base;
  const labels = base.labels.slice();
  const maxEdge = Math.max(width, height);

  for (const edit of edits) {
    const parts = Math.max(2, Math.floor(edit.partCount));
    const cx = edit.nx * width;
    const cy = edit.ny * height;
    const rPx = Math.max(1, edit.radius * maxEdge);
    const r2 = rPx * rPx;

    const x0 = Math.max(0, Math.floor(cx - rPx));
    const x1 = Math.min(width - 1, Math.ceil(cx + rPx));
    const y0 = Math.max(0, Math.floor(cy - rPx));
    const y1 = Math.min(height - 1, Math.ceil(cy + rPx));

    const circle: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * width + x;
        if (rgba[i * 4 + 3] < 128) continue;
        circle.push(i);
      }
    }
    if (circle.length < parts) continue;

    // Cold segmentation of the masked subset into `parts` pools, ids starting
    // at the edit's reserved baseId (deterministic → stable across re-segments).
    const { assignment } = segmentPixelSet(
      rgba, width, height, circle,
      { ...opts, poolCount: parts },
      edit.baseId,
    );
    for (let j = 0; j < circle.length; j++) {
      if (assignment[j] >= 0) labels[circle[j]] = assignment[j];
    }
  }

  const pools = buildPoolsFromLabels(rgba, width, height, labels, opts.subPaletteSize);
  return { width, height, labels, pools };
}

// Build a per-pixel SPLIT BLEND WEIGHT for feathered splits, or null when no
// edit has feather (in which case the caller uses the plain split recolor — a
// hard split needs no blend). The weight drives a composite of the WITH-splits
// recolor over the WITHOUT-splits recolor: 1 = use the split result fully,
// 0 = use the base (no-split) result. So a feathered split fades into what its
// neighbourhood would look like WITHOUT the split — true feathering, not a fade
// to the raw original.
//
// Per split: 1 inside the core radius·(1−feather); smoothstep 1→0 across the
// outer band [innerR, outerR]; 0 beyond outerR. Multiple splits take the MAX so
// every split's core stays fully applied even where another's feather overlaps.
// Pure geometry → regenerate at any resolution (preview vs full-res output).
export function buildSplitBlendWeight(
  width: number,
  height: number,
  edits: SplitEdit[],
): Float32Array | null {
  const anyFeather = edits.some((e) => (e.feather ?? 0) > 0);
  if (!anyFeather) return null;

  const w = new Float32Array(width * height); // 0 everywhere (outside = base)
  const maxEdge = Math.max(width, height);
  for (const e of edits) {
    const feather = clamp01(e.feather ?? 0);
    const cx = e.nx * width;
    const cy = e.ny * height;
    const outerR = Math.max(1, e.radius * maxEdge);
    const innerR = outerR * (1 - feather);
    const band = Math.max(1e-6, outerR - innerR);

    const x0 = Math.max(0, Math.floor(cx - outerR));
    const x1 = Math.min(width - 1, Math.ceil(cx + outerR));
    const y0 = Math.max(0, Math.floor(cy - outerR));
    const y1 = Math.min(height - 1, Math.ceil(cy + outerR));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= outerR) continue;        // outside → leave at base (0)
        let wt: number;
        if (d <= innerR) {
          wt = 1;                          // core → full split
        } else {
          const t = (d - innerR) / band;   // 0 at inner → 1 at outer
          const s = 1 - t;                 // 1 at inner → 0 at outer
          wt = s * s * (3 - 2 * s);        // smoothstep falloff
        }
        const i = y * width + x;
        if (wt > w[i]) w[i] = wt;          // strongest split wins
      }
    }
  }
  return w;
}

// ────────── pass 1: segment a pixel set into pools ──────────

// Core segmentation pass over an arbitrary list of pixel indices (the whole
// image for segmentImage, one pool's pixels for expandPool):
//   1. color-only Lab k-means → a per-pixel cluster-label map
//   2. connected-component islands on that map (CutWise)
//   3. edge-protected merge of small islands into neighbours (CutWise)
//   4. majority-filter smoothing (CutWise)
//   5. build Pool[] (descriptor + sub-palette + noise) from the final labels
// `assignment[j]` is the pool id chosen for `indices[j]`.
//
// Exported so per-anchor mini-Smash analysis (anchorAnalysis.ts) can re-use
// the same engine on a subset of source / target pixels — keeping island
// merge / smoothing / pool-building behaviour identical to the global pass.
export function segmentPixelSet(
  rgba: Uint8Array,
  width: number,
  height: number,
  indices: number[],
  opts: SegmentOptions,
  idStart: number,
  warmPools?: Pool[],
): { pools: Pool[]; assignment: Int32Array } {
  const total = indices.length;
  const assignment = new Int32Array(total).fill(-1);
  if (total === 0) return { pools: [], assignment };

  const k = Math.max(1, Math.floor(opts.poolCount));

  // ── 1. SLIC superpixels — the analysis unit for pool clustering. ──
  // SLIC collapses the pixel set into a few hundred small, color-coherent,
  // edge-aware regions; pool k-means then runs over THOSE rather than raw
  // (or decimated) pixels. The number of superpixels scales with poolCount
  // so a higher pool count gets a finer base partition.
  const slicK = Math.max(SLIC_K_MIN, k * SLIC_K_PER_POOL);
  const sp = slic(rgba, width, height, indices, {
    K: slicK,
    compactness: SLIC_COMPACTNESS,
    iterations: SLIC_ITERATIONS,
  });
  const n = sp.centers.length;
  if (n === 0) return { pools: [], assignment };

  // ── 2. LCh polar feature k-means over SUPERPIXELS. Bias tilts V vs (C, H). ──
  const { vw, cw, hw } = biasWeights(opts.colorVsValueBias);
  const effK = Math.min(k, n);

  // 4D feature per superpixel, plus a parallel weight buffer = superpixel pixel
  // count. The k-means accumulator weights each sample by its superpixel size,
  // so centroids stay faithful to the underlying pixel distribution even
  // though we're now iterating over O(K_slic) samples instead of O(N).
  const sampleFeatures = new Float32Array(n * 4);
  const sampleWeights = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = sp.centers[i];
    buildFeature(c.L, c.a, c.b, vw, cw, hw, sampleFeatures, i * 4);
    sampleWeights[i] = c.count;
  }

  const cents = buildInitCentroids(sampleFeatures, n, effK, vw, cw, hw, warmPools);
  const assign = new Int32Array(n);
  const sums = new Float64Array(effK * 4);
  const wsums = new Float64Array(effK);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) assign[i] = nearestCentroid(sampleFeatures, i * 4, cents, effK);
    sums.fill(0); wsums.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i], off = i * 4;
      const w = sampleWeights[i];
      sums[c * 4]     += sampleFeatures[off]     * w;
      sums[c * 4 + 1] += sampleFeatures[off + 1] * w;
      sums[c * 4 + 2] += sampleFeatures[off + 2] * w;
      sums[c * 4 + 3] += sampleFeatures[off + 3] * w;
      wsums[c] += w;
    }
    let totalShift = 0;
    for (let c = 0; c < effK; c++) {
      if (wsums[c] === 0) continue; // dead cluster — leave centroid in place
      let shift = 0;
      const inv = 1 / wsums[c];
      for (let d = 0; d < 4; d++) {
        const nv = sums[c * 4 + d] * inv;
        const dv = nv - cents[c * 4 + d];
        shift += dv * dv;
        cents[c * 4 + d] = nv;
      }
      totalShift += Math.sqrt(shift);
    }
    if (totalShift / effK < CONVERGENCE_THRESHOLD) break;
  }

  // ── 3. Superpixel → cluster map, then propagate to every pixel. ──
  // Each superpixel takes its final nearest centroid; the per-pixel label map
  // is just a lookup through the SLIC labels. Per-cluster mean Lab is still
  // accumulated from REAL pixels (not superpixel means) so the merge step's
  // edge / value / neutral protections operate on the same Lab statistics they
  // always have.
  const spToCluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    spToCluster[i] = nearestCentroid(sampleFeatures, i * 4, cents, effK);
  }
  const clusterLabels = new Int32Array(width * height).fill(-1);
  const clusterCount = new Int32Array(effK);
  const clusterLabSum = new Float64Array(effK * 3);
  for (let j = 0; j < total; j++) {
    const i = indices[j];
    const spId = sp.labels[i];
    if (spId < 0) continue;
    const c = spToCluster[spId];
    const o = i * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    clusterLabels[i] = c;
    clusterCount[c]++;
    clusterLabSum[c * 3]     += L;
    clusterLabSum[c * 3 + 1] += a;
    clusterLabSum[c * 3 + 2] += b;
  }

  // ── Color-range pool unification (poolContinuity). ──
  // Cluster pairs whose mean Lab distance falls below `continuity·UNIFY_MAX_LAB`
  // are union-find merged so chromatically-related regions across the canvas
  // (dress halves under a sash, face under hat brim) collapse to one pool with
  // one donor and one transform. continuity=0 makes this a no-op. The greedy
  // nearest-pair-first traversal prevents weak transitive chains from binding
  // distinct colour families together. See plugin/docs/pool-unification.md.
  const continuity = clamp01(opts.poolContinuity);
  if (continuity > 0) {
    const meanLab = new Float64Array(effK * 3);
    for (let c = 0; c < effK; c++) {
      const cnt = clusterCount[c];
      if (cnt > 0) {
        meanLab[c * 3]     = clusterLabSum[c * 3]     / cnt;
        meanLab[c * 3 + 1] = clusterLabSum[c * 3 + 1] / cnt;
        meanLab[c * 3 + 2] = clusterLabSum[c * 3 + 2] / cnt;
      }
    }
    const threshold = continuity * UNIFY_MAX_LAB;
    const t2 = threshold * threshold;
    const parent = new Int32Array(effK);
    for (let c = 0; c < effK; c++) parent[c] = c;
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    // All pairs under the threshold, sorted by distance ascending. Greedy union
    // by nearest pair keeps chains tight: if A-B and B-C both qualify but A-C
    // doesn't, we still merge transitively, but the order anchors merges to
    // their closest neighbours first.
    const pairs: { i: number; j: number; d2: number }[] = [];
    for (let i = 0; i < effK; i++) {
      if (clusterCount[i] === 0) continue;
      for (let j = i + 1; j < effK; j++) {
        if (clusterCount[j] === 0) continue;
        const dL = meanLab[i * 3]     - meanLab[j * 3];
        const dA = meanLab[i * 3 + 1] - meanLab[j * 3 + 1];
        const dB = meanLab[i * 3 + 2] - meanLab[j * 3 + 2];
        const d2 = dL * dL + dA * dA + dB * dB;
        if (d2 < t2) pairs.push({ i, j, d2 });
      }
    }
    pairs.sort((a, b) => a.d2 - b.d2);
    for (const p of pairs) {
      const ri = find(p.i), rj = find(p.j);
      if (ri !== rj) parent[ri] = rj;
    }
    // Apply the union map to clusterLabels + collapse stats into root clusters.
    let touched = false;
    for (let c = 0; c < effK; c++) if (find(c) !== c) { touched = true; break; }
    if (touched) {
      const remap = new Int32Array(effK);
      for (let c = 0; c < effK; c++) remap[c] = find(c);
      for (let i = 0; i < clusterLabels.length; i++) {
        const c = clusterLabels[i];
        if (c >= 0) clusterLabels[i] = remap[c];
      }
      const newCount = new Int32Array(effK);
      const newSum = new Float64Array(effK * 3);
      for (let c = 0; c < effK; c++) {
        const r = remap[c];
        newCount[r] += clusterCount[c];
        newSum[r * 3]     += clusterLabSum[c * 3];
        newSum[r * 3 + 1] += clusterLabSum[c * 3 + 1];
        newSum[r * 3 + 2] += clusterLabSum[c * 3 + 2];
      }
      clusterCount.set(newCount);
      clusterLabSum.set(newSum);
    }
  }

  // Cluster colors for the island-merge nearest-color test — mean Lab.
  const clusters: Cluster[] = [];
  for (let c = 0; c < effK; c++) {
    const cnt = clusterCount[c];
    if (cnt > 0) {
      const L = clusterLabSum[c * 3] / cnt;
      const a = clusterLabSum[c * 3 + 1] / cnt;
      const b = clusterLabSum[c * 3 + 2] / cnt;
      clusters.push({ rgb: labToRgb(L, a, b), lab: [L, a, b], count: cnt });
    } else {
      clusters.push({ rgb: [0, 0, 0], lab: [0, 0, 0], count: 0 });
    }
  }

  // ── 3-4. Islands → edge-protected merge → smoothing (CutWise). ──
  const { regionOf, regions } = labelComponents(clusterLabels, width, height);
  // Uniform priority (no focal anchors yet) → uniform merge threshold.
  const priorityMap = new Float32Array(width * height);
  const mergeParams: MergeParams = {
    shapeSize: SHAPE_SIZE,
    simplification: clamp01(opts.regionCleanup) * 100,
    edgePreservation: clamp01(opts.edgePreservation) * 100,
    valuePreservation: 0, // focal-zone only — engaged once anchors land
    neutralProtection: clamp01(opts.neutralProtection) * 100,
  };
  const merged = mergeSmallIslands(regionOf, regions, clusters, priorityMap, width, mergeParams);
  const finalLabels = smoothLabels(merged, width, height, SMOOTH_PASSES);

  // ── 5. Build pools from the final cluster-label map. ──
  const poolPixels: number[][] = [];
  for (let c = 0; c < effK; c++) poolPixels.push([]);
  const cCount = new Int32Array(effK);
  const cLabSum = new Float64Array(effK * 3);
  const cXSum = new Float64Array(effK);
  const cYSum = new Float64Array(effK);
  const cXXSum = new Float64Array(effK);
  const cYYSum = new Float64Array(effK);
  const cMinX = new Int32Array(effK).fill(width);
  const cMaxX = new Int32Array(effK).fill(-1);
  const cMinY = new Int32Array(effK).fill(height);
  const cMaxY = new Int32Array(effK).fill(-1);
  let setMinX = width, setMaxX = -1, setMinY = height, setMaxY = -1;

  for (let j = 0; j < total; j++) {
    const i = indices[j];
    const c = finalLabels[i];
    if (c < 0 || c >= effK) continue;
    const o = i * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    const x = i % width, y = (i / width) | 0;
    poolPixels[c].push(i);
    cCount[c]++;
    cLabSum[c * 3] += L; cLabSum[c * 3 + 1] += a; cLabSum[c * 3 + 2] += b;
    cXSum[c] += x; cYSum[c] += y;
    cXXSum[c] += x * x; cYYSum[c] += y * y;
    if (x < cMinX[c]) cMinX[c] = x;
    if (x > cMaxX[c]) cMaxX[c] = x;
    if (y < cMinY[c]) cMinY[c] = y;
    if (y > cMaxY[c]) cMaxY[c] = y;
    if (x < setMinX) setMinX = x;
    if (x > setMaxX) setMaxX = x;
    if (y < setMinY) setMinY = y;
    if (y > setMaxY) setMaxY = y;
  }

  // Compactness baseline: positional variance of a uniform scatter over the
  // segmented set's bounding box.
  const refW = Math.max(0, setMaxX - setMinX);
  const refH = Math.max(0, setMaxY - setMinY);
  const refVar = (refW * refW + refH * refH) / 12;
  const xDen = width > 1 ? width - 1 : 1;
  const yDen = height > 1 ? height - 1 : 1;

  // ── Build pools (descriptor + sub-palette + noise split). ──
  const pools: Pool[] = [];
  const srcCluster: number[] = []; // parallel to `pools`: source cluster index
  for (let c = 0; c < effK; c++) {
    const cnt = cCount[c];
    if (cnt === 0) continue; // cluster fully merged away

    const meanL = cLabSum[c * 3] / cnt;
    const meanA = cLabSum[c * 3 + 1] / cnt;
    const meanB = cLabSum[c * 3 + 2] / cnt;
    const [mr, mg, mb] = labToRgb(meanL, meanA, meanB);

    const mx = cXSum[c] / cnt, my = cYSum[c] / cnt;
    const varX = Math.max(0, cXXSum[c] / cnt - mx * mx);
    const varY = Math.max(0, cYYSum[c] / cnt - my * my);
    const compactness = refVar > 1e-6
      ? clamp01(1 - (varX + varY) / refVar)
      : 1;

    const descriptor: PoolDescriptor = {
      r: mr, g: mg, b: mb,
      labL: meanL, labA: meanA, labB: meanB,
      chroma: Math.sqrt(meanA * meanA + meanB * meanB),
      valueBand: meanL < SHADOW_MAX_L ? "shadow" : meanL > HIGHLIGHT_MIN_L ? "highlight" : "mid",
      pixelCount: cnt,
      weight: total > 0 ? cnt / total : 0,
      compactness,
      centroidX: clamp01(mx / xDen),
      centroidY: clamp01(my / yDen),
      bboxX0: clamp01(cMinX[c] / xDen),
      bboxY0: clamp01(cMinY[c] / yDen),
      bboxX1: clamp01(cMaxX[c] / xDen),
      bboxY1: clamp01(cMaxY[c] / yDen),
    };

    const { subPalette, noise } = analyzePool(
      poolPixels[c], rgba, width,
      varX + varY, compactness,
      opts.subPaletteSize,
    );

    pools.push({ id: -1, descriptor, subPalette, noise, subPools: null });
    srcCluster.push(c);
  }

  // ── Assign ids, remap the assignment buffer, sort pools by weight. ──
  assignIds(pools, idStart, warmPools);
  const remap = new Int32Array(effK).fill(-1);
  for (let p = 0; p < pools.length; p++) remap[srcCluster[p]] = pools[p].id;
  for (let j = 0; j < total; j++) {
    const c = finalLabels[indices[j]];
    assignment[j] = c >= 0 && c < effK ? remap[c] : -1;
  }
  pools.sort((a, b) => b.descriptor.weight - a.descriptor.weight);

  return { pools, assignment };
}

// ────────── pass 2: per-pool sub-palette + noise split ──────────

// Splits a pool into a structured sub-palette plus an optional noise component.
// "Noise" is judged RELATIVE to the pool's own spatial spread: a sub-color is
// noise only when it is spread almost as widely as the whole pool (speckle,
// not a block). This keeps the split stable regardless of the cluster-sharpness
// or sub-palette-size controls. A pool that is itself diffuse gets no split.
function analyzePool(
  idx: number[],
  rgba: Uint8Array,
  width: number,
  poolVar: number,         // spatial variance (varX+varY) of the whole pool
  poolCompactness: number, // 0..1 compactness of the whole pool
  subPaletteSize: number,
): { subPalette: SubSwatch[]; noise: NoiseProfile | null } {
  const cnt = idx.length;
  if (cnt === 0) return { subPalette: [], noise: null };

  // Pack the pool's member pixels into a 1-row RGBA strip and reuse the global
  // k-means palette extractor on it.
  const strip = new Uint8Array(cnt * 4);
  for (let j = 0; j < cnt; j++) {
    const o = idx[j] * 4, d = j * 4;
    strip[d] = rgba[o]; strip[d + 1] = rgba[o + 1];
    strip[d + 2] = rgba[o + 2]; strip[d + 3] = 255;
  }
  const pal = extractPalette(strip, cnt, 1, Math.max(1, Math.floor(subPaletteSize)));
  const m = pal.length;
  if (m === 0) return { subPalette: [], noise: null };

  // Assign each pool pixel to its nearest sub-swatch (Lab) and accumulate the
  // spatial spread of each sub-swatch within the pool.
  const sx = new Float64Array(m), sy = new Float64Array(m);
  const sxx = new Float64Array(m), syy = new Float64Array(m);
  const sCount = new Int32Array(m);
  for (let j = 0; j < cnt; j++) {
    const o = idx[j] * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    let best = 0, bestD = Infinity;
    for (let s = 0; s < m; s++) {
      const dl = L - pal[s].labL, da = a - pal[s].labA, db = b - pal[s].labB;
      const d = dl * dl + da * da + db * db;
      if (d < bestD) { bestD = d; best = s; }
    }
    const px = idx[j] % width, py = (idx[j] / width) | 0;
    sx[best] += px; sy[best] += py;
    sxx[best] += px * px; syy[best] += py * py;
    sCount[best]++;
  }

  // Only split noise out of a pool that is itself reasonably coherent — within
  // a diffuse pool the structured/noise distinction is not meaningful.
  const splitNoise = poolCompactness >= DIFFUSE_POOL_FLOOR && poolVar > 1e-6;
  const structured: SubSwatch[] = [];
  const noisy: SubSwatch[] = [];
  for (let s = 0; s < m; s++) {
    // relativeSpread: this sub-color's spatial variance as a fraction of the
    // pool's. ≈1 → spread like the whole pool (speckle); «1 → a tight block.
    let relativeSpread = 0;
    if (sCount[s] > 0 && poolVar > 1e-6) {
      const mx = sx[s] / sCount[s], my = sy[s] / sCount[s];
      const vx = Math.max(0, sxx[s] / sCount[s] - mx * mx);
      const vy = Math.max(0, syy[s] / sCount[s] - my * my);
      relativeSpread = (vx + vy) / poolVar;
    }
    const swatch: SubSwatch = {
      r: pal[s].r, g: pal[s].g, b: pal[s].b,
      labL: pal[s].labL, labA: pal[s].labA, labB: pal[s].labB,
      weight: pal[s].weight,
      compactness: clamp01(1 - relativeSpread),
    };
    const isNoise = splitNoise
      && relativeSpread > NOISE_RELATIVE_SPREAD
      && swatch.weight < NOISE_MAX_WEIGHT;
    (isNoise ? noisy : structured).push(swatch);
  }

  structured.sort((a, b) => b.weight - a.weight);
  const noise: NoiseProfile | null = noisy.length > 0
    ? {
        swatches: noisy.sort((a, b) => b.weight - a.weight),
        weight: noisy.reduce((t, s) => t + s.weight, 0),
      }
    : null;
  return { subPalette: structured, noise };
}

// ────────── centroid init (cold k-means++ or warm-start) ──────────

function buildInitCentroids(
  sampleFeatures: Float32Array,
  n: number,
  effK: number,
  vw: number,
  cw: number,
  hw: number,
  warmPools?: Pool[],
): Float32Array {
  const cents = new Float32Array(effK * 4);
  let seeded = 0;

  // Warm-start: seed from the previous pools' mean Lab — reprojected through
  // the CURRENT bias weights — so pool identity and the partition stay stable
  // while the user drags the controls. warmPools is weight-sorted, so when
  // poolCount shrank we keep the heaviest pools.
  if (warmPools && warmPools.length > 0) {
    const take = Math.min(effK, warmPools.length);
    for (let c = 0; c < take; c++) {
      const d = warmPools[c].descriptor;
      buildFeature(d.labL, d.labA, d.labB, vw, cw, hw, cents, c * 4);
    }
    seeded = take;
  }

  // Cold start (or top up after a poolCount increase): deterministic
  // k-means++ — first centroid = first sample, each next = the sample
  // farthest from its nearest existing centroid. No Math.random.
  if (seeded === 0) {
    cents[0] = sampleFeatures[0];
    cents[1] = sampleFeatures[1];
    cents[2] = sampleFeatures[2];
    cents[3] = sampleFeatures[3];
    seeded = 1;
  }
  if (seeded < effK) {
    const nearest = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mn = Infinity;
      for (let c = 0; c < seeded; c++) {
        const d = sqDist4(sampleFeatures, i * 4, cents, c * 4);
        if (d < mn) mn = d;
      }
      nearest[i] = mn;
    }
    for (let c = seeded; c < effK; c++) {
      let bestI = 0, bestD = -1;
      for (let i = 0; i < n; i++) {
        if (nearest[i] > bestD) { bestD = nearest[i]; bestI = i; }
      }
      cents[c * 4]     = sampleFeatures[bestI * 4];
      cents[c * 4 + 1] = sampleFeatures[bestI * 4 + 1];
      cents[c * 4 + 2] = sampleFeatures[bestI * 4 + 2];
      cents[c * 4 + 3] = sampleFeatures[bestI * 4 + 3];
      for (let i = 0; i < n; i++) {
        const d = sqDist4(sampleFeatures, i * 4, cents, c * 4);
        if (d < nearest[i]) nearest[i] = d;
      }
    }
  }
  return cents;
}

// ────────── stable id assignment ──────────

// Cold: ids idStart..idStart+n-1 by weight. Warm: greedily match each new pool
// to the nearest previous pool by mean-Lab distance (one-to-one) and inherit
// its id; pools with no match get fresh ids past the previous maximum, so
// identity is monotonic and stable across re-segmentation.
function assignIds(pools: Pool[], idStart: number, warmPools?: Pool[]): void {
  if (!warmPools || warmPools.length === 0) {
    [...pools]
      .sort((a, b) => b.descriptor.weight - a.descriptor.weight)
      .forEach((p, i) => { p.id = idStart + i; });
    return;
  }

  let nextId = idStart;
  for (const p of warmPools) nextId = Math.max(nextId, p.id + 1);

  const pairs: { ni: number; pi: number; d: number }[] = [];
  for (let ni = 0; ni < pools.length; ni++) {
    const a = pools[ni].descriptor;
    for (let pi = 0; pi < warmPools.length; pi++) {
      const b = warmPools[pi].descriptor;
      const dl = a.labL - b.labL, da = a.labA - b.labA, db = a.labB - b.labB;
      pairs.push({ ni, pi, d: dl * dl + da * da + db * db });
    }
  }
  pairs.sort((p, q) => p.d - q.d);

  const usedNew = new Set<number>(), usedPrev = new Set<number>();
  for (const pr of pairs) {
    if (usedNew.has(pr.ni) || usedPrev.has(pr.pi)) continue;
    pools[pr.ni].id = warmPools[pr.pi].id;
    usedNew.add(pr.ni); usedPrev.add(pr.pi);
  }
  for (const p of pools) if (p.id < 0) p.id = nextId++;
}

// ────────── distance + color helpers ──────────

function sqDist4(f: Float32Array, fOff: number, cents: Float32Array, cOff: number): number {
  const d0 = f[fOff] - cents[cOff];
  const d1 = f[fOff + 1] - cents[cOff + 1];
  const d2 = f[fOff + 2] - cents[cOff + 2];
  const d3 = f[fOff + 3] - cents[cOff + 3];
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
}

function nearestCentroid(f: Float32Array, fOff: number, cents: Float32Array, k: number): number {
  let best = 0, bestD = Infinity;
  for (let c = 0; c < k; c++) {
    const d = sqDist4(f, fOff, cents, c * 4);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// CIE Lab (D65) → sRGB. palette.ts keeps its labToRgb private; the inverse is
// small, so we keep a local copy rather than widen that module's surface.
// Exported so the transfer step can convert recolored Lab values back to RGB.
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const finv = (t: number) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const X = finv(fx) * 0.95047, Y = finv(fy), Z = finv(fz) * 1.08883;
  const R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
  const B = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  const toS = (c: number) => {
    const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(x * 255)));
  };
  return [toS(R), toS(G), toS(B)];
}
