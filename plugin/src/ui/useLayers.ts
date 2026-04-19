// Tracks the active document's pixel layers and refreshes on PS notifications.

import { useEffect, useState } from "react";
import { app, action } from "../services/photoshop";

export interface LayerInfo { id: number; name: string; }

function readLayers(): LayerInfo[] {
  const doc = app.activeDocument;
  if (!doc) return [];
  return doc.layers
    .filter((l: any) => l.kind === "pixel" || l.kind === undefined)
    .map((l: any) => ({ id: l.id, name: l.name }));
}

export function useLayers(): LayerInfo[] {
  const [layers, setLayers] = useState<LayerInfo[]>(() => readLayers());

  useEffect(() => {
    const refresh = () => setLayers(readLayers());
    const events = ["select", "make", "delete", "set", "open", "close", "move"];
    action.addNotificationListener(events, refresh);
    return () => action.removeNotificationListener?.(events, refresh);
  }, []);

  return layers;
}
