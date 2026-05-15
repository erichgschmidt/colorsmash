# ColorSmash Masterplan v1.1 — Addendum

Last updated: 2026-05-13
Applies to: `ColorSmash_Masterplan_v1.md`
Branch context: `feature/smash`, Phase 1 in progress

---

## 1. Purpose

This addendum captures a UI architecture decision made during Phase 1 implementation and testing. It supersedes v1 §4.1 (mode hierarchy) and §4.2 (Smash panel wireframe); all other sections of the v1 masterplan remain authoritative. The decision originated from direct user feedback during Phase 1:

> "I envisioned somewhat, that the UI for these pro features could be integrated to the left of the preview, so that you can switch between various controls without straying too far. … We can leverage the original preview and source/target selection. Maybe have a Color Match mode and a Smash mode UNDER the preview window, that will swap out the Match UI with the Smash UI. That way we can not bloat with redundant functions, and stay within the panel."

That feedback crystallized a concrete architectural shift: instead of a separate Smash tab with its own layer pickers and preview, Smash becomes an in-panel mode inside the existing MatchTab.

---

## 2. What changed and why

### v1 plan vs. v2 architecture

| Dimension | v1 Masterplan (superseded) | v2 Architecture (this addendum) |
|---|---|---|
| Panel structure | ProShell wraps MatchTab + SmashTab as peer tabs | One MatchTab; Smash is a mode inside it |
| Layer pickers | Duplicated in each tab | Shared; owned by MatchTab, consumed by both modes |
| Preview | Each tab had its own preview | One `<MatchedPreview>` component; transform varies by mode |
| Mode toggle | Top-level tab strip | `[Color Match · Smash]` pill toggle below the preview |
| PRO badge | Implicit via separate tab | Inline chip next to the Smash pill |
| `SmashTab.tsx` | Top-level Pro panel | Deprecated; replaced by slim `SmashSection.tsx` |
| `ProShell.tsx` | Tab-strip wrapper for MatchTab + SmashTab | Deprecated; removed once integration lands |
| `Panel.tsx` branch | `__SMASH_ENABLED__ ? <ProShell /> : <MatchTab />` | Just `<MatchTab />` in both builds |

### Rationale

- **No duplicate layer pickers.** Source and target selection live once; both modes read the same selections.
- **No parallel preview.** One preview component, one Before/After badge, one refresh callback. The transform baked into the preview changes by mode.
- **Cross-mode A/B is free.** Toggling `Color Match ↔ Smash` shows the same source through two transforms in the same preview tile — a before/after comparison across modes without any extra UI work.
- **Smaller panel surface.** The panel stays inside its existing footprint. No second tab inflates the navigation bar.
- **Shared infrastructure.** MatchTab's existing layer snapshot pipeline, error handling, and preview lifecycle are reused rather than duplicated.

---

## 3. The mode toggle

### Placement

Directly below the matched preview, above the mode-specific lower controls.

### Visual sketch

