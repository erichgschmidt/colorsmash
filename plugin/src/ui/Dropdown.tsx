// Custom (non-native) dropdown for short option lists.
//
// UXP's native <select> popovers can interfere with each other when multiple
// selects live in the same panel — the open list of one shows up associated
// with another, or selected values bleed. This component is a pure-React
// replacement built from divs, so there's no host-level popover involved.
// Use it for additional dropdowns in the panel; leave SourceSelector's
// existing native selects alone (one alone behaves fine).

import { useEffect, useRef, useState } from "react";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

export function Dropdown<T extends string>(props: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  title?: string;
  // Outer wrapper style — control width / margins by passing this.
  style?: React.CSSProperties;
}): JSX.Element {
  const { value, options, onChange, title, style } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Listener only attached while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = options.find(o => o.value === value);

  return (
    <div ref={wrapRef} style={{ position: "relative", ...style }}>
      <div
        onClick={() => setOpen(o => !o)}
        title={title}
        style={{
          padding: "2px 6px", fontSize: 10, borderRadius: 2,
          border: "1px solid #4a4a4a", background: "#2a2a2a",
          color: "#cccccc", cursor: "pointer", userSelect: "none",
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {current?.label ?? value}
        </span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100,
          marginTop: 2,
          background: "#2a2a2a", border: "1px solid #4a4a4a", borderRadius: 2,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          maxHeight: 240, overflowY: "auto",
        }}>
          {options.map(opt => {
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  padding: "4px 8px", fontSize: 10,
                  background: selected ? "#1473e6" : "transparent",
                  color: selected ? "#ffffff" : "#cccccc",
                  cursor: "pointer", userSelect: "none",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={e => {
                  if (!selected) (e.currentTarget as HTMLDivElement).style.background = "#3a3a3a";
                }}
                onMouseLeave={e => {
                  if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
              >
                {opt.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
