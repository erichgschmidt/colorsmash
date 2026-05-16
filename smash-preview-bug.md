# Smash preview bug — diagnostic findings

**Status:** Root cause identified with high confidence from static reading.
**Scope:** READ-ONLY investigation. No source code changed.

---

## Symptom recap

1. Smash mode, all controls at defaults → matched-preview tile shows a dull / near-monochrome result.
2. Touching ANY slider (even a no-op click) → preview brightens (more saturation, more colour variation).
3. Two screenshots with identical settings look different (one dull, one vibrant).
4. Apply always writes the DULL version to the PSD; it never matches the vibrant preview.

---

## Root cause (ranked)

### CAUSE #1 — primary: the preview-apply effect re-runs against a *newer* `tgt.snap` than the one the engine was built from. A double-application via a stale snapshot.

This is the confirmed instance of the "stale-preview multi-pass" phenomenon the codebase itself documents (`SmashSection.tsx:184-188` — the PASSES slider comment explicitly says it *emulates* "the look the user accidentally discovered when the panel snap captured a post-LUT version of the target layer").

**The chain of inputs that diverge:**

- `MatchTab.tsx:675` — `const tgt = useLayerPreview(tgtDocId, targetId);`
- `SmashSection` receives `targetSnap={tgt.snap}` (`MatchTab.tsx:3881`).
- `SmashSection`'s `snapDerived` useMemo (`SmashSection.tsx:451-462`) and `pipeline` useMemo (`:479-505`) are keyed on `targetSnap`. So is the parent's preview-apply `useEffect` (`MatchTab.tsx:1285-1337`, deps `[smashMode, smashPreviewLut, tgt.snap]`).
- The engine LUT (`smashPreviewLut`, `MatchTab.tsx:1279-1283`) is baked from `smashEngine`, which is set by `SmashSection`'s `onEngineChange` effect (`SmashSection.tsx:516-522`).

**Why `tgt.snap` changes by itself.** `readLayerPixels` (`photoshop.ts:75-117`) calls `imaging.getPixels({ documentID, layerID })`. For a **pixel** target layer that has a "Smash LUT" Color Lookup *adjustment layer* stacked above it, `getPixels(layerID)` returns that layer's *own* pixels — clean. But the snapshot is re-captured under several triggers, and the engine + preview can desynchronise across those re-captures:

- `useLayerPreview` re-runs `refresh()` whenever `docId`/`layerId` change or on explicit Refresh (`useLayerPreview.ts:43-83`).
- The global PS notification listener (`MatchTab.tsx:596-620`) fires on `set`, `make`, `select`, `historyStateChanged`, etc. — i.e. it fires when Apply installs the "Smash LUT" layer. It does **not** itself call `tgt.refresh()`, but it calls `refreshTgtLayersRef.current()` and sets `stale=true`; layer-list churn there can change `targetId` identity, which *does* re-trigger `useLayerPreview.refresh()`.
- The "Test Bake" path (`SmashSection.tsx:734-753`, `MatchTab.tsx:3883-3900`) pushes `bakeTargetPerPixel` pixels straight into the tile via `showAfter`, bypassing the LUT preview entirely.

When the snapshot is re-captured **after** the user (or a prior session) has Applied a "Smash LUT" layer, and the chosen target is the *composite* / a group / a layer that sits *below* a visible "Smash LUT", `getPixels` returns **already-graded pixels**. The engine then matches an already-graded image → effectively a second pass → vibrant. A clean snapshot → honest single application → dull. Nothing in `readLayerPixels` / `useLayerPreview` hides or excludes existing "Smash LUT" / "Color Lookup" layers before snapping (verified: no such logic exists in `photoshop.ts` or `useLayerPreview.ts`). `applySmashLut` (`applySmashLut.ts:135-258`) installs the Color Lookup layer **above the active layer** and can later be picked up by the next snapshot.

### CAUSE #2 — contributing: a stale-display ordering bug between `onEngineChange` → `smashEngine` → `smashPreviewLut` → preview-apply effect.

The preview-apply `useEffect` (`MatchTab.tsx:1285-1337`) lists deps `[smashMode, smashPreviewLut, tgt.snap]`. On the **first** mount in Smash mode the ordering is racy:

- `smashEngine` starts `null` (`MatchTab.tsx:1057`), so `smashPreviewLut` is `null`, so the effect early-returns at `:1288`.
- `SmashSection` mounts, its `pipeline` memo runs, and its `useEffect([pipeline])` (`:516-522`) calls `onEngineChange(engine)` → `setSmashEngine`. That is a **commit-phase** setState on the parent, scheduled *after* the parent already committed. It triggers a second parent render → `smashPreviewLut` bakes → effect runs.
- But `SmashSection`'s mount also runs an async settings restore (`:282-425`) that calls `setAmount`, `setPasses`, `setProportionMatch`, etc. Each restored value re-runs the `pipeline` memo and re-fires `onEngineChange`. If the restore resolves *after* the first preview render, the first tile is painted from the **DEFAULT-controls engine**, then the **restored-controls engine** lands a beat later.

