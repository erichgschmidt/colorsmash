# Smash Engine — Code-Quality Audit

Scope: `plugin/src/core/smash/*.ts` + `plugin/src/ui/smash/SmashSection.tsx` +
`plugin/src/ui/smash/persistence.ts`. Read-only audit; no source modified.
449 tests pass; the engine is functionally solid. The findings below are about
debt accreted across ~12 phases — persistence gaps, dead code, hot-path waste,
and a handful of latent bugs.

Priority key: **Critical** = user-visible breakage or data loss · **Should-fix**
= correctness/perf risk or real inconsistency · **Nice-to-have** = cleanup.

---

## Critical

### C1. `clusterMultipliers` (SOURCE MIX) is never persisted — silently lost on reload
- **Where:** `ui/smash/persistence.ts` (whole file — no field), `ui/smash/SmashSection.tsx:246` (state), `:404-413` (save effect), `:322-363` (load block).
- **What's wrong:** Every other ENGINE control (`posterize`, `distribution`, `conditionalCdf`, `slicedOt`, `zoneRatio`, all the temperature/zone fields) is in the `SmashPersisted` interface, written by the save `useEffect`, and restored in the load block. `clusterMultipliers` is in React state and is sent to the engine (`SmashSection.tsx:464`), but: it is **not** a field on `SmashPersisted`, **not** in the saver payload at `:404-413`, and **not** read back at load. A user who drags the SOURCE MIX ratio bar and reopens the panel loses every adjustment with no warning.
- **Fix:** Add `clusterMultipliers?: number[]` to `SmashPersisted`, include it in the save payload and the `useEffect` dep array, and restore it in the load block with a length-vs-cluster-count guard (the engine already tolerates stale-length arrays — see `transform.ts:773-777` — but the UI bar should reset to neutral if the count mismatches).

### C2. `SmashPersisted.colorization` only carries 3 of the toggle fields — `proportionMatch` etc. round-trip through a *different* path, but the 3 toggles are the only ones in the nested object
- **Where:** `ui/smash/persistence.ts:35-40` vs `SmashSection.tsx:464`.
- **What's wrong:** `SmashPersisted.colorization` declares only `{ hueByLuma, liftNeutrals, paletteSnap }`. The engine's `ColorizationOptions` has 25+ fields. The UI works around this by persisting the *numeric* engine fields (`proportionMatch`, `posterize`, …) as **flat top-level** keys on `SmashPersisted` and re-merging them into `colorization` only at engine-call time (`:464`). The result is two parallel conventions for one engine struct: nested for the 3 booleans, flat for everything else. This is the root cause of C1 — `clusterMultipliers` fell through the crack between the two conventions. It is brittle: any new colorization field must be wired in *three* places (interface, save, load) and a contributor reasonably assuming "add it to `colorization`" will produce a field that silently never persists.
- **Fix:** Pick one convention. Simplest: persist the whole resolved `ColorizationOptions` object under `colorization` and clamp/validate per-field on load. This collapses C1, C2, and most of the per-field load boilerplate at `:322-363`.

---

## Should-fix

### S1. Audit panel rows "Anchored clusters" / "Locked clusters" / "Gamut clipped" are permanently empty — `smash()` never populates them
- **Where:** `core/smash/audit.ts:52-75` (`withClusterAnchored`, `withClusterLocked`, `withGamutClipped` exported + tested), `transform.ts:9` (only `createAudit`, `withTraitContribution`, `withBandUsed`, `finalize` imported), `ui/smash/SmashAuditPanel.tsx:265-280` (renders the three fields).
- **What's wrong:** The audit panel displays Anchored/Locked clusters and a Gamut-clipped flag, but `smash()` calls none of the three mutators that would set them. `acesGamutCompress` runs unconditionally in `applyTransformOnePass` (`transform.ts:1062`) yet never reports whether it actually clipped. So those panel rows show "—/—/No" 100% of the time regardless of the image. Either dead UI or an unfinished feature; either way it misleads the user.
- **Fix:** Either (a) wire the mutators — have `acesGamutCompress` return a clipped flag and OR it into the audit, and emit anchored/locked from the cluster set; or (b) remove the three fields from `SmashAudit`, `audit.ts`, and the panel. Given `locked`/`anchor` are also dead (see S2), (b) is the smaller honest change.

