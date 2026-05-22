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

// ────────── persistence (reconcile across re-segmentation) ──────────

// Carry the user's macro groups across a re-segmentation instead of re-seeding
// from scratch. Keeps each macro's id / name / membership, drops pool ids that
// no longer exist, and folds any NEW pools (present but in no macro) into their
// nearest macro by aggregate colour. Falls back to a fresh seed when there's no
// usable prior (first run, or every prior pool vanished). Pairs with warm-
// started segmentation, which keeps pool ids stable enough for this to be
// meaningful. macroMatch is reconciled separately (reconcileMacroMatch).
export function reconcileMacros(prev: MacroGroup[], pools: Pool[], k: number): MacroGroup[] {
  if (prev.length === 0) return seedMacroGroups(pools, k);
  const present = new Set(pools.map(p => p.id));
  const byId = mapById(pools);

  let macros = prev.map(m => ({ ...m, poolIds: m.poolIds.filter(id => present.has(id)) }));
  const nonEmpty = macros.filter(m => m.poolIds.length > 0);
  if (nonEmpty.length === 0) return seedMacroGroups(pools, k);

  const assigned = new Set<number>();
  for (const m of macros) for (const id of m.poolIds) assigned.add(id);
  const orphans = pools.filter(p => !assigned.has(p.id));

  if (orphans.length > 0) {
    // Stable aggregates (computed once, before adding orphans) for nearest-macro.
    const aggs = nonEmpty.map(m => ({ id: m.id, d: macroDescriptor(m.poolIds, byId) }));
    const indexById = new Map(macros.map((m, i) => [m.id, i]));
    for (const orphan of orphans) {
      let bestId = aggs[0].id, bestD = Infinity;
      for (const a of aggs) {
        const dist = labDistance(orphan.descriptor, a.d.labL, a.d.labA, a.d.labB);
        if (dist < bestD) { bestD = dist; bestId = a.id; }
      }
      const mi = indexById.get(bestId)!;
      macros[mi] = { ...macros[mi], poolIds: [...macros[mi].poolIds, orphan.id] };
    }
  }

  return macros.filter(m => m.poolIds.length > 0);
}

// Carry the macro→macro donor mapping across a re-segmentation: keep each target
// macro's chosen donor when both that target macro and its donor source macro
// still exist; auto-match (matchMacros) any target macro left without a valid
// donor. So manual donor picks persist while new/changed groups get sensible
// defaults.
export function reconcileMacroMatch(
  prev: Map<number, number>,
  sourceMacros: MacroGroup[], sourcePools: Pool[],
  targetMacros: MacroGroup[], targetPools: Pool[],
): Map<number, number> {
  const validSrc = new Set(sourceMacros.map(m => m.id));
  const out = new Map<number, number>();
  const unmatched: MacroGroup[] = [];
  for (const tm of targetMacros) {
    const d = prev.get(tm.id);
    if (d != null && validSrc.has(d)) out.set(tm.id, d);
    else unmatched.push(tm);
  }
  if (unmatched.length > 0) {
    const auto = matchMacros(sourceMacros, sourcePools, unmatched, targetPools);
    for (const [t, s] of auto) out.set(t, s);
  }
  return out;
}

// Force tagged regions' pools into their assigned macro — AUTHORITATIVE: a
// region the user explicitly assigned ("this is skin") outranks colour-based
// placement, so an intersecting element isn't collapsed into the wrong group.
// Each tag = the pool ids a split produced + the macro it's assigned to. Tags
// for non-existent macros are ignored; last tag wins per pool. Applied after
// seed/reconcile.
export function applyRegionTags(
  macros: MacroGroup[],
  tags: { poolIds: number[]; macroId: number }[],
): MacroGroup[] {
  const validMacro = new Set(macros.map(m => m.id));
  const force = new Map<number, number>(); // poolId -> macroId
  for (const t of tags) {
    if (!validMacro.has(t.macroId)) continue;
    for (const pid of t.poolIds) force.set(pid, t.macroId);
  }
  if (force.size === 0) return macros;
  return macros.map(m => {
    const ids = m.poolIds.filter(id => !force.has(id) || force.get(id) === m.id);
    for (const [pid, mid] of force) {
      if (mid === m.id && !ids.includes(pid)) ids.push(pid);
    }
    return { ...m, poolIds: ids };
  });
}