```
┌─ MatchTab ──────────────────────────────────────────┐
│  [Source: layer ▼]   [Target: layer ▼]              │
│                                                      │
│  ┌──────────────── Matched Preview ───────────────┐  │
│  │                                                │  │
│  │              (preview tile)                    │  │
│  │                                [Before/After]  │  │
│  └────────────────────────────────────────────────┘  │
│  [Refresh ↺]                                         │
│                                                      │
│  ╔═══════════════════════════════════════════════╗   │
│  ║  [ Color Match ]   [ Smash  PRO ]             ║   │
│  ╚═══════════════════════════════════════════════╝   │
│                                                      │
│  ╌╌╌╌ mode-specific lower controls ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Behavior

- **Color Match pill** — default; active in free builds and Pro builds. Renders the existing palette strips, preset row, dimensions, zones, envelope, and the Apply Curves / Apply LUT / Export LUT buttons. Identical to the shipped MatchTab lower section.
- **Smash pill** — visible only when `__SMASH_ENABLED__` is true. A small `PRO` chip appears inline with the pill label. When active, the lower section swaps to `SmashSection`: DNA strip, Smash Amount slider + preset row, audit panel, Apply / Export .cube.
- **Free builds** — the toggle is never rendered. `MatchTab` renders its current lower section unconditionally. Terser DCE removes all Pro-only code paths. Free binary is byte-equivalent to today's shipped product.
- **Mode is not persisted across sessions** — always opens in Color Match.

---

## 4. State sharing

### MatchTab-owned (shared across modes)

| State | Type | Notes |
|---|---|---|
| `sourceDocId` | `number` | Active Photoshop document id |
| `sourceLayerId` | `number` | Selected source layer |
| `targetDocId` | `number` | Active document for target |
| `targetLayerId` | `number` | Selected target layer |
| `srcSnap` | `PixelData` | Source layer pixel snapshot |
| `tgtSnap` | `PixelData` | Target layer pixel snapshot |
| `matchedPreviewRef` | `React.RefObject<MatchedPreviewHandle>` | Imperative handle to `<MatchedPreview>` |
| `onRefresh` callback | `() => void` | Triggers fresh snapshot + preview recompute |
| `activeMode` | `'match' \| 'smash'` | Controls which lower section renders (Pro builds only) |

### Mode-specific (not shared)

**Match mode** — palette weights, palette count (3/5/7), dimensions (Full/Color/Hue/Sat/Contrast), zone softness, envelope, Apply/Export targets. All existing state; untouched.

**Smash mode** — Smash Amount, DNA strip display state, per-trait slider values, audit panel open/closed, engine output (`SmashEngineResult`). Owned by `SmashSection` and lifted to MatchTab only as needed via `onEngineChange`.

---

## 5. Live preview integration

Smash mode drives the existing `<MatchedPreview>` component through a single callback chain. No changes to `MatchedPreview` itself.

1. `SmashSection` computes a `SmashEngineResult` whenever controls change (Amount, traits, DNA). It calls `onEngineChange(result)` — a prop passed down from MatchTab.
2. MatchTab's `onEngineChange` handler applies the engine result to the source snapshot pixels. Implementation is TBD between two options:
   - **Per-pixel `applyTransform`** — lower memory, acceptable at 17³ preview tier resolution.
   - **Baked LUT** — MatchTab bakes the engine result to a 17³ LUT once and applies via the existing LUT path. Reuses preview infrastructure directly; preferred for consistency.
3. MatchTab pushes the resulting RGBA buffer to `matchedPreviewRef.current.setPixels(rgba)` — the same imperative call Match mode already uses when its sliders change.
4. `<MatchedPreview>` renders. No code changes needed in the component.

The two-tier preview schedule (17³ during drag, 33³ on commit) from v1 §4.6 applies to Smash mode identically — the bake tier simply uses `SmashEngineResult` as its input rather than the Match engine.

---

## 6. Free / Pro separation

The following are all wrapped in `__SMASH_ENABLED__` guards and absent from free builds:

- The `[Color Match · Smash]` mode toggle render path inside MatchTab.
- The `activeMode` state and the conditional branch on `activeMode`.
- The `onEngineChange` callback and the Smash → preview pixel pipeline.
- The `SmashSection` component import and render.
- All `core/smash/` engine calls triggered from MatchTab.

Free builds compile `MatchTab` with none of the above. The lower section renders unconditionally as Match controls. Webpack's dead-code elimination removes the gated branches entirely from the free `.ccx`.

The free and Pro builds share the same `<MatchedPreview>` component, the same layer picker UI, and the same snapshot / refresh infrastructure. Those are not gated.

---

## 7. Deprecations

The following files are deprecated and will be removed once the MatchTab integration lands and has been smoke-tested.

### `plugin/src/ui/smash/ProShell.tsx`

Originally responsible for wrapping `MatchTab` and `SmashTab` as peer tabs in a Pro-only tab strip. With the mode toggle moved inside MatchTab, ProShell has no remaining responsibility. To be deleted.

### `plugin/src/ui/smash/SmashTab.tsx`

The standalone top-level Pro panel with its own layer pickers and preview. Replaced by `SmashSection.tsx` — a slim, props-driven component that receives source/target snapshots from MatchTab and renders only the Smash-specific lower controls (DNA strip, Amount slider, preset row, audit panel, Apply / Export). `SmashTab.tsx` is to be deleted after `SmashSection.tsx` is integrated and verified.

### `plugin/src/ui/Panel.tsx` — branch simplification

The current branch `__SMASH_ENABLED__ ? <ProShell /> : <MatchTab />` becomes simply `<MatchTab />` in both builds. The mode toggle is internal to MatchTab; Panel.tsx no longer needs to know about the Pro/free distinction at the top level.

---

## 8. Implementation order

These map directly to the remaining work for the Phase 1 "Pro alpha foundation" milestone.

1. **Build `SmashSection.tsx`** — slim, props-driven component: receives `srcSnap`, `tgtSnap`, emits `onEngineChange`. No pickers, no preview. Agent O has this in flight.
2. **Add `activeMode` state and toggle UI to MatchTab** — gated by `__SMASH_ENABLED__`. Renders the `[Color Match · Smash PRO]` pill row; default is `'match'`. Free builds see no change.
3. **Branch MatchTab's lower content on `activeMode`** — when `'match'`, render existing controls unchanged. When `'smash'`, render `<SmashSection>`.
4. **Route Smash engine output to preview** — wire `onEngineChange` in MatchTab: bake or apply the engine result, call `matchedPreviewRef.current.setPixels()`.
5. **Remove ProShell and SmashTab; simplify Panel.tsx** — delete deprecated files, update Panel.tsx to unconditional `<MatchTab />`.

Steps 1 and 2 are independent and can proceed in parallel. Step 3 depends on both. Steps 4 and 5 depend on step 3.

---

## 9. Phase 1 checklist update

This supersedes the Phase 1 status tracking implied by v1 §5.

### Completed (as of this addendum)

1. Feature extraction (`features.ts`) — done.
2. Band construction (`bands.ts`) — done.
3. Per-band stats (`stats.ts`) — done.
4. DNA pairing (`profile.ts`) — done.
5. Per-band match (`transform.ts`) — done.
6. LUT bake (`lut.ts`) — done.
7. Source DNA strip UI (`SourceDNAStrip.tsx`) — done.
8. Smash Amount + preset row — done.
9. Smash Audit v0 — done.
10. Persist Smash preset — done.
11. Apply Curves / Apply LUT bonus — done.
12. Export LUT bonus — done.

### Remaining for Pro alpha milestone

Items 1–5 from §8 above: SmashSection, mode toggle, lower-section branch, engine-to-preview routing, ProShell/SmashTab removal.

---

## 10. What is unchanged from v1

The following sections of the v1 masterplan stand without modification:

- **Engineering strategy** — one repo, `feature/smash` branch, `__SMASH_ENABLED__` build flag, two `.ccx` targets, branching model, distribution options (§2.1–§2.7).
- **Technical architecture** — `core/smash/`, `core/perceptual/`, `app/smash/`, type definitions in `types.ts`, engine pseudo-pipeline, color science choices (§3.1–§3.5).
- **UX sections not superseded** — Smash Audit panel (§4.3), Show Influence overlay (§4.4), standard reference image (§4.5), two-tier preview (§4.6). These apply to Smash mode inside MatchTab exactly as written.
- **Roadmap from Phase 2 onward** — trait sliders, compression, ACES vMM, WebGL shader, Phase 3 ship items, Phase 4 advanced features (§5, Phase 2–4).
- **Acceptance criteria** (§6), **risk register** (§7), **deferred scope** (§8), **open questions** (§10).
- **Free / Pro line** (§1.3) — unchanged. The mode toggle is Pro-only; Match remains the full free experience.

Design principles from `_06` that informed v1 §4.2 carry forward: P3 (one big knob — Smash Amount stays the lead control), P5 (existing preview + Before/After badge survives), H1 (complex multi-dimensional state surfaced simply via a single toggle rather than a parallel tab).

---

*This addendum is the working record of the v2 UI architecture decision. When the implementation in §8 is complete and `ProShell.tsx` and `SmashTab.tsx` are deleted, this addendum can be folded back into a revised §4 of the main masterplan.*


---

## Addendum entry — Phase 5+: Cross-dimensional colorization (the grayscale-target problem)

The Phase 3-4 engine matches L / C / h distributions **independently** per dimension. That works beautifully when source and target both have meaningful color content. It breaks down when the target has near-zero structure on a dimension — most notably: **applying a colorful source to a grayscale target**.

The fundamental issue: per-dimension 1D CDF match can only redistribute existing structure. Grayscale targets have no hue/chroma structure to redistribute. The chroma CDF expands target's near-zero range into something resembling source's, but it doesn't INVENT structure where there was none. Output stays mostly grayscale with faint tinting.

The fix requires **cross-dimensional / conditional matching**: "given the target pixel's L, what should its (a, b) be?" This pulls color from the source's L→(a, b) correlation rather than from the target's (nonexistent) color distribution.

### Four approaches, ranked by sophistication

Each can ship as a **toggle** so users can mix mechanics for different creative outcomes. Multiple toggles produce blended behavior (sum-then-renormalize the contributions).

**Toggle 1 — Hue-by-L lookup (Phase 5a, ~2 hours)**
For each L value in source, compute the average (a, b). Build a 1D LUT `L → (a, b)`. At apply time, target pixel's L (after CDF match) → lookup → output (a, b). Preserves the shape of source's color-by-L correlation but loses noise. Cheap. The minimal viable colorization mechanic.

**Toggle 2 — Stochastic per-L-band sampling (Phase 5b, ~4 hours)**
Same idea but instead of averaging, sample a source pixel uniformly at random from the same L band. Use a deterministic hash of `(target_x, target_y)` as the seed so the result is reproducible across runs. Preserves noise — different target pixels at the same L get different colors. May need a small spatial smoothing pass to avoid checkerboard artifacts. Captures the "saturation variations, grays, and noise" the user wanted preserved.

**Toggle 3 — Conditional CDF: P(color | L) (Phase 5c, ~8 hours)**
Bucket source pixels by L. For each L bucket, build a 2D CDF over (a, b). At apply, look up target's L → select bucket → sample from the bucket's color CDF using target's existing (tiny) chroma as the percentile. Preserves L-conditional color distribution properly. More principled than Toggle 1; preserves cross-color structure within a band that Toggle 1's averaging loses.

**Toggle 4 — Sliced Optimal Transport (Phase 6, ~3 days)**
Pitié 2007. The principled joint-distribution match: random 1D projections, iterate. Captures all cross-dimension correlation including L↔C↔h↔spatial. Works on grayscale → colorful naturally. Heaviest implementation (~5× slower than per-dimension match) but the proper long-term answer. Already in `Masterplan_v1.md` §S5 / `Research_06.md` §S5.

**Skipped: Patch-based / spatial style transfer**
Different product (style transfer territory). Out of scope for Smash.

### Toggle UX

Each approach lives behind a checkbox or chip in an "Advanced — Colorization" disclosure under the trait sliders. Suggested default state:

- Toggle 1 (Hue-by-L) — ON by default. Cheap; gives sensible grayscale-target behavior out of the box.
- Toggle 2 (Stochastic) — OFF. User enables for "more painterly" / noise-preserved results.
- Toggle 3 (Conditional CDF) — OFF. Power user knob; can replace Toggle 1 for principled results.
- Toggle 4 (Sliced OT) — OFF. Heavy; opt-in for "more cinematic" / "more film-like" results.

Multiple toggles ON: contributions blend. The simple stacking math is `output = weighted average of each enabled approach's output`, with weights from a "blend balance" tertiary slider (or just default equal weights for v0).