So the very first tile can show the default-control look, and the first user interaction simply forces the latest (restored-or-changed) engine to flush. A slider touch changes a control → `pipeline` memo re-runs → `onEngineChange` → `setSmashEngine` → `smashPreviewLut` re-bakes → preview-apply effect re-runs → tile repaints with the *current* engine. The "touch fixes it" behaviour is exactly this forced flush picking up whatever the freshest engine/snapshot pair is.

### Why Apply outputs the DULL version

Apply and preview can be fed **different engines and/or different pixels**:

- **Preview** = `smashPreviewLut` (a **17³** LUT, `MatchTab.tsx:1282`) trilinearly interpolated over `tgt.snap` pixels (`:1294-1335`).
- **Apply** = `applySmashLut(pipeline.engine, …)` (`SmashSection.tsx:681`) → bakes a **33³** LUT (`applySmashLut.ts:140`) and installs it as a Color Lookup layer that PS applies to *whatever is actually under it in the document*.

Two independent divergences:

1. **Engine identity.** `onApply` uses `pipeline.engine` — `SmashSection`'s **current** memo value. The preview uses `smashEngine` — the parent state, updated only via the commit-phase `onEngineChange` effect. If a control changed and the effect hasn't flushed (or the preview is still showing a Test-Bake / stale frame), `pipeline.engine` ≠ `smashEngine`. Apply uses one, the tile shows the other.
2. **Input pixels.** The vibrant preview is (per Cause #1) produced from an *already-graded* `tgt.snap`. Apply's Color Lookup layer is applied by PS to the *clean* document layer underneath — a true single pass — so the canvas honestly shows the single-application (dull) result. The preview's vibrance was an artefact of double-grading a stale snapshot; Apply, being a real one-pass operation in PS, can never reproduce it.

Grid resolution (17³ preview vs 33³ apply) is a *secondary* contributor — it shifts colours slightly but cannot account for a dull↔vibrant swing on its own.

---

## Evidence index (file:line)

| Evidence | Location |
|---|---|
| Target snapshot taken via `getPixels(layerID)`, no adjustment-layer exclusion | `plugin/src/services/photoshop.ts:75-117` |
| Snapshot re-capture triggers (layer/doc change, Refresh) | `plugin/src/ui/useLayerPreview.ts:43-83` |
| PS notification listener fires on `set`/`make`/`historyStateChanged`, churns layer list | `plugin/src/ui/MatchTab.tsx:596-620` |
| `smashEngine` initial `null` | `plugin/src/ui/MatchTab.tsx:1057` |
| 17³ preview LUT bake | `plugin/src/ui/MatchTab.tsx:1279-1283` |
| Preview-apply effect, deps `[smashMode, smashPreviewLut, tgt.snap]` | `plugin/src/ui/MatchTab.tsx:1285-1337` |
| `onEngineChange` wiring → `setSmashEngine` | `plugin/src/ui/MatchTab.tsx:3882` |
| `SmashSection` `pipeline` memo | `plugin/src/ui/smash/SmashSection.tsx:479-505` |
| Commit-phase `onEngineChange` effect (documented anti-pattern fix) | `plugin/src/ui/smash/SmashSection.tsx:516-522` |
| Async settings restore re-firing `pipeline` after first paint | `plugin/src/ui/smash/SmashSection.tsx:282-425` |
| PASSES comment: explicit reference to the "stale snap captured a post-LUT version" phenomenon | `plugin/src/ui/smash/SmashSection.tsx:184-188` |
| Apply uses `pipeline.engine` + bakes 33³ | `plugin/src/ui/smash/SmashSection.tsx:681`, `plugin/src/app/smash/applySmashLut.ts:140` |
| Apply installs Color Lookup layer above active layer (feeds next snapshot) | `plugin/src/app/smash/applySmashLut.ts:181-223` |

---

## Recommended fix

Three layers; do all three.

1. **Snapshot in isolation, excluding prior Smash LUT layers (fixes Cause #1, the dull↔vibrant swing).**
   Before `imaging.getPixels` runs in `useLayerPreview`/`readLayerPixels`, temporarily hide every adjustment layer named `"Smash LUT"` / type `colorLookup` in the doc (or pass the appropriate isolation flag), capture, then restore visibility — all inside the existing `executeAsModal`. This guarantees the engine always matches the *clean* target, so the preview equals a true single application and equals what Apply produces. This is the load-bearing fix; without it the preview is fundamentally lying.

2. **Single source of truth for the engine (fixes Cause #2 + Apply divergence).**
   Make Apply consume the *same* engine the preview shows. Either: have `onApply` use the engine that was last sent through `onEngineChange` (lift it to a ref that both the preview LUT and Apply read), or have the parent own the engine and pass it down. Today `pipeline.engine` (child memo) and `smashEngine` (parent state) can transiently disagree.

3. **Make the first preview deterministic (polish for Cause #2 first-paint race).**
   Gate the preview-apply effect — or the first `onEngineChange` — until `SmashSection`'s async settings restore (`loadedRef.current`) has resolved, so the first tile is painted from the restored-control engine, never the transient default-control engine. Optionally bake the preview LUT at 33³ to match Apply's grid and remove the secondary resolution mismatch.

After (1)+(2), "touching a slider" becomes a true no-op visually, the two screenshots become identical, and Apply's PSD output matches the tile.
