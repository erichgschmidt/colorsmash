# Phase 5 design — Conditional CDF `P(color | L)`

Design doc for the Smash Engine "Conditional CDF" mechanic (Masterplan addendum
§8.5, Toggle 3 / Phase 5c). DESIGN ONLY — no source modified by this document.

## 0. Problem and intent

The Phase 3-4 engine matches L / C / h **independently**. The chroma CDF
(`chromaCdf`) and hue CDF (`hueCdf`) are *global*: every target pixel's chroma is
rank-mapped onto the whole source's chroma distribution, every hue onto the whole
source's hue distribution. This discards the *joint* structure that makes a
source legible — "dark pixels are blue, bright pixels are orange." Hue-by-L
(§8.4f) recovers the **mean** color per L band, but a single averaged `(a,b)` per
L bucket can't express within-L spread: if source's `L≈0.5` bucket is half red,
half teal, every target mid-tone gets the same muddy purple at the same magnitude.

**Conditional CDF** fixes this for the chroma and hue dimensions: instead of one
global chroma/hue CDF, build a *per-L-bucket* chroma CDF and a *per-L-bucket* hue
CDF. A target pixel at lightness `L` gets its chroma and hue rank-mapped against
the distribution of *source pixels that share that L band* — not the whole source.
This restores L-conditional color **spread**, not just the mean, in a fully
LUT-bakable way (no per-pixel random state, no spatial access).

Net contract preserved: `f(R,G,B) → (R',G',B')`, a pure function. The mechanic is
a no-op at its default control value, so existing presets and bakes are byte-identical.

---

## 1. Data structure

### 1.1 Bucketing

Source pixels are bucketed by Oklab `L` into **`L_BUCKETS = 12`** equal-width
buckets across the source's observed `[lMin, lMax]` range (same range convention
as `HueByLumaLut`). 12 is the sweet spot for ~16k–100k source features
(`extractFeatures` at stride 4): enough buckets to resolve a dark→mid→bright color
arc, few enough that the median bucket holds ~1k+ samples (16k / 12) so each
sub-CDF is statistically stable. (`HueByLumaLut` uses 64 bins because it only
stores 2 floats per bin — a CDF is far heavier, see §1.3.)

`lMin`/`lMax` are stored on the struct so apply-time can map an arbitrary input
`L` to a fractional bucket coordinate and interpolate (§3).

### 1.2 Per-bucket sub-CDFs

Each L bucket owns two `CdfMatchLut` values (the existing type from `cdfMatch.ts`):

- a **chroma sub-CDF** — built from the chroma values of source *and* target
  pixels that fall in this L bucket;
- a **hue sub-CDF** — built from the chroma-filtered (`chroma ≥ HUE_FILTER_CHROMA`)
  hue angles of source/target pixels in this L bucket, linear on `[-π, π]`.

A bucket whose source *or* target side has fewer than `VIABILITY_THRESHOLD` (16)
samples is **sparse**: its sub-CDF slot is `null` and apply-time falls back to the
global `chromaCdf` / `hueCdf` for that bucket (§2.3). Sparse buckets are normal at
the extreme ends of the L range and must degrade gracefully.

### 1.3 New interface

A standalone module `plugin/src/core/smash/conditionalCdf.ts` holds the type and
builder, mirroring how `hueByLuma.ts` and `cdfMatch.ts` are factored:

```typescript
// plugin/src/core/smash/conditionalCdf.ts

import { buildCdfMatchLut, lookupCdfMatch, type CdfMatchLut } from './cdfMatch';
import type { PixelFeatures } from './types';

/** Number of L buckets the conditional CDF is sliced into. */
export const L_BUCKETS = 12;

/** Sub-CDF bin count. Smaller than the global CDFs' 256 — each bucket holds
 *  fewer samples, so 64 bins keeps per-bucket noise down while halving memory. */
export const SUB_CDF_BINS = 64;

/**
 * Per-L-bucket chroma + hue CDFs. `chroma[i]` / `hue[i]` are the sub-CDFs for
 * L bucket i; either may be null when that bucket is too sparse on the source
 * or target side (apply-time falls back to the global CDF there).
 */
export interface ConditionalCdf {
  /** Bucket count (=== L_BUCKETS); stored for forward-compat. */
  readonly buckets: number;
  /** Source L range the buckets span. Apply-time maps input L into this range. */
  readonly lMin: number;
  readonly lMax: number;
  /** Per-bucket chroma sub-CDF; null = sparse, use global chromaCdf. */
  readonly chroma: readonly (CdfMatchLut | null)[];
  /** Per-bucket hue sub-CDF (linear on [-π,π]); null = sparse, use global hueCdf. */
  readonly hue: readonly (CdfMatchLut | null)[];
  /** Per-bucket source sample count — diagnostic / audit only. */
  readonly sampleCounts: Int32Array;
}
```

### 1.4 Memory cost

A `CdfMatchLut` is `{ bins, tMin, tMax, values: Float32Array(bins) }`. At
`SUB_CDF_BINS = 64`: `64 × 4 bytes = 256 B` of values + ~32 B overhead ≈ **288 B**
per sub-CDF.

`12 buckets × 2 sub-CDFs × 288 B ≈ 6.9 KB` worst case (all buckets viable), plus a
`48 B` `Int32Array(12)`. **Under 7 KB total** — negligible next to the existing
`clusterSubLuts` (up to 32 `HueByLumaLut`s of `64×2` floats each) and the global
CDFs. Built once per snap change, cached on `SmashCdfs`, never re-allocated on a
slider drag.

---

## 2. Building — `buildSmashCdfs` extension

### 2.1 Where it goes

`buildSmashCdfs` already lives in `transform.ts` and is the canonical builder
(cached per snap change, reused across slider drags via `precomputedCdfs`). The
conditional CDF is built there, right after the global `chromaCdf` / `hueCdf` and
`hueByLumaLut`, and added as one new field on the `SmashCdfs` and
`SmashEngineOutput` interfaces.

### 2.2 Builder

A new exported function in `conditionalCdf.ts`, called from `buildSmashCdfs`:

```typescript
/**
 * Build per-L-bucket chroma + hue CDFs from source/target features.
 * Buckets are equal-width over the SOURCE L range. A bucket is viable only
 * when BOTH its source and target slices clear VIABILITY_THRESHOLD; otherwise
 * its slot is null and apply-time falls back to the global CDF.
 */
export function buildConditionalCdf(
  sourceFeatures: PixelFeatures[],
  targetFeatures: PixelFeatures[],
  viabilityThreshold: number,   // 16, passed from transform.ts
  hueFilterChroma: number,      // 0.02, passed from transform.ts
): ConditionalCdf {
  const empty: ConditionalCdf = {
    buckets: L_BUCKETS, lMin: 0, lMax: 1,
    chroma: new Array(L_BUCKETS).fill(null),
    hue: new Array(L_BUCKETS).fill(null),
    sampleCounts: new Int32Array(L_BUCKETS),
  };
  if (sourceFeatures.length === 0 || targetFeatures.length === 0) return empty;

  // L range from the SOURCE (matches HueByLumaLut convention).
  let lMin = sourceFeatures[0].luma, lMax = sourceFeatures[0].luma;
  for (let i = 1; i < sourceFeatures.length; i++) {
    const l = sourceFeatures[i].luma;
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
  }
  const lRange = lMax - lMin;
  if (lRange <= 0) return empty; // degenerate single-L source

  // Bucket index helper — shared by both passes.
  const bucketOf = (l: number) =>
    Math.min(L_BUCKETS - 1, Math.max(0,
      Math.floor(((l - lMin) / lRange) * L_BUCKETS)));

  // Partition source + target chroma / hue values by L bucket.
  const srcC: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const tgtC: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const srcH: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const tgtH: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const sampleCounts = new Int32Array(L_BUCKETS);

  for (const f of sourceFeatures) {
    const k = bucketOf(f.luma);
    srcC[k].push(f.chroma);
    sampleCounts[k]++;
    if (f.chroma >= hueFilterChroma) srcH[k].push(f.hueAngle);
  }
  for (const f of targetFeatures) {
    // Target pixels routed by their OWN L into the SOURCE-defined buckets.
    const k = bucketOf(f.luma);
    tgtC[k].push(f.chroma);
    if (f.chroma >= hueFilterChroma) tgtH[k].push(f.hueAngle);
  }

  const chroma: (CdfMatchLut | null)[] = new Array(L_BUCKETS).fill(null);
  const hue: (CdfMatchLut | null)[] = new Array(L_BUCKETS).fill(null);
  for (let k = 0; k < L_BUCKETS; k++) {
    if (srcC[k].length >= viabilityThreshold &&
        tgtC[k].length >= viabilityThreshold) {
      chroma[k] = buildCdfMatchLut(
        Float32Array.from(srcC[k]), Float32Array.from(tgtC[k]), SUB_CDF_BINS);
    }
    if (srcH[k].length >= viabilityThreshold &&
        tgtH[k].length >= viabilityThreshold) {
      hue[k] = buildCdfMatchLut(
        Float32Array.from(srcH[k]), Float32Array.from(tgtH[k]), SUB_CDF_BINS);
    }
  }
  return { buckets: L_BUCKETS, lMin, lMax, chroma, hue, sampleCounts };
}
```