### When the colorization path activates

The engine inspects target's median chroma at smash-build time. If above `HUE_FILTER_CHROMA` × 2 (≈0.04), per-dimension CDF is the canonical path (Phase 3-4 — current behavior). If below, the colorization toggles take over for the hue + chroma dimensions; L still uses CDF match independently.

This means colorful targets get the Phase 3-4 behavior unchanged. Grayscale / low-chroma targets opt into the colorization pipeline automatically. The user can override via a "Colorization: Auto / Always / Off" tri-state.

### Where this slots in the roadmap

Sits after Phase 4 (currently shipping) and parallel to the Phase 5 anchor-preshaping discussed in the next entry. Both are user-vision items captured during Phase 3-4 testing. Recommended order:

- **Phase 4.5** — Toggle 1 (Hue-by-L) ships first as the minimal viable cross-dimensional path. Unblocks any grayscale-target use case.
- **Phase 5** — Toggle 2 (Stochastic) adds noise preservation, which the user specifically mentioned wanting.
- **Phase 5.5** — Toggle 3 (Conditional CDF) for more principled results.
- **Phase 6** — Toggle 4 (Sliced OT) for the proper long-term joint-distribution match.

Each phase is shippable independently. Each toggle is a separate engine module that the user can enable/disable without breaking the others.

