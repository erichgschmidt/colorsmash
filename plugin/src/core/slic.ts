// SLIC (Simple Linear Iterative Clustering) superpixel segmentation.
//
// SLIC seeds K cluster centers on a regular grid of step S = sqrt(N/K), then
// iterates Lloyd-style in a 5-D space (L, a, b, x, y) with a restricted 2S×2S
// search window per center — that locality is what keeps SLIC near-linear in
// pixel count regardless of K. The distance metric trades color against space:
//
//   D² = d_lab² + (m² · d_xy²) / S²
//
// where m (compactness) is a tunable knob — higher m → spatially compact, more
// regular superpixels; lower m → boundaries hug color edges more tightly.
//
// After convergence the assignment can leave a few tiny disconnected fragments
// inside a superpixel (Lloyd guarantees no spatial connectivity); a final
// connected-component sweep relabels fragments below a small area threshold by
// merging them into their largest 4-neighbour superpixel.
//
// Used as the analysis unit by `segmentPixelSet` in clusters.ts: instead of
// running pool k-means on raw decimated pixels (noisy, slow on real photos),
// SLIC first collapses the pixel set into a few hundred small, color-coherent,
// edge-aware regions, and pool k-means runs over THOSE — far stabler partitions
// with no change to downstream merge / smooth / pool-building.

import { rgbToLab } from "./palette";

// ────────── Public interface ──────────

export interface SuperpixelCenter {
  // Mean Lab of the superpixel's member pixels.
  L: number; a: number; b: number;
  // Mean xy of the superpixel's member pixels, in pixel coords.
  x: number; y: number;
  // Number of pixels assigned to this superpixel.
  count: number;
}

export interface SuperpixelResult {
  // Length width*height. Superpixel id per pixel, -1 for pixels excluded by
  // `indices` (or transparent). Ids are 0..centers.length-1 and dense.
  labels: Int32Array;
  centers: SuperpixelCenter[];
}

export interface SlicOptions {
  // Approximate target superpixel count. Actual count after the connectivity
  // sweep may be slightly different (empty superpixels are dropped, fragments
  // merged in).
  K: number;
  // Spatial regularization knob in the distance metric. Typical 10..40; higher
  // = more spatially compact superpixels (rounder, more tile-like). Lower lets
  // boundaries hug color edges more aggressively.
  compactness: number;
  // Lloyd iterations. Default 10 — SLIC converges fast; 4..10 is plenty.
  iterations?: number;
}

const DEFAULT_ITERATIONS = 10;

// Connectivity sweep absorbs fragments smaller than (S² / FRAGMENT_DIVISOR)
// into a neighbour. S² is the nominal superpixel area, so a divisor of 4 means
// "smaller than a quarter of a normal superpixel" — typical SLIC threshold.
const FRAGMENT_DIVISOR = 4;

// ────────── Algorithm ──────────