Notes:

- **Target pixels are routed into source-defined buckets** by their own `L`. This
  is deliberate and matches the rest of the engine: `lumaCdf` already rank-maps the
  target's L distribution onto the source's, so a target pixel landing in source
  bucket `k` is exactly the pixel whose post-L-CDF lightness sits in that band.
- **Sparse fallback is two-sided.** A bucket is `null` if *either* side is thin.
  A grayscale target has near-zero chroma everywhere — its hue sub-CDFs will often
  be `null` (few pixels above `HUE_FILTER_CHROMA`), and that is fine: hue then
  falls back, and Hue-by-L (which runs upstream) still supplies a sensible hue.
- **Cost:** two linear passes over the feature arrays (`O(N)`) + up to 24
  `buildCdfMatchLut` calls. Each sub-CDF sorts ~`N/12` values. Total ≈ the cost of
  one global CDF build × ~2 — well under 50 ms at 16k features, fine for the
  snap-cached path, never on a slider drag.

### 2.3 `buildSmashCdfs` / `SmashCdfs` / `SmashEngineOutput` wiring

Add one field to all three:

```typescript
// in SmashCdfs and SmashEngineOutput:
/** Phase 5 — per-L-bucket chroma + hue CDFs for the conditionalCdf mechanic.
 *  Built once per snap change. Null entries inside are sparse buckets that
 *  fall back to the global chromaCdf / hueCdf. */
readonly conditionalCdf: ConditionalCdf | null;
```

Inside `buildSmashCdfs`, after `hueByLumaLut` is built:

```typescript
const conditionalCdf = buildConditionalCdf(
  sourceFeatures, targetFeatures, VIABILITY_THRESHOLD, HUE_FILTER_CHROMA);
```

…and add `conditionalCdf` to the empty-input early-return object (`null`) and to
the final returned object. `smash()` copies it from `cdfs` onto the
`SmashEngineOutput` exactly the way it already copies `chromaCdf` / `hueByLumaLut`
(including into `partialForSampling` for the warmth-estimation pass).

---

## 3. Applying — `applyTransformOnePass` consumption

### 3.1 Where it slots in

The mechanic replaces the **source of `cdfMag` and the CDF-fallback `hsm`** in the
existing chroma/hue derivation. Today (transform.ts ~L903 / ~L916):

```typescript
const cdfMag = out.chromaCdf ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;
// ...
hsm = (out.hueCdf && Cin >= HUE_FILTER_CHROMA)
  ? lookupCdfMatch(out.hueCdf, hin) : hsmBand;
```

