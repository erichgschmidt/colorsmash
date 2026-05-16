# Phase 8 — Sliced Optimal Transport color matching (`slicedOt`)

**Status:** Design. Roadmap item §8.5 "Sliced optimal transport" (v1.1 §5, Toggle 4).
"Math-heavy, gives the strongest distribution preservation; benchmark before
implementing." This document is the benchmark-before-implementing design.

See `ColorSmash_Masterplan_v1.1_addendum.md` §8.5, and `conditional-cdf-design.md`
(Phase 5) for the closest precedent — a snap-cached joint-structure mechanic
with a `[0, 1]` blend control defaulting to a strict no-op.

---

## 1. Problem

The Phase 3–6 engine matches the OkLCh dimensions **independently**: `lumaCdf`,
`chromaCdf`, `hueCdf` each rank-map one *marginal* of the target onto the
corresponding marginal of the source. Phase 5 `conditionalCdf` recovers one slice
of the joint structure — `P(C | L)` and `P(h | L)` — but it is still axis-aligned:
it conditions on `L` and matches `C`/`h` separately within each `L` bucket. It
cannot express a correlation like "as `a` increases, `b` decreases" that does not
factor through `L`.

Sliced Optimal Transport (sliced OT) matches the **full joint 3D distribution**
of the target Oklab point cloud onto the source's. It is the strongest
distribution-preservation mechanic available without abandoning a LUT-bakable
pure function: it captures every linear and nonlinear correlation the per-axis
CDFs and the `L`-conditional CDFs miss, at the cost of a heavier `smash()`-time
computation.

This is **not** a per-`L` refinement of the existing CDFs. It is a parallel,
independent path: a converged 3D color→color displacement field, baked into its
own grid and consulted by `applyTransform` as one more blendable contribution.

---

## 2. Algorithm

### 2.1 Sliced OT in one paragraph

Sliced OT approximates the optimal transport map between two 3D point clouds by
reducing it to a sequence of trivial 1D problems. Pick a random unit direction
`θ ∈ S²`. Project every point of both clouds onto `θ` (a dot product → a scalar).
1D optimal transport between two equal-size scalar sets is *just sorting*: the
i-th smallest target projection should move to the i-th smallest source
projection. The displacement along `θ` for each target point is
`(sortedSrcProj[rank] − targetProj)`. Apply a fraction of that displacement to
the target point (moving it *along `θ` only*), pick a new random `θ`, repeat.
After enough slices the target cloud converges in distribution to the source
cloud. This is exactly `cdfMatch.ts`'s 1D rank-map sub-step, run repeatedly along
random axes instead of once along each fixed OkLCh axis.

### 2.2 Working color space

Run sliced OT in **Oklab `(L, a, b)`** — the same Cartesian space the feature
cloud already lives in (`PixelFeatures.oklab`). Reasons:

- Euclidean distance in Oklab is perceptually meaningful, so a random direction
  `θ` is a perceptually meaningful "color axis". OkLCh is *polar* — hue is
  circular and chroma is non-negative, so a linear projection and a linear
  sort-match are both wrong there (the existing per-axis hue CDF only works
  because the apply-side shortest-arc lerp papers over the wrap).
- The grid we bake into is RGB-indexed but the *displacement* it stores is most
  naturally computed and interpolated in Oklab.
- `srgbByteToOklab` / `oklabToSrgbByte` already exist and are cheap.

The three Oklab axes have different scales (`L ∈ ~[0,1]`, `a,b ∈ ~[-0.4,0.4]`).
Sliced OT does **not** require isotropic axes — a random direction simply samples
the (anisotropic) space — but for the convergence metric (§2.6) we normalize.
We do **not** pre-whiten the cloud; pre-whitening would change which transport
map sliced OT converges to, and the un-whitened map is the perceptually correct
one (move the same perceptual distance in every direction).

### 2.3 Random-projection scheme

Each iteration uses one direction `θ` drawn uniformly on the unit sphere `S²`.
Generate by normalizing a 3-vector of independent Gaussians (Box–Muller from a
seeded PRNG), rejecting the degenerate near-zero vector:

```ts
// Deterministic, seedable PRNG — mulberry32. Sliced OT MUST be reproducible:
// same (source, target, controls) ⇒ byte-identical LUT ⇒ stable presets/bakes.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDirection(rng: () => number): [number, number, number] {
  // Two uniforms → one Gaussian pair (Box–Muller); third Gaussian from a
  // second pair. Normalize. Re-draw on the measure-zero zero vector.
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
```

A fixed default seed (e.g. `0x5MASH`) is used so the result is deterministic.
Optionally a *batch* of directions per "epoch" can be quasi-randomized
(stratified on the sphere via a low-discrepancy sequence) for faster convergence;
for v0 we keep plain i.i.d. directions — simpler, and convergence is already
fast enough at the recommended subsample size (§5).

### 2.4 The iteration

Two clouds of equal size `N` (subsampled — see §5): `T` (target, the one that
moves) and `S` (source, fixed). `T0` is a frozen copy of `T`'s starting
positions — we need the *displacement field* `T_final − T0`, not just `T_final`.

```
for iter in 0 .. ITERS-1:
    θ        = randomDirection(rng)
    tProj[i] = dot(T[i], θ)                       # O(N)
    sProj[j] = dot(S[j], θ)                       # O(N)
    tOrder   = argsort(tProj)                     # O(N log N)
    sSorted  = sort(sProj)                        # O(N log N)
    for rank in 0 .. N-1:
        i      = tOrder[rank]
        disp   = sSorted[rank] - tProj[i]         # 1D OT displacement
        T[i]  += STEP * disp * θ                  # move along θ only
# displacement field:
field[i] = T[i] - T0[i]                           # Oklab (ΔL, Δa, Δb) per point
```

`STEP` (the per-iteration relaxation factor) is `1.0` for textbook sliced OT —
each slice fully corrects the marginal along its axis. `STEP < 1` (e.g. `0.6`)
trades convergence speed for smoothness of the per-iteration trajectory and
slightly reduces the chance of overshoot when `N` is small and the projected
distributions are noisy. **Recommendation: `STEP = 1.0`**, `ITERS` chosen
generously (§2.5) — full-step sliced OT with enough iterations is the
well-studied configuration and converges cleanly.

`sProj` only needs sorting; `tProj` needs `argsort` because we must write the
displacement back to the *original* index. `argsort` = sort an index array by
`tProj`.

### 2.5 Iteration count and convergence criterion

Sliced OT converges geometrically in distribution. For 3D clouds at `N ≈ 4000`
points, **`ITERS = 64`** random slices give a visually converged match;
`ITERS = 128` is indistinguishable but safe. We expose `ITERS` as an internal
constant (like `L_BUCKETS`), not a creative knob.

Add an **early-exit convergence check** every 16 iterations: the per-iteration
*sliced-Wasserstein residual* is the mean squared 1D displacement of the slice,
`meanResidual = (1/N) Σ disp²`. Track a rolling mean over the last 16 slices; if
it drops below `CONVERGE_EPS` (a small fraction of the cloud's variance, e.g.
`1e-4 ×` mean Oklab variance) stop early. This caps cost on easy pairs (source ≈
target) without hurting hard pairs.

```ts
const SLICED_OT_ITERS = 128;          // hard cap
const SLICED_OT_CHECK_EVERY = 16;
const SLICED_OT_CONVERGE_FRAC = 1e-4; // × cloud variance
const SLICED_OT_STEP = 1.0;
```

### 2.6 Why the result is a function of input color (LUT-bakable)

This is the load-bearing claim. Sliced OT moves a *point cloud* — by itself that
is a permutation/displacement of *samples*, not a function. It becomes a function
the moment we observe: **every target sample carries a displacement vector
`field[i] = T_final[i] − T0[i]`, and `field[i]` is attached to a known input
Oklab position `T0[i]`.** That is a *scattered* color→color map: input Oklab
`p_i` → output Oklab `p_i + field[i]`.

We convert that scattered map into a dense, smooth function exactly the way the
engine already converts feature data into apply-time state — by **baking it into
a regular grid once, at `smash()` time**, and interpolating the grid at apply
time. Sliced OT is run on the *subsampled feature clouds* inside `buildSmashCdfs`
(the snap-cached path, alongside `buildConditionalCdf`); the converged
displacement field is splatted into a small 3D Oklab grid stored on
`SmashEngineOutput.slicedOt`; `applyTransform` does a trilinear lookup into that
grid and applies the interpolated displacement. After the bake, no point cloud
exists at apply time — only the grid, which is frozen engine state, so the whole
mechanic is a pure `f(R,G,B) → (R',G',B')` and bakes cleanly into the 17³/33³
`.cube` LUT via the existing `bakeSmashLut`.

