# Temperature per-Chroma / per-Saturation Modulators — Design

**Status:** Design only. Target phase: **4.5t** (continues the 4.5m–4.5r temperature line).
**Working titles:** `temperatureCBias`, `temperatureSBias`.
**Mirrors:** `temperatureLBias` (Phase 4.5r) exactly — a `[-1,+1]` field, default `0`
(uniform = no-op), a linear per-pixel weight that multiplies the temperature
migration delta.

This document covers the remaining two of the three axes in the user's original
aspiration — *"intensity of cool vs warm, ratio of cool warm, influence by value,
color, saturation etc."* Phase 4.5r shipped the **value (L)** axis. This ships the
**chroma** and **saturation** axes. See addendum §8.4h "Future work":

> *Per-C modulation (only affect saturated pixels), per-S modulation. Each adds
> one more slider following the same pattern as `temperatureLBias`: multiply the
> migration delta by a per-pixel weight derived from `Cin` or `Sin`.*

---

## 1. Decision: two separate controls (C **and** S), not one combined

**Decision: ship two separate sliders — `temperatureCBias` and `temperatureSBias`.**

Chroma and saturation *are* correlated (`saturation = C / L`), so the temptation
is one "vividness" knob. Rejected, for four concrete reasons:

1. **They diverge exactly where the user cares.** A dark, deeply-colored pixel
   (`L≈0.2, C≈0.12`) has *moderate* chroma but *very high* saturation
   (`S = 0.12/0.2 = 0.6`). A bright pastel (`L≈0.9, C≈0.12`) has the *same*
   chroma but *low* saturation (`S ≈ 0.13`). "Affect the vivid colors" and
   "affect the punchy dark colors" are different artistic intents, and a single
   knob cannot express both. Chroma isolates *absolute colorfulness*;
   saturation isolates *colorfulness relative to lightness* (the "is this a
   muddy shadow or a rich shadow" distinction).

2. **The L axis already shipped as its own control.** `S = C/L` means the
   saturation modulator is partly redundant with `temperatureLBias` *only if*
   the user also constrains chroma. Keeping S separate lets the three sliders
   (`TARGET L`, `TARGET C`, `TARGET S`) compose into any region of the
   (L, C, S) space the user wants — including the genuinely useful
   "high-saturation regardless of L" selection that neither L nor C alone
   gives.

3. **House pattern is one-slider-per-axis.** Every temperature refinement so
   far (`temperature`, `temperatureSensitivity`, `temperatureLBias`) is a
   single-purpose scalar. A combined "CS" knob would be the first multiplexed
   control and would need a mode toggle — strictly more UI than two plain
   sliders, and harder to write a tooltip for.

4. **Cost is negligible.** Each modulator is a clamp + a lerp + a multiply per
   pixel (see §3). Two of them is still well under a microsecond per pixel and
   fully LUT-bakable. There is no performance argument for merging.

The two weights **compose multiplicatively** with each other and with
`temperatureLBias` (§3), so a user who wants "vivid highlights only" sets
`TARGET L = +100%`, `TARGET C = +100%` and gets the product — exactly the
behavior `temperatureLBias` established.

---

## 2. New `ColorizationOptions` fields

Two fields, added to `plugin/src/core/smash/types.ts` immediately after
`temperatureLBias` (keep the temperature cluster contiguous). Doc-comment style
matches the existing `temperatureLBias` comment.

```ts
  /** Phase 4.5t — Temperature C Bias. Limits the temperature mechanic to a
   *  slice of the CHROMA range — "vivid pixels only," "muted/neutral pixels
   *  only," or anywhere in between. Multiplies the per-pixel migration delta
   *  by a linear weight derived from the pixel's INPUT chroma (Cin), measured
   *  relative to the target image's own chroma distribution so the control is
   *  image-relative like the rest of the temperature mechanic.
   *
   *  Range [-1, +1]:
   *    -1: full bias toward LOW CHROMA — only neutral/muted pixels get the
   *        temperature shift; vivid pixels are untouched
   *     0 (default): uniform — every chroma level gets the temperature shift
   *        as computed by TEMPERATURE × SENSITIVITY
   *    +1: full bias toward HIGH CHROMA — only vivid pixels get the
   *        temperature shift; neutrals are untouched
   *
   *  Weight formula (cNorm = Cin normalized to [0,1] vs the target's chroma
   *  distribution — see `targetChromaP95`):
   *    if cBias === 0: weight = 1               (uniform)
   *    if cBias  >  0: weight = lerp(1, cNorm,     |cBias|)
   *    if cBias  <  0: weight = lerp(1, 1−cNorm,   |cBias|)
   *
   *  Composes multiplicatively with `temperatureLBias` and
   *  `temperatureSBias`: a pixel restricted to highlights AND high chroma
   *  receives the product of both weights. */
  readonly temperatureCBias?: number;
  /** Phase 4.5t — Temperature S Bias. Same idea as `temperatureCBias` but
   *  along the SATURATION axis (S = C / L — colorfulness relative to
   *  lightness). Limits the temperature mechanic to "high-saturation pixels
   *  only," "desaturated pixels only," or anywhere in between.
   *
   *  Chroma vs saturation: a dark richly-colored pixel has moderate chroma
   *  but high saturation; a bright pastel has the same chroma but low
   *  saturation. C Bias targets absolute colorfulness; S Bias targets
   *  colorfulness-per-lightness. Both are offered because the two diverge
   *  exactly where the user's artistic intent diverges.
   *
   *  Range [-1, +1]:
   *    -1: full bias toward LOW SATURATION — only desaturated pixels migrate
   *     0 (default): uniform — every saturation level gets the shift
   *    +1: full bias toward HIGH SATURATION — only saturated pixels migrate
   *
   *  Weight formula (sNorm = Sin normalized to [0,1] vs the target's
   *  saturation distribution — see `targetSaturationP95`):
   *    if sBias === 0: weight = 1               (uniform)
   *    if sBias  >  0: weight = lerp(1, sNorm,     |sBias|)
   *    if sBias  <  0: weight = lerp(1, 1−sNorm,   |sBias|)
   *
   *  Composes multiplicatively with `temperatureLBias` and
   *  `temperatureCBias`. */
  readonly temperatureSBias?: number;
```

Both default to `0` (uniform / no-op). `DEFAULT_SMASH_CONTROLS.colorization` in
`transform.ts` gains two entries alongside the existing `temperatureLBias: 0`:

```ts
    // Phase 4.5t: temperatureCBias / temperatureSBias default to 0 — uniform
    // across all chroma / saturation, temperature shift unrestricted.
    temperatureCBias: 0,
    temperatureSBias: 0,
```

---

## 3. Per-pixel weight formula & application point

### 3.1 Where it goes

`temperatureLBias` is applied inside `applyTransformOnePass` in
`transform.ts`, in the `if (shouldShift) { ... }` block (around lines
1190–1213). The existing code computes `lWeight`, then:

```ts
      // delta moves warmth toward (and possibly past) median, scaled by lWeight.
      const delta = -relW * effective_t * lWeight;
      aOut += delta * WARM_A;
      bOut += delta * WARM_B;
```

The two new weights multiply into **the exact same `delta` expression**, so all
three biases compose multiplicatively. The new block, replacing the existing
`lWeight`-only computation:

```ts
    if (shouldShift) {
      // Phase 4.5r — Temperature L Bias: linear weight on the migration
      // delta based on the pixel's output L.
      const rawLBias = controls.colorization?.temperatureLBias;
      const lBias =
        typeof rawLBias === 'number' && Number.isFinite(rawLBias)
          ? Math.max(-1, Math.min(1, rawLBias))
          : 0;
      let lWeight = 1;
      if (lBias !== 0) {
        const L = Math.max(0, Math.min(1, Lout));
        const target = lBias > 0 ? L : 1 - L;
        lWeight = 1 + Math.abs(lBias) * (target - 1);
      }

      // Phase 4.5t — Temperature C Bias: linear weight on the migration
      // delta based on the pixel's INPUT chroma, normalized image-relatively.
      const rawCBias = controls.colorization?.temperatureCBias;
      const cBias =
        typeof rawCBias === 'number' && Number.isFinite(rawCBias)
          ? Math.max(-1, Math.min(1, rawCBias))
          : 0;
      let cWeight = 1;
      if (cBias !== 0) {
        // Cin is the input pixel's pre-transform chroma (see §4). p95 is the
        // 95th-percentile chroma of the target image — the normalization
        // anchor. Guard against a fully-neutral target (p95 ≈ 0).
        const cNorm = Math.max(0, Math.min(1,
          Cin / Math.max(out.targetChromaP95, 1e-4)));
        const target = cBias > 0 ? cNorm : 1 - cNorm;
        cWeight = 1 + Math.abs(cBias) * (target - 1);
      }

      // Phase 4.5t — Temperature S Bias: linear weight on the migration
      // delta based on the pixel's INPUT saturation (S = C / L).
      const rawSBias = controls.colorization?.temperatureSBias;
      const sBias =
        typeof rawSBias === 'number' && Number.isFinite(rawSBias)
          ? Math.max(-1, Math.min(1, rawSBias))
          : 0;
      let sWeight = 1;
      if (sBias !== 0) {
        const Sin = Math.min(2, Cin / Math.max(Lin, 1e-6)); // matches features.ts
        const sNorm = Math.max(0, Math.min(1,
          Sin / Math.max(out.targetSaturationP95, 1e-4)));
        const target = sBias > 0 ? sNorm : 1 - sNorm;
        sWeight = 1 + Math.abs(sBias) * (target - 1);
      }

      // All three biases compose multiplicatively. With every bias at 0 each
      // weight is exactly 1, so delta is byte-identical to Phase 4.5r.
      const delta = -relW * effective_t * lWeight * cWeight * sWeight;
      aOut += delta * WARM_A;
      bOut += delta * WARM_B;
    }
```

### 3.2 Why **input** chroma/saturation, not output

`temperatureLBias` keys off `Lout` (the post-gate output L) because the user is
biasing toward where pixels *land*. For C/S we deliberately use **input**
`Cin`/`Sin` instead, for two reasons:

- **Stability.** `Cout` is the result of the chroma + saturation gates and can
  swing far from `Cin` (lift-neutrals can raise a near-zero chroma to the
  source median; INFLUENCE overdrive can overshoot). Keying the weight off a
  value the temperature step itself helped produce risks feedback-flavored
  surprises. `Cin`/`Sin` are fixed for the pixel — the user's "vivid pixels"
  selection means *vivid in the target they picked*, which is the intuitive
  reading.
- **Image-relativity is well-defined.** The whole temperature mechanic is
  image-relative to the *target*. Normalizing against the *target's* chroma
  distribution (§4) only makes sense for a value drawn from that same
  distribution — i.e. `Cin`. Using `Cout` would normalize an
  engine-synthesized chroma against the original target's percentiles, a
  category error.

`Cin` and `Lin` are already in scope at this point in `applyTransformOnePass`
(they are the polar decomposition of the input Oklab used by the gates above —
confirm the local names; if the function only carries `ain`/`bin`, derive
`Cin = Math.sqrt(ain*ain + bin*bin)` once near the top of the temperature block).

---

## 4. Normalizing chroma / saturation to a `[0,1]` axis

`Lout` is naturally in `[0,1]`, so `temperatureLBias` ramps over it directly.
Chroma and saturation are **not** bounded to `[0,1]` — Oklab chroma for
in-gamut sRGB tops out around `~0.33` but is image-dependent, and
`saturation = C/L` is clamped to `[0,2]` in `features.ts`. A fixed divisor
(e.g. "chroma / 0.33") would make the slider behave wildly differently between a
muted photo and a neon one — exactly the "absolute reference" failure mode that
Phase 4.5o suffered and 4.5p fixed by going image-relative.

**Proposal: normalize against the target image's own 95th-percentile chroma and
saturation.** This is consistent with the rest of temperature being
image-relative, and p95 (rather than max) rejects single-pixel outliers /
specular noise that would otherwise compress the whole ramp.

### 4.1 New `SmashEngineOutput` fields

Add two scalars next to `estimatedOutputMedianWarmth` (lines ~130–137 of
`transform.ts`):

```ts
  /** Phase 4.5t — 95th-percentile INPUT chroma of the target image, in Oklab
   *  C units. The normalization anchor for `temperatureCBias`'s weight ramp:
   *  a pixel at this chroma maps to cNorm = 1. p95 (not max) is used so a
   *  handful of specular/noise outliers don't compress the ramp. Computed at
   *  smash() time from the target features. */
  readonly targetChromaP95: number;
  /** Phase 4.5t — 95th-percentile INPUT saturation (S = C/L, clamped [0,2] as
   *  in features.ts) of the target image. Normalization anchor for
   *  `temperatureSBias`. */
  readonly targetSaturationP95: number;
```

### 4.2 Computing them in `smash()`

The target `PixelFeatures[]` are already extracted (`snapDerived.targetFeatures`,
passed to `smash()`). `features.ts` already populates `.chroma` and
`.saturation` per pixel. Compute both percentiles once, near where
`estimatedOutputMedianWarmth` is computed:

```ts
// Phase 4.5t — target chroma / saturation p95, normalization anchors for the
// temperature C/S bias weight ramps. p95 rejects specular outliers.
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}
const targetChromaP95 =
  percentile(targetFeatures.map((f) => f.chroma), 0.95);
const targetSaturationP95 =
  percentile(targetFeatures.map((f) => f.saturation), 0.95);
```

Add both to the `SmashEngineOutput` returned object **and** to
`partialForSampling` (so the warmth-median sampling pass — which calls
`applyTransform` with `temperature: 0` — sees a consistent shape). The values
are harmless in `partialForSampling` because `temperature: 0` short-circuits the
whole block before any C/S weight is read.

**Degenerate-target guard.** A fully-neutral grayscale target gives
`targetChromaP95 ≈ 0`. The `Math.max(out.targetChromaP95, 1e-4)` in §3.1 keeps
the division finite; `cNorm` then clamps to `1` for every pixel, so a
`temperatureCBias` set on a grayscale target degrades to "uniform" rather than
NaN — graceful, and arguably correct (there is no chroma structure to bias
along). Same for saturation.

### 4.3 Why p95 and not mean / median / max

- **max** — one specular highlight or one JPEG-fringe pixel sets the anchor;
  every real pixel then sits near `cNorm ≈ 0.1` and the slider feels dead.
- **median** — half the pixels exceed the anchor and clamp to `cNorm = 1`,
  collapsing the top half of the ramp.
- **p95** — ~5% of pixels clamp at the top (the genuinely-vivid ones, which is
  the intended "high chroma" target set), the rest spread smoothly across
  `[0,1]`. Matches how the eye reads "the vivid parts of this image."

---

## 5. UI wiring checklist

All in `plugin/src/ui/smash/SmashSection.tsx` unless noted. Follow the
`temperatureLBias` / `TARGET L` wiring exactly.

| # | Location | Change |
|---|----------|--------|
| 1 | State vars | `const [temperatureCBias, setTemperatureCBias] = useState<number>(0);` and `const [temperatureSBias, setTemperatureSBias] = useState<number>(0);` next to `temperatureLBias` (~line 158). |
| 2 | `INLINE_DEFAULTS` | Add `temperatureCBias: 0,` and `temperatureSBias: 0,` after `temperatureLBias: 0` (~line 92). |
| 3 | Mount restore (`loadSmashSettings`) | Two more clamp blocks after the `temperatureLBias` one (~line 254): `if (typeof persisted?.temperatureCBias === "number" && Number.isFinite(...)) setTemperatureCBias(Math.max(-1, Math.min(1, persisted.temperatureCBias)));` and the S equivalent. |
| 4 | Debounced save `useEffect` | Add `temperatureCBias, temperatureSBias` to the saver payload object **and** to the dependency array (~lines 269–272). |
| 5 | `pipeline` `useMemo` controls object | Add `temperatureCBias, temperatureSBias` to the `colorization: { ... }` merge (~line 315) **and** to the memo dependency array (~line 326). |
| 6 | `resetAllInline` | `setTemperatureCBias(INLINE_DEFAULTS.temperatureCBias);` and S equivalent (~line 364). |
| 7 | Slider row JSX | Two new `passesRowStyle` rows after the `TARGET L` row (~line 852). Labels `TARGET C` and `TARGET S`. `min={-100} max={100} step={5}`, `value={Math.round(temperatureCBias * 100)}`, `onChange` divides by 100. Sign-prefixed readout: `{temperatureCBias >= 0 ? "+" : ""}{Math.round(temperatureCBias * 100)}%`. Double-click resets that one row. |
| 8 | ENGINE header tooltips | Append `TARGET C`, `TARGET S` to the two `title` strings on the ENGINE header / ✕ button (~lines 506, 513). |
| 9 | `persistence.ts` | Add `temperatureCBias?: number;` and `temperatureSBias?: number;` to `SmashPersisted` with a Phase 4.5t doc comment, after `temperatureLBias` (~line 82). |

### Slider row JSX (TARGET C — TARGET S is identical with C→S)

```tsx
{/* Phase 4.5t — Temperature C Bias. Restricts the temperature shift to a
    slice of the CHROMA range. 0% = uniform. Negative = muted/neutral
    pixels only; positive = vivid pixels only. */}
<div
  style={passesRowStyle}
  onDoubleClick={() => { if (hasSnaps) setTemperatureCBias(INLINE_DEFAULTS.temperatureCBias); }}
>
  <span style={passesLabelStyle}>TARGET C</span>
  <input
    type="range"
    min={-100}
    max={100}
    step={5}
    value={Math.round(temperatureCBias * 100)}
    onChange={(e) => setTemperatureCBias(parseInt((e.target as HTMLInputElement).value, 10) / 100)}
    disabled={!hasSnaps}
    style={passesSliderStyle}
    title="Restricts the TEMPERATURE shift to a slice of the CHROMA range. 0% (default) = UNIFORM — every chroma level gets the shift. NEGATIVE = focus on MUTED/NEUTRAL pixels — only low-chroma pixels migrate; vivid pixels are untouched. POSITIVE = focus on VIVID pixels — only high-chroma pixels migrate; neutrals are untouched. Chroma is measured relative to this target image's own 95th-percentile chroma. ±100% = full bias (the opposite side is fully spared). Composes with TARGET L and TARGET S — set all three to sculpt an exact (lightness, chroma, saturation) region. Only effective when TEMPERATURE ≠ 0."
  />
  <span style={passesValueStyle}>{temperatureCBias >= 0 ? "+" : ""}{Math.round(temperatureCBias * 100)}%</span>
</div>
```

`TARGET S` tooltip swaps in: *"...slice of the SATURATION range (S = colorfulness
relative to lightness — a dark rich color is high-saturation even at moderate
chroma)... NEGATIVE = desaturated pixels only... POSITIVE = punchy/saturated
pixels only..."*

