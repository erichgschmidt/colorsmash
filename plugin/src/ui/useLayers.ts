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

// Recursively walk the layer tree, returning {layer, path} pairs where path is the slash-
// separated group hierarchy ("Group / Subgroup / LayerName"). doc.layers only contains
// top-level items, so any layer moved into a group (e.g. by another plugin auto-grouping)
// would otherwise vanish from our flat list. Skips our own [Color Smash] group so Match
// Curves adjustment layers don't pollute the source/target picker.
function walkLayers(layers: any[], parentPath: string[] = []): { layer: any; path: string[] }[] {
  const out: { layer: any; path: string[] }[] = [];
  for (const l of layers) {
    const isGroup = Array.isArray(l.layers);
    if (isGroup) {
      if (l.name === "[Color Smash]") continue;
      out.push(...walkLayers(l.layers, [...parentPath, l.name]));
    } else {
      out.push({ layer: l, path: parentPath });
    }
  }
  return out;
}

function readLayers(): LayerInfo[] {
  const doc = app.activeDocument;
  if (!doc) return [];
  return walkLayers(doc.layers)
    .filter(({ layer: l }) => l.kind === "pixel" || l.kind === "smartObject" || l.kind === undefined)
    .map(({ layer: l, path }) => ({
      id: l.id,
      name: path.length > 0 ? `${path.join(" / ")} / ${l.name}` : l.name,
    }));
}

function sameLayers(a: LayerInfo[], b: LayerInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name) return false;
  }
  return true;
}

export function useLayers(): { layers: LayerInfo[]; refresh: () => void } {
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
      "rename",
    ];
    action.addNotificationListener(events, refresh);
    // Low-frequency poll as backup: catches changes made by other plugins that wrap many ops
    // in one executeAsModal (e.g. LayerSquish's batch rename) — PS may coalesce/suppress the
    // individual notifications so we never see them. 1.5s is light and indistinguishable from
    // event-driven refresh in normal use.
    const pollTimer = setInterval(tryRefresh, 1500);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      action.removeNotificationListener?.(events, refresh);
    };
  }, []);

  return {
    layers,
    refresh: () => setLayers(readLayers()),
  };
}
