// Quick-select preset swatches: 1x4 row of small square previews under the source area.
// Each square shows the variant applied to the (downsampled) target — center-cropped
// like a paint swatch, not stretched. Hover reveals an enlarged popover so the user
// can read the full effect before committing. Click applies that preset to the PS doc.
//
// Why swatch-style (square + center crop):
//  - Vertically minimal — the whole row is ~38px including labels
//  - Square = clear comparable units; the eye lines them up
//  - Center crop avoids the squished-thumbnail look you get with objectFit: contain
//  - Hover is a *peek*, not a click — preview is non-destructive

import { useEffect, useMemo, useRef, useState } from "react";
import { rgbaToPngDataUrl } from "./encodePng";
import {
  ChannelCurves, Preset, applyChannelCurvesToRgba, applyPresetPostprocess,
  transformCurvesForPreset,
} from "../core/histogramMatch";

const PRESETS: { key: Preset; label: string; tip: string }[] = [
  { key: "color",    label: "Color",    tip: "Full color match — per-channel R/G/B curves transfer the source's tone + color." },
  { key: "hue",      label: "Hue",      tip: "Hue only — take the source's color but keep the target's brightness and saturation." },
  { key: "bw",       label: "B&W",      tip: "Black & white — match source's tonal contrast as a grayscale render." },
  { key: "contrast", label: "Contrast", tip: "Contrast / luma only — match the source's tonal curve, keep the target's existing colors." },
];

export interface PresetStripProps {
  // Pixel snapshots already used for the main preview. Both required to render swatches.
  srcRgba: Uint8Array | null;
  tgtRgba: Uint8Array | null;
  tgtWidth: number;
  tgtHeight: number;
  // Pre-computed base curves (the same fittedRaw the main preview uses). When present we
  // skip refitting; otherwise the strip is hidden. This keeps the strip in lockstep with
  // whatever the rest of the panel is showing.
  baseCurves: ChannelCurves | null;
  // Click handler — caller commits the preset to PS via applyMatch.
  onApply: (preset: Preset) => void;
}

export function PresetStrip(props: PresetStripProps) {
  const { srcRgba, tgtRgba, tgtWidth, tgtHeight, baseCurves, onApply } = props;
  const [hovered, setHovered] = useState<Preset | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Compute the 4 transformed RGBA buffers + PNG data URLs once per (curves, target).
  // Cheap enough to run synchronously inside useMemo — full preview pipeline already
  // does the same on every slider tick.
  const swatches = useMemo(() => {
    if (!srcRgba || !tgtRgba || !baseCurves) return null;
    const out: Record<Preset, string> = { color: "", hue: "", bw: "", contrast: "" };
    for (const { key } of PRESETS) {
      const c = transformCurvesForPreset(baseCurves, key);
      const mapped = applyChannelCurvesToRgba(tgtRgba, c);
      const final = applyPresetPostprocess(tgtRgba, mapped, key);
      try { out[key] = rgbaToPngDataUrl(final, tgtWidth, tgtHeight); } catch { out[key] = ""; }
    }
    return out;
  }, [srcRgba, tgtRgba, tgtWidth, tgtHeight, baseCurves]);

  // Close hover popover if the strip loses pointer (e.g. click-drag elsewhere).
  useEffect(() => {
    const onLeave = (e: MouseEvent) => {
      if (!stripRef.current) return;
      const r = stripRef.current.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        setHovered(null);
      }
    };
    window.addEventListener("mousemove", onLeave);
    return () => window.removeEventListener("mousemove", onLeave);
  }, []);

  if (!swatches) return null;

  // Sizing: 36px square swatches with a 2px gap and a tiny label under each. The whole
  // row is ~50px tall including the label — ~1/4 of the matched preview's footprint.
  const SWATCH = 36;
  return (
    <div ref={stripRef} style={{ position: "relative", marginTop: 6 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
        {PRESETS.map(({ key, label, tip }) => {
          const isHover = hovered === key;
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered(h => (h === key ? null : h))}
                onClick={() => onApply(key)}
                title={tip}
                style={{
                  width: SWATCH, height: SWATCH,
                  // background-image with cover + center keeps the swatch a perfect square
                  // and shows a center-cropped slice of the rendered preview. No stretch.
                  backgroundImage: swatches[key] ? `url(${swatches[key]})` : "none",
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: "#1f1f1f",
                  border: `1px solid ${isHover ? "#c19a3a" : "#555"}`,
                  borderRadius: 2,
                  cursor: "pointer",
                  boxShadow: isHover ? "0 0 0 1px #c19a3a" : "none",
                  transition: "border-color 60ms, box-shadow 60ms",
                }} />
              <span style={{ fontSize: 9, opacity: isHover ? 1 : 0.65, color: "#cccccc", userSelect: "none" }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      {/* Hover popover — enlarged preview of the hovered swatch. Floats above the rest of
          the panel without taking layout space. Aspect-true (objectFit: contain) so the
          popover gives the "see the whole thing" view that the cropped swatch can't. */}
      {hovered && swatches[hovered] && (
        <div style={{
          position: "absolute", top: SWATCH + 22, left: 0, zIndex: 10,
          width: 160, height: 160,
          background: "#111", border: "1px solid #c19a3a", borderRadius: 3,
          padding: 4, boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
          pointerEvents: "none", // popover is purely visual — don't trap mouse events
        }}>
          <img src={swatches[hovered]} alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        </div>
      )}
    </div>
  );
}
