// Target-column controls for MatchTab. Mirrors SourceSelector's layout (doc dropdown +
// dense layer list + thumbnail-right) so the two columns visually rhyme. Extracted from
// inline JSX in MatchTab purely to keep that file from sprawling further.

import { ReactNode } from "react";
import { MERGED_LAYER_ID } from "../core/histogramMatch";
import { LayerList } from "./LayerList";

export interface TargetSelectorProps {
  docs: { id: number; name: string }[];
  activeDocId: number | null;
  onSwitchDoc: (id: number) => void;

  layers: { id: number; name: string; kind?: string }[];
  targetId: number | null;
  setTargetId: (id: number) => void;

  selStyle: React.CSSProperties;
  onRefreshLayers?: () => void;

  thumbnail?: ReactNode;
}

export function TargetSelector(props: TargetSelectorProps) {
  const { docs, activeDocId, onSwitchDoc, layers, targetId, setTargetId, selStyle, thumbnail } = props;

  return (
    <>
      <div style={{ height: 26, display: "flex", alignItems: "center", gap: 4 }}>
        <select style={{ ...selStyle, flex: 1 }} value={activeDocId ?? ""} onChange={e => onSwitchDoc(Number(e.target.value))}
          title="Target document — where the new Curves layer will land. Independent of the source doc; can differ from PS's currently active doc.">
          {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {props.onRefreshLayers && (
          <div onClick={props.onRefreshLayers} title="Refresh document + target layer list"
            style={{ width: 22, height: 22, marginTop: -1, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #888", borderRadius: 2, color: "#ddd", fontSize: 16, userSelect: "none", boxSizing: "border-box", flexShrink: 0 }}>
            <span style={{ marginTop: -3, marginLeft: 1, lineHeight: 1 }}>⟳</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <LayerList
            items={layers}
            selectedId={targetId}
            onSelect={setTargetId}
            extras={[{ id: MERGED_LAYER_ID, name: "Merged", kind: "composite" }]}
          />
        </div>
        {thumbnail && (
          <div style={{ width: 72, flexShrink: 0, display: "flex", alignItems: "flex-start" }}>
            {thumbnail}
          </div>
        )}
      </div>
    </>
  );
}
