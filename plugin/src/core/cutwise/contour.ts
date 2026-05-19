// Ported from the CutWise plugin (plugin/src/core/contour.ts). Faithful copy of
// the boundary-vectorization algorithm — contour trace, Ramer-Douglas-Peucker
// simplify, scanline rasterize, and the `vectorizeLabels` orchestrator; no
// logic changes. The only adaptation is the import of `labelComponents`, which
// is resolved against ColorSmash's already-ported `./islands` module.
//
// Contour vectorization — replaces the pipeline's nearest-neighbour upsample.
//
// Nearest-neighbour upscaling of a small (~340-512px) cluster-label map to full
// document resolution stamps each working pixel as a hard rectangle, so every
// shape edge follows the working-resolution grid: the output looks 8-bit blocky.
//
// Instead, trace each connected region's boundary as a polygon, simplify that
// polygon with Ramer-Douglas-Peucker, and rasterize the simplified polygons at
// full resolution. The boundary becomes a handful of straight facets rather
// than a per-pixel staircase, giving the clean, graphic, paper-cut edges of
// Photoshop's Cutout filter. Pure and deterministic — no RNG, no AI.

import { labelComponents } from "./islands";

type Point = { x: number; y: number };

// simplicity 0..100 -> RDP epsilon in working-resolution pixels.
// At 0, epsilon sits just below 1px so the polygon hugs the pixel boundary
// (only collinear runs collapse). At 100 it reaches MAX_EPSILON, faceting the
// contour into long straight edges. Linear lerp keeps the slider predictable.
const MIN_EPSILON = 0.5;
const MAX_EPSILON = 12;

function epsilonFor(simplicity: number): number {
  const s = Math.max(0, Math.min(100, simplicity)) / 100;
  return MIN_EPSILON + s * (MAX_EPSILON - MIN_EPSILON);
}

// Perpendicular distance from p to the line through a and b. Degenerate
// segments (a == b) fall back to the point-to-point distance.
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.x - a.x, ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const cross = Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y));
  return cross / Math.sqrt(len2);
}

// Ramer-Douglas-Peucker on an open polyline. Exported for unit testing.
export function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative stack of [start, end] index ranges to avoid deep recursion.
  const stack: number[] = [0, points.length - 1];
  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDist(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push(start, maxIdx, maxIdx, end);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Simplify a closed polygon: anchor RDP at the two extreme points so the
// closure does not bias which vertices survive, then drop a duplicated tail.
export function simplifyPolygon(ring: Point[], epsilon: number): Point[] {
  if (ring.length < 4) return ring.slice();

  // Split the ring at the pair of farthest-apart vertices so RDP sees two
  // open polylines whose endpoints are stable regardless of the trace origin.
  let aIdx = 0, bIdx = 0, far = -1;
  const probe = Math.min(ring.length, 64); // bounded scan keeps this cheap
  for (let i = 0; i < probe; i++) {
    const step = Math.max(1, Math.floor(ring.length / probe));
    const ii = i * step;
    for (let j = ii + 1; j < ring.length; j += step) {
      const dx = ring[ii].x - ring[j].x, dy = ring[ii].y - ring[j].y;
      const d = dx * dx + dy * dy;
      if (d > far) { far = d; aIdx = ii; bIdx = j; }
    }
  }
  if (aIdx > bIdx) { const t = aIdx; aIdx = bIdx; bIdx = t; }

  const first: Point[] = [];
  for (let i = aIdx; i <= bIdx; i++) first.push(ring[i]);
  const second: Point[] = [];
  for (let i = bIdx; i < ring.length; i++) second.push(ring[i]);
  for (let i = 0; i <= aIdx; i++) second.push(ring[i]);

  const s1 = rdpSimplify(first, epsilon);
  const s2 = rdpSimplify(second, epsilon);

  // s1 ends where s2 begins and s2 ends where s1 begins — drop both shared
  // endpoints when stitching so the closed polygon has no duplicate vertices.
  const out = s1.slice(0, s1.length - 1);
  for (let i = 0; i < s2.length - 1; i++) out.push(s2[i]);
  return out;
}

// Boundary trace of a single region's outer contour along the pixel-edge grid.
//
// Vertices are pixel *corners* (integer lattice points); each step walks one
// unit edge between corners. With screen coordinates (y increasing downward)
// the trace runs clockwise with the region on the RIGHT of the heading. At
// every corner the next direction is chosen from the two pixels touching the
// edge ahead — wall-following — yielding a closed polygon in working-
// resolution units. An axis-aligned run between turns emits only its
// endpoints, so straight stretches stay vertex-light.
function traceContour(
  regionOf: Int32Array,
  width: number,
  height: number,
  regionId: number,
  startPixel: number,
): Point[] {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height &&
    regionOf[y * width + x] === regionId;

  // Headings, clockwise around the region interior: right, up, left, down.
  const dx = [1, 0, -1, 0];
  const dy = [0, -1, 0, 1];

  const sx = startPixel % width;
  const sy = (startPixel / width) | 0;

  // Start at the top-left corner of the topmost-leftmost pixel, heading right
  // along its top edge: that pixel has no inside neighbour above, so the edge
  // is a real boundary and the region sits below — on the right of the
  // heading, as the clockwise convention requires.
  const startX = sx, startY = sy;
  const startDir = 0;
  let cx = startX, cy = startY;
  let dir = startDir;
  const pts: Point[] = [];
  let lastDir = -1;

  const maxSteps = width * height * 8 + 8; // hard cap against pathological loops
  for (let steps = 0; steps < maxSteps; steps++) {
    // Emit a vertex only at turns; collinear corners are skipped.
    if (dir !== lastDir) pts.push({ x: cx, y: cy });
    lastDir = dir;

    cx += dx[dir];
    cy += dy[dir];

    // The four pixel cells meeting at the corner just reached.
    const tl = inside(cx - 1, cy - 1);
    const tr = inside(cx, cy - 1);
    const bl = inside(cx - 1, cy);
    const br = inside(cx, cy);

    // Wall-following, region on the RIGHT of the heading. `rightCell` is the
    // cell that must be inside to continue straight; `leftCell` is the cell
    // whose presence means the wall bends and we turn left. Neither inside =>
    // the wall ends and we turn right into the region. (left = dir+1,
    // right = dir+3, mod 4.)
    let rightCell: boolean;
    let leftCell: boolean;
    switch (dir) {
      case 0: rightCell = br; leftCell = tr; break; // heading right
      case 1: rightCell = tr; leftCell = tl; break; // heading up
      case 2: rightCell = tl; leftCell = bl; break; // heading left
      default: rightCell = bl; leftCell = br; break; // heading down
    }

    if (leftCell) {
      dir = (dir + 1) & 3; // wall on the left — turn left
    } else if (!rightCell) {
      dir = (dir + 3) & 3; // wall ended — turn right into the region
    }
    // else: straight edge continues, dir unchanged.

    // Closed when back at the start corner about to repeat the first edge.
    if (cx === startX && cy === startY && dir === startDir) break;
  }

  return pts;
}

// Even-odd scanline fill of a polygon into `out`, scaled by (sx, sy) from
// working units to output units, painting `value`. Bounded to [0, outW/H).
function fillPolygon(
  out: Int32Array,
  outW: number,
  outH: number,
  poly: Point[],
  sx: number,
  sy: number,
  value: number,
): void {
  if (poly.length < 3) return;

  let minY = Infinity, maxY = -Infinity;
  const px: number[] = new Array(poly.length);
  const py: number[] = new Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    px[i] = poly[i].x * sx;
    py[i] = poly[i].y * sy;
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }

  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(outH - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const scan = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = py[i], yj = py[j];
      if ((yi <= scan && yj > scan) || (yj <= scan && yi > scan)) {
        const t = (scan - yi) / (yj - yi);
        xs.push(px[i] + t * (px[j] - px[i]));
      }
    }
    xs.sort((a, b) => a - b);
    const row = y * outW;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(outW - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) out[row + x] = value;
    }
  }
}

