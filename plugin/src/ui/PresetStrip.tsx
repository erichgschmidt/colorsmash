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

const PRESETS: { key: Preset; label: string; tip: string }[] = [
  { key: "color",    label: "Color",    tip: "Full color match — transfers the source's per-channel tone + color." },
  { key: "hue",      label: "Hue",      tip: "Hue only — transfers the source's color, target keeps its own brightness + saturation." },
  { key: "bw",       label: "B&W",      tip: "Black & white — uses the source's tonal contrast as a grayscale render." },
  { key: "contrast", label: "Contrast", tip: "Contrast / luma only — transfers the source's tonal curve, target keeps its own colors." },
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

  // Source-facet PNGs — recompute only when the source snapshot changes.
  const swatches = useMemo(() => {
    if (!srcRgba || !srcWidth || !srcHeight) return null;
    const out: Record<Preset, string> = { color: "", hue: "", bw: "", contrast: "" };
    for (const { key } of PRESETS) {
      try {
        const variant = sourceVariant(srcRgba, key);
        out[key] = rgbaToPngDataUrl(variant, srcWidth, srcHeight);
      } catch { out[key] = ""; }
    }
    return out;
  }, [srcRgba, srcWidth, srcHeight]);

  // Sizing: 36px square swatches; row + tiny labels = ~52px total vertical. Replaces the
  // bulkier source thumbnail one-for-one and packs four times the information density.
  const SWATCH = 36;

  return (
    <div style={{ position: "relative", marginTop: 4 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
        {PRESETS.map(({ key, label, tip }) => {
          const isActive = active === key;
          const isHover = hovered === key;
          const ringColor = isActive ? "#c19a3a" : isHover ? "#888" : "#555";
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered(h => (h === key ? null : h))}
                onClick={() => onSelect(key)}
                title={tip}
                style={{
                  width: SWATCH, height: SWATCH,
                  // Cover + center keeps the square; shows a center-cropped slice of the
                  // source variant — paint-swatch aesthetic, no stretching.
                  backgroundImage: swatches?.[key] ? `url(${swatches[key]})` : "none",
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: "#1f1f1f",
                  border: `1px solid ${ringColor}`,
                  borderRadius: 2,
                  cursor: "pointer",
                  boxShadow: isActive ? "0 0 0 1px #c19a3a" : "none",
                  transition: "border-color 60ms, box-shadow 60ms",
                }} />
              <span style={{
                fontSize: 9, opacity: isActive || isHover ? 1 : 0.65,
                color: isActive ? "#f0d486" : "#cccccc",
                fontWeight: isActive ? 700 : 400, userSelect: "none",
              }}>{label}</span>
            </div>
          );
        })}
      </div>
      {/* Hover popover — enlarged source facet so the user can read the full image before
          committing the click. Pointer-events:none so it never traps clicks. */}
      {hovered && swatches?.[hovered] && (
        <div style={{
          position: "absolute", top: SWATCH + 22, left: 0, zIndex: 10,
          width: 160, height: 160,
          background: "#111", border: "1px solid #c19a3a", borderRadius: 3,
          padding: 4, boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}>
          <img src={swatches[hovered]} alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        </div>
      )}
    </div>
  );
}