### persistence.ts entry

```ts
  /** v1.21 Phase 4.5t — temperature C / S bias. Each -1..+1, default 0.
   *  Limit the temperature shift to a slice of the chroma (C) or
   *  saturation (S) range (-1 = muted/desaturated only, +1 = vivid/
   *  saturated only). */
  temperatureCBias?: number;
  temperatureSBias?: number;
```

---

## 6. LUT-bakability confirmation

**Confirmed bakable.** The Smash LUT bake samples `applyTransform(R,G,B)` on a
33³ grid and writes a `.cube`. The two modulators add nothing that breaks the
pure-function contract:

- **No per-pixel random state, no spatial access.** Each weight is a pure
  function of the pixel's own `Cin` / `Lin` plus two **engine-time constants**
  (`targetChromaP95`, `targetSaturationP95`) frozen on the `SmashEngineOutput`
  before the bake samples anything — identical in kind to
  `estimatedOutputMedianWarmth` (4.5p) and `adjustedClusterWeights` (4.5k),
  both already confirmed bakable.
- **`Cin` / `Sin` are deterministic functions of the input RGB** — chroma is
  the polar magnitude of the input Oklab `(a,b)`; saturation is `C/L`. So the
  whole modulated `delta` is still `f(R,G,B) → (R',G',B')`.
