// One "aspect" row of the per-band Smash UI — a collapsible accordion section.
//
// Header (always visible): chevron + label, the borrow-amount slider, and a
// reset. So a collapsed row is still adjustable. Expanding one row collapses
// the others (the parent owns the accordion state).
//
// Body (when expanded): slice-count + adaptive chips, the SOURCE editable
// ratio band, the TARGET band (which follows the Rank-by cross-feed axis),
// the Rank-by selector, and the Softness slider.
//
// Pure presentational component — all data in via props, changes out via
// callbacks.

import type { RgbTriplet, RankBy } from "../../core/smash/engine";
import { RatioBar } from "./RatioBar";

const RANK_BY_LABELS: Record<RankBy, string> = {
  auto: "Auto",
  value: "Value",
  hue: "Hue",
  saturation: "Saturation",
  chroma: "Chroma",
};

export interface AspectRowProps {
  /** Display label, e.g. "Value", "Hue", "Saturation", "Chroma". */
  label: string;
  /** Accordion state — whether this row's body is shown. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** SOURCE band: per-bin colours, editable absolute weights, the natural
   *  histogram (double-click reset target), and luma-sort flag. */
  sourceSortByLuma: boolean;
  sourceColors: readonly RgbTriplet[];
  sourceWeights: readonly number[];
  sourceNatural: readonly number[];
  onSourceWeightsChange: (next: number[]) => void;
  /** TARGET band — the band feeding the transfer's rank. Follows the Rank-by
   *  axis, so it may be a different axis than this row's own. */
  targetSortByLuma: boolean;
  targetColors: readonly RgbTriplet[];
  targetWeights: readonly number[];
  targetNatural: readonly number[];
  onTargetWeightsChange: (next: number[]) => void;
  /** Name of the axis the TARGET band belongs to when it's cross-fed (Rank-by
   *  set to another axis); null when it's this row's own axis. */
  targetAxisName: string | null;
  /** Borrow/smash amount, 0..1. */
  amount: number;
  onAmountChange: (next: number) => void;
  /** Softness, 0..1 — smooths both bands so transitions aren't hard-stepped. */
  softness: number;
  onSoftnessChange: (next: number) => void;
  /** Cross-feed: which axis supplies this aspect's transfer rank. */
  rankBy: RankBy;
  rankByOptions: readonly RankBy[];
  onRankByChange: (next: RankBy) => void;
  /** Number of slices in this aspect's bands. */
  binCount: number;
  binCountOptions: readonly number[];
  onBinCountChange: (next: number) => void;
  /** Adaptive drag mode for both of this row's bands. */
  adaptive: boolean;
  onAdaptiveChange: (next: boolean) => void;
  /** Reset this aspect to defaults. */
  onReset: () => void;
  /** Disable all controls (no source/target loaded). */
  disabled?: boolean;
}

/** A distribution is "flat" when one slice holds almost all the mass — the
 *  image has essentially no variation along this axis. */
function isFlat(weights: readonly number[]): boolean {
  let total = 0;
  let max = 0;
  for (const x of weights) {
    const v = x > 0 ? x : 0;
    total += v;
    if (v > max) max = v;
  }
  return total < 1e-6 || max / total > 0.9;
}

// ────────── styles ──────────

const rowWrapStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 5,
  paddingBottom: 6, borderBottom: "1px solid #333",
};

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
};

const titleStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, cursor: "pointer",
  userSelect: "none", minWidth: 92, flexShrink: 0,
};

const chevronStyle: React.CSSProperties = {
  width: 9, textAlign: "center", color: "#888", fontSize: 9,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "#ccc",
  textTransform: "uppercase",
};

const sliderStyle: React.CSSProperties = {
  flex: 1, height: 14, minWidth: 40,
};

const valueStyle: React.CSSProperties = {
  fontSize: 10, color: "#aaa", fontVariantNumeric: "tabular-nums",
  minWidth: 34, textAlign: "right",
};

const bandWrapStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
};

const bandTagStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", minWidth: 48,
  display: "flex", flexDirection: "column", gap: 1,
};

const tagNoteStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 600, letterSpacing: 0, textTransform: "none",
};

const arrowStyle: React.CSSProperties = {
  fontSize: 11, color: "#888", textAlign: "center",
};

const subRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
};

const subLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", minWidth: 48,
};

const chipRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, paddingLeft: 56,
};

const countWrapStyle: React.CSSProperties = {
  display: "flex", gap: 2, alignItems: "center", flexShrink: 0,
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 8, fontWeight: 600, lineHeight: 1,
  padding: "2px 4px", borderRadius: 2, cursor: "pointer", userSelect: "none",
  border: `1px solid ${active ? "#6ab7ff" : "#444"}`,
  background: active ? "#6ab7ff" : "transparent",
  color: active ? "#0f1620" : "#999",
});

const resetChipStyle: React.CSSProperties = {
  fontSize: 10, lineHeight: 1, flexShrink: 0,
  padding: "2px 5px", borderRadius: 2, cursor: "pointer", userSelect: "none",
  border: "1px solid #555", background: "transparent", color: "#999",
};

const selectStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 18, fontSize: 10, fontFamily: "inherit",
  padding: "0 18px 0 5px", boxSizing: "border-box", margin: 0,
  appearance: "none" as any, WebkitAppearance: "none" as any,
  background: "#2e2e2e url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'><path d='M0 0l4 5 4-5z' fill='%23999'/></svg>\") no-repeat right 5px center",
  color: "#ddd", border: "1px solid #444", borderRadius: 2, outline: "none",
};

// ────────── component ──────────

