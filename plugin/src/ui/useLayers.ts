// Tracks the active document's pixel layers and refreshes on PS notifications.
//
// Important: PS fires `make`/`delete`/etc. notifications *during* the modal scope, before
// doc.layers is updated. Reading synchronously in the handler returns stale state — the
// new layer wouldn't show up until the *next* notification arrived. We defer the read to
// the next tick (and again ~120ms later as a backup) so by the time we read, the document
// tree reflects the change. Also dedupe so React doesn't re-render on no-op refreshes.

import { useEffect, useState } from "react";
import { app, action } from "../services/photoshop";

export interface LayerInfo { id: number; name: string; }

// Recursively flatten the layer tree. doc.layers only contains top-level items, so any layer
// moved into a group (e.g. by another plugin like LayerSquish auto-grouping) would otherwise
// vanish from our flat list. Skips our own [Color Smash] group so Match Curves adjustment
// layers don't pollute the source/target picker.
function flattenLayers(layers: any[]): any[] {
  const out: any[] = [];
  for (const l of layers) {
    const isGroup = Array.isArray(l.layers);
    if (isGroup) {
      if (l.name === "[Color Smash]") continue;
      out.push(...flattenLayers(l.layers));
    } else {
      out.push(l);
    }
  }
  return out;
}

function readLayers(): LayerInfo[] {
  const doc = app.activeDocument;
  if (!doc) return [];
  return flattenLayers(doc.layers)
    .filter((l: any) => l.kind === "pixel" || l.kind === "smartObject" || l.kind === undefined)
    .map((l: any) => ({ id: l.id, name: l.name }));
}

function sameLayers(a: LayerInfo[], b: LayerInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name) return false;
  }
  return true;
}

export function useLayers(): LayerInfo[] {
  const [layers, setLayers] = useState<LayerInfo[]>(() => readLayers());

  useEffect(() => {
    let cancelled = false;
    const tryRefresh = () => {
      if (cancelled) return;
      const next = readLayers();
      setLayers(prev => sameLayers(prev, next) ? prev : next);
    };
    // Defer so the doc tree reflects the just-finished mutation. Two passes catch fast-then-late
    // updates (some events settle on microtask, others after a frame or two).
    const refresh = () => {
      setTimeout(tryRefresh, 0);
      setTimeout(tryRefresh, 120);
    };
    refresh();
    const events = [
      "select", "make", "delete", "set", "open", "close", "move",
      "duplicate", "copyToLayer", "copyMerged", "paste", "placeEvent",
      "rasterizeLayer", "groupLayer", "ungroupLayer", "mergeLayers", "mergeVisible",
    ];
    action.addNotificationListener(events, refresh);
    return () => {
      cancelled = true;
      action.removeNotificationListener?.(events, refresh);
    };
  }, []);

  return layers;
}
