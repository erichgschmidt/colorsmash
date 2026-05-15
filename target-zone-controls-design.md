# Phase 4.5l — Target Zone Controls (design spec)

Deferred follow-up to Phase 4.5j (zone routing, §8.4f). Where 4.5j defined
*how a target pixel finds its source cluster* (1D nearest by `Lin` against
`clusterLs`) and *what color it pulls from that cluster* (centroid ↔ sub-LUT
lerp by `detailRichness`), this phase gives the user **explicit control over
the L-axis routing function on the target side**: the shape of the boundaries
between zones, where those boundaries land, and how the L range below/above
a boundary is rescaled into the bands the engine sees.

The user's framing: *"my target dynamic range of 5 zones has a lot of fall
off, or snappy edges — we can blur or tighten those edges. We should also be
able to MOVE those edges to COMPRESS their relationships."*

This is a **target-side L remap that feeds zone routing**, not a change to
the source clusters or their sub-LUTs. The clusters stay frozen at extraction
time; only the function `Lin → (which cluster, how strongly)` becomes
user-shapeable.

---

## 1. Conceptual mapping (user words → engine math)

The user described three things:

| User language | What it controls | Engine surface |
|---|---|---|
| "blur or tighten edges" | Hardness of the boundary between two adjacent L-zones | Softmax temperature / smoothstep width around each midpoint |
| "MOVE those edges" | Position of each zone boundary along the L axis | Per-boundary L offset, applied to the midpoint between two centroid Ls |
| "COMPRESS their relationships" (e.g. 0–50% squished to 0–25%) | Nonlinear remap of target L *before* routing — squeezes the L range that maps to a given band | Piecewise-linear L→L remap defined by the moved boundaries |

The three controls compose: **(1) edge sharpness** is a routing-blend
parameter, **(2) edge position** redefines the boundaries, and **(3) edge
compression** is what naturally falls out of moving the boundaries if we
interpret them as new band edges in a piecewise-linear L pre-warp.

Key insight: **edge position and edge compression are two views of the same
slider family**. Moving a boundary from L=0.5 to L=0.25 *automatically*
compresses the 0–0.5 source-side range into the 0–0.25 target-routing range
— but only if we wire the slider as "where does the boundary live on the
target L axis, while the cluster centroid stays put on the routing axis."
Section 4 lays this out precisely. The OPEN QUESTIONS section asks the user
to confirm this is the right reading before we commit to one-slider vs.
two-slider semantics.

---

## 2. Recap of current Phase 4.5j routing (the thing we're modifying)

From `transform.ts:830–863`, the per-pixel routing today is:

```
bestIdx = argmin_k |Lin − clusterLs[k]|                        // hard pick
(aZone, bZone) = lerp(centroid[bestIdx], subLUT[bestIdx](Lin), detailRichness)
hsm += circular_delta(atan2(bZone,aZone), hsm) × zoneInfluence
Csm += (√(aZone²+bZone²) − Csm) × zoneInfluence
```

Equivalent to a hard winner-take-all over K cluster Ls. The implicit
"boundaries" between adjacent clusters (after sorting `clusterLs`
ascending) are the **midpoints** `m_i = (L_i + L_{i+1}) / 2` for i = 0..K−2.
There are K−1 such midpoints. The user wants to manipulate **these K−1
midpoints**, not the K centroid Ls (which are properties of the source).

**Required precomputation**: today `clusterLs` is stored in k-means index
order. For this mechanic we need a sorted view. Either:

- Add `clusterOrderByL: Int32Array` to `SmashCdfs` (a permutation that maps
  sorted-by-L position → original cluster index), or
- Sort `clusterLs` / `clusterSubLuts` / `clusterRgbs` / `adjustedClusterWeights`
  at build time and keep them sorted everywhere downstream.

Either works; the second is cleaner if no other code path depends on the
k-means ordering. (One known consumer: `paletteSnap` reads `clusters` in its
own indexing — verify before resorting in place. See OPEN QUESTIONS.)

---

## 3. The three controls

### 3.1 EDGE SOFTNESS — boundary hardness

**Name (UI):** `EDGE SOFTNESS` (label in caps, same row style as ZONES /
INFLUENCE / DETAIL / ZONE RATIO).

