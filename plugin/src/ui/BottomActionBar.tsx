import { uxpConfirm } from "./uxpConfirm";

// Bottom action bar for MatchTab:
//   left:  Deselect | Overwrite labels (left-anchored, may be visually occluded)
//   right: RGB/LAB toggle + refresh icon button (right-anchored over panel BG)

export interface BottomActionBarProps {
  deselectOnApply: boolean;
  setDeselectOnApply: (b: boolean) => void;
  overwriteOnApply: boolean;
  setOverwriteOnApply: (b: boolean) => void;
  remember: boolean;
  setRemember: (b: boolean) => void;
  onRefreshAll: () => void;
  onResetAll: () => void;
  stale: boolean;
}

export function BottomActionBar(props: BottomActionBarProps) {
  const { deselectOnApply, setDeselectOnApply, overwriteOnApply, setOverwriteOnApply,
          remember, setRemember,
          onRefreshAll, onResetAll, stale } = props;

  // Single-click destructive reset. Opens a UXP modal dialog (window.confirm doesn't
  // exist in UXP — see uxpConfirm.ts for the dialog implementation).
  const handleResetClick = async () => {
    const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
    if (ok) onResetAll();
  };

  // Single left-aligned row of segmented pills + trailing icons:
  //   [DESELECT][REPLACE][SAVE]  [✕] [⟳]
  // v1.18.x: checkbox+label replaced with pill toggles matching the
  // RGB/Lab/LUT and Off/Focus/Exclude visual language elsewhere in the
  // panel. Pills are filled when active, outlined when off — same dim
  // gray vocabulary, no color theming so they read as "settings" not
  // "actions" (the colored pills above — LIVE / SWAP / MASK — are
  // distinct, action-y).
  const ROW_GAP = 4;
  const pillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, height: 18, padding: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
    background: active ? "#3a3a3a" : "transparent",
    color: active ? "#dddddd" : "#888",
    border: `1px solid ${active ? "#888" : "#444"}`,
    borderRadius: 2, cursor: "pointer", userSelect: "none",
    lineHeight: "16px", boxSizing: "border-box",
  });
  return (
    <div style={{
      display: "flex", flexWrap: "nowrap", alignItems: "center",
      marginTop: 8, fontSize: 10, color: "#cccccc",
      height: 18, lineHeight: "18px", overflow: "hidden", gap: ROW_GAP,
      width: "100%", minWidth: 0,
    }}>
      <div onClick={() => setDeselectOnApply(!deselectOnApply)}
        style={pillStyle(deselectOnApply)}
        title="Deselect — drop the active marquee before creating the layer so curves/LUT apply to the full target. (Independent of the marquee Focus/Exclude toggle above the Apply button.)">
        DESELECT
      </div>
      <div onClick={() => setOverwriteOnApply(!overwriteOnApply)}
        style={pillStyle(overwriteOnApply)}
        title="Replace — on: overwrite the prior Match Curves/LUT layer in [Color Smash] on Apply. Off: keep prior layers (hidden) so you can stack alternatives.">
        REPLACE
      </div>
      <div onClick={() => setRemember(!remember)}
        style={pillStyle(remember)}
        title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles).">
        SAVE
      </div>
      <button onClick={handleResetClick}
        title="Reset all settings to defaults and clear the saved file"
        style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 12, lineHeight: 1,
                 border: "none", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ marginTop: -1 }}>✕</span>
      </button>
      {/* The RGB/Lab/LUT 3-way control moved to the target palette area in
          v1.15.0 — output mode now lives next to the destination it modifies,
          not in the bottom action bar. */}
      <div onClick={onRefreshAll}
        title={stale
          ? "Photoshop changed since last refresh — click to resync"
          : "In sync. Click to refresh source + target previews + layer lists"}
        style={{
          width: 16, height: 16, padding: 0, marginLeft: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: stale ? "#c19a3a" : "transparent",
          color: stale ? "#fff" : "#aaa",
          border: stale ? "1px solid #c19a3a" : "1px solid #888",
          borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 14, userSelect: "none",
        }}>
        <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
      </div>
    </div>
  );
}
