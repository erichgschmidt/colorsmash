# Color Smash — Product Requirements Document

**Version:** v0.3 (original draft) — superseded in practice by what shipped in v1.0–v1.2 (see §8 "Shipped" sections below)
**Status:** Historical draft. Actual shipped algorithm and architecture diverged from §5/§6.
**Last updated:** 2026-04-18

## 1. One-line pitch
A Photoshop plugin that recreates the intent of Photoshop's Match Color but emits it as a **live, editable stack of adjustment layers plus a generated 3D LUT** — fully non-destructive, tweakable, and exportable.

## 2. Why
Photoshop's Match Color is destructive, opaque, and hasn't meaningfully evolved. Artists want the same "transfer the look of image A onto image B" capability but with:
- editable sliders that stay editable after apply
- tonal-zone control (shadows/mids/highlights independently)
- protection for skin, neutrals, highlights
- exportable presets and LUTs that round-trip to other tools

## 3. Product principles
1. **Non-destructive by default** — every output is a toggleable, reorderable group.
2. **Three output modes:** editable stack, baked LUT, hybrid (default).
3. **Artist sliders on top, color science underneath.**
4. **Beat Match Color on editability + control**, not just raw accuracy.
5. **Future-proof data model** — transfers serialize to portable JSON + `.cube`, independent of Photoshop's layer representation.

## 4. Compatibility floor
- **Target:** Photoshop 25.0+ (late 2023), validated on 26.x and 27.x (2026).
- Manifest v5, apiVersion 2, SWC UI.
- No CEP / ExtendScript path. Users on older versions see a clear version-requirement message.
- Rationale and tradeoffs: see [decisions/00-compatibility.md](decisions/00-compatibility.md).

## 5. Algorithm core
- **Shipped (v1.0+):** Per-channel R/G/B histogram specification fitted to Curves control points; optional perceptual Lab-domain match sampled back to per-channel curves; Hue-only via PS Hue blend mode. Reinhard mean/σ was prototyped but not the shipped path.
- **v2 (future):** Sliced optimal transport for palette fidelity.
- **v3 (future):** Skin/neutral-aware local transfer via segmentation.
- **v4 (speculative):** Learned flow-based matcher as opt-in AI mode.

Details: see [algorithm.md](algorithm.md).

## 6. Output architecture — generated layer stack
```
▸ [Color Smash] group (opacity = Fade)
   ├── Color Lookup (generated 3D LUT)           ← main 3D transform
   ├── Curves (post-LUT tone)                    ← Luminance
   ├── Hue/Saturation (post-LUT chroma)          ← Color Intensity
   ├── Color Balance (residual neutralize)       ← Neutralize
   ├── Curves + Blend If (highlight protect)     ← Protect Highlights
   └── Group mask (skin ∪ neutral protection)    ← Preserve Skin / Neutrals
```

## 7. UI / controls (v1)
- **Sources:** pick source layer/doc, target layer, optional selections
- **Match:** Amount, Luminance, Color Intensity, Neutralize
- **Protection:** Preserve Skin, Preserve Neutrals, Protect Highlights
- **Mode:** Editable Stack / LUT only / Hybrid (default)
- Apply → builds group; light sliders live-edit helper layers; heavy params trigger "Rebuild LUT."

## 8. Technical architecture
- UXP panel, Manifest v5, apiVersion 2, TypeScript + React + SWC
- Imaging API for pixel reads/writes (with capability check — see decisions/03-pixel-access.md)
- Service layer isolates every `photoshop` DOM + `batchPlay` call
- Pure-TS algorithm core, unit-testable outside Photoshop
- LUT generator in TS; port to WASM (Rust) if perf demands
- Preset doc format: JSON + embedded `.cube`, version-tagged
- Action recording enabled (`enableMenuRecording: true`)

