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

/** Per-trait tooltip text for the audit bars. Each describes what the
 *  trait controls in the engine and what its bar percentage represents. */
export const TRAIT_TOOLTIPS: Record<keyof TraitAmounts, string> = {
  value:
    "Value: how strongly the smashed L (perceptual lightness) overrides the input L. " +
    "100% = output L fully matches source's L distribution (after lumaCdf). " +
    "0% = input L preserved. Bar shows traits.value × global gate.",
  hue:
    "Hue: how strongly the smashed hue angle overrides the input hue. " +
    "100% = output hue fully follows source's hue distribution (after hueCdf or Hue-by-L). " +
    "0% = input hue preserved. Clamped to [0, 100%] (circular-wrap overshoot looks broken).",
  saturation:
    "Saturation: targets S = Cout / Lout at the smashed L. Applied AFTER value and chroma " +
    "so it adjusts vibrancy at the newly-decided L. Bar shows traits.saturation × global gate.",
  chroma:
    "Chroma: how strongly the smashed chroma magnitude overrides the input chroma. " +
    "Drives the rank-mapped chroma CDF. 100% = full match to source's chroma distribution. " +
    "Bar shows traits.chroma × global gate.",
  neutral:
    "Neutral protection: PULLS the master gate DOWN on near-neutral inputs. " +
    "Higher = more protection (neutrals shifted less). Per-pixel modulation, not a global gate. " +
    "Bar shows traits.neutral × global gate.",
  accent:
    "Accent boost: PUSHES the master gate UP on rare / vivid input pixels. " +
    "Higher = accent-color pixels get more emphasis. Lets the master gate exceed 1 — " +
    "outputs over-shoot the literal CDF match for vivid inputs.",
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
  const tooltip = fellBack
    ? `Band ${index}: FELL BACK to identity. Either the source or target had < VIABILITY_THRESHOLD samples in this band, so no curves were fit — pixels in this L band pass through unchanged.`
    : `Band ${index}: viable. Curves fit from source/target features within this band's L bounds. Output pixels in this L band get the band's per-channel curves applied (soft-blended with adjacent bands).`;
  return (
    <span key={`band-${index}`} style={pillStyle} title={tooltip}>{`B${index}`}</span>
  );
}

function clusterPill(index: number, bg: string, kind: 'anchored' | 'locked'): React.ReactElement {
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
  const tooltip = kind === 'anchored'
    ? `Cluster ${index} is ANCHORED. (Reserved for Phase 5+ anchor pre-shaping — anchored clusters get preserved through the engine instead of being remapped.)`
    : `Cluster ${index} is LOCKED. (Reserved for Phase 5+ — locked clusters' weight stays fixed regardless of zoneRatio.)`;
  return (
    <span key={`cluster-${bg}-${index}`} style={pillStyle} title={tooltip}>{`C${index}`}</span>
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
    const tip = TRAIT_TOOLTIPS[trait];
    return (
      <div key={trait} style={traitRowStyle} title={tip}>
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
      <span style={mutedStyle} title="No clusters currently anchored. (Anchoring is reserved for Phase 5+ pre-shaping — clusters that should be preserved through the engine instead of remapped.)">—</span>
    ) : (
      audit.clustersAnchored.map((idx) => clusterPill(idx, "#3a3a5a", 'anchored'))
    );

  const lockedPills =
    audit.clustersLocked.length === 0 ? (
      <span style={mutedStyle} title="No clusters currently locked. (Locking is reserved for Phase 5+ — locked clusters keep their natural weight regardless of the ZONE RATIO slider.)">—</span>
    ) : (
      audit.clustersLocked.map((idx) => clusterPill(idx, "#5a3a5a", 'locked'))
    );

  // 5. Status row
  const gamutColor = audit.gamutClipped ? "#ff8866" : "#888";
  const gamutLabel = audit.gamutClipped ? "Yes" : "No";

  return (
    <div
      style={containerStyle}
      title="Smash Audit: diagnostic snapshot of the engine's last run. Trait bars show what each gate contributed; band pills show which L bands had viable curves vs fell back to identity; cluster pills surface anchor/lock state (Phase 5+); gamut indicator flags whether ACES had to compress any pixels into sRGB. Doesn't affect output — purely informational."
    >
      {/* 1. Header */}
      <div style={headerRowStyle}>
        <span style={sectionLabelStyle}>Smash Audit</span>
        <span
          style={elapsedStyle}
          title="Engine build time in milliseconds — how long the most recent smash() call took to compute the engine output (CDF builds, cluster sub-LUTs, median estimation, etc.). Roughly 50-200ms typical; spikes when the source/target snap changes (re-extracts DNA) or when clusterCount changes (re-runs k-means)."
        >{elapsedText}</span>
      </div>

      {/* 2. Trait contribution bars */}
      <div
        style={{ display: "flex", flexDirection: "column", gap: 5 }}
        title="Per-trait contribution bars. Each shows traits[name] × global gate — i.e., how strongly that dimension's smashed value overrides input. Hover individual rows for per-trait detail."
      >
        {traitBars}
      </div>

      {/* 3. Bands */}
      <div>
        <div
          style={{ ...sectionLabelStyle, marginBottom: 5 }}
          title="Bands: the L-axis segments the engine fit per-channel histogram-match curves into. Green = viable (curves fit from enough samples). Red = fell back to identity (too few samples on source or target side). Soft band membership at apply time blends adjacent bands by Gaussian falloff, so band boundaries aren't visible in output."
        >Bands</div>
        <div style={pillsRowStyle}>{bandPills}</div>
      </div>

      {/* 4. Clusters */}
      <div style={clusterSectionStyle}>
        <div
          style={sectionLabelStyle}
          title="Clusters: source palette extracted via k-means in CIE Lab. Used by Distribution, Posterize, Palette Snap, and Zone Routing mechanics. Cluster count is set by the ZONES slider above. Anchor/Lock state is reserved for Phase 5+ pre-shaping (not editable yet)."
        >Clusters</div>
        <div style={clusterRowStyle}>
          <span
            style={clusterLabelStyle}
            title="Anchored clusters (Phase 5+): clusters marked to be preserved through the engine instead of remapped. Currently always empty."
          >Anchored:</span>
          <div style={pillsRowStyle}>{anchoredPills}</div>
        </div>
        <div style={clusterRowStyle}>
          <span
            style={clusterLabelStyle}
            title="Locked clusters (Phase 5+): clusters whose natural weight stays fixed regardless of ZONE RATIO. Currently always empty."
          >Locked:</span>
          <div style={pillsRowStyle}>{lockedPills}</div>
        </div>
      </div>

      {/* 5. Status */}
      <div
        title="Gamut clipped: whether ACES gamut compression had to push any output pixel back into sRGB during this engine run. 'Yes' = some pixels would have landed out-of-gamut and were softly compressed; their hues are preserved but chroma is reduced near the gamut edge."
      >
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