**Engine field:** `colorization.zoneEdgeSoftness: number` ∈ [0, 1], default
`0` (hard pick — matches today's Phase 4.5j behavior exactly).

**Slider:** 0–100% in 5% steps. 0% = today's argmin. 100% = bands fully
overlap into a single blurred field.

**Math.** Replace the hard argmin with a soft assignment, then weighted sum
the cluster contributions:

```
// σ scales the routing softness. At s=0, σ→0 and softmax collapses to argmin.
σ = ε + s × σ_max                          // s = zoneEdgeSoftness, σ_max = 0.10
w_k = exp(-(Lin − clusterLs[k])² / (2σ²))  // K weights
w_k /= Σ w_k                               // normalize
(aZone, bZone) = Σ_k w_k × (centroid_k.ab + (subLUT_k(Lin) − centroid_k.ab) × detail)
```

`σ_max = 0.10` in Oklab L is chosen so that at s=1 a typical 5-zone palette
(centroids ~0.2 apart) sees neighbour weights ≈ exp(-2) ≈ 0.14 of the
winner — a strong but not total blur. Tune in implementation.

`ε ≈ 1e-4` keeps the denominator non-degenerate at s=0; for performance,
short-circuit to the existing argmin path when `s < 0.005`.

**Where it slots in.** Replaces the `bestIdx` scan at `transform.ts:836–846`,
and the single-cluster lookup at `:847–854`. The downstream lerp at `:855–863`
(toward hsm / Csm by `zoneInfluence`) is unchanged.

**Cost.** Goes from O(K) compare + 1 sub-LUT eval to O(K) compare + K sub-LUT
evals. At K=5 with the slider engaged this is ~5× the current zone-path cost.
Still negligible per-pixel (~250 ns vs ~50 ns; LUT bake amortizes it across
the 16³ = 4096 grid). Short-circuit at s=0 preserves the cheap path for users
who don't engage this slider.

**Composition.** Strictly additive on top of 4.5j. detail still works (it
just runs inside each cluster's contribution before the soft-sum). With s=0,
output is bit-identical to today. INFLUENCE still scales the final lerp
toward `(hZone, CZone)`.

---

### 3.2 EDGE SHIFT — boundary position (and the implicit L pre-warp)

**Name (UI):** `EDGE SHIFT` for the single-knob version (see OPEN QUESTIONS
for the K−1-sliders alternative).

**Engine field:** `colorization.zoneEdgeShift: number` ∈ [−1, +1], default
`0` (boundaries at natural midpoints — matches today exactly).

**Slider:** −100% to +100% in 5% steps. Negative = boundaries pulled *down*
in L (darker — shadow zones get squeezed, mid/highlight zones expand to
cover more of target L). Positive = boundaries pushed up in L (highlight
zones squeezed).

**Math.** Define the K−1 natural boundary positions `m_i` (sorted-by-L
midpoints), then warp each toward an anchor:

```
// Sorted centroid Ls: L_0 < L_1 < ... < L_{K-1}.
// Natural midpoints:
m_i^natural = (L_i + L_{i+1}) / 2          for i = 0..K-2

// Shift target: a uniform L distribution would place K−1 boundaries at
// k/K for k = 1..K-1. We lerp toward those evenly-spaced positions by |t|,
// signed for direction.
m_i^uniform = (i + 1) / K
t = zoneEdgeShift  ∈ [-1, +1]

if t >= 0:
  m_i^shifted = m_i^natural + t × (1 − m_i^natural) × bias_i
else:
  m_i^shifted = m_i^natural + t × (m_i^natural − 0) × bias_i

// where bias_i weights inner boundaries more than outer ones, e.g.
// bias_i = sin(π × (i+1)/K) so the extreme boundaries near L=0 / L=1 move
// less than the central ones — keeps the slider from collapsing the
// darkest/lightest zones to zero width.
```

This is one possible 1-knob mapping; an equally valid simpler choice is a
straight lerp toward `m_i^uniform` (see OPEN QUESTIONS — "should EDGE SHIFT
be a single knob or K−1 knobs?").

**Then apply the boundaries to routing.** Two implementation paths, both
equivalent in output but different in efficiency:

**Path A — boundary-aware routing (recommended).** Use the shifted
boundaries directly in the soft-routing weights. Each cluster `k` (in
sorted-by-L order) owns the L interval `[m_{k-1}^shifted, m_k^shifted]`
(with `m_{-1}=0` and `m_{K-1}=1`). Weight by a smoothstep that hits 1 inside
its interval and falls to 0 outside, with the smoothstep width controlled by
`zoneEdgeSoftness`:

```
for cluster k (sorted-by-L order):
  lo = m_{k-1}^shifted, hi = m_k^shifted     // k=0: lo=0; k=K-1: hi=1
  w_k = smoothstep_band(Lin, lo, hi, σ)      // 1 inside, falls over width σ
w_k /= Σ w_k
```

Composition with §3.1: σ here is the same `zoneEdgeSoftness` parameter
expressed as a smoothstep width instead of a Gaussian σ. Equivalent
intuition.

**Path B — pre-warp L, then route by natural boundaries.** Build a
piecewise-linear remap `g(L)` that maps each natural band `[m_{i-1}^natural,
m_i^natural]` onto its shifted counterpart `[m_{i-1}^shifted, m_i^shifted]`,
then route by the un-shifted clusterLs as today:

```
L_routing = g(Lin)         // piecewise linear, K segments
// then run 4.5j as today using L_routing in place of Lin
```

Path A and Path B produce *identical* hard-pick output. They differ subtly
under soft routing (Path A blurs in the shifted space; Path B blurs in the
natural space then maps through a piecewise function). Recommend **Path A**
for conceptual cleanness: the user is manipulating routing boundaries, not
warping Lin itself. (See OPEN QUESTIONS.)

**Where it slots in.** Same insertion point as §3.1 — replaces the bestIdx
scan. The boundaries `m_i^shifted` are computed once per slider tick (K−1
floats) and passed into the per-pixel routing.

**Composition.**
- With INFLUENCE = 0, no effect (zone path doesn't run).
- With ZONES (clusterCount) change, recompute boundaries.
- With ZONE RATIO (4.5k cluster weight modulation), independent — RATIO
  reweights how *source* contributes; SHIFT moves where *target* hands off
  between zones.

---

### 3.3 EDGE COMPRESSION — band width rescaling

**Status: subsumed by EDGE SHIFT if we adopt Path A.** Moving a boundary
from L=0.5 to L=0.25 *is* compressing the [0, 0.5] target L range into the
band that gets routed to the cluster sitting at, say, L=0.2. There is no
extra math — the routing function `Lin → cluster` simply has its boundary
at a new L value, so 1–25% of Lin now triggers the shadow cluster (was
1–50%).

The user's "values are now darker, and the upper 50% of my targets values
are not [now] 25–100% of the dynamic range" reads as exactly this: shift
the shadow→mid boundary from m=0.5 to m=0.25, and the upper band stretches
from [0.5, 1.0] to [0.25, 1.0].

**Two reasons to keep COMPRESSION as a separate concept:**

1. **If we offer K−1 individual EDGE sliders** (one per boundary), the user
   never says the word "compression" — they just drag boundaries. The
   compression *emerges*.
2. **If we offer a single global EDGE SHIFT knob** (§3.2), then a *second*
   global knob — call it `EDGE SQUEEZE` — could control whether the shift
   pulls boundaries together (toward 0.5) or pushes them apart (toward 0
   and 1). That gives the user "make all my zones thinner near the
   middle / thicker near the middle" without needing K−1 sliders.

A minimal viable Phase 4.5l ships **EDGE SOFTNESS + EDGE SHIFT** (two new
sliders, §3.1 + §3.2 Path A). EDGE SQUEEZE / per-boundary sliders defer
to 4.5m unless the user explicitly asks for them now.

| Knob | Range | Default | What it does |
|---|---|---|---|
| `zoneEdgeSoftness` (EDGE SOFTNESS) | 0–1 | 0 | Hardness of zone boundaries. 0 = argmin (today), 1 = wide blur across neighbours. |
| `zoneEdgeShift` (EDGE SHIFT) | −1 to +1 | 0 | Slide all K−1 zone boundaries down (−) or up (+) the target L axis toward uniformly-spaced positions. |
| *(deferred)* `zoneEdgeSqueeze` | −1 to +1 | 0 | Push boundaries toward the L midpoint (+) or toward the extremes (−). |
| *(deferred)* `zoneEdges[K-1]` | per-boundary [0,1] | natural midpoints | Direct per-boundary L positions, overrides the global EDGE SHIFT/SQUEEZE knobs. |

---

## 4. Worked example (user's verbatim scenario)

User says: *"if my dynamic range of 5 zones has a lot of fall off… we can
blur or tighten those edges. I want to be able to MOVE those edges to
COMPRESS… so the 1–50% range squishes to 1–25%."*

5 zones → 4 boundaries. Say sorted clusterLs = [0.10, 0.30, 0.50, 0.72, 0.90].

| | natural midpoint | after EDGE SHIFT = −0.5 | meaning |
|---|---|---|---|
| m₀ (shadow→darkmid) | 0.20 | 0.10 | shadow band squeezes from [0, 0.20] to [0, 0.10] |
| m₁ (darkmid→mid) | 0.40 | 0.25 | "1–50% squishes to 1–25%" — matches user's example |
| m₂ (mid→highmid) | 0.61 | 0.55 | mid band shifts down |
| m₃ (highmid→highlight) | 0.81 | 0.78 | highlight barely moves (outer bias) |

After: target L values in [0.25, 0.55] now route to the "mid" cluster (was
[0.40, 0.61]) — i.e. the middle grays are now darker AND the upper 50% of
target L (0.50–1.0) gets spread across mid + highmid + highlight bands
proportionally to the new boundaries.

If EDGE SOFTNESS is then turned up to 30%, the [0.25, 0.55] mid band still
*dominates* in that L range, but pixels near 0.25 also pick up ~20% of the
darkmid cluster's color, and pixels near 0.55 pick up ~20% of the highmid
cluster's. The "snappy edges" in the user's framing become smooth crossfades.

---

## 5. Pipeline placement and composition

**Where in `applyTransformOnePass`:** Both new controls live *inside the
existing Phase 4.5j block* at `transform.ts:830–864`. The block's signature
becomes:

```
if (zoneInfluence > 0 && clusterSubLuts.length > 0) {
  // 1. Compute boundaries m_0..m_{K-2} from sorted clusterLs + zoneEdgeShift.
  //    (Could be precomputed at smash() time, NOT per-pixel — see §6.)
  // 2. For each cluster (sorted-by-L), compute soft assignment weight w_k
  //    from Lin, boundaries, and zoneEdgeSoftness.
  // 3. Weighted-sum each cluster's (aZone_k, bZone_k) contribution
  //    (centroid + detail × subLUT delta) to get (aZone, bZone).
  // 4. Lerp (hsm, Csm) toward (hZone, CZone) by zoneInfluence.
}
```

Steps 1 and the per-pixel weight schedule (2) are new. Step 3 generalizes
the existing single-cluster pickup. Step 4 is unchanged.

**Order relative to other Phase 4.5 mechanics** (unchanged from §8.4f):

```
CDF + lift + Hue-by-L + paletteSnap (hue)
  → Phase 4.5j+l zone routing (per-cluster soft blend over user-shaped bands)
  → trait gates
  → RGB
  → distribution (Phase 4.5e) → posterize (Phase 4.5d)
```

**Slider dependency graph:**

```
ZONES (clusterCount) ─┬─ rebuilds clusterLs / subLuts / centroids (DNA-level)
                     │
EDGE SHIFT ──────────┼─→ shifts boundaries (engine-time, sub-ms)
                     │       │
EDGE SOFTNESS ───────┼───────┼─→ per-pixel soft assignment
                     │       │
DETAIL ──────────────┼───────┼─→ per-pixel centroid↔subLUT lerp inside each w_k contribution
                     │       │
INFLUENCE ───────────┴───────┴─→ final lerp toward (hZone, CZone)

ZONE RATIO ──→ adjustedClusterWeights (4.5k, distribution-only, independent)
```

EDGE SHIFT and EDGE SOFTNESS are **engine-time / per-pixel parameters
only**. They do NOT trigger re-extraction (unlike ZONES). They should live
on `colorization` next to `zoneInfluence` / `detailRichness` / `zoneRatio`
and participate in the same persistence + recipe IO.

---

## 6. Engine-time precomputation

Compute once per `smash()` call, store in `SmashEngineOutput` alongside
`adjustedClusterWeights`:

```
sortedClusterLs:     Float32Array(K)        // ascending
clusterOrderByL:     Int32Array(K)          // sorted_pos → kmeans_idx
zoneBoundaries:      Float32Array(K - 1)    // m_i^shifted, ascending
```

This keeps the per-pixel hot path doing one binary search (or linear scan)
over `zoneBoundaries` + K smoothstep evals, no allocations.

The boundaries depend on (sortedClusterLs, zoneEdgeShift) only — recompute
when either changes. SoftnessSchedule per pixel depends on `Lin` and the
shared σ, no engine-time precomputation needed.

---

## 7. UI vocabulary

Matches the existing INFLUENCE / DETAIL / ZONE RATIO row style in
`SmashSection.tsx:498–570`:

```
ZONES        [3 ─────●──── 32]   5
INFLUENCE    [0% ─●──── 100%]   30%
DETAIL       [0% ─────●─ 100%]   100%
EDGE SOFTNESS  [0% ●──── 100%]   0%    ← NEW
EDGE SHIFT     [-100% ──●── +100%]  0%   ← NEW
ZONE RATIO   [-100% ──●── +100%]  0%
```

Tooltips, same voice as Phase 4.5j tooltips:

- `EDGE SOFTNESS`: "How sharp the boundaries between zones are. 0% = hard
  edges (each target L picks exactly one source cluster). 100% = soft edges
  (target L blends contributions from neighbouring clusters). Only takes
  effect when INFLUENCE > 0."
- `EDGE SHIFT`: "Slide the zone boundaries along the target L axis. 0% =
  natural (boundaries fall at source-cluster midpoints). NEGATIVE = squeeze
  shadow zones (boundaries move toward dark; mid/highlight zones expand).
  POSITIVE = squeeze highlight zones. Only takes effect when INFLUENCE > 0."

Both sliders are gated by `disabled={!hasSnaps}` like the others.

---

## 8. Persistence + recipe IO

Two new fields:

```typescript
// SmashControls.colorization
zoneEdgeSoftness?: number;   // [0, 1], default 0
zoneEdgeShift?: number;      // [-1, +1], default 0
```

Both get the standard `typeof === "number" && Number.isFinite(...)` + clamp
guard at persistence restore. Both serialize in recipe v1.21+ (matches the
slot already taken by `zoneInfluence` / `detailRichness` / `zoneRatio`).

LUT bakability: **yes**, same argument as §8.4f. Both are pure functions of
frozen engine state once `smash()` completes; the per-pixel hot path is
deterministic in `(R, G, B)`.

---

## 9. OPEN QUESTIONS — please answer before implementation

### Q1. Single global EDGE SHIFT, or K−1 per-boundary sliders?

The user said "move those edges" plural. Three options:

- **(A) Single `EDGE SHIFT` knob** (this doc's recommendation). Simple,
  matches existing slider density. K−1 boundaries are computed from one
  parameter via a bias function. Loses precise control over individual
  boundaries.
- **(B) K−1 per-boundary sliders.** Most expressive but K varies (3–32),
  so UI scales unpredictably. Could clamp to "show sliders only if K ≤ 6"
  with the global knob as fallback.
- **(C) Single knob + an "advanced" disclosure with K−1 sliders.** Most
  flexible. More UI work.

**Default plan if no answer:** ship (A). Most users won't want K−1 sliders;
the global knob already covers the "compress shadows / lift mids" intent.

### Q2. Does EDGE SHIFT preserve area-under-curve, or just slide endpoints?

Two readings of the user's "1–50% squishes to 1–25%":

- **Endpoint sliding (this doc's recommendation, §3.2 / §4).** Boundary at
  L=0.50 moves to L=0.25; the [0, 0.25] target L range routes to the
  shadow cluster, [0.25, end] routes to the next. The "compression" is
  whatever falls out of that — shadow band gets *smaller* on the L axis,
  so *fewer* target pixels route to shadow.
- **Area-preserving compression.** Boundary moves to L=0.25 but with
  internal nonlinear warping such that the *count of pixels* routed to
  shadow stays the same. This requires a target-side histogram and
  effectively re-does CDF matching on the L axis pre-routing. Much more
  expensive and conceptually overlaps with lumaCdf.

**Default plan if no answer:** ship endpoint sliding (the simpler, cleaner
reading). lumaCdf already handles "make my target's L distribution match
source's"; EDGE SHIFT is for *user-imposed* deviation from that, not for
re-doing the match.

### Q3. Path A (boundary-aware routing) vs Path B (L pre-warp + natural boundaries)?

Both produce identical hard-pick output; they differ under soft routing.
Path A blurs in the user's shifted L space (boundaries look smooth in the
new coordinates). Path B blurs in the natural cluster space then maps
through a piecewise function (boundaries can look kinked under heavy soft
+ heavy shift).

**Default plan if no answer:** ship Path A. Conceptually cleaner — the
user is shaping a routing function, not warping Lin.

### Q4. Resort `clusterLs` / sub-LUTs in place, or add a sort permutation?

§2 / §6 noted that `clusterLs` is currently in k-means index order. We need
sorted-by-L access for boundary math. `paletteSnap` (§8.4d) and the
`distribution` mechanic (§8.4e) both read cluster data — verify their
indexing assumptions before sorting in place.

**Default plan if no answer:** add a separate `clusterOrderByL: Int32Array`
to `SmashEngineOutput`. Zero risk of breaking existing consumers. Tiny
memory cost.

### Q5. Should EDGE SOFTNESS share a control with DETAIL?

DETAIL controls intra-cluster L→(a,b) variation. EDGE SOFTNESS controls
inter-cluster L blending. Conceptually orthogonal but both fall in the
"how much variation does the zone path expose" family. Keep separate
(this doc's choice) or merge into one "RICHNESS" knob?

**Default plan if no answer:** keep separate. They have different
defaults (DETAIL=1, SOFTNESS=0) and different semantics. Merging would
force users to make tradeoffs they shouldn't have to.

### Q6. Should EDGE SHIFT also touch posterize / distribution thresholds?

Both `posterize` (Phase 4.5d) and `distribution` (Phase 4.5e) implicitly
have band boundaries (where they snap or where they crossfade). Should
EDGE SHIFT affect those too, or only zone routing?

**Default plan if no answer:** zone routing only. The user described this
mechanic specifically in zone-routing terms; coupling to posterize /
distribution would surprise them. Add a separate global "BAND SHIFT" later
if needed.

---

## 10. Effort estimate

| Component | LOC | Complexity | Test coverage |
|---|---|---|---|
| Add `zoneEdgeSoftness` / `zoneEdgeShift` to `SmashControls` types + defaults | ~10 | trivial | unit: default round-trips through persistence |
| Compute sorted boundaries in `buildSmashCdfs` (or `smash()`) | ~25 | low | unit: K=3,5,8,32 sortedness + monotonicity of shifted boundaries |
| Replace `bestIdx` block in `applyTransformOnePass` with soft-weighted sum | ~40 | medium | unit: at softness=0 + shift=0, output bit-identical to today's 4.5j; at softness=1, weights normalize to Σ=1; at shift=±1, boundaries hit expected positions |
| Persistence + recipe IO updates | ~15 | trivial | round-trip test |
| Two new sliders in `SmashSection.tsx` | ~50 | low | screenshot diff |
| LUT bake regression check | ~0 (existing harness) | trivial | exact-match test: a bake at softness=0/shift=0 matches a Phase 4.5j-frozen bake |

**Total: ~140 LOC, ~1 engineer-day for the recommended (A)+endpoint-sliding+Path-A flavour**, plus ~half a day for tests + UI polish. If we ship the deferred `EDGE SQUEEZE` or per-boundary sliders, add another ~half day each.

**Risk areas:**
- Sort ordering interaction with `paletteSnap` / `distribution` (Q4). Audit before commit.
- LUT bake exactness at softness=0 (must match 4.5j byte-for-byte to keep
  existing presets stable). The short-circuit at `s < 0.005` to the existing
  argmin path is the safe pattern.
- Performance regression at high K (e.g. K=32) with softness > 0: K
  sub-LUT evals per pixel × 4096 LUT grid cells = ~130k extra evals per
  bake. Still <100ms total. Acceptable.

---

## 11. Recommendation

Ship **EDGE SOFTNESS + EDGE SHIFT** as Phase 4.5l. Two new sliders, ~1.5
engineer-days, no breaking changes, fully LUT-bakable, composes cleanly
with Phase 4.5j/k. Defer per-boundary sliders and `EDGE SQUEEZE` to 4.5m
unless the user explicitly wants them in the first cut.

The remaining decisions (Q1–Q6) all have sensible defaults documented above;
the user can override any of them and the design adapts without restructure.
