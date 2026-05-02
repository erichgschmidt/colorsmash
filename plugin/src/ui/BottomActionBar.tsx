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

  // Single row, layout strategy:
  //   - Outer relative-positioned box with overflow:hidden + height:18 (no wrapping
  //     possible — children that overflow simply clip, they can't push to a 2nd row)
  //   - Right-cluster ([✕][RGB][⟳]) is position:absolute pinned to the right edge,
  //     so the buttons NEVER disappear regardless of how narrow the panel gets
  //   - Left flex strip holds the [toggle+label] cells; padding-right reserves
  //     space for the button cluster so labels can never crash into them
  //   - Cells shrink with min-width:0 — labels clip silently in narrow panels
  const cell = (basis: number): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 3,
    flex: `0 1 ${basis}px`, minWidth: 0, maxWidth: `${basis}px`,
    overflow: "hidden", whiteSpace: "nowrap",
  });
  const labelTxt: React.CSSProperties = { overflow: "hidden", whiteSpace: "nowrap", minWidth: 0 };
  const checkboxStyle: React.CSSProperties = { margin: 0, flexShrink: 0 };
  // Right cluster: ✕ (16) + gap 6 + RGB (~30) + gap 6 + ⟳ (16) = 74. Reserve 80 for safety.
  const RIGHT_RESERVED = 80;
  return (
    <div style={{ position: "relative", marginTop: 8, height: 18, overflow: "hidden" }}>
      {/* Left strip: label cells. paddingRight keeps labels out from under buttons. */}
      <div style={{
        display: "flex", flexWrap: "nowrap", alignItems: "center",
        height: "100%", paddingRight: RIGHT_RESERVED, gap: 6,
        fontSize: 10, color: "#cccccc",
      }}>
        <label style={{ ...cell(70), cursor: "pointer" }}
          title="Deselect — drop the active marquee before creating the layer so curves apply to the full target.">
          <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={checkboxStyle} />
          <span style={labelTxt}>Deselect</span>
        </label>
        <label style={{ ...cell(65), cursor: "pointer" }}
          title="Replace — on: overwrite the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
          <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={checkboxStyle} />
          <span style={labelTxt}>Replace</span>
        </label>
        <label style={{ ...cell(65), cursor: "pointer" }}
          title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles).">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={checkboxStyle} />
          <span style={labelTxt}>Save</span>
        </label>
      </div>
      {/* Right cluster — absolute-pinned to the right edge so buttons never disappear,
          regardless of how narrow the panel is. The reserved padding above keeps the
          left strip's labels from sliding under these buttons. */}
      <div style={{
        position: "absolute", right: 0, top: 0, height: "100%",
        display: "flex", alignItems: "center", gap: 6,
      }}>
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
            width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
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
