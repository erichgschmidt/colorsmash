// Snapshot a chosen layer at low resolution. Variant of useTargetPreview that takes an explicit
// layerId instead of always using the active layer. Returns null until a layer is selected.

import { useCallback, useEffect, useState } from "react";
import { app, action, readLayerPixels, executeAsModal } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

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