- **Multi-pass safe.** `targetChromaP95` is fixed for the bake; each of the
  `passes` iterations re-derives `Cin` from *its own* input, exactly as
  `temperatureLBias` re-derives `Lout` per pass. No accumulation hazard.
- **Default = byte-exact regression.** With both biases `0`, `cWeight` and
  `sWeight` are exactly `1`, so `delta` is bit-identical to Phase 4.5r output
  — verified by the test in §7.

---

## 7. Test plan (vitest)

Add to the existing temperature transform test file (the one already covering
`temperatureLBias` — likely `transform.temperature.test.ts` under
`plugin/src/core/smash/__tests__/` or co-located; place these next to the 4.5r
cases).

1. **Default no-op / regression.** With `temperatureCBias` and
   `temperatureSBias` both `undefined` (and again both `0`), every baked grid
   point is byte-identical to the Phase 4.5r output with `temperatureLBias`
   only. Guards the "compose multiplicatively, identity at 0" contract.

2. **C bias `+1` spares neutrals.** Build a target with a known low-chroma
   pixel and a known high-chroma pixel, `temperature ≠ 0`, `temperatureCBias =
   +1`. Assert the low-chroma pixel's output equals its `temperature = 0`
   output (untouched), and the high-chroma pixel's shift magnitude is
   unchanged vs. `temperatureCBias = 0`.

