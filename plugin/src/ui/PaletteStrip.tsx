// Display-only palette strip. K-means clustering on the source pixels surfaces N
// dominant colors as swatches, giving the Source section visual identity that
// matches the language photographers use ("here are the colors I'm pulling from").
//
// Reflects the active preset: Full shows the raw RGB clusters, Color (hue blend)
// shows the same clusters with luminance flattened to pure-hue swatches, and
// Contrast shows the clusters desaturated to grays. The strip becomes a visual
// preview of "what the source contributes to the match under this preset" —
// reinforces the conceptual link between preset choice and source palette.
//
// Phase A: still no click interactivity. Pure visualization. Phase B (later)
// would let users toggle individual swatches in/out to filter the source.

import { useMemo } from "react";
import { extractPalette, PaletteSwatch } from "../core/palette";
import { Preset } from "../core/histogramMatch";

interface PaletteStripProps {
  srcRgba: Uint8Array | null;
  srcWidth: number;
  srcHeight: number;
  // Active preset — drives a per-swatch RGB transformation at render time so the
  // palette visually reflects what each preset emphasizes:
  //   • color    (Full)     → swatches rendered as-is
  //   • hue      (Color)    → luminance flattened, hue+sat preserved → pure-hue swatches
  //   • contrast (Contrast) → fully desaturated → grayscale value strip
  preset?: Preset;
  // Number of swatches. Default 5 — empirically the right balance between
  // visual richness and not turning the strip into noise.
  count?: number;
}

// Approximate sRGB luma (Rec.709). Fast enough at 5 swatches that we don't need
// to involve the full Lab path here — the palette extraction already happened
// in Lab; this is just a per-preset display transform.
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Apply the preset's display transform to a swatch's RGB. Returns a CSS rgb() string.
function swatchColor(s: PaletteSwatch, preset: Preset | undefined): string {
  if (preset === "contrast") {
    // Desaturate to perceptual gray.
    const y = Math.round(luma(s.r, s.g, s.b));
    return `rgb(${y}, ${y}, ${y})`;
  }
  if (preset === "hue") {
    // Flatten luminance: scale RGB so its luma lands at a fixed mid-tone (~140),
    // preserving hue + saturation but stripping the lightness component. Tiny clamp
    // step so we don't blow out highly-saturated near-primary swatches.
    const TARGET_Y = 140;
    const y = luma(s.r, s.g, s.b);
    if (y < 1) return `rgb(${TARGET_Y}, ${TARGET_Y}, ${TARGET_Y})`;
    const k = TARGET_Y / y;
    const r = Math.max(0, Math.min(255, Math.round(s.r * k)));
    const g = Math.max(0, Math.min(255, Math.round(s.g * k)));
    const b = Math.max(0, Math.min(255, Math.round(s.b * k)));
    return `rgb(${r}, ${g}, ${b})`;
  }
  // color (Full) or unspecified: pass through.
  return `rgb(${s.r}, ${s.g}, ${s.b})`;
}

export function PaletteStrip(props: PaletteStripProps) {
  const { srcRgba, srcWidth, srcHeight, preset, count = 5 } = props;

  // Cluster extraction memoized on buffer reference — only re-runs when source
  // pixels actually change. The per-preset display transform is a cheap render-
  // time mapping; no need to invalidate clusters when the user toggles preset.
  const swatches = useMemo(() => {
    if (!srcRgba || srcWidth === 0 || srcHeight === 0) return [];
    return extractPalette(srcRgba, srcWidth, srcHeight, count);
  }, [srcRgba, srcWidth, srcHeight, count]);

  if (swatches.length === 0) {
    // Empty placeholder so layout doesn't jump when source loads.
    return (
      <div style={{ display: "flex", height: 24, gap: 2, opacity: 0.4 }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
        ))}
      </div>
    );
  }

  const tipForPreset = preset === "contrast" ? "value range (preset: Contrast)"
                     : preset === "hue"      ? "hues (preset: Color)"
                     :                          "dominant colors (preset: Full)";

  return (
    <div style={{ display: "flex", height: 24, gap: 2 }}
      title={`Source palette — ${tipForPreset}`}>
      {swatches.map((s, i) => (
        <div key={i}
          style={{
            flex: 1,
            background: swatchColor(s, preset),
            border: "1px solid #333",
            borderRadius: 2,
          }}
          title={`rgb(${s.r}, ${s.g}, ${s.b}) — ${(s.weight * 100).toFixed(0)}%`}
        />
      ))}
    </div>
  );
}
