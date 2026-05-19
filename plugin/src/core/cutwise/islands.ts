// Ported from the CutWise plugin (plugin/src/core/islands.ts). Faithful copy of
// the connected-component labelling + small-island merge algorithm; no logic
// changes. CutWise's `Cluster` type and the `labDist2` helper (from its
// color.ts) are ported inline here — ColorSmash's palette/clusters modules
// expose rgbToLab/labToRgb but no Lab squared-distance helper or shared
// Cluster type, so the minimal pieces are duplicated rather than imported.
//
// Island analysis — the spatial half of CutWise.
//
// quantize.ts collapses color noise into K clusters but has no notion of
// *shapes*. labelComponents finds the connected runs of same-cluster pixels
// (the "islands"), and mergeSmallIslands absorbs islands whose area falls below
// a threshold into their nearest-color neighbour. The threshold is sampled from
// the anchor-driven priority map, so focal zones keep tiny shapes while tertiary
// zones collapse into broad masses — uniform algorithm, art-directed result.

export type Lab = [number, number, number];
export type Rgb = [number, number, number];

// A quantized color cluster. Mirrors CutWise's quantize.ts Cluster shape; the
// island merge only reads `lab` (for nearest-colour comparison), but `rgb` and
// `count` are kept so callers can build clusters faithfully.
export interface Cluster {
  rgb: Rgb;
  lab: Lab;
  // Pixel count assigned to this cluster — its prevalence in the image.
  count: number;
}

// Squared Euclidean distance in Lab. Squared form avoids the sqrt in hot loops;
// callers comparing distances don't need the true metric. Ported inline from
// CutWise's color.ts.
function labDist2(a: Lab, b: Lab): number {
  const dL = a[0] - b[0], dA = a[1] - b[1], dB = a[2] - b[2];
  return dL * dL + dA * dA + dB * dB;
}

export interface Region {
  id: number;
  cluster: number; // index into the clusters array
  size: number; // pixel area
}

export interface LabelResult {
  // One entry per pixel: region id, or -1 for transparent pixels.
  regionOf: Int32Array;
  regions: Region[];
}

// 4-connected connected-component labelling of a cluster-label map.
export function labelComponents(
  labels: Int32Array,
  width: number,
  height: number,
): LabelResult {
  const regionOf = new Int32Array(labels.length).fill(-1);
  const regions: Region[] = [];
  const stack = new Int32Array(labels.length);

  for (let start = 0; start < labels.length; start++) {
    if (regionOf[start] !== -1 || labels[start] === -1) continue;
    const cluster = labels[start];
    const id = regions.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    regionOf[start] = id;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % width, y = (p / width) | 0;
      if (x > 0 && regionOf[p - 1] === -1 && labels[p - 1] === cluster) {
        regionOf[p - 1] = id; stack[sp++] = p - 1;
      }
      if (x < width - 1 && regionOf[p + 1] === -1 && labels[p + 1] === cluster) {
        regionOf[p + 1] = id; stack[sp++] = p + 1;
      }
      if (y > 0 && regionOf[p - width] === -1 && labels[p - width] === cluster) {
        regionOf[p - width] = id; stack[sp++] = p - width;
      }
      if (y < height - 1 && regionOf[p + width] === -1 && labels[p + width] === cluster) {
        regionOf[p + width] = id; stack[sp++] = p + width;
      }
    }
    regions.push({ id, cluster, size });
  }
  return { regionOf, regions };
}

export interface MergeParams {
  // Island area, in pixels, that a fully-collapsed (tertiary) zone absorbs at
  // zero simplification. Focal zones keep every shape regardless; this only
  // sizes the low-priority end of the scale.
  shapeSize: number;
  // Global simplification 0..100. Scales the threshold in low-priority zones.
  simplification: number;
  // Edge protection 0..100. Higher = refuse to merge across strong colour
  // edges, so real contours survive even in heavily simplified zones.
  edgePreservation: number;
  // Value-contrast protection 0..100. Higher = refuse to merge a focal island
  // into a neighbour when doing so would erase a significant lightness (L) step,
  // keeping the focal subject's light/dark structure and silhouette readable.
  // Unlike edgePreservation this only engages in focal zones and only on L —
  // hue/chroma differences are ignored. 0 = no value protection (unchanged).
  valuePreservation: number;
}

// How aggressively low-priority zones inflate the merge threshold at full
// simplification: tertiary pixels collapse shapes up to ~60× the base size.
const MAX_BOOST = 60;
const EDGE_LOOSE = 8000; // Lab dist² ceiling at edgePreservation≈0
const EDGE_TIGHT = 60; // Lab dist² ceiling at edgePreservation=100

// Value-contrast protection: |ΔL| ceiling above which a focal merge is blocked.
// LOOSE = 100 spans the full L range, so at zero protection strength no merge is
// ever blocked — valuePreservation=0 is an exact no-op. TIGHT ≈ 12 is roughly
// the L step at which two tones read as distinct light/dark planes; at full
// strength any island whose L differs from its neighbour by more than that
// survives, keeping the focal subject's value structure intact.
const VALUE_LOOSE = 100;
const VALUE_TIGHT = 12;

// Minimal binary min-heap over (key, value) pairs. Used with lazy invalidation:
// stale entries are detected and skipped by the caller after popping.
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    this.keys.push(key); this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): { key: number; val: number } | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[0], val = this.vals[0];
    const lastK = this.keys.pop()!, lastV = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastK; this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return { key, val };
  }
  private swap(a: number, b: number): void {
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
    const tv = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = tv;
  }
}

