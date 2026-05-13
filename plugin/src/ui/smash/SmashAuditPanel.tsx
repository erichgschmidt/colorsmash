// SmashAuditPanel — decision inspector for the Pro Smash Engine.
// Operationalizes the "Smash is not a black box" promise from
// ColorSmash_Masterplan_v1.md §4.3: one panel that shows which traits
// contributed how much, which bands had usable data, which clusters were
// anchored/locked, whether gamut compression clipped, and build time.

import React from "react";
import type { SmashAudit, TraitAmounts } from "../../core/smash/types";

export interface SmashAuditPanelProps {
  audit: SmashAudit;
  /** Optional: total number of bands the engine had (so the panel can show
   *  "3/3 bands used" or "2/3 bands fell back"). Inferred from
   *  audit.bandsUsed.length if not provided. */
  bandCount?: number;
  /** Optional: total cluster count (so the panel can show "2/5 anchored"
   *  context). Inferred from audit.clustersAnchored if not provided. */
  clusterCount?: number;
}

/** Order in which traits render in the contribution chart. */
export const TRAIT_DISPLAY_ORDER: readonly (keyof TraitAmounts)[] = [
  "value",
  "hue",
  "saturation",
  "chroma",
  "neutral",
  "accent",
];

/** Human-readable labels for traits. */
export const TRAIT_LABELS: Record<keyof TraitAmounts, string> = {
  value: "Value",
  hue: "Hue",
  saturation: "Saturation",
  chroma: "Chroma",
  neutral: "Neutral",
  accent: "Accent",
};

// ---------------------------------------------------------------------------
// Sub-styles (mirrors PaletteStrip / SourceDNAStrip vocabulary)
// ---------------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  background: "#2e2e2e",
  border: "1px solid #1a1a1a",
  borderRadius: 4,
  boxSizing: "border-box",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  color: "#888",
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  lineHeight: 1,
};

const elapsedStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: "monospace",
  color: "#888",
  lineHeight: 1,
};

const traitRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
};

const traitLabelStyle: React.CSSProperties = {
  width: 56,
  flexShrink: 0,
  fontSize: 9,
  color: "#aaa",
  lineHeight: 1,
  whiteSpace: "nowrap" as const,
};

const barTrackStyle: React.CSSProperties = {
  flex: 1,
  height: 8,
  background: "#1a1a1a",
  borderRadius: 2,
  position: "relative" as const,
  overflow: "hidden",
};

const traitValueStyle: React.CSSProperties = {
  width: 32,
  flexShrink: 0,
  fontSize: 9,
  color: "#aaa",
  textAlign: "right" as const,
  lineHeight: 1,
};

const pillsRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flexWrap: "wrap" as const,
  gap: 4,
  alignItems: "center",
};

const mutedStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#555",
  lineHeight: 1,
};

const clusterSectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const clusterRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
};

const clusterLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#888",
  width: 52,
  flexShrink: 0,
  lineHeight: 1,
};

// ---------------------------------------------------------------------------
// Pill factories
// ---------------------------------------------------------------------------

function bandPill(index: number, fellBack: boolean): React.ReactElement {
  const pillStyle: React.CSSProperties = {
    background: fellBack ? "#5a3a3a" : "#3a5a3a",
    color: "#ddd",
    fontSize: 9,
    padding: "2px 6px",
    borderRadius: 8,
    lineHeight: 1,
    userSelect: "none",
    flexShrink: 0,
  };
  return (
    <span key={`band-${index}`} style={pillStyle}>{`B${index}`}</span>
  );
}

function clusterPill(index: number, bg: string): React.ReactElement {
  const pillStyle: React.CSSProperties = {
    background: bg,
    color: "#ddd",
    fontSize: 9,
    padding: "2px 6px",
    borderRadius: 8,
    lineHeight: 1,
    userSelect: "none",
    flexShrink: 0,
  };
  return (
    <span key={`cluster-${bg}-${index}`} style={pillStyle}>{`C${index}`}</span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SmashAuditPanel(props: SmashAuditPanelProps): JSX.Element {
  const { audit } = props;

  // 1. Header row
  const elapsedText =
    audit.elapsedMs > 0 ? `${Math.round(audit.elapsedMs)}ms` : "—";

  // 2. Trait contribution bars
  const traitBars = TRAIT_DISPLAY_ORDER.map((trait) => {
    const contribution =
      (audit.traitContributions as Record<keyof TraitAmounts, number>)[trait] ?? 0;
    const fillPct = Math.min(1, Math.max(0, contribution)) * 100;
    const barFillStyle: React.CSSProperties = {
      position: "absolute",
      top: 0,
      left: 0,
      height: "100%",
      width: `${fillPct}%`,
      background: "#6ab7ff",
      borderRadius: 2,
    };
    return (
      <div key={trait} style={traitRowStyle}>
        <span style={traitLabelStyle}>{TRAIT_LABELS[trait]}</span>
        <div style={barTrackStyle}>
          <div style={barFillStyle} />
        </div>
        <span style={traitValueStyle}>{Math.round(fillPct)}%</span>
      </div>
    );
  });

  // 3. Bands section
  const bandPills =
    audit.bandsUsed.length === 0 ? (
      <span style={mutedStyle}>—</span>
    ) : (
      audit.bandsUsed.map((b) => bandPill(b.index, b.fellBack))
    );

  // 4. Clusters section
  const anchoredPills =
    audit.clustersAnchored.length === 0 ? (
      <span style={mutedStyle}>—</span>
    ) : (
      audit.clustersAnchored.map((idx) => clusterPill(idx, "#3a3a5a"))
    );

  const lockedPills =
    audit.clustersLocked.length === 0 ? (
      <span style={mutedStyle}>—</span>
    ) : (
      audit.clustersLocked.map((idx) => clusterPill(idx, "#5a3a5a"))
    );

  // 5. Status row
  const gamutColor = audit.gamutClipped ? "#ff8866" : "#888";
  const gamutLabel = audit.gamutClipped ? "Yes" : "No";

  return (
    <div style={containerStyle}>
      {/* 1. Header */}
      <div style={headerRowStyle}>
        <span style={sectionLabelStyle}>Smash Audit</span>
        <span style={elapsedStyle}>{elapsedText}</span>
      </div>

      {/* 2. Trait contribution bars */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {traitBars}
      </div>

      {/* 3. Bands */}
      <div>
        <div style={{ ...sectionLabelStyle, marginBottom: 5 }}>Bands</div>
        <div style={pillsRowStyle}>{bandPills}</div>
      </div>

      {/* 4. Clusters */}
      <div style={clusterSectionStyle}>
        <div style={sectionLabelStyle}>Clusters</div>
        <div style={clusterRowStyle}>
          <span style={clusterLabelStyle}>Anchored:</span>
          <div style={pillsRowStyle}>{anchoredPills}</div>
        </div>
        <div style={clusterRowStyle}>
          <span style={clusterLabelStyle}>Locked:</span>
          <div style={pillsRowStyle}>{lockedPills}</div>
        </div>
      </div>

      {/* 5. Status */}
      <div>
        <span style={{ ...sectionLabelStyle, color: "#888" }}>
          Gamut clipped:{" "}
        </span>
        <span style={{ fontSize: 9, color: gamutColor, lineHeight: 1 }}>
          {gamutLabel}
        </span>
      </div>
    </div>
  );
}