Phase 5 wraps both lookups in a helper that, when the toggle is engaged, blends
the **bucket-conditional** result over the **global** result by the control
amount, with **linear interpolation between the two adjacent L buckets** so output
is continuous across bucket edges.

### 3.2 Which L drives bucket selection

Bucket selection uses **`Lsm`** (the post-`lumaCdf` smashed lightness), not `Lin`.
Rationale: the conditional CDF buckets were built over the *source's* L range, and
`lumaCdf` is precisely the function that maps a target pixel into the source's L
distribution. `Lsm` is "where this pixel now lives in source-L space," so it is
the correct key into source-derived buckets. (This differs from posterize / zone
routing, which key on `Lin` because the user reasons about *target* L bands there;
here the buckets are *source* constructs, so `Lsm` is right. Called out as Open
Question Q1 with this resolution.)

### 3.3 Interpolation — no banding at bucket edges

`Lsm` maps to a fractional bucket coordinate; the two straddling buckets each
produce a candidate value and the results are blended by the fractional weight.
Because the per-bucket CDFs change smoothly bucket-to-bucket and the blend is
linear in `Lsm`, the output has no discontinuity at bucket boundaries.

Hue interpolation uses the engine's existing **circular shortest-arc** convention
so two buckets straddling the ±π wrap blend correctly.

```typescript
/** Conditional chroma lookup: bucket-interpolated, with per-bucket fallback to
 *  the global chromaCdf for sparse buckets. Returns a chroma magnitude. */
function condChroma(out: SmashEngineOutput, Lsm: number, Cin: number): number {
  const cc = out.conditionalCdf;
  const globalMag = out.chromaCdf
    ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : 0;
  if (!cc || cc.lMax <= cc.lMin) return globalMag;

  // Fractional bucket coordinate in [0, buckets-1].
  const t = ((Math.max(cc.lMin, Math.min(cc.lMax, Lsm)) - cc.lMin)
            / (cc.lMax - cc.lMin)) * (cc.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, cc.buckets - 1);
  const frac = t - k0;

  // Per-bucket value: conditional sub-CDF when viable, else global.
  const v0 = cc.chroma[k0]
    ? Math.max(0, lookupCdfMatch(cc.chroma[k0]!, Cin)) : globalMag;
  const v1 = cc.chroma[k1]
    ? Math.max(0, lookupCdfMatch(cc.chroma[k1]!, Cin)) : globalMag;
  return v0 + (v1 - v0) * frac;
}

/** Conditional hue lookup. Returns an angle in [-π, π]-ish; circular blend. */
function condHue(
  out: SmashEngineOutput, Lsm: number, hin: number, hGlobalFallback: number,
): number {
  const cc = out.conditionalCdf;
  const globalHue = (out.hueCdf)
    ? lookupCdfMatch(out.hueCdf, hin) : hGlobalFallback;
  if (!cc || cc.lMax <= cc.lMin) return globalHue;

  const t = ((Math.max(cc.lMin, Math.min(cc.lMax, Lsm)) - cc.lMin)
            / (cc.lMax - cc.lMin)) * (cc.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, cc.buckets - 1);
  const frac = t - k0;

  const h0 = cc.hue[k0] ? lookupCdfMatch(cc.hue[k0]!, hin) : globalHue;
  const h1 = cc.hue[k1] ? lookupCdfMatch(cc.hue[k1]!, hin) : globalHue;
  // Circular shortest-arc blend from h0 toward h1.
  let dh = h1 - h0;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  return h0 + dh * frac;
}
```

### 3.4 The core-loop edit

`conditionalCdf` is a `[0,1]` amount. `0` = identity (use the global CDFs exactly,
byte-for-byte the Phase 4 path). `>0` lerps the global result toward the
bucket-conditional result. Replacing the two lines from §3.1:

```typescript
// Phase 5 — Conditional CDF amount. 0 = global CDFs unchanged (default).
const rawCond = controls.colorization?.conditionalCdf;
const conditionalAmt =
  typeof rawCond === 'number' && Number.isFinite(rawCond)
    ? Math.max(0, Math.min(1, rawCond)) : 0;

// --- chroma ---
const cdfMagGlobal = out.chromaCdf
  ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;
let cdfMag = cdfMagGlobal;
if (conditionalAmt > 0 && out.conditionalCdf) {
  const cond = condChroma(out, Lsm, Cin);
  cdfMag = cdfMagGlobal + (cond - cdfMagGlobal) * conditionalAmt;
}
// liftNeutrals / proportionMatch math below is UNCHANGED — it consumes cdfMag.

// --- hue (the CDF-fallback branch only; Hue-by-L branch untouched) ---
if (hueByLumaActive && srcLutMag > 1e-6) {
  hsm = Math.atan2(bSrcLut, aSrcLut);            // Hue-by-L — unchanged
} else {
  const hGlobal = (out.hueCdf && Cin >= HUE_FILTER_CHROMA)
    ? lookupCdfMatch(out.hueCdf, hin) : hsmBand;
  if (conditionalAmt > 0 && out.conditionalCdf && Cin >= HUE_FILTER_CHROMA) {
    const condH = condHue(out, Lsm, hin, hsmBand);
    let dh = condH - hGlobal;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    hsm = hGlobal + dh * conditionalAmt;          // circular blend
  } else {
    hsm = hGlobal;
  }
}
```

`condChroma` short-circuits to the byte-exact global value when
`conditionalCdf === null`, when the source's L range is degenerate, and when every
relevant bucket is sparse — so a degenerate snap can never produce a regression.

---

## 4. New control field + UI

### 4.1 `ColorizationOptions`

One new optional field, slotting into the `// Future toggles (Phase 5+)` block at
the bottom of `ColorizationOptions` (`types.ts`) — the comment already reserves the
name `conditionalCdf`:

```typescript
/** Phase 5 — Conditional CDF P(color | L). Amount in [0, 1] controlling how
 *  far chroma + hue are matched against PER-L-BUCKET source distributions
 *  instead of the global chroma/hue CDFs.
 *    0.0 (default): global CDFs only — byte-identical to the Phase 4 path.
 *    0.5: 50/50 blend between the global CDF result and the bucket-
 *         conditional result.
 *    1.0: fully bucket-conditional — a target pixel's chroma + hue are
 *         rank-mapped against the source pixels that share its (smashed) L
 *         band, restoring within-L color spread the global CDF averages away.
 *  Buckets too sparse to be statistically meaningful fall back to the global
 *  CDF automatically; output is interpolated between adjacent L buckets so
 *  there is no banding at bucket edges. Only affects the chroma magnitude and
 *  the CDF-fallback hue branch — when Hue-by-L is on it still owns hue. */
readonly conditionalCdf?: number;
```

- **Name:** `conditionalCdf` (reserved by the existing comment).
- **Range:** `[0, 1]`.
- **Default:** `0` — strict no-op. `DEFAULT_SMASH_CONTROLS.colorization` gets
  `conditionalCdf: 0` added with a Phase 5 comment. Existing presets that lack the
  field, and every existing LUT bake, are unchanged: the engine treats `undefined`
  and `0` identically and the §3.4 code path short-circuits before any new lookup.

### 4.2 UI wiring (`SmashSection.tsx`)

`conditionalCdf` is a continuous `[0,1]` amount, so it gets a standard inline
ENGINE slider, modeled exactly on the existing `PROPORTION` / `DISTRIBUTION` rows.
Five touch points, all already patterned in the file:

1. **State:** `const [conditionalCdf, setConditionalCdf] = useState<number>(0);`
2. **`INLINE_DEFAULTS`:** add `conditionalCdf: 0`.
3. **Persistence restore** (the `persisted?.` block ~L217): add
   ```typescript
   if (typeof persisted?.conditionalCdf === "number" &&
       Number.isFinite(persisted.conditionalCdf)) {
     setConditionalCdf(Math.max(0, Math.min(1, persisted.conditionalCdf)));
   }
   ```
