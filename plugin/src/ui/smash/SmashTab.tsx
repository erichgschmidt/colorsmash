// Phase 1 SmashTab — wires the Pro engine end-to-end through the shipped UI
// pieces (SourceDNAStrip + SmashControlsBar + SmashAuditPanel).
//
// Current scope: DEMO MODE. Source and target are synthesized gradients so the
// engine can be exercised without Photoshop layer integration. Each slider
// drag re-runs the full pipeline (extract → pair → smash). Layer pickers,
// live preview, and the Apply / Export buttons land in the next milestone
// (ColorSmash_Masterplan_v1.md §5 Phase 1, items remaining: SmashTab to
// real engine wiring + Persist Smash preset).

import { useMemo, useState } from "react";
import { SourceDNAStrip } from "./SourceDNAStrip";
import {
  SmashControlsBar,
  type SmashPreset,
  SMASH_PRESET_AMOUNTS,
  detectPreset,
} from "./SmashControlsBar";
import { SmashAuditPanel } from "./SmashAuditPanel";
import {
  extractFeatures,
  extractSourceDNA,
  extractTargetStructure,
  pairDNA,
  smash,
  DEFAULT_SMASH_CONTROLS,
  type SmashEngineOutput,
  type SourceDNA,
} from "../../core/smash";

const DEMO_W = 64;
const DEMO_H = 64;

// Warm source: deep maroon → cream highlight.
const SOURCE_COLD: [number, number, number] = [60, 30, 20];
const SOURCE_WARM: [number, number, number] = [255, 220, 180];

// Cool target: deep blue → pale sky highlight.
const TARGET_COLD: [number, number, number] = [20, 30, 60];
const TARGET_WARM: [number, number, number] = [180, 220, 255];

function makeGradient(
  w: number,
  h: number,
  c0: readonly [number, number, number],
  c1: readonly [number, number, number],
): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / Math.max(1, w + h - 2);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

interface DemoPipeline {
  sourceDNA: SourceDNA;
  engine: SmashEngineOutput;
}

function buildDemo(amount: number): DemoPipeline {
  const sourceRgba = makeGradient(DEMO_W, DEMO_H, SOURCE_COLD, SOURCE_WARM);
  const targetRgba = makeGradient(DEMO_W, DEMO_H, TARGET_COLD, TARGET_WARM);

  const sourceDNA = extractSourceDNA(sourceRgba, DEMO_W, DEMO_H);
  const targetStructure = extractTargetStructure(targetRgba, DEMO_W, DEMO_H);
  const profile = pairDNA(sourceDNA, targetStructure);

  const sourceFeatures = extractFeatures(sourceRgba, DEMO_W, DEMO_H, 1);
  const targetFeatures = extractFeatures(targetRgba, DEMO_W, DEMO_H, 1);

  const controls = { ...DEFAULT_SMASH_CONTROLS, global: amount };
  const engine = smash(sourceFeatures, targetFeatures, profile, controls);

  return { sourceDNA, engine };
}

export function SmashTab() {
  const [amount, setAmount] = useState<number>(SMASH_PRESET_AMOUNTS.strong);

  const demo = useMemo<DemoPipeline>(() => buildDemo(amount), [amount]);
  const preset = detectPreset(amount);

  const onPresetChange = (next: SmashPreset) => {
    setAmount(SMASH_PRESET_AMOUNTS[next]);
  };

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={headerStyle}>SMASH ENGINE</div>

      <div style={demoBannerStyle}>
        Demo mode — synthetic warm→cool transfer. Photoshop layer integration
        and Apply / Export are next.
      </div>

      <div style={sectionLabelStyle}>SOURCE DNA</div>
      <SourceDNAStrip bands={demo.sourceDNA.bands} height={36} />

      <SmashControlsBar
        amount={amount}
        preset={preset}
        onAmountChange={setAmount}
        onPresetChange={onPresetChange}
      />

      <div style={sectionLabelStyle}>SMASH AUDIT</div>
      <SmashAuditPanel
        audit={demo.engine.audit}
        bandCount={demo.engine.profile.bands.length}
      />
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 1.5,
  color: "#ddd",
  textTransform: "uppercase",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 1,
  color: "#888",
  textTransform: "uppercase",
  marginTop: 2,
};

const demoBannerStyle: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.4,
  color: "#aaa",
  background: "#2e2e2e",
  border: "1px dashed #444",
  borderRadius: 4,
  padding: "6px 8px",
};
