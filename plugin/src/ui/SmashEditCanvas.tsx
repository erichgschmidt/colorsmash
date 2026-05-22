// Large, zoomable/pannable editing canvas for the Smash tab. Mirrors the base
// Match section's zoom/pan model (buttons + log2 slider + keyboard +/-/0 +
// drag-pan; NO scroll-wheel zoom — UXP's host intercepts the wheel before our
// handler, see MatchedPreview.tsx) and adds Source / Target / Output tabs plus
// draggable + resizable circle overlays for anchors and splits.
//
// Coordinate model — everything is computed in screen pixels from:
//   scale0 = contain-fit of (imgW,imgH) into (cw,ch); dw = imgW·scale0·zoom;
//   ox = (cw−dw)/2 + pan.x; a normalized point (nx,ny) → (ox+nx·dw, oy+ny·dh).
// A circle's normalized radius is a fraction of max(imgW,imgH), so its screen
// radius is radius·max(dw,dh). Center/resize handles are FIXED screen size so
// they stay grabbable at any zoom; rings scale with the image (they represent
// an image-space reach).

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Pt } from "../core/regions";

export interface CanvasCircle {
  key: string;
  nx: number;
  ny: number;
  radius: number;       // normalized to max(imgW,imgH)
  color: string;
  dashed?: boolean;
  movable?: boolean;    // draggable centre (default true)
  resizable?: boolean;  // drag-handle on the ring
  removable?: boolean;  // × badge
  // Feather, 0..1 — when `featherable`, the circle draws a faint inner ring at
  // radius·(1−feather) with its own drag handle; dragging it sets feather.
  featherable?: boolean;
  feather?: number;
}

// A polygon (lasso/vector) overlay — outline + draggable vertices + a centroid
// move handle. Normalized points.
export interface CanvasPoly {
  key: string;
  points: Pt[];
  color: string;
  movable?: boolean;    // centroid drag translates the whole polygon
  editable?: boolean;   // per-vertex drag handles
  removable?: boolean;  // × badge near the centroid
}

export interface CanvasView {
  id: string;
  label: string;
  url: string | null;
  imgW: number;
  imgH: number;
  circles: CanvasCircle[];
  polys?: CanvasPoly[];
  placeholder: string;
  // Optional highlight image drawn ON TOP of `url` at the same transform (its
  // own alpha controls the wash/dim). Used for the macro-group silhouette so the
  // active group "pops" and its gaps are visible while eyedropping. pointerEvents
  // are disabled so it never intercepts placement clicks.
  overlayUrl?: string | null;
  // True click on empty canvas (debounced vs pan/drag). Omitted = view is
  // read-only (e.g. the Output tab). `opts.alt` carries the Alt modifier so the
  // caller can invert an armed eyedropper (add ⇄ subtract) for that one click.
  onPlace?: (nx: number, ny: number, opts?: { alt?: boolean }) => void;
  // When set, dragging on empty canvas draws a freehand lasso (pan is suspended);
  // on release the collected normalized path is handed back to be simplified
  // into a polygon region.
  onLasso?: (points: Pt[]) => void;
}

