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

  // Single left-aligned row, all flush left with consistent gap:
  //   [☐ Deselect] [☐ Replace] [☐ Save] [✕] [RGB] [⟳]
  //
  // Layout rules:
  //   - flex-wrap:nowrap so the row never breaks to a second line
  //   - Each [toggle+label] cell has a fixed basis but can shrink down to just the
  //     toggle width (label clips silently behind the next cell when compressed)
  //   - The 3 trailing buttons (✕/RGB/⟳) are flex-shrink:0 — they always render
  //     at full size and stay in place; they don't get pushed by label widths
  //   - gap between all items is uniform so visual spacing reads as "equal apart"
  const ROW_GAP = 6;
  // Each cell is a flex container with a fixed basis that can shrink down to JUST
  // the checkbox width. Explicit lineHeight matches row height so text can't push
  // the row taller. The label-span is display:block (not inline) so its overflow
  // truly clips horizontally — inline spans were apparently re-flowing in UXP.
  const cell = (basis: number): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 10,
    flex: `0 1 ${basis}px`, minWidth: 14, maxWidth: `${basis}px`,
    overflow: "hidden", whiteSpace: "nowrap",
    height: 18, lineHeight: "18px",
    cursor: "pointer",
  });
  const labelTxt: React.CSSProperties = {
    display: "block", overflow: "hidden", whiteSpace: "nowrap",
    minWidth: 0, lineHeight: "18px",
  };
  // Lock checkbox width explicitly — UXP renders native checkboxes at variable
  // widths (16-22px) which can violate cell minWidth and force unexpected reflow.
  const checkboxStyle: React.CSSProperties = {
    margin: 0, flexShrink: 0, width: 14, height: 14, padding: 0, boxSizing: "border-box",
  };
  return (
    <div style={{
      display: "flex", flexWrap: "nowrap", alignItems: "center",
      marginTop: 8, fontSize: 10, color: "#cccccc",
      height: 18, lineHeight: "18px", overflow: "hidden", gap: ROW_GAP,
      width: "100%", minWidth: 0,
    }}>
      {/* Use <div> instead of <label> — UXP <label>+<input> has UA-specific
          intrinsic-sizing rules that bypass some flex constraints. Click on the
          <div> still toggles via onClick handler. */}
      <div onClick={() => setDeselectOnApply(!deselectOnApply)} style={cell(70)}
        title="Deselect — drop the active marquee before creating the layer so curves apply to the full target.">
        <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Deselect</span>
      </div>
      <div onClick={() => setOverwriteOnApply(!overwriteOnApply)} style={cell(65)}
        title="Replace — on: overwrite the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
        <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Replace</span>
      </div>
      <div onClick={() => setRemember(!remember)} style={cell(65)}
        title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles).">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={checkboxStyle} />
        <span style={labelTxt}>Save</span>
      </div>
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
      {/* Extra marginLeft so the visual gap from RGB→⟳ matches the gap from ✕→RGB.
          Without it, RGB's wider footprint makes the right gap look tighter. */}
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
