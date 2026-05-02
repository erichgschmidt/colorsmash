// Source-column controls for MatchTab:
//   Row 1 (always): [source/doc dropdown] [layer dropdown OR mode widget] [refresh]
//   Row 2 (always): thumbnail full-width below, fixed height
//
// The horizontal-dropdown layout mirrors the target picker above the preview, so source
// and target read as a matched pair. The dense layer-list approach was tried and dropped
// — too much vertical space for a one-of-many pick that a select handles fine.

import { ReactNode } from "react";
import { MERGED_LAYER_ID } from "../core/histogramMatch";

type SrcMode = "layer" | "selection" | "folder";

export interface SourceSelectorProps {
  // Doc / source dropdown
  docs: { id: number; name: string }[];
  activeDocId: number | null;
  srcMode: SrcMode;
  browsedFile: string;
  onSwitchDoc: (id: number) => void;
  onSwitchSrcMode: (m: SrcMode) => void;
  setBrowsedFile: (s: string) => void;
  onBrowseImage: () => void;

  // Layer pick (layer mode)
  layers: { id: number; name: string; kind?: string }[];
  sourceId: number | null;
  setSourceId: (id: number) => void;

  // Selection mode toggles
  autoUpdate: boolean;
  setAutoUpdate: (b: boolean) => void;
  sampleMerged: boolean;
  setSampleMerged: (b: boolean) => void;
  sampleLock: boolean;
  setSampleLock: (b: boolean) => void;

  selStyle: React.CSSProperties;
  onRefreshLayers?: () => void;

  // Optional thumbnail painted below the dropdown row. Caller owns the snapshot logic.
  thumbnail?: ReactNode;
}

export function SourceSelector(props: SourceSelectorProps) {
  const {
    docs, activeDocId, srcMode, browsedFile, onSwitchDoc, onSwitchSrcMode, setBrowsedFile, onBrowseImage,
    layers, sourceId, setSourceId,
    autoUpdate, setAutoUpdate, sampleMerged, setSampleMerged, sampleLock, setSampleLock,
    selStyle, thumbnail,
  } = props;

  // Right-of-doc widget changes per mode. Layer mode → layer dropdown. Selection mode →
  // the auto/merge/lock toggle cluster. Browsed-file mode → sticky filename label.
  const rightWidget = srcMode === "layer" ? (
    <select style={{ ...selStyle, flex: 1, minWidth: 0 }} value={sourceId ?? ""} onChange={e => setSourceId(Number(e.target.value))}
      title="Source layer — pixels are read from this layer in the source document.">
      {layers.length === 0 && <option value="">— none —</option>}
      {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      <option value={MERGED_LAYER_ID}>Merged</option>
    </select>
  ) : srcMode === "folder" ? (
    <div style={{ flex: 1, minWidth: 0, height: 22, display: "flex", alignItems: "center", padding: "0 6px",
      background: "#1f1f1f", border: "1px solid #555", borderRadius: 2, fontSize: 10, opacity: 0.85,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      title={browsedFile || "no file"}>
      {browsedFile ? `📁 ${browsedFile}` : "no file"}
    </div>
  ) : (
    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 10, height: 22 }}>
      <input type="checkbox" checked={autoUpdate} onChange={e => setAutoUpdate(e.target.checked)}
        title={autoUpdate ? "Auto-sample on (selection changes re-sample)" : "Auto-sample on selection change"}
        style={{ cursor: "pointer", flexShrink: 0, margin: 0 }} />
      <span style={{ color: autoUpdate ? "#7d7" : "#555", flexShrink: 0 }}>●</span>
      <input type="checkbox" checked={sampleMerged} onChange={e => setSampleMerged(e.target.checked)}
        title="Sample merged composite (everything visible at the selection) instead of just the active layer"
        style={{ cursor: "pointer", flexShrink: 0, marginLeft: 4, margin: 0 }} />
      <span style={{ opacity: 0.8 }}>Merge</span>
      <input type="checkbox" checked={sampleLock} onChange={e => setSampleLock(e.target.checked)}
        title="Lock current sample — auto-update is disabled while on. Use to freeze a sample while you experiment."
        style={{ cursor: "pointer", flexShrink: 0, marginLeft: 4, margin: 0 }} />
      <span style={{ opacity: 0.8 }}>Lock</span>
    </div>
  );

  return (
    <>
      {/* Single horizontal row: source/doc, then mode-specific widget, then refresh.
          Same pattern as the target row above the preview so the two read as a pair. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <select style={{ ...selStyle, flex: 1, minWidth: 0 }}
          title="Source — an open document (pick a layer at right), the active selection, or an image file from disk."
          value={
            srcMode === "folder" ? "__file__" :
            srcMode === "selection" ? "__selection__" : (activeDocId ?? "")
          }
          onChange={e => {
            const v = e.target.value;
            if (v === "__selection__") { setBrowsedFile(""); onSwitchSrcMode("selection"); }
            else if (v === "__browse__") { onBrowseImage(); }
            else if (v === "__file__") { /* sticky display, ignore */ }
            else { setBrowsedFile(""); onSwitchSrcMode("layer"); onSwitchDoc(Number(v)); }
          }}>
          {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="__selection__">⊞ Use Selection</option>
          <option value="__browse__">📁 Browse Image…</option>
          {browsedFile && <option value="__file__">📁 {browsedFile}</option>}
        </select>
        {rightWidget}
        {props.onRefreshLayers && (
          <div onClick={props.onRefreshLayers} title="Refresh document + layer list (use if a doc was just opened/closed or another plugin renamed layers)"
            style={{ width: 22, height: 22, marginTop: 2, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #888", borderRadius: 2, color: "#ddd", fontSize: 16, userSelect: "none", boxSizing: "border-box", flexShrink: 0 }}>
            <span style={{ marginTop: -3, marginLeft: 1, lineHeight: 1 }}>⟳</span>
          </div>
        )}
      </div>
      {/* Thumbnail row — full width below the dropdowns. Caller controls aspect/height
          via the slot's PreviewPane props. */}
      {thumbnail && (
        <div style={{ marginTop: 4 }}>{thumbnail}</div>
      )}
    </>
  );
}
