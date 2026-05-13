// Phase 1 SmashTab — wires the Pro engine to real Photoshop layers, with a
// synthetic fallback when nothing is picked yet.
//
// What works now:
//   - source / target layer pickers (minimal, scoped to the active doc)
//   - real RGBA via useLayerPreview (640px max edge, same as MatchTab uses)
//   - DNA / controls / audit re-run on every slider drag
//   - Export .cube button writes the baked 33³ LUT to a user-picked path
//
// What's next (still Phase 1):
//   - Apply button: install the LUT as a Color Lookup adjustment layer
//   - Persist Smash preset (HistoryEntry kind='smash' with embedded DNA)

import { useEffect, useMemo, useState } from "react";
import { app } from "../../services/photoshop";
import { useLayers } from "../useLayers";
import { useLayerPreview } from "../useLayerPreview";
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
  bakeSmashLut,
  serializeSmashCube,
  DEFAULT_SMASH_CONTROLS,
  type SmashEngineOutput,
  type SourceDNA,
} from "../../core/smash";

// ────────── synthetic demo fallback ──────────

const DEMO_W = 64;
const DEMO_H = 64;
const SOURCE_COLD: [number, number, number] = [60, 30, 20];
const SOURCE_WARM: [number, number, number] = [255, 220, 180];
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
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

interface EnginePipeline {
  sourceDNA: SourceDNA;
  engine: SmashEngineOutput;
  demoMode: boolean;
}

function runEngine(
  sourceRgba: Uint8Array,
  srcW: number,
  srcH: number,
  targetRgba: Uint8Array,
  tgtW: number,
  tgtH: number,
  amount: number,
  demoMode: boolean,
): EnginePipeline {
  const sourceDNA = extractSourceDNA(sourceRgba, srcW, srcH);
  const targetStructure = extractTargetStructure(targetRgba, tgtW, tgtH);
  const profile = pairDNA(sourceDNA, targetStructure);
  const sourceFeatures = extractFeatures(sourceRgba, srcW, srcH, 4);
  const targetFeatures = extractFeatures(targetRgba, tgtW, tgtH, 4);
  const controls = { ...DEFAULT_SMASH_CONTROLS, global: amount };
  const engine = smash(sourceFeatures, targetFeatures, profile, controls);
  return { sourceDNA, engine, demoMode };
}

// ────────── component ──────────

