// Vector region geometry — polygons in normalized (0..1) image coordinates.
//
// Used by the lasso/vector split tool: a freehand path is simplified to a
// polygon (so it has a handful of draggable vertices, not hundreds of raw
// points), rasterized to the pixel set the segmenter re-clusters, and given a
// soft INWARD falloff for feathering. Pure geometry — no image/segmentation
// deps — so it's trivially testable and reusable at any resolution.

export interface Pt { x: number; y: number; }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ────────── simplification (Ramer–Douglas–Peucker) ──────────

// Perpendicular distance from p to the line through a→b (normalized coords).
function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    const ex = p.x - a.x, ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // distance from point to infinite line = |cross| / |dir|
  const cross = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx);
  return cross / Math.sqrt(len2);
}

function rdp(points: Pt[], tol: number): Pt[] {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    const left = rdp(points.slice(0, idx + 1), tol);
    const right = rdp(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// Simplify a freehand path (normalized coords) to a handful of vertices. The
// path is treated as a CLOSED loop (a lasso): we RDP the open chain then drop a
// trailing vertex if it coincides with the first. Tolerance is in normalized
// units (fraction of the image's smaller-ish dimension); ~0.01 is a good lasso
// default. Always returns at least a triangle when the input has area.
export function simplifyPolygon(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 3) return points.slice();
  const simplified = rdp(points, tolerance);
  // Drop a duplicate closing vertex if present.
  if (simplified.length > 3) {
    const first = simplified[0], last = simplified[simplified.length - 1];
    const dx = first.x - last.x, dy = first.y - last.y;
    if (dx * dx + dy * dy < 1e-8) simplified.pop();
  }
  return simplified.length >= 3 ? simplified : points.slice(0, 3);
}

// ────────── measures ──────────

export function polygonCentroid(points: Pt[]): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / points.length, y: sy / points.length };
}

// Even-odd ray-cast point-in-polygon (normalized coords).
export function polygonContains(points: Pt[], x: number, y: number): boolean {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + (yj === yi ? 1e-12 : 0)) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Normalized bounding box of a polygon, clamped to 0..1.
export function polygonBBox(points: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0: clamp01(x0), y0: clamp01(y0), x1: clamp01(x1), y1: clamp01(y1) };
}

// ────────── rasterization ──────────

// Pixel indices whose CENTRE falls inside the polygon, scanning only the bbox.
export function polygonPixelIndices(points: Pt[], width: number, height: number): number[] {
  if (points.length < 3) return [];
  const bb = polygonBBox(points);
  const x0 = Math.max(0, Math.floor(bb.x0 * width));
  const x1 = Math.min(width - 1, Math.ceil(bb.x1 * width));
  const y0 = Math.max(0, Math.floor(bb.y0 * height));
  const y1 = Math.min(height - 1, Math.ceil(bb.y1 * height));
  const out: number[] = [];
  for (let py = y0; py <= y1; py++) {
    const ny = (py + 0.5) / height;
    for (let px = x0; px <= x1; px++) {
      const nx = (px + 0.5) / width;
      if (polygonContains(points, nx, ny)) out.push(py * width + px);
    }
  }
  return out;
}

// Trace the outer boundary of a binary mask into a simplified polygon (Moore-
// neighbour boundary following from the top-left set pixel, clockwise). Returns
// the outline of the component containing that pixel in normalized coords, RDP-
// simplified; [] if the mask is empty or degenerate. Used to auto-snap a lasso
// to a colour edge after excluding a colour. Holes/other components are ignored
// (the outer boundary is what the polygon represents).
export function traceMaskOutline(
  mask: Uint8Array, width: number, height: number, tolerance = 0.01,
): Pt[] {
  let start = -1;
  for (let i = 0; i < width * height; i++) { if (mask[i] === 1) { start = i; break; } }
  if (start < 0) return [];
  const sx = start % width, sy = (start / width) | 0;
  const isSet = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  // 8 neighbours clockwise starting at E.
  const nb = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const out: { x: number; y: number }[] = [];
  let cx = sx, cy = sy, dir = 0;
  const maxSteps = width * height * 4;
  let steps = 0;
  do {
    out.push({ x: cx, y: cy });
    let moved = false;
    const startK = (dir + 6) % 8; // turn back-left, then sweep clockwise
    for (let k = 0; k < 8; k++) {
      const d = (startK + k) % 8;
      const nx = cx + nb[d][0], ny = cy + nb[d][1];
      if (isSet(nx, ny)) { cx = nx; cy = ny; dir = d; moved = true; break; }
    }
    if (!moved) break; // isolated pixel
    steps++;
  } while (!(cx === sx && cy === sy) && steps < maxSteps);

  if (out.length < 3) return [];
  const norm = out.map(p => ({ x: (p.x + 0.5) / width, y: (p.y + 0.5) / height }));
  return simplifyPolygon(norm, tolerance);
}

// Distance (in PIXELS) from a pixel centre to the nearest polygon edge segment.
// Used to build an inward feather: pixels deep inside have a large distance,
// pixels near the boundary have ~0.
export function polygonEdgeDistancePx(
  points: Pt[], px: number, py: number, width: number, height: number,
): number {
  const n = points.length;
  if (n < 2) return 0;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = points[j].x * width, ay = points[j].y * height;
    const bx = points[i].x * width, by = points[i].y * height;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}
