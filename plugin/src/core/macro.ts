// Macro groups — the semantic foundation layer above pools.
//
// A flat segmentation gives N sibling pools with no notion that "these five
// pools are all skin". Macro groups collect pools (regardless of colour) into a
// handful of foundation groups (skin / shirt / hair / BG). Correspondence then
// runs MACRO-FIRST: source macros are matched to target macros by role, and the
// per-pool donor search for each target pool is CONSTRAINED to the source pools
// inside its macro's matched source macro. So skin pools can only draw skin
// donors — the foundation stays correct — while sub-palettes still transfer for
// detail (the "finishing pass").
//
// This module is pure TS (no UXP / React). Macros are seeded by clustering pool
// descriptors and are editable downstream; nothing here persists state.

import type { Pool, PoolDescriptor, ValueBand } from "./clusters";
import { labToRgb } from "./clusters";
import { matchPools } from "./match";
import type { Correspondence, PoolMatch } from "./match";

export interface MacroGroup {
  id: number;          // stable within one side's macro set (0..n-1 by weight)
  name: string;        // editable label, e.g. "Macro 1"
  poolIds: number[];   // member top-level pool ids
}

// Aggregate (weight-weighted) display info for a macro — for the UI swatch/list.
export interface MacroInfo {
  r: number; g: number; b: number;
  weight: number;       // sum of member pool weights (fraction of the image)
  poolCount: number;
}

// Value-band cuts — mirror clusters.ts (those constants are module-private there).
const SHADOW_MAX_L = 33;
const HIGHLIGHT_MIN_L = 66;
const bandOf = (L: number): ValueBand =>
  L < SHADOW_MAX_L ? "shadow" : L > HIGHLIGHT_MIN_L ? "highlight" : "mid";

function mapById(pools: Pool[]): Map<number, Pool> {
  const m = new Map<number, Pool>();
  for (const p of pools) m.set(p.id, p);
  return m;
}

// ────────── seeding ──────────