// Preserve LOCKED macros' PIXEL TERRITORY across a re-segmentation. Each locked
// macro owned a set of pixels last time (prevLabels ∈ its prev poolIds). After
// re-seg the pools change (split/merge/renumber — especially on a pool-count
// change), so we re-assign by territory: a NEW pool joins a locked macro when the
// MAJORITY of that pool's pixels fall in that macro's old territory. Pools not
// majority-owned by any locked macro are left for normal reconcile (they "smash
// around" freely). Returns authoritative tags for applyRegionTags; [] when there
// is nothing locked or the label maps don't line up (e.g. the image changed).
export function lockTerritoryTags(
  prevLabels: ArrayLike<number>,
  prevMacros: { id: number; poolIds: number[] }[],
  lockedIds: Set<number>,
  newLabels: ArrayLike<number>,
): { poolIds: number[]; macroId: number }[] {
  if (lockedIds.size === 0 || prevLabels.length !== newLabels.length) return [];
  // prev pool id → locked macro id (only for locked macros).
  const prevPoolToLocked = new Map<number, number>();
  for (const m of prevMacros) {
    if (!lockedIds.has(m.id)) continue;
    for (const pid of m.poolIds) prevPoolToLocked.set(pid, m.id);
  }
  if (prevPoolToLocked.size === 0) return [];

  const total = new Map<number, number>();              // new pool → total pixels
  const claim = new Map<number, Map<number, number>>(); // new pool → (locked macro → overlap)
  for (let i = 0; i < newLabels.length; i++) {
    const np = newLabels[i];
    if (np < 0) continue;
    total.set(np, (total.get(np) ?? 0) + 1);
    const lm = prevPoolToLocked.get(prevLabels[i]);
    if (lm == null) continue;
    let c = claim.get(np);
    if (!c) { c = new Map(); claim.set(np, c); }
    c.set(lm, (c.get(lm) ?? 0) + 1);
  }

  const byMacro = new Map<number, number[]>();
  for (const [np, c] of claim) {
    let bestMacro = -1, bestCount = 0;
    for (const [lm, cnt] of c) if (cnt > bestCount) { bestCount = cnt; bestMacro = lm; }
    if (bestMacro >= 0 && bestCount > (total.get(np) ?? 0) * 0.5) {
      const arr = byMacro.get(bestMacro) ?? [];
      arr.push(np);
      byMacro.set(bestMacro, arr);
    }
  }
  const tags: { poolIds: number[]; macroId: number }[] = [];
  for (const [macroId, poolIds] of byMacro) tags.push({ poolIds, macroId });
  return tags;
}

// ────────── membership suggestions (contamination / missing) ──────────

export interface MacroSuggestion {
  // Member pool ids that sit far from the macro's aggregate colour — likely
  // contamination (something that wandered into the wrong group). Worst first.
  contaminating: number[];
  // Pools currently in OTHER macros that sit close to this macro's aggregate —
  // likely missing members. Nearest first.
  candidates: { poolId: number; fromMacroId: number }[];
}

// A member farther than this (Lab units) from its macro's aggregate is flagged
// as possible contamination; a non-member nearer than CANDIDATE_LAB is offered
// as a possible missing member.
const CONTAM_LAB = 32;
const CANDIDATE_LAB = 22;

function labDistance(d: PoolDescriptor, L: number, a: number, b: number): number {
  const dl = d.labL - L, da = d.labA - a, db = d.labB - b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

// For one macro: which members look contaminating, and which pools from other
// macros look like they belong here. Pure ranking by Lab proximity to the
// macro's weighted aggregate — drives the +add / −remove suggestions in the UI.
export function macroSuggestions(
  macroId: number,
  macros: MacroGroup[],
  pools: Pool[],
): MacroSuggestion {
  const byId = mapById(pools);
  const macro = macros.find(m => m.id === macroId);
  if (!macro) return { contaminating: [], candidates: [] };
  const agg = macroDescriptor(macro.poolIds, byId);
  const memberSet = new Set(macro.poolIds);

  const contaminating = macro.poolIds
    .map(id => ({ id, dist: byId.has(id) ? labDistance(byId.get(id)!.descriptor, agg.labL, agg.labA, agg.labB) : 0 }))
    .filter(x => x.dist > CONTAM_LAB)
    .sort((p, q) => q.dist - p.dist)
    .map(x => x.id);

  const poolToMacro = new Map<number, number>();
  for (const m of macros) for (const pid of m.poolIds) poolToMacro.set(pid, m.id);

  const candidates = pools
    .filter(p => !memberSet.has(p.id))
    .map(p => ({ poolId: p.id, fromMacroId: poolToMacro.get(p.id) ?? -1, dist: labDistance(p.descriptor, agg.labL, agg.labA, agg.labB) }))
    .filter(x => x.dist < CANDIDATE_LAB)
    .sort((p, q) => p.dist - q.dist)
    .map(x => ({ poolId: x.poolId, fromMacroId: x.fromMacroId }));

  return { contaminating, candidates };
}

// The macro (excluding `excludeMacroId`) whose aggregate is nearest to a pool —
// where a "−remove"d pool should be rehomed.
export function nearestMacroFor(
  poolId: number,
  macros: MacroGroup[],
  pools: Pool[],
  excludeMacroId: number,
): number | null {
  const byId = mapById(pools);
  const p = byId.get(poolId);
  if (!p) return null;
  let best: number | null = null, bestD = Infinity;
  for (const m of macros) {
    if (m.id === excludeMacroId || m.poolIds.length === 0) continue;
    const agg = macroDescriptor(m.poolIds, byId);
    const d = labDistance(p.descriptor, agg.labL, agg.labA, agg.labB);
    if (d < bestD) { bestD = d; best = m.id; }
  }
  return best;
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