export function slic(
  rgba: Uint8Array,
  width: number,
  height: number,
  indices: number[],
  opts: SlicOptions,
): SuperpixelResult {
  const labels = new Int32Array(width * height).fill(-1);
  const N = indices.length;
  if (N === 0) return { labels, centers: [] };

  const K = Math.max(1, Math.floor(opts.K));
  const m = Math.max(0.001, opts.compactness);
  const iterations = Math.max(1, Math.floor(opts.iterations ?? DEFAULT_ITERATIONS));

  // Precompute Lab for every pixel in the index set. We index into these arrays
  // by pixel position p = y*width + x (sparse — only pixels in `indices` have
  // meaningful entries), so subsequent passes never call rgbToLab again.
  const labL = new Float32Array(width * height);
  const labA = new Float32Array(width * height);
  const labB = new Float32Array(width * height);
  const isMember = new Uint8Array(width * height);
  // Bounding box of the index set — seeds and per-pixel iteration are clipped
  // to it so we never spend work on empty corners (e.g. inside expandPool).
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let j = 0; j < N; j++) {
    const p = indices[j];
    const o = p * 4;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    labL[p] = L; labA[p] = a; labB[p] = b;
    isMember[p] = 1;
    const x = p % width, y = (p / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  // Grid step S — sized so a uniform K×K grid covers N pixels. Floor so the
  // grid is never empty (S≥1) but it's still possible for the actual seed
  // count to slightly differ from K depending on member shape.
  const S = Math.max(1, Math.round(Math.sqrt(N / K)));

  // Seed grid centers across the index-set bounding box. Skip cells whose
  // anchor pixel isn't a member (e.g. masked-out regions). Each center stores
  // its current (L, a, b, x, y) — initialized to the anchor pixel.
  const centersL: number[] = [];
  const centersA: number[] = [];
  const centersB: number[] = [];
  const centersX: number[] = [];
  const centersY: number[] = [];
  const halfS = S >> 1;
  for (let cy = minY + halfS; cy <= maxY; cy += S) {
    for (let cx = minX + halfS; cx <= maxX; cx += S) {
      // If the grid anchor isn't a member, search a small neighbourhood for
      // the nearest member — keeps seeds even on irregularly-shaped masks.
      let seedX = cx, seedY = cy;
      if (!isMember[seedY * width + seedX]) {
        let found = false;
        for (let r = 1; r <= halfS && !found; r++) {
          for (let dy = -r; dy <= r && !found; dy++) {
            const ny = cy + dy;
            if (ny < minY || ny > maxY) continue;
            for (let dx = -r; dx <= r && !found; dx++) {
              const nx = cx + dx;
              if (nx < minX || nx > maxX) continue;
              if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring boundary
              if (isMember[ny * width + nx]) {
                seedX = nx; seedY = ny; found = true;
              }
            }
          }
        }
        if (!found) continue;
      }
      const p = seedY * width + seedX;
      centersL.push(labL[p]);
      centersA.push(labA[p]);
      centersB.push(labB[p]);
      centersX.push(seedX);
      centersY.push(seedY);
    }
  }

  // Degenerate index set (smaller than one grid cell): seed a single center at
  // the first member pixel so we still produce a valid (single-superpixel)
  // result rather than returning an empty labels map.
  if (centersL.length === 0) {
    const p0 = indices[0];
    centersL.push(labL[p0]);
    centersA.push(labA[p0]);
    centersB.push(labB[p0]);
    centersX.push(p0 % width);
    centersY.push((p0 / width) | 0);
  }

  let kEff = centersL.length;

  // SLIC distance scaling. The "/ S²" on the spatial term keeps m roughly scale-
  // invariant; we cache m²/S² so the per-pixel loop is multiply-add only.
  const spaceWeight = (m * m) / (S * S);

  const labelOf = new Int32Array(width * height).fill(-1);
  const minDist = new Float32Array(width * height);

  // Lloyd iterations.
  for (let iter = 0; iter < iterations; iter++) {
    // Initialize the distance map to +Infinity each iteration. Pixels never
    // touched stay -1 → they were not within any center's 2S window (rare for
    // a healthy seed grid, but tolerated below).
    labelOf.fill(-1);
    minDist.fill(Infinity);

    for (let c = 0; c < kEff; c++) {
      const cL = centersL[c], cA = centersA[c], cB = centersB[c];
      const cx = centersX[c], cy = centersY[c];
      // Center coords can be non-integer after the Lloyd update; clamp the
      // search window to integer pixel coords with a ceil/floor.
      const x0 = Math.max(minX, Math.ceil(cx - S));
      const x1 = Math.min(maxX, Math.floor(cx + S));
      const y0 = Math.max(minY, Math.ceil(cy - S));
      const y1 = Math.min(maxY, Math.floor(cy + S));
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          const p = row + x;
          if (!isMember[p]) continue;
          const dL = labL[p] - cL;
          const dA = labA[p] - cA;
          const dB = labB[p] - cB;
          const dx = x - cx, dy = y - cy;
          const d = dL * dL + dA * dA + dB * dB + (dx * dx + dy * dy) * spaceWeight;
          if (d < minDist[p]) {
            minDist[p] = d;
            labelOf[p] = c;
          }
        }
      }
    }

    // Fallback: any member pixel left untouched (no nearby center) gets the
    // globally nearest center by spatial distance. Cheap because it's rare.
    for (let j = 0; j < N; j++) {
      const p = indices[j];
      if (labelOf[p] !== -1) continue;
      const x = p % width, y = (p / width) | 0;
      let best = 0, bestD = Infinity;
      for (let c = 0; c < kEff; c++) {
        const dx = x - centersX[c], dy = y - centersY[c];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c; }
      }
      labelOf[p] = best;
    }

    // Update centers as means of their member pixels.
    const sumL = new Float64Array(kEff);
    const sumA = new Float64Array(kEff);
    const sumB = new Float64Array(kEff);
    const sumX = new Float64Array(kEff);
    const sumY = new Float64Array(kEff);
    const count = new Int32Array(kEff);
    for (let j = 0; j < N; j++) {
      const p = indices[j];
      const c = labelOf[p];
      if (c < 0) continue;
      sumL[c] += labL[p]; sumA[c] += labA[p]; sumB[c] += labB[p];
      sumX[c] += p % width; sumY[c] += (p / width) | 0;
      count[c]++;
    }
    for (let c = 0; c < kEff; c++) {
      if (count[c] === 0) continue; // dead center — leave in place
      const inv = 1 / count[c];
      centersL[c] = sumL[c] * inv;
      centersA[c] = sumA[c] * inv;
      centersB[c] = sumB[c] * inv;
      centersX[c] = sumX[c] * inv;
      centersY[c] = sumY[c] * inv;
    }
  }

  // ── Connectivity enforcement ──
  //
  // SLIC's per-pixel argmin doesn't guarantee that each superpixel is one
  // connected region — a center can claim two disjoint blobs. Run a flood-fill
  // over the labelOf map; fragments below the area threshold get merged into
  // their largest 4-neighbour fragment (which may itself be small, so we sort
  // fragments by size ascending and absorb each into the largest neighbour
  // alive at that moment).
  const fragmentThreshold = Math.max(
    1,
    Math.floor((S * S) / FRAGMENT_DIVISOR),
  );
  const result = enforceConnectivity(
    labelOf, isMember, width, height, kEff, fragmentThreshold,
  );

  // ── Compact final labels → 0..n-1 and build center descriptors. ──
  const finalLabels = result.labels;
  const fragmentLabel = result.fragmentLabel; // per-pixel "fragment id" used internally
  // We use finalLabels (the post-merge superpixel ids) for the output, and
  // recompute the means from the actual pixel assignments — the centersX/Y
  // from Lloyd are pre-merge and would be wrong for the absorbed regions.
  // Find the set of live superpixel ids.
  const remap = new Int32Array(kEff).fill(-1);
  let liveCount = 0;
  for (let j = 0; j < N; j++) {
    const c = finalLabels[indices[j]];
    if (c < 0) continue;
    if (remap[c] === -1) { remap[c] = liveCount++; }
  }
  const sumL2 = new Float64Array(liveCount);
  const sumA2 = new Float64Array(liveCount);
  const sumB2 = new Float64Array(liveCount);
  const sumX2 = new Float64Array(liveCount);
  const sumY2 = new Float64Array(liveCount);
  const count2 = new Int32Array(liveCount);
  for (let j = 0; j < N; j++) {
    const p = indices[j];
    const cOld = finalLabels[p];
    if (cOld < 0) { labels[p] = -1; continue; }
    const cNew = remap[cOld];
    labels[p] = cNew;
    sumL2[cNew] += labL[p]; sumA2[cNew] += labA[p]; sumB2[cNew] += labB[p];
    sumX2[cNew] += p % width; sumY2[cNew] += (p / width) | 0;
    count2[cNew]++;
  }
  const centers: SuperpixelCenter[] = [];
  for (let c = 0; c < liveCount; c++) {
    const cnt = count2[c];
    if (cnt === 0) {
      centers.push({ L: 0, a: 0, b: 0, x: 0, y: 0, count: 0 });
      continue;
    }
    const inv = 1 / cnt;
    centers.push({
      L: sumL2[c] * inv,
      a: sumA2[c] * inv,
      b: sumB2[c] * inv,
      x: sumX2[c] * inv,
      y: sumY2[c] * inv,
      count: cnt,
    });
  }
  // Silence the unused warning — fragmentLabel is computed for debug only.
  void fragmentLabel;
  return { labels, centers };
}

