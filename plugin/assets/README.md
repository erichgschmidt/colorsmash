# plugin/assets

## reference.png

1024×1024 procedural test card. Used by the Pro Smash Engine for:

- Preset gallery thumbnails — every preset is rendered through this image so
  any two presets can be compared apples-to-apples (see
  `ColorSmash_Research_06_inspiration.md` §U6).
- Regression test fixtures.
- Side-by-side "what each preset family does" UI strip.

### Layout

| Region | Vertical pixels | Content |
|---|---|---|
| ColorChecker grid | 0–512 | 4 rows × 6 cols, X-Rite 24-patch standard sRGB values |
| Skin tones | 512–640 | 8 Fitzpatrick-inspired swatches, light to deep |
| Foliage | 640–768 | 8 greens, light/yellow to dark/cool |
| Sky gradient | 768–896 | Horizontal: cool zenith → mid → warm horizon |
| Neutral ramp | 896–1024 | Horizontal: pure black → pure white |

Background around the ColorChecker (cols 0–127 and 896–1023 in the top half)
is RGB (80, 80, 80) so the patches read as a separate field.

### Regenerating

```
npm run gen:reference
```

(or `node scripts/gen-reference-image.js` directly). The script is pure Node
stdlib — no extra dependencies. Output is deterministic; the committed PNG
should always match a fresh generation.

## fonts / icons

Pre-existing UXP panel assets — see manifest.json for icon variants used by
Photoshop's plugin chrome.