3. **C bias `-1` spares vivid pixels.** Mirror of test 2: high-chroma pixel
   untouched, low-chroma pixel fully shifted.

4. **C bias `±0.5` is a linear interpolation.** Assert the migration delta at
   `cBias = 0.5` equals `delta(0) * (0.5 + 0.5 * cNorm)` within a tight epsilon
   for several `cNorm` values — confirms the `lerp(1, target, |bias|)` ramp.

5. **S bias diverges from C bias.** Construct two pixels with *equal chroma*
   but *different L* (hence different `S = C/L`). With `temperatureSBias = +1`
   assert they receive *different* weights, and with `temperatureCBias = +1`
   assert they receive the *same* weight. This is the core "two controls, not
   one" justification, encoded as a test.

6. **Multiplicative composition.** With `temperatureLBias = +1` (highlights),
   `temperatureCBias = +1` (vivid), assert a dark muted pixel's delta ≈ 0 and a
   bright vivid pixel's delta ≈ `delta(0)`, and a bright *muted* pixel's delta
   ≈ `delta(0) * lWeight * cWeight` (the product, not either alone).

7. **Grayscale-target guard.** Fully-neutral target (`targetChromaP95 ≈ 0`):
   any `temperatureCBias` value produces no NaN/Infinity in the baked LUT and
   the output equals the uniform (`cBias = 0`) result.

