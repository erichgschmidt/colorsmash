import { MatchTab } from "./MatchTab";

export function Panel() {
  return (
    <div style={{
      fontFamily: "Adobe Clean, sans-serif", fontSize: 11, color: "#cccccc", background: "#323232",
      height: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column",
    }}>
      <div style={{ flex: 1, overflow: "auto" }}>
        <MatchTab />
      </div>
    </div>
  );
}
