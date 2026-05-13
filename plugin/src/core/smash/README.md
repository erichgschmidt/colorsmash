# core/smash — Pro Smash Engine primitives

This namespace holds all algorithm primitives for the Pro tier (Smash Engine).
See `ColorSmash_Masterplan_v1.md` for the full plan and `_04`/`_05`/`_06` for
the vision, audit, and inspiration that led here.

## Import boundary

**Free code MUST NOT import from `core/smash/`.** Reverse direction is fine —
Pro code freely imports from `core/`, `app/`, `services/`, etc.

The free build (`npm run build` / `build:free`) sets `__SMASH_ENABLED__` to
`false`. Any free code path that references Pro code is unreachable at runtime
and dead-code-eliminated by terser. But adding a static import of `core/smash/*`
from free code keeps the module in the bundle even if unused, which defeats the
size benefit. Until an ESLint rule enforces this, the rule is honored by
convention.

## What lives here

Per masterplan §3.1:

- `types.ts` — TypeScript structs for `SourceDNA`, `TargetStructure`,
  `SmashControls`, `SmashPreset`, `BandStats`, `ClusterStats`, `PixelFeatures`,
  `GlobalStats`. Pure types, no runtime code.
- `features.ts` (later) — per-pixel feature extraction (Oklab, LCh, neutral /
  accent scores).
- `bands.ts` (later) — adaptive band construction over Value / Hue / Sat / Chroma.
- `stats.ts` (later) — per-band statistics rollup.
- `clusters.ts` (later) — per-cluster stats (extends `core/palette.ts`).
- `profile.ts` (later) — `SourceDNA` × `TargetStructure` pairing.
- `transform.ts` (later) — per-band per-trait transform synthesis.
- `compress.ts` (later) — sliced OT compression (Pitié 2007).
- `gamut.ts` (later) — ACES vMM gamut compression.
- `lut.ts` (later) — Smash LUT generation.
- `audit.ts` (later) — `SmashAudit` data: which traits contributed, which bands
  fell back to identity, etc.

## Color science choices (pinned in masterplan §3.4)

- Oklab for new math; OkLCh for polar form.
- ΔE2000 for tests; Oklab Euclidean in engine.
- Sliced OT (5–10 random projections) for compression.
- ACES vMM for gamut compression.
- 33³ LUT default; 17³ preview-tier; 65³ optional high-quality.

## Status

Phase 0 — skeleton only. See masterplan §5 Phase 0.
