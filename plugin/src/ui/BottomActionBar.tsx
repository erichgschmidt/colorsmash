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

  // Single row: [☐ Deselect] [☐ Replace] [☐ Save] [✕] [RGB] [⟳]
  //
  // Switched from flex to CSS Grid because flex still wrapped in narrow UXP panels
  // even with flexWrap:nowrap (the right-cluster's intrinsic min-content width pushed
  // total beyond container, and UXP's Chromium occasionally still broke to a new line).
  // Grid with minmax(0, basis) does NOT wrap — overflowing tracks just clip — and the
  // checkbox label tracks shrink down to 0, freeing room for the rightmost auto track
  // that holds the [✕][RGB][⟳] cluster. The cluster itself is flex-shrink:0 so buttons
  // stay visible at any width; labels clip silently in their own track.
  const cell: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 3,
    minWidth: 0, overflow: "hidden", whiteSpace: "nowrap",
  };
  const labelTxt: React.CSSProperties = { overflow: "hidden", whiteSpace: "nowrap", minWidth: 0 };
  const checkboxStyle: React.CSSProperties = { margin: 0, flexShrink: 0 };
  return (
    <div style={{
      // Trailing track is an explicit pixel width — UXP's grid implementation
      // sometimes collapses `auto` tracks containing inline-flex children to 0
      // (the buttons disappear). Pinning to ~80px reserves room for [✕][RGB][⟳]
      // + their inter-button margins (~16+16+16+~14 margins ≈ 76px).
      display: "grid",
      gridTemplateColumns: "minmax(0, 70px) minmax(0, 65px) minmax(0, 65px) 80px",
      alignItems: "center", marginTop: 8, fontSize: 10, color: "#cccccc",
      height: 18, overflow: "hidden",
    }}>
      <label style={{ ...cell, cursor: "pointer" }}
        title="Deselect — drop the active marquee before creating the layer so curves apply to the full target.">
        <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Deselect</span>
      </label>
      <label style={{ ...cell, cursor: "pointer" }}
        title="Replace — on: overwrite the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
        <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Replace</span>
      </label>
      <label style={{ ...cell, cursor: "pointer" }}
        title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles).">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Save</span>
      </label>
      {/* Right-cluster track. flex (not inline-flex) so it fills its 80px grid track
          predictably; justify-end aligns the buttons to the right edge. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
      <button onClick={handleResetClick}
        title="Reset all settings to defaults and clear the saved file"
        style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 12, lineHeight: 1,
                 border: "none", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ marginTop: -1 }}>✕</span>
      </button>
      <div onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
        title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
        style={{ height: 16, padding: "0 2px", marginLeft: 3, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 fontSize: 9, fontWeight: 600, color: "#dddddd",
                 border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, userSelect: "none" }}>
        <span style={{ marginTop: 0, lineHeight: 1 }}>{colorSpace.toUpperCase()}</span>
      </div>
      {/* Refresh button + stale indicator. Always manual mode; click to refresh.
          Color: amber when PS state changed since last refresh, otherwise transparent. */}
      <div
        onClick={onRefreshAll}
        title={stale
          ? "Photoshop changed since last refresh — click to resync"
          : "In sync. Click to refresh source + target previews + layer lists"}
        style={{
          width: 16, height: 16, padding: 0, marginLeft: 11, display: "inline-flex", alignItems: "center", justifyContent: "center",
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
