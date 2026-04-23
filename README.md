# Color Smash

A Photoshop UXP plugin that color-matches one layer to another by fitting per-channel R/G/B Curves to the source's histograms — output is a single editable Curves adjustment layer, not baked pixels.

## What it does

Pick a **source** (a layer or a marquee selection) and a **target** (a layer). Color Smash fits a Curves adjustment that makes the target's per-channel histograms match the source's. The result is non-destructive — it's one Curves layer clipped to the target inside a `[Color Smash]` group, fully editable in Photoshop afterward.

Beyond the basic fit, you get:

- **Match controls** — overall amount, smoothing (anti-banding), max stretch (slope cap).
- **Chroma only** — preserves the target's luminance, applies only the color cast (PS "Color" blend mode).
- **Dimension warps** — value, chroma, hue shift, contrast, neutralize, separation. Each is identity at default, deviating only when you move the slider.
- **Zone targeting** — separate amount / anchor / falloff for shadows / mids / highlights, so you can apply the match strongly in one tonal range and gently (or not at all) in another.
- **Live preview** with throttled redraw + double-buffered image for flicker-free dragging.
- **Selection mode** with optional auto-update — sample the active marquee shape as the source signature; toggle Auto and the source re-samples whenever you settle a new marquee.

## Requirements

- Photoshop 25 (2024) or newer (UXP API v2, Imaging API).
- An RGB document, 8 or 16 bits/channel.
- At least two pixel layers in the active document (or one layer + an active selection).

## Install

### From a packaged `.ccx`

1. Double-click the `.ccx` file. Creative Cloud Desktop installs it.
2. Open Photoshop → **Plugins → Color Smash** to open the panel.

### From source (development sideload)

1. Install Adobe **UXP Developer Tool** from Creative Cloud Desktop.
2. `cd plugin && npm install && npm run build`
3. In UDT: **Add Plugin** → point at `plugin/manifest.json`.
4. Click **Load** to open the panel in Photoshop.

## Usage

1. Open a document with the layer you want to recolor (target) and a reference layer (source).
2. Open **Color Smash** from the Plugins menu.
3. Pick **Source** mode:
   - **L (Layer)** — use a layer as the source.
   - **S (Selection)** — sample the active marquee. Tick the checkbox for auto-sample on selection change.
4. Pick **Target** layer.
5. Watch the matched preview + curves graph update live.
6. Tweak any of the accordion sections (Match controls, Dimension warps, Zone targeting).
7. Click **Apply Match** — a single Curves adjustment layer appears in `[Color Smash]` group, clipped to the target.
8. Edit the Curves layer further in PS if you want.

## Development

```
cd plugin
npm install
npm run build         # production build to dist/
npm run watch         # rebuild on save
npm run typecheck     # tsc --noEmit
```

The built bundle is `plugin/dist/index.js` (~64KB, no runtime deps beyond React).

## Project layout

```
plugin/
├── manifest.json          # UXP manifest
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

🤖 Built with assistance from [Claude Code](https://claude.com/claude-code).