// Nearest-neighbour fill of a region's own pixels — the fallback when a
// region's simplified polygon degenerates so no region silently vanishes.
function fillRegionNearest(
  out: Int32Array,
  regionOf: Int32Array,
  width: number,
  height: number,
  outW: number,
  outH: number,
  regionId: number,
  value: number,
): void {
  const sx = width / outW;
  const sy = height / outH;
  for (let y = 0; y < outH; y++) {
    const wy = Math.min(height - 1, (y * sy) | 0);
    const row = y * outW;
    for (let x = 0; x < outW; x++) {
      const wx = Math.min(width - 1, (x * sx) | 0);
      if (regionOf[wy * width + wx] === regionId) out[row + x] = value;
    }
  }
}

// Vectorize a working-resolution cluster-label map into a full-resolution one.
//
// Each connected component is traced into a polygon, RDP-simplified, then
// rasterized largest-first: painting big regions before the small ones they
// contain lets nested regions and holes resolve without explicit hole tracing.
export function vectorizeLabels(
  labels: Int32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  simplicity: number,
): Int32Array {
  const out = new Int32Array(outWidth * outHeight).fill(-1);
  if (width <= 0 || height <= 0 || outWidth <= 0 || outHeight <= 0) return out;

  // Base layer: a nearest-neighbour upscale of the label map. Each region's
  // contour is traced and simplified independently, so neighbouring polygons
  // no longer share their common edge exactly — that leaves hairline gaps
  // between them. Painting the simplified polygons over this base means any
  // such sliver falls through to the correct region instead of a crack.
  for (let y = 0; y < outHeight; y++) {
    const wy = Math.min(height - 1, ((y * height) / outHeight) | 0);
    const wrow = wy * width;
    const orow = y * outWidth;
    for (let x = 0; x < outWidth; x++) {
      const wx = Math.min(width - 1, ((x * width) / outWidth) | 0);
      out[orow + x] = labels[wrow + wx];
    }
  }

  const { regionOf, regions } = labelComponents(labels, width, height);
  if (regions.length === 0) return out;

  const epsilon = epsilonFor(simplicity);
  const scaleX = outWidth / width;
  const scaleY = outHeight / height;

  // One representative start pixel per region: its topmost-then-leftmost pixel,
  // which is guaranteed to have no inside neighbour above it.
  const startOf = new Int32Array(regions.length).fill(-1);
  for (let p = 0; p < regionOf.length; p++) {
    const r = regionOf[p];
    if (r !== -1 && startOf[r] === -1) startOf[r] = p;
  }

  // Largest-first so smaller contained regions paint on top.
  const order = regions.map((r) => r.id);
  order.sort((a, b) => regions[b].size - regions[a].size);

  for (const id of order) {
    const cluster = regions[id].cluster;
    const start = startOf[id];
    if (start === -1) continue;

    const ring = traceContour(regionOf, width, height, id, start);
    const poly = simplifyPolygon(ring, epsilon);

    if (poly.length < 3) {
      fillRegionNearest(
        out, regionOf, width, height, outWidth, outHeight, id, cluster,
      );
      continue;
    }
    fillPolygon(out, outWidth, outHeight, poly, scaleX, scaleY, cluster);
  }

  return out;
}
