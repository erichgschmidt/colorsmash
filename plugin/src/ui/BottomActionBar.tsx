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

  // Layout: labels left-anchored in reading order (Deselect, Overwrite, Remember); RGB +
  // refresh right-anchored with solid panel-gray bg + higher z-index. As the panel narrows,
  // the right group's bg covers the rightmost label text first — words slide UNDER the
  // buttons/toggles instead of ellipsizing or wrapping. Every checkbox + button stays
  // clickable since none of them ever get covered.
  return (
    <div style={{ position: "relative", height: 18, marginTop: 8, fontSize: 10, color: "#cccccc", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, height: 18, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap", zIndex: 1 }}>
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
      <div style={{ position: "absolute", right: 0, top: 0, height: 18, display: "flex", alignItems: "center", gap: 4, background: "#535353", paddingLeft: 6, zIndex: 2 }}>
        <button onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
          title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
          style={{ height: 16, padding: "0 3px", fontSize: 9, fontWeight: 600, lineHeight: "14px",
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