The grid is intentionally **Oklab-indexed**, not RGB-indexed: the displacement
field is smooth in Oklab (sliced OT minimizes Oklab-space transport cost), so a
uniform Oklab grid resolves it with far fewer cells than a uniform RGB grid
would. `bakeSmashLut`'s outer RGB grid still works — each RGB grid point is
converted to Oklab, looked up in the Oklab displacement grid, displaced, and
converted back. (See §4.)

---

## 3. `smash()`-time bake — the displacement grid

### 3.1 Grid structure

A new module `core/smash/slicedOt.ts`. The grid:

```ts
/** A baked sliced-OT color→color displacement field over a regular Oklab grid.
 *  Stores, per grid cell, the Oklab displacement (ΔL, Δa, Δb) that maps an
 *  input color toward the source's joint distribution. Apply-time does a
 *  trilinear lookup + add. Frozen engine state — fully LUT-bakable. */
export interface SlicedOtField {
  /** Per-axis grid resolution. 16 is the shipped default (16³ = 4096 cells). */
  readonly size: number;
  /** Oklab bounds the grid spans — the union bbox of source+target clouds,
   *  padded ~5% so apply-time inputs near the extremes still interpolate. */
  readonly lMin: number; readonly lMax: number;
  readonly aMin: number; readonly aMax: number;
  readonly bMin: number; readonly bMax: number;
  /** Flat displacement values, length size³ × 3, layout L-outer / a / b-inner.
   *  cell (li,ai,bi) → [dL, da, db] at offset ((li*size + ai)*size + bi)*3. */
  readonly disp: Float32Array;
}
```

`size = 16` → 4096 cells × 3 floats = 48 KB. Comparable to the existing per-snap
cached state; acceptable on `SmashEngineOutput`. (`conditionalCdf` is ~7 KB; this
is larger but still small.)

### 3.2 Splat: scattered field → grid

The converged sliced-OT result is `N` scattered samples `(T0[i], field[i])`. Bake
them into the grid by **inverse-distance / trilinear splatting** — each sample
deposits its displacement into the 8 surrounding grid cells weighted by trilinear
weights; then divide each cell by its accumulated weight (a normalized scatter,
the transpose of trilinear gather):

```ts
function buildSlicedOtField(
  source: ReadonlyArray<Vec3>,   // Oklab points, subsampled
  target: ReadonlyArray<Vec3>,   // Oklab points, subsampled (equal length)
  size = 16,
): SlicedOtField {
  // 1. run sliced OT → field[i] (Oklab Δ per target point)   [§2.4]
  // 2. compute padded union bbox over source ∪ target
  // 3. for each (T0[i], field[i]): trilinear-splat field[i] into disp[],
  //    accumulating a parallel weight[] array
  // 4. disp[cell] /= weight[cell]  (cells with weight 0 → §3.3 fill)
}
```

Equal-length clouds: subsample source and target to the *same* `N` (sliced OT's
1D sort-match assumes equal sizes). If raw counts differ, subsample both to
`min(srcCount, tgtCount, SUBSAMPLE_N)`.

### 3.3 Empty-cell fill (extrapolation)

Grid cells with no nearby sample (the cloud doesn't fill its bbox uniformly —
e.g. no near-black-blue pixels) get `weight = 0`. Two-stage fill:

1. **Flood / pull from neighbours.** Iteratively set each empty cell to the
   weighted mean of its filled 6-neighbours, repeated until stable (a cheap
   Laplacian inpaint on a 16³ grid — a handful of passes).
2. Any cell still empty after the flood (fully isolated region) → zero
   displacement (identity). Safe: those colors don't occur in either image, so
   the LUT bake will only land there via interpolation between filled cells.

This gives a globally smooth field with no holes — important because
`bakeSmashLut` samples a *uniform RGB* grid that will probe Oklab cells the cloud
never visited.

### 3.4 Degenerate inputs

