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
  colorSpace: "rgb" | "lab";
  setColorSpace: (updater: (c: "rgb" | "lab") => "rgb" | "lab") => void;
  onRefreshAll: () => void;
  onResetAll: () => void;
  stale: boolean;
}

export function BottomActionBar(props: BottomActionBarProps) {
  const { deselectOnApply, setDeselectOnApply, overwriteOnApply, setOverwriteOnApply,
          remember, setRemember,
          colorSpace, setColorSpace, onRefreshAll, onResetAll, stale } = props;

  // Single-click destructive reset. Opens a UXP modal dialog (window.confirm doesn't
  // exist in UXP — see uxpConfirm.ts for the dialog implementation).
  const handleResetClick = async () => {
    const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
    if (ok) onResetAll();
  };

  // 4-column grid shared with the multi-zone row above (see TOGGLE_GRID_TEMPLATE in
  // MatchTab). Cols 1-3 fixed widths so checkboxes stay vertically aligned with the
  // multi-row checkboxes. Col 4 holds [✕][RGB][⟳] in the bottom; just [☐ Adaptive]
  // in the multi row. The ✕ button (col 4 first) aligns with the Adaptive checkbox.
  const labelTxt: React.CSSProperties = {
    overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, paddingRight: 4,
  };
  const cell: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 3, overflow: "hidden", minWidth: 0,
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 70px) minmax(0, 65px) minmax(0, 65px) auto", alignItems: "center", marginTop: 8, fontSize: 10, color: "#cccccc", height: 18, overflow: "hidden" }}>
      <label style={{ ...cell, cursor: "pointer" }} title="Deselect — drop the active marquee before creating the layer so curves apply to the full target.">
        <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTxt}>Deselect</span>
      </label>
      <label style={{ ...cell, cursor: "pointer" }} title="Replace — on: overwrite the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
        <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTxt}>Replace</span>
      </label>
      <label style={{ ...cell, cursor: "pointer" }} title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles).">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTxt}>Save</span>
      </label>
      {/* Col 4: ✕ + RGB + ⟳ in bottom row, [☐ Adaptive] in multi row. ✕'s left edge
          aligns with the Adaptive checkbox above. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button onClick={handleResetClick}
          title="Reset all settings to defaults and clear the saved file"
          style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                   background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 12, lineHeight: 1,
                   border: "none", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
          <span style={{ marginTop: -1 }}>✕</span>
        </button>
        <div onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
          title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
          style={{ height: 16, padding: "0 2px", display: "inline-flex", alignItems: "center", justifyContent: "center",
                   fontSize: 9, fontWeight: 600, color: "#dddddd",
                   border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, userSelect: "none" }}>
          <span style={{ marginTop: 0, lineHeight: 1 }}>{colorSpace.toUpperCase()}</span>
        </div>
        <div onClick={onRefreshAll}
          title={stale
            ? "Photoshop changed since last refresh — click to resync"
            : "In sync. Click to refresh source + target previews + layer lists"}
          style={{
            width: 16, height: 16, padding: 0, marginLeft: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: stale ? "#c19a3a" : "transparent",
            color: stale ? "#fff" : "#aaa",
            border: stale ? "1px solid #c19a3a" : "1px solid #888",
            borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 14, userSelect: "none",
          }}>
          <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
        </div>
      </div>
    </div>
  );
}
