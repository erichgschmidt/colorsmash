# Color Smash

A Photoshop UXP plugin that color-matches one image to another. Outputs editable **Curves** (RGB or Lab) or **Color Lookup** (33³ 3D LUT) adjustment layers — non-destructive, organized in a `[Color Smash]` group, fully editable in Photoshop afterward.

Compatible with Photoshop 25 (2024) and newer. Current version: **v1.20.70**.

## What it does

Pick a **source** (a layer in any open doc, an active marquee selection, or an image file from disk) and a **target** layer. Color Smash fits a transform that makes the target's color statistics match the source's, then bakes the transform into a non-destructive adjustment layer clipped to the target.

Three output modes — click a tab in the OUTPUT island to swap mode AND apply in one click:

- **RGB** — separable per-channel histogram match → editable Curves layer.
- **Lab** — perceptual L\*a\*b\* match, projected back to per-channel curves → Curves layer.
- **LUT** — 33³ 3D Color Lookup adjustment with preset blend math baked in. Loadable in PS, Premiere, Resolve, or any LUT-aware host.

## Panel layout (v1.20.70)

The panel renders as a stack of soft-cornered "island" sections. SOURCE and TARGET are always visible; the rest collapse via the `▾/▸` disclosure on each header.

| Island | What it does |
|---|---|
| **Header** | Wordmark + version on the left; PS native `↶ ↷` undo/redo in the middle; `💾 REVERT ✕ ⟳ ⚙ ?` action cluster on the right. |
| **SOURCE / REFERENCE** | Source doc + layer picker. Preset strip below (Full / Color / Hue / Saturation / Contrast) — click a swatch to stage that preset's transform. Source palette weight bar with softness / ↔ / 3-5-7 / ✕ toolbar above it. |
| **TARGET / PREVIEW** | Target doc + layer picker, before/after preview pane with log2-zoom + pan + background-color toggle, ⇄ swap source↔target, target palette weight bar. |
| **TRANSFORM** | Three sub-sections (Color / Tone / Envelope), each with its own enable checkbox and `(i)` help button. Collapsed by default. |
| **OUTPUT** | `[+] [○]` column-1 cluster on the left, `RGB | Lab | LUT` tabs on the right. Clicking a tab swaps the output mode AND applies in one click. `JUMP | ISOLATE` row at the bottom (target-specific actions). |
| **MASK** | Single MASK button + Off / Focus / Exclude tristate. Collapsed by default. |
| **HISTORY** | Recent recipe strip with pin / rename, ↓ IMPORT / ↑ EXPORT. Collapsed by default. |
| **FITTED CURVES** | Diagnostic R/G/B channel transfer-curve graph + status line. Collapsed by default. |

## Header icons (left → right)

- **↶ ↷** — Photoshop native undo / redo (same as Ctrl/Cmd+Z). Reverses PS-level edits, NOT panel state.
- **💾** — Export current preset to disk as a portable 33³ `.CUBE` 3D LUT.
- **REVERT** — Restore panel state from the active Match layer's XMP metadata. A `Before REVERT @ HH:MM` history entry is auto-saved as a permanent safety net before the revert applies. While the button reads UN-REVERT (immediately after a revert), one more click restores the pre-revert state from an in-memory shadow slot.
- **✕** — Reset all panel settings to defaults (confirm dialog).
- **⟳** — Resync everything from PS (docs, layer lists, source / target previews, selection mask).
- **⚙** — Open the Settings drawer.
- **?** — About / quick-start help.

## OUTPUT island

The OUTPUT island consolidates Apply, output-mode selection, branching, and live re-bake into one block. There is no separate "Apply" button — **clicking an output tab both swaps mode AND applies**.

- **`+` (column 1, top)** — branch arm. When armed (green), the next tab click archives the current `[Color Smash]` group (renames it `[Color Smash] _NN`, hides it) and starts a fresh one. Auto-disarms after that click.
- **`○` AUTO** — record-armed indicator. When ON (filled red), slider changes auto-update the existing output layer in real-time (debounced, configurable in Settings). Click an output tab once to seed the layer, then drag sliders to live-update.
- **RGB / Lab / LUT tabs** — click to swap output mode AND apply. The active tab has an amber border; previously-used-this-session modes show a dim "dormant" warm tint.
- **JUMP** — select the target layer in PS Layers panel and scroll it into view.
- **ISOLATE** — A/B compare via hide-other-layers. Snapshots prior visibility, hides everything except the target's ancestor chain and the `[Color Smash]` group. Click again to restore.

## MASK island

Single MASK button + Off / Focus / Exclude tristate. The MASK button toggles BOTH the red preview overlay (visualization) AND the per-cluster attenuation gate (which bakes a layer mask onto the output layer). Default ON.

- **Off** — full-image apply, marquee ignored.
- **Focus** — apply only inside the active marquee.
- **Exclude** — apply only outside the active marquee. Useful for protecting a region.

## Settings drawer (⚙)

Click the gear icon in the header to expand the inline Settings drawer. Four sections:

- **GENERAL** — Group color (8 PS color tags), Group name (rename `[Color Smash]` to anything), Persistence (save settings across reloads).
- **LUT** — Strength (lerp toward identity), Quality (17³ / 33³ / 65³ grid), Dither.
- **ADVANCED** — AUTO debounce (60–1000 ms), History capacity (5–30).
- **DIAGNOSTICS** — Verbose status, Reveal data folder, Export / Import config JSON.

## HISTORY island

Recent recipes auto-record after every apply (recipe-only — target swatches stripped). Click any thumbnail to restore that state. Pin (★) entries to survive ring-buffer eviction. Rename via right-click. **↓ IMPORT** loads a `.json` recipe file (cross-machine portable, auto-pinned). **↑ EXPORT** writes pinned entries (or all entries if nothing is pinned) to a `.json` file.

