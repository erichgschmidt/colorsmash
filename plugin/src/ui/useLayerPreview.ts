// Snapshot a chosen layer at low resolution. Variant of useTargetPreview that takes an explicit
// layerId instead of always using the active layer. Returns null until a layer is selected.

import { useCallback, useEffect, useState } from "react";
import { app, action, readLayerPixels, executeAsModal } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import { MERGED_LAYER_ID } from "../core/histogramMatch";

const PREVIEW_MAX_EDGE = 640;

export interface LayerSnapshot {
  width: number;
  height: number;
  data: Uint8Array;
  layerName: string;
  layerId: number;
}

export function useLayerPreview(layerId: number | null): { snap: LayerSnapshot | null; refresh: () => void; error: string | null } {
  const [snap, setSnap] = useState<LayerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (layerId == null) { setSnap(null); setError(null); return; }
    try {
      const result = await executeAsModal("Color Smash layer snapshot", async () => {
        const doc = app.activeDocument;
        if (!doc) throw new Error("No doc");
        // MERGED_LAYER_ID sentinel: read the full document composite (no layerID).
        if (layerId === MERGED_LAYER_ID) {
          const { imaging } = require("photoshop");
          const r = await imaging.getPixels({ documentID: doc.id, componentSize: 8, applyAlpha: false, colorSpace: "RGB" });
          const id = r.imageData;
          const raw = await id.getData();
          const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const w = id.width, h = id.height;
          const components = id.components ?? (src.length / (w * h));
          const data = new Uint8Array(w * h * 4);
          if (components === 4) data.set(src);
          else for (let i = 0, j = 0; i < w * h; i++, j += 3) { const o = i * 4; data[o] = src[j]; data[o + 1] = src[j + 1]; data[o + 2] = src[j + 2]; data[o + 3] = 255; }
          if (id.dispose) id.dispose();
          const small = downsampleToMaxEdge({ width: w, height: h, data, bounds: { left: 0, top: 0, right: w, bottom: h } }, PREVIEW_MAX_EDGE);
          return { width: small.width, height: small.height, data: small.data, layerName: "Merged", layerId };
        }
        const layer = doc.layers.find((l: any) => l.id === layerId);
        if (!layer) throw new Error(`Layer ${layerId} not found`);
        const buf = await readLayerPixels(layer);
        const small = downsampleToMaxEdge(buf, PREVIEW_MAX_EDGE);
        return { width: small.width, height: small.height, data: small.data, layerName: layer.name, layerId };
      });
      setSnap(result);
      setError(null);
    } catch (e: any) {
      setSnap(null);
      setError(e?.message ?? String(e));
    }
  }, [layerId]);

  useEffect(() => {
    refresh();
    const events = ["select", "make", "delete", "set"];
    const handler = () => refresh();
    action.addNotificationListener(events, handler);
    return () => { action.removeNotificationListener?.(events, handler); };
  }, [refresh]);

  return { snap, refresh, error };
}
