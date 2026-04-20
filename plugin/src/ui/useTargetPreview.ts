// Loads + caches a downsampled snapshot of the active layer for fast in-panel preview.

import { useCallback, useEffect, useState } from "react";
import { app, action, readLayerPixels, executeAsModal } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const PREVIEW_MAX_EDGE = 384;

export interface PreviewSnapshot {
  width: number;
  height: number;
  data: Uint8Array;
  layerName: string;
  layerId: number;
}

export function useTargetPreview(): { snap: PreviewSnapshot | null; refresh: () => void; error: string | null } {
  const [snap, setSnap] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const doc = app.activeDocument;
      if (!doc) { setSnap(null); setError("No active document"); return; }

      const layerInfo = await executeAsModal("Color Smash preview", async () => {
        const d = app.activeDocument;
        if (!d) throw new Error("No doc");
        const layer = d.activeLayers?.[0] ?? d.layers?.[0];
        if (!layer) throw new Error("No layers");
        const buf = await readLayerPixels(layer);
        const small = downsampleToMaxEdge(buf, PREVIEW_MAX_EDGE);
        return {
          width: small.width, height: small.height, data: small.data,
          layerName: layer.name, layerId: layer.id,
        };
      });
      setSnap(layerInfo);
      setError(null);
    } catch (e: any) {
      setSnap(null);
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const events = ["select", "make", "delete", "set", "open", "close"];
    const handler = () => refresh();
    action.addNotificationListener(events, handler);
    return () => { action.removeNotificationListener?.(events, handler); };
  }, [refresh]);

  return { snap, refresh, error };
}
