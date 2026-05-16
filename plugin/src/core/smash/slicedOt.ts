// Phase 8 — Sliced Optimal Transport color matching.
//
// The Phase 3-6 engine matches the OkLCh dimensions independently (per-axis
// CDFs) plus one L-conditional slice (Phase 5). Neither captures a joint
// correlation like "as a increases, b decreases" that doesn't factor through
// L. Sliced OT matches the FULL joint 3D Oklab distribution of target→source.
//
// How it stays LUT-bakable: sliced OT moves a point cloud, but each moved
// sample carries a displacement field[i] = T_final[i] − T0[i] attached to a
// known input Oklab position T0[i] — a scattered colour→colour map. We run it
// once per snap inside buildSmashCdfs, splat the converged field into a small
// 16³ Oklab grid, and let applyTransform do a trilinear lookup-and-add. After
// the bake no point cloud exists at apply time — only the frozen grid — so the
// whole mechanic is a pure f(R,G,B)→(R',G',B') and bakes into the .cube LUT.
//
// See sliced-ot-design.md and ColorSmash_Masterplan_v1.1_addendum.md §8.5.

import type { Vec3 } from './types';

/** Per-axis Oklab grid resolution. 16³ = 4096 cells × 3 floats = 48 KB. */
const SLICED_OT_GRID = 16;
/** Point-cloud subsample size — enough for a 16³ bake, sorts fast. */
const SLICED_OT_SUBSAMPLE_N = 4000;
/** Hard cap on random slices. Early-exit (below) usually stops well before. */
const SLICED_OT_ITERS = 128;
/** Check the convergence residual every this many slices. */
const SLICED_OT_CHECK_EVERY = 16;
/** Early-exit when the rolling mean residual drops below this × cloud variance. */
const SLICED_OT_CONVERGE_FRAC = 1e-4;
/** Per-iteration relaxation factor. 1.0 = textbook full-step sliced OT. */
const SLICED_OT_STEP = 1.0;
/** Fixed PRNG seed — sliced OT MUST be reproducible (stable presets/bakes). */
const SLICED_OT_SEED = 0x5a3c91;

/**
 * A baked sliced-OT colour→colour displacement field over a regular Oklab
 * grid. Each cell stores the Oklab displacement (ΔL, Δa, Δb) that nudges an
 * input colour toward the source's joint distribution. Frozen engine state —
 * fully LUT-bakable.
 */
export interface SlicedOtField {
  /** Per-axis grid resolution (=== SLICED_OT_GRID). */
  readonly size: number;
  /** Oklab bounds the grid spans — padded union bbox of source+target. */
  readonly lMin: number; readonly lMax: number;
  readonly aMin: number; readonly aMax: number;
  readonly bMin: number; readonly bMax: number;
  /** Flat displacement, length size³ × 3, layout L-outer / a / b-inner:
   *  cell (li,ai,bi) → [dL,da,db] at ((li*size+ai)*size+bi)*3. */
  readonly disp: Float32Array;
}

/** Deterministic, seedable PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform random unit vector on S² (Box–Muller Gaussians, normalized). */
function randomDirection(rng: () => number): [number, number, number] {
  for (;;) {
    const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng();
    const r1 = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12)));
    const g0 = r1 * Math.cos(2 * Math.PI * u2);
    const g1 = r1 * Math.sin(2 * Math.PI * u2);
    const r2 = Math.sqrt(-2 * Math.log(Math.max(u3, 1e-12)));
    const g2 = r2 * Math.cos(2 * Math.PI * u4);
    const len = Math.hypot(g0, g1, g2);
    if (len > 1e-9) return [g0 / len, g1 / len, g2 / len];
  }
}

/** Subsample `points` to `n` entries into a flat Float32Array (3n), using a
 *  seeded partial Fisher–Yates shuffle so the pick is deterministic. */
function subsampleFlat(points: readonly Vec3[], n: number, rng: () => number): Float32Array {
  const len = points.length;
  const idx = new Int32Array(len);
  for (let i = 0; i < len; i++) idx[i] = i;
  // Partial shuffle: pick the first n slots.
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (len - i));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = points[idx[i]];
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/**
 * Build a baked sliced-OT displacement field from source / target Oklab point
 * clouds. Subsamples both to an equal N, runs sliced OT, splats the converged
 * displacement into a 16³ Oklab grid, and flood-fills empty cells.
 *
 * Returns null on degenerate (empty) input — apply-time then short-circuits
 * to identity.
 */
