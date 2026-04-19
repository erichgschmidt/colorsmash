# Pre-Build Considerations — Itemized with Recommendations

**Status:** Working doc. Each item links to (or will link to) a decision doc under `decisions/` when finalized.

Every item below has a recommended default so we can start building without waiting. Items marked **VERIFY** need live web/legal checks before public launch but don't block Phase 0.

---

## Legal / naming

### 1. Product name: "Color Smash" — **VERIFY**
- **Recommendation:** Proceed with "Color Smash" as working name through Phase 0–2. Before Phase 5 (marketplace submission), run real checks:
  - USPTO TESS (classes 9 and 42)
  - Adobe Exchange search
  - `npm view color-smash` / `colorsmash`
  - WHOIS on colorsmash.com / .app / .io
  - Google SEO collision check (expect some — casual games use similar names)
- **Risk:** A prior "COLORSMASH" children's toy mark may exist; verify live status.
- **Fallback names to keep warm:** ColorGraft, MatchSmith, Palette Transfer Pro.

### 2. Trademark avoidance in marketing copy
- **Recommendation:** Don't use "Match Color" as a product descriptor. Use "color transfer," "color matching," "style transfer." Reference Photoshop Match Color only in comparative context ("unlike Photoshop's Match Color, Color Smash is non-destructive...").

### 3. Marketplace publisher profile — **VERIFY**
- **Recommendation:** Start the publisher profile at `developer.adobe.com/distribute` during Phase 2 (not Phase 5) — approval is async. Collect: legal entity, W-9/W-8, payout bank, support email, privacy policy URL.
- EU DSA trader disclosure required since Feb 2024: legal name, address, phone, email, trade register ID.
- **Revenue share:** Adobe has historically been 85/15 dev-favorable but this changes — verify at submission time.

### 4. License choice
- **Recommendation:** **Proprietary** for the plugin, MIT for any standalone algorithm libraries we open-source. Avoid GPL dependencies entirely — they would force the plugin open.

---

## Color science decisions

### 5. Working color space for analysis
- **Recommendation:** **sRGB-assumed for v1.** Detect document profile; if not sRGB, show a one-time warning but still proceed with sRGB math. Phase 3: honor the document profile properly.
- **Why:** 95%+ of targets will be sRGB. Profile-correct math doubles complexity for edge cases we can add later.

### 6. Lab conversion constants
- **Recommendation:** **D65 illuminant, sRGB→XYZ via standard IEC 61966-2-1 matrix.** Write constants to a single `color-constants.ts` file. Document the choice in code comments.
- Decision record: [decisions/01-color-space.md](decisions/01-color-space.md) (to write).

### 7. Linear vs gamma-encoded analysis
- **Recommendation:** **Analyze in gamma-encoded sRGB, not linear.** Reinhard's paper and Photoshop Match Color both effectively operate in gamma space; matching that behavior keeps results intuitive. Revisit if Phase 4 OT work shows artifacts.
- **Why it matters:** µ/σ in linear light vs gamma give perceptibly different results, especially in shadows.

### 8. Gamut handling on Lab→RGB return
- **Recommendation:** **Soft compression** toward neutral for out-of-gamut results, with user-facing "Gamut Compression" slider (default: medium). Hard clip only as a debug mode.
- **Why:** Reinhard transfer frequently pushes saturated colors out of RGB; hard clip looks worse than soft compression.

### 9. Bit depth support
- **Recommendation:** **v1: 8-bit and 16-bit RGB.** Process internally in float32. LUT is precision-limited to ~8-bit-equivalent; document this. 32-bit float (HDR) deferred to v2 or later.
- Detect doc bit depth via `document.bitsPerChannel`; offer conversion prompt for non-RGB.

### 10. Color modes — scope
- **Recommendation:** **RGB-only, matching Photoshop's own Match Color constraint.** For CMYK/Grayscale/Indexed docs, show "Convert to RGB to use Color Smash" with a one-click convert button.

---

