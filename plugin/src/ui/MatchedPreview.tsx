// Matched-preview block for MatchTab: header (zoom +/−/1:1, swap, before/after),
// draggable container, keyboard shortcut handling for +/-/0, and a <canvas> driven
// imperatively by the parent via the exposed handle (setPixels for matched/after,
// setBefore for the unmodified target).
//
// Uses canvas + putImageData rather than <img> + PNG data URL — PNG encoding was
// the heaviest single op in the preview redraw chain, and putImageData skips it
// entirely. Per-frame work drops by ~5-10× at 256-edge preview, which makes
// every interactive control (sliders, palette weights, presets) feel real-time.
//
// Before/After UX:
//   • Small corner badge overlay shows the current view ("After" / "Before").
//   • Mouse-down on the badge → temporarily show the OTHER view while held.
//   • Click on the badge (no drag) → toggle the persistent default.
// The two combine via XOR (`showBefore !== holding`) so e.g. you can persistent-flip
// to "Before" and then peek at "After" by holding the badge.

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";

export interface MatchedPreviewHandle {
  setPixels: (rgba: Uint8Array, width: number, height: number) => void;
  setBefore: (rgba: Uint8Array, width: number, height: number) => void;
}

interface MatchedPreviewProps {
  onSwap?: () => void;
  canSwap?: boolean;
}