The plugin ships with 4 starter recipes (Punch / Faded / Warm Mid / Mono) — installed on first run.

## Per-document `[Color Smash]` group

Every bake lands in a single canonical `[Color Smash]` group at the doc root, color-tagged orange in the Layers panel (color is configurable in Settings). The plugin auto-deduplicates stray groups before each apply, so JUMP / ISOLATE / Layers-panel selection changes can't accidentally cause groups to stack.

Inside the group, each output mode keeps its own layer prefix and they coexist for A/B comparison:

- `Match RGB` — RGB-mode Curves layer.
- `Match Lab` — Lab-mode Curves layer.
- `Match LUT [preset]` — LUT-mode Color Lookup layer.

## Round-trip restore

Every bake stamps the layer with XMP metadata containing the panel state that produced it. Click the layer in PS, hit **REVERT** in the panel, and every slider, palette weight, preset, output mode, and doc/layer choice snaps back. Works across documents (target doc/layer are stored).

## Requirements

- Photoshop 25 (2024) or newer (UXP API v2, Imaging API).
- An RGB document, 8 or 16 bits/channel.
- Two pixel layers, **or** one layer plus an active selection, **or** one layer plus an image file on disk.

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

1. Open a document with the layer you want to recolor (target). Have a reference image available — another layer in the same doc, a layer in a different open doc, an active marquee on the current layer, or a file on disk.
2. Open **Color Smash** from the Plugins menu.
3. **SOURCE / REFERENCE** — pick the source doc and layer, OR `Use Selection` (marquee — has Auto / Merge / Lock sub-toggles), OR `Browse Image…` (file picker). The preset strip below the dropdowns shows the source rendered through each preset; click a swatch to stage it.
4. **TARGET / PREVIEW** — pick the target doc and layer. `Merged` uses the document composite. The matched preview updates live as you tweak.
5. **OUTPUT** — click `RGB`, `Lab`, or `LUT` to apply. The active mode shows an amber border. To stack multiple modes, click each tab in sequence — they coexist inside the `[Color Smash]` group.
6. To protect part of the target from being matched, drag a swatch in the target palette bar toward zero (its cluster region stops receiving the transform).
7. To localize the apply to a marquee, draw the marquee on the target doc, then expand the MASK island and click `Focus` (apply inside) or `Exclude` (apply outside).
8. To revert to a previous state, click a baked Match layer in PS Layers, then hit **REVERT** in the header. To recover from accidental REVERT, click it again immediately (UN-REVERT) — or use the auto-saved `Before REVERT` history entry.

### Cross-document

Source and target dropdowns are fully independent. Pick a layer in document A as source and a layer in document B as target — clicking an OUTPUT tab writes the result into document B's `[Color Smash]` group.

## TRANSFORM controls

Three accordion sub-sections inside the TRANSFORM island, each with an enable checkbox and `(i)` help button:

- **Color** — Amount (match strength), Smooth (Gaussian on the CDFs, anti-banding), Stretch (max slope), Anchor stretch to histogram range, Hue only (preserve target saturation + luminance).
- **Tone** — Value / Chroma / Hue / Contrast / Neutralize / Separation. Identity at default; each slider deviates from there.
- **Envelope** — Arbitrary-N piecewise weight curve over input luma 0..255. Click empty area to add a smooth point; Alt-click toggles smooth↔corner; Shift/Ctrl-drag locks one axis; Delete/Backspace removes selected.

## Recipes & history

- **Auto-record** — every apply pushes a recipe-only entry (source palette + preset + slider values; target swatches stripped so the recipe is portable).
- **Pin** — star icon. Pinned entries survive ring-buffer eviction.
- **Rename** — right-click an entry. Custom names display in the thumbnail tooltip.
- **Import / Export** — JSON envelope format (`color-smash-recipes`, versioned). Cross-machine portable. Doc/layer ids stripped at export.
- **Starter recipes** — 4 curated recipes (Punch / Faded / Warm Mid / Mono B&W) installed on first run.

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
    ├── ui/                # Panel, PreviewPane, accordion editors, hooks
    ├── core/              # pure-TS algorithms (histogramMatch, lab, lut, downsample)
    ├── services/          # Photoshop DOM + batchPlay wrappers
    └── app/               # Apply orchestration, XMP, recipes, group dedup
```

## Implementation notes

- **Single canonical group** — `consolidateColorSmashGroups()` runs before every apply, merging any stray nested `[Color Smash]` groups into a single top-level one. Prevents stacking when PS's insertion-point context (set by JUMP / ISOLATE / user clicks) tries to spawn nested groups.
- **Three-step UI palette** — outer panel `#555` (lightest), island bg `#4a4a4a` (mid), dropdown/control bg `#2e2e2e` (darkest). Each level recesses into the next.
- **Layer/doc dropdown freshness** — PS fires make/delete notifications during the modal scope before `doc.layers` reflects the mutation. Reads are deferred (`setTimeout 0` plus a 120 ms backup) and deduped, so newly created layers and documents appear immediately.
- **REVERT recoverability (two safety nets)** — Auto-history: a pinned `Before REVERT @ HH:MM` entry is pushed before the revert applies, survives reloads. Shadow slot: in-memory copy of pre-revert state; the button reads `UN-REVERT` while the slot is live, click again to restore.
- **Preview zoom buttons** — rendered as `<div>` elements rather than `<button>`s to work around UXP shadow-DOM text-rendering issues.

## License

MIT — see [LICENSE](LICENSE).

---

Built with assistance from [Claude Code](https://claude.com/claude-code).
