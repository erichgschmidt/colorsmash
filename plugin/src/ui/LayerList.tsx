// Dense scrolling layer picker. One row = checkbox + name + type tag. Single-select
// (checking a row clears the previous one) so it slots in wherever a <select> used to live.
//
// Why a fixed-height scroll box instead of a dropdown: with 30+ layers in a doc the native
// UXP <select> popup scrolls weirdly and hides everything beneath it; this stays inline so
// the user can scan many layers at a glance. Row height is intentionally ~18px — we'd
// rather fit ~7 rows in the default 130px viewport than make each row "comfortable".

import { useEffect, useRef } from "react";

export interface LayerListItem {
  id: number;
  name: string;
  kind?: string;
}

export interface LayerListProps {
  items: LayerListItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  // Extra synthetic rows appended at the bottom — used for the "Merged" pseudo-layer.
  extras?: LayerListItem[];
  height?: number;
  emptyLabel?: string;
}

// Best-effort tag from PS layer.kind. Anything we don't recognize falls through unchanged so
// new PS kinds still render a useful tag instead of being silently dropped.
function typeTag(kind?: string): string {
  if (!kind) return "";
  const k = String(kind);
  if (k === "smartObject") return "smart";
  if (k === "adjustment") return "adj";
  return k;
}

export function LayerList(props: LayerListProps) {
  const { items, selectedId, onSelect, extras = [], height = 130, emptyLabel = "no layers" } = props;
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the selected row into view when it changes from outside (e.g. doc switch
  // auto-picks the topmost layer). Without this the chosen row can sit off-screen.
  useEffect(() => {
    if (selectedId == null) return;
    const el = listRef.current?.querySelector<HTMLDivElement>(`[data-layer-id="${selectedId}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const all = [...items, ...extras];

  return (
    <div ref={listRef} style={{
      height, overflowY: "auto", background: "#1f1f1f", border: "1px solid #555",
      borderRadius: 2, fontSize: 10, color: "#ddd",
    }}>
      {all.length === 0 && (
        <div style={{ padding: "6px 8px", color: "#666", fontSize: 10 }}>{emptyLabel}</div>
      )}
      {all.map(l => {
        const checked = selectedId === l.id;
        return (
          <div key={l.id} data-layer-id={l.id}
            onClick={() => onSelect(l.id)}
            // Hover styling done via inline handlers — no CSS files in this codebase, and a
            // single :hover would require a stylesheet. Cheap enough at <50 rows.
            onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLDivElement).style.background = "#2a2a2a"; }}
            onMouseLeave={e => { if (!checked) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            style={{
              display: "flex", alignItems: "center", gap: 4, height: 18, padding: "0 4px 0 0",
              cursor: "pointer", userSelect: "none",
              // 4px accent stripe on the left for the checked row — same idea as PS's own
              // selected-layer highlight, easier to spot than a full row tint.
              borderLeft: `4px solid ${checked ? "#c19a3a" : "transparent"}`,
              background: checked ? "#2f2a1c" : "transparent",
            }}>
            <input type="checkbox" checked={checked} readOnly
              // readOnly + onClick on the row handles both checkbox and label clicks; stops
              // the inner click from firing twice via row delegation.
              onClick={e => { e.stopPropagation(); onSelect(l.id); }}
              style={{ margin: "0 2px 0 4px", cursor: "pointer", flexShrink: 0 }} />
            <span style={{
              flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }} title={l.name}>{l.name}</span>
            {l.kind !== undefined && (
              <span style={{ opacity: 0.6, fontSize: 9, color: "#888", flexShrink: 0, marginLeft: 4 }}>
                {typeTag(l.kind)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
