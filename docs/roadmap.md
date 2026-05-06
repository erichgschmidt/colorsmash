# Color Smash — Roadmap

**Last updated:** 2026-04-18

See [PRD.md](PRD.md) for product context and [considerations.md](considerations.md) for pre-build decisions reflected here.

> **Note (2026-04):** Phases 0 and 1 below are historical — the spike used Reinhard mean/σ, but the shipped path (v1.0+) is per-channel histogram-specification fitted to Curves. The v1.1 and v1.2 sections further down reflect what's actually in the panel today.

## Phase 0 — Spike (1 week, historical)
**Goal:** Prove Imaging API + Reinhard math end-to-end.

- UXP skeleton on PS 25.0+, Manifest v5, apiVersion 2
- Imaging API pixel read of two layers (verify API status per considerations §22)
- Pure-TS Lab conversion + mean/σ computation (considerations §6, §7)
- Write flat result layer to target
- Stats computed on 512px downsample (§16)
- Golden-image test harness bootstrapped (§18, §19)

**Exit criteria:** result within ΔE < 5 of reference Reinhard implementation on 3 test pairs.

## Phase 1 — MVP editable stack (2–3 weeks)
**Goal:** Generate the adjustment-layer group, non-destructive, sliders wired.

- Build `[Color Smash]` group via batchPlay from computed params
- Sliders: Match Amount, Luminance, Color Intensity, Neutralize
- Apply-on-click UX (§15)
- Selection-aware stats (§11)
- Re-apply detection with Replace/Edit (§13)
- Single history step per apply (§14)
- Handle 8-bit + 16-bit RGB; convert-prompt for other modes (§9, §10)

**Exit criteria:** internal alpha usable on real photos; stack stays editable after apply.

## Phase 2 — LUT generation (partially shipped in v1.2)
**Goal:** Hybrid mode as default output.

**Shipped (v1.2, 2026-04):** Export LUT button — bakes the staged preset (curves + blend-mode emulation, including the non-separable Color and Luminosity blends) to a portable 33³ Adobe `.CUBE` file at a user-picked path. Sidesteps Photoshop's unreliable Color Lookup install path; user loads the LUT manually wherever (PS Color Lookup layer, Premiere, Resolve, etc.). Hybrid-mode (auto-installed Color Lookup layer alongside helper layers) remains future work.

- 33³ LUT generator from transfer function (pure TS)
- `.cube` writer
- Color Lookup layer installation via batchPlay
- Hybrid mode: LUT + helper layers
- LUT-only mode
- Start Adobe publisher profile paperwork (§3)

**Exit criteria:** LUT round-trips through DaVinci Resolve, Nuke, or a reference LUT viewer.

## Phase 2.5 — Zone Editor (proposed, ~2 weeks)
**Goal:** Lumetri-Wheels-style tonal-zone color grading that bakes to a native PS layer stack with auto-tuned Blend If gating.

See [zone-editor-spec.md](zone-editor-spec.md) for full design. May supersede or precede Phase 3.

## Phase 3 — Protection masks (2–3 weeks)
**Goal:** Preserve Skin, Preserve Neutrals, Protect Highlights.

- Color-range skin mask (pluggable for future Sensei swap — §23)
- Low-chroma neutral mask
- Blend If highlight gating
- Group mask composition
- Soft gamut compression slider (§8)

**Exit criteria:** portrait test set shows skin-ΔE improvement vs. no-protection baseline.

## Phase 4 — Sliced OT + perceptual validation (3+ weeks)
**Goal:** Advanced palette fidelity; measurable wins vs. native Match Color.

- Sliced optimal transport implementation
- "Palette Match Strength" slider
- Run test suite from research02 §7.1
- ΔE + histogram-distance metrics vs. Photoshop Match Color
- Perf profile — decide WASM port (§17)

**Exit criteria:** objective wins on ≥ 3 of 9 test categories; no regressions.

## v1.2 — Preset strip + LUT export (shipped, 2026-04)
**Goal:** One-click preset selection with portable LUT export for use outside Photoshop.

- Preset strip above the matched preview: three full-width swatches — **Full** (per-channel R/G/B match, Normal blend), **Color** (PS Color blend, transfers H+S, target keeps luma), **Contrast** (averaged R/G/B curve + Luminosity blend, transfers tonal curve, target keeps colors). Each swatch paints the source through that preset's transform.
- Click-to-stage: clicking a swatch updates the matched preview live but does not write to PS — Apply Curves bakes whatever's staged (non-destructive UX).
- **Export LUT** button (50/50 with Apply Curves): bakes staged preset to a 33³ Adobe `.CUBE` file. Loadable in PS Color Lookup, Premiere, Resolve, etc. Captures non-separable Color/Luminosity blend math a Curves layer cannot.
- Matched preview gets a Before/After corner badge (click toggles persistent, click-and-hold peeks momentarily).
- Layout cleanup: target picker is now a single horizontal row above the matched preview; source picker matches the same `[source ▼] [layer/mode ▼] [⟳]` pattern.
- Internal: repeated Apply Curves no longer nests `[Color Smash]` groups inside one another.

## v1.10 — Hue + Saturation presets (shipped, 2026-05)
**Goal:** Complete the H/S/L decomposition of the preset strip and clean up an adapt-mode degenerate state.

