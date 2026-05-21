// SmashMacroPanel — the macro-groups foundation view for the Smash tab.
//
// Lists each TARGET macro group with an editable name + its read-only
// auto-matched SOURCE donor macro, plus a stepper to re-seed how many macro
// groups exist (k, clamped 2..8). Pure presentation: all state lives upstream,
// this component only renders props and calls back on user intent.

import * as React from "react";
import type { MacroGroup, MacroInfo } from "../core/macro";

export interface SmashMacroPanelProps {
  targetMacros: MacroGroup[];                    // ordered, weight-desc
  targetMacroInfo: Map<number, MacroInfo>;       // by target macro id
  sourceMacroInfo: Map<number, MacroInfo>;       // by source macro id
  macroMatch: Map<number, number>;               // targetMacroId -> sourceMacroId (auto; READ-ONLY display)
  macroCount: number;                            // current k
  onReseed: (k: number) => void;                 // user changed the group count; clamp 2..8 before calling
  onRenameMacro: (targetMacroId: number, name: string) => void;
}

const MIN_K = 2;
const MAX_K = 8;

const stepperStyle: React.CSSProperties = {
  padding: "1px 9px",
  fontSize: 12,
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#3a3a3a",
  color: "#ddd",
  cursor: "pointer",
  userSelect: "none",
};

const swatchStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  flex: "0 0 auto",
  borderRadius: 3,
  border: "1px solid #000",
};

const nameInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 10,
  background: "#161616",
  color: "#ccc",
  border: "1px solid #3a3a3a",
  borderRadius: 2,
  padding: "2px 5px",
  outline: "none",
};

const rgbCss = (info: MacroInfo | undefined): string =>
  info ? `rgb(${info.r}, ${info.g}, ${info.b})` : "#2a2a2a";

export function SmashMacroPanel(props: SmashMacroPanelProps) {
  const {
    targetMacros,
    targetMacroInfo,
    sourceMacroInfo,
    macroMatch,
    macroCount,
    onReseed,
    onRenameMacro,
  } = props;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {/* Header row: label + count stepper */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, fontSize: 10, fontWeight: "bold", color: "#cccccc" }}>
          MACRO GROUPS
        </span>
        <div
          onClick={() => onReseed(Math.max(MIN_K, macroCount - 1))}
          title="Fewer macro groups"
          style={stepperStyle}
        >
          −
        </div>
        <span style={{ fontSize: 11, color: "#eee", minWidth: 14, textAlign: "center" }}>
          {macroCount}
        </span>
        <div
          onClick={() => onReseed(Math.min(MAX_K, macroCount + 1))}
          title="More macro groups"
          style={stepperStyle}
        >
          +
        </div>
      </div>

      {/* Hint */}
      <div style={{ fontSize: 9, color: "#999" }}>
        The foundation: each target group only draws donors from its matched
        source group. Rename to label them (skin, hair, …).
      </div>

      {/* Rows — one per target macro, or an empty-state line */}
      {targetMacros.length === 0 ? (
        <div style={{ fontSize: 10, color: "#9a9aa8" }}>
          Macro groups appear once both images are segmented.
        </div>
      ) : (
        targetMacros.map((macro) => {
          const info = targetMacroInfo.get(macro.id);
          const sId = macroMatch.get(macro.id);
          const srcInfo = sId != null ? sourceMacroInfo.get(sId) : undefined;
          return (
            <div
              key={macro.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "#1f1f1f",
                border: "1px solid #3a3a3a",
                borderRadius: 2,
                padding: "3px 6px",
              }}
            >
              {/* Target swatch */}
              <div
                title="Target macro group — rename to label it"
                style={{ ...swatchStyle, background: rgbCss(info) }}
              />

              {/* Editable name */}
              <input
                type="text"
                value={macro.name}
                title="Target macro group — rename to label it"
                onChange={(e) => onRenameMacro(macro.id, e.target.value)}
                style={nameInputStyle}
              />

              {/* Weight · pool count */}
              {info && (
                <span style={{ fontSize: 9, color: "#777", whiteSpace: "nowrap" }}>
                  {Math.round(info.weight * 100)}% · {info.poolCount}p
                </span>
              )}

              {/* Match arrow */}
              <span style={{ fontSize: 10, color: "#777" }}>→</span>

              {/* Matched source donor (read-only) */}
              {srcInfo ? (
                <>
                  <div
                    title="Auto-matched donor group (source)"
                    style={{ ...swatchStyle, background: rgbCss(srcInfo) }}
                  />
                  <span style={{ fontSize: 9, color: "#999", whiteSpace: "nowrap" }}>
                    {Math.round(srcInfo.weight * 100)}%
                  </span>
                </>
              ) : (
                <span
                  title="Auto-matched donor group (source)"
                  style={{ fontSize: 9, color: "#777" }}
                >
                  —
                </span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
