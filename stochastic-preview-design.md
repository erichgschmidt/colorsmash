# Phase 7 — Stochastic per-L-band sampling (preview-only mode)

**Status:** design. DESIGN-ONLY — no source touched.
**Roadmap slot:** Masterplan v1.1 addendum §8.5, "Stochastic per-L-band sampling" (Toggle 2). Successor to §8.5a (`conditionalCdf`, Phase 5) and §8.6 (source ratios, Phase 6).

---

## 1. Problem

Conditional CDF (§8.5a) recovered *within-L chroma/hue spread* — a target pixel's chroma + hue are rank-mapped against the source pixels that share its smashed L band. But CDF matching is still a **deterministic monotone map**: every target pixel landing at the same `(Lsm, Cin, hin)` produces *exactly* the same output. A flat region of the target — a clear sky, a wall, a gradient ramp — gets recolored to a perfectly flat region of output color. The source's natural *grain* (the per-pixel scatter that makes a real photo's mid-tones half-warm/half-cool rather than uniformly purple) is averaged away by the rank map.

The user explicitly asked for noise/variety preservation ("more painterly", §8.5 #262). Stochastic sampling restores it: instead of mapping a target pixel to the CDF's deterministic rank position, **draw a random sample from the matching source L-band's actual color distribution**. Two adjacent target pixels at the same `(Lsm, Cin)` now land on two *different* real source colors, reproducing the source's within-band scatter.

### The catch — not LUT-bakable

A 3D LUT is a pure function `f(R,G,B)→(R',G',B')`: identical RGB in → identical RGB out, by construction. Stochastic sampling deliberately breaks that — *same input → different output* — so it **cannot be baked into a `.cube`**. It requires per-pixel state (the RNG draw). This design treats that honestly: stochastic is a **panel-preview-only mode** the user **rasterizes** (applies directly to pixels via the existing `bakeTargetPerPixel` path) rather than baking to a LUT. The seeded-hash variant in §6 makes the per-pixel state *deterministic and spatially stable* without making it RGB-pure — it is still not LUT-bakable, but it is reproducible and flicker-free.

---

## 2. Scope & non-goals

In scope:
- A new per-L-bucket *empirical sample reservoir* built alongside `ConditionalCdf` in `buildConditionalCdf` / `buildSmashCdfs`.
- A per-pixel sampling step inside a **new** transform entry point (not `applyTransformOnePass`, which must stay LUT-pure).
- A `ColorizationOptions.stochastic` control block.
- UI: a mode chip in `SmashSection`, disabled `.cube` export with clear messaging, and an Apply path that rasterizes instead of installing a Color Lookup layer.

Non-goals:
- Changing `applyTransformOnePass`, `applyTransform`, `bakeSmashLut`, or `serializeSmashCube`. The LUT path stays byte-identical — stochastic is strictly additive.
- Spatial/neighborhood-aware sampling (blue-noise dithering, error diffusion). Forward work; §11.
- Sliced OT (Toggle 4 / Phase 8) — separate roadmap item.

---

## 3. Data structure

### 3.1 Per-bucket sample reservoir

`ConditionalCdf` already slices the source into `L_BUCKETS = 12` equal-width L buckets. Stochastic sampling reuses the *same* bucketing, but instead of (or in addition to) a 64-bin sub-CDF it needs the bucket's **raw `(a,b)` samples** to draw from. We store a fixed-size **reservoir** per bucket — a flat `Float32Array` of `(a,b)` pairs, capped so memory stays bounded regardless of feature count.

```typescript
// New module: core/smash/stochasticBands.ts

/** Max (a,b) samples retained per L bucket. 256 pairs = 2 KB/bucket;
 *  12 buckets ≈ 24 KB total. Large enough that re-draws look varied,
 *  small enough to keep the engine snapshot light. Buckets with fewer
 *  source pixels store all of them; larger buckets are reservoir-sampled
 *  down to this cap (uniform, unbiased — see fillReservoir). */
export const BAND_RESERVOIR_CAP = 256;

/** Empirical (a,b) sample reservoir for one image, sliced by L bucket.
 *  Built once per snap change next to ConditionalCdf; frozen engine state. */
export interface StochasticBands {
  /** === L_BUCKETS. Stored for forward-compat. */
  readonly buckets: number;
  /** Source L range the buckets span (mirrors ConditionalCdf.lMin/lMax
   *  so the same Lsm→bucket routing math applies). */
  readonly lMin: number;
  readonly lMax: number;
  /** Per-bucket flat (a,b) pairs: samples[k] has length 2*count[k].
   *  Pair j is (samples[k][2j], samples[k][2j+1]). Empty when sparse. */
  readonly samples: readonly Float32Array[];
  /** Per-bucket retained sample count (samples[k].length / 2). */
  readonly counts: Int32Array;
}
```

Why `(a,b)` and not `(L,a,b)` or full RGB: the stochastic mechanic substitutes for the **chroma magnitude + hue direction** half of the transform — exactly the slot `conditionalCdf` occupies (§8.5a "Composition"). `L` is owned unconditionally by `lumaCdf` and must stay deterministic so tonal structure is stable. Storing `(a,b)` lets the sampled color drop straight into the existing `aOut`/`bOut` reconstruction. (`C` and `h` are derived from the drawn `(a,b)`.)

### 3.2 Builder

```typescript
import type { PixelFeatures } from './types';
import { L_BUCKETS } from './conditionalCdf';

export function buildStochasticBands(
  sourceFeatures: PixelFeatures[],
  rngSeed = 0x9e3779b9, // build-time RNG: deterministic reservoir fill
): StochasticBands {
  if (sourceFeatures.length === 0) return emptyStochasticBands();

  let lMin = sourceFeatures[0].luma, lMax = lMin;
  for (let i = 1; i < sourceFeatures.length; i++) {
    const l = sourceFeatures[i].luma;
    if (l < lMin) lMin = l; if (l > lMax) lMax = l;
  }
  const lRange = lMax - lMin;
  if (lRange <= 0) return emptyStochasticBands();

  const bucketOf = (l: number) =>
    Math.min(L_BUCKETS - 1, Math.max(0,
      Math.floor(((l - lMin) / lRange) * L_BUCKETS)));

  // Reservoir-sample (a,b) pairs into each bucket — Algorithm R, so a
  // bucket with 50k source pixels keeps an unbiased uniform 256-pair
  // subsample. Deterministic given rngSeed → identical engine snapshot.
  const reservoirs: number[][] = Array.from({ length: L_BUCKETS }, () => []);
  const seen = new Int32Array(L_BUCKETS);
  const rng = mulberry32(rngSeed);
  for (const f of sourceFeatures) {
    const k = bucketOf(f.luma);
    const n = seen[k]++;
    const a = f.oklab[1], b = f.oklab[2];
    if (n < BAND_RESERVOIR_CAP) {
      reservoirs[k].push(a, b);
    } else {
      const j = Math.floor(rng() * (n + 1));
      if (j < BAND_RESERVOIR_CAP) { reservoirs[k][2 * j] = a; reservoirs[k][2 * j + 1] = b; }
    }
  }
  const samples = reservoirs.map(r => Float32Array.from(r));
  const counts = Int32Array.from(samples.map(s => s.length / 2));
  return { buckets: L_BUCKETS, lMin, lMax, samples, counts };
}
```

`buildStochasticBands` is called once inside `buildSmashCdfs`, cached on `SmashCdfs.stochasticBands` and copied onto `SmashEngineOutput.stochasticBands`, exactly as `conditionalCdf` is. Cost: one extra O(N) pass + 12 `Float32Array` allocations — negligible next to the existing CDF builds. Memory: ~24 KB on the snapshot.

> **Build-time RNG ≠ apply-time RNG.** The reservoir fill is seeded so the *engine snapshot* is reproducible (good for tests, presets). The per-pixel draws in §4 are a separate RNG.

---

## 4. Per-pixel sampling algorithm

### 4.1 Where it runs — a new transform entry point

`applyTransformOnePass` **must not change** — it is the function `bakeSmashLut` samples, and the LUT path's byte-stability is a hard invariant (§8.5a, §8.6 both stress this). Stochastic sampling lives in a **new sibling** function:

```typescript
// core/smash/transform.ts — new export, NOT called by bakeSmashLut.

/** Stochastic single-pass transform. Identical to applyTransformOnePass
 *  EXCEPT the chroma/hue half is drawn from a random source sample in the
 *  pixel's L bucket instead of the deterministic CDF rank-map. Requires a
 *  per-pixel RNG draw `u ∈ [0,1)` supplied by the caller — that is the
 *  per-pixel state a LUT cannot carry, which is why this path is preview-only.
 *
 *  When stochastic is disabled, or stochasticBands is null/sparse for the
 *  pixel's bucket, this falls back to the exact applyTransformOnePass result —
 *  so the stochastic preview degrades smoothly to the deterministic preview. */
export function applyTransformStochasticOnePass(
  out: SmashEngineOutput,
  r: number, g: number, b: number,
  u: number,        // per-pixel uniform random in [0,1)
): Vec3 { /* see §4.3 */ }
```

The multi-pass wrapper gets a stochastic twin too, `applyTransformStochastic(out, r, g, b, rng)`, mirroring `applyTransform`'s `passes` loop but threading a fresh `u = rng()` per pass per pixel.

### 4.2 The draw

The deterministic path computes (transform.ts ~L1180–1214):
- `cdfMag` — chroma magnitude from the chroma CDF (optionally conditional-blended);
- `hsm` — hue from Hue-by-L or the hue CDF.

The stochastic path *replaces those two* with a sample from the L bucket:

1. Route the pixel by its **smashed L** `Lsm` into a fractional bucket coordinate `t ∈ [0, buckets-1]`, exactly as `condChromaLookup` does — `k0 = floor(t)`, `k1 = k0+1`, `frac = t-k0`.
2. Pick **one** of the two straddling buckets: `kPick = (u2 < frac) ? k1 : k0`, where `u2` is a second decorrelated uniform (cheap: `u2 = (u * 1.6180339 + 0.5) % 1`). This is *stochastic interpolation* — it gives the same expected bucket mix as linear blending but never averages two colors into a muddy mean (which is the whole point of going stochastic).
3. If `kPick`'s reservoir is empty (sparse bucket), **fall back** to the deterministic `cdfMag`/`hsm` for this pixel.
4. Otherwise draw pair index `j = floor(u * count[kPick])`, read `(aSample, bSample)`.
5. Derive `Csample = hypot(aSample,bSample)`, `hSample = atan2(bSample,aSample)`.
6. Feed `Csample`/`hSample` into the existing pipeline in place of `cdfMag`/`hsm` — i.e. `cdfMag := Csample`, the Hue-by-L/`hsm` block is bypassed and `hsm := hSample`.

Everything downstream is unchanged: `liftNeutrals`/`proportionMatch` still floor the magnitude, the trait gates (`chromaGate`, `hueGate`) still lerp `Cin→Csm` and `hin→hsm`, temperature/distribution/posterize still run. Stochastic only changes *which* `(Csm, hsm)` target the gates aim at.

### 4.3 Reference implementation

```typescript
// Inside applyTransformStochasticOnePass — replaces the cdfMag / hsm
// computation block of applyTransformOnePass. All other code (band blend,
// gamut, Lsm, gates, temperature, distribution, posterize) is shared verbatim
// — factor the common body into a helper so the two paths can't drift.

function sampleBandColor(
  sb: StochasticBands, Lsm: number, u: number,
): { a: number; b: number } | null {
  if (sb.lMax <= sb.lMin || sb.buckets < 2) return null;
  const clampedL = Math.max(sb.lMin, Math.min(sb.lMax, Lsm));
  const t = ((clampedL - sb.lMin) / (sb.lMax - sb.lMin)) * (sb.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, sb.buckets - 1);
  const frac = t - k0;
  // Decorrelated second uniform for the bucket pick (stochastic interp).
  const u2 = (u * 1.6180339887 + 0.5) % 1;
  let k = u2 < frac ? k1 : k0;
  if (sb.counts[k] === 0) k = k === k1 ? k0 : k1;   // try the sibling bucket
  if (sb.counts[k] === 0) return null;              // both sparse → caller falls back
  const j = Math.min(sb.counts[k] - 1, Math.floor(u * sb.counts[k]));
  const arr = sb.samples[k];
  return { a: arr[2 * j], b: arr[2 * j + 1] };
}

// ... in the transform body, where the deterministic path sets cdfMag / hsm:
const drawn = (stochasticActive && out.stochasticBands)
  ? sampleBandColor(out.stochasticBands, Lsm, u)
  : null;

let cdfMag: number;
let hsm: number;
if (drawn) {
  cdfMag = Math.hypot(drawn.a, drawn.b);
  hsm    = Math.atan2(drawn.b, drawn.a);   // bypasses Hue-by-L for this pixel
} else {
  // ── exact deterministic block from applyTransformOnePass ──
  cdfMag = /* global / conditional chroma CDF result */;
  hsm    = /* Hue-by-L or hue CDF result */;
}
```

### 4.4 Strength control — `amount`

Pure stochastic (100%) can be too noisy. The control (§7) is an `amount ∈ [0,1]` that **blends the drawn target toward the deterministic target** *before* the gates:

```typescript
const sa = stochasticAmount; // 0..1
const cdfMagDet = /* deterministic cdfMag */;
const hsmDet    = /* deterministic hsm */;
if (drawn) {
  cdfMag = cdfMagDet + (Math.hypot(drawn.a, drawn.b) - cdfMagDet) * sa;
  let dh = Math.atan2(drawn.b, drawn.a) - hsmDet;     // shortest-arc
  if (dh >  Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  hsm = hsmDet + dh * sa;
}
```

At `amount = 0` the result is byte-identical to the deterministic preview (so the toggle is a strict no-op at default — same discipline as every other mechanic). At `1.0` the pixel takes the raw drawn sample. This means the deterministic block must be computed regardless — a few extra `lookupCdfMatch` per pixel, fine for the preview path.

---

## 5. How the three paths diverge

| Path | Entry point | Per-pixel state | Stochastic? | Export artifact |
|---|---|---|---|---|
| **LUT preview** (live panel) | `bakeSmashLut` → `applyTransform` | none | no | drives `useLayerPreview` Color Lookup layer |
| **Test Bake** (diagnostic) | `bakeTargetPerPixel` → `applyTransform` | none | no | per-pixel ground truth, no LUT quantization |
| **Stochastic preview** *(new)* | `bakeTargetStochastic` → `applyTransformStochastic` | RNG draw per pixel/pass | **yes** | rasterized pixels only — **no `.cube`** |

The new bake driver mirrors `bakeTargetPerPixel` (lut.ts L91) but threads the RNG:

```typescript
// core/smash/lut.ts — new sibling of bakeTargetPerPixel.

/** Per-pixel stochastic bake. Like bakeTargetPerPixel but each opaque pixel
 *  gets a fresh random draw, so the output carries the source's within-L
 *  grain. NOT a LUT — there is no f(R,G,B) to serialize. `seed` makes a run
 *  reproducible; the hashed variant (§6) makes it spatially stable too. */
export function bakeTargetStochastic(
  engine: SmashEngineOutput,
  rgba: Uint8Array, width: number, height: number,
  seed = 0xC01015,
): Uint8Array {
  const total = width * height;
  const out = new Uint8Array(total * 4);
  const useHash = engine.controls.colorization?.stochastic?.seeded !== false;
  const rng = mulberry32(seed); // sequential mode
  for (let i = 0; i < total; i++) {
    const o = i * 4, a = rgba[o + 3];
    if (a < 128) { out[o]=rgba[o]; out[o+1]=rgba[o+1]; out[o+2]=rgba[o+2]; out[o+3]=a; continue; }
    const x = i % width, y = (i / width) | 0;
    // §6 — hashed mode: u derived from pixel coords → stable across re-renders.
    const u = useHash ? hash2u(x, y, seed) : rng();
    const [r, g, b] = applyTransformStochastic(engine, rgba[o], rgba[o+1], rgba[o+2], u);
    out[o]=r; out[o+1]=g; out[o+2]=b; out[o+3]=a;
  }
  return out;
}
```

### Live panel preview while stochastic is on

The live panel preview (`onEngineChange` → LUT path) **cannot** show stochastic output — there is no LUT. Two options; **recommendation: option B**.

- **Option A** — leave the live preview on the deterministic LUT; the user clicks a button to see the stochastic render. Cheap, but the preview lies about what Apply will do.
- **Option B (recommended)** — when stochastic mode is on, the panel preview is driven by `bakeTargetStochastic` into the panel tile via the **existing `onTestBake(pixels, w, h)` callback channel** (SmashSection L64, already wired to render raw pixels in the matched-preview tile). The parent already restores the LUT preview on the next engine change; we make stochastic re-render on engine change instead of reverting. Cost: a 256² stochastic bake is ~50–80 ms (one `applyTransformStochastic` per pixel, same order as `bakeTargetPerPixel`) — fine for a debounced post-drag re-render, not for every drag frame. Debounce ~120 ms after the last control change, exactly like a snap recompute.

This keeps WYSIWYG: what the panel shows *is* what Apply rasterizes.

### Apply

`applySmashLut` (app/smash/applySmashLut.ts) installs a Color Lookup adjustment layer from a baked `.cube`. Stochastic has no `.cube`, so a **new** apply path is needed:

```typescript
// New: app/smash/applySmashStochastic.ts
// Renders bakeTargetStochastic at FULL document resolution and writes the
// pixels into a new raster layer (executeAsModal + putPixels / a pixel-layer
// batchPlay descriptor). Distinct from applySmashLut: this is destructive-to-
// a-new-layer rasterization, not a non-destructive adjustment layer.
export async function applySmashStochastic(
  engine: SmashEngineOutput,
  fullResRgba: Uint8Array, width: number, height: number,
): Promise<ApplySmashLutResult> { /* executeAsModal, create pixel layer, putPixels */ }
```

Key UX consequence: stochastic Apply is **resolution-dependent and one-shot**. Unlike a Color Lookup layer (re-renders live, adjustable), the stochastic layer is *baked pixels* — re-applying re-rolls the grain. The layer should be named `Smash Stochastic` (vs `Smash LUT`) so the user can tell them apart, and the in-place-replace logic (`replaceLayerId`) still applies so repeated Apply clicks don't spam the panel.

> Full-res stochastic bake of a 24 MP image is ~24M `applyTransformStochastic` calls ≈ 2–5 s. Acceptable for an explicit Apply click inside `executeAsModal` with a progress status; not acceptable on a slider drag (hence the debounced 256² preview).

---

## 6. Seeded-hash determinism — **recommended: yes, default on**

A naive sequential RNG (`rng()` per pixel in scan order) has two problems:
1. **Temporal flicker** — every re-render (slider drag, snap change) re-rolls *every* pixel, so a flat region shimmers as the user tweaks unrelated controls. Visually alarming and makes A/B comparison impossible.
2. **Non-reproducibility** — a preset can't recreate the exact look; Apply at a different resolution produces unrelated grain.

**Fix: derive the per-pixel uniform from a hash of the pixel's `(x, y)` coordinates** (plus a user-visible seed), not from a stream:

```typescript
// core/smash/stochasticBands.ts

/** 32-bit integer hash of (x, y, seed) → uniform [0,1). Spatially stable:
 *  the same pixel always draws the same sample for a given seed, so the
 *  grain is frozen in place across re-renders. Changing `seed` re-rolls the
 *  whole field (a "re-shuffle grain" button). */
export function hash2u(x: number, y: number, seed: number): number {
  let h = (x | 0) * 0x1f1f1f1f ^ (y | 0) * 0x8da6b343 ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
```

Properties:
- **Spatially stable** — flat target regions get a *fixed, frozen* grain pattern. Tweaking a slider re-renders but the grain stays put; only the pixels whose `(Lsm,Cin)` actually changed move. No shimmer.
- **Reproducible** — `(seed)` is the only state; persist it in the preset and the look recreates exactly. Resolution-independence is *partial*: `(x,y)` hashing means a downscaled preview and full-res Apply sample different coordinate grids, so grain *scale* differs (preview grain looks coarser). Acceptable — and far better than fully unrelated noise. If exact preview↔Apply parity is wanted, hash *normalized* `(x/width, y/height)` quantized to a fixed grid; deferred (§10 OQ-3).
- **Honest about LUT-bakability** — this is the critical point the brief asks for. Hashing makes the output *deterministic per pixel*, but it is **still a function of `(x, y)`, not of `(R,G,B)`**. Two pixels with identical RGB at different coordinates still produce different output. A 3D LUT is indexed by RGB only — it has nowhere to put `(x,y)`. **So the hashed scheme is still NOT LUT-bakable.** It buys reproducibility and stability, not bakability. The `.cube` export stays disabled in stochastic mode regardless.

Recommendation: **ship the hashed scheme as the default** (`seeded: true`), expose the integer seed plus a "re-shuffle grain" button, and keep the sequential RNG only as an internal fallback / non-default `seeded: false` for users who explicitly want every render to re-roll (rare; probably drop it before ship — §10 OQ-2).

---

## 7. Control field on `ColorizationOptions`

The `types.ts` placeholder comment (L429) reserves `stochasticPerL?: boolean`. A boolean is too thin — we need amount + seed + mode. Replace it with a struct, consistent with `AxisRatio`'s precedent (§8.6):

```typescript
// types.ts — replaces the reserved `readonly stochasticPerL?: boolean;` line.

/** Phase 7 — Stochastic per-L-band sampling. PREVIEW-ONLY: when active the
 *  transform draws a random source sample per pixel, which breaks the
 *  f(R,G,B) purity a 3D LUT requires. The engine still bakes a LUT for the
 *  deterministic mechanics; `.cube` export and the Color Lookup Apply are
 *  disabled while `amount > 0` (see SmashSection). Absent / `amount: 0` is a
 *  strict no-op — the deterministic LUT path is byte-identical to Phase 6. */
export interface StochasticOptions {
  /** Blend toward the random draw. 0 = deterministic (CDF rank-map, the
   *  default, LUT-bakable). 1 = raw per-pixel source sample. Intermediate
   *  lerps the drawn (C,h) target toward the deterministic target before
   *  the trait gates — see §4.4. */
  readonly amount: number;
  /** When true (default) the per-pixel uniform is hash(x,y,seed) — spatially
   *  stable, reproducible grain. When false, a sequential RNG re-rolls every
   *  render (flickers; debug only). */
  readonly seeded?: boolean;
  /** Integer seed for the hashed scheme. Changing it re-shuffles the grain
   *  field. Persisted in the preset so a look recreates exactly. */
  readonly seed?: number;
}

export interface ColorizationOptions {
  // ... existing fields ...
  /** Phase 7 — see StochasticOptions. Preview-only; not LUT-bakable. */
  readonly stochastic?: StochasticOptions;
  // Future toggles:
  //   readonly slicedOt?: number;   // Phase 8
}
```

`DEFAULT_SMASH_CONTROLS.colorization` gains `stochastic: { amount: 0, seeded: true, seed: 0xC01015 }`. Because `amount` defaults to 0, **existing presets, LUT bakes, and `.cube` exports are byte-identical** — the engine never enters the stochastic branch until the user opts in. Persistence: `SmashSection` already round-trips `colorization` into `color-smash-smash.json`; the new sub-struct rides along with no extra wiring beyond the load-guard at L315.

---

## 8. Composition with existing mechanics

Stochastic sits at the **same pipeline position as `conditionalCdf`** — it substitutes for the chroma-magnitude + hue-direction lookups, nothing else.

- **`conditionalCdf`** — mutually redundant on the same axis. When `stochastic.amount > 0`, the stochastic draw *replaces* the conditional/global chroma+hue result (the draw IS a within-L sample, which is what conditional CDF approximates deterministically). Recommendation: when stochastic is engaged, the deterministic baseline it blends toward (§4.4) is still the conditional-CDF result if `conditionalCdf > 0` — so the two stack gracefully (`amount` 0→1 slides conditional-deterministic → stochastic). No special-casing needed; the `cdfMagDet`/`hsmDet` in §4.4 already honor `conditionalCdf`.
- **`hueByLuma`** — when a stochastic sample is drawn, it carries its own hue, so Hue-by-L is **bypassed for that pixel** (the draw's `atan2` wins). At `amount < 1` the §4.4 blend lerps between the Hue-by-L `hsmDet` and the drawn hue — smooth. When `seeded` and a flat region all draws from the same bucket, you still get variety because each pixel's hash picks a *different* sample.
- **`liftNeutrals` / `proportionMatch`** — unchanged; they floor `cdfMag` *after* the draw. A near-neutral target pixel that draws a low-chroma source sample still gets lifted to the per-L floor. Good — stochastic shouldn't defeat neutral protection.
- **Trait gates (`chromaGate`, `hueGate`, `global`, `neutral`, `accent`)** — unchanged; they lerp `Cin→Csm` / `hin→hsm` where `Csm`/`hsm` are now the (possibly drawn) values. Turning `traits.chroma` down still pulls the drawn color back toward the input.
- **`distribution` / `posterize` / zone routing** — run downstream in RGB/Oklab space, fully orthogonal. A user can stochastically sample *then* posterize — grainy input snapped to clusters. Reasonable.
- **`passes`** — `applyTransformStochastic` threads a fresh `u` per pass (decorrelate with `hash2u(x,y,seed+pass)`), so a 2× stochastic pass compounds *different* grain each pass rather than amplifying one draw. Matches the compounding intent of `passes`.
- **`temperature` and source ratios** — orthogonal; temperature acts on `aOut/bOut` post-reconstruction, source ratios reshape the CDFs `cdfMagDet` reads from. Both compose for free.

---

## 9. UI / UX

### 9.1 Mode communication

Stochastic is not just another slider — it changes what Apply/Export *can do*. Surface it as a distinct **ENGINE STOCHASTIC** slider directly below **CONDITIONAL** (its sibling on the same axis), `0–100%`, double-click-resets to 0, matching every other engine slider in `SmashSection`.

When `stochastic.amount > 0`, the section enters **"preview-only mode"**, signalled by:
- A small inline badge next to the slider: `PREVIEW ONLY — can't export .cube`.
- The grain controls become visible below the slider: a numeric **Seed** field and a **Re-shuffle grain** button (bumps the seed).

### 9.2 Export `.cube` — disabled with explanation

`onExportCube` (SmashSection L677) must guard:

```typescript
const stochasticOn = (colorization.stochastic?.amount ?? 0) > 0;
// ...
<button
  onClick={onExportCube}
  disabled={stochasticOn}
  title={stochasticOn
    ? "Export disabled: Stochastic mode draws a random sample per pixel, so "
      + "there is no fixed f(R,G,B) to bake into a .cube. Set STOCHASTIC to 0 "
      + "to re-enable .cube export, or use Apply to rasterize the stochastic "
      + "result onto a new layer."
    : "Bake the current Smash transform to a portable .cube LUT."}
>
  Export .cube
</button>
```

If the user somehow reaches `onExportCube` with stochastic on (keyboard), it early-returns with `setExportStatus("Export .cube unavailable in Stochastic mode — use Apply to rasterize.")`.

### 9.3 Apply — splits by mode

`onApply` branches on `stochasticOn`:
- **Off** → current `applySmashLut` (Color Lookup adjustment layer). Unchanged.
- **On** → `applySmashStochastic` (§5): full-res `bakeTargetStochastic` rasterized to a new `Smash Stochastic` pixel layer. Status text: `applying… (rasterizing — this can't be a live LUT layer)` then `Smash Stochastic layer added`.

The `[+]` fork button works for both. The Apply button's tooltip updates in stochastic mode: *"Stochastic mode rasterizes the grainy result onto a new pixel layer — it is baked, not a live adjustment. Re-applying re-rolls the grain (change Seed to control it)."*

### 9.4 Test Bake

`Test Bake` stays deterministic (it is explicitly the LUT-vs-engine fidelity diagnostic). Optionally rename the live-preview behavior so that, in stochastic mode, the panel preview *is* the stochastic render (§5 option B) and `Test Bake` still shows the deterministic ground truth — giving the user a built-in A/B of "with grain" vs "without".

---

## 10. Test plan

Pure-function core (`core/smash/stochasticBands.ts`, `transform.ts`) is unit-testable; only the PS layer write needs manual QA.

**`buildStochasticBands`**
1. Empty source → `emptyStochasticBands` (all counts 0).
2. Single-L source (`lRange = 0`) → empty (degenerate guard).
3. Source with `< BAND_RESERVOIR_CAP` pixels in a bucket → that bucket retains *all* of them, `counts[k]` exact.
4. Source with `> CAP` pixels in a bucket → `counts[k] === CAP`; reservoir is an unbiased subsample (statistical test: bucket mean `(a,b)` of the reservoir within tolerance of the full-bucket mean).
5. Determinism: same features + same `rngSeed` → byte-identical `samples` arrays.

**`sampleBandColor` / `applyTransformStochasticOnePass`**
6. `stochastic.amount = 0` → output **byte-identical** to `applyTransformOnePass` for a grid of RGB inputs (the no-op invariant — critical).
7. `stochasticBands = null` (degenerate snap) → falls back to deterministic for all pixels.
8. Sparse bucket (both `k0`,`k1` empty) → `sampleBandColor` returns `null`, pixel falls back deterministically.
9. `amount = 1`, dense bucket → output `(C,h)` equals a *real* source sample's `(C,h)` from the routed bucket (membership test against the reservoir).
10. Variety: two inputs with identical `(R,G,B)` but different `u` → different output (the defining property). Conversely identical `(R,G,B,u)` → identical output (determinism given `u`).
11. `amount` monotonicity: output `(C,h)` for fixed `u` moves continuously from deterministic (`amount=0`) to drawn (`amount=1`).

**`hash2u`**
12. Same `(x,y,seed)` → identical `u`. Different `seed` → decorrelated field (correlation near 0 over a 256² grid).
13. Uniformity: `u` over a 256² grid is approximately uniform on `[0,1)` (chi-square bucketed test).

**`bakeTargetStochastic`**
14. Hashed mode: two runs with the same `seed` → identical output buffer (spatial stability / reproducibility).
15. Hashed mode: re-render after a *no-op* engine change → flat regions unchanged (no shimmer) — compare buffers, expect equality on pixels whose `(Lsm,Cin)` didn't move.
16. Transparent pixels (`a < 128`) passed through unchanged.
17. Sequential mode (`seeded:false`): two runs differ (re-roll), but the histogram of outputs is stable.

**Composition**
18. `stochastic.amount=0` with every other mechanic at non-default → byte-identical to current engine (regression guard for the whole preset corpus).
19. `posterize=1` + `stochastic=1` → output snaps to a finite cluster set (posterize still dominates downstream).

**Manual / PS**
20. `applySmashStochastic` creates a `Smash Stochastic` raster layer; `[+]` fork hides priors; in-place replace works.
21. `.cube` export button is disabled and tooltipped when `amount > 0`; re-enables at 0.
22. Visual: a grayscale target + a grainy film source — stochastic preview shows restored grain vs the flat deterministic preview.

---

## 11. Open questions & recommended resolutions

**OQ-1 — Reservoir cap of 256.** Too few → visible repetition in large flat regions (only 256 distinct colors per bucket tile across thousands of pixels). Too many → snapshot bloat.
*Recommendation:* ship `BAND_RESERVOIR_CAP = 256` (24 KB total). Repetition is masked by the hashed spatial scramble + the `lift`/gate/temperature post-processing that perturbs each pixel further. Revisit to 1024 only if QA on large flat skies shows banding; make it an internal constant, not a knob.

**OQ-2 — Keep the sequential (non-hashed) RNG mode?** It only exists as a fallback and it flickers.
*Recommendation:* **drop `seeded: false` before ship.** Always hash. Removes a confusing knob and a flicker footgun. Keep the `seeded` field in the type as reserved-for-future (e.g. animation, where per-frame re-roll is wanted) but don't expose it in the UI for v1.

**OQ-3 — Preview↔Apply grain-scale mismatch.** `hash2u(x,y)` on a 256² preview vs a 24 MP Apply samples different coordinate grids → preview grain looks coarser than the applied result.
*Recommendation:* accept the mismatch for v1 and document it in the Apply tooltip ("final grain is finer than the preview"). If it bothers users, switch to hashing a fixed-resolution normalized grid (`floor(x/width * GRID)`, `floor(y/height * GRID)` with `GRID ≈ 2048`) so preview and Apply sample the *same* logical grain field — deferred as a polish item.

**OQ-4 — Should the live panel preview auto-show stochastic (§5 option B) or require a button?**
*Recommendation:* **option B, debounced ~120 ms.** WYSIWYG matters more than the ~60 ms re-render cost; the debounce already matches the snap-recompute cadence so it won't feel laggy. Reuse the existing `onTestBake` pixel channel — no new plumbing.

**OQ-5 — Draw `(a,b)` only, or full `(L,a,b)`?** Drawing `L` too would give even more variety.
*Recommendation:* `(a,b)` only. `L` is owned by `lumaCdf` and tonal stability is non-negotiable — a stochastic `L` would make flat regions *jitter in brightness*, which reads as noise/damage, not grain. Chroma/hue scatter reads as natural film grain; luminance scatter does not.

**OQ-6 — Interaction with `conditionalCdf` in the UI.** Two sliders on the same axis could confuse.
*Recommendation:* keep both, place `STOCHASTIC` directly under `CONDITIONAL`, and add a one-line section caption: *"CONDITIONAL recovers within-tone color spread deterministically; STOCHASTIC restores per-pixel grain (preview-only)."* They genuinely do different things (deterministic spread vs random grain) and compose (§8); no need to make them mutually exclusive.

---

## 12. File-touch summary (for implementation, not this task)

| File | Change |
|---|---|
| `core/smash/stochasticBands.ts` | **new** — `StochasticBands`, `BAND_RESERVOIR_CAP`, `buildStochasticBands`, `hash2u`, `mulberry32`, `emptyStochasticBands` |
| `core/smash/transform.ts` | add `stochasticBands` to `SmashCdfs` + `SmashEngineOutput`; call `buildStochasticBands` in `buildSmashCdfs`; new exports `applyTransformStochasticOnePass`, `applyTransformStochastic`; factor shared body out of `applyTransformOnePass` (no behavior change) |
| `core/smash/lut.ts` | **new** export `bakeTargetStochastic` (sibling of `bakeTargetPerPixel`) |
| `core/smash/types.ts` | replace reserved `stochasticPerL?` with `StochasticOptions` + `colorization.stochastic`; add to `DEFAULT_SMASH_CONTROLS` |
| `app/smash/applySmashStochastic.ts` | **new** — rasterize full-res stochastic bake to a pixel layer |
| `ui/smash/SmashSection.tsx` | STOCHASTIC slider + seed/re-shuffle controls; guard `onExportCube`; branch `onApply`; option-B live preview via `onTestBake` channel; persist `stochastic` |
| `ColorSmash_Masterplan_v1.1_addendum.md` | new §8.7 entry once shipped |
```
