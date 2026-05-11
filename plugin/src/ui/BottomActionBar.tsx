import { useState } from "react";
import { SettingsPanel } from "./SettingsPanel";

// Bottom action bar for MatchTab.
// v1.18.3: rebuilt as a minimal row of icon buttons. Frequently-touched
// settings (Deselect / Replace / Save) moved into a SettingsPanel popover
// behind the gear icon so the main action bar is uncluttered. ✕ Reset moved
// inside the panel too (always behind a confirmation dialog anyway). The
// refresh ⟳ icon stays as a top-level affordance since it indicates external
// PS state staleness and users may want to click it without diving into
// settings.

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

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Icon button — square, dim gray, brightens on hover (subtle). Used for
  // ⚙ settings + ⟳ refresh below. Stale state for refresh overrides the
  // dim look with the existing amber "needs attention" treatment.
  const iconButton: React.CSSProperties = {
    width: 18, height: 18, padding: 0,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "transparent", color: "#aaa",
    border: "1px solid #555", borderRadius: 3,
    cursor: "pointer", boxSizing: "border-box", flexShrink: 0,
    fontSize: 12, lineHeight: 1, userSelect: "none",
  };

  return (
    <>
      <div style={{
        display: "flex", flexWrap: "nowrap", alignItems: "center",
        marginTop: 8, fontSize: 10, color: "#cccccc",
        height: 20, lineHeight: "20px", overflow: "hidden", gap: 4,
        width: "100%", minWidth: 0, justifyContent: "flex-end",
      }}>
        <div onClick={() => setSettingsOpen(true)}
          style={iconButton}
          title="Settings — Deselect / Replace / Save persistence / Reset">
          <span style={{ marginTop: -1 }}>⚙</span>
        </div>
        <div onClick={onRefreshAll}
          title={stale
            ? "Photoshop changed since last refresh — click to resync"
            : "In sync. Click to refresh source + target previews + layer lists"}
          style={{
            ...iconButton,
            background: stale ? "#c19a3a" : "transparent",
            color: stale ? "#fff" : "#aaa",
            border: stale ? "1px solid #c19a3a" : "1px solid #555",
            fontSize: 14,
          }}>
          <span style={{ marginTop: -2, lineHeight: 1 }}>⟳</span>
        </div>
      </div>
      {settingsOpen && (
        <SettingsPanel
          deselectOnApply={deselectOnApply} setDeselectOnApply={setDeselectOnApply}
          overwriteOnApply={overwriteOnApply} setOverwriteOnApply={setOverwriteOnApply}
          remember={remember} setRemember={setRemember}
          onResetAll={onResetAll}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}
