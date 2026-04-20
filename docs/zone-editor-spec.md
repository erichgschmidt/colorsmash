# Zone Editor — Spec

**Status:** Proposed feature. Not in current roadmap; would slot before or replace Phase 3 (protection masks).
**Last updated:** 2026-04-19

## One-line pitch
A Lumetri-Wheels-style color grading panel that compiles to a native Photoshop adjustment-layer stack with auto-tuned Blend If gating per tonal zone — no manual mask painting, fully editable after bake.

## Why
Photoshop has the raw primitives (Curves, Hue/Sat, Color Balance, Blend If) to do tonal-zone color grading, but wiring them up by hand is fiddly and the Blend If split-slider math is unintuitive. Color Smash already understands Reinhard math; with a zone editor we let users *direct* the grade rather than just transfer it from a reference.

## Product principles
1. **WYSIWYG preview before bake.** What the user sees in the panel is what the layer stack produces.
2. **Bake to native PS layers.** Output is a `.psd`-portable stack that makes sense to anyone who opens it, not opaque pixel data.
3. **Zones are editable forever.** After bake, dragging the Blend If sliders works; deleting a zone's layer disables that zone.
4. **No invented controls.** Every slider in the panel maps 1:1 to something a colorist already understands.

## Scope (v1)

### Zones
Three fixed zones: **Shadows**, **Midtones**, **Highlights**. (Generalization to N adaptive zones is v2 — see "Future" section.)

Each zone owns:
- **Range** — a luminance range with soft falloff (mapped to Blend If split sliders on bake)
- **Hue shift** — degrees ±180
- **Saturation** — ±100%
- **Value (lift)** — ±100 (Curves output offset at the zone's L midpoint)
- **Tint** — color picker (a/b shift toward picked hue, magnitude controlled by Saturation)

### Panel UI sketch
```
┌─ Color Smash · Zone Grade ──────────────────────┐
│ ┌─ Histogram preview ─────────────────────────┐ │
│ │ █▆▅▃▂▁                                      │ │
│ │ │ shadows │ midtones │  highlights  │       │ │
│ │ └─drag────┴──drag────┴──drag────────┘       │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ▸ SHADOWS                                       │
│   Hue:    ●━━○━━━ -30°    Sat:  ●━━━━○ +20%    │
│   Lift:   ●━━━○━━ -8       Tint: [■]            │
│                                                 │
│ ▸ MIDTONES                                      │
│   (collapsed; click to expand)                  │
│                                                 │
│ ▸ HIGHLIGHTS                                    │
│   Hue:    ●━━━━○ +60°     Sat:  ●━━━○━ -10%   │
│   Lift:   ●━━━━○ +15      Tint: [■]            │
│                                                 │
│ Preview: live · Bake: [        Apply        ]   │
└─────────────────────────────────────────────────┘
```

### Histogram + range editor
- Renders the active layer's luminance histogram
- Three colored bands overlay it (cool/neutral/warm or user-themed)
- Drag the boundaries to widen/narrow zones; drag the inner edges to soften/harden the falloff
- Boundary positions map directly to Blend If "underlying" split sliders on bake

### Live preview
- Plugin maintains a 256px downsampled version of the active layer
- On any slider change, runs the zone transform pure-TS on the downsample → renders to a preview thumbnail in the panel
- No PS round-trip; no apply needed for preview
- Full-res result happens only on Bake

### Bake output
For each non-zero zone, produce one Curves + one Color Balance adjustment layer (or Hue/Sat for hue+sat) with **Blend If** configured to gate that layer to the zone's range. Group as `[Color Smash] zones` with subgroups per zone.

```
[Color Smash] zones
├── Shadows (group)
│   ├── Hue/Sat (your shadow hue+sat)  · Blend If: U 0/15-85/95
│   └── Curves (your shadow lift)      · Blend If: U 0/15-85/95
├── Midtones (group)
│   └── ...
└── Highlights (group)
    └── ...
```

Empty zones emit nothing.

## Technical notes
- Blend If "underlying" split sliders: the four-slider model (black-low, black-high, white-low, white-high) directly encodes the band edges + feather. Plugin computes these from the user-specified range + falloff.
- Hue shift via Hue/Sat layer's master Hue slider.
- Saturation via Hue/Sat master Sat.
- Lift via Curves output offset at zone's L midpoint (single anchor + linear extrapolation).
- Tint via Color Balance midtones cyanRed/magentaGreen/yellowBlue derived from picked color in Lab.
- Live preview uses the same `simulateStack` machinery already built (extend with Blend-If simulation).

## Phasing

### v1 (zone editor MVP)
3 fixed zones, hue+sat+lift per zone, draggable range editor, live preview, bake to layer stack with Blend If.

### v2 (adaptive zones)
- N zones via k-means in Lab
- Auto-suggest zone count from histogram bimodality (silhouette score)
- User can add/remove zones manually
- Zones can be color-defined (e.g., "skin tones" via Lab/RGB cluster) not just luminance-defined

### v3 (Reinhard-as-zone-defaults)
- "Smart Suggest" button: runs current Reinhard algorithm to compute source→target shift, then auto-populates the zone editor with values that approximate the transfer
- User starts from the algorithmic suggestion and refines manually

### v4 (Cross-zone transitions)
- Detect seam artifacts between zones; auto-soften via Blend If feather expansion
- Preview shows seam highlights when too sharp

## Why this could be the headline feature
- Beats Lumetri because the output is a *Photoshop layer stack* the artist owns and can edit forever, not opaque parameters in an effect
- Beats DaVinci because it lives where photographers already work
- Beats hand-rolled Curves+Blend If because the Blend If math is automatic and previewable
- Differentiates Color Smash from "just another color matcher"

## Open questions
- Number of preset zone counts vs adaptive (user research needed)
- Should "Bake" replace any existing `[Color Smash]` group, or coexist?
- Zone editor and Reinhard transfer: parallel features or unified workflow?