export function SmashTab() {
  const [docId, setDocId] = useState<number | null>(null);
  const [sourceLayerId, setSourceLayerId] = useState<number | null>(null);
  const [targetLayerId, setTargetLayerId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number>(SMASH_PRESET_AMOUNTS.strong);
  const [exportStatus, setExportStatus] = useState<string>("");

  // On mount: pick up whatever the active doc + layer is in PS.
  useEffect(() => {
    try {
      const doc = app?.activeDocument;
      if (doc) {
        setDocId(doc.id);
        const active = doc.activeLayers?.[0];
        if (active) setSourceLayerId(active.id);
      }
    } catch {
      /* not in PS; demo fallback will render */
    }
  }, []);

  const { layers, refresh } = useLayers(docId);
  const srcSnap = useLayerPreview(docId, sourceLayerId);
  const tgtSnap = useLayerPreview(docId, targetLayerId);

  const pipeline = useMemo<EnginePipeline>(() => {
    if (srcSnap.snap && tgtSnap.snap) {
      return runEngine(
        srcSnap.snap.data, srcSnap.snap.width, srcSnap.snap.height,
        tgtSnap.snap.data, tgtSnap.snap.width, tgtSnap.snap.height,
        amount,
        /* demoMode */ false,
      );
    }
    // Fallback: synthetic warm→cool demo so the panel always renders something.
    return runEngine(
      makeGradient(DEMO_W, DEMO_H, SOURCE_COLD, SOURCE_WARM), DEMO_W, DEMO_H,
      makeGradient(DEMO_W, DEMO_H, TARGET_COLD, TARGET_WARM), DEMO_W, DEMO_H,
      amount,
      /* demoMode */ true,
    );
  }, [srcSnap.snap, tgtSnap.snap, amount]);

  const preset = detectPreset(amount);
  const onPresetChange = (next: SmashPreset) => setAmount(SMASH_PRESET_AMOUNTS[next]);

  const onExportCube = async () => {
    setExportStatus("baking…");
    try {
      const lut = bakeSmashLut(pipeline.engine, 33);
      const cubeText = serializeSmashCube(lut, "ColorSmash");
      // Lazy-load UXP storage so the test environment never touches it.
      const uxp = await import("uxp");
      const fs = (uxp as any).default?.storage?.localFileSystem
        ?? (uxp as any).storage?.localFileSystem;
      if (!fs) throw new Error("UXP storage unavailable");
      const entry = await fs.getFileForSaving("ColorSmash.cube", { types: ["cube"] });
      if (!entry) { setExportStatus("cancelled"); return; }
      await entry.write(cubeText);
      setExportStatus(`saved ${entry.name}`);
    } catch (err: any) {
      setExportStatus(`error: ${err?.message ?? err}`);
    }
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>SMASH ENGINE</div>

      {pipeline.demoMode && (
        <div style={demoBannerStyle}>
          Demo mode — pick a source and target layer below to run on real pixels.
        </div>
      )}

      <LayerRow
        label="SOURCE"
        layers={layers}
        value={sourceLayerId}
        onChange={setSourceLayerId}
        onRefresh={refresh}
        snapInfo={srcSnap.snap}
        error={srcSnap.error}
      />
      <LayerRow
        label="TARGET"
        layers={layers}
        value={targetLayerId}
        onChange={setTargetLayerId}
        onRefresh={refresh}
        snapInfo={tgtSnap.snap}
        error={tgtSnap.error}
      />

      <div style={sectionLabelStyle}>SOURCE DNA</div>
      <SourceDNAStrip bands={pipeline.sourceDNA.bands} height={36} />

      <SmashControlsBar
        amount={amount}
        preset={preset}
        onAmountChange={setAmount}
        onPresetChange={onPresetChange}
      />

      <div style={sectionLabelStyle}>SMASH AUDIT</div>
      <SmashAuditPanel
        audit={pipeline.engine.audit}
        bandCount={pipeline.engine.profile.bands.length}
      />

      <div style={actionRowStyle}>
        <button style={actionButtonStyle} onClick={onExportCube} title="Bake the current Smash transform to a portable .cube LUT.">
          Export .cube
        </button>
        {exportStatus && <span style={statusStyle}>{exportStatus}</span>}
      </div>
    </div>
  );
}

// ────────── pickers ──────────

interface LayerRowProps {
  label: string;
  layers: { id: number; name: string; kind?: string }[];
  value: number | null;
  onChange: (id: number | null) => void;
  onRefresh: () => void;
  snapInfo: { width: number; height: number; layerName: string } | null;
  error: string | null;
}

function LayerRow(props: LayerRowProps) {
  const { label, layers, value, onChange, onRefresh, snapInfo, error } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ ...sectionLabelStyle, width: 56, marginTop: 0 }}>{label}</div>
      <select
        style={selectStyle}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
      >
        <option value="">— pick a layer —</option>
        {layers.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
      <div
        title="Refresh layer list"
        style={refreshButtonStyle}
        onClick={onRefresh}
      >⟳</div>
      <div style={statusStyle}>
        {error ? `! ${error}` : snapInfo ? `${snapInfo.width}×${snapInfo.height}` : "—"}
      </div>
    </div>
  );
}

// ────────── styles ──────────

const containerStyle: React.CSSProperties = {
  padding: 12, display: "flex", flexDirection: "column", gap: 10,
};

const headerStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, letterSpacing: 1.5, color: "#ddd",
  textTransform: "uppercase",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", marginTop: 2,
};

const demoBannerStyle: React.CSSProperties = {
  fontSize: 10, lineHeight: 1.4, color: "#aaa", background: "#2e2e2e",
  border: "1px dashed #444", borderRadius: 4, padding: "6px 8px",
};

const selectStyle: React.CSSProperties = {
  flex: 1, height: 22, background: "#2e2e2e", color: "#ddd",
  border: "1px solid #1a1a1a", borderRadius: 2, fontSize: 11, padding: "0 6px",
};

const refreshButtonStyle: React.CSSProperties = {
  width: 22, height: 22, display: "inline-flex", alignItems: "center",
  justifyContent: "center", cursor: "pointer", border: "1px solid #888",
  borderRadius: 2, color: "#ddd", fontSize: 14, userSelect: "none",
  boxSizing: "border-box", flexShrink: 0,
};

const statusStyle: React.CSSProperties = {
  fontSize: 9, color: "#888", minWidth: 56, textAlign: "right",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, marginTop: 4,
};

const actionButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#ddd", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 12px", fontFamily: "inherit", fontSize: 11,
  cursor: "pointer",
};
