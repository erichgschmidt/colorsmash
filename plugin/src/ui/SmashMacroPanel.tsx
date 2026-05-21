// SmashMacroPanel — the macro-groups foundation view for the Smash tab.
//
// Lists each TARGET macro group (the semantic foundation) and lets the user
// EDIT membership and the per-macro donor. Expanding a group opens an inline
// editor: pick a donor source macro, add/remove member pools, and act on
// contamination ("looks out of place") / nearby-candidate suggestions.
//
// Pure presentation: all state lives upstream; this component only renders
// props and calls back on user intent.

import * as React from "react";
import type { MacroGroup, MacroInfo, MacroSuggestion } from "../core/macro";

export interface PoolChip {
  r: number;
  g: number;
  b: number;
  weightPct: number;
}

export interface SmashMacroPanelProps {
  targetMacros: MacroGroup[]; // ordered weight-desc; { id, name, poolIds }
  targetMacroInfo: Map<number, MacroInfo>; // by target macro id
  sourceMacros: MacroGroup[]; // donor groups (for the donor picker)
  sourceMacroInfo: Map<number, MacroInfo>;
  macroMatch: Map<number, number>; // targetMacroId -> sourceMacroId (editable via onSetDonor)
  macroCount: number;
  onReseed: (k: number) => void; // call with clamped value 2..8
  onRenameMacro: (id: number, name: string) => void;
  onSetDonor: (targetMacroId: number, sourceMacroId: number) => void;
  targetPoolChip: (poolId: number) => PoolChip | undefined; // color+weight% for a target pool
  suggestionsFor: (targetMacroId: number) => MacroSuggestion;
  onAddPoolToMacro: (poolId: number, macroId: number) => void; // +candidate into this macro
  onRemovePoolFromMacro: (poolId: number, fromMacroId: number) => void; // -member (parent rehomes)
  expandedMacroId: number | null; // which macro's editor is open (single-accordion)
  onToggleExpand: (id: number | null) => void;
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

const miniBtnStyle: React.CSSProperties = {
  padding: "0 7px",
  fontSize: 12,
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#3a3a3a",
  color: "#ddd",
  cursor: "pointer",
  userSelect: "none",
};

const summarySwatch: React.CSSProperties = {
  width: 14,
  height: 14,
  flex: "0 0 auto",
  borderRadius: 3,
  border: "1px solid #000",
};

const poolSwatch: React.CSSProperties = {
  width: 12,
  height: 12,
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

const labelStyle: React.CSSProperties = { fontSize: 9, color: "#999" };

const rgbCss = (c: { r: number; g: number; b: number } | undefined): string =>
  c ? `rgb(${c.r}, ${c.g}, ${c.b})` : "#2a2a2a";

const contamBadge: React.CSSProperties = {
  fontSize: 9,
  color: "#1a1a1a",
  background: "#f5a623",
  borderRadius: "50%",
  width: 13,
  height: 13,
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// Stop the name input from toggling the accordion when interacted with.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function SmashMacroPanel(props: SmashMacroPanelProps) {
  const {
    targetMacros,
    targetMacroInfo,
    sourceMacros,
    sourceMacroInfo,
    macroMatch,
    macroCount,
    onReseed,
    onRenameMacro,
    onSetDonor,
    targetPoolChip,
    suggestionsFor,
    onAddPoolToMacro,
    onRemovePoolFromMacro,
    expandedMacroId,
    onToggleExpand,
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
        Each target group only draws donors from its matched source group. Expand
        a group to fix its members or change its donor.
      </div>

      {/* Cards — one per target macro, or an empty-state line */}
      {targetMacros.length === 0 ? (
        <div style={{ fontSize: 10, color: "#9a9aa8" }}>
          Macro groups appear once both images are segmented.
        </div>
      ) : (
        targetMacros.map((macro) => {
          const info = targetMacroInfo.get(macro.id);
          const donorId = macroMatch.get(macro.id);
          const donorInfo = donorId != null ? sourceMacroInfo.get(donorId) : undefined;
          const expanded = expandedMacroId === macro.id;
          const sug = suggestionsFor(macro.id);
          const contamCount = sug.contaminating.length;

          return (
            <div
              key={macro.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                background: "#1f1f1f",
                border: "1px solid #3a3a3a",
                borderRadius: 2,
                padding: "3px 6px",
              }}
            >
              {/* Summary row — clickable to toggle expand */}
              <div
                onClick={() => onToggleExpand(expanded ? null : macro.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              >
                <span style={{ fontSize: 9, color: "#777", width: 8 }}>
                  {expanded ? "▾" : "▸"}
                </span>

                {/* Target swatch */}
                <div
                  title="Target macro group — rename to label it"
                  style={{ ...summarySwatch, background: rgbCss(info) }}
                />

                {/* Editable name (must not toggle the accordion) */}
                <input
                  type="text"
                  value={macro.name}
                  title="Target macro group — rename to label it"
                  onChange={(e) => onRenameMacro(macro.id, e.target.value)}
                  onClick={stop}
                  onPointerDown={stop}
                  onMouseDown={stop}
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

                {/* Matched donor swatch (read in summary; edited when expanded) */}
                {donorInfo ? (
                  <div
                    title="Matched donor group (source)"
                    style={{ ...summarySwatch, background: rgbCss(donorInfo) }}
                  />
                ) : (
                  <span title="Matched donor group (source)" style={{ fontSize: 10, color: "#777" }}>
                    —
                  </span>
                )}

                {/* Contamination badge */}
                {contamCount > 0 && (
                  <span title={`${contamCount} members look out of place`} style={contamBadge}>
                    !
                  </span>
                )}
              </div>

              {/* Expanded inline editor */}
              {expanded && (
                <ExpandedEditor
                  macro={macro}
                  donorId={donorId}
                  sourceMacros={sourceMacros}
                  sourceMacroInfo={sourceMacroInfo}
                  sug={sug}
                  targetMacros={targetMacros}
                  targetPoolChip={targetPoolChip}
                  onSetDonor={onSetDonor}
                  onAddPoolToMacro={onAddPoolToMacro}
                  onRemovePoolFromMacro={onRemovePoolFromMacro}
                />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ────────── expanded inline editor ──────────

interface ExpandedEditorProps {
  macro: MacroGroup;
  donorId: number | undefined;
  sourceMacros: MacroGroup[];
  sourceMacroInfo: Map<number, MacroInfo>;
  sug: MacroSuggestion;
  targetMacros: MacroGroup[];
  targetPoolChip: (poolId: number) => PoolChip | undefined;
  onSetDonor: (targetMacroId: number, sourceMacroId: number) => void;
  onAddPoolToMacro: (poolId: number, macroId: number) => void;
  onRemovePoolFromMacro: (poolId: number, fromMacroId: number) => void;
}

function ExpandedEditor(props: ExpandedEditorProps) {
  const {
    macro,
    donorId,
    sourceMacros,
    sourceMacroInfo,
    sug,
    targetMacros,
    targetPoolChip,
    onSetDonor,
    onAddPoolToMacro,
    onRemovePoolFromMacro,
  } = props;

  const contaminating = new Set(sug.contaminating);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
      {/* Donor group picker */}
      <div style={labelStyle}>Donor group</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {sourceMacros.map((sm) => {
          const sInfo = sourceMacroInfo.get(sm.id);
          const selected = donorId === sm.id;
          return (
            <div
              key={sm.id}
              onClick={() => onSetDonor(macro.id, sm.id)}
              title={sm.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 4px",
                borderRadius: 2,
                cursor: "pointer",
                userSelect: "none",
                border: selected ? "1px solid #1473e6" : "1px solid #3a3a3a",
                background: selected ? "#22364f" : "transparent",
              }}
            >
              <div style={{ ...poolSwatch, background: rgbCss(sInfo) }} />
              <span style={{ fontSize: 9, color: "#aaa" }}>
                {sInfo ? Math.round(sInfo.weight * 100) : 0}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Members */}
      <div style={labelStyle}>Members</div>
      {macro.poolIds.map((poolId) => {
        const chip = targetPoolChip(poolId);
        const flagged = contaminating.has(poolId);
        return (
          <div
            key={poolId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderLeft: flagged ? "2px solid #f5a623" : "2px solid transparent",
              paddingLeft: 2,
            }}
          >
            <div style={{ ...poolSwatch, background: rgbCss(chip) }} />
            <span style={{ fontSize: 9, color: "#aaa" }}>{chip ? chip.weightPct : 0}%</span>
            {flagged && (
              <span title="Looks out of place — consider removing" style={contamBadge}>
                !
              </span>
            )}
            <span style={{ flex: 1 }} />
            <div
              onClick={() => onRemovePoolFromMacro(poolId, macro.id)}
              title="Remove from this group"
              style={miniBtnStyle}
            >
              −
            </div>
          </div>
        );
      })}

      {/* Add nearby — only when there are candidates */}
      {sug.candidates.length > 0 && (
        <>
          <div style={labelStyle}>Add nearby</div>
          {sug.candidates.map((cand) => {
            const chip = targetPoolChip(cand.poolId);
            const fromName =
              targetMacros.find((m) => m.id === cand.fromMacroId)?.name ?? `Macro${cand.fromMacroId}`;
            return (
              <div
                key={cand.poolId}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <div style={{ ...poolSwatch, background: rgbCss(chip) }} />
                <span style={{ fontSize: 9, color: "#aaa" }}>{chip ? chip.weightPct : 0}%</span>
                <span style={{ fontSize: 9, color: "#777", whiteSpace: "nowrap" }}>
                  from {fromName}
                </span>
                <span style={{ flex: 1 }} />
                <div
                  onClick={() => onAddPoolToMacro(cand.poolId, macro.id)}
                  title="Add to this group"
                  style={miniBtnStyle}
                >
                  +
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
