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

### 8.4f — `zoneInfluence` + `detailRichness`: two-step zone routing (Phase 4.5j)

**User vision** (verbatim): *"an extra step in the abstract phase (or pre-abstract phase) where we use the simplified zones almost as masks, to determine the 'relative scale' that each cluster should express… each cluster has lots of relative color relationships within it, often times values and colors that might technically be VERY different from a raw 1:1 color range or value swap… so it needs to simplify as a means to organize its application, but it also needs to be able to retrieve the distinct relative color associations from the source… not just 1:1 color swapping."*

The two-step intuition: (1) use clusters as the coarse organizational framework — they capture source's joint modes and their populations, which `lumaCdf` then ensures the target's L distribution mirrors. (2) Within each cluster, don't just dump the centroid — preserve the cluster's internal value→color variation so the output retains source's nuance, not just its averaged identity.

**What's new architecturally.** This is the first mechanic that uses **per-cluster sub-LUTs**. At engine build time:

```
For each source cluster c (k-means in CIE Lab via core/palette.ts, then Oklab):
    clusterPixels = source features nearest to c's centroid (Oklab Euclidean)
    c.subLUT = buildHueByLumaLut(clusterPixels)   // miniature Hue-by-L per cluster
```

These sub-LUTs live in `SmashCdfs.clusterSubLuts` and are computed once per snap change (not per slider tick).

**Apply-time math.** After all other hue/chroma paths have computed `(hsm, Csm)`:

```
1. ROUTE: nearest cluster by L distance (1D scan of clusterLs, O(K), K=3..32)
   bestIdx = argmin |Lin − clusterLs[k]|

2. ZONE (a, b): blend cluster centroid vs cluster sub-LUT by detailRichness
   (aCen, bCen) = clusters[bestIdx].centroidOklab
   (aSub, bSub) = lookupHueByLuma(clusterSubLuts[bestIdx], Lin)
   (aZone, bZone) = lerp(centroid, sub-LUT, detailRichness)

3. POLAR: convert to (hZone, CZone)
   CZone = √(aZone² + bZone²)
   hZone = atan2(bZone, aZone)

4. APPLY: lerp existing (hsm, Csm) toward zone result by zoneInfluence
   hsm += circular_delta(hZone, hsm) × zoneInfluence
   Csm += (CZone − Csm) × zoneInfluence
```

**The two sliders and the cluster count.**

| Knob | Range | Default | What it does |
|---|---|---|---|
| `clusterCount` (ZONES) | 3–32 integer | 5 | Number of source palette zones. Re-extracts SourceDNA on change (~50ms). Coarse-grained at 3, fine-grained at 32. |
| `zoneInfluence` (INFLUENCE) | 0–1 | 0 (off) | How strongly the zone-routed (hsm, Csm) replaces the default Hue-by-L/CDF result. |
| `detailRichness` (DETAIL) | 0–1 | 1 | Inside the zone path, lerps between cluster CENTROID (0, flat within zone) and the cluster's own SUB-LUT at Lin (1, intra-cluster L→(a,b) variation). |

**Why match by Lin (not Lout)?** Same reasoning as posterize §8.4d: the user thinks in terms of "target's own L bands map to source's clusters." Using post-lumaCdf Lout would scramble that intuition.

**Why blend at (a, b) instead of full RGB (like posterize)?** Composes with the engine's `Lout` from lumaCdf + the trait gates. The zone path provides the COLOR (chroma + hue) but lets the engine decide LIGHTNESS independently — so the user can use Smash Amount + the Value trait to scale Lout while zone routing handles chroma identity. Posterize, by contrast, hard-snaps the whole RGB.

