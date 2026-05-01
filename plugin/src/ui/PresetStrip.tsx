// Quick-select preset swatches: 1x4 row of square previews showing the SOURCE in each
// preset's characteristic visualization (full color / pure hue / grayscale / contrast).
// Click a swatch to STAGE that preset — the matched preview pane below updates to show
// the result on the target. Apply Curves bakes whatever's staged into the PS doc.
//
// This is non-destructive: nothing is written to PS until the user explicitly applies.
//
// Why swatches of source (not target):
//   - You're picking which ASPECT of the source to transfer; the swatch shows that aspect
//   - Differences between presets are immediately visible at a glance
//   - The matched preview already shows the target-side result, so duplicating that here
//     would be redundant. Source facets answer "what am I about to transfer?"

import { useMemo, useState } from "react";
import { rgbaToPngDataUrl } from "./encodePng";
import { Preset, sourceVariant } from "../core/histogramMatch";
import { downsampleToMaxEdge } from "../core/downsample";

// Swatches scale to fill the panel width (flex: 1 each, square via aspect-ratio).
// Encode resolution is decoupled from on-screen size — we encode once at this max
// edge and let the browser scale up. 128px keeps swatches crisp up to ~150px display
// (more than enough for any reasonable panel width) without paying the full ~256px
// source-snap cost. PNG encoding is pure JS and proportional to pixel count, so this
// is the knob that determines source-layer-switch responsiveness.
const SWATCH_ENCODE_EDGE = 128;

// Internal preset ids stay unchanged ("color" / "hue" / "contrast") to avoid churning
// the whole pipeline. Display labels diverged after a UX round: "Color" → "Full",
// "Hue" → "Color", and the underlying blend mode for the second one swapped from
// PS-Hue to PS-Color blend (H+S transfer instead of H-only). See applyMatch + the
// applyPresetPostprocess switch for the corresponding pixel semantics.
const PRESETS: { key: Preset; label: string; tip: string }[] = [
  { key: "color",    label: "Full",     tip: "Full match — transfers the source's per-channel tone + color (R/G/B curves)." },
  { key: "hue",      label: "Color",    tip: "Color blend — transfers the source's hue + saturation, target keeps its own luma." },
  { key: "contrast", label: "Contrast", tip: "Contrast / luma — transfers the source's tonal curve, target keeps its own colors." },
];

export interface PresetStripProps {
  // Source pixels — used to render the 4 facet swatches. Width/height for PNG encode.
  srcRgba: Uint8Array | null;
  srcWidth: number;
  srcHeight: number;
  // Currently staged preset; selected swatch gets a gold border + brighter label.
  active: Preset;
  // Click handler — caller updates `active` and re-renders the matched preview pane.
  onSelect: (preset: Preset) => void;
}

export function PresetStrip(props: PresetStripProps) {
  const { srcRgba, srcWidth, srcHeight, active, onSelect } = props;
  const [hovered, setHovered] = useState<Preset | null>(null);

  // Source-facet PNGs — recompute only when the source snapshot changes. We downsample
  // the source ONCE up front (cheap pixel pass), then run the 4 variant transforms +
  // PNG encodes on the small buffer. Both the variant pass and the encoder are O(pixels),
  // so dropping from 256x256 to 80x80 cuts cost ~10x. PNG encode is pure JS and is the
  // dominant cost — without this, swapping source layers stalls the UI noticeably.
  const swatches = useMemo(() => {
    if (!srcRgba || !srcWidth || !srcHeight) return null;
    const small = downsampleToMaxEdge(
      { data: srcRgba, width: srcWidth, height: srcHeight, bounds: { left: 0, top: 0, right: srcWidth, bottom: srcHeight } },
      SWATCH_ENCODE_EDGE,
    );
    const out: Record<Preset, string> = { color: "", hue: "", contrast: "" };
    for (const { key } of PRESETS) {
      try {
        const variant = sourceVariant(small.data, key);
        out[key] = rgbaToPngDataUrl(variant, small.width, small.height);
      } catch { out[key] = ""; }
    }
    return out;
  }, [srcRgba, srcWidth, srcHeight]);

  // Each swatch's wrapper takes flex: 1 of the row, so 3 swatches divide the panel width
  // evenly. aspect-ratio: 1 on the square keeps it a perfect square at any width — the
  // square shrinks if the panel is narrow, grows if wide, but never stretches non-square.
  return (
    <div style={{ position: "relative", marginTop: 4 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "flex-start", width: "100%" }}>
        {PRESETS.map(({ key, label, tip }) => {
          const isActive = active === key;
          const isHover = hovered === key;
          const ringColor = isActive ? "#c19a3a" : isHover ? "#888" : "#555";
          return (
            <div key={key} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2 }}>
              {/* Square via the padding-bottom trick instead of CSS aspect-ratio:
                  UXP's Chromium runtime doesn't reliably honor aspect-ratio. The outer
                  wrapper has padding-bottom:100% (= width % since vertical % refs width),
                  giving height == width. The actual swatch is absolute-positioned to fill. */}
              <div style={{ position: "relative", width: "100%", paddingBottom: "100%" }}>
                <div
                  onMouseEnter={() => setHovered(key)}
                  onMouseLeave={() => setHovered(h => (h === key ? null : h))}
                  onClick={() => onSelect(key)}
                  title={tip}
                  style={{
                    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                    // Cover + center: center-cropped slice of the variant, paint-swatch feel.
                    backgroundImage: swatches?.[key] ? `url(${swatches[key]})` : "none",
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundColor: "#1f1f1f",
                    border: `1px solid ${ringColor}`,
                    borderRadius: 2,
                    cursor: "pointer",
                    boxShadow: isActive ? "0 0 0 1px #c19a3a" : "none",
                    transition: "border-color 60ms, box-shadow 60ms",
                    boxSizing: "border-box",
                  }} />
              </div>
              <span style={{
                textAlign: "center",
                fontSize: 9, opacity: isActive || isHover ? 1 : 0.65,
                color: isActive ? "#f0d486" : "#cccccc",
                fontWeight: isActive ? 700 : 400, userSelect: "none",
              }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
