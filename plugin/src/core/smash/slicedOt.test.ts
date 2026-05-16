// Tests for slicedOt.ts (Phase 8) — sliced optimal transport color matching.

import { describe, it, expect } from 'vitest';
import { buildSlicedOtField, lookupSlicedOt } from './slicedOt';
import type { Vec3 } from './types';

/** A blob of `n` Oklab points around `center` with a small uniform spread. */
function blob(center: Vec3, spread: number, n: number, seed: number): Vec3[] {
  // Tiny deterministic LCG so the test fixtures are reproducible.
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    out.push([
      center[0] + (rnd() - 0.5) * spread,
      center[1] + (rnd() - 0.5) * spread,
      center[2] + (rnd() - 0.5) * spread,
    ]);
  }
  return out;
}

describe('buildSlicedOtField — degenerate inputs', () => {
  it('empty source or target → null', () => {
    const pts = blob([0.5, 0, 0], 0.1, 100, 1);
    expect(buildSlicedOtField([], pts)).toBeNull();
    expect(buildSlicedOtField(pts, [])).toBeNull();
    expect(buildSlicedOtField([], [])).toBeNull();
  });

  it('a normal pair builds a finite 16³ field', () => {
    const src = blob([0.7, -0.1, 0.05], 0.15, 600, 11);
    const tgt = blob([0.3, 0.1, 0.0], 0.15, 600, 22);
    const field = buildSlicedOtField(src, tgt);
    expect(field).not.toBeNull();
    expect(field!.size).toBe(16);
    expect(field!.disp.length).toBe(16 * 16 * 16 * 3);
    for (let i = 0; i < field!.disp.length; i++) {
      expect(Number.isFinite(field!.disp[i])).toBe(true);
    }
  });
});

describe('buildSlicedOtField — determinism', () => {
  it('same input → byte-identical field (seeded PRNG)', () => {
    const src = blob([0.6, 0.05, -0.05], 0.2, 500, 7);
    const tgt = blob([0.4, -0.05, 0.08], 0.2, 500, 9);
    const a = buildSlicedOtField(src, tgt)!;
    const b = buildSlicedOtField(src, tgt)!;
    expect(a.disp.length).toBe(b.disp.length);
    for (let i = 0; i < a.disp.length; i++) {
      expect(a.disp[i]).toBe(b.disp[i]);
    }
    expect(a.lMin).toBe(b.lMin);
    expect(a.lMax).toBe(b.lMax);
  });
});

describe('buildSlicedOtField — transport behaviour', () => {
  it('source ≈ target → near-zero displacement field', () => {
    const cloud = blob([0.5, 0.0, 0.0], 0.2, 800, 33);
    // Same distribution on both sides → nothing to transport.
    const field = buildSlicedOtField(cloud, cloud)!;
    let maxAbs = 0;
    for (let i = 0; i < field.disp.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(field.disp[i]));
    }
    expect(maxAbs).toBeLessThan(0.05);
  });

  it('displacement at the target centroid points toward the source centroid', () => {
    const srcCenter: Vec3 = [0.75, -0.12, 0.06];
    const tgtCenter: Vec3 = [0.30, 0.10, -0.04];
    const src = blob(srcCenter, 0.12, 700, 5);
    const tgt = blob(tgtCenter, 0.12, 700, 6);
    const field = buildSlicedOtField(src, tgt)!;
    const [dL, da, db] = lookupSlicedOt(field, tgtCenter[0], tgtCenter[1], tgtCenter[2]);
    // The transport should move the target blob toward the source blob.
    expect(dL).toBeGreaterThan(0.2);   // toward L 0.75
    expect(da).toBeLessThan(-0.08);    // toward a -0.12
    expect(db).toBeGreaterThan(0.04);  // toward b 0.06
  });
});

describe('lookupSlicedOt', () => {
  it('returns finite values and clamps out-of-bounds inputs', () => {
    const src = blob([0.6, 0.0, 0.0], 0.15, 500, 41);
    const tgt = blob([0.4, 0.05, 0.05], 0.15, 500, 42);
    const field = buildSlicedOtField(src, tgt)!;
    // Well inside the grid, and far outside on every axis.
    const probes: Vec3[] = [
      [0.5, 0.0, 0.0], [-5, -5, -5], [5, 5, 5], [0.5, 10, -10],
    ];
    for (const [L, a, b] of probes) {
      const out = lookupSlicedOt(field, L, a, b);
      expect(out.length).toBe(3);
      for (const c of out) expect(Number.isFinite(c)).toBe(true);
    }
  });
});