---

## Addendum entry — Phase 5 alt: Target-side anchor pre-shaping

The user articulated a separate-but-composable idea during Phase 3-4 testing: a **target-side pre-conditioner that runs BEFORE the source-driven CDF match**.

Today the pipeline is:
```
target pixels → target CDF → match to source CDF → output
```

Proposed pipeline:
```
target pixels → user-shaped CDF (via anchor curves per dimension) → match to source CDF → output
```

Per dimension (value, hue, saturation, chroma), the user gets interactive anchor points on a histogram. Dragging an anchor stretches/compresses the local distribution. The reshaped target becomes the new input to the source-CDF remap. End result: "I want my target to behave like a 50% high-key image before Smash kicks in" — then Smash takes that shaped distribution and forces it into the source's proportions.

This is the natural form of the "Range Fields" concept in `Masterplan_v1.md` §4 — but operating on histogram **distribution** rather than spatial **selection**. Same idea: "let the user pre-define where things should land before the engine processes." Where Range Fields say "this region in the image gets the transform," Anchor Curves say "this region of the histogram becomes that region before the transform."

### Implementation cost

Math is small — a 1D LUT pre-stage that composes with the existing CDF match as another lookup. UI is substantial:
- Histogram visualization per dimension (canvas-rendered, live, bin-sensitive)
- Interactive anchor placement (click-add, drag-move, right-click-delete)
- Curve interpolation between anchors (Catmull-Rom or monotone cubic)
- One editor per dimension (value, hue with circular topology, saturation, chroma)
- Toggle per dimension (most users use defaults; pre-shape is power user)
- Storage in the preset format

Total: ~1–2 days for a useful v0. Belongs after Phase 5 colorization (above), since the colorization toggles solve the more pressing problem first.

