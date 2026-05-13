# app/smash — Pro Photoshop integration

Pro-tier Photoshop UXP integration code lives here. The free `app/` folder
contains shipped integration for the Match workflow; this folder contains
the equivalent for the Smash Engine.

## Import boundary

Free code MUST NOT import from this folder. Pro code (anything under
`core/smash/`, `ui/smash/`, or `app/smash/`) may import freely from
`app/`, `core/`, and `services/`.

## Status

Phase 1:

- `applySmashLut.ts` — installs a Smash-baked 33³ LUT as a Color Lookup
  adjustment layer via batchPlay. Reuses the ICC prefix/suffix bytes
  from `_iccTemplate.ts` but builds the CLUT directly from the engine's
  float LUT (the existing iccGen.ts builds from ChannelCurves).

Phase 2+:

- Group placement (`[Color Smash Pro]` container)
- Selection-aware install (focus / exclude marquee → layer mask)
- Target-palette mask integration
- Multi-LUT region installs
- Live LUT mode (in-place update of an existing Color Lookup layer)