export const MatchedPreview = forwardRef<MatchedPreviewHandle, MatchedPreviewProps>(function MatchedPreview(props, ref) {
  const { onSwap, canSwap } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matchedContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [bgMatchPanel, setBgMatchPanel] = useState(true);
  const dragStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const mouseOverMatchedRef = useRef(false);

  // Cached pixel buffers — parent sends both via the handle. We store the rgba
  // reference + dims and blit via putImageData on demand. No encoding step at all,
  // so flipping Before/After or pushing a new buffer costs only the time to copy
  // bytes onto the canvas.
  const afterRef = useRef<{ rgba: Uint8Array; w: number; h: number } | null>(null);
  const beforeRef = useRef<{ rgba: Uint8Array; w: number; h: number } | null>(null);
  // Persistent "show before by default" toggle (click on badge).
  const [showBefore, setShowBefore] = useState(false);
  // Momentary hold (mousedown→mouseup on badge). XOR with showBefore decides view.
  const [holding, setHolding] = useState(false);
  const displayBefore = showBefore !== holding;

  // Diagnostic flag — set to true to log per-frame state. Leave on while
  // debugging the canvas blank-preview issue, remove once we've confirmed
  // what's working.
  const DEBUG_RENDER = true;
  // One-time canvas sanity check: fill a colored rect to confirm the context
  // can draw at all. If this never appears the issue is canvas mounting / CSS
  // visibility, not ImageData.
  const sanityCheckedRef = useRef(false);

  // Blit the chosen buffer onto the canvas. Resizes canvas intrinsic dims to match
  // the buffer (no-op if unchanged) so putImageData lands 1:1 in pixel space; CSS
  // handles the visual sizing via the zoom/pan style.
  const renderCurrent = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      if (DEBUG_RENDER) console.log("MP render: canvas ref null");
      return;
    }
    const buf = displayBefore ? beforeRef.current : afterRef.current;
    if (!buf) {
      if (DEBUG_RENDER) console.log("MP render: buffer null", { displayBefore, hasBefore: !!beforeRef.current, hasAfter: !!afterRef.current });
      return;
    }
    if (canvas.width !== buf.w) canvas.width = buf.w;
    if (canvas.height !== buf.h) canvas.height = buf.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      if (DEBUG_RENDER) console.error("MP render: getContext('2d') returned null — UXP canvas may not support 2D");
      return;
    }

    // First-time sanity check: draw a magenta square so we can confirm the
    // canvas, its context, and CSS visibility are all working independently
    // of putImageData / ImageData.
    if (!sanityCheckedRef.current) {
      sanityCheckedRef.current = true;
      try {
        ctx.fillStyle = "magenta";
        ctx.fillRect(0, 0, Math.min(40, buf.w), Math.min(40, buf.h));
        if (DEBUG_RENDER) console.log("MP render: drew sanity rect", {
          canvasW: canvas.width, canvasH: canvas.height,
          rectW: canvas.getBoundingClientRect().width,
          rectH: canvas.getBoundingClientRect().height,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("MP render: fillRect failed:", e);
      }
      // Don't return — fall through to putImageData so subsequent frames
      // overwrite the magenta with real pixels.
    }

    try {
      // UXP's Chromium doesn't expose ImageData as a global. ctx.createImageData
      // is the supported factory.
      const imageData = ctx.createImageData(buf.w, buf.h);
      imageData.data.set(buf.rgba);
      ctx.putImageData(imageData, 0, 0);
      if (DEBUG_RENDER) console.log("MP render: putImageData ok", {
        bufLen: buf.rgba.length, expected: buf.w * buf.h * 4,
        canvasW: canvas.width, canvasH: canvas.height,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("MatchedPreview putImageData failed:", e);
    }
  };
  useEffect(renderCurrent, [showBefore, holding]); // re-render on mode flip
  // Render-on-mount fallback: if the parent called setPixels before the canvas
  // ref was attached, the cached buffer never made it onto the canvas. Run
  // once after first commit so any pre-mount buffer paints. Cheap if no buffer
  // is cached yet (early-return).
  useEffect(() => { renderCurrent(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    setPixels: (rgba, w, h) => {
      // Skip blit when the parent hands us the same buffer reference — primarily
      // catches mode-flip churn since result pixels do change every redraw.
      if (afterRef.current && afterRef.current.rgba === rgba) return;
      afterRef.current = { rgba, w, h };
      if (!displayBefore) renderCurrent();
    },
    setBefore: (rgba, w, h) => {
      // Target.snap.data is a stable reference until the target itself changes,
      // so the identity check skips the blit on every slider tick (the parent
      // calls this unconditionally per redraw to keep the badge in sync).
      if (beforeRef.current && beforeRef.current.rgba === rgba) return;
      beforeRef.current = { rgba, w, h };
      if (displayBefore) renderCurrent();
    },
  }), [displayBefore]);

  const onZoomMouseDown = (e: React.MouseEvent) => {
    dragStartRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      setPan({ x: dragStartRef.current.px + (ev.clientX - dragStartRef.current.x), y: dragStartRef.current.py + (ev.clientY - dragStartRef.current.y) });
    };
    const onUp = () => { dragStartRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // Wheel-zoom was attempted but UXP's host-level scroll routing pre-empts our document
  // handler unless an active mouse interaction is happening. Conceded — buttons + drag-pan
  // + keyboard shortcuts are the supported zoom controls.
  // Keyboard shortcuts: + zoom in, - zoom out, 0 reset (when matched preview is hovered).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!mouseOverMatchedRef.current) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(z => Math.min(8, z + 0.25)); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(z => Math.max(0.25, z - 0.25)); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, []);

  // Badge interaction: distinguishes hold (≥150ms or mousemove) from a true click.
  // - mousedown starts a "potential click" timer; if mouseup within window with no
  //   move, it's a click → toggle persistent showBefore.
  // - if held longer than threshold OR moved off, treat as hold → flip momentarily.
  const badgeStateRef = useRef<{ downAt: number; movedOff: boolean } | null>(null);
  const onBadgeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't start a drag-pan
    badgeStateRef.current = { downAt: Date.now(), movedOff: false };
    setHolding(true);
    const onUp = () => {
      window.removeEventListener("mouseup", onUp);
      const s = badgeStateRef.current;
      badgeStateRef.current = null;
      setHolding(false);
      // Quick tap with no drift = persistent toggle. Long hold or drift = just a hold.
      if (s && Date.now() - s.downAt < 200 && !s.movedOff) {
        setShowBefore(b => !b);
      }
    };
    window.addEventListener("mouseup", onUp);
  };

  const badgeText = displayBefore ? "Before" : "After";

  return (
    <>
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Preview</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Swap source/target button — sits just left of the Before/After badge.
              Only enabled when source is an actual layer (selection/folder sources
              can't be valid destinations, so swap is meaningless there). */}
          {onSwap && (
            <div onClick={() => { if (canSwap) onSwap(); }}
              title={canSwap ? "Swap source and target (docs + layers)" : "Swap unavailable: source must be a layer"}
              style={{
                height: 16, width: 22, marginRight: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700,
                color: canSwap ? "#ddd" : "#666",
                border: "1px solid " + (canSwap ? "#888" : "#555"),
                borderRadius: 2, cursor: canSwap ? "pointer" : "default", userSelect: "none", boxSizing: "border-box",
              }}>
              <span style={{ marginTop: -1, lineHeight: 1 }}>⇄</span>
            </div>
          )}
          {/* Before/After badge — moved out of the preview overlay into the header bar
              so it doesn't sit on top of the image. Click toggles persistent view;
              click-and-hold peeks the other view momentarily. Sits just left of the
              zoom controls. marginRight separates it visually from the zoom cluster. */}
          <div onMouseDown={onBadgeMouseDown}
            title={`Currently showing ${badgeText.toLowerCase()}. Click to toggle, hold to peek the other.`}
            style={{
              height: 16, padding: "0 6px", marginRight: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 600,
              color: displayBefore ? "#1a1a1a" : "#dddddd",
              background: displayBefore ? "#c19a3a" : "transparent",
              border: "1px solid " + (displayBefore ? "#c19a3a" : "#888"),
              borderRadius: 2, cursor: "pointer", userSelect: "none", boxSizing: "border-box",
            }}>
            {badgeText}
          </div>
          <div onClick={() => zoom > 0.25 && setZoom(z => Math.max(0.25, z - 0.25))} title="Zoom out"
            style={{ width: 18, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: zoom <= 0.25 ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: zoom <= 0.25 ? "default" : "pointer", userSelect: "none", boxSizing: "border-box" }}>
            <span style={{ marginTop: -2, marginLeft: 1, lineHeight: 1 }}>-</span>
          </div>
          <span style={{ minWidth: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <div onClick={() => zoom < 8 && setZoom(z => Math.min(8, z + 0.25))} title="Zoom in"
            style={{ width: 18, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: zoom >= 8 ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: zoom >= 8 ? "default" : "pointer", userSelect: "none", boxSizing: "border-box" }}>
            <span style={{ marginTop: -2, marginLeft: 1, lineHeight: 1 }}>+</span>
          </div>
          <div
            onClick={() => setBgMatchPanel(b => !b)}
            title={bgMatchPanel ? "Preview background: panel gray (click for dark)" : "Preview background: dark (click to match panel)"}
            style={{ width: 16, height: 16, marginLeft: 8, background: bgMatchPanel ? "#535353" : "#111", border: "1px solid #888", borderRadius: 2, cursor: "pointer", boxSizing: "border-box" }} />
          <div onClick={() => (zoom !== 1 || pan.x !== 0 || pan.y !== 0) && resetZoom()} title="Reset zoom + pan"
            style={{ height: 16, width: 30, marginLeft: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: (zoom === 1 && pan.x === 0 && pan.y === 0) ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: (zoom === 1 && pan.x === 0 && pan.y === 0) ? "default" : "pointer", userSelect: "none", boxSizing: "border-box" }}>
            <span style={{ marginTop: -1, lineHeight: 1 }}>1:1</span>
          </div>
        </div>
      </div>
      <div ref={matchedContainerRef} style={{ position: "relative", height: 240, overflow: "hidden", cursor: "grab", background: bgMatchPanel ? "#535353" : "#111", border: "1px solid #555", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center" }}
        onMouseDown={onZoomMouseDown}
        onMouseEnter={() => { mouseOverMatchedRef.current = true; }}
        onMouseLeave={() => { mouseOverMatchedRef.current = false; }}>
        {/* Canvas sizing: intrinsic dimensions match the buffer (set in
            renderCurrent via canvas.width/height). CSS uses auto sizing
            constrained by max-width/max-height so the canvas fits the container
            at zoom=1 with its native aspect preserved. Zoom + pan applied via
            transform — transform-origin: center so zooming pivots around the
            visual center, not the top-left corner.
            (object-fit on canvas is unreliable across Chromium versions, so
            we don't use it; max-* + auto sizing is the portable equivalent.) */}
        <canvas ref={canvasRef}
          style={{
            width: "auto", height: "auto",
            maxWidth: "100%", maxHeight: "100%",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center",
            flexShrink: 0,
            // Diagnostic background — yellow tint shows the canvas is mounted
            // and visible even when no pixels have been drawn. Will be fully
            // covered by putImageData when rendering succeeds. Remove once we
            // confirm the preview renders.
            background: "rgba(255, 255, 0, 0.15)",
          }} />
      </div>
    </>
  );
});
