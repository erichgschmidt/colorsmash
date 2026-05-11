import { uxpConfirm } from "./uxpConfirm";

// Bottom action bar for MatchTab.
// v1.19.1: reverted from the gear-icon-only layout — Deselect / Replace /
// Save pills back inline, with Reset (✕) + Refresh (⟳) icons trailing.
// The brief v1.19.0 experiment hiding the pills behind a settings popover
// made the controls hard to find; users expect "set once, ignored after"
// prefs to still be VISIBLE, not buried.
// Pill style matches segmented controls elsewhere (RGB/Lab/LUT, Off/Focus/
// Exclude, Multi/Blend If/Adaptive).

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

  const handleResetClick = async () => {
    const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
    if (ok) onResetAll();
  };

  // Pill style — neutral gray (matches RGB/Lab/LUT segmented control).
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
      height: 18, lineHeight: "18px", overflow: "hidden", gap: 4,
      width: "100%", minWidth: 0,
    }}>
      <div onClick={() => setDeselectOnApply(!deselectOnApply)}
        style={pillStyle(deselectOnApply)}
        title="Deselect — drop the active marquee before creating the layer so curves/LUT apply to the full target. Independent of the marquee Focus/Exclude tristate above the Apply button.">
        DESELECT
      </div>
      <div onClick={() => setOverwriteOnApply(!overwriteOnApply)}
        style={pillStyle(overwriteOnApply)}
        title="Replace — on: overwrite the prior Match Curves/LUT layer in [Color Smash] on Apply. Off: keep prior layers (hidden) so you can stack alternatives.">
        REPLACE
      </div>
      <div onClick={() => setRemember(!remember)}
        style={pillStyle(remember)}
        title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles, output mode, LUT options).">
        SAVE
      </div>
      <button onClick={handleResetClick}
        title="Reset all settings to defaults and clear the saved file"
        style={{ width: 18, height: 18, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 12, lineHeight: 1,
                 border: "none", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ marginTop: -1 }}>✕</span>
      </button>
      <div onClick={onRefreshAll}
        title={stale
          ? "Photoshop changed since last refresh — click to resync"
          : "In sync. Click to refresh source + target previews + layer lists"}
        style={{
          width: 18, height: 18, padding: 0, marginLeft: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: stale ? "#c19a3a" : "transparent",
          color: stale ? "#fff" : "#aaa",
          border: `1px solid ${stale ? "#c19a3a" : "#888"}`,
          borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 14, userSelect: "none",
        }}>
        <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
      </div>
    </div>
  );
}
