# ColorSmash — project-scoped instructions

## Parallel Pro / Smash branch policy

A **Pro tier** ("Smash Engine") is being developed in parallel on the
`feature/smash-v2` branch. This is a clustering-based pivot: source and
target images are broken into macro color "pools", each pool is analyzed
for its sub-palette, and that hierarchical profile is transferred onto the
target. When working on the regular ColorSmash plugin (`master`), follow
these rules:

### Retired — `feature/smash` (v1 archive, do not develop)

The original Smash Engine (per-aspect band transfer, optimal transport,
etc.) is **frozen** on `feature/smash` (pushed to `origin/feature/smash`,
tip `9b33684`). It is kept as a **reference archive only** — the v2
clustering approach replaces it. Do NOT develop, merge, or delete this
branch; read from it (`git show feature/smash:<path>`) if you want to
crib old code.

### Off-limits — never edit on master without coordinating

- `plugin/src/core/smash/**` (doesn't exist on master yet; Pro-only)
- `plugin/src/ui/smash/**` (doesn't exist on master yet; Pro-only)
- `plugin/src/core/perceptual/**` (doesn't exist on master yet; shared but introduced by Pro)
- `plugin/assets/reference.png`, `plugin/scripts/gen-reference-image.js`
- The `feature/smash-v2` and `feature/smash` branches themselves —
  do NOT check out, reset, force-push, delete, or merge from them.

### Edit with care — exist on master, modified on Pro

These four files were touched on the Pro branch. Edits here are fine but
flag them in commit messages so the Pro branch can merge cleanly:

- `plugin/package.json` (`build:free` / `build:pro` / `gen:reference` scripts added on Pro)
- `plugin/webpack.config.js` (DefinePlugin for `__SMASH_ENABLED__` added on Pro)
- `plugin/src/types/ambient.d.ts` (`__SMASH_ENABLED__` declaration added on Pro)
- `plugin/src/ui/Panel.tsx` (single `__SMASH_ENABLED__` ternary added on Pro)

### Refactors that need explicit coordination

If you plan to refactor `core/palette.ts`, `core/histogramMatch.ts`, or any
preset IO (`recipeIO.ts`, `persistence.ts`), **pause and check with the
user first** — the Pro branch is planning to extract `core/color/` shared
utilities and a preset format v2, both of which touch these files.

### What you CAN do freely

Everything else on `master` — `MatchTab.tsx`, `PaletteStrip.tsx`, `app/*`,
`services/photoshop.ts`, `manifest.json`, `README.md`, presets, settings,
UI work, new features that don't touch the off-limits paths. Commit and
ship as normal. The Pro branch periodically merges master in, so your
improvements flow forward automatically.
