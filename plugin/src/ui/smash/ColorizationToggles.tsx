// ColorizationToggles — Phase 4.5 disclosure panel for cross-dimensional
// colorization mechanics. Sits below the TRAITS sliders in SmashSection and
// exposes toggles that activate when the target's chroma is too low for the
// per-dimension CDF match to produce color on its own (e.g., grayscale target).
// Structured with one row now (Phase 4.5: Hue-by-L) and trivially accepts
// Phase 5+ rows (stochastic per-L, conditional CDF, sliced OT) as additions.

import React from "react";

// ────────── public types ──────────

export interface ColorizationToggleState {
  /** Phase 4.5 — Hue-by-L lookup. ON = engine engages cross-dimensional
   *  colorization (L -> avg source (a,b) lookup) when target chroma is
   *  low. OFF = engine stays per-dimension CDF only. */
  readonly hueByLuma: boolean;
  // Future toggles (Phase 5+) added here:
  //   readonly stochasticPerL: boolean;   // noise-preserving sampling
  //   readonly conditionalCdf: boolean;   // P(color|L) match
  //   readonly slicedOt: boolean;         // sliced optimal transport
}

export const DEFAULT_COLORIZATION_TOGGLES: ColorizationToggleState = {
  hueByLuma: true, // ON by default — cheap, gives sensible grayscale-target behavior
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
