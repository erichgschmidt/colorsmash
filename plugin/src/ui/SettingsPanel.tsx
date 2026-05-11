// Settings panel — a popover that houses rarely-touched preference toggles
// so the main panel stays focused on the active editing flow. Opened by a
// gear icon in the BottomActionBar (v1.18.3).
//
// What's in here vs what stays in the main UI:
//   - In here: Deselect (one-time pref), Replace (one-time pref), Save
//     (persistence — set once, ignored after). Future: anything else
//     that's "set once and forget."
//   - NOT here: action pills (LIVE / RESTORE / AUTO / SWAP / MASK / Save LUT),
//     output mode toggle, marquee tristate, multi-zone toggles, LUT options.
//     Those are touched repeatedly during editing and belong inline.
//
// The panel is a click-outside-to-close overlay. Avoids deep modal dialogs
// (heavier UX commitment) and keeps the user a single click from anywhere.

import { uxpConfirm } from "./uxpConfirm";

export interface SettingsPanelProps {
  deselectOnApply: boolean;
  setDeselectOnApply: (b: boolean) => void;
  overwriteOnApply: boolean;
  setOverwriteOnApply: (b: boolean) => void;
  remember: boolean;
  setRemember: (b: boolean) => void;
  onResetAll: () => void;
  onClose: () => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { deselectOnApply, setDeselectOnApply, overwriteOnApply, setOverwriteOnApply,
          remember, setRemember, onResetAll, onClose } = props;

  const handleResetClick = async () => {
    const ok = await uxpConfirm("Reset all panel settings to defaults and clear the saved file?", "Reset");
    if (ok) {
      onResetAll();
      onClose();
    }
  };

  // Pill style mirrors the segmented controls elsewhere (RGB/Lab/LUT,
  // Off/Focus/Exclude, Multi/Blend If/Adaptive). Single-toggle on/off
  // variant — filled when active, outlined when not.
  const pillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, height: 22, padding: "0 8px",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
    background: active ? "#3a3a3a" : "transparent",
    color: active ? "#dddddd" : "#888",
    border: `1px solid ${active ? "#888" : "#444"}`,
    borderRadius: 2, cursor: "pointer", userSelect: "none",
    lineHeight: "20px", boxSizing: "border-box",
  });

  // Backdrop click closes the panel; clicks INSIDE the panel body don't bubble.
  return (
    <div onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: "#2a2a2a", border: "1px solid #555", borderRadius: 4,
          padding: 12, minWidth: 240, maxWidth: 320,
          display: "flex", flexDirection: "column", gap: 10,
          fontSize: 11, color: "#cccccc",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#dddddd" }}>Settings</span>
          <div onClick={onClose}
            title="Close settings"
            style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center",
                     fontSize: 12, lineHeight: 1, cursor: "pointer", userSelect: "none",
                     color: "#888", border: "1px solid #444", borderRadius: 2 }}>×</div>
        </div>

        {/* Apply behavior section */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 9, opacity: 0.5, letterSpacing: 0.4 }}>APPLY BEHAVIOR</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div onClick={() => setDeselectOnApply(!deselectOnApply)}
              style={pillStyle(deselectOnApply)}
              title="Deselect — drop the active marquee before creating the layer so the new Curves / LUT layer applies to the full target. Independent of the marquee Focus/Exclude tristate.">
              DESELECT
            </div>
            <div onClick={() => setOverwriteOnApply(!overwriteOnApply)}
              style={pillStyle(overwriteOnApply)}
              title="Replace — on: overwrite the prior Match Curves/LUT layer in [Color Smash] on Apply. Off: keep prior layers (hidden) so you can stack alternatives.">
              REPLACE
            </div>
          </div>
        </div>

        {/* Panel state section */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 9, opacity: 0.5, letterSpacing: 0.4 }}>PANEL STATE</span>
          <div style={{ display: "flex", gap: 4 }}>
            <div onClick={() => setRemember(!remember)}
              style={pillStyle(remember)}
              title="Save — persist all panel settings across reloads (sliders, zones, envelope, toggles, output mode, LUT options).">
              SAVE
            </div>
            <div onClick={handleResetClick}
              style={{
                flex: 1, height: 22, padding: "0 8px",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                background: "transparent", color: "#d87a7a",
                border: "1px solid #d87a7a", borderRadius: 2,
                cursor: "pointer", userSelect: "none",
                lineHeight: "20px", boxSizing: "border-box",
              }}
              title="Reset all settings to defaults and clear the saved file. Confirmation dialog before proceeding.">
              RESET
            </div>
          </div>
        </div>

        <span style={{ fontSize: 9, opacity: 0.4, marginTop: 4 }}>
          More options coming as the panel grows.
        </span>
      </div>
    </div>
  );
}