4. **Persistence save + pipeline `useMemo`:** add `conditionalCdf` to the saved
   object, to `colorization: { ... }` in the `controls` object, and to **both**
   dependency arrays (the save effect's and the pipeline memo's).
5. **`resetAllInline`:** add `setConditionalCdf(INLINE_DEFAULTS.conditionalCdf);`
6. **JSX:** a `passesRowStyle` row labeled `CONDITIONAL`, `min=0 max=100 step=5`,
   `value={Math.round(conditionalCdf*100)}`, double-click resets to default, with
   a `title` tooltip summarizing the no-op-at-0 behavior. Place it directly below
   the `DISTRIBUTION` row (both are joint-structure mechanics; grouping them reads
   well). It does **not** require `clusterCount` and works on any snap pair, so it
   has no enable-gating beyond `hasSnaps`.

No `manifest.json` / recipe-format version bump beyond what the existing
`colorization` blob already covers — it serializes as one more numeric field on
the same object as `zoneEdgeShift` et al., which the addendum §8.4j confirms is
the established pattern (recipe v1.21+).

---

## 5. Composition with existing mechanics

The conditional CDF substitutes for the **global chroma/hue CDF lookups**, so it
sits at the *same pipeline position* those lookups already occupy — early, in the
"derive `(hsm, Csm)`" stage — and everything downstream is unchanged.

Pipeline order (single pass), Phase 5 insertion marked **▶**:

```
1. band curves → ACES gamut compress → smashR/G/B          (unchanged)
2. Lsm  = lumaCdf(Lin)                                      (unchanged)
▶  cdfMag = lerp(global chromaCdf(Cin),
                 conditional condChroma(Lsm,Cin), amt)      ← Phase 5
3. liftNeutrals / proportionMatch floor cdfMag → Csm        (unchanged; consumes new cdfMag)
4. hue: Hue-by-L  OR  ▶ lerp(global hueCdf, condHue, amt)   ← Phase 5 (CDF branch only)
5. paletteSnap hue override                                 (unchanged)
6. zone routing (zoneInfluence / detailRichness / edges)    (unchanged)
7. trait gates → Lout / hout / Cout → aOut / bOut           (unchanged)
8. temperature (+ sensitivity + L-bias)                      (unchanged)
9. oklabToSrgbByte                                          (unchanged)
10. distribution (soft cluster blend on RGB)                 (unchanged)
11. posterize (hard cluster snap on RGB)                     (unchanged)
```

Interactions, mechanic by mechanic:

- **Hue-by-L (§8.4f, default ON):** Hue-by-L *owns hue* whenever it's active
  (`hueByLumaActive && srcLutMag > 1e-6`). Conditional CDF therefore only touches
  hue in the **else** branch — the CDF-fallback path used when Hue-by-L is off or
  has no usable magnitude. Conditional CDF *always* governs the **chroma
  magnitude** path (`cdfMag`), and Hue-by-L only re-aims direction, so the two
  compose cleanly: with both on, hue comes from source's L→(a,b) mean direction,
  chroma magnitude comes from the L-bucket-conditional chroma CDF — arguably the
  ideal pairing (consistent color story + faithful within-L chroma spread).
- **liftNeutrals / proportionMatch (§8.4a–c):** these *consume* `cdfMag` as
  `cdfMag = condChroma-blended value`. The lift floor math is unchanged; it now
  floors a bucket-conditional magnitude instead of a global one. This is strictly
  an improvement — `liftAmount = neutralness × max(0, liftFloor − cdfMag)` and a
  more accurate per-L `cdfMag` makes the floor decision sharper. No ordering change.
- **distribution / posterize (§8.4d–e):** run at the very end on RGB, fully
  orthogonal — they snap/blend toward cluster colors regardless of how `(hsm,Csm)`
  was derived. Conditional CDF feeding a better `(hsm,Csm)` just gives them a
  better starting RGB.
