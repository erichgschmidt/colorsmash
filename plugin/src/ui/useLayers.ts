// Tracks the active document's pixel layers and refreshes on PS notifications.
//
// Three layered defenses against staleness:
//   1. Listen for explicit PS notifications (set, rename, make, delete, etc.).
//   2. Defer reads with setTimeout so doc.layers reflects just-finished mutations.
//   3. Poll every 1.5s as backup for events PS coalesces or never fires.
//
// Even with all of that, `layer.name` returned by the UXP DOM is *cached* — PS only
// invalidates the cache on certain notifications, which other plugins' batch operations
// (e.g. LayerSquish auto-rename) sometimes don't trigger. To bypass that cache, we re-query
// each layer's name via action.batchPlay, which always reads PS state directly in real time.

import { useEffect, useRef, useState } from "react";
import { app, action } from "../services/photoshop";

// `kind` is whatever PS reports on layer.kind ("pixel" | "smartObject" | "group" | "text" |
// "adjustment" | …). Surfaced so the new dense list UI can show a type tag per row without
// re-querying. Optional because folded-down DOM entries occasionally lack it.
export interface LayerInfo { id: number; name: string; kind?: string; }

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

function readLayersFromDom(docId: number | null): { id: number; name: string; kind?: string; path: string[] }[] {
  if (docId == null) return [];
  const doc = (app.documents ?? []).find((d: any) => d.id === docId);
  if (!doc) return [];
  return walkLayers(doc.layers)
    .filter(({ layer: l }) => l.kind === "pixel" || l.kind === "smartObject" || l.kind === undefined)
    .map(({ layer: l, path }) => ({ id: l.id, name: l.name, kind: l.kind, path }));
}

// Bypass the UXP DOM's name cache by querying each layer's current name via batchPlay.
// PS evaluates the descriptor against live document state — there's no caching layer in
// front of it. One batched call regardless of layer count.
async function fetchFreshNames(docId: number, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  try {
    const queries = ids.map(id => ({
      _obj: "get",
      _target: [
        { _property: "name" },
        { _ref: "layer", _id: id },
        { _ref: "document", _id: docId },
      ],
    }));
    const results: any[] = await action.batchPlay(queries, { synchronousExecution: false } as any);
    ids.forEach((id, i) => {
      const n = results[i]?.name;
      if (typeof n === "string") out.set(id, n);
    });
  } catch { /* fall back to whatever the DOM gave us */ }
  return out;
}

async function readLayersFresh(docId: number | null): Promise<LayerInfo[]> {
  if (docId == null) return [];
  const dom = readLayersFromDom(docId);
  if (dom.length === 0) return [];
  const fresh = await fetchFreshNames(docId, dom.map(l => l.id));
  // Also refresh group path names — group renames have the same DOM-cache problem. Walk
  // the dom result and resolve each path segment to a fresh name where possible.
  const allPathIds = new Set<string>();
  for (const { path } of dom) for (const segment of path) allPathIds.add(segment);
  // Path segments are by name not id, so a second pass would need group ids. Skip for now —
  // the leaf name is what users care about most.
  return dom.map(({ id, name, kind, path }) => ({
    id,
    kind,
    name: (() => {
      const leafName = fresh.get(id) ?? name;
      return path.length > 0 ? `${path.join(" / ")} / ${leafName}` : leafName;
    })(),
  }));
}

function sameLayers(a: LayerInfo[], b: LayerInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name) return false;
  }
  return true;
}

// Layers for the panel-selected document — NOT app.activeDocument. The panel is the source
// of truth: even if the user clicks another doc tab in PS chrome, this hook keeps reading
// from the doc they picked in the panel dropdown.
//
// Manual mode only: fetches on mount and on docId change. Otherwise sits inert until the
// user clicks a refresh button (which calls the returned refresh()). No polling, no PS
// notification listeners — the parent's stale detector handles the "things changed" hint.
export function useLayers(docId: number | null): { layers: LayerInfo[]; refresh: () => void } {
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const refreshFnRef = useRef<() => Promise<void>>(async () => {});
  const docIdRef = useRef(docId);
  docIdRef.current = docId;

  // Reset list immediately when the panel-selected doc id changes so we don't briefly show
  // the previous doc's layers under the new doc's selection.
  useEffect(() => { setLayers([]); }, [docId]);

  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    const tryRefresh = async (force = false) => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const next = await readLayersFresh(docIdRef.current);
        if (!cancelled) {
          setLayers(prev => (force || !sameLayers(prev, next)) ? next : prev);
        }
      } finally {
        inflight = false;
      }
    };
    refreshFnRef.current = () => tryRefresh(true);
    const refresh = () => {
      setTimeout(() => tryRefresh(false), 0);
      setTimeout(() => tryRefresh(false), 120);
    };
    refresh();
    return () => { cancelled = true; };
  }, [docId]);

  return {
    layers,
    refresh: () => { void refreshFnRef.current(); },
  };
}