### S2. `ClusterStats.locked` / `.anchor` and `clusters.ts` helpers `lockCluster` / `anchorCluster` / `applyClusterMultipliers` are dead
- **Where:** `core/smash/types.ts:79-80` (fields), `core/smash/clusters.ts:59-105` (three exported helpers).
- **What's wrong:** `extractClusters` always sets `locked:false, anchor:false, multiplier:1`. Nothing in the engine ever reads `.locked` or `.anchor` (grep of `transform.ts`/`profile.ts` returns nothing). `lockCluster`, `anchorCluster`, and `applyClusterMultipliers` are exported and have tests but **zero non-test callers** in `src/` — the SOURCE MIX feature reweights via `colorization.clusterMultipliers` inside `smash()` (`transform.ts:772-800`) and never touches `applyClusterMultipliers`. `ClusterStats.natural` is read only by the dead `applyClusterMultipliers`.
- **Fix:** Delete the three helpers and their tests; drop `locked`, `anchor`, `natural`, `multiplier` from `ClusterStats` (or keep `multiplier`/`natural` only if a future preset format needs them, with a comment). This also unblocks the (b) option in S1.

### S3. `smash()` re-filters every band's source/target features on every call — O(bands × N) per slider drag
- **Where:** `transform.ts:650-651` inside the `for` over `profile.bands`.
- **What's wrong:** `sourceFeatures.filter(...)` / `targetFeatures.filter(...)` run once per band, each a full O(N) scan over ~16k–100k features, allocating a new array. With `bandCount` up to 7 that's ~14 full passes + allocations on **every** `smash()` call — and `smash()` runs every slider tick. The expensive CDF build was already hoisted into the snap-cached `buildSmashCdfs`; this band-curve fit was not. The masterplan note at `transform.ts:618-622` claims slider drags are "~5ms"; the band re-filter undercuts that on large feature sets.
- **Fix:** The per-band `ChannelCurves` depend only on `(sourceFeatures, targetFeatures, profile)` — not on `controls`. Move the whole band-transform loop into `buildSmashCdfs` (or a sibling snap-cached builder) and pass `bandTransforms` through `SmashCdfs`, exactly as the CDFs are. `smash()` then only does audit + ratio resolution per tick.

### S4. Temperature warmth-median estimation runs 64 full `applyTransform` calls inside `smash()` — and `applyTransform` honors `passes`
- **Where:** `transform.ts:823-863`.
- **What's wrong:** `smash()` samples `applyTransform` over a 4×4×4 RGB grid (comment at `:850` says "27 points / 3×3×3" but `samplePoints` has 4 entries → **64** points — stale comment, see N1). Each call runs the *entire* pipeline including all colorization mechanics. When `passes > 1`, each of the 64 calls runs `applyTransformOnePass` 2–4× — so the warmth estimate alone is up to 256 full-pipeline evaluations per `smash()` call, i.e. per slider tick. The sliced-OT lookup, distribution loop, etc. all execute 64–256× just to compute one median. It's correct but heavier than the "~27 samples is enough … cheap" comment implies.
- **Fix:** Sample with a fixed `passes:1, temperature:0` control set (the temp-zero override already exists at `:823-826`; add `passes:1`). Better: warmth only needs the post-gate Oklab, not the full RGB round-trip — a lighter dedicated sampler would cut this to near-free.

### S5. `applyTransformOnePass` allocates 3 arrays per pixel in the hot path
- **Where:** `transform.ts:1025-1033`.
- **What's wrong:** `bandTransforms.map(...)` (rawWeights), `.reduce(...)`, and a second `.map(...)` (weights) allocate two `number[]` of length `bandTransforms.length` **per pixel**. `applyTransformOnePass` runs 4096–35937× per LUT bake (× `passes`, × the 64 warmth samples). That's ~70k–550k short-lived array allocations per bake — pure GC pressure for a fixed-size (≤7) inner loop.
- **Fix:** Compute the Gaussian weights into a reused scratch `Float64Array` (or just two stack scalars accumulated in a single loop: one pass for `weightSum`, one to accumulate `outR/G/B` dividing by `weightSum` inline). No allocation, identical math.

