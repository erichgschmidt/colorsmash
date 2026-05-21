import { describe, it, expect } from "vitest";
import {
  Pt,
  simplifyPolygon,
  polygonCentroid,
  polygonContains,
  polygonBBox,
  polygonPixelIndices,
  polygonEdgeDistancePx,
  traceMaskOutline,
} from "./regions";

// ────────── fixtures & helpers ──────────

// Axis-aligned square spanning [0.2, 0.8] in both axes (CCW-ish order).
const SQUARE: Pt[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

// A simple triangle.
const TRIANGLE: Pt[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.5, y: 0.8 },
];

// Linear interpolation between two points.
function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Deterministic pseudo-random in [-1, 1] from an integer seed.
function jitter(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

// Walk the 4 sides of `corners` with `perSide` samples each, adding tiny jitter
// (< amp) so RDP has wiggle to collapse. Returns a dense closed-ish path.
function sampledSquarePath(corners: Pt[], perSide: number, amp: number): Pt[] {
  const path: Pt[] = [];
  let k = 0;
  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide; // [0,1) — excludes the next corner (added as next side's start)
      const p = lerp(a, b, t);
      path.push({ x: p.x + jitter(k++) * amp, y: p.y + jitter(k++) * amp });
    }
  }
  return path;
}

// ────────── polygonContains ──────────

describe("polygonContains", () => {
  it("classifies the square's centre as inside", () => {
    expect(polygonContains(SQUARE, 0.5, 0.5)).toBe(true);
  });

  it("classifies points outside each side as outside", () => {
    expect(polygonContains(SQUARE, 0.1, 0.5)).toBe(false); // left
    expect(polygonContains(SQUARE, 0.9, 0.5)).toBe(false); // right
    expect(polygonContains(SQUARE, 0.5, 0.95)).toBe(false); // below
    expect(polygonContains(SQUARE, 0.5, 0.05)).toBe(false); // above
  });

  it("works for a triangle", () => {
    expect(polygonContains(TRIANGLE, 0.5, 0.3)).toBe(true); // near the wide top, inside
    expect(polygonContains(TRIANGLE, 0.5, 0.1)).toBe(false); // above the top edge
    expect(polygonContains(TRIANGLE, 0.2, 0.7)).toBe(false); // bottom-left, outside the apex
    expect(polygonContains(TRIANGLE, 0.9, 0.5)).toBe(false); // far right
  });
});

// ────────── polygonCentroid ──────────

describe("polygonCentroid", () => {
  it("returns the centre of the square", () => {
    const c = polygonCentroid(SQUARE);
    expect(c.x).toBeCloseTo(0.5, 10);
    expect(c.y).toBeCloseTo(0.5, 10);
  });

  it("returns the vertex average of a triangle", () => {
    const c = polygonCentroid(TRIANGLE);
    expect(c.x).toBeCloseTo((0.2 + 0.8 + 0.5) / 3, 10);
    expect(c.y).toBeCloseTo((0.2 + 0.2 + 0.8) / 3, 10);
  });

  it("returns origin for an empty polygon", () => {
    expect(polygonCentroid([])).toEqual({ x: 0, y: 0 });
  });
});

// ────────── polygonBBox ──────────

describe("polygonBBox", () => {
  it("returns a tight bbox for the square", () => {
    const bb = polygonBBox(SQUARE);
    expect(bb.x0).toBeCloseTo(0.2, 10);
    expect(bb.y0).toBeCloseTo(0.2, 10);
    expect(bb.x1).toBeCloseTo(0.8, 10);
    expect(bb.y1).toBeCloseTo(0.8, 10);
  });

  it("clamps out-of-range vertices to 0..1", () => {
    const poly: Pt[] = [
      { x: -0.1, y: -0.2 },
      { x: 1.3, y: 0.5 },
      { x: 0.5, y: 1.4 },
    ];
    const bb = polygonBBox(poly);
    expect(bb.x0).toBe(0);
    expect(bb.y0).toBe(0);
    expect(bb.x1).toBe(1);
    expect(bb.y1).toBe(1);
  });
});

// ────────── polygonPixelIndices ──────────

describe("polygonPixelIndices", () => {
  const W = 100;
  const H = 100;

  it("rasterizes ~area pixels for the square on a 100x100 grid", () => {
    const idx = polygonPixelIndices(SQUARE, W, H);
    // Expected area: 0.6 * 0.6 * 10000 = 3600 px.
    expect(idx.length).toBeGreaterThan(3600 - 400);
    expect(idx.length).toBeLessThan(3600 + 400);
  });

  it("returns indices in range and whose pixel centre is actually inside", () => {
    const idx = polygonPixelIndices(SQUARE, W, H);
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(W * H);
    }
    // Spot-check a handful map back to centres inside the polygon.
    const samples = [idx[0], idx[Math.floor(idx.length / 2)], idx[idx.length - 1]];
    for (const i of samples) {
      const py = Math.floor(i / W);
      const px = i % W;
      const nx = (px + 0.5) / W;
      const ny = (py + 0.5) / H;
      expect(polygonContains(SQUARE, nx, ny)).toBe(true);
    }
  });

  it("excludes pixels whose centre is outside (no false positives near the bbox edge)", () => {
    const idx = new Set(polygonPixelIndices(SQUARE, W, H));
    // Pixel (10,50): centre (0.105, 0.505) is left of the square → must be absent.
    expect(idx.has(50 * W + 10)).toBe(false);
    // Pixel (50,50): centre (0.505, 0.505) is inside → must be present.
    expect(idx.has(50 * W + 50)).toBe(true);
  });

  it("returns [] for degenerate (<3 point) input", () => {
    expect(polygonPixelIndices([], W, H)).toEqual([]);
    expect(polygonPixelIndices([{ x: 0.5, y: 0.5 }], W, H)).toEqual([]);
    expect(polygonPixelIndices([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }], W, H)).toEqual([]);
  });
});

