# ColorSmash — project-scoped instructions

## Parallel Pro / Smash branch policy

A **Pro tier** ("Smash Engine") is being developed in parallel on a worktree
branch (currently `claude/musing-chandrasekhar-ed6125`; will be renamed to
`feature/smash`). When working on the regular ColorSmash plugin (`master`),
follow these rules:

### Off-limits — never edit on master without coordinating

- `plugin/src/core/smash/**` (doesn't exist on master yet; Pro-only)
- `plugin/src/ui/smash/**` (doesn't exist on master yet; Pro-only)
- `plugin/src/core/perceptual/**` (doesn't exist on master yet; shared but introduced by Pro)
- `plugin/assets/reference.png`, `plugin/scripts/gen-reference-image.js`
- The `feature/smash` / `claude/musing-chandrasekhar-ed6125` branch itself —
  do NOT check out, reset, force-push, delete, or merge from it.

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