interface Props {
  views: CanvasView[];
  activeId: string;
  onActiveChange: (id: string) => void;
  onMoveCircle: (viewId: string, key: string, nx: number, ny: number) => void;
  onResizeCircle: (viewId: string, key: string, radius: number) => void;
  onRemoveCircle: (viewId: string, key: string) => void;
  onFeatherCircle?: (viewId: string, key: string, feather: number) => void;
  // Polygon editing: replace a polygon's points (vertex drag / centroid move),
  // and remove a polygon.
  onSetPolyPoints?: (viewId: string, key: string, points: Pt[]) => void;
  onRemovePoly?: (viewId: string, key: string) => void;
  // When set, the header shows an eye toggle. While hidden, circle overlays
  // aren't drawn and placing/dragging is suppressed — so you can judge the
  // recolored result (or outline over it) cleanly.
  overlaysHidden?: boolean;
  onToggleOverlays?: () => void;
  // Performance: when false (default), a drag updates only the cheap overlay and
  // the expensive pipeline (re-segment / transfer) runs ONCE on release. When
  // true, every pointer-move commits live (continuous recompute). Header shows a
  // ⚡ toggle when onToggleLiveDrag is provided.
  liveDrag?: boolean;
  onToggleLiveDrag?: () => void;
  // Press-and-hold on the image (no drag) for ~HOLD_MS fires this with the held
  // point + screen coords — used to open the magnify/sub-palette loupe. A quick
  // tap still fires onPlace; a drag pans. Omitted = no hold gesture.
  onHold?: (nx: number, ny: number, clientX: number, clientY: number) => void;
  height?: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const PLACE_DRAG_PX = 4; // movement that turns a tap into a pan
const HANDLE = 11;       // fixed screen px for the centre handle hit area
const HOLD_MS = 280;     // press-and-hold (no drag) before the loupe fires

type Gesture =
  | { kind: "bg"; sx: number; sy: number; px: number; py: number; moved: boolean }
  | { kind: "move"; key: string; sx: number; sy: number; moved: boolean }
  | { kind: "resize"; key: string }
  | { kind: "feather"; key: string }
  | { kind: "lasso" }
  | { kind: "polyMove"; key: string; startNX: number; startNY: number; start: Pt[] }
  | { kind: "polyVertex"; key: string; index: number };

export function SmashEditCanvas({
  views, activeId, onActiveChange,
  onMoveCircle, onResizeCircle, onRemoveCircle, onFeatherCircle,
  onSetPolyPoints, onRemovePoly,
  overlaysHidden = false, onToggleOverlays,
  liveDrag = false, onToggleLiveDrag,
  onHold,
  height = 280,
}: Props) {
  const view = views.find(v => v.id === activeId) ?? views[0];

  // In-progress drag draft (performance mode): the live geometry of the item
  // being dragged, rendered locally so the heavy pipeline isn't recomputed until
  // release. null when idle or in live mode.
  type Draft = { key: string; kind: Gesture["kind"]; nx?: number; ny?: number; radius?: number; feather?: number; points?: Pt[] };
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // Hovered polygon vertex (for the remove-vertex × badge).
  const [hoverVertex, setHoverVertex] = useState<{ key: string; index: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cw, setCw] = useState(0);
  const ch = height;

  const containerRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const gestureRef = useRef<Gesture | null>(null);
  // Press-and-hold (loupe) bookkeeping: a pending timer and a flag set when the
  // hold fired so the subsequent pointerup doesn't ALSO place.
  const holdTimerRef = useRef<number | null>(null);
  const heldRef = useRef(false);
  const [, force] = useState(0); // re-render on gesture transitions when needed
  // In-progress freehand lasso path (normalized), rendered live while drawing.
  const [lassoPts, setLassoPts] = useState<Pt[] | null>(null);
  const lassoActive = !!view?.onLasso && !overlaysHidden;

  // Measure container width (panel width is stable; re-measure on window resize
  // and tab change in case layout shifts).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el) setCw(el.clientWidth);
    const onResize = () => { if (containerRef.current) setCw(containerRef.current.clientWidth); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeId]);

