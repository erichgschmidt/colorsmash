# Color Smash

A Photoshop UXP plugin that color-matches one image to another by fitting per-channel R/G/B Curves to the source's histograms. The output is a single editable Curves adjustment layer, not baked pixels.

## What it does

Pick a **source** (a layer in any open doc, an active marquee selection, or an image file from disk) and a **target** layer. Color Smash fits a Curves adjustment that makes the target's histograms match the source's. The result is non-destructive: one Curves layer clipped to the target inside a `[Color Smash]` group, fully editable in Photoshop afterward.

Beyond the basic fit, you get:

- **RGB or LAB matching** — toggle between per-channel RGB histogram specification and a perceptual L*a*b*-domain match (curves are still sampled back to per-channel R/G/B so the output stays a standard Curves layer).
- **Match controls** — overall amount, smoothing (anti-banding), max stretch (slope cap).
- **Chroma only** — preserves the target's luminance, applies only the color cast (Curves layer set to "Color" blend mode).
- **Dimension warps** — value, chroma, hue shift, contrast, neutralize, separation. Each is identity at default, deviating only when you move the slider.
- **Zone targeting** — separate amount / anchor / falloff for shadows / mids / highlights, so you can apply the match strongly in one tonal range and gently (or not at all) in another.
- **Live matched preview** with zoom (− / value / + / 1:1 buttons), drag-to-pan, and keyboard shortcuts (`+` / `-` to zoom, `0` to reset) when the preview is hovered.
- **Selection mode** with Auto, Merge, and Lock toggles — the active marquee re-samples on its own when bounds change or pixels under it change; Merge samples the visible composite instead of the active layer; Lock freezes the current sample while you experiment elsewhere.

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
3. In the **Source** dropdown (top-left), pick one of:
   - **Any open document name** — switches to that doc and uses Layer mode; pick the source layer in the dropdown below.
   - **⊞ Use Selection** — samples the active marquee. Below the dropdown: **Auto** (re-sample on selection or pixel changes), **Merge** (sample the visible composite instead of just the active layer), **Lock** (freeze the current sample).
   - **📁 Browse Image…** — opens a file picker; the chosen image is loaded as the source. The filename appears as a sticky entry in the dropdown for quick re-selection.
4. In the **Doc** dropdown (top-right), pick the target document; pick the **Target** layer below it.
5. Watch the matched preview update live. Zoom with the −/+/1:1 buttons or `+` / `-` / `0` keys; drag inside the preview to pan.
6. Toggle **RGB / LAB** in the matched preview header to switch color-space; click the small refresh button to re-read both source and target previews from Photoshop.
7. Tweak any of the accordion sections: **Match controls**, **Dimension warps**, **Zone targeting**.
8. In the bottom bar, set **Deselect** (drop the active marquee before applying so curves apply to the full target) and **Overwrite** (replace the topmost / selected `Match Curves` layer, vs. hiding the prior one so alternatives stack).
9. Click **Apply Curves** — a single Curves adjustment layer appears in `[Color Smash]` group, clipped to the target.
10. Edit the Curves layer further in Photoshop if you want.

## Development

```
cd plugin
npm install
npm run build         # production build to dist/
npm run watch         # rebuild on save
npm run typecheck     # tsc --noEmit
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
    ├── ui/                # MatchTab, PreviewPane, CurvesGraph, ZoneCompoundSlider, hooks
    ├── core/              # pure-TS algorithms (histogramMatch, downsample)
    ├── services/          # Photoshop DOM + batchPlay wrappers
    └── app/               # Apply orchestration (applyMatch)
```

## License

MIT — see [LICENSE](LICENSE).

---

Built with assistance from [Claude Code](https://claude.com/claude-code).