- **zone routing (§8.4f/j):** runs *after* `(hsm,Csm)` and lerps toward
  `(hZone,CZone)` by `zoneInfluence`. With `zoneInfluence > 0` the zone path
  partially overrides the conditional-CDF result — expected and consistent with
  how zone routing already overrides Hue-by-L. No special-casing.
- **temperature:** final Oklab `(a,b)` shift, untouched.
- **passes (§8.4c):** each pass re-runs the whole transform, so the conditional
  CDF is consulted once per pass on the previous pass's bytes — same compounding
  behavior every other mechanic gets, no special handling.

No mechanic needs to *know* about conditional CDF; it is a drop-in replacement for
two lookups. That is the §8.5 "each toggle is a separate module" contract.

---

## 6. LUT-bakability + per-pixel cost

**Bakable: yes.** Every input to `condChroma` / `condHue` is either the pixel's own
`Cin` / `hin` / `Lsm` (all derived purely from `R,G,B`) or frozen engine state
(`out.conditionalCdf`, built at `smash()` time). No per-pixel random state, no
spatial neighborhood access — the §0 LUT contract holds. The mechanic bakes into
the 17³ preview LUT and the 33³ export LUT exactly like `chromaCdf` does today.

**Per-pixel cost** (only when `conditionalCdf > 0` — at the `0` default the §3.4
guard short-circuits and cost is zero, byte-identical to Phase 4):

- 1 fractional-bucket computation: ~3 flops.
- chroma: 2 `lookupCdfMatch` calls (one per straddling bucket) + 1 lerp. Each
  `lookupCdfMatch` is an O(1) normalize + floor + 1 interp ≈ 6 flops. Plus the
  global lookup that's already paid. **~2 extra lookups.**
- hue: same — 2 extra `lookupCdfMatch` + a circular blend.

Total: **~4 extra `lookupCdfMatch` + ~20 flops per pixel** vs. the Phase 4 path.
At the 33³ = 35 937-cell export bake that is ~0.15M extra lookups — sub-millisecond
total. Comparable to one zone-routing `clusterScan`, far cheaper than `distribution`'s
K-cluster Gaussian sum. Completely inside the existing bake budget.

---

## 7. Test plan (`conditionalCdf.test.ts` + additions to `transform.test.ts`)

New file `plugin/src/core/smash/conditionalCdf.test.ts` — `buildConditionalCdf`:

1. **Empty input** → `ConditionalCdf` with all-`null` `chroma`/`hue`, zeroed
   `sampleCounts`, `lMin/lMax` defaulted.
2. **Degenerate single-L source** (`lMax === lMin`) → all-`null` (early return).
3. **Bucket partitioning** — synthesize a source with a known L→chroma gradient
   (dark pixels chroma≈0, bright pixels chroma≈0.2); assert low buckets'
   sub-CDF maps to low chroma and high buckets' to high chroma.
4. **Sparse fallback** — a source/target where one L bucket has `< 16` samples;
   assert that bucket's `chroma[k]` / `hue[k]` is `null` while populated buckets
   are non-null.
5. **Hue chroma-filter** — a bucket of near-neutral pixels (`chroma < 0.02`)
   produces a `null` hue sub-CDF even when the chroma sub-CDF is viable.
6. **`sampleCounts`** sums to the source feature count (every source pixel lands
   in exactly one bucket).

`transform.test.ts` additions — apply-side:

7. **Identity at default** — `conditionalCdf` absent and `conditionalCdf: 0`
   both produce byte-identical output to a frozen Phase 4 reference across a
   sampling grid (the §8.4j-style regression guard — the critical no-op test).
8. **Engaged ≠ identity** — on a source with strong L-conditional color
   variation, `conditionalCdf: 1` produces output that differs from
   `conditionalCdf: 0` for at least some mid-L pixels.
9. **Monotonic blend** — output at `conditionalCdf: 0.5` lies between the `0` and
   `1` outputs per channel (the lerp is well-behaved).
