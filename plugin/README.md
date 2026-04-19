# Color Smash — Plugin

Phase 0 spike scaffold. UXP, Manifest v5, apiVersion 2, TS + React.

## Layout
- `manifest.json` — UXP manifest (PS 25.0+)
- `src/ui/` — React panel
- `src/services/photoshop.ts` — only file allowed to call `photoshop` / `batchPlay`
- `src/core/` — pure-TS algorithm (Lab, Reinhard, downsample). Unit-testable outside PS.
- `src/app/runSpike.ts` — Phase 0 end-to-end orchestration
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

## Phase 0 spike flow
1. Open a PS doc with ≥ 2 layers (bottom = source, top = target).
2. Click "Run Reinhard transfer" in the panel.
3. New layer `[Color Smash] Result` is created with the matched pixels.

Exit criteria: ΔE < 5 vs reference Reinhard on 3 test pairs (golden harness — TODO).
