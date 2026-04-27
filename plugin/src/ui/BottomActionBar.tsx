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
  //
  // The 5 interactive elements (3 checkboxes + 2 buttons) are flex-shrink:0 → never compress,
  // always visible & clickable. The 3 label text spans are flex-shrink:1 with min-width:0
  // and overflow:hidden but NO ellipsis — so as the panel narrows the words clip silently
  // (looks like they're sliding under the next toggle), then disappear entirely once their
  // span is squeezed to 0. Words are sacrificed; interactive controls always survive.
  const textStyle: React.CSSProperties = {
    overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1,
  };
  const checkboxStyle: React.CSSProperties = { margin: 0, flexShrink: 0 };
  return (
    <div style={{ display: "flex", alignItems: "center", marginTop: 8, fontSize: 10, color: "#cccccc", height: 18, overflow: "hidden", gap: 3 }}>
      <input type="checkbox" checked={deselectOnApply} onChange={e => setDeselectOnApply(e.target.checked)} style={checkboxStyle}
        title="Deselect — drop the active marquee before creating the layer so curves apply to the full target." />
      <span style={{ ...textStyle, marginRight: 7 }}>Deselect</span>
      <input type="checkbox" checked={overwriteOnApply} onChange={e => setOverwriteOnApply(e.target.checked)} style={checkboxStyle}
        title="Replace — on: overwrite the prior Match Curves layer. Off: keep prior layers (hidden) so you can stack alternatives." />
      <span style={{ ...textStyle, marginRight: 7 }}>Replace</span>
      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={checkboxStyle}
        title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles)." />
      <span style={{ ...textStyle, marginRight: 7 }}>Save</span>
      <button onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
        title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
        style={{ height: 16, padding: "0 1px", fontSize: 9, fontWeight: 600, lineHeight: "14px",
                 background: "transparent", color: "#dddddd",
                 border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        {colorSpace.toUpperCase()}
      </button>
      <button onClick={onRefreshAll} title="Refresh source + target previews"
        style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "transparent", color: "#dddddd",
                 border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 11 }}>
        <span style={{ marginTop: -1, lineHeight: 1 }}>⟳</span>
      </button>
    </div>
  );
}
