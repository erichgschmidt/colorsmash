// Source DNA Strip — primary trust-builder for the Smash UI.
// Shows how the engine read the reference image, organized by Shadows / Mids /
// Highlights bands.
//
// Segment WIDTH = the band's luma-range span. The engine cuts bands at equal
// PERCENTILES (each band holds ~1/3 of the pixels by construction — see
// bands.ts), so a pixel-ratio width would always be a useless flat 33/33/33.
// The luma SPAN, by contrast, is genuinely image-dependent: a high-key image
// packs its dark pixels into a narrow shadow band and spreads its bright
// pixels across a wide highlight band, so the strip reads as "mostly
// highlights" — an honest picture of the source's tonal shape. Segments are
// colored by band median Oklab. Styled to feel like a sibling of PaletteStrip.

import React from "react";
import type { BandStats } from "../../core/smash/types";
import { oklabToSrgbByte } from "../../core/perceptual/oklab";

export interface SourceDNAStripProps {
  /** Bands from constructBands(). Length 3, 5, or 7. May be empty (renders nothing). */
  bands: readonly BandStats[];
  /** Optional row height in pixels. Default 32. */
  height?: number;
  /** Optional click handler — receives the clicked band's index. */
  onBandClick?: (index: number) => void;
}

const MIN_SEGMENT_PX = 4;

/**
 * Converts a band's medianOklab to a CSS rgb() string, or returns a dark-gray
 * sentinel for empty bands (sampleCount === 0).
 */
function bandBgColor(band: BandStats): string {
  if (band.sampleCount === 0) return "#2a2a2a";
  const [L, a, b] = band.medianOklab;
  const [r, g, bv] = oklabToSrgbByte(L, a, b);
  return `rgb(${r}, ${g}, ${bv})`;
}

/**
 * Chooses black or white text based on Oklab L (perceived lightness).
 * Threshold at L > 0.55 (roughly sRGB mid-gray) keeps legibility on both
 * light pastels and dark saturated colors.
 */
function textColor(band: BandStats): string {
  return band.medianOklab[0] > 0.55 ? "#000000" : "#ffffff";
}

/**
 * CSS background for a segment. Empty bands get a diagonal stripe overlay so
 * the user can spot "no data" at a glance without relying on color alone.
 */
function segmentBackground(band: BandStats): string {
  const base = bandBgColor(band);
  if (band.sampleCount === 0) {
    // Diagonal stripe over the dark-gray base — unmistakably "no data."
    return (
      `repeating-linear-gradient(` +
      `135deg, ` +
      `transparent 0px, transparent 4px, ` +
      `rgba(255,255,255,0.07) 4px, rgba(255,255,255,0.07) 8px` +
      `), ${base}`
    );
  }
  return base;
}

export function SourceDNAStrip(props: SourceDNAStripProps): JSX.Element | null {
  const { bands, height = 32, onBandClick } = props;

  if (bands.length === 0) return null;

  // Segment width tracks each band's luma-range SPAN (bounds width), not its
  // pixel ratio — the bands are equal-population by construction, so pixel
  // ratio is always a flat ~1/3 and conveys nothing. The span varies per
  // image and shows the source's tonal distribution shape.
  const bandSpan = (b: BandStats): number => Math.max(0, b.bounds[1] - b.bounds[0]);
  const totalSpan = bands.reduce((sum, b) => sum + bandSpan(b), 0) || 1;

  const stripStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "row",
    width: "100%",
    height,
    border: "1px solid #1a1a1a",
    borderRadius: 4,
    overflow: "hidden",
    boxSizing: "border-box",
  };

  return (
    <div style={stripStyle}>
      {bands.map((band, i) => {
        // Proportional flex-grow by luma-range span, with a minimum pixel
        // floor so thin / empty bands stay visible and selectable.
        const proportion = bandSpan(band) / totalSpan;
        const flexGrow = Math.max(MIN_SEGMENT_PX / height, proportion);

        const txt = textColor(band);
        // Pip colors follow the text-color logic: white on dark, muted on light.
        const pipColor = band.medianOklab[0] > 0.55 ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.9)";

        const segmentStyle: React.CSSProperties = {
          flexGrow,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: MIN_SEGMENT_PX,
          background: segmentBackground(band),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          cursor: onBandClick ? "pointer" : "default",
          userSelect: "none",
          overflow: "hidden",
          position: "relative",
          // Hover lift is handled via inline opacity on the segment container;
          // since we cannot use :hover in inline styles we accept a small
          // deviation and leave the hover effect to the CSS cascade or a
          // future wrapper. The component remains purely presentational with
          // no useState.
        };

        // Label: centered, small, bold enough to read on saturated backgrounds.
        const labelStyle: React.CSSProperties = {
          fontSize: 9,
          fontWeight: 600,
          color: txt,
          letterSpacing: "0.03em",
          lineHeight: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "90%",
          textAlign: "center",
        };

        // Pip row sits below the label.
        const pipRowStyle: React.CSSProperties = {
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
        };

        // Neutral pip — filled circle. Opacity tracks neutralDensity.
        const neutralPipStyle: React.CSSProperties = {
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: pipColor,
          opacity: band.neutralDensity,
          flexShrink: 0,
        };

        // Accent pip — CSS triangle pointing up. Opacity tracks accentDensity.
        // border-left / border-right / border-bottom trick: a 0-width element
        // with transparent side borders and a colored bottom border.
        const accentPipStyle: React.CSSProperties = {
          width: 0,
          height: 0,
          borderLeft: "3px solid transparent",
          borderRight: "3px solid transparent",
          borderBottom: `5px solid ${pipColor}`,
          opacity: band.accentDensity,
          flexShrink: 0,
        };

        const handleClick = onBandClick ? () => onBandClick(i) : undefined;

        return (
          <div
            key={`dna-band-${i}`}
            style={segmentStyle}
            onClick={handleClick}
            title={`${band.label} — luma ${Math.round(band.bounds[0] * 100)}–${Math.round(band.bounds[1] * 100)} (spans ${(proportion * 100).toFixed(0)}% of the tonal range; bands are equal-population, ~${(100 / bands.length).toFixed(0)}% of pixels each)`}
          >
            <div style={labelStyle}>{band.label}</div>
            <div style={pipRowStyle}>
              <div style={neutralPipStyle} />
              <div style={accentPipStyle} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