  // Geometry for the active view at the current zoom/pan.
  const geom = (() => {
    const imgW = view?.imgW || 1;
    const imgH = view?.imgH || 1;
    const scale0 = Math.min(cw / imgW, ch / imgH) || 0;
    const dw = imgW * scale0 * zoom;
    const dh = imgH * scale0 * zoom;
    const ox = (cw - dw) / 2 + pan.x;
    const oy = (ch - dh) / 2 + pan.y;
    return { imgW, imgH, scale0, dw, dh, ox, oy, maxD: Math.max(dw, dh) };
  })();

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const { ox, oy, dw, dh } = geom;
    if (dw <= 0 || dh <= 0) return null;
    return { nx: clamp01((px - ox) / dw), ny: clamp01((py - oy) / dh), px, py };
  }, [geom]);

  // Window-level pointer handling while a gesture is active.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      if (g.kind === "bg") {
        const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        if (!g.moved && Math.hypot(dx, dy) > PLACE_DRAG_PX) {
          g.moved = true;
          // Became a pan → cancel the pending hold/loupe.
          if (holdTimerRef.current != null) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
        }
        if (g.moved) setPan({ x: g.px + dx, y: g.py + dy });
        return;
      }
      if (g.kind === "move") {
        const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        if (!g.moved && Math.hypot(dx, dy) > PLACE_DRAG_PX) g.moved = true;
        const n = toNorm(e.clientX, e.clientY);
        if (n && view) {
          if (liveDrag) onMoveCircle(view.id, g.key, n.nx, n.ny);
          else setDraft({ key: g.key, kind: "move", nx: n.nx, ny: n.ny });
        }
        return;
      }
      if (g.kind === "resize" || g.kind === "feather") {
        const el = containerRef.current;
        if (!el || !view) return;
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const c = view.circles.find(cc => cc.key === g.key);
        if (!c) return;
        const cxPx = geom.ox + c.nx * geom.dw;
        const cyPx = geom.oy + c.ny * geom.dh;
        const dist = Math.hypot(px - cxPx, py - cyPx);
        if (g.kind === "resize") {
          const radius = geom.maxD > 0 ? clamp01(dist / geom.maxD) : c.radius;
          if (liveDrag) onResizeCircle(view.id, g.key, radius);
          else setDraft({ key: g.key, kind: "resize", radius });
        } else {
          // Inner handle distance vs the outer ring → feather = 1 − inner/outer.
          const outerPx = c.radius * geom.maxD;
          const feather = outerPx > 0 ? clamp01(1 - dist / outerPx) : 0;
          if (liveDrag) onFeatherCircle?.(view.id, g.key, feather);
          else setDraft({ key: g.key, kind: "feather", feather });
        }
        return;
      }
      if (g.kind === "lasso") {
        const n = toNorm(e.clientX, e.clientY);
        if (n) setLassoPts(prev => [...(prev ?? []), { x: n.nx, y: n.ny }]);
        return;
      }
      if (g.kind === "polyMove") {
        if (!view) return;
        const n = toNorm(e.clientX, e.clientY);
        if (!n) return;
        const dnx = n.nx - g.startNX, dny = n.ny - g.startNY;
        const moved = g.start.map(p => ({ x: clamp01(p.x + dnx), y: clamp01(p.y + dny) }));
        if (liveDrag) onSetPolyPoints?.(view.id, g.key, moved);
        else setDraft({ key: g.key, kind: "polyMove", points: moved });
        return;
      }
      if (g.kind === "polyVertex") {
        if (!view) return;
        const poly = view.polys?.find(p => p.key === g.key);
        const n = toNorm(e.clientX, e.clientY);
        if (!poly || !n) return;
        const src = (draftRef.current && draftRef.current.key === g.key && draftRef.current.points) ? draftRef.current.points : poly.points;
        const pts = src.map((p, i) => (i === g.index ? { x: n.nx, y: n.ny } : p));
        if (liveDrag) onSetPolyPoints?.(view.id, g.key, pts);
        else setDraft({ key: g.key, kind: "polyVertex", points: pts });
        return;
      }
    };
    const onUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      // Any pending hold timer is moot now.
      if (holdTimerRef.current != null) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
      // A completed hold (loupe opened) swallows the click — don't also place.
      if (g && g.kind === "bg" && !g.moved && !heldRef.current && view?.onPlace && !overlaysHidden) {
        const n = toNorm(e.clientX, e.clientY);
        if (n) view.onPlace(n.nx, n.ny, { alt: e.altKey });
      }
      heldRef.current = false;
      if (g && g.kind === "lasso" && view?.onLasso) {
        setLassoPts(prev => {
          if (prev && prev.length >= 3) view.onLasso!(prev);
          return null;
        });
      }
      // Performance mode: commit the deferred draft once, on release.
      const d = draftRef.current;
      if (!liveDrag && g && d && view) {
        if (d.kind === "move" && d.nx != null && d.ny != null) onMoveCircle(view.id, d.key, d.nx, d.ny);
        else if (d.kind === "resize" && d.radius != null) onResizeCircle(view.id, d.key, d.radius);
        else if (d.kind === "feather" && d.feather != null) onFeatherCircle?.(view.id, d.key, d.feather);
        else if ((d.kind === "polyMove" || d.kind === "polyVertex") && d.points) onSetPolyPoints?.(view.id, d.key, d.points);
      }
      if (d) setDraft(null);
      force(x => x + 1);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [view, geom, toNorm, onMoveCircle, onResizeCircle, onFeatherCircle, onSetPolyPoints, overlaysHidden, liveDrag]);

  // Keyboard zoom when hovered (mirrors Match).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(z => Math.min(8, z + 0.25)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(z => Math.max(0.25, z - 0.25)); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onBgDown = (e: React.PointerEvent) => {
    if (lassoActive) {
      // Start a freehand lasso instead of a pan. Seed with the first point.
      const n = toNorm(e.clientX, e.clientY);
      gestureRef.current = { kind: "lasso" };
      setLassoPts(n ? [{ x: n.nx, y: n.ny }] : []);
      return;
    }
    gestureRef.current = { kind: "bg", sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, moved: false };
    // Arm the press-and-hold loupe: if the pointer stays put for HOLD_MS, fire
    // onHold (and suppress the click-place on release). A pan cancels it.
    heldRef.current = false;
    if (onHold && !overlaysHidden) {
      const cx = e.clientX, cy = e.clientY;
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        const g = gestureRef.current;
        if (g && g.kind === "bg" && !g.moved) {
          const n = toNorm(cx, cy);
          if (n) { heldRef.current = true; onHold(n.nx, n.ny, cx, cy); }
        }
      }, HOLD_MS);
    }
  };
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const atDefault = zoom === 1 && pan.x === 0 && pan.y === 0;

  const btn = (enabled: boolean): React.CSSProperties => ({
    width: 18, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, fontWeight: 700, color: enabled ? "#ddd" : "#666",
    border: "1px solid #888", borderRadius: 2, cursor: enabled ? "pointer" : "default",
    userSelect: "none", boxSizing: "border-box",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* Tab strip + zoom controls on one header row. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
        <div style={{ display: "flex", gap: 3, flex: 1 }}>
          {views.map(v => {
            const active = v.id === activeId;
            const disabled = !v.url;
            return (
              <div
                key={v.id}
                onClick={() => { if (!disabled) onActiveChange(v.id); }}
                title={disabled ? `${v.label} (not ready)` : v.label}
                style={{
                  padding: "3px 9px", fontSize: 10, fontWeight: 600, borderRadius: 3,
                  border: `1px solid ${active ? "#1473e6" : "#444"}`,
                  background: active ? "#1473e6" : "#2c2c2c",
                  color: disabled ? "#666" : active ? "#fff" : "#aaa",
                  cursor: disabled ? "default" : "pointer", userSelect: "none",
                }}
              >
                {v.label}
              </div>
            );
          })}
        </div>
        {/* zoom cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <div onClick={() => zoom > 0.25 && setZoom(z => Math.max(0.25, z - 0.25))} title="Zoom out (−)"
            style={btn(zoom > 0.25)}>−</div>
          <input type="range" min={Math.log2(0.25)} max={Math.log2(8)} step={0.05}
            value={Math.log2(Math.max(0.25, Math.min(8, zoom)))}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setZoom(Math.pow(2, v)); }}
            title={`Zoom ${Math.round(zoom * 100)}%`}
            style={{ width: 58, margin: 0, cursor: "pointer" }} />
          <div onClick={() => zoom < 8 && setZoom(z => Math.min(8, z + 0.25))} title="Zoom in (+)"
            style={btn(zoom < 8)}>+</div>
          <span style={{ minWidth: 30, textAlign: "right", opacity: 0.7 }}>{Math.round(zoom * 100)}%</span>
          {onToggleLiveDrag && (
            <div onClick={onToggleLiveDrag}
              title={liveDrag
                ? "Live drag: recomputes continuously while you drag (smoother result, heavier). Click for performance mode."
                : "Performance: dragging updates only the outline; the recolor recomputes when you release. Click for live drag."}
              style={{ height: 16, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: liveDrag ? "#7dd87d" : "#f5a623", border: `1px solid ${liveDrag ? "#3a5a3a" : "#5a4416"}`, borderRadius: 2, cursor: "pointer", userSelect: "none", boxSizing: "border-box" }}>
              {liveDrag ? "live" : "⚡"}
            </div>
          )}
          {onToggleOverlays && (
            <div onClick={onToggleOverlays}
              title={overlaysHidden ? "Show region overlays (anchors / splits)" : "Hide region overlays — judge or outline over the clean image"}
              style={{ height: 16, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: overlaysHidden ? "#666" : "#ddd", border: `1px solid ${overlaysHidden ? "#555" : "#888"}`, borderRadius: 2, cursor: "pointer", userSelect: "none", boxSizing: "border-box" }}>
              {overlaysHidden ? "◌" : "◉"}
            </div>
          )}
          <div onClick={() => !atDefault && resetZoom()} title="Reset zoom + pan (0)"
            style={{ height: 16, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: atDefault ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: atDefault ? "default" : "pointer", userSelect: "none", boxSizing: "border-box" }}>1:1</div>
        </div>
      </div>

      {/* Stage */}
      <div
        ref={containerRef}
        onPointerDown={onBgDown}
        onPointerEnter={() => { hoverRef.current = true; }}
        onPointerLeave={() => { hoverRef.current = false; }}
        style={{
          position: "relative", width: "100%", height: ch, overflow: "hidden",
          background: "#1b1b1b", border: "1px solid #3a3a3a", borderRadius: 2,
          cursor: gestureRef.current?.kind === "bg" && gestureRef.current.moved ? "grabbing" : "crosshair",
          touchAction: "none", userSelect: "none",
        }}
      >
        {view?.url ? (
          <img
            src={view.url}
            draggable={false}
            style={{
              position: "absolute",
              left: geom.ox, top: geom.oy, width: geom.dw, height: geom.dh,
              imageRendering: "pixelated", display: "block", pointerEvents: "none",
            }}
          />
        ) : (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 10, opacity: 0.5, color: "#ccc",
          }}>{view?.placeholder ?? "—"}</div>
        )}

        {/* Group-silhouette highlight (its own alpha dims the rest / washes the
            group). Hidden with the eye toggle so the clean result stays judgeable. */}
        {view?.url && view.overlayUrl && !overlaysHidden && (
          <img
            src={view.overlayUrl}
            draggable={false}
            style={{
              position: "absolute",
              left: geom.ox, top: geom.oy, width: geom.dw, height: geom.dh,
              imageRendering: "pixelated", display: "block", pointerEvents: "none",
            }}
          />
        )}

        {/* Circle overlays */}
        {view?.url && !overlaysHidden && view.circles.map(c => {
          // Performance mode: render the dragged circle from its live draft so
          // it follows the cursor without committing to the heavy pipeline.
          const d = draft && draft.key === c.key ? draft : null;
          const nx = d?.nx ?? c.nx;
          const ny = d?.ny ?? c.ny;
          const radius = d?.radius ?? c.radius;
          const cxPx = geom.ox + nx * geom.dw;
          const cyPx = geom.oy + ny * geom.dh;
          const rPx = radius * geom.maxD;
          const movable = c.movable !== false;
          const resizeAngle = -Math.PI / 4; // handle at upper-right of the ring
          const hx = cxPx + Math.cos(resizeAngle) * rPx;
          const hy = cyPx + Math.sin(resizeAngle) * rPx;
          const feather = d?.feather ?? c.feather ?? 0;
          const innerFrac = 1 - feather;
          // Feather handle sits on the inner ring at lower-left (+135°).
          const fAngle = (3 * Math.PI) / 4;
          const fr = rPx * innerFrac;
          const fhx = cxPx + Math.cos(fAngle) * fr;
          const fhy = cyPx + Math.sin(fAngle) * fr;
          return (
            <Fragment key={c.key}>
              {/* outer ring */}
              <div style={{
                position: "absolute", pointerEvents: "none",
                left: cxPx - rPx, top: cyPx - rPx, width: rPx * 2, height: rPx * 2,
                borderRadius: "50%",
                border: c.dashed ? `1px dashed ${c.color}` : `1px solid ${c.color}`,
                opacity: 0.9,
              }} />
              {/* inner feather ring (faint) — the core where the split applies
                  fully; between it and the outer ring the recolor feathers. */}
              {c.featherable && feather > 0 && (
                <div style={{
                  position: "absolute", pointerEvents: "none",
                  left: cxPx - fr, top: cyPx - fr, width: fr * 2, height: fr * 2,
                  borderRadius: "50%", border: `1px solid ${c.color}`, opacity: 0.4,
                }} />
              )}
              {/* centre handle (drag to move) */}
              <div
                onPointerDown={movable ? (e) => {
                  e.stopPropagation();
                  gestureRef.current = { kind: "move", key: c.key, sx: e.clientX, sy: e.clientY, moved: false };
                } : undefined}
                style={{
                  position: "absolute",
                  left: cxPx - HANDLE, top: cyPx - HANDLE, width: HANDLE * 2, height: HANDLE * 2,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: movable ? "grab" : "default",
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.color, border: "1px solid #000", pointerEvents: "none" }} />
              </div>
              {/* resize handle on the ring */}
              {c.resizable && (
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    gestureRef.current = { kind: "resize", key: c.key };
                  }}
                  title="Drag to resize"
                  style={{
                    position: "absolute",
                    left: hx - 6, top: hy - 6, width: 12, height: 12,
                    borderRadius: 2, background: "#1f1f1f", border: `1px solid ${c.color}`,
                    cursor: "nesw-resize",
                  }}
                />
              )}
              {/* feather handle on the inner ring — drag toward centre for a
                  softer edge, toward the rim for a harder one. */}
              {c.featherable && onFeatherCircle && (
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    gestureRef.current = { kind: "feather", key: c.key };
                  }}
                  title="Drag to feather (soft edge)"
                  style={{
                    position: "absolute",
                    left: fhx - 5, top: fhy - 5, width: 10, height: 10,
                    borderRadius: "50%", background: c.color, border: "1px solid #000",
                    opacity: 0.85, cursor: "move",
                  }}
                />
              )}
              {/* remove badge */}
              {c.removable && (
                <div
                  onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); if (view) onRemoveCircle(view.id, c.key); }}
                  title="Remove"
                  style={{
                    position: "absolute",
                    left: cxPx + 6, top: cyPx - 16, width: 13, height: 13,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "#1f1f1f", color: "#fff", border: `1px solid ${c.color}`,
                    borderRadius: "50%", fontSize: 10, lineHeight: "10px", fontWeight: 700,
                    cursor: "pointer", userSelect: "none",
                  }}
                >×</div>
              )}
            </Fragment>
          );
        })}

        {/* Polygon (lasso) outlines — SVG, visual only. */}
        {view?.url && !overlaysHidden && view.polys && view.polys.length > 0 && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {view.polys.map(p => {
              const dp = (draft && draft.key === p.key && draft.points) ? draft.points : p.points;
              const pts = dp
                .map(pt => `${geom.ox + pt.x * geom.dw},${geom.oy + pt.y * geom.dh}`)
                .join(" ");
              return (
                <polygon key={p.key} points={pts} fill={p.color} fillOpacity={0.12}
                  stroke={p.color} strokeWidth={1} strokeDasharray="4 3" opacity={0.95} />
              );
            })}
          </svg>
        )}

        {/* Polygon handles — vertices (edit), centroid (move), remove badge. */}
        {view?.url && !overlaysHidden && view.polys && view.polys.map(p => {
          const pp = (draft && draft.key === p.key && draft.points) ? draft.points : p.points;
          let cx = 0, cy = 0;
          for (const pt of pp) { cx += pt.x; cy += pt.y; }
          cx /= pp.length || 1; cy /= pp.length || 1;
          const cenX = geom.ox + cx * geom.dw, cenY = geom.oy + cy * geom.dh;
          return (
            <Fragment key={p.key}>
              {/* Edge-midpoint "+" handles — click to INSERT a vertex there. */}
              {p.editable !== false && onSetPolyPoints && pp.map((pt, i) => {
                const nxt = pp[(i + 1) % pp.length];
                const mx = geom.ox + ((pt.x + nxt.x) / 2) * geom.dw;
                const my = geom.oy + ((pt.y + nxt.y) / 2) * geom.dh;
                return (
                  <div key={`mid-${i}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const inserted = pp.slice();
                      inserted.splice(i + 1, 0, { x: (pt.x + nxt.x) / 2, y: (pt.y + nxt.y) / 2 });
                      if (view) onSetPolyPoints(view.id, p.key, inserted);
                    }}
                    title="Add a point on this edge"
                    style={{
                      position: "absolute", left: mx - 4, top: my - 4, width: 8, height: 8,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: "50%", background: "#1f1f1f", border: `1px dashed ${p.color}`,
                      color: p.color, fontSize: 8, lineHeight: "8px", cursor: "copy", opacity: 0.7,
                    }}>+</div>
                );
              })}
              {p.editable !== false && pp.map((pt, i) => {
                const vx = geom.ox + pt.x * geom.dw, vy = geom.oy + pt.y * geom.dh;
                const hovered = hoverVertex && hoverVertex.key === p.key && hoverVertex.index === i;
                const canRemove = pp.length > 3 && onSetPolyPoints;
                return (
                  <Fragment key={`v-${i}`}>
                    <div
                      onPointerDown={(e) => { e.stopPropagation(); gestureRef.current = { kind: "polyVertex", key: p.key, index: i }; }}
                      onPointerEnter={() => setHoverVertex({ key: p.key, index: i })}
                      onPointerLeave={() => setHoverVertex(h => (h && h.key === p.key && h.index === i ? null : h))}
                      title="Drag to reshape"
                      style={{
                        position: "absolute", left: vx - 5, top: vy - 5, width: 10, height: 10,
                        borderRadius: "50%", background: "#1f1f1f", border: `1px solid ${p.color}`,
                        cursor: "grab",
                      }} />
                    {hovered && canRemove && (
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation(); e.preventDefault();
                          const trimmed = pp.filter((_, j) => j !== i);
                          if (view) onSetPolyPoints!(view.id, p.key, trimmed);
                          setHoverVertex(null);
                        }}
                        title="Remove this point"
                        style={{
                          position: "absolute", left: vx + 5, top: vy - 13, width: 12, height: 12,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: "#3a2a2a", color: "#e8b0b0", border: `1px solid #6a4a4a`,
                          borderRadius: "50%", fontSize: 10, lineHeight: "10px", fontWeight: 700,
                          cursor: "pointer", userSelect: "none",
                        }}>×</div>
                    )}
                  </Fragment>
                );
              })}
              {p.movable !== false && (
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const n = toNorm(e.clientX, e.clientY);
                    if (!n) return;
                    gestureRef.current = { kind: "polyMove", key: p.key, startNX: n.nx, startNY: n.ny, start: pp.map(q => ({ ...q })) };
                  }}
                  title="Drag to move the whole region"
                  style={{
                    position: "absolute", left: cenX - HANDLE, top: cenY - HANDLE,
                    width: HANDLE * 2, height: HANDLE * 2,
                    display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab",
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, border: "1px solid #000", pointerEvents: "none" }} />
                </div>
              )}
              {p.removable && (
                <div
                  onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); if (view) onRemovePoly?.(view.id, p.key); }}
                  title="Remove region"
                  style={{
                    position: "absolute", left: cenX + 6, top: cenY - 16, width: 13, height: 13,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "#1f1f1f", color: "#fff", border: `1px solid ${p.color}`,
                    borderRadius: "50%", fontSize: 10, lineHeight: "10px", fontWeight: 700,
                    cursor: "pointer", userSelect: "none",
                  }}
                >×</div>
              )}
            </Fragment>
          );
        })}

        {/* In-progress freehand lasso */}
        {lassoPts && lassoPts.length > 0 && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            <polyline
              points={lassoPts.map(pt => `${geom.ox + pt.x * geom.dw},${geom.oy + pt.y * geom.dh}`).join(" ")}
              fill="#f5a62322" stroke="#f5a623" strokeWidth={1.5} />
          </svg>
        )}
      </div>

      <div style={{ fontSize: 9, color: "#888", lineHeight: 1.4 }}>
        {lassoActive
          ? "Lasso mode: drag to draw a region · release to place · drag a vertex to reshape · click a dashed + on an edge to add a point · hover a vertex and click × to remove it."
          : "Drag to pan · +/− or the slider to zoom (no scroll-wheel in Photoshop) · drag a dot to move, the square handle to resize, the inner dot to feather. Polygon: + on an edge adds a point, hover a vertex for ×."}
      </div>
    </div>
  );
}