// Merge under-threshold islands into their nearest-colour neighbour. Returns a
// per-pixel cluster index map (-1 for transparent) ready for recolouring.
export function mergeSmallIslands(
  regionOf: Int32Array,
  regions: Region[],
  clusters: Cluster[],
  priorityMap: Float32Array,
  width: number,
  params: MergeParams,
): Int32Array {
  const R = regions.length;
  const out = new Int32Array(regionOf.length);
  const height = regionOf.length / width;

  // Union-find over region ids; size/cluster/prioritySum tracked per root.
  const parent = new Int32Array(R);
  const size = new Float64Array(R);
  const clusterOf = new Int32Array(R);
  const prioritySum = new Float64Array(R);
  const neighbors: Set<number>[] = [];
  for (let i = 0; i < R; i++) {
    parent[i] = i;
    size[i] = regions[i].size;
    clusterOf[i] = regions[i].cluster;
    neighbors.push(new Set());
  }
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };

  // Accumulate priority sums and region adjacency in one pass over pixels.
  for (let p = 0; p < regionOf.length; p++) {
    const r = regionOf[p];
    if (r === -1) continue;
    prioritySum[r] += priorityMap[p];
    const x = p % width, y = (p / width) | 0;
    if (x < width - 1) {
      const b = regionOf[p + 1];
      if (b !== -1 && b !== r) { neighbors[r].add(b); neighbors[b].add(r); }
    }
    if (y < height - 1) {
      const b = regionOf[p + width];
      if (b !== -1 && b !== r) { neighbors[r].add(b); neighbors[b].add(r); }
    }
  }

  const sim = Math.max(0, Math.min(100, params.simplification)) / 100;
  const ep = Math.max(0, Math.min(100, params.edgePreservation)) / 100;
  const vp = Math.max(0, Math.min(100, params.valuePreservation)) / 100;
  const maxMergeDist2 = ep <= 0 ? Infinity : EDGE_LOOSE - ep * (EDGE_LOOSE - EDGE_TIGHT);

  // avgPriority(root) — region's mean anchor priority, clamped to 0..1.
  const avgPriority = (root: number): number => {
    const avg = prioritySum[root] / Math.max(1, size[root]);
    return avg < 0 ? 0 : avg > 1 ? 1 : avg;
  };

  // Largest merge threshold — reached in fully-collapsed (priority 0) zones.
  const maxThreshold = params.shapeSize * (1 + sim * MAX_BOOST);

  // threshold(root) — area below which this island gets absorbed. Lerps from 1
  // in focal zones (priority ≈ 1: every shape survives) up to maxThreshold in
  // tertiary zones (priority ≈ 0: collapse aggressively). Anchoring the focal
  // end at 1 — not shapeSize — is what makes focal anchors actually preserve
  // detail rather than merging everything below the base size everywhere.
  const threshold = (root: number): number => {
    const p = avgPriority(root);
    return 1 + (1 - p) * (maxThreshold - 1);
  };

  const heap = new MinHeap();
  for (let i = 0; i < R; i++) heap.push(size[i], i);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const root = find(top.val);
    // Stale entry: already merged, or size grew since this entry was pushed.
    if (root !== top.val || size[root] !== top.key) continue;
    if (size[root] >= threshold(root)) continue;

    // Nearest-colour neighbour, tie-breaking toward the larger island.
    const myLab = clusters[clusterOf[root]].lab;
    let best = -1, bestD = Infinity, bestSize = -1;
    for (const nb of neighbors[root]) {
      const nr = find(nb);
      if (nr === root) continue;
      const d = labDist2(myLab, clusters[clusterOf[nr]].lab);
      if (d < bestD || (d === bestD && size[nr] > bestSize)) {
        bestD = d; best = nr; bestSize = size[nr];
      }
    }
    if (best === -1) continue; // isolated island — nothing to merge into
    if (bestD > maxMergeDist2) continue; // sits on a real edge — protect it

    // Value-contrast protection: in focal zones, refuse a merge that would
    // erase a strong lightness step. Protection strength is vp × priority, so
    // tertiary islands are never protected (priority ≈ 0) and vp = 0 is a
    // no-op (ceiling stays at VALUE_LOOSE, which |ΔL| can never exceed).
    if (vp > 0) {
      const strength = vp * avgPriority(root);
      const valueCeil = VALUE_LOOSE - strength * (VALUE_LOOSE - VALUE_TIGHT);
      const dL = Math.abs(myLab[0] - clusters[clusterOf[best]].lab[0]);
      if (dL > valueCeil) continue; // strong value contrast in a focal zone
    }

    // Absorb root into best: best keeps its identity, cluster, and colour.
    parent[root] = best;
    size[best] += size[root];
    prioritySum[best] += prioritySum[root];
    for (const nb of neighbors[root]) {
      const nr = find(nb);
      if (nr === best) continue;
      neighbors[best].add(nr);
      neighbors[nr].delete(root);
      neighbors[nr].add(best);
    }
    neighbors[best].delete(root);
    heap.push(size[best], best);
  }

  for (let p = 0; p < regionOf.length; p++) {
    const r = regionOf[p];
    out[p] = r === -1 ? -1 : clusterOf[find(r)];
  }
  return out;
}
