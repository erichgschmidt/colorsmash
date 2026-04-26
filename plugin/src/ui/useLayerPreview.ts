// Snapshot a chosen layer at low resolution. Variant of useTargetPreview that takes an explicit
// layerId instead of always using the active layer. Returns null until a layer is selected.

import { useCallback, useEffect, useRef, useState } from "react";
import { app, action, readLayerPixels, executeAsModal } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import { MERGED_LAYER_ID } from "../core/histogramMatch";

const PREVIEW_MAX_EDGE = 640;

// Recursively search the layer tree for a layer with the given id. doc.layers only contains
// top-level items, so layers nested in groups (or auto-grouped by other plugins) need this.
function findLayerById(layers: any[], id: number): any | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (Array.isArray(l.layers)) {
      const found = findLayerById(l.layers, id);
      if (found) return found;
    }
  }
  return null;
}

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
        const layer = findLayerById(doc.layers, layerId);
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

  // Track which doc the last successful snap came from. If app.activeDocument.id changes
  // (PS doc switch — events for this aren't reliable, especially in-PS switches), force a
  // refresh on the next poll tick. Same defense applies to LayerSquish-style batch operations
  // that PS coalesces into a single notification we may never see.
  const lastDocIdRef = useRef<number | null>(null);

  useEffect(() => {
    refresh();
    lastDocIdRef.current = app.activeDocument?.id ?? null;
    const events = ["select", "make", "delete", "set", "open", "close", "rename"];
    const handler = () => {
      lastDocIdRef.current = app.activeDocument?.id ?? null;
      refresh();
    };
    action.addNotificationListener(events, handler);
    // 1.5s safety poll: catches doc switches and silent batch ops.
    const pollTimer = setInterval(() => {
      const currentId = app.activeDocument?.id ?? null;
      if (currentId !== lastDocIdRef.current) {
        lastDocIdRef.current = currentId;
        refresh();
      }
    }, 1500);
    return () => {
      clearInterval(pollTimer);
      action.removeNotificationListener?.(events, handler);
    };
  }, [refresh]);

  return { snap, refresh, error };
}
