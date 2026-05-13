// Pro mode toggle that lives below the matched preview in MatchTab.
// Two pills (Color Match / Smash) plus a small PRO badge. Click-dispatch
// uses <div onClick> per the UXP convention. Rendered only when
// __SMASH_ENABLED__ is true at build time, so the free build never sees it.

export type SmashMode = "match" | "smash";

export interface ModeToggleProps {
  mode: SmashMode;
  onModeChange: (next: SmashMode) => void;
}

export function ModeToggle(props: ModeToggleProps) {
  const { mode, onModeChange } = props;
  return (
    <div style={containerStyle}>
      <ModePill
        label="Color Match"
        active={mode === "match"}
        onClick={() => onModeChange("match")}
      />
      <ModePill
        label="Smash"
        active={mode === "smash"}
        onClick={() => onModeChange("smash")}
      />
      <div style={proBadgeStyle}>PRO</div>
      <div style={{ flex: 1 }} />
    </div>
  );
}

function ModePill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? "#3a3a3a" : "transparent",
        color: active ? "#ffffff" : "#aaaaaa",
        padding: "4px 12px",
        fontSize: 10,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        borderBottom: active ? "2px solid #6ab7ff" : "2px solid transparent",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginTop: 6,
  padding: "2px 0",
};

const proBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "#6ab7ff",
  letterSpacing: 1,
  marginLeft: 4,
  userSelect: "none",
};
