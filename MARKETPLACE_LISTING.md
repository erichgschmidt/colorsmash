# Color Smash — Adobe Marketplace Listing Copy

Copy/paste source for the Adobe Exchange Producer Portal. Edit before
submission to match your final branding/pricing.

---

## Short description (under 100 chars)

> Per-channel histogram color match into a single editable Curves layer.

## Long description (~1500 chars)

> Color Smash matches the color profile of one image to another by
> fitting per-channel R/G/B Curves to source histograms. The output
> is a single editable Curves adjustment layer — non-destructive,
> inspectable, tweakable in Photoshop's native dialog.
>
> KEY FEATURES
>
> • Per-channel histogram matching in RGB or perceptual Lab space
>
> • Live preview of the match as you tweak — no Apply round-trips
>
> • Cross-document workflow: source and target each have independent
>   document dropdowns. Pick a source layer in one open document and
>   a target layer in another — the Curves layer lands in the
>   target's document. Per-dropdown refresh forces a hook-level
>   reload to catch silent batch renames.
>
> • Layer dropdowns show full group hierarchy
>   (Group / Subgroup / LayerName) and skip the plugin's own
>   [Color Smash] group automatically.
>
> • Source from a layer, the active marquee selection, or any image
>   file from disk
>
> • Target a layer, a group, or the merged document composite
>
> • Three-section control surface — Color (match strength, smoothing,
>   stretch, hue-only), Tone (value, chroma, hue, contrast,
>   neutralize, separation), Zones (shadows / midtones / highlights
>   with independent amount, anchor, falloff, and competitive bias;
>   lock the total to redistribute weight without changing strength).
>
> • Envelope editor for arbitrary-N per-tone weight curves with mix
>   of smooth (monotone-cubic) and corner (linear) interpolation
>
> • Hue-only mode: match color while preserving target saturation +
>   luminance (HSY-style Hue blend, not the saturation-inflating
>   Color blend used by naive implementations)
>
> • Anchor stretch slope cap to the actual histogram range so the
>   slider behaves consistently across bright vs dark sources
>
> • Persist all settings across panel reloads with the Save toggle in
>   the bottom action bar (debounced write to a JSON file in the
>   plugin's data folder; the toggle's own state is included). The
>   adjacent red ✕ button resets every control to defaults and
>   deletes the saved file after a confirm prompt.
>
> WORKFLOW
>
> Pick source. Pick target. Tweak. Apply. Done.
>
> Compatible with Photoshop 2024 (25.0.0) and later, on macOS and
> Windows.

## Category

> Image Adjustments
> (or: Color & Tone, if available)

## Tags (5-10)

> histogram match, color grading, curves, color correction,
> color match, color reference, lab color, photo retouching

## URLs

- **Support**: https://github.com/erichgschmidt/colorsmash/issues
- **Privacy Policy**: https://erichgschmidt.github.io/colorsmash/privacy.html
- **Website / Documentation**: https://github.com/erichgschmidt/colorsmash

(GitHub Pages must be enabled on the repo with `docs/` as the source
for the privacy URL above to resolve. Settings → Pages → Source:
Deploy from a branch, `master` / `/docs`.)

## Pricing

> Free (recommended for first release)

If switching to paid later: Adobe sets fixed tiers ($4.99, $9.99,
$14.99, etc.). Setup requires Hyperwallet payment onboarding in the
Producer Portal first.

## Asset checklist

Required uploads at submission time (not in this repo yet — create
before submitting):

- [ ] **Hero image**: 1280×720 PNG, under 1 MB. Recommended: panel
      docked in PS chrome with a before/after color-match comparison.
- [ ] **Screenshots** (3–5): 1280×720 PNG each. Suggested set:
      1. Panel docked, source + target previews visible
      2. Match controls expanded — sliders + zone targeting
      3. Envelope editor with a few smooth + corner points placed
      4. Before/after split of an applied color match
      5. The generated Curves layer opened in PS's native dialog
- [x] **Product icon**: 256×256 PNG with transparent background.
      Placeholder ready in `plugin/icons/` (icon-light/dark + @2x);
      replace with final art before submission.

## Submission flow

1. Adobe Developer Console → reserve plugin id `com.colorsmash.plugin`
2. Adobe Exchange Producer Portal → complete Producer Profile
3. UXP Developer Tool → Add Plugin (point at `plugin/manifest.json`)
4. `cd plugin && npm run build` → packages production `index.js`
5. UDT → ⋯ menu → Package → produces `.ccx` file
6. Producer Portal → New Plugin → fill out form using copy above →
   upload `.ccx` → submit
7. Wait 3–7 business days for human review