### Composes naturally with everything else

- Per-dimension CDF match still runs. Pre-shape is just a 1D LUT applied first.
- Colorization toggles still run on dimensions where target has structure (post-preshape).
- Trait sliders still gate per-dimension output.
- Oversample / crank still extrapolates.
- Apply / Export bake the pre-shape into the output LUT alongside everything else.

Whichever combination the user composes, the output is a single 33³ LUT.

---

## 8. Color end-goals — what the plugin should accomplish

This section is the canonical statement of what "Smash" means for color. It supersedes earlier scattered language across v1 and refines the user's intent as it crystallized during Phase 4 testing. The engine's job is **none of**: "apply a stylistic filter," "match average color," "blend the source over the target." It is **all of**:

### 8.1 The five goals

1. **Distribution mirroring across every spectrum.** For each of value (L), hue (h), saturation (S=C/L), and chroma (C), the target's distribution should be forced to look like the source's — adapted to whatever range the target actually occupies. If the source has 50% pure black, 15% dark gray, 25% medium yellow-gray, and 10% saturated red, the target should be remapped so its distribution rank-mirrors that proportionally across the equivalent range. This is the literal per-dimension CDF histogram match.

2. **Source color identity expression — including non-dominant colors.** The output should look like it could have been drawn from the source's color palette. If the source has 90% red and 10% gray, the output should show *both* colors, not just the dominant red averaged across everything. Minorities matter — they're part of the source's identity. Mechanism: `paletteSnap` toggle (§8.4) routes each output pixel to the *nearest source cluster* rather than the per-L average.

3. **Cross-dimensional inference for sparse targets.** When the target has too little structure on one dimension to redistribute (e.g., a grayscale target on the chroma/hue axes), the engine *invents* structure from the source's L-correlation. The `hueByLuma` toggle aims hue at the source's average (a, b) direction per L bucket; `liftNeutrals` floors chroma at source's median magnitude so shadows colorize broadly instead of collapsing.

4. **User-tunable intensification.** The user controls how aggressive the smash is. The `passes` knob (1×–4×) re-runs the engine on its own output, compounding chroma further up source's CDF. The trait sliders (Value/Hue/Sat/Chroma/Neutral/Accent at 0–200%) scale per-dimension gates; 100–200% is the explicit "crank past literal CDF match" region.

5. **Single-LUT bakability whenever possible.** The full transform must encode into one 33³ Color Lookup adjustment layer in Photoshop. No multi-layer stacks, no masks (except the masks the user chooses to add manually), no spatial dependencies. The transform is `f(R, G, B) → (R', G', B')` — pure per-pixel. This constraint is *fundamental*, not optional, and shapes every mechanic the engine offers.

### 8.2 What the LUT constraint rules out

Goal #2 (color identity) is the hardest because of #5 (LUT-bakable). A LUT can only produce different outputs for different inputs. For a perfectly flat grayscale region — every pixel literally `RGB(128, 128, 128)` — the LUT must map all of them to the same output color. Diversity is impossible there.

The engine works around this where the target has *any* chromatic variation:
- Anti-aliased edges (R ≠ G ≠ B by 1–2 LSB)
- JPEG compression chroma noise
- Real color in the target (even a "grayscale-looking" sepia photo has structure)

These micro-variations become selectors that route different pixels to different source clusters. Diversity arises naturally for real photos; only mathematically-flat fills collapse.

For genuinely flat regions, the user has three escape hatches:
- Run `paletteSnap` OFF and accept the L-averaged output (current default before paletteSnap shipped)
- Apply via the **panel preview path** rasterized to a layer — preview runs per-pixel and can be stochastic (Phase 5+ option)
- Inject light chromatic noise into the target before applying the LUT (one-line PS adjustment)

### 8.3 What each mechanic contributes to the goals

| Mechanic | Goal it serves | Optional? |
|---|---|---|
| Per-dimension CDF (L/C/h) | #1 (distribution mirroring) | No — engine core |
| Band-fitted per-channel curves | #1 (within each L band) | No — engine core |
| ACES gamut compress | #1 (range preservation) | No — engine core |
| `hueByLuma` toggle (Phase 4.5) | #3 (cross-dim hue) | Yes, ON by default |
| `liftNeutrals` toggle (Phase 4.5b → refined 4.5f) | #1 (proportions) + #3 (cross-dim chroma) | Yes, ON by default |
| `paletteSnap` toggle (Phase 4.5d, this section) | #2 (color identity) | Yes, OFF by default; opt-in for stronger color preservation |
| `passes` 1–4× (Phase 4.5c) | #4 (intensification) | Yes, default 1× |
| Trait sliders @ 0–200% | #4 (per-dim crank) | Yes, default 100% all |
| Pre-shaping anchors (Phase 6, planned) | #1 (user-tunable input distribution) | Yes, opt-in |

