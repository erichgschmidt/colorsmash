// Pro shell — tab strip wrapping Match and Smash. Rendered only when
// `__SMASH_ENABLED__` is true. In the free build this whole component is
// dead-code-eliminated.

import { useState } from "react";
import { MatchTab } from "../MatchTab";
import { SmashTab } from "./SmashTab";

type Mode = "match" | "smash";

export function ProShell() {
  const [mode, setMode] = useState<Mode>("match");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={tabStripStyle}>
        <TabButton label="Match" active={mode === "match"} onClick={() => setMode("match")} />
        <TabButton label="Smash" active={mode === "smash"} onClick={() => setMode("smash")} />
        <div style={{ flex: 1 }} />
        <div style={proBadgeStyle}>PRO</div>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {mode === "match" ? <MatchTab /> : <SmashTab />}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? "#3a3a3a" : "transparent",
        color: active ? "#ffffff" : "#aaaaaa",
        padding: "6px 14px",
        fontFamily: "inherit",
        fontSize: 11,
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

const tabStripStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "#404040",
  borderBottom: "1px solid #2a2a2a",
  height: 28,
  flexShrink: 0,
};

const proBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "#6ab7ff",
  letterSpacing: 1,
  marginRight: 10,
};