// Cluster a side's pools into ~k macro groups by mean-Lab proximity, weighted by
// pool weight. Deterministic (heaviest-pool seed + farthest-point seeding, no
// Math.random), so re-seeding the same pools is stable. Returns macros sorted by
// aggregate weight desc with ids 0..m-1 and generic names.
export function seedMacroGroups(pools: Pool[], k: number): MacroGroup[] {
  const n = pools.length;
  if (n === 0) return [];
  const kk = Math.max(1, Math.min(Math.floor(k), n));

  const feat: [number, number, number][] = pools.map(p =>
    [p.descriptor.labL, p.descriptor.labA, p.descriptor.labB],
  );
  const wts = pools.map(p => Math.max(1e-6, p.descriptor.weight));

  const dist2 = (a: [number, number, number], b: [number, number, number]) => {
    const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return dl * dl + da * da + db * db;
  };

  // ── deterministic seeding ──
  // First centroid = heaviest pool. Each subsequent = the pool whose (distance
  // to its nearest chosen centroid) × weight is largest — a weighted farthest-
  // point heuristic that spreads seeds across the heaviest, most distinct pools.
  const centroids: [number, number, number][] = [];
  let heaviest = 0;
  for (let i = 1; i < n; i++) if (wts[i] > wts[heaviest]) heaviest = i;
  centroids.push([...feat[heaviest]]);
  const nearest = feat.map(f => dist2(f, centroids[0]));
  while (centroids.length < kk) {
    let bestI = -1, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const score = nearest[i] * wts[i];
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    if (bestI < 0) break;
    centroids.push([...feat[bestI]]);
    const c = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = dist2(feat[i], c);
      if (d < nearest[i]) nearest[i] = d;
    }
  }

  // ── Lloyd iterations ──
  const assign = new Int32Array(n).fill(0);
  const m = centroids.length;
  for (let iter = 0; iter < 16; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < m; c++) {
        const d = dist2(feat[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    // recompute centroids (weighted)
    const sum = Array.from({ length: m }, () => [0, 0, 0]);
    const wsum = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const c = assign[i], w = wts[i];
      sum[c][0] += feat[i][0] * w; sum[c][1] += feat[i][1] * w; sum[c][2] += feat[i][2] * w;
      wsum[c] += w;
    }
    for (let c = 0; c < m; c++) {
      if (wsum[c] > 0) {
        centroids[c][0] = sum[c][0] / wsum[c];
        centroids[c][1] = sum[c][1] / wsum[c];
        centroids[c][2] = sum[c][2] / wsum[c];
      }
    }
    if (!moved && iter > 0) break;
  }

  // Group pool ids by cluster; drop empties.
  const buckets: number[][] = Array.from({ length: m }, () => []);
  for (let i = 0; i < n; i++) buckets[assign[i]].push(pools[i].id);
  const poolsById = mapById(pools);
  const groups = buckets
    .filter(b => b.length > 0)
    .map(poolIds => {
      let weight = 0;
      for (const id of poolIds) weight += poolsById.get(id)?.descriptor.weight ?? 0;
      return { poolIds, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  return groups.map((g, i) => ({ id: i, name: `Macro ${i + 1}`, poolIds: g.poolIds }));
}

// ────────── aggregate descriptors ──────────

// Weight-weighted aggregate PoolDescriptor for a macro's member pools. Used both
// for the UI swatch and to synthesize a pseudo-pool for macro↔macro matching.
export function macroDescriptor(poolIds: number[], poolsById: Map<number, Pool>): PoolDescriptor {
  let wsum = 0, L = 0, a = 0, b = 0, px = 0, cx = 0, cy = 0, comp = 0;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const id of poolIds) {
    const p = poolsById.get(id);
    if (!p) continue;
    const d = p.descriptor;
    const w = Math.max(0, d.weight);
    wsum += w;
    L += d.labL * w; a += d.labA * w; b += d.labB * w;
    cx += d.centroidX * w; cy += d.centroidY * w; comp += d.compactness * w;
    px += d.pixelCount;
    if (d.bboxX0 < x0) x0 = d.bboxX0;
    if (d.bboxY0 < y0) y0 = d.bboxY0;
    if (d.bboxX1 > x1) x1 = d.bboxX1;
    if (d.bboxY1 > y1) y1 = d.bboxY1;
  }
  const inv = wsum > 0 ? 1 / wsum : 0;
  const mL = L * inv, mA = a * inv, mB = b * inv;
  const [r, g, bl] = labToRgb(mL, mA, mB);
  if (x1 < x0) { x0 = 0; x1 = 0; }
  if (y1 < y0) { y0 = 0; y1 = 0; }
  return {
    r, g, b: bl,
    labL: mL, labA: mA, labB: mB,
    chroma: Math.sqrt(mA * mA + mB * mB),
    valueBand: bandOf(mL),
    pixelCount: px,
    weight: wsum,
    compactness: inv > 0 ? comp * inv : 0,
    centroidX: cx * inv, centroidY: cy * inv,
    bboxX0: x0, bboxY0: y0, bboxX1: x1, bboxY1: y1,
  };
}

// Per-macro UI info keyed by macro id.
export function macroInfoMap(macros: MacroGroup[], pools: Pool[]): Map<number, MacroInfo> {
  const byId = mapById(pools);
  const out = new Map<number, MacroInfo>();
  for (const macro of macros) {
    const d = macroDescriptor(macro.poolIds, byId);
    out.set(macro.id, { r: d.r, g: d.g, b: d.b, weight: d.weight, poolCount: macro.poolIds.length });
  }
  return out;
}

// Synthesize a pseudo-Pool from a macro so the proven matchPools scorer can be
// reused for macro↔macro matching. subPalette/noise/subPools are unused by the
// scorer, so they're left empty.
function macroToPool(macro: MacroGroup, poolsById: Map<number, Pool>): Pool {
  return {
    id: macro.id,
    descriptor: macroDescriptor(macro.poolIds, poolsById),
    subPalette: [],
    noise: null,
    subPools: null,
  };
}

// ────────── matching ──────────

// Match source macros → target macros by role (reusing matchPools on pseudo-
// pools built from macro aggregates). Returns Map<targetMacroId, sourceMacroId>.
export function matchMacros(
  sourceMacros: MacroGroup[], sourcePools: Pool[],
  targetMacros: MacroGroup[], targetPools: Pool[],
): Map<number, number> {
  const out = new Map<number, number>();
  if (sourceMacros.length === 0 || targetMacros.length === 0) return out;
  const srcById = mapById(sourcePools);
  const tgtById = mapById(targetPools);
  const srcPseudo = sourceMacros.map(m => macroToPool(m, srcById));
  const tgtPseudo = targetMacros.map(m => macroToPool(m, tgtById));
  const corr = matchPools(srcPseudo, tgtPseudo);
  for (const mm of corr.matches) out.set(mm.targetPoolId, mm.sourcePoolId);
  return out;
}

// Build a per-pool correspondence CONSTRAINED by the macro matching: each target
// pool is matched only against the source pools inside its macro's matched
// source macro. Target macros with no matched source macro (or an empty one)
// fall back to the full source pool set. Returns a standard Correspondence so
// the transfer step is unchanged.
export function buildMacroConstrainedCorrespondence(
  sourceMacros: MacroGroup[], sourcePools: Pool[],
  targetMacros: MacroGroup[], targetPools: Pool[],
  macroMatch: Map<number, number>,
): Correspondence {
  const srcById = mapById(sourcePools);
  const tgtById = mapById(targetPools);
  const srcMacroById = new Map(sourceMacros.map(m => [m.id, m]));

  const matches: PoolMatch[] = [];
  const usedSource = new Set<number>();

  for (const tm of targetMacros) {
    const targetMembers = tm.poolIds
      .map(id => tgtById.get(id))
      .filter((p): p is Pool => !!p);
    if (targetMembers.length === 0) continue;

    const srcMacroId = macroMatch.get(tm.id);
    let sourceMembers: Pool[] = [];
    if (srcMacroId != null && srcMacroById.has(srcMacroId)) {
      sourceMembers = srcMacroById.get(srcMacroId)!.poolIds
        .map(id => srcById.get(id))
        .filter((p): p is Pool => !!p);
    }
    if (sourceMembers.length === 0) sourceMembers = sourcePools; // fallback

    const corr = matchPools(sourceMembers, targetMembers);
    for (const mm of corr.matches) { matches.push(mm); usedSource.add(mm.sourcePoolId); }
  }

  // Any target pools not covered by a macro (shouldn't happen — seeding covers
  // all) get a global match so the correspondence stays total.
  const coveredTargets = new Set(matches.map(m => m.targetPoolId));
  const orphanTargets = targetPools.filter(p => !coveredTargets.has(p.id));
  if (orphanTargets.length > 0) {
    const corr = matchPools(sourcePools, orphanTargets);
    for (const mm of corr.matches) { matches.push(mm); usedSource.add(mm.sourcePoolId); }
  }

  const unmatchedSourceIds = sourcePools.filter(p => !usedSource.has(p.id)).map(p => p.id);
  return { matches, unmatchedSourceIds };
}