- Empty source or empty target → `slicedOt: null`; apply-time short-circuits to
  identity (no-op), exactly like `conditionalCdf: null`.
- Source ≈ target (residual below `CONVERGE_EPS` at iteration 0) → near-zero
  field; harmless, the mechanic just contributes nothing.
- Single-color source → all source projections equal → every target point maps
  to that color along every axis → field collapses the target to a point. This
  is *correct* sliced OT behaviour (matching a delta distribution), but visually
  it is a flat fill. The `[0,1]` blend control (and the default of `0`) means the
  user opts into this; no special-casing needed.

### 3.5 Where it slots into `buildSmashCdfs`

`buildSlicedOtField` is called once inside `buildSmashCdfs`, after
`buildConditionalCdf`, from the same `sourceFeatures` / `targetFeatures` arrays
(subsampled — §5). It is added to both `SmashCdfs` and the degenerate-return
literal, parallel to `conditionalCdf`. `smash()` copies it onto
`SmashEngineOutput.slicedOt`. It is **not** rebuilt on a slider drag — only on a
snap change — because it depends solely on the feature clouds, not on
`SmashControls`. (The `slicedOt` blend amount, like `conditionalCdf`, is a pure
apply-time gate and needs no rebuild.)

---

## 4. `applyTransform` lookup

### 4.1 New `SmashEngineOutput` field

```ts
export interface SmashEngineOutput {
  // ... existing fields ...
  /** Phase 8 — baked sliced-OT joint-distribution displacement field.
   *  Null on degenerate (empty-feature) input. When the slicedOt control is
   *  0 (default) the apply path short-circuits and never reads this. */
  readonly slicedOt: SlicedOtField | null;
}
```

Mirror it on `SmashCdfs`.

### 4.2 The lookup

Sliced OT is applied as a displacement of the smashed Oklab triple
`(Lout, aOut, bOut)` **after** the per-trait gates, temperature, and zone routing
— at the same position as the final `oklabToSrgbByte` conversion (replacing line
~1547). It must run on the *post-gate* color so it composes with everything
upstream rather than being scrambled by it.

```ts
/** Trilinear lookup of the sliced-OT displacement at an Oklab point.
 *  Returns [dL, da, db]; out-of-bounds inputs clamp to the grid edge. */
function lookupSlicedOt(field: SlicedOtField, L: number, a: number, b: number): Vec3 {
  const { size, lMin, lMax, aMin, aMax, bMin, bMax, disp } = field;
  const fx = clamp01((L - lMin) / (lMax - lMin)) * (size - 1);
  const fy = clamp01((a - aMin) / (aMax - aMin)) * (size - 1);
  const fz = clamp01((b - bMin) / (bMax - bMin)) * (size - 1);
  const x0 = Math.min(size - 2, Math.floor(fx)), x1 = x0 + 1, tx = fx - x0;
  const y0 = Math.min(size - 2, Math.floor(fy)), y1 = y0 + 1, ty = fy - y0;
  const z0 = Math.min(size - 2, Math.floor(fz)), z1 = z0 + 1, tz = fz - z0;
  const at = (xi: number, yi: number, zi: number, c: number) =>
    disp[((xi * size + yi) * size + zi) * 3 + c];
  // standard trilinear blend over the 8 corner displacements, per channel
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  const blend = (c: number) =>
    lerp(
      lerp(lerp(at(x0,y0,z0,c), at(x1,y0,z0,c), tx),
           lerp(at(x0,y1,z0,c), at(x1,y1,z0,c), tx), ty),
      lerp(lerp(at(x0,y0,z1,c), at(x1,y0,z1,c), tx),
           lerp(at(x0,y1,z1,c), at(x1,y1,z1,c), tx), ty),
      tz);
  return [blend(0), blend(1), blend(2)];
}
```

In `applyTransformOnePass`, just before the final `oklabToSrgbByte`:

