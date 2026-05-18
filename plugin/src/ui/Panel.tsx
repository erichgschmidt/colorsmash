import { useState } from "react";
import { MatchTab } from "./MatchTab";
import { AnalysisTab } from "./AnalysisTab";

type Tab = "match" | "analysis";

// Tab button styling — active tab gets the PS-blue accent + lifted background
// so it reads as the foreground tab against the #535353 panel.
function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
    background: active ? "#1473e6" : "#3a3a3a",
    color: active ? "#ffffff" : "#aaaaaa",
    border: `1px solid ${active ? "#1473e6" : "#4a4a4a"}`,
    borderRadius: 2, cursor: "pointer", userSelect: "none",
    fontFamily: "inherit",
  };
}

export function Panel() {
  const [tab, setTab] = useState<Tab>("match");

  return (
    <div style={{
      fontFamily: "Adobe Clean, sans-serif", fontSize: 11, color: "#cccccc", background: "#535353",
      height: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column",
    }}>
      {/* Tab switcher */}
      <div style={{ display: "flex", gap: 4, padding: "6px 6px 0" }}>
        <div style={tabBtnStyle(tab === "match")} onClick={() => setTab("match")}>Match</div>
        <div style={tabBtnStyle(tab === "analysis")} onClick={() => setTab("analysis")}>Analysis</div>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "match" ? <MatchTab /> : <AnalysisTab />}
      </div>
    </div>
  );
}