All of these compose into the same 33³ LUT output.

### 8.4 Phase 4.5d — `paletteSnap`: the color-identity mechanic

**Problem.** Hue-by-L's per-bucket *average* `(a, b)` collapses minorities (§8.1 #2). A 90% red / 10% gray source produces an "almost-pure red" output regardless of how much gray the source actually contains; the gray is averaged away.

**Mechanism.** When `paletteSnap` is ON, the smashed hue `hsm` is derived by:

1. Look up `Lsm` (post-L-CDF) as before.
2. Compute the input pixel's hue direction `hin = atan2(bIn, aIn)`. For tiny `Cin`, this is noisy but the noise itself is useful — it varies per-pixel.
3. Scan the source's clusters (already computed in `SourceDNA.clusters` via k-means). For each cluster with meaningful chroma (≥ a chromatic floor, e.g., 0.02), compute:
   - Hue distance `dh = circular_distance(hin, cluster.hue)`
   - L distance `dL = |Lsm − cluster.L|`
   - Score = `−(dh + α·dL)` where α weights L proximity (e.g., 0.5)
4. Pick the cluster with the maximum score. Use its `atan2(b, a)` as `hsm`.

**Effect.**
- Pixels with detectable input hue direction snap to the source cluster matching that direction. Different pixels can pick different clusters → diverse output.
- Pixels at very low `Cin` (perfect or near-perfect gray) still produce a deterministic cluster pick (via the L term), but adjacent pixels with even 1-LSB chroma variation may pick different clusters. This is the diversity mechanism for real photos.
- Output chroma magnitude still comes from the CDF + `liftNeutrals`. `paletteSnap` only re-aims the hue.

**Why this preserves minority colors.** Each output pixel resolves to *one specific source cluster* instead of a weighted average. A 90/10 source has two clusters (red + gray); the engine doesn't average them — it picks one per pixel based on input cues. The *population* of cluster picks across the output image then reflects the source's full palette.

**LUT-bakable.** Yes — the per-pixel decision is a pure function of `(R, G, B)` because `hin` is derived from input alone and the cluster table is frozen at engine-build time.

**Tradeoff vs. `hueByLuma`.**
- `hueByLuma` ON, `paletteSnap` OFF: smooth, averaged color story — clean, but minority colors lost.
- `hueByLuma` ON, `paletteSnap` ON: discrete cluster snapping per pixel — diverse, but with cluster-boundary discontinuities (visible if the input image is very smooth and there are few clusters).
- `paletteSnap` ON without `hueByLuma`: same cluster routing, but per-pixel hue CDF for fallback when `Cin` is below the routing threshold.

Default: **OFF**, to preserve smoothness in the default look. User opts in when they want minority colors expressed.

### 8.4b — `liftNeutrals` per-L floor refinement (Phase 4.5f)

**Earlier behavior (Phase 4.5b shipping):** lift floor was `sourceMedianChroma` — a single global number for the whole source. Every near-neutral target pixel got pushed to the same magnitude regardless of L. Symptom: a 15%-fire / 85%-dark source produced nearly-uniform warm output instead of "warm where source is warm, dark where source is dark." Source's color/neutral *proportions* were lost in the output.

**Refined behavior (this revision):** lift floor is `srcLutMag(Lsm)` — the magnitude of the `hueByLumaLut` lookup at the smashed L. The hueByLumaLut already stores the magnitude-preserving average chroma per L bucket (built once at engine time), so reusing it costs nothing.

```
liftFloor = magnitude of hueByLumaLut at Lsm    # source's typical chroma at this L
liftAmount = neutralness × max(0, liftFloor − cdfMag)
Csm = cdfMag + liftAmount
```

**Effect on a bimodal source (e.g., dark background + bright fire):**

