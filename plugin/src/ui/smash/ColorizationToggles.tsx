// ColorizationToggles — Phase 4.5 disclosure panel for cross-dimensional
// colorization mechanics. Sits below the TRAITS sliders in SmashSection and
// exposes toggles that activate when the target's chroma is too low for the
// per-dimension CDF match to produce color on its own (e.g., grayscale target).
// Structured with one row now (Phase 4.5: Hue-by-L) and trivially accepts
// Phase 5+ rows (stochastic per-L, conditional CDF, sliced OT) as additions.

import React from "react";

// ────────── public types ──────────

export interface ColorizationToggleState {
  /** Phase 4.5 — Hue-by-L lookup. ON = smashed hue is the source's L→(a,b)
   *  direction at the smashed L (source-driven color story). OFF = smashed
   *  hue comes from the per-pixel hue CDF (target's own hue layout, rank-
   *  mapped). */
  readonly hueByLuma: boolean;
  /** Phase 4.5b — Lift neutrals. ON = near-neutral target pixels get a
   *  chroma floor at source's median chroma so shadows in grayscale-ish
   *  targets colorize broadly. OFF = chroma comes from per-dim CDF
   *  unchanged (faithful to source's L→C structure; shadows stay
   *  monochrome when source's shadows are neutral). */
  readonly liftNeutrals: boolean;
  /** Phase 4.5d — Palette snap. ON = each output pixel's hue snaps to the
   *  nearest source CLUSTER instead of using the per-L average. Preserves
   *  source's color identity — minority colors get expressed when the
   *  target has any chromatic variation (anti-aliasing, JPEG noise, real
   *  color). OFF = smoother averaged output. */
  readonly paletteSnap: boolean;
  // Future toggles (Phase 5+) added here:
  //   readonly stochasticPerL: boolean;   // noise-preserving sampling
  //   readonly conditionalCdf: boolean;   // P(color|L) match
  //   readonly slicedOt: boolean;         // sliced optimal transport
}

export const DEFAULT_COLORIZATION_TOGGLES: ColorizationToggleState = {
  hueByLuma: true,     // ON by default — source-driven color story
  liftNeutrals: true,  // ON by default — broad colorization across L
  paletteSnap: false,  // OFF by default — opt-in for stronger color identity
};

export interface ColorizationTogglesProps {
  state: ColorizationToggleState;
  onChange: (next: ColorizationToggleState) => void;
  disabled?: boolean;
}

// ────────── toggle row descriptor ──────────

interface ToggleRowDef {
  key: keyof ColorizationToggleState;
  label: string;
  description: string;
  tooltip: string;
}

const TOGGLE_ROWS: ToggleRowDef[] = [
  {
    key: "hueByLuma",
    label: "Hue-by-L",
    description: "Pulls hue from source's L→(a,b) correlation. Chroma magnitude from CDF stays the same.",
    tooltip:
      "Hue-by-L (Phase 4.5): The smashed hue is aimed at the source's average (a,b) " +
      "direction for each luminance bucket, while chroma magnitude still comes from the " +
      "per-dimension chroma CDF. Net effect: ON produces a source-driven color story by " +
      "lightness; OFF preserves the target's own per-pixel hue (rank-mapped onto source's " +
      "hue distribution). ON is always at least as colorful as OFF.",
  },
  {
    key: "liftNeutrals",
    label: "Lift neutrals",
    description: "Floors chroma at source's median magnitude for near-neutral pixels. Lifts shadows in grayscale targets.",
    tooltip:
      "Lift neutrals (Phase 4.5b): Without this floor, a grayscale-ish target's near-" +
      "neutral pixels rank at the bottom of the chroma CDF and pick up source's MINIMUM " +
      "chroma (≈0 for sources with dark backgrounds), so shadows stay monochrome even " +
      "with Hue-by-L on. With the floor, near-neutral pixels get source's TYPICAL chroma " +
      "magnitude paired with Hue-by-L's direction — broad colorization across the whole " +
      "L range. Vivid input pixels (Cin ≥ 0.15) are unaffected; only neutrals are lifted.",
  },
  {
    key: "paletteSnap",
    label: "Palette snap",
    description: "Each pixel's hue snaps to the nearest source cluster. Expresses minority colors instead of averaging them away.",
    tooltip:
      "Palette snap (Phase 4.5d): Replaces the per-L bucket average with a discrete " +
      "snap to the nearest source CLUSTER. Different input pixels can pick different " +
      "clusters → minority colors in the source (e.g., 10% gray in a 90% red source) " +
      "actually show up in the output instead of being averaged away. Diversity emerges " +
      "when the target has any chromatic variation (edges, JPEG noise, real color); " +
      "perfectly flat grayscale fills still get a uniform cluster pick. OFF = smooth " +
      "averaged output (Hue-by-L behavior). ON = discrete color identity per pixel.",
  },
];

// ────────── accent blue — matches PRO badge + SmashControlsBar active chip ──

const ACCENT_BLUE = "#6ab7ff";

// ────────── component ──────────

export function ColorizationToggles(props: ColorizationTogglesProps): JSX.Element {
  const { state, onChange, disabled = false } = props;

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: 8,
    background: "#2e2e2e",
    border: "1px solid #1a1a1a",
    borderRadius: 4,
    opacity: disabled ? 0.5 : 1,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    cursor: disabled ? "default" : "pointer",
    userSelect: "none",
  };

  const rowInnerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
  };

  return (
    <div style={containerStyle}>
      {TOGGLE_ROWS.map((row) => {
        const isOn = state[row.key];

        const checkboxStyle: React.CSSProperties = {
          width: 16,
          height: 16,
          background: isOn ? ACCENT_BLUE : "#3a3a3a",
          border: `1px solid ${isOn ? ACCENT_BLUE : "#1a1a1a"}`,
          borderRadius: 2,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          fontSize: 11,
          lineHeight: 1,
          color: "#fff",
          fontWeight: 700,
        };

        const labelStyle: React.CSSProperties = {
          fontSize: 10,
          fontWeight: 500,
          color: isOn ? "#ccc" : "#777",
        };

        const descStyle: React.CSSProperties = {
          fontSize: 9,
          color: "#888",
          paddingLeft: 22, // align with label (16px checkbox + 6px gap)
          lineHeight: 1.4,
        };

        const handleClick = () => {
          if (disabled) return;
          onChange({ ...state, [row.key]: !isOn });
        };

        return (
          <div
            key={row.key}
            style={rowStyle}
            onClick={handleClick}
            title={row.tooltip}
          >
            <div style={rowInnerStyle}>
              <div style={checkboxStyle}>
                {isOn ? "✓" : null}
              </div>
              <span style={labelStyle}>{row.label}</span>
            </div>
            <div style={descStyle}>{row.description}</div>
          </div>
        );
      })}
    </div>
  );
}