// ────────── Connectivity helpers ──────────

// Sweep the Lloyd labelOf map, flood-fill each connected component, then
// absorb fragments below `threshold` into their largest 4-neighbour fragment.
// Returns a new label map (still on the original superpixel id space — the
// caller compacts to dense ids).
function enforceConnectivity(
  labelOf: Int32Array,
  isMember: Uint8Array,
  width: number,
  height: number,
  kEff: number,
  threshold: number,
): { labels: Int32Array; fragmentLabel: Int32Array } {
  void kEff;
  const N = labelOf.length;
  const fragmentLabel = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);

  // Flood-fill each connected, same-superpixel-id region → fragment ids.
  interface Fragment { id: number; superpixel: number; size: number; pixels: number[]; }
  const fragments: Fragment[] = [];
  for (let start = 0; start < N; start++) {
    if (fragmentLabel[start] !== -1 || !isMember[start] || labelOf[start] < 0) continue;
    const sp = labelOf[start];
    const id = fragments.length;
    fragmentLabel[start] = id;
    let sptr = 0;
    stack[sptr++] = start;
    const pixels: number[] = [];
    while (sptr > 0) {
      const p = stack[--sptr];
      pixels.push(p);
      const x = p % width, y = (p / width) | 0;
      if (x > 0)            { const q = p - 1;     if (fragmentLabel[q] === -1 && labelOf[q] === sp) { fragmentLabel[q] = id; stack[sptr++] = q; } }
      if (x < width - 1)    { const q = p + 1;     if (fragmentLabel[q] === -1 && labelOf[q] === sp) { fragmentLabel[q] = id; stack[sptr++] = q; } }
      if (y > 0)            { const q = p - width; if (fragmentLabel[q] === -1 && labelOf[q] === sp) { fragmentLabel[q] = id; stack[sptr++] = q; } }
      if (y < height - 1)   { const q = p + width; if (fragmentLabel[q] === -1 && labelOf[q] === sp) { fragmentLabel[q] = id; stack[sptr++] = q; } }
    }
    fragments.push({ id, superpixel: sp, size: pixels.length, pixels });
  }

  // Union-find over fragment ids; absorbed fragments inherit their target's
  // superpixel label.
  const F = fragments.length;
  const parent = new Int32Array(F);
  const superpixelOf = new Int32Array(F);
  const sizeOf = new Int32Array(F);
  for (let i = 0; i < F; i++) {
    parent[i] = i;
    superpixelOf[i] = fragments[i].superpixel;
    sizeOf[i] = fragments[i].size;
  }
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };

  // Build fragment-adjacency lists by scanning pixels. Small allocations are
  // fine here — fragments are typically O(K) which is far below pixel count.
  const adj: Set<number>[] = [];
  for (let i = 0; i < F; i++) adj.push(new Set());
  for (let p = 0; p < N; p++) {
    const f = fragmentLabel[p];
    if (f < 0) continue;
    const x = p % width, y = (p / width) | 0;
    if (x < width - 1) {
      const g = fragmentLabel[p + 1];
      if (g >= 0 && g !== f) { adj[f].add(g); adj[g].add(f); }
    }
    if (y < height - 1) {
      const g = fragmentLabel[p + width];
      if (g >= 0 && g !== f) { adj[f].add(g); adj[g].add(f); }
    }
  }

  // Process fragments smallest-first; absorb each under-threshold fragment
  // into its largest neighbour (any neighbour, not just same-superpixel ones).
  // The neighbour adopts our pixels and our adjacency; we keep going until no
  // under-threshold fragments are left or none have neighbours.
  const order: number[] = [];
  for (let i = 0; i < F; i++) order.push(i);
  order.sort((a, b) => fragments[a].size - fragments[b].size);

  for (const idx of order) {
    const root = find(idx);
    if (sizeOf[root] >= threshold) continue;
    let best = -1, bestSize = -1;
    for (const nb of adj[root]) {
      const nr = find(nb);
      if (nr === root) continue;
      if (sizeOf[nr] > bestSize) { bestSize = sizeOf[nr]; best = nr; }
    }
    if (best === -1) continue; // isolated (e.g. one component covers all)
    // Absorb root → best: best keeps its superpixel id.
    parent[root] = best;
    sizeOf[best] += sizeOf[root];
    for (const nb of adj[root]) {
      const nr = find(nb);
      if (nr === best) continue;
      adj[best].add(nr);
      adj[nr].delete(root);
      adj[nr].add(best);
    }
    adj[best].delete(root);
  }

  // Build the final per-pixel superpixel label = superpixelOf[find(fragment)].
  const out = new Int32Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    const f = fragmentLabel[p];
    if (f < 0) continue;
    out[p] = superpixelOf[find(f)];
  }
  return { labels: out, fragmentLabel };
}
