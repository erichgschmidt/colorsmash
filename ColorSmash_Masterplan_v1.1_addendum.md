# ColorSmash Masterplan v1.1 — Addendum

Last updated: 2026-05-13
Applies to: `ColorSmash_Masterplan_v1.md`
Branch context: `feature/smash`, Phase 1 in progress

---

## 1. Purpose

This addendum captures a UI architecture decision made during Phase 1 implementation and testing. It supersedes v1 §4.1 (mode hierarchy) and §4.2 (Smash panel wireframe); all other sections of the v1 masterplan remain authoritative. The decision originated from direct user feedback during Phase 1:

> "I envisioned somewhat, that the UI for these pro features could be integrated to the left of the preview, so that you can switch between various controls without straying too far. … We can leverage the original preview and source/target selection. Maybe have a Color Match mode and a Smash mode UNDER the preview window, that will swap out the Match UI with the Smash UI. That way we can not bloat with redundant functions, and stay within the panel."

That feedback crystallized a concrete architectural shift: instead of a separate Smash tab with its own layer pickers and preview, Smash becomes an in-panel mode inside the existing MatchTab.

---

## 2. What changed and why

### v1 plan vs. v2 architecture

| Dimension | v1 Masterplan (superseded) | v2 Architecture (this addendum) |
|---|---|---|
| Panel structure | ProShell wraps MatchTab + SmashTab as peer tabs | One MatchTab; Smash is a mode inside it |
| Layer pickers | Duplicated in each tab | Shared; owned by MatchTab, consumed by both modes |
| Preview | Each tab had its own preview | One `<MatchedPreview>` component; transform varies by mode |
| Mode toggle | Top-level tab strip | `[Color Match · Smash]` pill toggle below the preview |
| PRO badge | Implicit via separate tab | Inline chip next to the Smash pill |
| `SmashTab.tsx` | Top-level Pro panel | Deprecated; replaced by slim `SmashSection.tsx` |
| `ProShell.tsx` | Tab-strip wrapper for MatchTab + SmashTab | Deprecated; removed once integration lands |
| `Panel.tsx` branch | `__SMASH_ENABLED__ ? <ProShell /> : <MatchTab />` | Just `<MatchTab />` in both builds |

### Rationale

- **No duplicate layer pickers.** Source and target selection live once; both modes read the same selections.
- **No parallel preview.** One preview component, one Before/After badge, one refresh callback. The transform baked into the preview changes by mode.
- **Cross-mode A/B is free.** Toggling `Color Match ↔ Smash` shows the same source through two transforms in the same preview tile — a before/after comparison across modes without any extra UI work.
- **Smaller panel surface.** The panel stays inside its existing footprint. No second tab inflates the navigation bar.
- **Shared infrastructure.** MatchTab's existing layer snapshot pipeline, error handling, and preview lifecycle are reused rather than duplicated.

---

## 3. The mode toggle

### Placement

Directly below the matched preview, above the mode-specific lower controls.

### Visual sketch