10. **No banding** — sweep input L finely across a bucket boundary; assert the
    output `(a,b)` (or chroma) is continuous — successive deltas stay below a
    small epsilon, no step discontinuity at the boundary.
11. **Sparse-bucket graceful** — a snap whose extreme L buckets are sparse still
    produces finite, in-gamut output at `conditionalCdf: 1` (no NaN, no throw).
12. **Hue-by-L precedence** — with `hueByLuma: true`, hue output is unchanged by
    `conditionalCdf` (conditional CDF only touches the chroma path + the
    fallback hue branch); with `hueByLuma: false`, hue *does* respond.
13. **Degenerate snap** — `conditionalCdf: null` on the engine output → identity,
    no throw.

A `buildSmashCdfs` test should also assert the new `conditionalCdf` field is
populated (non-null) for a normal feature pair and `null` for empty input.

---

## 8. Open questions + recommended resolutions

**Q1 — Bucket key: `Lsm` or `Lin`?**
*Resolution: `Lsm`.* The buckets are built over the *source's* L range; `lumaCdf`
maps a target pixel into source-L space; `Lsm` is therefore "where this pixel lives
among the source buckets." Posterize/zone routing key on `Lin` because the user
reasons about *target* bands there — different construct, different key. Documented
in §3.2.

**Q2 — Bucket count: fixed 12, or tied to `clusterCount` / a slider?**
*Resolution: fixed `L_BUCKETS = 12`.* It is an *internal resolution* parameter, not
a creative knob — the user already has `clusterCount` (3–32) for explicit zone
granularity. Exposing a second count slider would be confusing and invites sparse
buckets. 12 balances within-L resolution against per-bucket sample count. If a
future need arises, promoting it to a constant-driven slider is a one-line change;
defer.

**Q3 — Equal-width L buckets vs. equal-population (percentile) buckets?**
*Resolution: equal-width* for v0. Equal-population buckets would guarantee no
sparse buckets but make the apply-time `Lsm → bucket` map nonlinear (need a stored
percentile LUT) and complicate the interpolation. Equal-width keeps the apply path
a trivial linear map and matches `HueByLumaLut`'s existing convention. The sparse
fallback already handles thin extreme buckets cleanly. Revisit only if real sources
show too many sparse buckets in practice.

**Q4 — Should conditional CDF *replace* Hue-by-L for the hue dimension?**
*Resolution: no — compose, don't replace.* Hue-by-L gives a smooth, averaged color
story (great default); conditional-CDF hue preserves within-L hue spread but is
noisier on grayscale targets. Keep Hue-by-L owning hue when active, let conditional
CDF own the chroma magnitude unconditionally and the hue *fallback* branch. Users
who want full bucket-conditional hue can turn Hue-by-L off — the existing toggle
already exposes that. (Mirrors §8.4f's open question about Hue-by-L vs. zone
routing: defer removal, let mechanics coexist.)

**Q5 — Sub-CDF bin count: 64 vs. 256?**
*Resolution: 64.* Each bucket holds ~1/12 of the samples a global CDF sees, so 256
bins would over-resolve the noise. 64 halves memory and is plenty for a
within-bucket chroma/hue distribution. Global CDFs stay at 256.

**Q6 — Should the chroma sub-CDF feed `liftNeutrals`' `srcLutMag` per-L floor too?**
*Resolution: no, out of scope for Phase 5.* `liftFloor` already gets per-L behavior
from `hueByLumaLut`'s magnitude (`proportionMatch`). Routing it through the
conditional CDF as well would entangle two mechanics. Phase 5 ships the chroma/hue
*matching* path only; the lift floor stays as-is and simply consumes the improved
`cdfMag`. Note as possible Phase 5.x follow-up.

**Q7 — Interaction with `passes > 1`?**
*Resolution: none needed.* Each pass re-derives `Lsm`/`Cin`/`hin` from the previous
pass's bytes and re-consults the frozen `conditionalCdf` — identical to how every
other mechanic compounds across passes. No per-pass state.
