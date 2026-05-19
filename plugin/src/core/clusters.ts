// Content-following hierarchical color segmentation.
//
// Pass 1 (macro): color-only Lab k-means quantizes the image into pool colors;
// connected-component "islands" then give the spatial structure, and small
// islands are merged into neighbours with edge protection (CutWise's island
// logic). Because no spatial term is mixed into the clustering, pool
// boundaries follow real image content instead of forming convex tiles.
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
  poolCount: number;        // k for the color quantize, e.g. 2..12
  edgePreservation: number; // 0..1 — refuse island merges across strong color edges
  regionCleanup: number;    // 0..1 — how aggressively small islands are absorbed
  subPaletteSize: number;   // k for each pool's sub-palette, e.g. 3..7
}

export interface SegmentResult {
  width: number;
  height: number;
  labels: Int32Array;       // length width*height, id of the MOST-SPECIFIC pool
                            // assigned to each pixel (-1 = transparent)
  pools: Pool[];            // top-level pools, sorted by descriptor.weight desc
}

// ────────── Tuning constants ──────────

// Decimate input for the k-means fit (mirrors palette.ts SAMPLE_STRIDE). Labels
// are still produced for every full-res pixel after the fit converges.
const SAMPLE_STRIDE = 4;
const MAX_ITERATIONS = 16;
const CONVERGENCE_THRESHOLD = 0.5; // mean centroid shift below which we stop

// Base island area (px) absorbed at zero Region cleanup — the despeckle floor.
// Region cleanup scales the merge threshold up from here.
const SHAPE_SIZE = 12;
// Majority-filter passes that clean the merged label map's contours.
const SMOOTH_PASSES = 2;

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

interface Sample {
  // Lab feature vector — color-only k-means (no spatial term).
  fl: number; fa: number; fb: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

// ────────── pass 1: segment a pixel set into pools ──────────

// Core segmentation pass over an arbitrary list of pixel indices (the whole
// image for segmentImage, one pool's pixels for expandPool):
//   1. color-only Lab k-means → a per-pixel cluster-label map
//   2. connected-component islands on that map (CutWise)
//   3. edge-protected merge of small islands into neighbours (CutWise)
//   4. majority-filter smoothing (CutWise)
//   5. build Pool[] (descriptor + sub-palette + noise) from the final labels
// `assignment[j]` is the pool id chosen for `indices[j]`.
function segmentPixelSet(
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

  // ── 1. Color-only Lab k-means. Decimated samples drive the fit. ──
  const samples: Sample[] = [];
  for (let j = 0; j < total; j += SAMPLE_STRIDE) {
    const o = indices[j] * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    samples.push({ fl: L, fa: a, fb: b });
  }
  const n = samples.length;
  if (n === 0) return { pools: [], assignment };
  const effK = Math.min(k, n);

  const cents = buildInitCentroids(samples, n, effK, warmPools);
  const assign = new Int32Array(n);
  const sums = new Float64Array(effK * 3);
  const counts = new Int32Array(effK);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) assign[i] = nearestCentroid(samples[i], cents, effK);
    sums.fill(0); counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i], s = samples[i];
      sums[c * 3] += s.fl; sums[c * 3 + 1] += s.fa; sums[c * 3 + 2] += s.fb;
      counts[c]++;
    }
    let totalShift = 0;
    for (let c = 0; c < effK; c++) {
      if (counts[c] === 0) continue; // dead cluster — leave centroid in place
      let shift = 0;
      for (let d = 0; d < 3; d++) {
        const nv = sums[c * 3 + d] / counts[c];
        const dv = nv - cents[c * 3 + d];
        shift += dv * dv;
        cents[c * 3 + d] = nv;
      }
      totalShift += Math.sqrt(shift);
    }
    if (totalShift / effK < CONVERGENCE_THRESHOLD) break;
  }

  // ── 2. Assign every pixel → a width*height cluster-label map. ──
  const clusterLabels = new Int32Array(width * height).fill(-1);
  const clusterCount = new Int32Array(effK);
  const tmp: Sample = { fl: 0, fa: 0, fb: 0 };
  for (let j = 0; j < total; j++) {
    const o = indices[j] * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    tmp.fl = L; tmp.fa = a; tmp.fb = b;
    const c = nearestCentroid(tmp, cents, effK);
    clusterLabels[indices[j]] = c;
    clusterCount[c]++;
  }

  // Cluster colors for the island-merge nearest-color test.
  const clusters: Cluster[] = [];
  for (let c = 0; c < effK; c++) {
    const L = cents[c * 3], a = cents[c * 3 + 1], b = cents[c * 3 + 2];
    clusters.push({ rgb: labToRgb(L, a, b), lab: [L, a, b], count: clusterCount[c] });
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
  samples: Sample[],
  n: number,
  effK: number,
  warmPools?: Pool[],
): Float32Array {
  const cents = new Float32Array(effK * 3);
  let seeded = 0;

  // Warm-start: seed from the previous pools' mean Lab so pool identity and
  // the partition stay stable while the user drags a control. warmPools is
  // weight-sorted, so when poolCount shrank we keep the heaviest pools.
  if (warmPools && warmPools.length > 0) {
    const take = Math.min(effK, warmPools.length);
    for (let c = 0; c < take; c++) {
      const d = warmPools[c].descriptor;
      cents[c * 3] = d.labL; cents[c * 3 + 1] = d.labA; cents[c * 3 + 2] = d.labB;
    }
    seeded = take;
  }

  // Cold start (or top up after a poolCount increase): deterministic
  // k-means++ — first centroid = first sample, each next = the sample
  // farthest from its nearest existing centroid. No Math.random.
  if (seeded === 0) {
    const s0 = samples[0];
    cents[0] = s0.fl; cents[1] = s0.fa; cents[2] = s0.fb;
    seeded = 1;
  }
  if (seeded < effK) {
    const nearest = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mn = Infinity;
      for (let c = 0; c < seeded; c++) {
        const d = sqDist3(samples[i], cents, c);
        if (d < mn) mn = d;
      }
      nearest[i] = mn;
    }
    for (let c = seeded; c < effK; c++) {
      let bestI = 0, bestD = -1;
      for (let i = 0; i < n; i++) {
        if (nearest[i] > bestD) { bestD = nearest[i]; bestI = i; }
      }
      const s = samples[bestI];
      cents[c * 3] = s.fl; cents[c * 3 + 1] = s.fa; cents[c * 3 + 2] = s.fb;
      for (let i = 0; i < n; i++) {
        const d = sqDist3(samples[i], cents, c);
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

function sqDist3(s: Sample, cents: Float32Array, c: number): number {
  const dl = s.fl - cents[c * 3];
  const da = s.fa - cents[c * 3 + 1];
  const db = s.fb - cents[c * 3 + 2];
  return dl * dl + da * da + db * db;
}

function nearestCentroid(s: Sample, cents: Float32Array, k: number): number {
  let best = 0, bestD = Infinity;
  for (let c = 0; c < k; c++) {
    const d = sqDist3(s, cents, c);
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
