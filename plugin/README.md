# Color Smash — Plugin

UXP panel source for Color Smash. Manifest v5, apiVersion 2, TypeScript + React.

See the [repo root README](../README.md) for the user-facing feature list and install instructions.

## Layout
- `manifest.json` — UXP manifest (PS 25.0+)
- `src/ui/` — React panel (Match tab, preview, envelope/zone editors, hooks)
- `src/services/photoshop.ts` — only file allowed to call `photoshop` / `batchPlay`
- `src/core/` — pure-TS algorithms (histogram match, Lab, downsample, LUT writer). Unit-testable outside PS.
- `src/app/` — Apply orchestration (single Curves layer + multi-zone trio)
- `src/core/__tests__/` — vitest

## Dev
```
npm install
npm run build      # bundle to dist/index.js
npm run watch      # rebuild on save
npm test           # core unit tests
npm run typecheck
```

Load in Photoshop via UXP Developer Tool → Add Existing Plugin → select this folder's `manifest.json`.
