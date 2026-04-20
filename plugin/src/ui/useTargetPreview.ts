// Loads + caches a downsampled snapshot of the active layer for fast in-panel preview.
// Re-fetches when the active layer changes.

import { useEffect, useState } from "react";
import { app, action } from "../services/photoshop";
import { readLayerPixels, executeAsModal, getActiveDoc } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const PREVIEW_MAX_EDGE = 192;

export interface PreviewSnapshot {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, downsampled
}

export function useTargetPreview(): PreviewSnapshot | null {
  const [snap, setSnap] = useState<PreviewSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const doc = app.activeDocument;
        if (!doc) { if (alive) setSnap(null); return; }
        const layer = doc.activeLayers?.[0] ?? doc.layers?.[0];
        if (!layer) { if (alive) setSnap(null); return; }
        const buf = await executeAsModal("Color Smash preview snapshot", async () => {
          return await readLayerPixels(getActiveDoc().layers.find((l: any) => l.id === layer.id));
        });
        const small = downsampleToMaxEdge(buf, PREVIEW_MAX_EDGE);
        if (alive) setSnap({ width: small.width, height: small.height, data: small.data });
      } catch {
        if (alive) setSnap(null);
      }
    };
    refresh();
    const events = ["select", "make", "delete", "set", "open", "close"];
    action.addNotificationListener(events, refresh);
    return () => { alive = false; action.removeNotificationListener?.(events, refresh); };
  }, []);

  return snap;
}