```ts
// Phase 8 — Sliced OT. Joint-3D-distribution displacement of the post-gate
// Oklab color. 0 = off (default, byte-identical to Phase 7). >0 lerps the
// color toward its sliced-OT-transported position.
const rawSlicedOt = controls.colorization?.slicedOt;
const slicedOtAmt =
  typeof rawSlicedOt === "number" && Number.isFinite(rawSlicedOt)
    ? Math.max(0, Math.min(1, rawSlicedOt))
    : 0;
if (slicedOtAmt > 0 && out.slicedOt) {
  const [dL, da, db] = lookupSlicedOt(out.slicedOt, Lout, aOut, bOut);
  Lout += dL * slicedOtAmt;
  aOut += da * slicedOtAmt;
  bOut += db * slicedOtAmt;
}

let [finalR, finalG, finalB] = oklabToSrgbByte(Lout, aOut, bOut);
```

Cost when engaged: one `lookupSlicedOt` (8 grid fetches + ~21 lerps). Zero when
`slicedOtAmt === 0` — the guard short-circuits, so existing presets and bakes are
**byte-identical**.

### 4.3 Interaction with `bakeSmashLut`

`bakeSmashLut` is unchanged: it samples `applyTransform` over a uniform RGB grid.
Each RGB grid point flows through the new sliced-OT block automatically. The
double interpolation (RGB `.cube` grid → trilinear; Oklab displacement grid →
trilinear) is acceptable because the displacement field is smooth by
construction (§3.3 flood-fill) — there are no hard edges to alias. 33³ export
resolution comfortably resolves it.

---

## 5. Performance budget

`smash()`-time cost of one sliced-OT build (the only added cost; apply-time is
negligible):

| Stage | Cost |
|---|---|
| Per iteration | `2N` dot products + `2 × O(N log N)` sorts + `N` displacement writes |
| `ITERS` iterations | `ITERS × O(N log N)` |
| Splat into 16³ grid | `O(N)` (8 cells/sample) |
| Flood-fill 16³ grid | `O(size³)` × few passes — negligible |

The dominant term is `ITERS × 2 × N log N` comparisons. Concrete estimates
(modern laptop JS, `Float32Array`, typed sort):

| Subsample `N` | `ITERS` | Est. `smash()` cost | Notes |
|---|---|---|---|
| 2000 | 64 | ~15–25 ms | fast, slightly noisier field |
| **4000** | **64** | **~35–55 ms** | **recommended default** |
| 8000 | 128 | ~150–220 ms | overkill for preview tier |

`extractFeatures` at `sampleStride = 4` yields ~16k features on a 256² image.
Sliced OT does **not** need all of them — a uniform random subsample of
**`SUBSAMPLE_N = 4000`** (seeded, deterministic) preserves the joint distribution
well enough for a 16³ grid bake, and 4000 sorts fast. The subsample is drawn once
per snap inside `buildSmashCdfs`.

```ts
const SLICED_OT_SUBSAMPLE_N = 4000;
```

This sits comfortably inside the snap-cached budget. `buildSmashCdfs` already
does ~10–30 ms of cluster sub-LUT work; +35–55 ms for sliced OT keeps the total
snap recompute well under the ~100 ms feel-instant threshold. It is **never** run
on a slider drag — `slicedOt` (the blend amount) is a pure apply-time gate.

If profiling shows it too slow, the levers in order of preference:
`SUBSAMPLE_N` ↓ → `ITERS` ↓ (with early-exit §2.5 doing most of the work
already) → run the build in a worker / lazily on first non-zero `slicedOt`.

---

## 6. The control — `ColorizationOptions.slicedOt`

A blend amount, **not** an alternative mode. Rationale: every other Phase 4.5+
joint-structure mechanic (`conditionalCdf`, `distribution`, `posterize`,
`zoneInfluence`) is a continuous `[0,1]`/`[0,2]` knob defaulting to a no-op, and
sliced OT fits the same pattern — users dial in *how much* joint-distribution
matching they want, on top of (not instead of) the per-axis CDF result.

```ts
export interface ColorizationOptions {
  // ... existing toggles ...
  /** Phase 8 — Sliced optimal transport. Blends the engine's post-gate output
   *  color toward its sliced-OT-transported position — the strongest joint-3D
   *  distribution match (captures Oklab correlations the per-axis and
   *  conditional CDFs miss). Range [0, 1]:
   *    0.0 (default): off — byte-identical to Phase 7.
   *    0.5: half-way toward the full joint-distribution match.
   *    1.0: full sliced-OT transport of the post-gate color.
   *  Computed at smash() time as a baked Oklab displacement grid; apply-time
   *  is one trilinear lookup. Composes with all other mechanics. */
  readonly slicedOt?: number;
}
```