```
┌─ MatchTab ──────────────────────────────────────────┐
│  [Source: layer ▼]   [Target: layer ▼]              │
│                                                      │
│  ┌──────────────── Matched Preview ───────────────┐  │
│  │                                                │  │
│  │              (preview tile)                    │  │
│  │                                [Before/After]  │  │
│  └────────────────────────────────────────────────┘  │
│  [Refresh ↺]                                         │
│                                                      │
│  ╔═══════════════════════════════════════════════╗   │
│  ║  [ Color Match ]   [ Smash  PRO ]             ║   │
│  ╚═══════════════════════════════════════════════╝   │
│                                                      │
│  ╌╌╌╌ mode-specific lower controls ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Behavior

- **Color Match pill** — default; active in free builds and Pro builds. Renders the existing palette strips, preset row, dimensions, zones, envelope, and the Apply Curves / Apply LUT / Export LUT buttons. Identical to the shipped MatchTab lower section.
- **Smash pill** — visible only when `__SMASH_ENABLED__` is true. A small `PRO` chip appears inline with the pill label. When active, the lower section swaps to `SmashSection`: DNA strip, Smash Amount slider + preset row, audit panel, Apply / Export .cube.
- **Free builds** — the toggle is never rendered. `MatchTab` renders its current lower section unconditionally. Terser DCE removes all Pro-only code paths. Free binary is byte-equivalent to today's shipped product.
- **Mode is not persisted across sessions** — always opens in Color Match.

---

## 4. State sharing

### MatchTab-owned (shared across modes)

| State | Type | Notes |
|---|---|---|
| `sourceDocId` | `number` | Active Photoshop document id |
| `sourceLayerId` | `number` | Selected source layer |
| `targetDocId` | `number` | Active document for target |
| `targetLayerId` | `number` | Selected target layer |
| `srcSnap` | `PixelData` | Source layer pixel snapshot |
| `tgtSnap` | `PixelData` | Target layer pixel snapshot |
| `matchedPreviewRef` | `React.RefObject<MatchedPreviewHandle>` | Imperative handle to `<MatchedPreview>` |
| `onRefresh` callback | `() => void` | Triggers fresh snapshot + preview recompute |
| `activeMode` | `'match' \| 'smash'` | Controls which lower section renders (Pro builds only) |

### Mode-specific (not shared)

**Match mode** — palette weights, palette count (3/5/7), dimensions (Full/Color/Hue/Sat/Contrast), zone softness, envelope, Apply/Export targets. All existing state; untouched.

**Smash mode** — Smash Amount, DNA strip display state, per-trait slider values, audit panel open/closed, engine output (`SmashEngineResult`). Owned by `SmashSection` and lifted to MatchTab only as needed via `onEngineChange`.

---

## 5. Live preview integration

Smash mode drives the existing `<MatchedPreview>` component through a single callback chain. No changes to `MatchedPreview` itself.

1. `SmashSection` computes a `SmashEngineResult` whenever controls change (Amount, traits, DNA). It calls `onEngineChange(result)` — a prop passed down from MatchTab.
2. MatchTab's `onEngineChange` handler applies the engine result to the source snapshot pixels. Implementation is TBD between two options:
   - **Per-pixel `applyTransform`** — lower memory, acceptable at 17³ preview tier resolution.
   - **Baked LUT** — MatchTab bakes the engine result to a 17³ LUT once and applies via the existing LUT path. Reuses preview infrastructure directly; preferred for consistency.
3. MatchTab pushes the resulting RGBA buffer to `matchedPreviewRef.current.setPixels(rgba)` — the same imperative call Match mode already uses when its sliders change.
4. `<MatchedPreview>` renders. No code changes needed in the component.

The two-tier preview schedule (17³ during drag, 33³ on commit) from v1 §4.6 applies to Smash mode identically — the bake tier simply uses `SmashEngineResult` as its input rather than the Match engine.

---

## 6. Free / Pro separation

The following are all wrapped in `__SMASH_ENABLED__` guards and absent from free builds:

- The `[Color Match · Smash]` mode toggle render path inside MatchTab.
- The `activeMode` state and the conditional branch on `activeMode`.
- The `onEngineChange` callback and the Smash → preview pixel pipeline.
- The `SmashSection` component import and render.
- All `core/smash/` engine calls triggered from MatchTab.

Free builds compile `MatchTab` with none of the above. The lower section renders unconditionally as Match controls. Webpack's dead-code elimination removes the gated branches entirely from the free `.ccx`.

The free and Pro builds share the same `<MatchedPreview>` component, the same layer picker UI, and the same snapshot / refresh infrastructure. Those are not gated.

---

## 7. Deprecations

The following files are deprecated and will be removed once the MatchTab integration lands and has been smoke-tested.

### `plugin/src/ui/smash/ProShell.tsx`

Originally responsible for wrapping `MatchTab` and `SmashTab` as peer tabs in a Pro-only tab strip. With the mode toggle moved inside MatchTab, ProShell has no remaining responsibility. To be deleted.

### `plugin/src/ui/smash/SmashTab.tsx`

The standalone top-level Pro panel with its own layer pickers and preview. Replaced by `SmashSection.tsx` — a slim, props-driven component that receives source/target snapshots from MatchTab and renders only the Smash-specific lower controls (DNA strip, Amount slider, preset row, audit panel, Apply / Export). `SmashTab.tsx` is to be deleted after `SmashSection.tsx` is integrated and verified.

### `plugin/src/ui/Panel.tsx` — branch simplification

The current branch `__SMASH_ENABLED__ ? <ProShell /> : <MatchTab />` becomes simply `<MatchTab />` in both builds. The mode toggle is internal to MatchTab; Panel.tsx no longer needs to know about the Pro/free distinction at the top level.

---

## 8. Implementation order

These map directly to the remaining work for the Phase 1 "Pro alpha foundation" milestone.

1. **Build `SmashSection.tsx`** — slim, props-driven component: receives `srcSnap`, `tgtSnap`, emits `onEngineChange`. No pickers, no preview. Agent O has this in flight.
2. **Add `activeMode` state and toggle UI to MatchTab** — gated by `__SMASH_ENABLED__`. Renders the `[Color Match · Smash PRO]` pill row; default is `'match'`. Free builds see no change.
3. **Branch MatchTab's lower content on `activeMode`** — when `'match'`, render existing controls unchanged. When `'smash'`, render `<SmashSection>`.
4. **Route Smash engine output to preview** — wire `onEngineChange` in MatchTab: bake or apply the engine result, call `matchedPreviewRef.current.setPixels()`.
5. **Remove ProShell and SmashTab; simplify Panel.tsx** — delete deprecated files, update Panel.tsx to unconditional `<MatchTab />`.

Steps 1 and 2 are independent and can proceed in parallel. Step 3 depends on both. Steps 4 and 5 depend on step 3.

---

## 9. Phase 1 checklist update

This supersedes the Phase 1 status tracking implied by v1 §5.

### Completed (as of this addendum)

1. Feature extraction (`features.ts`) — done.
2. Band construction (`bands.ts`) — done.
3. Per-band stats (`stats.ts`) — done.
4. DNA pairing (`profile.ts`) — done.
5. Per-band match (`transform.ts`) — done.
6. LUT bake (`lut.ts`) — done.
7. Source DNA strip UI (`SourceDNAStrip.tsx`) — done.
8. Smash Amount + preset row — done.
9. Smash Audit v0 — done.
10. Persist Smash preset — done.
11. Apply Curves / Apply LUT bonus — done.
12. Export LUT bonus — done.

### Remaining for Pro alpha milestone

Items 1–5 from §8 above: SmashSection, mode toggle, lower-section branch, engine-to-preview routing, ProShell/SmashTab removal.

---

## 10. What is unchanged from v1

The following sections of the v1 masterplan stand without modification:

- **Engineering strategy** — one repo, `feature/smash` branch, `__SMASH_ENABLED__` build flag, two `.ccx` targets, branching model, distribution options (§2.1–§2.7).
- **Technical architecture** — `core/smash/`, `core/perceptual/`, `app/smash/`, type definitions in `types.ts`, engine pseudo-pipeline, color science choices (§3.1–§3.5).
- **UX sections not superseded** — Smash Audit panel (§4.3), Show Influence overlay (§4.4), standard reference image (§4.5), two-tier preview (§4.6). These apply to Smash mode inside MatchTab exactly as written.
- **Roadmap from Phase 2 onward** — trait sliders, compression, ACES vMM, WebGL shader, Phase 3 ship items, Phase 4 advanced features (§5, Phase 2–4).
- **Acceptance criteria** (§6), **risk register** (§7), **deferred scope** (§8), **open questions** (§10).
- **Free / Pro line** (§1.3) — unchanged. The mode toggle is Pro-only; Match remains the full free experience.

Design principles from `_06` that informed v1 §4.2 carry forward: P3 (one big knob — Smash Amount stays the lead control), P5 (existing preview + Before/After badge survives), H1 (complex multi-dimensional state surfaced simply via a single toggle rather than a parallel tab).

---

*This addendum is the working record of the v2 UI architecture decision. When the implementation in §8 is complete and `ProShell.tsx` and `SmashTab.tsx` are deleted, this addendum can be folded back into a revised §4 of the main masterplan.*
