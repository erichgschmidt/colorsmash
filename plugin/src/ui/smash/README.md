# ui/smash — Pro Smash Engine UI

All Pro-tier panels, tabs, and components live under this folder.

See `ColorSmash_Masterplan_v1.md` §3.1 / §4 for module map and wireframe.

## Import boundary

**Free code MUST NOT import from `ui/smash/`.** The single exception is
`Panel.tsx`, which conditionally renders the Smash shell behind
`__SMASH_ENABLED__`. In the free build that constant is `false`, the ternary
folds, and terser DCE removes the Pro branch.

The reverse direction is unrestricted — Smash UI freely imports from `ui/`,
`core/`, `services/`, etc.

## What lives here

Phase 0 (shipped):
- `SmashTab.tsx` — placeholder content for the Smash mode.
- `ProShell.tsx` — top-level shell that wraps `MatchTab` and `SmashTab` with a
  simple tab strip. Only rendered in Pro builds.

Phase 1+ (per masterplan §5):
- `SourceDNAStrip.tsx`
- `TraitSliders.tsx`
- `RelationshipMatrix.tsx`
- `HueSatCurve.tsx`
- `SmashAudit.tsx`
- `RecipeMode.tsx`
- `RangeFields.tsx`
- `ShowInfluence.tsx`

## Status

Phase 0 — visible stub gated by `__SMASH_ENABLED__`. Functional Smash UI
arrives in Phase 1.
