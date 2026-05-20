// Collapsible section — the header chip toggles its body open/closed.
//
// Extracted from SmashTab.tsx so both SmashTab and AnalysisTab can share the
// same compact-panel layout. Behavior + styling are unchanged from the
// original local definition.

import { useState } from "react";

export function Section({ title, children, defaultOpen = true }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          ...SECTION_HEADER, cursor: "pointer", userSelect: "none",
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        <span style={{ fontSize: 8 }}>{open ? "▾" : "▸"}</span>
        {title}
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: "#cccccc",
  padding: "3px 6px", background: "#2c2c2c",
  border: "1px solid #444", borderRadius: 3,
};
