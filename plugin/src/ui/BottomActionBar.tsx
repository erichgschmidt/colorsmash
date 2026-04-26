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
}

export function BottomActionBar(props: BottomActionBarProps) {
  const { deselectOnApply, setDeselectOnApply, overwriteOnApply, setOverwriteOnApply,
          remember, setRemember,
          colorSpace, setColorSpace, onRefreshAll } = props;

  return (
    // Bottom action bar: labels left-anchored, buttons right-anchored over panel BG so when
    // space gets tight, the buttons visually occlude the labels (no wrap, no shift).
    <div style={{ position: "relative", height: 18, marginTop: 8, fontSize: 10, color: "#cccccc" }}>
      <div style={{ position: "absolute", left: 0, top: 0, height: 18, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="Drop active marquee selection before creating the layer (so curves apply to the full target).">
          <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={{ margin: 0, verticalAlign: "middle" }} />
          Deselect
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="On: replace the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
          <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={{ margin: 0, verticalAlign: "middle" }} />
          Overwrite
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="Persist all panel settings across reloads (sliders, zones, envelope, toggles).">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ margin: 0, verticalAlign: "middle" }} />
          Remember
        </label>
      </div>
      <div style={{ position: "absolute", right: 0, top: 0, height: 18, display: "flex", alignItems: "center", gap: 4, background: "#535353", paddingLeft: 6 }}>
        <button onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
          title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
          style={{ height: 16, padding: "0 6px", fontSize: 10, fontWeight: 600, lineHeight: "14px",
                   background: "transparent", color: "#dddddd",
                   border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box" }}>
          {colorSpace.toUpperCase()}
        </button>
        <button onClick={onRefreshAll} title="Refresh source + target previews"
          style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                   background: "transparent", border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box" }}>
          <span style={{ width: 8, height: 8, background: "#bbbbbb", borderRadius: 1 }} />
        </button>
      </div>
    </div>
  );
}
