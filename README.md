# Color Smash

A Photoshop UXP plugin that color-matches one image to another by fitting per-channel R/G/B Curves to the source's histograms. The output is a single editable Curves adjustment layer, not baked pixels.

## What it does

Pick a **source** (a layer in any open doc, an active marquee selection, or an image file from disk) and a **target** layer. Color Smash fits a Curves adjustment that makes the target's histograms match the source's. The result is non-destructive: one Curves layer clipped to the target inside a `[Color Smash]` group, fully editable in Photoshop afterward.

Beyond the basic fit:

- **Preset strip (v1.2)** — three full-width swatches above the matched preview: **Full · Color · Contrast**. Each swatch paints the source through that preset's characteristic transform so you can see at a glance what's about to be transferred. Click a swatch to *stage* the preset — the matched preview updates live, but nothing writes to PS until you hit **Apply Curves** (non-destructive). **Full** = per-channel R/G/B match (Normal blend). **Color** = PS Color blend (transfers H+S, target keeps its luma). **Contrast** = averaged R/G/B curve + Luminosity blend (transfers tonal curve, target keeps its colors).
- **Export LUT (v1.2)** — button next to Apply Curves. Bakes the staged preset (curves + blend-mode emulation) into a 33³ Adobe `.CUBE` 3D LUT and writes it to a path you pick. Sidesteps Photoshop's flaky Color Lookup automation — load the LUT manually in PS's Color Lookup layer, Premiere, Resolve, or any LUT-aware host. The LUT captures non-separable Color/Luminosity blend math that a Curves layer alone cannot represent.
- **Matched preview Before/After badge** — corner overlay on the preview pane. Click toggles a persistent Before/After view; click-and-hold peeks the other state momentarily.
- **Multi-zone Curves output (v1.1)** — when the **Multi** toggle is on, Apply emits three stacked Curves layers (Shadows / Mids / Highlights) instead of one, each fitted from only the pixels in its luma band. Limit each band spatially with a paintable **Mask**, with **Blend If** sliders, or **Both**. Turn on **Adaptive** to shift the band peaks to the target's P10/P50/P90 luma percentiles (with outer extents matching the actual histogram bounds), so each band gets a meaningful pixel sample on low-key or high-key scenes. Every layer remains independently editable in PS afterward.
- **RGB or LAB matching** — toggle between per-channel RGB histogram specification and a perceptual L*a*b*-domain match. Curves are sampled back to per-channel R/G/B so the output stays a standard Curves layer.
- **Color** — overall amount, smoothing (anti-banding), max stretch (slope cap), optional anchor of the slope cap to the target's actual histogram range, and a Hue-only mode that preserves target saturation and luminance.
- **Tone** — value, chroma, hue shift, contrast, neutralize, separation. Each is identity at default, deviating only when you move the slider.
- **Zones** — independent shadows / mids / highlights bands with amount, bias, anchor, and falloff. Optional locked total to keep the three amounts summing to a fixed value. Band swatch colors are sampled from the target image.
- **Envelope** — arbitrary-N piecewise weight curve over input 0..255 that further modulates the match per tonal value, composed multiplicatively with zones.
- **Live matched preview** with zoom buttons, drag-to-pan, keyboard shortcuts, and a background-color toggle.
- **Selection mode** with Auto, Merge, and Lock toggles — the active marquee re-samples on its own when bounds or pixels change; Merge samples the visible composite; Lock freezes the current sample.
- **Merged target** — sentinel option that uses the document composite as target; the Curves layer is placed at the top of the stack with no clipping.

## Requirements

- Photoshop 25 (2024) or newer (UXP API v2, Imaging API).
- An RGB document, 8 or 16 bits/channel.
- Two pixel layers in the active document, **or** one layer plus an active selection, **or** one layer plus an image file on disk.

## Install

### From a packaged `.ccx`

1. Double-click the `.ccx` file. Creative Cloud Desktop installs it.
2. Open Photoshop → **Plugins → Color Smash** to open the panel.

### From source (development sideload)

1. Install Adobe **UXP Developer Tool** from Creative Cloud Desktop.
2. `cd plugin && npm install && npm run build`
3. In UDT: **Add Plugin** → point at `plugin/manifest.json`.
4. Click **Load** to open the panel in Photoshop.

The plugin requests `localFileSystem` permission so the **Browse Image…** source mode can open files from disk.

## Usage

1. Open a document with the layer you want to recolor (target). Have a reference image available — it can be another layer in the same doc, a layer in a different open doc, an active marquee on the current layer, or a file on disk.
2. Open **Color Smash** from the Plugins menu.
3. In the **Source** row (`[source/doc ▼] [layer/mode-widget ▼] [⟳]`), pick one of:
   - **Any open document name** — switches to that doc and uses Layer mode; pick the source layer in the second dropdown.
   - **Use Selection** — samples the active marquee. The widget exposes **Auto** (re-sample on selection or pixel changes), **Merge** (sample the visible composite instead of just the active layer), **Lock** (freeze the current sample).
   - **Browse Image…** — opens a file picker; the chosen image is loaded as the source. The filename appears as a sticky entry in the dropdown for quick re-selection.
   Below the source row, the **preset strip** (Full · Color · Contrast) shows the source rendered through each preset. Click a swatch to stage it.