### S6. `buildSmashCdfs` materializes three throwaway `Vec3[]` arrays for sliced-OT
- **Where:** `transform.ts:376-377`.
- **What's wrong:** `sourceFeatures.map((f) => f.oklab)` and `targetFeatures.map((f) => f.oklab)` allocate two full `Vec3[]` (16k–100k entries) only to be immediately subsampled to 4000 inside `buildSlicedOtField`. `buildSlicedOtField` then copies again via `subsampleFlat`. This is snap-cached (not per-drag) so it's lower severity, but it's two avoidable large allocations.
- **Fix:** Have `buildSlicedOtField` accept the `PixelFeatures[]` directly (or an accessor) and read `.oklab` during its own subsample pass.

### S7. `slicedOt` looks up displacement at **input** Oklab while every other mechanic composes on the **smashed** result — inconsistent and possibly wrong
- **Where:** `transform.ts:1581-1586`, comment at `:1570-1575`.
- **What's wrong:** The comment justifies keying the field on the *input* (`Lin, aIn, bIn`). But by the time Phase 8 runs, `Lout/aOut/bOut` already encode L-CDF, chroma-CDF, Hue-by-L, zone routing, conditional CDF, and temperature. Adding a displacement computed from the *raw input* position means sliced-OT does not actually "transport the engine's output toward the source" (as `types.ts:404-405` claims) — it transports the *original target pixel*, then that vector is bolted onto an already-heavily-transformed colour. The two transforms don't compose: stack `slicedOt` on top of a strong `conditionalCdf` and the OT vector is fighting a colour that no longer exists in the cloud it was fit to. The field was *fit* on target→source clouds, so keying on `T0` (input) is internally consistent with the fit — but then it should be applied *instead of* the per-axis CDFs at high strength, not added after them.
- **Fix:** Decide the intended composition and document it in `applyTransformOnePass`'s header. If sliced-OT is meant to be the strongest joint match, key it on `Lout/aOut/bOut` (apply-on-output) so it corrects whatever the cheaper mechanics produced; if it's an independent target→source map, the masterplan/`types.ts` doc should say "displaces the input pixel" not "the engine's output colour."

### S8. `applyTransformOnePass` has no order-of-operations header — the pipeline order is implicit
- **Where:** `transform.ts:1007` onward.
- **What's wrong:** The function is ~660 lines and the mechanic order (band curves → gamut compress → L/C/h CDF → liftNeutrals → conditionalCdf → paletteSnap → zone routing → trait gates → temperature → slicedOt → RGB convert → distribution → posterize) is only discoverable by reading top to bottom. Two mechanics compose in a non-obvious order: **distribution runs before posterize** (`:1591` then `:1641`) — intentional per the comment, but distribution operates in RGB *after* the Oklab→RGB convert while zone routing operates in Oklab *before* it. A reader can't see the staged pipeline at a glance, and "where does my new mechanic go?" has no documented answer — which is how the engine accreted inconsistencies S7/S10.
- **Fix:** Add a numbered pipeline comment block at the top of `applyTransformOnePass` listing each stage, its colour space (RGB vs Oklab OkLCh), and why it sits where it does. Cheap, high-value for the next phase.

### S9. `posterize` / `distribution` ignore the trait gates and `masterGate` — a 100%-posterize at `global=0` still posterizes
- **Where:** `transform.ts:1606-1668` vs the gate math at `:1402-1422`.
- **What's wrong:** `masterGate` (and `global`) scale the L/C/h deltas, and the `global=0` path is tested as identity (`transform.test.ts:206`). But `distribution` and `posterize` lerp the final RGB by their own raw amount with **no `masterGate` factor**. So with `global=0` (Smash Amount 0) but `posterize=1`, the output is fully snapped to cluster RGBs — the "amount" slider does not zero the effect. Similarly `slicedOt` and `temperature` are gated by their own amounts only, not `global`. This is a consistency gap: some mechanics respect the master Amount, some don't, and nothing documents which.
- **Fix:** Decide the contract. Either multiply `distribution`/`posterize`/`slicedOt`/`temperature` strengths by `masterGate` (or `controls.global`) so Amount is a true master, or document in S8's header that these four are "post-gate absolute effects" by design. Right now it's neither stated nor consistent.