export function buildSlicedOtField(
  sourceOklab: readonly Vec3[],
  targetOklab: readonly Vec3[],
  size: number = SLICED_OT_GRID,
): SlicedOtField | null {
  if (sourceOklab.length === 0 || targetOklab.length === 0) return null;
  const N = Math.min(sourceOklab.length, targetOklab.length, SLICED_OT_SUBSAMPLE_N);
  if (N < 2) return null;

  const rng = mulberry32(SLICED_OT_SEED);
  const S = subsampleFlat(sourceOklab, N, rng);
  const T = subsampleFlat(targetOklab, N, rng);
  const T0 = T.slice(); // frozen start positions — needed for the displacement

  // Cloud variance (mean of the 3 axis variances of T0) — the convergence
  // threshold is a small fraction of this.
  let cloudVar = 0;
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += T0[i * 3 + c];
    mean /= N;
    let v = 0;
    for (let i = 0; i < N; i++) { const d = T0[i * 3 + c] - mean; v += d * d; }
    cloudVar += v / N;
  }
  cloudVar /= 3;
  const convergeThreshold = SLICED_OT_CONVERGE_FRAC * Math.max(cloudVar, 1e-9);

  // Sliced OT iterations.
  const tProj = new Float32Array(N);
  const sProj = new Float32Array(N);
  const order: number[] = new Array(N);
  let windowResidual = 0;
  for (let iter = 0; iter < SLICED_OT_ITERS; iter++) {
    const [tx, ty, tz] = randomDirection(rng);
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      tProj[i] = T[o] * tx + T[o + 1] * ty + T[o + 2] * tz;
      sProj[i] = S[o] * tx + S[o + 1] * ty + S[o + 2] * tz;
      order[i] = i;
    }
    sProj.sort();                                  // ascending source ranks
    order.sort((a, b) => tProj[a] - tProj[b]);     // argsort target by projection
    let residual = 0;
    for (let rank = 0; rank < N; rank++) {
      const i = order[rank];
      const d = sProj[rank] - tProj[i];            // 1D OT displacement
      residual += d * d;
      const step = SLICED_OT_STEP * d;
      const o = i * 3;
      T[o] += step * tx;
      T[o + 1] += step * ty;
      T[o + 2] += step * tz;
    }
    windowResidual += residual / N;
    // Early exit: rolling mean residual over the last window dropped below the
    // convergence threshold → the cloud has matched, stop.
    if ((iter + 1) % SLICED_OT_CHECK_EVERY === 0) {
      if (windowResidual / SLICED_OT_CHECK_EVERY < convergeThreshold) break;
      windowResidual = 0;
    }
  }

  // Padded union bbox over source ∪ T0 (the input positions the field keys on).
  let lMin = Infinity, lMax = -Infinity;
  let aMin = Infinity, aMax = -Infinity;
  let bMin = Infinity, bMax = -Infinity;
  const extend = (arr: Float32Array) => {
    for (let i = 0; i < N; i++) {
      const L = arr[i * 3], a = arr[i * 3 + 1], b = arr[i * 3 + 2];
      if (L < lMin) lMin = L; if (L > lMax) lMax = L;
      if (a < aMin) aMin = a; if (a > aMax) aMax = a;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    }
  };
  extend(S);
  extend(T0);
  const padAxis = (lo: number, hi: number): [number, number] => {
    const span = hi - lo;
    const pad = span > 1e-6 ? span * 0.05 : 0.05;
    return [lo - pad, hi + pad];
  };
  [lMin, lMax] = padAxis(lMin, lMax);
  [aMin, aMax] = padAxis(aMin, aMax);
  [bMin, bMax] = padAxis(bMin, bMax);

  // Splat the scattered displacement field into the grid (normalized
  // trilinear scatter — the transpose of a trilinear gather).
  const cells = size * size * size;
  const disp = new Float32Array(cells * 3);
  const weight = new Float32Array(cells);
  const norm = (v: number, lo: number, hi: number) =>
    Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (size - 1);
  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const dL = T[o] - T0[o];
    const da = T[o + 1] - T0[o + 1];
    const db = T[o + 2] - T0[o + 2];
    const fx = norm(T0[o], lMin, lMax);
    const fy = norm(T0[o + 1], aMin, aMax);
    const fz = norm(T0[o + 2], bMin, bMax);
    const x0 = Math.min(size - 2, Math.floor(fx)), x1 = x0 + 1, tx = fx - x0;
    const y0 = Math.min(size - 2, Math.floor(fy)), y1 = y0 + 1, ty = fy - y0;
    const z0 = Math.min(size - 2, Math.floor(fz)), z1 = z0 + 1, tz = fz - z0;
    for (let cx = 0; cx < 2; cx++) {
      const wx = cx === 0 ? 1 - tx : tx;
      const xi = cx === 0 ? x0 : x1;
      for (let cy = 0; cy < 2; cy++) {
        const wy = cy === 0 ? 1 - ty : ty;
        const yi = cy === 0 ? y0 : y1;
        for (let cz = 0; cz < 2; cz++) {
          const wz = cz === 0 ? 1 - tz : tz;
          const zi = cz === 0 ? z0 : z1;
          const w = wx * wy * wz;
          const cell = (xi * size + yi) * size + zi;
          disp[cell * 3] += dL * w;
          disp[cell * 3 + 1] += da * w;
          disp[cell * 3 + 2] += db * w;
          weight[cell] += w;
        }
      }
    }
  }
  const filled = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    if (weight[cell] > 1e-9) {
      const inv = 1 / weight[cell];
      disp[cell * 3] *= inv;
      disp[cell * 3 + 1] *= inv;
      disp[cell * 3 + 2] *= inv;
      filled[cell] = 1;
    }
  }

  // Flood-fill empty cells: repeatedly set each to the mean of its filled
  // 6-neighbours (a cheap Laplacian inpaint). A handful of passes on a 16³
  // grid; cells still empty after → identity (zero displacement), which is
  // safe because no real colour lands there except via interpolation.
  const idxOf = (x: number, y: number, z: number) => (x * size + y) * size + z;
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          const cell = idxOf(x, y, z);
          if (filled[cell]) continue;
          let sL = 0, sA = 0, sB = 0, n = 0;
          const acc = (xi: number, yi: number, zi: number) => {
            if (xi < 0 || yi < 0 || zi < 0 || xi >= size || yi >= size || zi >= size) return;
            const nc = idxOf(xi, yi, zi);
            if (!filled[nc]) return;
            sL += disp[nc * 3]; sA += disp[nc * 3 + 1]; sB += disp[nc * 3 + 2]; n++;
          };
          acc(x - 1, y, z); acc(x + 1, y, z);
          acc(x, y - 1, z); acc(x, y + 1, z);
          acc(x, y, z - 1); acc(x, y, z + 1);
          if (n > 0) {
            disp[cell * 3] = sL / n;
            disp[cell * 3 + 1] = sA / n;
            disp[cell * 3 + 2] = sB / n;
            filled[cell] = 1; // becomes a source for later cells in this pass
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  return { size, lMin, lMax, aMin, aMax, bMin, bMax, disp };
}