4. In the **Target** row directly above the matched preview (`[doc ▼] [layer ▼] [⟳]`), pick the target document and target layer. The **MERGED** option uses the document composite as the target. Source and target docs are independent — each row has its own ⟳ refresh button (forces a hook-level reload to bypass any DOM cache, useful after silent batch renames). The Before/After badge in the preview corner identifies the target so no separate target thumbnail is shown.
5. Layer dropdowns show the full group hierarchy as `Group / Subgroup / LayerName` so nested layers are unambiguous. The plugin's own `[Color Smash]` group is skipped automatically.
6. Watch the matched preview update live. Zoom with the −/+/1:1 buttons or `+` / `-` / `0` keys when the preview is hovered; drag inside the preview to pan; click the swatch to flip the preview background between dark and panel-gray.
7. Toggle **RGB / LAB** in the matched preview header to switch color-space; click the small refresh button to re-read both source and target previews from Photoshop.
8. Tweak any of the accordion sections: **Color**, **Tone**, **Zones**, **Envelope**.
9. In the bottom action bar (right-anchored — labels clip silently behind the toggles in narrow panels): `[☐ Deselect] [☐ Replace] [☐ Save] [✕] [RGB] [⟳]`. **Deselect** drops the active marquee before applying, **Replace** overwrites the topmost / selected `Match Curves` layer instead of stacking, **Save** persists all panel settings to disk (debounced ~500ms, including the Save toggle itself so it survives reloads), **✕** (red) opens a confirm modal that wipes settings and deletes the persisted file, **RGB/LAB** is the color-space toggle, **⟳** refreshes previews.
10. Click **Apply Curves** — a single Curves adjustment layer appears in `[Color Smash]` group, clipped to the target (or at the top of the stack if MERGED). When source and target live in different documents, the layer is placed in the target's document. Or click **Export LUT** (50/50 split with Apply Curves) to save the staged preset as a portable 33³ `.CUBE` file instead of writing to PS.

### Multi-zone Curves

Above the bottom action bar there is a row: `[☐ Multi] [☐ Blend If] [☐ Adaptive]`. (The mask is the default band-limiter; turning Blend If on implicitly switches mask export off — the two are mutually exclusive, so no separate Mask checkbox is needed.)

- **Multi** — turn on to emit three stacked Curves layers (Shadows / Mids / Highlights) instead of one. The Apply button label switches to **Apply Multi Curves**. Each band's curves are fitted from only the pixels whose luma falls inside that band, so a single grade can lift shadows, neutralize mids, and cool highlights independently — useful for mixed-lighting scenes where one global curve over- or under-corrects.
- **Blend If** — by default each band layer gets a paintable luminosity layer mask (visible thumbnail, editable in PS — paint to localize, blur to feather). Turn the **Blend If** checkbox on to swap that mask for the underlying-luma sliders in Layer Style → Blending Options instead — no mask data, lighter on the file, editable from the Blending Options dialog. The two are mutually exclusive: Blend If on means no mask, off means mask only.
- **Adaptive** — when on, the band peaks shift to the target's P10 / P50 / P90 luma percentiles, and the outer extents (the leftmost shadow point and the rightmost highlight point) follow the histogram's actual min / max. When off, peaks are fixed at 0 / 128 / 255. Adaptive is on by default and is what you want for most images; turn off only when you want a strict 0/128/255 partition for a specific look.

The three layers land in the `[Color Smash]` group named `Match — Shadows`, `Match — Mids`, `Match — Highlights`, all clipped to the target. **Replace** still works — re-applying overwrites the prior multi-zone trio.

### Cross-document

Source and target dropdowns are fully independent. Pick a layer in document A as source and a layer in document B as target — Apply writes the Curves layer into document B. Use the ⟳ refresh button next to either dropdown if Photoshop's notification stream gets out of sync (e.g. after a batch rename).

## Color

- **Amount** — global blend toward the matched curves (0 = identity).
- **Smooth** — Gaussian smoothing on the per-channel CDFs to reduce banding from sparse histograms.
- **Stretch** — maximum allowed slope on the fitted curve. Caps amplification of low-population bins.
- **Anchor stretch to histogram range** — when on, the slope cap walks from where the target's data actually starts/ends (≥0.5% of peak count) instead of from 0/255. Keeps Stretch behavior consistent across bright vs. dark sources.
- **Hue only (preserve target saturation + luminance)** — applies a Hue-blend Curves layer. Preview takes H from the mapped pixel, S from the original, then re-imposes Rec.709 luma — matches Photoshop's HSY-style Hue blend and avoids the saturation inflation per-channel curves naturally produce.

