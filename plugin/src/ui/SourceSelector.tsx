// Source-column controls for MatchTab:
//   - Document/source dropdown (active doc list + "Use Selection" + "Browse Image…")
//   - Mode-specific selector (dense layer list / selection toggles / browsed-file label)
//   - Thumbnail preview rendered to the RIGHT of the list (caller passes it as a prop)
//
// The thumbnail is a slot rather than a baked-in render so the parent stays in control of
// snapshot sourcing (srcOverride vs live snap) without us re-piping every prop.

import { ReactNode } from "react";
import { MERGED_LAYER_ID } from "../core/histogramMatch";
import { LayerList } from "./LayerList";

type SrcMode = "layer" | "selection" | "folder";

export interface SourceSelectorProps {
  // Doc dropdown
  docs: { id: number; name: string }[];
  activeDocId: number | null;
  srcMode: SrcMode;
  browsedFile: string;
  onSwitchDoc: (id: number) => void;
  onSwitchSrcMode: (m: SrcMode) => void;
  setBrowsedFile: (s: string) => void;
  onBrowseImage: () => void;

  // Layer list (layer mode)
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

  // Optional thumbnail painted to the right of the list. Caller owns the snapshot logic.
  thumbnail?: ReactNode;
}

export function SourceSelector(props: SourceSelectorProps) {
  const {
    docs, activeDocId, srcMode, browsedFile, onSwitchDoc, onSwitchSrcMode, setBrowsedFile, onBrowseImage,
    layers, sourceId, setSourceId,
    autoUpdate, setAutoUpdate, sampleMerged, setSampleMerged, sampleLock, setSampleLock,
    selStyle, thumbnail,
  } = props;

  // The center widget changes per mode. Only "layer" mode gets the dense list; the other
  // two are unchanged from the old design (selection toggles, sticky file label).
  const center = srcMode === "layer" ? (
    <LayerList
      items={layers}
      selectedId={sourceId}
      onSelect={setSourceId}
      // "Merged" pseudo-layer pinned at the bottom — same affordance as the old <option>.
      extras={[{ id: MERGED_LAYER_ID, name: "Merged", kind: "composite" }]}
    />
  ) : srcMode === "folder" ? (
    <div style={{ height: 130, display: "flex", alignItems: "center", justifyContent: "center",
      background: "#1f1f1f", border: "1px solid #555", borderRadius: 2, fontSize: 10, opacity: 0.7, padding: "0 8px", textAlign: "center" }}>
      {browsedFile ? `📁 ${browsedFile}` : "no file"}
    </div>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, height: 26 }}>
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
      <div style={{ height: 26, display: "flex", alignItems: "center", gap: 4 }}>
        <select style={{ ...selStyle, flex: 1 }}
          title="Source — an open document, the active selection (with auto/merge/lock toggles), or an image file from disk."
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
        {props.onRefreshLayers && (
          <div onClick={props.onRefreshLayers} title="Refresh document + layer list (use if a doc was just opened/closed or another plugin renamed layers)"
            style={{ width: 22, height: 22, marginTop: -1, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #888", borderRadius: 2, color: "#ddd", fontSize: 16, userSelect: "none", boxSizing: "border-box", flexShrink: 0 }}>
            <span style={{ marginTop: -3, marginLeft: 1, lineHeight: 1 }}>⟳</span>
          </div>
        )}
      </div>
      {/* List on the left grows; fixed-width thumbnail on the right. minWidth:0 on the
          left flex child is required so the truncating layer names actually truncate. */}
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <div style={{ flex: 1, minWidth: 0 }}>{center}</div>
        {thumbnail && (
          <div style={{ width: 72, flexShrink: 0, display: "flex", alignItems: "flex-start" }}>
            {thumbnail}
          </div>
        )}
      </div>
    </>
  );
}
