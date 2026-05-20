# Pool Color-Range Unification

## Problem

Our segmentation produces spatially-coherent pools via k-means → connected-component
islands → edge-protected merge → smooth → polygon vectorize. Each pixel ends up
**hard-assigned** to exactly one pool. Chromatically-related regions that are split
by an intervening colour — e.g. a dress under a sash, a face partly shadowed by a hat
brim — end up in *different* pools, so their transfer cannot share a donor and the
colour continuity breaks at boundaries that aren't really colour boundaries at all.

This is a structural limitation, not a tuning problem. No combination of existing
sliders fixes it because the pool boundaries themselves are wrong: they're spatial,
not chromatic.

## Strategy

After k-means produces N clusters, **unify clusters whose mean Lab distance is below
a threshold**, controlled by a "Pool continuity" slider. Pools can then contain
multiple disjoint spatial islands while still being one pool semantically — one
donor, one transform, one correspondence entry.

Implemented as union-find over cluster mean Labs, run inside `segmentPixelSet` after
the per-pixel assignment loop has produced raw cluster labels and accumulated
per-cluster Lab sums.

## Pipeline (inside `segmentPixelSet`)

1. **k-means** in LCh polar feature space (existing) → `clusters[0..effK-1]` with
   centroids in the polar space.
2. **Per-pixel assign** every pixel in the segmented set to its nearest cluster;
   accumulate `clusterCount[c]` and `clusterLabSum[c]` from real Lab values.
3. **Compute per-cluster mean Lab** = `clusterLabSum[c] / clusterCount[c]`.
4. **NEW — color-range unification pass:**
   - Compute Lab Euclidean distance for every pair of non-empty clusters.
   - Sort pairs by distance ascending.
   - Greedy union-find: for each pair below `continuity × UNIFY_MAX_LAB`, union them
     (skipping pairs already in the same group). Greedy-nearest-first prevents weak
     transitive merges that would happen with a naive single-pass.
5. **Remap `clusterLabels`** so all pixels in a unified group carry the union-find
   root's id. Pixels that weren't in any pair pass through unchanged.
6. **Collapse `clusterCount` + `clusterLabSum`** under root ids (one O(effK) pass).
7. **Continue** with the existing pipeline: build `Cluster[]` → `labelComponents`
   → `mergeSmallIslands` → `smoothLabels` → pool building. Each unified cluster
   is treated as one pool naturally because its (now-disjoint) islands share a
   cluster id.

The downstream code needs **zero changes** — the unification is invisible to it.
Non-root clusters end up with `count = 0` and are skipped during pool building.

## Slider — "Pool continuity"

- `0` (default): no unification. Byte-identical to today's behaviour.
- `1`: aggressive. `UNIFY_MAX_LAB = 30` Lab units — broad colour families
  (warms, blues, near-neutrals) merge into single pools.
- Recommended range for typical work: **0.10 – 0.30**, where same-hue
  near-neighbours unify but distinct families stay separate.

The slider lives in the segmentation controls (INPUTS section) of both
AnalysisTab and SmashTab.

## Effects

- A pool can now contain **multiple disjoint islands**.
- One donor / one transform per unified pool.
- Cross-image colour continuity restored: same-colour regions, regardless of
  physical separation, share their transform.
- Correspondence list shrinks above 0 — the user's `poolCount` becomes a *cap*
  on the number of *initial* clusters, not the *final* pool count.

## Trade-offs

- Less granular control over individual region transforms in the unified case
  (one entry in the correspondence list controls multiple disjoint regions).
  This is the explicit point — it's the dress-under-sash fix.
- Pools' compactness scores drop for spatially-scattered unified pools, which
  in turn affects the noise pass (a diffuse unified pool gets no noise split).
  This is consistent with how diffuse-pool noise is already handled.
- The pool-map preview shows the same colour across multiple regions when they're
  unified — that visualisation IS the feature; it tells the user "these are one
  pool now."

## Why this and not per-pixel soft assignment

An alternative is per-pixel cross-pool blending at transfer time (fuzzy
membership). That smooths out boundaries but **doesn't make the pool tree
recognise the dress halves as one entity** — correspondence still sees two
pools, the user still maps them separately, the pool maps still tint them
differently. Pool unification fixes the structure; soft assignment would just
paper over the seam. Unification was the right call.
