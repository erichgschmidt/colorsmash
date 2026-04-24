// Matched-preview block for MatchTab: header (zoom +/−/1:1), draggable container,
// keyboard shortcut handling for +/-/0, and the inline <img> driven imperatively
// by the parent via the exposed handle (setPixels).

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { rgbaToPngDataUrl } from "./encodePng";

export interface MatchedPreviewHandle {
  setPixels: (rgba: Uint8Array, width: number, height: number) => void;
}

export const MatchedPreview = forwardRef<MatchedPreviewHandle, {}>(function MatchedPreview(_props, ref) {
  const matchedFrontRef = useRef<HTMLImageElement>(null);
  const matchedContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const mouseOverMatchedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    setPixels: (rgba, w, h) => {
      const img = matchedFrontRef.current;
      if (!img) return;
      try { img.src = rgbaToPngDataUrl(rgba, w, h); } catch { /* ignore encode errors during drag */ }
    },
  }), []);

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

  return (
    <>
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Preview</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button onClick={() => setZoom(z => Math.max(0.25, z - 0.25))} disabled={zoom <= 0.25} title="Zoom out" style={{ width: 18, height: 16, padding: 0, fontSize: 12, lineHeight: "12px", background: "transparent", color: zoom <= 0.25 ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: zoom <= 0.25 ? "default" : "pointer" }}>−</button>
          <span style={{ minWidth: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(8, z + 0.25))} disabled={zoom >= 8} title="Zoom in" style={{ width: 18, height: 16, padding: 0, fontSize: 12, lineHeight: "12px", background: "transparent", color: zoom >= 8 ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: zoom >= 8 ? "default" : "pointer" }}>+</button>
          <button onClick={resetZoom} disabled={zoom === 1 && pan.x === 0 && pan.y === 0} title="Reset zoom + pan" style={{ height: 16, padding: "0 6px", fontSize: 9, background: "transparent", color: zoom === 1 ? "#666" : "#ddd", border: "1px solid #888", borderRadius: 2, cursor: "pointer" }}>1:1</button>
        </div>
      </div>
      <div ref={matchedContainerRef} style={{ height: 240, overflow: "hidden", cursor: "grab", background: "#111", border: "1px solid #555", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center" }}
        onMouseDown={onZoomMouseDown}
        onMouseEnter={() => { mouseOverMatchedRef.current = true; }}
        onMouseLeave={() => { mouseOverMatchedRef.current = false; }}>
        <img ref={matchedFrontRef} alt=""
          style={{
            width: `${100 * zoom}%`, height: `${100 * zoom}%`,
            objectFit: "contain",
            marginLeft: `${pan.x}px`, marginTop: `${pan.y}px`,
            flexShrink: 0,
          }} />
      </div>
    </>
  );
});
