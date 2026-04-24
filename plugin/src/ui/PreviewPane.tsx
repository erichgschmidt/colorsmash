// Reusable preview pane: layer dropdown + image (drawn from RGBA via PNG data URL).
// Optional onPickColor: clicking on the image samples the pixel under the cursor and calls back.

import { useEffect, useRef } from "react";
import { rgbaToPngDataUrl } from "./encodePng";
import type { LayerSnapshot } from "./useLayerPreview";

export interface PreviewPaneProps {
  label: string;
  layers: { id: number; name: string }[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  snapshot: LayerSnapshot | null;
  transformedRgba?: Uint8Array | null;  // optional override (e.g., zones-applied target preview)
  onRefresh?: () => void;
  onPickColor?: (rgb: { r: number; g: number; b: number }) => void;
  height?: number;
  hideSelector?: boolean;
  fitAspect?: boolean;  // if true, container height tracks snapshot aspect ratio
  maxHeight?: number;   // cap for fitAspect (default 180)
  centerImg?: boolean;  // if true, image is centered horizontally in its container (default left)
  imgTransform?: string; // CSS transform applied to the img (for zoom/pan)
}

export interface PreviewImgHandle {
  setPixels: (rgba: Uint8Array, width: number, height: number) => void;
}

export function PreviewPane(props: PreviewPaneProps & { imgHandleRef?: React.MutableRefObject<PreviewImgHandle | null> }) {
  const imgRef = useRef<HTMLImageElement>(null);
  // Second buffer img for double-buffering when imgHandleRef is used. Eliminates the
  // load-cycle blank-frame flash inherent to img.src reassignment with dataURLs.
  const imgBackRef = useRef<HTMLImageElement>(null);
  const visibleRef = useRef<"front" | "back">("front");
  const wrapRef = useRef<HTMLDivElement>(null);
  const height = props.height ?? 140;

  useEffect(() => {
    if (!props.imgHandleRef) return;
    props.imgHandleRef.current = {
      setPixels: (rgba, w, h) => {
        const front = imgRef.current;
        const back = imgBackRef.current;
        if (!front || !back) return;
        const showFront = visibleRef.current === "front";
        const target = showFront ? back : front;
        const other  = showFront ? front : back;
        target.onload = () => {
          target.style.opacity = "1";
          other.style.opacity = "0";
          visibleRef.current = showFront ? "back" : "front";
        };
        target.src = rgbaToPngDataUrl(rgba, w, h);
      },
    };
    return () => { if (props.imgHandleRef) props.imgHandleRef.current = null; };
  }, [props.imgHandleRef]);

  useEffect(() => {
    // When imgHandleRef is provided, the parent owns img.src updates imperatively
    // (e.g. live preview redraws). Don't double-write here or we cause flicker.
    if (props.imgHandleRef) return;
    const img = imgRef.current;
    if (!img || !props.snapshot) return;
    const data = props.transformedRgba ?? props.snapshot.data;
    img.src = rgbaToPngDataUrl(data, props.snapshot.width, props.snapshot.height);
  }, [props.snapshot, props.transformedRgba, props.imgHandleRef]);

  const onImgClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!props.onPickColor || !props.snapshot) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * props.snapshot.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * props.snapshot.height);
    const i = (y * props.snapshot.width + x) * 4;
    const data = props.transformedRgba ?? props.snapshot.data;
    props.onPickColor({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };

  const sel: React.CSSProperties = { flex: 1, padding: "2px 4px", fontSize: 10, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" };

  const aspectStyle: React.CSSProperties = props.fitAspect && props.snapshot
    ? { aspectRatio: `${props.snapshot.width} / ${props.snapshot.height}`, width: "100%", maxHeight: props.maxHeight ?? 180 }
    : { height };

  return (
    <div ref={wrapRef} style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {!props.hideSelector && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2, fontSize: 10, opacity: 0.8 }}>
          <span style={{ width: 40, opacity: 0.7 }}>{props.label}</span>
          <select style={sel} value={props.selectedId ?? ""} onChange={e => props.onSelect(Number(e.target.value))}>
            {props.layers.length === 0 && <option value="">— none —</option>}
            {props.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}
      <div style={{
        background: "#111", border: "1px solid #555", borderRadius: 2,
        display: "flex", alignItems: "center", justifyContent: props.centerImg ? "center" : "flex-start",
        ...aspectStyle, overflow: "hidden", position: "relative",
      }}>
        {(props.snapshot || props.imgHandleRef)
          ? props.imgHandleRef
            ? <>
                <img ref={imgRef} alt={props.label} onClick={onImgClick}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                           cursor: props.onPickColor ? "crosshair" : "default",
                           position: "absolute", top: 0, left: 0, right: 0, bottom: 0, margin: "auto" }} />
                <img ref={imgBackRef} alt="" aria-hidden
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                           position: "absolute", top: 0, left: 0, right: 0, bottom: 0, margin: "auto",
                           opacity: 0, pointerEvents: "none" }} />
              </>
            : <img ref={imgRef} alt={props.label} onClick={onImgClick}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                         cursor: props.onPickColor ? "crosshair" : "default" }} />
          : <span style={{ color: "#666", fontSize: 10 }}>{props.layers.length === 0 ? "no layers" : "select a layer"}</span>}
      </div>
      {props.onRefresh && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
          <button onClick={props.onRefresh} style={{
            padding: "1px 6px", background: "transparent", color: "#aaa",
            border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9,
          }}>↻</button>
        </div>
      )}
    </div>
  );
}