| Target L (after lumaCdf) | Source's chroma at that L | Lift | Output |
|---|---|---|---|
| Low (≈0.1, source's "dark background" rank) | Very small (≈0.005) | Tiny | Stays dark/neutral |
| Mid (≈0.5) | Moderate | Moderate | Some warm tone |
| High (≈0.85, source's "fire" rank) | Large (≈0.20) | Big | Vivid warm |

Combined with `lumaCdf` rank-mapping target's L distribution onto source's (so target gets the same proportion of low/high L pixels as source does), the OUTPUT's color/neutral ratio approximately matches the SOURCE'S. Goal #1 (distribution mirroring across all spectra) extends to color *proportions*, not just averaged distributions.

**What this doesn't solve:** within-L diversity. If source's L=0.5 bucket is 50% red + 50% blue, target's pixels at L=0.5 still all get the bucket's *average* direction (a muted purple) at the bucket's *average* magnitude. Per-pixel diversity within a bucket is what Phase 5 stochastic per-L sampling and the existing `paletteSnap` toggle address.

**Falls back gracefully:** if `hueByLumaLut` is null (degenerate input), `liftFloor` falls back to `sourceMedianChroma` — the old behavior — so no regressions on edge cases.

### 8.4c — `proportionMatch` slider (Phase 4.5g)

The Phase 4.5f per-L floor is a strong default but it's also an opinion: it forces the output to mirror the source's L→C structure faithfully. Some users want that exactly; others want a softer interpretation that still colorizes neutrals broadly without being chained to source's exact proportions. Phase 4.5g exposes this as a continuous control.

**Mechanic.** `proportionMatch ∈ [0, 1]` lerps the lift floor between the two regimes:

```
liftFloor = proportionMatch × srcLutMag(Lsm) + (1 − proportionMatch) × sourceMedianChroma
```

| Value | Behavior | Effect on a 15%-fire / 85%-dark source |
|---|---|---|
| 1.0 (tight, default) | Pure per-L floor | Output = ~85% dark + ~15% red, mirrors source's structure |
| 0.5 | 50/50 blend | Halfway: dark areas get some warm tint, but still less than highlights |
| 0.0 (loose) | Pure global median floor | Output = ~uniform warm tint everywhere (pre-4.5f behavior) |

**UI.** Inline slider below PASSES, labeled `PROPORTION`, range 0–100% in 5% steps. Tooltip explains the tight/loose tradeoff.

**Composition.**
- No effect when `liftNeutrals` is OFF (no lift to compute, slider is dormant).
- Composes with `passes` — multi-pass compounds whatever lift floor the slider lands on.
- Composes with `paletteSnap` — snap re-aims hue regardless of which floor produced the magnitude.
- Composes with `hueByLuma` direction — orthogonal mechanics.

**Falls back gracefully:** when `hueByLumaLut` is null, `srcLutMag` is undefined and the engine uses `sourceMedianChroma` regardless of slider position — no NaN, no surprise.

### 8.4d — `posterize`: L-banded full cluster snap (Phase 4.5h)

**User vision** (sketched as a mockup, see Section 8 history): take the source's distinct color palette (~5–16 distinct hues from k-means), and *paint* the target's L bands with those colors directly — a grayscale photo becomes a posterized illustration in source's palette.

**Problem this addresses.** `paletteSnap` re-aims hue *direction* only. It doesn't replace the pixel's L or chroma magnitude, so the output is still a smooth gradient of source-derived hues — not the bold posterized banding the user envisioned. Goal #2 (color identity expression) is partially served by paletteSnap; full identity expression as discrete bands is what posterize does.

**Mechanic.** A new continuous knob `posterize ∈ [0, 1]`. Applied at the *end* of `applyTransformOnePass`, *after* the engine has computed the smooth output via L-CDF, chroma lift, Hue-by-L, gamut compression, etc:

```
for each cluster c in SourceDNA.clusters:
    dL = |Lin − c.centroidOklab.L|
pick cluster with min dL
finalRGB = smoothRGB + (cluster.rgb − smoothRGB) × posterize
```

| Value | Behavior |
|---|---|
| 0.0 (default) | No snap. Output is the engine's smooth result, exactly as before. |
| 0.3 | Subtle pull toward the palette — color "personality" of source comes through, gradient still mostly smooth. |
| 0.7 | Strong posterize bands visible, with some smoothing remaining. |
| 1.0 | Full snap. Each output pixel IS exactly one of the source clusters' RGBs — hard posterized illustration look. |

**Why match by `Lin` (input L) and not `Lout`?** Matches user's intuition that target's *own* L bands route to clusters: a dancer's mid-tone face → source's mid-tone cluster. Using `Lout` (post-lumaCdf) would route by the rank-mapped lightness, which can compress wildly for bimodal sources and produces less intuitive band placement.

**Orthogonal to all other mechanics.**
- Composes with `paletteSnap` (which only modulates hue): the smooth output that posterize then snaps from already has paletteSnap's hue routing baked in.
- Composes with `passes` (multi-pass): each pass's intermediate output uses posterize. At passes>1, intermediate posterized values feed the next pass.
- Composes with `liftNeutrals` + `proportionMatch`: those determine the smooth output, posterize then snaps it.

**Cluster count.** Determined at SourceDNA extraction time (currently 16 by default in `core/smash/clusters.ts`). For more aggressive posterize banding (the user's mockup looks like ~5 bands), the cluster count would need to be tunable — future work. With 16 clusters, posterize=1.0 still produces a posterized look but with finer banding than the mockup.

**LUT-bakable.** Yes — `posterize` is purely a function of input RGB (via Lin) and frozen cluster table, with no per-pixel state. Bakes into the single Color Lookup adjustment layer alongside everything else.

### 8.4e — `distribution`: soft joint-mode density blend (Phase 4.5i)

**User vision** (verbatim): *"I want a posterize sort of logic to color application, but not the posterize effect. I want it to remain a color smash type of application, but emphasize the distribution… using histograms to find the overlaps that are highest frequency in the source, as the 'effect' we are trying to imprint onto another."*

**The gap this closes.** Earlier mechanics fall into two camps:
- **Per-dimension marginals** (Phase 3/4 CDFs): smooth output, treats L, C, h as independent. Loses joint co-occurrence — doesn't know that the source has "dark warm + bright red", only that it has "some dark + some bright" and "some warm + some red".
- **Cluster snap** (paletteSnap, posterize): respects joint distribution (clusters ARE joint modes), but SNAPS (hard pick). Produces banding.

`distribution` lives in between: respects joint co-occurrence like clusters do, but blends smoothly across all clusters weighted by both gaussian proximity AND cluster population. The result is **smooth like a CDF but joint like clusters** — exactly the "smash with structure" intuition.

**Mechanic.** Applied at the end of `applyTransformOnePass`, *before* posterize:

```
SIGMA = 0.15    # Oklab L+a+b joint distance softness

for each source cluster c:
    dist² = (Lin − c.L)² + (aIn − c.a)² + (bIn − c.b)²
    weight[c] = c.population × exp(−dist² / 2σ²)

blendRGB = Σ(c.rgb × weight[c]) / Σ(weight[c])
finalRGB = smoothRGB + (blendRGB − smoothRGB) × distribution
```

- **`c.population`** is the existing `cluster.weight` field — fraction of source pixels in that cluster. High-frequency clusters dominate the blend ("emphasize the distribution").
- **Gaussian falloff** weights clusters by proximity to the input pixel's joint Oklab position. Distant clusters contribute less.
- **`σ = 0.15`** combined-Oklab is empirically tuned: aggressive enough to favor nearby clusters, soft enough to interpolate smoothly between them. Could become user-tunable later if "how soft" matters.

| Slider | Result |
|---|---|
| 0.0 (default) | No blend, output is engine's smooth result |
| 0.3 | Subtle pull toward source's modal regions, gradient stays smooth |
| 0.7 | Strong joint-mode emphasis, source's "color personality" dominates |
| 1.0 | Full lerp — output is the frequency-weighted joint mean of source's clusters at this input's Oklab position |

**Comparison across all four cluster-aware knobs:**

| Knob | Match space | Match mode | Output |
|---|---|---|---|
| `paletteSnap` | Hue (1D, circular) | Hard pick | Smooth gradient of source-derived hues |
| `posterize` | L (1D, linear) | Hard pick | Banded into N cluster RGBs |
| `distribution` (this) | Joint Oklab (3D) | Soft Gaussian + frequency | Smooth, joint, frequency-weighted |
| Per-dim CDFs | L, C, h marginals | Rank-mapped | Smooth, but joint-blind |

**Composition.**
- Applied BEFORE posterize — if both are on, posterize hard-snaps the distribution-blended result. (Rare to want both at high values; one or the other.)
- Stacks with all the gates that come earlier (CDF, Hue-by-L, Lift, Proportion, paletteSnap) since those produce the "smoothRGB" that distribution lerps from.
- Stacks with passes — each pass's intermediate uses distribution.

**LUT-bakable.** Yes. Distribution is a pure function of (R, G, B) via (Lin, aIn, bIn) + frozen cluster table. ~16 cluster gaussian evaluations per pixel; ~50ns per cluster eval; ~1µs per pixel — negligible. Bakes into the single Color Lookup adjustment layer like everything else.

### 8.5 What's still on the roadmap (Phase 5+)

The four colorization mechanics in v1.1 §5 remain forward work:

- **Stochastic per-L-band sampling** (Toggle 2). Per-pixel random sample from source's bucket distribution. NOT LUT-bakable (same input → different output requires per-pixel state) but works as a panel-preview-only mode the user can rasterize.
- **Conditional CDF P(color | L)** (Toggle 3). Per-L bucket chroma distribution match, not just bucket mean. Adds within-L diversity in a LUT-bakable way.
- **Sliced optimal transport** (Toggle 4). Math-heavy, gives the strongest distribution preservation; benchmark before implementing.
- **Pre-shaping anchors** (§7). User-defined 1D LUTs per dimension applied before the CDF match. Composes with everything above.

The order is roughly: Phase 4.5d `paletteSnap` (shipping now) → Phase 5 conditional CDF (next likely) → Phase 6 anchors → Phase 7 stochastic preview mode → Phase 8 sliced OT.