8. **Percentile helper unit test.** `percentile([...], 0.95)` returns the
   expected element for a few hand-checked arrays incl. empty (`→ 0`) and
   single-element inputs.

9. **`shouldShift = false` short-circuit.** When a pixel is same-polarity as
   the slider (no migration), the C/S weights are never reached and the output
   is unchanged regardless of `temperatureCBias` / `temperatureSBias`.

10. **Persistence round-trip.** `makeSmashSaver` → `loadSmashSettings` restores
    `temperatureCBias` / `temperatureSBias`; out-of-range values clamp to
    `[-1,+1]`; missing keys leave the defaults.

---

## 8. Open questions & recommended resolutions

**Q1. Input vs output chroma/saturation for the weight key.**
*Recommendation: input (`Cin`/`Sin`).* Rationale in §3.2 — output chroma is
gate-dependent and can't be normalized against the target's own distribution
without a category error. If playtesting shows users expect "vivid" to mean
"vivid *after* smashing," revisit, but ship on input.

**Q2. p95 vs a different percentile / max for the normalization anchor.**
*Recommendation: p95.* See §4.3. Cheap to make the percentile a named constant
(`TEMP_BIAS_NORM_PERCENTILE = 0.95`) so it can be tuned without touching call
sites. Do **not** expose it as a user control — it is a calibration constant,
not a creative knob.

