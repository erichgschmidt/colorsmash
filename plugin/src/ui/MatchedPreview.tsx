// Matched-preview block for MatchTab: header (zoom +/−/1:1), draggable container,
// keyboard shortcut handling for +/-/0, and the inline <img> driven imperatively
// by the parent via the exposed handle (setPixels for matched/after, setBefore
// for the unmodified target).
//
// Before/After UX:
//   • Small corner badge overlay shows the current view ("After" / "Before").
//   • Mouse-down on the badge → temporarily show the OTHER view while held.
//   • Click on the badge (no drag) → toggle the persistent default.
// The two combine via XOR (`showBefore !== holding`) so e.g. you can persistent-flip
// to "Before" and then peek at "After" by holding the badge.

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { rgbaToPngDataUrl } from "./encodePng";

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
  const matchedContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [bgMatchPanel, setBgMatchPanel] = useState(true);
  const dragStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const mouseOverMatchedRef = useRef(false);

  // Cached pixel buffers — parent sends both via the handle. We PNG-encode once
  // per arriving buffer and cache the URL so mode flips are free.
  const afterRef = useRef<{ rgba: Uint8Array; w: number; h: number; url: string } | null>(null);
  const beforeRef = useRef<{ rgba: Uint8Array; w: number; h: number; url: string } | null>(null);
  // Persistent "show before by default" toggle (click on badge).
  const [showBefore, setShowBefore] = useState(false);
  // Momentary hold (mousedown→mouseup on badge). XOR with showBefore decides view.
  const [holding, setHolding] = useState(false);
  const displayBefore = showBefore !== holding;

  // Double-buffer + latest-frame token. We render through TWO <img> elements
  // and only show one at a time. When a new buffer arrives we set the OFF-screen
  // img's src; when it loads (decode complete), we swap which is visible. The
  // currently-visible img keeps showing the previous frame in the meantime, so
  // there's no blank/flicker gap between updates.
  //
  // The token guards against late decodes for stale frames: we increment a
  // counter on every setPixels and capture it at the start of the encode. When
  // the off-screen img's onload fires, we only swap if our captured token is
  // still the latest — otherwise a newer frame is already in flight or just
  // landed and we discard ours.
  const imgARef = useRef<HTMLImageElement>(null);
  const imgBRef = useRef<HTMLImageElement>(null);
  const [activeBuffer, setActiveBuffer] = useState<"A" | "B">("A");
  // Most recent token issued. Capture at encode time; check at onload time.
  const latestTokenRef = useRef(0);

  // Render whichever buffer matches displayBefore. Routes the new url to the
  // currently-OFF-screen img and swaps on its onload. For mode-flips (no new
  // url, just toggle which buffer's url we're already showing) we don't need
  // the swap dance — both URLs are pre-cached, so we just push them to both
  // imgs and update the active flag synchronously.
  const renderCurrent = () => {
    const buf = displayBefore ? beforeRef.current : afterRef.current;
    const a = imgARef.current; const b = imgBRef.current;
    if (!a || !b || !buf) return;
    // Mode-flip path: same url, just decide which img shows it. Set both src's
    // to the same url so whichever becomes active has the right content.
    if (a.src !== buf.url) a.src = buf.url;
    if (b.src !== buf.url) b.src = buf.url;
  };
  useEffect(renderCurrent, [showBefore, holding]);

  // Push a new buffer onto the off-screen img and swap on load. Token-guarded.
  const pushNew = (which: "after" | "before", buf: { rgba: Uint8Array; w: number; h: number; url: string }) => {
    const token = ++latestTokenRef.current;
    // Decide which img is currently off-screen (based on activeBuffer state).
    // Use the ref values at call time rather than closure-capturing activeBuffer
    // because pushNew is invoked from the imperative setPixels.
    const showingA = (activeBuffer === "A");
    const offImg = showingA ? imgBRef.current : imgARef.current;
    if (!offImg) return;
    // Skip the swap if we're not currently showing this buffer's view.
    const isViewActive = (which === "before") === displayBefore;
    if (!isViewActive) return;
    const onload = () => {
      offImg.removeEventListener("load", onload);
      offImg.removeEventListener("error", onerror);
      // Stale-frame guard: a newer pushNew has already happened, drop ours.
      if (token !== latestTokenRef.current) return;
      setActiveBuffer(showingA ? "B" : "A");
    };
    const onerror = () => {
      offImg.removeEventListener("load", onload);
      offImg.removeEventListener("error", onerror);
    };
    offImg.addEventListener("load", onload);
    offImg.addEventListener("error", onerror);
    offImg.src = buf.url;
  };

  useImperativeHandle(ref, () => ({
    setPixels: (rgba, w, h) => {
      if (afterRef.current && afterRef.current.rgba === rgba) return;
      let url = "";
      try { url = rgbaToPngDataUrl(rgba, w, h); } catch { return; }
      const buf = { rgba, w, h, url };
      afterRef.current = buf;
      if (!displayBefore) pushNew("after", buf);
    },
    setBefore: (rgba, w, h) => {
      if (beforeRef.current && beforeRef.current.rgba === rgba) return;
      let url = "";
      try { url = rgbaToPngDataUrl(rgba, w, h); } catch { return; }
      const buf = { rgba, w, h, url };
      beforeRef.current = buf;
      if (displayBefore) pushNew("before", buf);
    },
  }), [displayBefore, activeBuffer]);

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

  // Note for future perf revisits: UXP's Chromium is unusually restricted on
  // pixel-data paths. Two experiments captured here so we don't re-run them:
  //
  //   1. Canvas 2D pixel APIs — ALL missing: createImageData, putImageData,
  //      getImageData, ImageData global, OffscreenCanvas, createImageBitmap.
  //      ctx.fillRect works (basic 2D primitives are fine), but you can't push
  //      a raw RGBA buffer onto a canvas. Tried in feature/palette-weighted-bar
  //      and reverted.
  //
  //   2. BMP data URL — silently rejected. UXP's <img> decoder fires neither
  //      onload nor onerror for `data:image/bmp;base64,...`, even with the img
  //      mounted in DOM. PNG control fires events fine in the same harness, so
  //      it's specifically BMP that's not decoded. Tried in
  //      feature/bmp-preview-probe (branch deleted).
  //
  // Blob + URL.createObjectURL DO exist, but they only help once you've paid
  // the PNG encode cost — and PNG encoding is the actual bottleneck. So PNG
  // data URL → <img> is the floor. Drag perf is acceptable thanks to the
  // cluster-assignment cache + 30fps redraw throttle in MatchTab. If preview
  // ever feels slow again, the next lever is lower-res-during-interaction
  // (render at 128² during drag, full 256² on release) — not a new transport.

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
        {/* Swap source/target button — flush left so it doesn't compete with the
            zoom cluster on the right. Only enabled when source is an actual layer
            (selection/folder sources can't be valid destinations). */}
        {onSwap ? (
          <div onClick={() => { if (canSwap) onSwap(); }}
            title={canSwap ? "Swap source and target (docs + layers)" : "Swap unavailable: source must be a layer"}
            style={{
              height: 16, width: 22, display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700,
              color: canSwap ? "#ddd" : "#666",
              border: "1px solid " + (canSwap ? "#888" : "#555"),
              borderRadius: 2, cursor: canSwap ? "pointer" : "default", userSelect: "none", boxSizing: "border-box",
            }}>
            <span style={{ marginTop: -1, lineHeight: 1 }}>⇄</span>
          </div>
        ) : <span />}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
        {/* Two stacked imgs for double-buffered swap. The off-screen one
            decodes the next frame; on its onload we swap which is visible.
            This eliminates the brief blank gap that single-img + img.src=
            update can show when the parent feeds a new buffer mid-decode.
            We render BOTH absolutely-positioned with the same zoom/pan
            transform so the swap is pixel-identical in geometry. */}
        {(["A", "B"] as const).map(which => (
          <img key={which} ref={which === "A" ? imgARef : imgBRef} alt=""
            style={{
              position: "absolute", inset: 0, margin: "auto",
              width: `${100 * zoom}%`, height: `${100 * zoom}%`,
              objectFit: "contain",
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              flexShrink: 0,
              opacity: activeBuffer === which ? 1 : 0,
              // No transition — we want the swap to be instant. Opacity is
              // the binary visibility toggle; both imgs are mounted and
              // decoded in their respective slots.
            }} />
        ))}
      </div>
    </>
  );
});
