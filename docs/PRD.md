# Color Smash — Product Requirements Document

**Version:** v0.3
**Status:** Draft, pre-Phase 0
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
- **MVP:** Reinhard mean/σ transfer in Lab + gray-world neutralize + linear fade.
- **v2:** Sliced optimal transport for palette fidelity.
- **v3:** Skin/neutral-aware local transfer via segmentation.
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