### S10. `paletteSnap` scores clusters by `hin` (input hue) but zone routing and posterize route by `Lin`/`Lsm` — three different "nearest cluster" definitions
- **Where:** `paletteSnap` `transform.ts:1259-1262` (hue dist + 0.5·L dist), zone argmin `:1366-1368` (`|Lin − clusterL|`), posterize `:1657-1659` (`|Lin − centroidL|`), `buildSmashCdfs` cluster bucketing `:329-339` (full Oklab Euclidean).
- **What's wrong:** Four mechanics that all "pick the nearest source cluster" use four different distance metrics. That's defensible per-mechanic (the masterplan §8.4 explains the L-routing intuition for posterize/zone) but there is no shared helper and no comment cross-referencing them, so the divergence reads as accident rather than intent.
- **Fix:** Extract a small `nearestClusterByL(clusters, L)` helper used by zone-argmin and posterize (they're byte-identical logic — `:1366-1368` ≡ `:1657-1659`), and add a one-line comment on `paletteSnap` explaining why *it* uses hue distance instead.

### S11. `condChromaLookup` clamps the result `≥0` but `condHueLookup` does not clamp hue into `[-π, π]`
- **Where:** `transform.ts:966-967` vs `:991-996`.
- **What's wrong:** `condChromaLookup` defends with `Math.max(0, …)`. `condHueLookup` blends `h0 + dh*frac` and can return a value outside `[-π, π]` when `h0` is near a bound. Downstream the result feeds `dh = condH - hGlobal` (`:1231`) which *is* wrap-corrected, so today it's harmless — but it's an undocumented invariant. If a future consumer reads the conditional hue directly it will get an unnormalised angle.
- **Fix:** Either wrap the return of `condHueLookup` into `[-π, π]`, or add a comment that callers must wrap-correct.

---

## Nice-to-have

### N1. Stale comment: warmth sampling says "27 points (3×3×3)" but samples 64 (4×4×4)
- **Where:** `transform.ts:850` `samplePoints = [16, 96, 176, 240]` (4 values → 64 grid points); comments at `:136-139` and `:822` both say "3×3×3 / 27 points."
- **Fix:** Update both comments to 4×4×4 / 64.

### N2. `ColorizationOptions` doc comment for `temperature` contains a self-correction mid-sentence
- **Where:** `types.ts:274-279`: *"Negative t mirrors: … — wait, that's wrong. Actually: …"*.
- **What's wrong:** A literal "wait, that's wrong" left in shipped API documentation. Harmless but unprofessional and confusing.
- **Fix:** Rewrite the paragraph to state the final (correct) behaviour cleanly.

### N3. `ColorizationOptions` future-toggle stubs are stale
- **Where:** `types.ts:440-443`: `// readonly stochasticPerL?: boolean; // readonly slicedOt?: boolean;` — but `slicedOt` already shipped (`:415`).
- **Fix:** Remove the `slicedOt` stub line; keep or drop `stochasticPerL` per roadmap.

### N4. `SmashEngineOutput` / `SmashCdfs` have grown to ~30 fields with heavy duplication
- **Where:** `transform.ts:52-173` (`SmashEngineOutput`), `:183-230` (`SmashCdfs`).
- **What's wrong:** `SmashEngineOutput` re-exports nearly every `SmashCdfs` field verbatim (`lumaCdf`, `chromaCdf`, `hueCdf`, `hueByLumaLut`, `targetMedianChroma`, `sourceMedianChroma`, `clusterSubLuts`, `clusterLs`, `clusterRgbs`, `clusterOrderByL`, `sortedClusterLs`, `conditionalCdf`, `slicedOt`). `smash()` literally copies them field-by-field (`:713-722`, then again in two object literals `:833-847` and `:865-879`). The six `*RatioNaturalWeights`/`*RatioBandColors` pairs are also flat. `targetMedianChroma` is documented as "no longer used as an eligibility gate … recorded for inspection" (`:86-91`) — i.e. dead weight on the hot struct.
- **Fix:** Nest the CDF bundle: `SmashEngineOutput` holds `cdfs: SmashCdfs` instead of 13 mirrored fields, and group the three ratio axes into a `ratioAxes: { value, hue, chroma }` record. Drop `targetMedianChroma` if nothing reads it (grep shows only the audit comment). Cuts the two giant object literals to a few lines and removes the field-copy block.

### N5. `featuresToRgba` non-null assertions rely on an upstream length check
- **Where:** `transform.ts:666-667` `featuresToRgba(srcFiltered)!`.
- **What's wrong:** The `!` is safe only because `:654` already guaranteed `length >= VIABILITY_THRESHOLD`. Fine today, fragile to refactor.
- **Fix:** Minor — a comment, or have `featuresToRgba` throw on empty rather than return null.

### N6. `accentScore` is computed twice with different constants and one is shadowed
- **Where:** `transform.ts:1396-1399`: `neutralness`/`accentScore` are recomputed here, but `liftNeutralness` (`:1211`) already computed the identical `1 - min(1, Cin/0.15)`. `neutralness` at `:1396` duplicates `liftNeutralness`.
- **Fix:** Compute the `Cin/0.15` neutralness once and reuse for both lift and gate.

### N7. Magic numbers scattered through the hot path
- **Where:** `0.15` neutralness divisor (`:1211`, `:1396`), `0.10`/`0.15` accent window (`:1398`), `WARM_A=0.82`/`WARM_B=0.57` defined twice (`:848-849` and `:1470-1471`), `HUE_FILTER_CHROMA`, `0.02` cluster-chroma floor (`:1249`), `SIGMA=0.15` (`:1609`).
- **Fix:** Hoist to named module constants (the warm-axis pair especially — duplicating it invites drift).

---

## Test-coverage notes

Coverage is genuinely good — every `colorization` field has at least a
default-is-no-op test plus an engaged-diverges test in `transform.test.ts`, and
`conditionalCdf`/`slicedOt`/`valueRatio`/the temperature biases each have a
degenerate-input (empty features → null) test. Gaps worth closing:

- **No persistence round-trip tests.** `persistence.ts` has no test file at all. A `loadSmashSettings`→`makeSmashSaver`→reload test would have caught C1/C2 immediately.
- **`temperatureSensitivity`** is exercised only indirectly (it appears in `transform.test.ts` setup) — no test asserts the soft-vs-sharp exponent (`3^(2·sens−1)`) actually changes the split width.
- **No test composes mechanics adversarially** — e.g. `slicedOt:1` + `conditionalCdf:1` together (the S7 composition concern), or `posterize:1` + `global:0` (the S9 gate gap). All divergence tests toggle one mechanic against default.
- **`zoneEdgeSoftness`** has an engaged test but no sparse/`K≤1`-cluster degenerate test (the `zoneBoundaries.length > 0` guard at `:1326` is untested for the empty-boundary branch).

---

## Summary

The Smash engine is correct and well-tested at the unit level, but rapid
phase growth left real debt. **Two Critical issues** are user-facing data loss:
the SOURCE MIX `clusterMultipliers` is never persisted (C1), caused by a
split-brain persistence convention where the `colorization` struct carries 3
fields nested and 20+ fields flat (C2). **Should-fix** items cluster around (a)
dead audit/cluster machinery — `locked`/`anchor`, three `clusters.ts` helpers,
and three audit mutators are exported, tested, and never called, so the audit
panel's cluster/gamut rows are permanently blank (S1–S2); (b) hot-path waste —
per-call band re-filtering (S3), 64–256 full-pipeline warmth samples (S4), and
per-pixel array allocation (S5); and (c) composition ambiguity — `slicedOt`
keys on input not output (S7), `posterize`/`distribution` bypass the master
Amount gate (S9), and `applyTransformOnePass` has no documented stage order
(S8). None block shipping, but C1/C2 should be fixed before the next release
and the dead code removed to stop the audit panel from lying to users.

Report file: `C:\Users\Gus\Documents\development\ColorSmash\.claude\worktrees\musing-chandrasekhar-ed6125\smash-engine-audit.md`