**Q3. Should C/S bias normalize against the target or the *output*
distribution?** *Recommendation: target.* The target is what the user sees and
points at; the output distribution isn't known until after the transform.
Consistent with §3.2.

**Q4. Saturation at near-black pixels.** `S = C/L` blows up as `L→0`.
`features.ts` already clamps `S` to `[0,2]` via `C / Math.max(L, 1e-6)` then
`Math.min(2, ...)`. *Recommendation:* reuse that exact clamp in the transform
(shown in §3.1) so the engine's `Sin` matches `features.ts`'s `.saturation` and
therefore matches the p95 anchor's units. Do not invent a second saturation
definition.

**Q5. UI ordering / naming.** Three `TARGET *` rows in a row could read as a
group. *Recommendation:* keep `TARGET L`, then `TARGET C`, then `TARGET S` in
that order directly below `SENSITIVITY`; the shared `TARGET` prefix already
signals "these three sculpt where temperature applies." No sub-header needed —
consistent with the flat ENGINE slider list. If the list feels long later, a
`TEMPERATURE` disclosure grouping all five temperature rows is a clean future
refactor, out of scope here.

**Q6. Combined "vividness" convenience knob.** Explicitly rejected (§1). If
user feedback later asks for it, it can be added as a *macro* that drives both
sliders, leaving the two primitives intact — but not in this phase.