- **Hue preset** (PS Hue blend): transfers only the source's hue cast; target keeps its own saturation and luma. The gentler alternative to Color, which transfers H+S and frequently over-saturates — Hue is what users often actually wanted when reaching for "shift the color cast."
- **Saturation preset** (PS Saturation blend): symmetric case — matches the source's vibrancy without shifting hue. "Make this image as punchy as that reference."
- Preset strip now has 5 entries — **Full · Color · Hue · Saturation · Contrast** — covering every combination of H / S / L transfer. The new swatches render the source on their characteristic visualization: Hue as pure-hue at fixed L=0.5 / max S, Saturation as a grayscale saturation heatmap (vibrant = bright, neutral = dark).
- **v1.10.1 fix**: adaptive palette drag now recovers cleanly from a fully-overscaled state (one swatch maxed, others at zero) — previously the bar was stuck and required leaving adapt mode or hitting Reset to recover. Recovery redistributes the freed budget by natural prevalence so dragging flows smoothly.

## v1.9 — Target palette polish (shipped, 2026-05)
**Goal:** Tighten the v1.8 dual-palette UI.

- Reset buttons moved next to the 3/5/7 count toggle in both source and target palette headers; styled with a reddish coral tone (#d87a7a) to read as a destructive action.
- Preview header restructured: swap + Before/After cluster flush left, zoom controls (− slider +) centered, background + 1:1 right.
- Documentation pass — Zones references removed from user-facing copy now that the section is gone from the UI.

## v1.8 — Target palette weight bar + softness (shipped, 2026-05)
**Goal:** Replace the fixed-luma-band Zones panel with a strictly more general per-cluster targeting tool.

- **Target palette weight bar** under the matched preview. Mirrors the source palette UI (3/5/7 count toggle, handle/adapt drag modes, dark→light sort, Reset) but with different math: source weights bias the histogram fit (which source colors influence the curves), target weights control curve application strength per cluster (drag a target swatch toward 0 to leave that color region untouched while the rest gets matched).
- **Mask toggle** on the target palette header (default on). When on, the per-cluster attenuation produces a layer mask on the baked Curves layer in addition to feathering the preview. When off, both preview and bake skip the mask — uniform curves. A/B compare with one click.
- **Softness slider** below each palette bar (0..100). 0 = hard nearest-cluster boundary, 100 = smooth Lorentzian blend across all clusters. Source and target each have their own slider; both are persisted. Feathering visible immediately on the bar itself.
- **Adaptive mode** clarified: in adapt, dragging a swatch BODY grows/shrinks it and all others rebalance proportionally. White boundary markers stay visible as non-interactive visual guides.
- **Zones accordion section removed.** The cluster-based bar is strictly more general than the old three fixed luma bands. ZoneOpts persistence still ships for backward-compat with saved settings — they load cleanly, but there's no longer a UI to edit them.

## v1.7 — Weighted palette + perf polish (shipped, 2026-05)
**Goal:** Bias the match toward a specific accent color in the reference, with real-time response.

- **v1.4 — Source palette display strip (Phase A):** k-means in CIE Lab space, 3 / 5 / 7 cluster count toggle, swatches sorted dark→light, mirrors the active preset (Full = raw clusters, Color = pure-hue swatches with luminance flattened, Contrast = grayscale value strip). Display-only; no influence on the match yet.
- **v1.5 — Weighted palette bar:** proportional segments (width = natural prevalence × user multiplier). Handle mode (default): drag white dividers between segments to redistribute weight pair-wise between adjacent neighbors, mass-conserving on the pair. The reweighted palette synthesizes a biased source that drives both the live preview and the Apply Curves bake.
- **v1.6 — Adaptive drag mode:** `adapt` toggle (persisted) flips the bar from handle-drag to swatch-body-drag — drag the body of any swatch to grow/shrink it, and every other swatch rebalances proportionally to maintain its relative ratio. Symmetric across all swatches regardless of position. Reset button returns all weights to neutral (×1).
- **v1.6 — Selectrix-style log2 zoom slider** in preview header: `<input type="range">` on a log2 axis (step 0.05) between − and + buttons, so each unit doubles/halves zoom. Smooth fluid scrubbing complementing the discrete buttons.
- **v1.6 — Preview header cleanup:** "Preview" label removed; ⇄ swap moved flush-left so the zoom cluster owns the right.
- **v1.7 — Performance:** cluster-assignment cache (~10× faster palette synthesis during drag), double-buffered `<img>` swap with a latest-frame token (no flicker between frames), redraw throttle tightened from 33 ms to 16 ms (60 fps).

## v1.1 — Multi-zone Curves (shipped, 2026-04)
**Goal:** Spatially-aware grading that adapts across mixed-lighting scenes.

- Apply emits 3 stacked Curves layers (Shadows / Mids / Highlights), each fitted from only the pixels in its luma band
- Band limiting via paintable luminosity layer **Mask**, **Blend If** (Layer Style → Blending Options), or **Both**
- **Adaptive bands**: peaks shift to the target's P10/P50/P90 luma percentiles and outer extents follow the histogram's actual min/max, so each band gets a meaningful pixel sample on low-key / high-key scenes
- Each output layer is independently editable in PS afterward (mask paintable, curve tweakable, Blend If draggable)

## Phase 5 — Ship
**Goal:** Marketplace submission.

- Preset JSON schema finalized
- Action recording polish (`enableMenuRecording`)
- Privacy policy, support site, docs
- Screenshots, demo video
- `.ccx` packaging + private-distribution beta
- Public submission

## Reinhard accuracy roadmap (parallel track)
See [accuracy-plan.md](accuracy-plan.md). Current = Draft mode (shipping). Robust mode (PS-validated fitter, denser calibration, more layer types) is post-launch polish.

## Phase 6 — Future
- Sensei-driven semantic local transfer
- Multi-LUT region-aware output
- Optional ML matcher (flow-based / cmKAN-style) as WASM module
- 32-bit / HDR support
- Cloud preset sync