export function AspectRow(props: AspectRowProps): JSX.Element {
  const {
    label, expanded, onToggleExpand,
    sourceSortByLuma, sourceColors, sourceWeights, sourceNatural, onSourceWeightsChange,
    targetSortByLuma, targetColors, targetWeights, targetNatural, onTargetWeightsChange,
    targetAxisName,
    amount, onAmountChange,
    softness, onSoftnessChange,
    rankBy, rankByOptions, onRankByChange,
    binCount, binCountOptions, onBinCountChange,
    adaptive, onAdaptiveChange, onReset,
  } = props;
  const disabled = !!props.disabled;

  const amountPct = Math.round(Math.max(0, Math.min(1, amount)) * 100);
  const softnessPct = Math.round(Math.max(0, Math.min(1, softness)) * 100);
  const sourceFlat = isFlat(sourceWeights);
  const targetFlat = isFlat(targetWeights);

  return (
    <div style={rowWrapStyle}>
      <div style={headerStyle}>
        <div
          style={titleStyle}
          onClick={onToggleExpand}
          title={expanded ? `Collapse ${label}` : `Expand ${label}`}
        >
          <span style={chevronStyle}>{expanded ? "▾" : "▸"}</span>
          <span style={labelStyle}>{label}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={amountPct}
          disabled={disabled}
          onChange={(e) => onAmountChange(Number(e.target.value) / 100)}
          style={sliderStyle}
          title={`${label} borrow amount — how strongly the target adopts the source distribution.`}
        />
        <span style={valueStyle}>{amountPct}%</span>
        <div
          style={resetChipStyle}
          onClick={() => { if (!disabled) onReset(); }}
          title={`Reset ${label} to defaults — borrow 100%, softness 0, 16 slices, bands back to the images' own distributions.`}
        >
          ↺
        </div>
      </div>

      {expanded && (
        <>
          <div style={chipRowStyle}>
            <div
              style={countWrapStyle}
              title="Slices — how many segments each band is split into. Fewer = simpler; more = finer."
            >
              {binCountOptions.map((n) => (
                <div
                  key={n}
                  style={chipStyle(n === binCount)}
                  onClick={() => { if (!disabled && n !== binCount) onBinCountChange(n); }}
                >
                  {n}
                </div>
              ))}
            </div>
            <div
              style={chipStyle(adaptive)}
              onClick={() => { if (!disabled) onAdaptiveChange(!adaptive); }}
              title="Adaptive drag — dragging a slice pushes the others aside proportionally, instead of only trading with its neighbour."
            >
              ↔
            </div>
          </div>

          <div style={bandWrapStyle} title={sourceFlat
            ? `The source has almost no variation along ${label} — this band is a single spike and can't be meaningfully reshaped.`
            : undefined}>
            <span style={bandTagStyle}>
              <span>Source</span>
              {sourceFlat && <span style={{ ...tagNoteStyle, color: "#d9a441" }}>flat</span>}
            </span>
            <div style={{ flex: 1, opacity: sourceFlat ? 0.55 : 1 }}>
              <RatioBar
                colors={sourceColors}
                weights={sourceWeights.slice()}
                setWeights={onSourceWeightsChange}
                resetWeights={sourceNatural}
                sortByLuma={sourceSortByLuma}
                adaptive={adaptive}
                disabled={disabled}
                title={`${label} — source ratio band. Drag to reweight; double-click to reset.`}
              />
            </div>
          </div>

          <div style={arrowStyle}>↓</div>

          <div style={bandWrapStyle} title={targetAxisName
            ? `Cross-feed: ${label} is ranked by the ${targetAxisName} axis, so this is the ${targetAxisName} target distribution. Editing it also affects the ${targetAxisName} aspect.`
            : (targetFlat
              ? `The target has almost no variation along ${label} (e.g. a grayscale image) — this band is a single spike. This aspect colorizes by Value rank instead; edit the Source band to shape the result.`
              : undefined)}>
            <span style={bandTagStyle}>
              <span>Target</span>
              {targetAxisName
                ? <span style={{ ...tagNoteStyle, color: "#6ab7ff" }}>↤ {targetAxisName}</span>
                : (targetFlat && <span style={{ ...tagNoteStyle, color: "#d9a441" }}>flat</span>)}
            </span>
            <div style={{ flex: 1, opacity: (targetFlat && !targetAxisName) ? 0.55 : 1 }}>
              <RatioBar
                colors={targetColors}
                weights={targetWeights.slice()}
                setWeights={onTargetWeightsChange}
                resetWeights={targetNatural}
                sortByLuma={targetSortByLuma}
                adaptive={adaptive}
                disabled={disabled}
                title={`Target ratio band${targetAxisName ? ` (${targetAxisName})` : ""}. Drag to reweight; double-click to reset.`}
              />
            </div>
          </div>

          <div style={subRowStyle}>
            <span style={subLabelStyle}>Rank by</span>
            <select
              value={rankBy}
              disabled={disabled}
              onChange={(e) => onRankByChange((e.target as HTMLSelectElement).value as RankBy)}
              style={selectStyle}
              title={`Cross-feed — which axis drives the ${label} transfer. Auto picks the smart choice (${label}'s own spectrum, or Value when this channel is flat). Pick an axis explicitly to rank ${label} by it — e.g. paint hue along the lightness ramp.`}
            >
              {rankByOptions.map((opt) => (
                <option key={opt} value={opt}>{RANK_BY_LABELS[opt]}</option>
              ))}
            </select>
          </div>

          <div style={subRowStyle}>
            <span style={subLabelStyle}>Softness</span>
            <input
              type="range"
              min={0}
              max={100}
              value={softnessPct}
              disabled={disabled}
              onChange={(e) => onSoftnessChange(Number(e.target.value) / 100)}
              style={sliderStyle}
              title="Softness — smooths the transitions between band slices, so the transfer averages across neighbours instead of hard-stepping."
            />
            <span style={valueStyle}>{softnessPct}%</span>
          </div>
        </>
      )}
    </div>
  );
}
