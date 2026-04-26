// Source-column controls for MatchTab:
//   - Document/source dropdown (active doc list + "Use Selection" + "Browse Image…")
//   - Mode-specific selector (layer dropdown / selection toggles / browsed-file label)

import { MERGED_LAYER_ID } from "../core/histogramMatch";

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

  // Layer dropdown (layer mode)
  layers: { id: number; name: string }[];
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
}

export function SourceSelector(props: SourceSelectorProps) {
  const {
    docs, activeDocId, srcMode, browsedFile, onSwitchDoc, onSwitchSrcMode, setBrowsedFile, onBrowseImage,
    layers, sourceId, setSourceId,
    autoUpdate, setAutoUpdate, sampleMerged, setSampleMerged, sampleLock, setSampleLock,
    selStyle,
  } = props;

  const sourceModeContent = srcMode === "layer" ? (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <select style={{ ...selStyle, flex: 1 }} value={sourceId ?? ""} onChange={e => setSourceId(Number(e.target.value))}>
        {layers.length === 0 && <option value="">— none —</option>}
        {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        <option value={MERGED_LAYER_ID}>🔀 Merged</option>
      </select>
      {props.onRefreshLayers && (
        <div onClick={props.onRefreshLayers} title="Force-refresh layer list (use if names look stale after another plugin renamed/regrouped)"
          style={{ width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #888", borderRadius: 2, color: "#ddd", fontSize: 12, userSelect: "none", boxSizing: "border-box", flexShrink: 0 }}>
          <span style={{ marginTop: -1, lineHeight: 1 }}>⟳</span>
        </div>
      )}
    </div>
  ) : srcMode === "folder" ? (
    <span style={{ fontSize: 10, opacity: 0.7 }}>{browsedFile ? `📁 ${browsedFile}` : ""}</span>
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
      <div style={{ height: 26 }}>
        <select style={selStyle}
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
      </div>
      <div style={{ height: 26 }}>{sourceModeContent}</div>
    </>
  );
}