Default in `DEFAULT_SMASH_CONTROLS.colorization`: `slicedOt: 0`. Absent /
non-finite / `≤ 0` are all strict no-ops — existing presets and `.cube` bakes are
unchanged.

UI: an ENGINE **SLICED OT** slider, placed below **CONDITIONAL** in the engine
section (it is the natural "next level up" from conditional CDF in
distribution-matching strength).

### Composition with existing mechanics

- **Per-axis CDFs (Phase 3/4) & conditional CDF (Phase 5):** sliced OT runs
  *downstream*, on the already-smashed `(Lout, aOut, bOut)`. The CDFs decide the
  marginal-and-conditional structure; sliced OT then nudges the result toward the
  true joint distribution. They **stack** — a user can run conditional CDF at
  0.5 and sliced OT at 0.5 and get progressively stronger joint matching. They
  are not mutually exclusive; sliced OT is the heaviest hammer, not a replacement.
- **`distribution` / `posterize`:** those run on `finalR/G/B` *after*
  `oklabToSrgbByte`. Sliced OT runs *before* the conversion. Order:
  per-axis CDF → conditional CDF → zone routing → gates → temperature →
  **sliced OT** → `oklabToSrgbByte` → distribution → posterize. Each is a
  separable lerp; all compose without special-casing.
- **`passes` (multi-pass):** each pass's `applyTransformOnePass` applies sliced
  OT, so the field is re-applied per pass. Acceptable — it is a function of the
  pass's input color like every other mechanic.
- **Gates / traits:** sliced OT is applied after the trait gates, so it is *not*
  gated by `traits.chroma` etc. It has its own `slicedOt` amount. (Gating it
  again by traits would double-attenuate; the single `slicedOt` knob is the
  intended control surface.)

---

## 7. Test plan

`core/smash/slicedOt.test.ts`:

1. **1D sub-step equivalence.** Sliced OT restricted to a single fixed axis
   (`θ = (1,0,0)`), one iteration, must reproduce `buildCdfMatchLut` /
   `lookupCdfMatch`'s rank-map result along that axis (within float tolerance).
   Confirms the projection+sort core matches the proven 1D code.
2. **Marginal convergence.** After a full build, the transported target cloud's
   per-axis sorted marginals must closely match the source's (sliced OT subsumes
   per-axis matching). Assert sliced-Wasserstein residual below `CONVERGE_EPS`.
3. **Joint correlation capture.** Construct a synthetic source with a built-in
   `a`↔`b` anti-correlation that factors through *neither* `L` nor any single
   axis, and a target with `a`/`b` independent. Per-axis CDF + conditional CDF
   leave the correlation unmatched; assert sliced OT recovers it (sample
   covariance of the transported cloud matches source within tolerance).
4. **Determinism.** Same `(source, target)` ⇒ byte-identical `SlicedOtField`
   (seeded PRNG). Run twice, `expect(disp).toEqual(disp)`.
5. **No-op default.** `slicedOt: 0` (and absent/`undefined`) ⇒ `applyTransform`
   output byte-identical to the pre-Phase-8 engine over a sampled RGB grid.
6. **Degenerate inputs.** Empty source / empty target ⇒ `slicedOt: null` ⇒
   identity. Single-color source ⇒ no crash, field finite everywhere.
7. **Grid smoothness / no holes.** After flood-fill, every grid cell is finite;
   neighbouring-cell displacement differences are bounded (no spikes that would
   alias under the `.cube` bake).
8. **LUT-bakability round-trip.** `bakeSmashLut` over an output with `slicedOt:
   1` produces a valid `.cube`; re-applying that LUT to the target approximates
   `bakeTargetPerPixel` within the usual LUT-fidelity tolerance.
9. **Performance regression.** `buildSmashCdfs` with sliced OT enabled stays
   under a budgeted ceiling (e.g. 120 ms at `SUBSAMPLE_N = 4000`).
10. **Subsample stability.** Two different seeded subsamples of the same cloud
    produce visually-close fields (mean per-cell displacement difference small)
    — confirms 4000 points is enough.

Plus a manual `reference.png` visual check: a grayscale target + a strongly
bimodal-color source, `slicedOt` swept 0→1, eyeballed for smooth strengthening
of the joint match with no banding.

