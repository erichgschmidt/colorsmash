import { useState } from "react";
import { TransferTab } from "./TransferTab";
import { ZonesTab } from "./ZonesTab";

type Tab = "transfer" | "zones";

export function Panel() {
  const [tab, setTab] = useState<Tab>("transfer");

  const tabBtn = (id: Tab): React.CSSProperties => ({
    flex: 1, padding: "6px 8px", fontSize: 11, cursor: "pointer",
    background: tab === id ? "#1473e6" : "transparent",
    color: tab === id ? "white" : "#aaa",
    border: "1px solid #444",
    borderBottom: tab === id ? "1px solid #1473e6" : "1px solid #444",
  });

  return (
    <div style={{
      fontFamily: "sans-serif", fontSize: 11, color: "#ddd", background: "#222",
      height: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex" }}>
        <button style={tabBtn("transfer")} onClick={() => setTab("transfer")}>Transfer</button>
        <button style={tabBtn("zones")}    onClick={() => setTab("zones")}>Zones</button>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "transfer" ? <TransferTab /> : <ZonesTab />}
      </div>
    </div>
  );
}