## Zones

Three bands (shadows / mids / highlights), each with:

- **Amount** (0..1) — how strongly the match applies inside this band.
- **Bias** (-100..+100) — softmax-style pressure: positive bias grows the band at its neighbors' expense in overlap regions. Implemented as `exp(bias/50)` multiplicative gain inside partition-of-unity normalization. `0` is bit-identical to the un-biased fit.
- **Anchor** and **falloff** on a shared compound slider — controls where the band's center sits along 0..255 and how soft its edges are.

A **Lock total** checkbox in the zone header proportionally rebalances the other two amounts when you drag one, preserving `s + m + h`.

Each band's swatch color is the gaussian-weighted mean RGB of target pixels within the band's luma range (computed from the target snapshot via `computeLumaBins` / `bandMeanColor`). Colors update as anchors and falloffs move. Falls back to fixed blue / gray / yellow if no target snapshot is available.

## Envelope

Arbitrary-N piecewise weight curve over input luma 0..255 that modulates the match per tonal value. Composes multiplicatively with the zone weights. Default seeds three identity-weight points at 0 / 127 / 255.

Editor controls:

- **Click empty area** — adds a smooth point and immediately starts dragging it.
- **Drag point** — moves position and weight.
- **Shift-drag** — vertical only (weight only).
- **Ctrl-drag** (Cmd on Mac) — horizontal only (position only).
- **Alt-click point** — toggles smooth (●) ↔ corner (■). Smooth segments use monotone cubic Hermite interpolation (Fritsch–Carlson); corner segments are linear.
- **Click point** — selects (highlight). **Delete** / **Backspace** removes.
- **Right-click point** — removes. **Double-click point** — removes (legacy).
- **Reset** — restores the three identity points.

Background overlay shows the target luma histogram as filled gray bars and the source luma histogram as an orange polyline.

## Tone

Identity at default. Each slider deviates the fitted curves along one axis:

- **Value** — overall lightness shift.
- **Chroma** — saturation push/pull.
- **Hue** — hue rotation.
- **Contrast** — S-curve / inverse-S around mid-gray.
- **Neutralize** — pulls per-channel midpoints toward neutral.
- **Separation** — spreads channels apart in tonal range.

## Bottom bar

Layout: `[☐ Deselect] [☐ Replace] [☐ Save] [✕] [RGB/LAB] [⟳]` above the Apply Curves / Export LUT row. Buttons are right-anchored; their text-labels clip silently behind toggles when the panel is narrow.

- **Deselect** — drops the active marquee before applying so the Curves layer affects the full target.
- **Replace** — overwrites the topmost / selected `Match Curves` layer instead of stacking a new one beside it.
- **Save** — persists all panel settings (including this toggle's own state) to a JSON file in the plugin's data folder, debounced ~500ms. Restored on next panel load.
- **✕** — solid red. Opens a UXP confirm modal: "Reset all panel settings to defaults and clear the saved file?" Confirm wipes all panel settings to defaults and deletes the persisted settings file.
- **RGB/LAB** — color-space toggle (tight, hugs the letters).
- **⟳** — re-reads source and target previews from Photoshop.
- **Apply Curves** — writes the result (bakes the staged preset to a Curves layer in PS).
- **Export LUT** — writes the staged preset to a 33³ `.CUBE` file at a path you pick.

## Development

```
cd plugin
npm install
npm run build         # production build to dist/
npm run watch         # rebuild on save
npm run typecheck     # tsc --noEmit
npm run test          # vitest
```

The built bundle is `plugin/dist/index.js`.

## Project layout

```
plugin/
├── manifest.json          # UXP manifest (panel default 260×800)
├── index.html             # plugin entry HTML
├── icons/                 # PS panel icons
├── dist/                  # build output (gitignored)
└── src/
    ├── index.tsx          # React mount
    ├── ui/                # Panel, PreviewPane, envelope/zone editors, hooks
    ├── core/              # pure-TS algorithms (histogramMatch, lab, downsample, lut)
    ├── services/          # Photoshop DOM + batchPlay wrappers
    └── app/               # Apply orchestration
```

## Implementation notes

- **Layer/doc dropdown freshness** — Photoshop fires make/delete notifications during the modal scope before `doc.layers` reflects the mutation. Reads are deferred (`setTimeout 0` plus a 120 ms backup) and deduped, so newly created layers and documents appear immediately in the dropdowns instead of requiring a second action.
- **Preview zoom buttons** — rendered as `<div>` elements rather than `<button>`s to work around UXP shadow-DOM text-rendering issues.

## License

MIT — see [LICENSE](LICENSE).

---

Built with assistance from [Claude Code](https://claude.com/claude-code).
