// Display-only palette strip. K-means clustering on the source pixels surfaces N
// dominant colors as swatches, giving the Source section visual identity that
// matches the language photographers use ("here are the colors I'm pulling from").
//
// Phase A: no interactivity. Pure feedback. Pairs with the existing PresetStrip
// (stacked above it). If we keep this, Phase B adds click-to-toggle for
// subtractive control over which clusters contribute to the histogram match.

import { useMemo } from "react";
import { extractPalette } from "../core/palette";

interface PaletteStripProps {
  srcRgba: Uint8Array | null;
  srcWidth: number;
  srcHeight: number;
  // Number of swatches. Default 5 — empirically the right balance between
  // visual richness and not turning the strip into noise.
  count?: number;
}

export function PaletteStrip(props: PaletteStripProps) {
  const { srcRgba, srcWidth, srcHeight, count = 5 } = props;

  // Memoize on the buffer reference. srcRgba changes when the source changes
  // (new layer / new selection / new browsed image), and is stable otherwise,
  // so this only re-runs when there's actually new pixels to cluster. ~30ms
  // for k=5 on a 256-edge source — fine off the render path.
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

  return (
    <div style={{ display: "flex", height: 24, gap: 2 }}
      title="Source palette — dominant colors clustered from the source image (display only)">
      {swatches.map((s, i) => (
        <div key={i}
          style={{
            flex: 1,
            background: `rgb(${s.r}, ${s.g}, ${s.b})`,
            border: "1px solid #333",
            borderRadius: 2,
          }}
          title={`rgb(${s.r}, ${s.g}, ${s.b}) — ${(s.weight * 100).toFixed(0)}%`}
        />
      ))}
    </div>
  );
}
