// SmashSection — slim Smash mode fragment that lives inside MatchTab.
// Receives source/target RGBA snaps as props (no layer pickers, no
// useLayerPreview) and owns only the engine pipeline, amount state,
// persistence, and the controls/audit/apply/export action row.
// The parent drives the matched preview via the onEngineChange callback.

import { useEffect, useMemo, useRef, useState } from "react";
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
import { loadSmashSettings, makeSmashSaver, type SmashPersisted } from "./persistence";
import { applySmashLut } from "../../app/smash/applySmashLut";

// ────────── public types ──────────

export interface SmashSectionLayerSnap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface SmashSectionProps {
  /** Source layer RGBA from the parent's useLayerPreview. Null when nothing
   *  picked or snap pending. */
  sourceSnap: SmashSectionLayerSnap | null;
  /** Target layer RGBA. Null when nothing picked. */
  targetSnap: SmashSectionLayerSnap | null;
  /** Fired whenever the engine rebuilds (slider drag, snap arrival). The
   *  parent uses this to drive the matched preview. Receives null when the
   *  engine has no valid output (no snaps yet). */
  onEngineChange?: (engine: SmashEngineOutput | null) => void;
}

// ────────── internal pipeline type ──────────

interface EnginePipeline {
  sourceDNA: SourceDNA;
  engine: SmashEngineOutput;
}

// ────────── component ──────────

export function SmashSection(props: SmashSectionProps): JSX.Element {
  const { sourceSnap, targetSnap, onEngineChange } = props;

  const [amount, setAmount] = useState<number>(SMASH_PRESET_AMOUNTS.strong);
  const [exportStatus, setExportStatus] = useState<string>("");
  const loadedRef = useRef<boolean>(false);

  // Debounced saver — created once per component lifetime.
  const saverRef = useRef<((s: SmashPersisted) => void) | null>(null);
  if (!saverRef.current) saverRef.current = makeSmashSaver(500);

  // Mount: restore persisted amount only — layer ids are managed by the parent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = await loadSmashSettings();
      if (cancelled) return;
      if (typeof persisted?.amount === "number" && Number.isFinite(persisted.amount)) {
        setAmount(Math.max(0, Math.min(1, persisted.amount)));
      }
      loadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []);

  // Save amount on change (debounced 500ms). Skip until initial load resolved.
  useEffect(() => {
    if (!loadedRef.current) return;
    saverRef.current?.({ amount });
  }, [amount]);

  // Engine pipeline: recompute whenever snaps or amount change.
  const pipeline = useMemo<EnginePipeline | null>(() => {
    if (!sourceSnap || !targetSnap) {
      onEngineChange?.(null);
      return null;
    }

    const sourceDNA = extractSourceDNA(sourceSnap.data, sourceSnap.width, sourceSnap.height);
    const targetStructure = extractTargetStructure(targetSnap.data, targetSnap.width, targetSnap.height);
    const profile = pairDNA(sourceDNA, targetStructure);
    const sourceFeatures = extractFeatures(sourceSnap.data, sourceSnap.width, sourceSnap.height, 4);
    const targetFeatures = extractFeatures(targetSnap.data, targetSnap.width, targetSnap.height, 4);
    const controls = { ...DEFAULT_SMASH_CONTROLS, global: amount };
    const engine = smash(sourceFeatures, targetFeatures, profile, controls);

    onEngineChange?.(engine);
    return { sourceDNA, engine };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSnap, targetSnap, amount]);

  const preset = detectPreset(amount);
  const onPresetChange = (next: SmashPreset) => setAmount(SMASH_PRESET_AMOUNTS[next]);

  const onApply = async () => {
    if (!pipeline) return;
    setExportStatus("applying…");
    try {
      const result = await applySmashLut(pipeline.engine);
      if (result.ok) {
        setExportStatus(`applied: ${result.layerName ?? "Smash LUT"}`);
      } else {
        setExportStatus(`apply error: ${result.error ?? "unknown"}`);
      }
    } catch (err: any) {
      setExportStatus(`apply error: ${err?.message ?? err}`);
    }
  };

  const onExportCube = async () => {
    if (!pipeline) return;
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

  const hasSnaps = sourceSnap !== null && targetSnap !== null;

  return (
    <div style={containerStyle}>
      {!hasSnaps && (
        <div style={placeholderStyle}>
          Pick a source and target layer to run Smash.
        </div>
      )}

      {hasSnaps && pipeline && (
        <>
          <div style={sectionLabelStyle}>SOURCE DNA</div>
          <SourceDNAStrip bands={pipeline.sourceDNA.bands} height={36} />
        </>
      )}

      <SmashControlsBar
        amount={amount}
        preset={preset}
        onAmountChange={setAmount}
        onPresetChange={onPresetChange}
        disabled={!hasSnaps}
      />

      {hasSnaps && pipeline && (
        <>
          <div style={sectionLabelStyle}>SMASH AUDIT</div>
          <SmashAuditPanel
            audit={pipeline.engine.audit}
            bandCount={pipeline.engine.profile.bands.length}
          />
        </>
      )}

      {hasSnaps && (
        <div style={actionRowStyle}>
          <div
            style={pipeline ? primaryButtonStyle : primaryButtonDisabledStyle}
            onClick={onApply}
            title="Install the current Smash transform as a Color Lookup adjustment layer above the active layer."
          >
            Apply
          </div>
          <div
            style={pipeline ? actionButtonStyle : actionButtonDisabledStyle}
            onClick={onExportCube}
            title="Bake the current Smash transform to a portable .cube LUT."
          >
            Export .cube
          </div>
          {exportStatus && <span style={statusStyle}>{exportStatus}</span>}
        </div>
      )}
    </div>
  );
}

// ────────── styles ──────────

const containerStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 1, color: "#888",
  textTransform: "uppercase", marginTop: 2,
};

const placeholderStyle: React.CSSProperties = {
  fontSize: 10, color: "#555", lineHeight: 1.4,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, marginTop: 4,
};

const actionButtonStyle: React.CSSProperties = {
  background: "#3a3a3a", color: "#ddd", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 12px", fontFamily: "inherit", fontSize: 11,
  cursor: "pointer", userSelect: "none", display: "inline-block",
};

const actionButtonDisabledStyle: React.CSSProperties = {
  ...actionButtonStyle,
  opacity: 0.4, cursor: "default",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#6ab7ff", color: "#0f1620", border: "1px solid #1a1a1a",
  borderRadius: 3, padding: "5px 14px", fontFamily: "inherit", fontSize: 11,
  fontWeight: 600, cursor: "pointer", userSelect: "none", display: "inline-block",
};

const primaryButtonDisabledStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  opacity: 0.4, cursor: "default",
};

const statusStyle: React.CSSProperties = {
  fontSize: 9, color: "#888", minWidth: 56, textAlign: "right",
};