**Q7. Extended ranges.** `temperature` and `temperatureSensitivity` got
`[-2,+2]` / `[0,2]` overdrive ranges in Phase 4.5q. `temperatureLBias` stayed
`[-1,+1]` (a weight past 1 would *amplify* the delta, changing meaning from
"restrict" to "boost"). *Recommendation:* keep C/S bias `[-1,+1]` to match
`temperatureLBias` — these are restrictors, not gains. Overdrive belongs on
`temperature`/`SENSITIVITY`.

---

## Summary of files touched (implementation phase, not this doc)

- `plugin/src/core/smash/types.ts` — two `ColorizationOptions` fields.
- `plugin/src/core/smash/transform.ts` — `DEFAULT_SMASH_CONTROLS` defaults;
  two `SmashEngineOutput` fields; `percentile` helper + p95 computation in
  `smash()`; `cWeight`/`sWeight` in the `shouldShift` block of
  `applyTransformOnePass`; add the two p95 fields to `partialForSampling`.
- `plugin/src/ui/smash/SmashSection.tsx` — state, `INLINE_DEFAULTS`, restore,
  save, pipeline merge, `resetAllInline`, two slider rows, tooltips.
- `plugin/src/ui/smash/persistence.ts` — two `SmashPersisted` fields.
- `ColorSmash_Masterplan_v1.1_addendum.md` §8.4h — add a "Phase 4.5t" entry
  next to the 4.5r entry; mark §8.4h "Future work" per-C/per-S as done.
- Temperature transform vitest file — the §7 cases.