### Shipped in v1.2 (2026-04)
- Preset strip (Full / Color / Contrast) above matched preview, click-to-stage UX
- Export LUT button — bakes staged preset to portable 33³ Adobe `.CUBE` 3D LUT (sidesteps PS's flaky Color Lookup automation)
- Matched preview Before/After badge (click to toggle, click-and-hold to peek)

### Shipped in v1.4 → v1.7 (2026-05)
- **Source palette display strip** (v1.4, Phase A): k-means clustering in CIE Lab space, 3 / 5 / 7 swatch count toggle, sorted dark→light. Mirrors the active preset (Full = raw clusters, Color = pure-hue swatches with luminance flattened, Contrast = grayscale value strip).
- **Weighted palette bar** (v1.5+): proportional segments where each cluster's width = natural prevalence × user multiplier. Two drag modes — handle mode (default, white dividers redistribute weight pair-wise between adjacent neighbors, mass-conserving on the pair) and adaptive mode (`adapt` toggle, persisted: drag a swatch body to grow/shrink it; all other swatches rebalance proportionally to maintain their relative ratios). Reset returns all weights to neutral. The reweighted palette feeds both the live preview and the Apply Curves bake.
- **Selectrix-style log2 zoom slider** in the preview header — smooth fluid scrubbing alongside discrete −/+ buttons.
- **Preview header cleanup**: "Preview" label dropped; ⇄ swap moved flush-left so the zoom cluster owns the right side.
- **Performance** (v1.7): cluster-assignment cache (~10× faster palette synthesis during drag), double-buffered `<img>` swap with a latest-frame token (no flicker between frames), redraw throttle tightened from 33 ms to 16 ms (60 fps).

### Shipped in v1.10 (2026-05)
- **Hue and Saturation presets**: the preset strip grew from 3 to 5 entries — Full / Color / **Hue** / **Saturation** / Contrast — completing the H/S/L decomposition. Hue (PS Hue blend) transfers only the hue cast and is the gentler answer to Color's frequent over-saturation; Saturation (PS Saturation blend) is the symmetric case for matching vibrancy without shifting hue. Each new preset's source-strip swatch shows the source projected onto its characteristic visualization (Hue: pure-hue at fixed L=0.5 / max S; Saturation: grayscale heatmap of saturation level).
- **v1.10.1 fix**: adaptive palette drag now recovers cleanly from a fully-overscaled state (one swatch maxed, others at zero) — the freed budget redistributes by natural prevalence so the bar can be dragged back smoothly without leaving adapt mode or hitting Reset.

### Shipped in v1.8 → v1.9 (2026-05)
- **Target palette weight bar + softness** (v1.8): a second weight bar under the matched preview, mirroring the source palette's 3/5/7/handle/adapt UI but with different math — target weights control curve application strength per cluster (drag a swatch toward 0 to leave that color region untouched), source weights still bias the histogram fit. Mask toggle on the target header bakes the per-cluster attenuation as a layer mask on the output Curves layer. Softness slider (0..100) on each bar controls cluster-region falloff (hard nearest-cluster → smooth Lorentzian blend).
- **Zones accordion removed** (v1.8): superseded by the target palette weight bar. Cluster-based attenuation in Lab space is strictly more general than three fixed luma bands. ZoneOpts persistence still ships for backward-compat — older saved settings load cleanly but the UI is gone.
- **v1.9 polish**: reset buttons relocated next to the 3/5/7 count toggles and tinted coral as destructive actions; preview header restructured (swap + B/A flush left, zoom centered, bg + 1:1 right).

For the user-facing copy of all shipped features, the repo root [README](../README.md) is canonical — this PRD is kept as a historical design document.

## 9. Roadmap
See [roadmap.md](roadmap.md) for phase breakdown. High-level:
- **Phase 0:** Spike — prove Imaging API + math (1 wk)
- **Phase 1:** MVP editable stack (2–3 wks)
- **Phase 2:** LUT generation (2 wks)
- **Phase 3:** Protection masks (2–3 wks)
- **Phase 4:** Sliced OT + perceptual validation (3+ wks)
- **Phase 5:** Presets, Actions integration, marketplace submission
- **Phase 6 (future):** Semantic local transfer, ML mode

## 10. Non-goals (v1)
- CMYK, Grayscale, Indexed, Duotone documents
- Video/timeline color matching
- Pre-Photoshop-2024 support
- Real-time preview during slider drag (apply-on-click for v1)
- Cloud presets / account sync

## 11. Open questions
Tracked in [decisions/](decisions/) as they're resolved.