## Scope traps

### 11. Selections as source/target regions
- **Recommendation:** **v1 supports selections.** Without this, users can't isolate the "look" from a specific area. Stats computation already iterates pixels — add a mask-aware variant now, not later.

### 12. Smart Object targets
- **Recommendation:** **v1 treats Smart Objects as valid targets** — build the adjustment group above them (they already support clipped adjustments). Don't try to edit the Smart Object's contents.

### 13. Re-apply behavior
- **Recommendation:** **Detect existing `[Color Smash]` group, offer Replace / Stack New / Edit.** Default: Edit (open sliders tied to existing group). Prevents users from building up five stacked copies accidentally.

### 14. Undo granularity
- **Recommendation:** **Single history step per Apply.** Wrap in `executeAsModal({ commandName: "Apply Color Smash" })`. Slider tweaks after apply generate their own single-step entries.

---

## UX decisions

### 15. Live preview vs apply-on-click
- **Recommendation:** **Apply-on-click for v1.** Honest about cost, predictable UX. Add "auto-refresh" toggle in v2 once perf is characterized.

### 16. Stats downsampling for speed
- **Recommendation:** **Downsample to 512px longest-edge for statistics.** Visually indistinguishable for µ/σ and OT; ~100× faster. Full-resolution only for the final pixel write.
- LUT generation stays full-precision; only stats analysis downsamples.

### 17. Performance budget
- **Recommendation:** **Target: < 2s apply on 24MP image, Apple Silicon baseline.** Drives the "is LUT gen in TS fast enough" decision. If Phase 2 measures > 3s, WASM port moves to Phase 3.

---

## Testing infrastructure

### 18. Golden-image regression harness
- **Recommendation:** **Build in Phase 0.** Fixed source/target image pairs → hashed output. Runs in CI. Prevents silent algorithm drift.

### 19. Headless algorithm core
- **Recommendation:** **Pure-TS core with no Photoshop imports.** Tests run in Node via vitest. This is the single highest-leverage architectural decision — it makes every future change cheap to validate.

### 20. Synthetic test PSD
- **Recommendation:** **Build a `tests/fixtures/synthetic.psd`** with the cases from research02 §7.1: grayscale ramps, casted neutrals, same-mean-different-histogram, etc. One file, documented layers, used for both algorithm tests and perceptual evaluation.

---

## Project hygiene

### 21. Repo location
- **Recommendation:** **Start a clean repo at `ColorSmash/`**, not inside the MaterialMaker worktree. Current worktree has ~40 stale planning .md files from another project. Clean repo = clean git history, clearer scope.

### 22. Imaging API status — **VERIFY**
- **Recommendation:** **Design assuming Imaging API is GA on PS 25.0+.** If current docs still show beta banner, add a feature-detect fallback to `copyPixels` via batchPlay. Verify at start of Phase 0.

### 23. Sensei / AI segmentation — **VERIFY**
- **Recommendation:** **Design the protection-mask module to accept any mask source.** v1 uses color-range for skin; swap in Sensei calls in Phase 3 or later without rewriting the pipeline.

---

## Dependencies

### 24. Color-conversion library
- **Recommendation:** **Write our own.** ~100 lines of pure math, we control precision and bit depth. Audit `culori` as reference only; don't ship it (Node assumptions may break in UXP).

### 25. `.cube` LUT writer
- **Recommendation:** **Write our own.** Trivial format. Keeps the preset-format stack fully in-house.

### 26. UI framework lock-in
- **Recommendation:** **React + Spectrum Web Components.** Adobe's documented path. TypeScript strict mode. Vite for bundling.

---

## Summary — what's actually blocking

Nothing here blocks Phase 0. The only items that need answers before shipping publicly are the **VERIFY** tags (1, 3, 22, 23), and those can be checked in parallel with development.

Next: convert this into individual decision docs under `decisions/` as each is finalized, and reflect changes back into [PRD.md](PRD.md) and [roadmap.md](roadmap.md).
