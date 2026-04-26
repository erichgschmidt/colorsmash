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

  // Single left-aligned row: [☐ Deselect] [☐ Overwrite] [☐ Remember] [RGB] [⟳]
  // Each label's checkbox is flex-shrink:0 (fixed width) and the text span is flex-shrink:1
  // with overflow hidden — so as the panel narrows, the label TEXT clips/disappears first
  // while every checkbox and the right-side buttons remain visible and clickable.
  const labelTextStyle: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
  const labelStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 3, cursor: "pointer", minWidth: 0, flexShrink: 1 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 10, color: "#cccccc", height: 18, overflow: "hidden" }}>
      <label style={labelStyle} title="Drop active marquee selection before creating the layer (so curves apply to the full target).">
        <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTextStyle}>Deselect</span>
      </label>
      <label style={labelStyle} title="On: replace the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives.">
        <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTextStyle}>Overwrite</span>
      </label>
      <label style={labelStyle} title="Persist all panel settings across reloads (sliders, zones, envelope, toggles).">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ margin: 0, flexShrink: 0 }} />
        <span style={labelTextStyle}>Remember</span>
      </label>
      <button onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
        title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
        style={{ height: 16, padding: "0 3px", fontSize: 9, fontWeight: 600, lineHeight: "14px",
                 background: "transparent", color: "#dddddd",
                 border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        {colorSpace.toUpperCase()}
      </button>
      <button onClick={onRefreshAll} title="Refresh source + target previews"
        style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "transparent", border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, background: "#bbbbbb", borderRadius: 1 }} />
      </button>
    </div>
  );
}
