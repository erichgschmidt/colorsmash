// TraitSliders — Phase 2 "Traits" subsection of the Pro Smash panel.
// Six per-dimension sliders (Value, Hue, Saturation, Chroma, Neutral, Accent)
// each gate a distinct component of the per-band histogram-match transfer.
// Pure presentational; no internal state. Sibling of SmashControlsBar.

import React from "react";
import type { TraitAmounts } from "../../core/smash/types";

// ────────── public interface ──────────

export interface TraitSlidersProps {
  /** Current trait values. Amounts in [0, 2]: 0 = no transfer, 1 = literal
   *  CDF match (the engine's natural target), >1 = oversample / extrapolate
   *  past the source distribution for creative crank effects. */
  amounts: TraitAmounts;
  onAmountsChange: (next: TraitAmounts) => void;
  /** When true, all sliders are non-interactive. Used while engine is idle. */
  disabled?: boolean;
  /** Max slider value × 100. Default 200 (allows 2× oversample). Set to 100
   *  to lock sliders to literal-CDF-match (no crank). */
  maxPercent?: number;
}

/** Trait keys rendered in this order. */
export const TRAIT_ORDER: readonly (keyof TraitAmounts)[] = [
  "value",
  "hue",
  "saturation",
  "chroma",
  "neutral",
  "accent",
];

/** Human-readable labels. */
export const TRAIT_LABELS: Record<keyof TraitAmounts, string> = {
  value: "Value",
  hue: "Hue",
  saturation: "Saturation",
  chroma: "Chroma",
  neutral: "Neutral",
  accent: "Accent",
};

/** Brief one-line hover descriptions. */
export const TRAIT_TIPS: Record<keyof TraitAmounts, string> = {
  value: "How much of the source's luma distribution to transfer.",
  hue: "How strongly to push target hues toward the source's hue families.",
  saturation: "How much saturation to transfer from the source.",
  chroma: "How tightly to match the source's chroma spread.",
  neutral: "Protect near-neutral pixels (skin, grays). Higher = more protection.",
  accent: "How much to transfer rare, vivid accent colors.",
};

/**
 * Defaults — all traits at 1 except neutral which is 0.5 and accent which is 0.
 * Matches DEFAULT_SMASH_CONTROLS.traits in core/smash/transform.ts.
 * Exported so callers (SmashSection) can seed initial state and reset.
 */
export const DEFAULT_TRAIT_AMOUNTS: TraitAmounts = {
  value: 1,
  hue: 1,
  saturation: 1,
  chroma: 1,
  neutral: 0.5,
  accent: 0,
};

// ────────── component ──────────

export function TraitSliders(props: TraitSlidersProps): JSX.Element {
  const { amounts, onAmountsChange, disabled = false, maxPercent = 200 } = props;

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
    alignItems: "center",
    gap: 6,
  };

  const labelStyle: React.CSSProperties = {
    width: 60,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "#888",
    flexShrink: 0,
  };

  const sliderStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    margin: 0,
    cursor: disabled ? "default" : "pointer",
    height: 12,
  };

  const numericBase: React.CSSProperties = {
    width: 32,
    fontSize: 10,
    textAlign: "right",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div style={containerStyle}>
      {TRAIT_ORDER.map((trait) => {
        const amount = amounts[trait];
        const intValue = Math.round(amount * 100);
        const isCrank = intValue > 100;

        return (
          <div
            key={trait}
            style={rowStyle}
            title={TRAIT_TIPS[trait]}
          >
            <span style={labelStyle}>{TRAIT_LABELS[trait]}</span>
            <input
              type="range"
              min={0}
              max={maxPercent}
              step={1}
              value={intValue}
              style={sliderStyle}
              onChange={(e) => {
                if (disabled) return;
                const next = parseInt((e.target as HTMLInputElement).value, 10) / 100;
                onAmountsChange({ ...amounts, [trait]: next });
              }}
            />
            <span style={{
              ...numericBase,
              // Crank zone (>100%) → orange, signals destructive extrapolation
              // past the literal source distribution. Below 100 stays muted.
              color: isCrank ? "#ff8866" : "#ccc",
              fontWeight: isCrank ? 600 : 400,
            }}>{intValue}</span>
          </div>
        );
      })}
    </div>
  );
}
