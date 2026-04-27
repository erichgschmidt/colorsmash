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
  liveUpdates: boolean;
  setLiveUpdates: (b: boolean) => void;
  stale: boolean;
}

export function BottomActionBar(props: BottomActionBarProps) {
  const { deselectOnApply, setDeselectOnApply, overwriteOnApply, setOverwriteOnApply,
          remember, setRemember,
          colorSpace, setColorSpace, onRefreshAll, onResetAll,
          liveUpdates, setLiveUpdates, stale } = props;

  // Single-click destructive reset. Opens a UXP modal dialog (window.confirm doesn't
  // exist in UXP — see uxpConfirm.ts for the dialog implementation).
  const handleResetClick = async () => {
    const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
    if (ok) onResetAll();
  };

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
      <button onClick={handleResetClick}
        title="Reset all settings to defaults and clear the saved file"
        style={{ width: 16, height: 16, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 background: "#e66666", color: "#fff", fontWeight: 700, fontSize: 12, lineHeight: 1,
                 border: "none", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ marginTop: -1 }}>✕</span>
      </button>
      <div onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
        title="Toggle color space — RGB matches per-channel histograms; Lab matches in perceptual space."
        style={{ height: 16, padding: "0 2px", marginLeft: 5, display: "inline-flex", alignItems: "center", justifyContent: "center",
                 fontSize: 9, fontWeight: 600, color: "#dddddd",
                 border: "1px solid #888", borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, userSelect: "none" }}>
        <span style={{ marginTop: -1, lineHeight: 1 }}>{colorSpace.toUpperCase()}</span>
      </div>
      {/* Three-in-one: refresh button + live-updates toggle + stale indicator.
          Left click: refresh now (clears stale).
          Right-click or double-click: toggle live updates on/off.
          Background color encodes state at a glance:
            • blue (filled) = live updates ON
            • gray = live updates OFF, in sync
            • amber = live updates OFF, stale (PS state changed since last refresh) */}
      <div
        onClick={onRefreshAll}
        onDoubleClick={(e) => { e.preventDefault(); setLiveUpdates(!liveUpdates); }}
        onContextMenu={(e) => { e.preventDefault(); setLiveUpdates(!liveUpdates); }}
        title={
          liveUpdates
            ? "Live updates ON — auto-syncs to PS changes. Click to refresh now. Right-click or double-click to switch to manual."
            : (stale
                ? "Manual mode — Photoshop changed since last refresh. Click to refresh. Right-click or double-click to enable live updates."
                : "Manual mode — in sync. Click to refresh. Right-click or double-click to enable live updates.")
        }
        style={{
          width: 16, height: 16, padding: 0, marginLeft: 10, display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: liveUpdates ? "#3a7fc1" : (stale ? "#c19a3a" : "transparent"),
          color: liveUpdates || stale ? "#fff" : "#aaa",
          border: liveUpdates ? "1px solid #3a7fc1" : (stale ? "1px solid #c19a3a" : "1px solid #888"),
          borderRadius: 3, cursor: "pointer", boxSizing: "border-box", flexShrink: 0, fontSize: 11, userSelect: "none",
        }}>
        <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
      </div>
    </div>
  );
}