/**
 * Trilinear lookup of the sliced-OT displacement at an Oklab point. Returns
 * [dL, da, db]; out-of-bounds inputs clamp to the grid edge.
 */
export function lookupSlicedOt(
  field: SlicedOtField,
  L: number,
  a: number,
  b: number,
): Vec3 {
  const { size, lMin, lMax, aMin, aMax, bMin, bMax, disp } = field;
  const norm = (v: number, lo: number, hi: number) =>
    Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (size - 1);
  const fx = norm(L, lMin, lMax);
  const fy = norm(a, aMin, aMax);
  const fz = norm(b, bMin, bMax);
  const x0 = Math.min(size - 2, Math.floor(fx)), x1 = x0 + 1, tx = fx - x0;
  const y0 = Math.min(size - 2, Math.floor(fy)), y1 = y0 + 1, ty = fy - y0;
  const z0 = Math.min(size - 2, Math.floor(fz)), z1 = z0 + 1, tz = fz - z0;
  const at = (xi: number, yi: number, zi: number, c: number) =>
    disp[((xi * size + yi) * size + zi) * 3 + c];
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  const blend = (c: number) =>
    lerp(
      lerp(lerp(at(x0, y0, z0, c), at(x1, y0, z0, c), tx),
           lerp(at(x0, y1, z0, c), at(x1, y1, z0, c), tx), ty),
      lerp(lerp(at(x0, y0, z1, c), at(x1, y0, z1, c), tx),
           lerp(at(x0, y1, z1, c), at(x1, y1, z1, c), tx), ty),
      tz);
  return [blend(0), blend(1), blend(2)];
}