**Composition.**
- All earlier mechanics (CDF, Hue-by-L, lift, paletteSnap) run first to produce `(hsm, Csm)`.
- Zone path lerps from that result toward `(hZone, CZone)` by `zoneInfluence`.
- `distribution` and `posterize` then run on the gated RGB output (they're at the very end of the pipeline).
- So a full chain at all-on would be: CDF + lift + Hue-by-L + paletteSnap (hue only) → zone routing (per-cluster blend) → gates → RGB → distribution (soft cluster blend on RGB) → posterize (hard snap on RGB).

**LUT-bakable.** Yes. Pure function of (R, G, B) via Lin + frozen sub-LUTs + frozen cluster centroids. Per-pixel cost: 1 cluster scan (O(K)) + 1 sub-LUT lookup + a few trig ops. ~K × 5ns + 50ns ≈ negligible. Bakes into the Color Lookup adjustment layer like everything else.

**Open question — do we still need Hue-by-L?**

When `zoneInfluence=1` and `detailRichness=1`, the zone path effectively replaces the global Hue-by-L with a per-cluster set of Hue-by-L lookups. It's strictly more granular. The user has marked Hue-by-L for potential removal if zone routing covers its use cases in practice. Defer that decision until we see how the new mechanic feels across a few sessions.

### 8.4g — `zoneRatio`: source-side cluster weight modulation (Phase 4.5k)

**User vision** (verbatim): *"I need a ratio slider to increase or reduce a source zone relationship (add or tighten zones relative to one another)"*.

The source clusters carry a `weight` field (fraction of source pixels). This drives any mechanic that weights by frequency — today, the `distribution` mechanic's Gaussian-weighted blend. Source A with 90% red / 10% blue gets a very different `distribution` output than Source B with 50% red / 50% blue, even if the cluster centroids are identical. `zoneRatio` lets the user nudge those weights without re-extracting the source.

**Mechanic.** Compute adjusted weights at `smash()` time:

```
k = exp(zoneRatio)     // zoneRatio ∈ [-1, +1] → k ∈ [1/e, e]
for each cluster i:
  adjusted_weight[i] ∝ natural_weight[i]^k
normalize so Σ = 1
```

| zoneRatio | k | Effect on 90/10 source |
|---|---|---|
| -1.0 | 0.37 | weights → 0.96 / 0.83 ≈ near-uniform → minority gets equal voice |
| 0.0 (default) | 1.0 | 0.9 / 0.1 — natural |
| +1.0 | 2.72 | 0.99 / 0.0008 — minority almost vanishes |

Symmetric, intuitive: "tighten" the zones (slide negative) makes the distribution treat them more equally; "loosen" (slide positive) lets dominance run wild.

**Storage.** `SmashEngineOutput.adjustedClusterWeights: Float32Array` (one slot per cluster, normalized). Computed once per `smash()` call (sub-millisecond), reused by all per-pixel mechanics that consume weights.

**Currently consumed by.** Only `distribution` (replaces the `c.weight × gaussian` blend with `adjustedWeight × gaussian`). Future mechanics that want frequency-aware behavior can read `adjustedClusterWeights` for the user-modulated version without re-doing the power-exponent math per pixel.

**UI.** Inline slider below DETAIL, labeled ZONE RATIO. Range -100..+100% in 5% steps. Default 0% (natural).

**LUT-bakable.** Yes — adjustedClusterWeights is engine-time state, frozen by the time the LUT bake samples applyTransform.

### 8.4h — `temperature`: warm/cool final-pass shift (Phase 4.5m)

**User vision** (verbatim): *"a warm cool slider would also help. intensity of cool vs warm, ratio of cool warm, influence by value, color, saturation etc."*

Scoped MVP: single global warm/cool slider. Per-L / per-C / per-S modulators deferred — they're orthogonal and cheap to add once the base mechanic is shipped.

**Mechanic.** Final pre-conversion shift on output Oklab `(a, b)`:

```
Δa = temperature × 0.06    # +a = warm (red), −a = cool (green)
Δb = temperature × 0.04    # +b = warm (yellow), −b = cool (blue)
aOut += Δa
bOut += Δb
```

Coefficients chosen empirically: at ±1 produces ≈ 30-byte channel shift on neutral inputs without crushing pixels at the gamut edge (ACES gamut compression already ran upstream so most outputs have headroom).

**Where it sits.** After all structure-aware paths (CDF, Hue-by-L, lift, zone routing, paletteSnap), after the gates set `Cout` / `hout`, after `aOut`/`bOut` are reconstructed from polar — but BEFORE `oklabToSrgbByte`. So it's a perceptual-space shift; oklabToSrgbByte's clipping handles any gamut excursions naturally.

**Composition.**
- Every other mechanic is a global mood overlay's friend — Distribution, Posterize, paletteSnap, zone routing all still run as usual; temperature just biases the final Oklab (a, b) before sRGB conversion.
- Composes with Passes — each pass's intermediate output gets warm-shifted, so multi-pass with temperature can compound the warmth/coolness across iterations.

**LUT-bakable.** Yes. Pure function of (R, G, B) → (R', G', B') via the rest of the pipeline plus a final constant (a, b) offset. Bakes into the Color Lookup adjustment layer like everything else.

**UI.** TEMPERATURE slider inline below ZONE RATIO. Range -100..+100% step 5, default 0%. Sign-prefixed value display.

**Future work.** Per-L modulation (only affect highlights / only affect shadows), per-C modulation (only affect saturated pixels), per-S modulation. Each adds one more slider. None changes the core math — just multiplies the relative-shift scalar by a per-pixel weight derived from Lin / Cin / Sin.

### 8.4i — Refinements (Phase 4.5n)

Two changes to existing knobs based on user feedback:

**INFLUENCE overdrive (zoneInfluence 0–200%).** Slider max raised from 100% to 200%, engine clamp from 1.0 to 2.0. Values above 100% over-rotate the smashed hue past the zone's hue and overshoot Csm past the cluster's chroma magnitude. Useful when the cluster's character is "right but underdone." `oklabToSrgbByte` clamps the result in-gamut.

**TEMPERATURE evolution: Phase 4.5m → 4.5o → 4.5p.**

- **4.5m** — uniform `(Δa, Δb)` bias: every pixel shifted, even if already on the slider's polarity. "Crank up warm on a warm image" did nothing visible to the warms (only cools migrated) but cooled the whole thing on `t < 0`.
- **4.5n** — polarity-aware, but lerped to **mirror** (`-warmth`) → warm pixels swung into green-blue at `|t|=1`. Perceptually a literal hue rotation, not a temperature shift.
- **4.5o** — polarity-aware, lerped to **neutral (0)** instead of mirror. Warm pixels desaturate toward gray. Still operated on **absolute** Oklab warm axis, so the user's complaint surfaced: "if the image is mostly warm, cranking warm does literally nothing." All pixels were on the same side of absolute zero → no migration.
- **4.5p (current)** — **image-relative**. The image's own estimated output-warmth median is the neutral center; "warm" / "cool" are defined relative to *that*, not relative to absolute zero. Even uniformly-warm images have above-median and below-median pixels, so the slider always has something to act on.

**Phase 4.5p math:**

```
medianW = estimatedOutputMedianWarmth   # computed at smash() time from 64 sample bakes
warmth  = aOut · WARM_A + bOut · WARM_B
relW    = warmth − medianW

sensScale  = 3^(2·sensitivity − 1)       # sensitivity 0 → 1/3, 0.5 → 1, 1 → 3
effective_t = min(1, |t| · sensScale)    # clamped so pixel cannot overshoot median

shouldShift = (t > 0 ∧ relW < 0) ∨ (t < 0 ∧ relW > 0)
if shouldShift:
    delta = −relW · effective_t          # migrate TOWARD median
    aOut += delta · WARM_A
    bOut += delta · WARM_B
```

```
warmth = aOut · 0.82 + bOut · 0.57             # project onto warm axis
shouldShift = (t > 0 && warmth < 0)             # warm slider, cool pixel
            ∨ (t < 0 && warmth > 0)             # cool slider, warm pixel
if shouldShift:
    newWarmth = warmth × (1 − |t|)              # NEW: lerp toward 0, never past
    Δproj = newWarmth − warmth
    aOut += Δproj × 0.82
    bOut += Δproj × 0.57
```

**Behavior table (Phase 4.5p):**

| Slider | Pixel above median (image-relative warm) | Pixel below median (image-relative cool) |
|---|---|---|
| `t = +0.5` (warm) | Untouched (same polarity) | Migrate halfway to median (gets warmer) |
| `t = +1.0` (warm) | Untouched | Reach median (warmth_out = median) |
| `t = −0.5` (cool) | Migrate halfway to median (gets cooler) | Untouched |
| `t = −1.0` (cool) | Reach median | Untouched |

`effective_t` is clamped at 1 (cannot overshoot past median) → the Phase 4.5o guarantee survives: warm source + `t=-1` still doesn't produce literal green/blue. Pixels reach the image's own median but no further.

**Phase 4.5p — Sensitivity slider.** New `temperatureSensitivity ∈ [0, 1]` controls how fast pixels migrate given their distance from median:

- `0.0` (soft, `sensScale = 1/3`) — only outliers (far from median) migrate appreciably; near-median pixels barely move. Smooth gradient.
- `0.5` (linear, `sensScale = 1`) — pixels migrate proportionally to their distance from median (default).
- `1.0` (sharp, `sensScale = 3`) — even pixels just past median migrate fully (clamped at median). Distinct warm/cool zones emerge.

**Median estimation** — at `smash()` time we run `applyTransform` (with `temperature=0` to break the recursion) at 64 RGB grid points (4×4×4), project each output onto the Oklab warm axis, and take the median. ~64 applyTransform calls per smash() — ~3ms on typical hardware. Snap-cached via `SmashCdfs`, recomputed only when controls change.

**Why this matches the user's intent.** Earlier 4.5o was correct math against an absolute reference but felt wrong because the absolute reference is unmoored from the actual image. The image-relative reference makes the slider always operate on the SPREAD within the current image — even uniformly-warm imagery has internal warmth variation, and that's what the user wants to grade.

Regression tests (both still pass):
- 4.5o no-cross-past-zero: warm source + t=-1 still keeps R−B ≥ 0 (because image-cool pixels migrate UP toward median, image-warm pixels migrate DOWN toward median — both stay positive when median > 0).
- 4.5p wiring: temperature produces measurable shift across a varied input set.

Only the warm-axis projection is modified; the perpendicular (green↔magenta) axis is preserved.

LUT-bakable. The median lives on engine output state, frozen by the time the LUT bake samples applyTransform.

### 8.4j — `zoneEdgeSoftness` + `zoneEdgeShift`: target-side L routing controls (Phase 4.5l)

**User vision** (verbatim): *"my target dynamic range of 5 zones has a lot of fall off, or snappy edges — we can blur or tighten those edges. We should also be able to MOVE those edges to COMPRESS their relationships."*

Where Phase 4.5j (§8.4f) defined *how a target pixel finds its source cluster* (1D nearest by `Lin` against `clusterLs`) and *what color it pulls from that cluster* (centroid ↔ sub-LUT lerp by `detailRichness`), this phase gives the user **explicit control over the L-axis routing function on the target side**: the shape of the boundaries between zones, where those boundaries land, and how the L range below/above a boundary is rescaled into the bands the engine sees.

This is a **target-side L remap that feeds zone routing**, not a change to the source clusters or their sub-LUTs. The clusters stay frozen at extraction time; only the function `Lin → (which cluster, how strongly)` becomes user-shapeable.

**Conceptual mapping (user words → engine math).** The user described three things, which collapse into two sliders:

| User language | What it controls | Engine surface |
|---|---|---|
| "blur or tighten edges" | Hardness of the boundary between two adjacent L-zones | Gaussian falloff width around each midpoint (soft assignment) |
| "MOVE those edges" | Position of each zone boundary along the L axis | Per-boundary L offset, applied to the natural midpoint between two centroid Ls |
| "COMPRESS their relationships" (e.g. 0–50% squished to 0–25%) | Nonlinear remap of target L *before* routing | Falls out for free from moving the boundaries — band widths are just `m_i − m_{i−1}` |

The third bullet is subsumed by the second: moving a boundary from L=0.5 to L=0.25 *is* compressing the [0, 0.5] target L range into the band that routes to the shadow cluster. No extra knob needed.

**What was added.** Two new sliders below DETAIL in `SmashSection.tsx`:

| Knob | Range | Default | What it does |
|---|---|---|---|
| `zoneEdgeSoftness` (EDGE SOFTNESS) | 0–1 | 0 | Hardness of zone boundaries. 0 = argmin (today's Phase 4.5j behavior, bit-identical). 1 = wide gaussian blur across neighbouring clusters. |
| `zoneEdgeShift` (EDGE SHIFT) | −1 to +1 | 0 | Slide all K−1 zone boundaries along the target L axis. Negative = shadow zones squeezed toward dark, mid/highlight zones expand. Positive = highlight zones squeezed. |

**Mechanism — sorted clusters and K−1 boundaries.** The current `clusterLs` is stored in k-means index order; for this mechanic the engine needs sorted-by-L access. The engine builds a `clusterOrderByL: Int32Array(K)` permutation (sorted_pos → kmeans_idx) at `smash()` time, leaving `paletteSnap`'s and `distribution`'s existing indexing untouched. Sorted centroid Ls `L_0 < L_1 < ... < L_{K-1}` then define K−1 natural boundary midpoints:

```
m_i^natural = (L_i + L_{i+1}) / 2          for i = 0..K-2
```

**Mechanism — boundary shift.** EDGE SHIFT warps the natural midpoints toward uniform spacing (`(i+1)/K`), with a sin-shaped bias function that lets central boundaries move more than the outermost two (so the darkest/lightest bands never collapse to zero width):

```
t = zoneEdgeShift                          # in [-1, +1]
bias_i = sin(π × (i+1)/K)                  # 0 at extremes, 1 at K/2
if t >= 0:
  m_i^shifted = m_i^natural + t × (1 − m_i^natural) × bias_i
else:
  m_i^shifted = m_i^natural + t × m_i^natural × bias_i
```

The K−1 shifted boundaries land in `SmashEngineOutput.zoneBoundaries: Float32Array(K-1)`, recomputed only when `clusterCount`, `clusterLs`, or `zoneEdgeShift` changes.

**Mechanism — soft assignment.** EDGE SOFTNESS replaces the hard `argmin |Lin − clusterLs[k]|` with a gaussian-weighted soft pick. Each cluster (in sorted-by-L order) gets a weight from its distance to `Lin`, with σ controlled by the slider:

```
σ = ε + zoneEdgeSoftness × σ_max           # σ_max = 0.10, ε ≈ 1e-4
w_k = exp(-(Lin − clusterLs[sorted_k])² / (2σ²))
w_k /= Σ w_k
(aZone, bZone) = Σ_k w_k × (centroid_k.ab + detail × (subLUT_k(Lin) − centroid_k.ab))
```

`σ_max = 0.10` in Oklab L is chosen so at softness=1 a typical 5-zone palette (centroids ~0.2 apart) sees neighbour weights ≈ exp(-2) ≈ 0.14 of the winner — a strong but not total blur. The short-circuit `softness < 0.005` falls back to the existing argmin path, preserving the cheap O(K)-compare + 1-subLUT-eval cost for users who don't engage the slider. At softness > 0, the per-pixel cost rises to K sub-LUT evals per pixel (~250 ns vs ~50 ns at K=5), still negligible inside the LUT bake.

**Engine state added.** Two new fields on `SmashCdfs` / `SmashEngineOutput`, computed once per `smash()` call (sub-millisecond, no allocations per pixel):

```typescript
clusterOrderByL: Int32Array;       // length K, sorted-pos → kmeans-idx permutation
zoneBoundaries:  Float32Array;     // length K-1, m_i^shifted ascending
```

Engine-time-only. Per-pixel hot path does one binary search (or linear scan, fine at K ≤ 32) over `zoneBoundaries` plus K gaussian evals. Neither slider triggers re-extraction — `clusterCount` (ZONES) is still the only knob that rebuilds the cluster table.

**Worked example (user's verbatim scenario).** 5 zones → 4 boundaries. Say sorted clusterLs = [0.10, 0.30, 0.50, 0.72, 0.90].

| | natural midpoint | after EDGE SHIFT = −0.5 | meaning |
|---|---|---|---|
| m₀ (shadow→darkmid) | 0.20 | 0.10 | shadow band squeezes from [0, 0.20] to [0, 0.10] |
| m₁ (darkmid→mid) | 0.40 | 0.25 | "1–50% squishes to 1–25%" — matches user's example |
| m₂ (mid→highmid) | 0.61 | 0.55 | mid band shifts down |
| m₃ (highmid→highlight) | 0.81 | 0.78 | highlight barely moves (outer bias) |

After the shift, target L values in [0.25, 0.55] route to the "mid" cluster (was [0.40, 0.61]). The middle grays are now darker, and the upper 50% of target L (0.50–1.0) gets spread across mid + highmid + highlight bands proportionally to the new boundaries.

If EDGE SOFTNESS is then turned up to 30%, the [0.25, 0.55] mid band still *dominates* in that L range, but pixels near 0.25 also pick up ~20% of the darkmid cluster's color, and pixels near 0.55 pick up ~20% of the highmid cluster's. The "snappy edges" become smooth crossfades.

**Composition with other Phase 4.5 mechanics.**

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

- **With INFLUENCE = 0**: zone path doesn't run; both new sliders are inert.
- **With ZONES change**: boundaries recompute automatically (depends on sorted clusterLs).
- **With ZONE RATIO** (4.5k): orthogonal — RATIO reweights how *source* contributes to the `distribution` mechanic; EDGE SHIFT moves where *target* hands off between zones during routing.
- **With DETAIL** (4.5j): unchanged composition. detail still controls centroid↔subLUT lerp inside each cluster's contribution, just now summed across K clusters instead of picked from one.
- **With softness=0 + shift=0**: output bit-identical to today's Phase 4.5j. Existing presets and LUT bakes remain stable.

**LUT bakability.** Yes. Both knobs are pure functions of (R, G, B) via `Lin` plus frozen engine state (`clusterOrderByL`, `zoneBoundaries`, sub-LUTs, centroids). Per-pixel cost: K gaussian evals + K sub-LUT lookups + a weighted sum; ~250 ns at K=5 with softness > 0, still well inside the 4096-cell LUT bake budget. At softness=0 the engine short-circuits to the existing single-cluster path and the bake cost matches Phase 4.5j byte-for-byte — a regression test guards exact-match against a frozen 4.5j bake.

**Persistence + recipe IO.** Two new fields on `colorization`:

```typescript
zoneEdgeSoftness?: number;   // [0, 1], default 0
zoneEdgeShift?: number;      // [-1, +1], default 0
```

Both get the standard `typeof === "number" && Number.isFinite(...)` + clamp guard at persistence restore. Both serialize in recipe v1.21+ alongside the slot already taken by `zoneInfluence` / `detailRichness` / `zoneRatio`.

**Open questions resolved.** The design doc raised six open questions (Q1–Q6) before implementation. All six were resolved per the design's recommended defaults: single global EDGE SHIFT (Q1), endpoint sliding rather than area-preserving compression (Q2), Path A boundary-aware routing rather than Path B L pre-warp (Q3), permutation index over in-place sort (Q4), SOFTNESS kept separate from DETAIL (Q5), zone-routing-only scope rather than coupling to posterize / distribution (Q6). Deferred to 4.5m if requested later: per-boundary K−1 sliders and a global `EDGE SQUEEZE` knob for pushing all boundaries toward/away from the L midpoint.

### 8.5 What's still on the roadmap (Phase 5+)

The four colorization mechanics in v1.1 §5 remain forward work:

- **Stochastic per-L-band sampling** (Toggle 2). Per-pixel random sample from source's bucket distribution. NOT LUT-bakable (same input → different output requires per-pixel state) but works as a panel-preview-only mode the user can rasterize.
- **Conditional CDF P(color | L)** (Toggle 3). Per-L bucket chroma distribution match, not just bucket mean. Adds within-L diversity in a LUT-bakable way.
- **Sliced optimal transport** (Toggle 4). Math-heavy, gives the strongest distribution preservation; benchmark before implementing.
- **Pre-shaping anchors** (§7). User-defined 1D LUTs per dimension applied before the CDF match. Composes with everything above.

The order is roughly: Phase 4.5d `paletteSnap` (shipping now) → Phase 5 conditional CDF (next likely) → Phase 6 anchors → Phase 7 stochastic preview mode → Phase 8 sliced OT.
