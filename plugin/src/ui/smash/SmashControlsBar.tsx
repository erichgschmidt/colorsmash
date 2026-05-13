// Smash Amount slider + preset chip row for the Pro Smash Engine (Phase 1).
// Pure presentational — no internal state, no effects. Styled to match
// PaletteStrip's inline-style vocabulary. Lives under ui/smash/ so only
// the Pro build imports it.

import React from "react";

export type SmashPreset = "subtle" | "balanced" | "strong" | "smash";

export interface SmashControlsBarProps {
  /** Current Smash Amount, 0..1. */
  amount: number;
  /** Currently selected preset chip (may be 'custom' if amount doesn't match
   *  any preset's exact value). 'custom' is implicit — pass undefined for it. */
  preset?: SmashPreset;
  onAmountChange: (next: number) => void;
  onPresetChange: (next: SmashPreset) => void;
  /** Optional disabled state (e.g., while building DNA). */
  disabled?: boolean;
}

/** Preset -> amount mapping. Exported so smash mode can read it for sync. */
export const SMASH_PRESET_AMOUNTS: Record<SmashPreset, number> = {
  subtle: 0.30,
  balanced: 0.60,
  strong: 0.85,
  smash: 1.00,
};

// 0.0051 absorbs IEEE 754 drift: 0.295 - 0.30 evaluates to ~0.00500000000000044
// in double precision, which would falsely fail a strict 0.005 boundary check.
const PRESET_TOLERANCE = 0.0051;

/** Returns the preset whose SMASH_PRESET_AMOUNTS value is within 0.005 of
 *  amount, else undefined. The parent calls this to keep the chip in sync
 *  when the user drags the slider. */
export function detectPreset(amount: number): SmashPreset | undefined {
  for (const key of Object.keys(SMASH_PRESET_AMOUNTS) as SmashPreset[]) {
    if (Math.abs(SMASH_PRESET_AMOUNTS[key] - amount) <= PRESET_TOLERANCE) {
      return key;
    }
  }
  return undefined;
}

const PRESET_LABELS: Record<SmashPreset, string> = {
  subtle: "Subtle",
  balanced: "Balanced",
  strong: "Strong",
  smash: "Smash",
};

const ACCENT_BLUE = "#6ab7ff";
const PRESET_ORDER: SmashPreset[] = ["subtle", "balanced", "strong", "smash"];

export function SmashControlsBar(props: SmashControlsBarProps): JSX.Element {
  const { amount, preset, onAmountChange, onPresetChange, disabled = false } = props;

  const sliderValue = Math.round(amount * 100);

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 8,
    background: "#2e2e2e",
    border: "1px solid #1a1a1a",
    borderRadius: 4,
    opacity: disabled ? 0.5 : 1,
  };

  const amountRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: 1,
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

  const numericStyle: React.CSSProperties = {
    width: 32,
    fontSize: 10,
    color: "#ccc",
    textAlign: "right",
    flexShrink: 0,
  };

  const presetRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 4,
  };

  const presetBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "4px 0",
    fontSize: 10,
    fontWeight: active ? 600 : 500,
    background: active ? ACCENT_BLUE : "#3a3a3a",
    color: active ? "#fff" : "#aaa",
    border: "1px solid #2a2a2a",
    borderRadius: 3,
    cursor: disabled ? "default" : "pointer",
    userSelect: "none",
    textAlign: "center",
    boxSizing: "border-box",
  });

  return (
    <div style={containerStyle}>
      <div style={amountRowStyle}>
        <span style={labelStyle}>Smash Amount</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={sliderValue}
          disabled={disabled}
          style={sliderStyle}
          onChange={(e) => {
            if (disabled) return;
            onAmountChange(parseInt((e.target as HTMLInputElement).value, 10) / 100);
          }}
        />
        <span style={numericStyle}>{sliderValue}</span>
      </div>
      <div style={presetRowStyle}>
        {PRESET_ORDER.map((p) => (
          <div
            key={p}
            style={presetBtnStyle(preset === p)}
            onClick={() => {
              if (disabled) return;
              onPresetChange(p);
            }}
          >
            {PRESET_LABELS[p]}
          </div>
        ))}
      </div>
    </div>
  );
}