---

## 8. Open questions & recommended resolutions

1. **Grid resolution — 16³ vs 17³ vs 33³?**
   *Recommend 16³.* The displacement field is smooth in Oklab; 16³ = 4096 cells
   (48 KB) resolves it well and the flood-fill + trilinear keep it artifact-free.
   17³ aligns with the preview LUT but the Oklab grid is independent of the RGB
   `.cube` grid, so alignment buys nothing. Revisit only if test 7/8 shows
   aliasing.

2. **Apply before or after `oklabToSrgbByte`?**
   *Recommend before* (displace in Oklab). The field is computed and smooth in
   Oklab; displacing there and then converting once is cleaner than baking an
   RGB-space field. Cost is identical.

3. **`STEP` = 1.0 vs <1?**
   *Recommend 1.0* with generous `ITERS` + early-exit. Full-step sliced OT is the
   standard, well-converging configuration; `STEP < 1` only matters if small-`N`
   noise causes visible overshoot, which the 4000-point subsample should avoid.
   Keep `STEP` an internal constant so it can be lowered without an API change.

4. **Should `slicedOt` be gated by the master gate / `controls.global`?**
   *Recommend no.* It has its own `[0,1]` amount; the post-gate position it
   displaces already reflects `global`. Adding another gate would make the knob
   non-linear and confusing. Consistent with how `distribution`/`posterize` work
   (own amount, applied post-gate).

5. **Subsample size — fixed 4000 or adaptive to image size?**
   *Recommend fixed 4000* for v0. It is deterministic, fast, and enough for a
   16³ bake. If a future tier raises feature counts dramatically, make it
   `min(featureCount, 4000)` — already the natural clamp.

6. **Equal-size requirement — what if source/target counts differ a lot?**
   *Recommend* subsampling both to the same `N = min(srcN, tgtN, 4000)`. Sliced
   OT's 1D sort-match needs equal sizes; unequal sizes would need a 1D OT with
   interpolation (the `cdfMatch` percentile trick). Equal subsampling is simpler
   and the percentile information is already preserved by uniform random sampling.

7. **Interaction with `conditionalCdf` — redundant?**
   *Recommend shipping both.* They are not redundant: conditional CDF is cheap
   (~0 apply cost, no `smash()` bake) and `L`-axis-aligned; sliced OT is the
   heavier, fully-joint tool. Users on weak hardware or wanting a light touch use
   conditional CDF; users wanting maximum distribution fidelity reach for sliced
   OT. They stack cleanly (§6). Document sliced OT as "conditional CDF, but for
   the full 3D joint distribution and in every direction."

8. **Hue wrap.** Sliced OT runs in Cartesian Oklab `(L,a,b)` — there is no hue
   angle and no wrap. The post-displacement `(aOut, bOut)` are converted directly
   to RGB. No circular-arc handling needed (unlike the per-axis hue CDF). This is
   a clean advantage of working in Oklab Cartesian.

9. **Quasi-random (stratified) directions for faster convergence?**
   *Defer.* I.i.d. directions at `ITERS = 64–128` converge fine for 3D. A
   low-discrepancy sphere sequence could cut `ITERS` ~2×; revisit only if the
   performance budget tightens.

---

## 9. Summary of changes (when implemented — design only here)

- **New:** `core/smash/slicedOt.ts` — `SlicedOtField`, `buildSlicedOtField`,
  `lookupSlicedOt`, the mulberry32 PRNG + `randomDirection`, constants.
- **`transform.ts`:** add `slicedOt: SlicedOtField | null` to `SmashEngineOutput`
  and `SmashCdfs` (+ degenerate-return literal); call `buildSlicedOtField` in
  `buildSmashCdfs`; add the apply-time block in `applyTransformOnePass` before
  `oklabToSrgbByte`; `slicedOt: 0` in `DEFAULT_SMASH_CONTROLS.colorization`.
- **`types.ts`:** `slicedOt?: number` on `ColorizationOptions`.
- **UI:** ENGINE **SLICED OT** slider below **CONDITIONAL**; persisted in
  `color-smash-smash.json`.
- **No change** to `lut.ts` / `bakeSmashLut` — sliced OT bakes through the
  existing path automatically.
