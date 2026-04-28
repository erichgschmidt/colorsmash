# Color Smash — Roadmap

**Last updated:** 2026-04-18

See [PRD.md](PRD.md) for product context and [considerations.md](considerations.md) for pre-build decisions reflected here.

## Phase 0 — Spike (1 week)
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

## Phase 2 — LUT generation (2 weeks)
**Goal:** Hybrid mode as default output.

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
