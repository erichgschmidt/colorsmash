import { MatchTab } from "./MatchTab";
import { ProShell } from "./smash/ProShell";

export function Panel() {
  return (
    <div style={{
      fontFamily: "Adobe Clean, sans-serif", fontSize: 11, color: "#cccccc", background: "#535353",
      height: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column",
    }}>
      {__SMASH_ENABLED__ ? (
        <ProShell />
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <MatchTab />
        </div>
      )}
    </div>
  );
}