// ────────── polygonEdgeDistancePx ──────────

describe("polygonEdgeDistancePx", () => {
  const W = 100;
  const H = 100;

  it("measures ~30px from the square centre to the nearest edge", () => {
    // Square spans x,y ∈ [20, 80] in px; centre (50,50) is 30px from every edge.
    const d = polygonEdgeDistancePx(SQUARE, 50, 50, W, H);
    expect(d).toBeCloseTo(30, 0);
  });

  it("measures ~0px on an edge", () => {
    // (20,50) sits on the left edge.
    const d = polygonEdgeDistancePx(SQUARE, 20, 50, W, H);
    expect(d).toBeLessThan(0.5);
  });

  it("is larger at the centre than near an edge", () => {
    const dCentre = polygonEdgeDistancePx(SQUARE, 50, 50, W, H);
    const dNear = polygonEdgeDistancePx(SQUARE, 25, 50, W, H); // 5px from left edge
    expect(dCentre).toBeGreaterThan(dNear);
    expect(dNear).toBeCloseTo(5, 0);
  });

  it("returns 0 for under-2-point input", () => {
    expect(polygonEdgeDistancePx([], 50, 50, W, H)).toBe(0);
    expect(polygonEdgeDistancePx([{ x: 0.5, y: 0.5 }], 50, 50, W, H)).toBe(0);
  });
});

// ────────── simplifyPolygon ──────────

describe("simplifyPolygon", () => {
  it("collapses a 40-point jittered square outline to a handful of vertices", () => {
    const path = sampledSquarePath(SQUARE, 10, 0.004); // 40 pts, jitter < tolerance
    expect(path.length).toBe(40);

    const simplified = simplifyPolygon(path, 0.02);
    // Should reduce substantially — down to roughly the 4 corners (allow 4..6).
    expect(simplified.length).toBeLessThan(10);
    expect(simplified.length).toBeGreaterThanOrEqual(3);

    // The simplified polygon still contains the original centre.
    const c = polygonCentroid(SQUARE);
    expect(polygonContains(simplified, c.x, c.y)).toBe(true);
    expect(polygonContains(simplified, 0.5, 0.5)).toBe(true);
  });

  it("returns 3-point input as-is", () => {
    const out = simplifyPolygon(TRIANGLE, 0.02);
    expect(out).toEqual(TRIANGLE);
    expect(out).not.toBe(TRIANGLE); // a copy, not the same reference
  });

  it("drops a duplicate closing vertex", () => {
    // Explicitly-closed square (first === last) with extra midpoints to survive RDP entry.
    const closed: Pt[] = [
      { x: 0.2, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
      { x: 0.2, y: 0.2 }, // duplicate of first
    ];
    const out = simplifyPolygon(closed, 0.02);
    const first = out[0];
    const last = out[out.length - 1];
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    expect(dx * dx + dy * dy).toBeGreaterThan(1e-8); // closing dup removed
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe("traceMaskOutline", () => {
  it("traces a filled square mask into a polygon that contains its centre", () => {
    const W = 40, H = 40;
    const mask = new Uint8Array(W * H);
    for (let y = 8; y < 32; y++) for (let x = 8; x < 32; x++) mask[y * W + x] = 1;
    const poly = traceMaskOutline(mask, W, H, 0.01);
    expect(poly.length).toBeGreaterThanOrEqual(3);
    // The outline encloses the square's centre…
    expect(polygonContains(poly, 0.5, 0.5)).toBe(true);
    // …and excludes a point well outside the square.
    expect(polygonContains(poly, 0.05, 0.05)).toBe(false);
    // Its bbox roughly matches the filled region (x,y ∈ [8/40, 32/40]).
    const bb = polygonBBox(poly);
    expect(bb.x0).toBeLessThan(0.3);
    expect(bb.x1).toBeGreaterThan(0.7);
  });

  it("returns [] for an empty mask", () => {
    expect(traceMaskOutline(new Uint8Array(16), 4, 4)).toEqual([]);
  });

  it("follows an L-shape (concave) — its outline excludes the missing corner", () => {
    const W = 40, H = 40;
    const mask = new Uint8Array(W * H);
    // Full square [8,32) minus the bottom-right quadrant [20,32)×[20,32).
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 32; x++) {
        if (x >= 20 && y >= 20) continue;
        mask[y * W + x] = 1;
      }
    }
    const poly = traceMaskOutline(mask, W, H, 0.01);
    expect(poly.length).toBeGreaterThanOrEqual(3);
    // A point in the kept arm is inside; the removed corner is outside.
    expect(polygonContains(poly, 12 / W, 12 / H)).toBe(true);
    expect(polygonContains(poly, 27 / W, 27 / H)).toBe(false);
  });
});
