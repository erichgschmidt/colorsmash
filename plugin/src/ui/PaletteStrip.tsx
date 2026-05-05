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

export type PaletteCount = 3 | 5 | 7;

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
  // Number of swatches. Persisted at the parent level so it survives reloads.
  count: PaletteCount;
  setCount: (n: PaletteCount) => void;
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

// Count toggle styling. Compact and dim — meant to read as a quiet control,
// not compete with the swatches below it.
const countBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: "1px 6px", fontSize: 9, fontWeight: 600,
  background: active ? "#1473e6" : "transparent",
  color: active ? "#fff" : "#888",
  border: `1px solid ${active ? "#1473e6" : "#444"}`,
  borderRadius: 2, cursor: "pointer", userSelect: "none",
  height: 14, lineHeight: "12px", boxSizing: "border-box",
});

export function PaletteStrip(props: PaletteStripProps) {
  const { srcRgba, srcWidth, srcHeight, preset, count, setCount } = props;

  // Cluster extraction memoized on buffer + count. The per-preset display transform
  // is a cheap render-time mapping; no need to re-cluster when preset toggles.
  const swatches = useMemo(() => {
    if (!srcRgba || srcWidth === 0 || srcHeight === 0) return [];
    return extractPalette(srcRgba, srcWidth, srcHeight, count);
  }, [srcRgba, srcWidth, srcHeight, count]);

  // Display order: sort by luminance (dark → light) so the strip reads as a value
  // gradient rather than a prevalence-ranked arrangement. Matches the convention
  // in palette tools (Coolors, Adobe Color, etc.) and is more visually pleasing.
  // Prevalence info is preserved in the per-swatch tooltip.
  const sorted = useMemo(() => [...swatches].sort((a, b) => luma(a.r, a.g, a.b) - luma(b.r, b.g, b.b)), [swatches]);

  const countToggle = (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}
      title="Number of palette swatches — fewer for primary themes, more for nuance">
      {([3, 5, 7] as PaletteCount[]).map(n => (
        <div key={n} onClick={() => setCount(n)} style={countBtnStyle(n === count)}>{n}</div>
      ))}
    </div>
  );

  if (sorted.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, opacity: 0.5 }}>palette</span>
          {countToggle}
        </div>
        <div style={{ display: "flex", height: 24, gap: 2, opacity: 0.4 }}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} style={{ flex: 1, background: "#1a1a1a", border: "1px solid #333", borderRadius: 2 }} />
          ))}
        </div>
      </div>
    );
  }

  const tipForPreset = preset === "contrast" ? "value range (preset: Contrast)"
                     : preset === "hue"      ? "hues (preset: Color)"
                     :                          "dominant colors (preset: Full)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 9, opacity: 0.5 }}>palette</span>
        {countToggle}
      </div>
      <div style={{ display: "flex", height: 24, gap: 2 }}
        title={`Source palette — ${tipForPreset} (sorted dark → light)`}>
        {sorted.map((s, i) => (
          <div key={i}
            style={{
              flex: 1,
              background: swatchColor(s, preset),
              border: "1px solid #333",
              borderRadius: 2,
            }}
            title={`rgb(${s.r}, ${s.g}, ${s.b}) — ${(s.weight * 100).toFixed(0)}% of source`}
          />
        ))}
      </div>
    </div>
  );
}
