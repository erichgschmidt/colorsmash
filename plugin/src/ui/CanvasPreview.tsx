// Canvas-based preview for the matched-preview path. Avoids the PNG encode + img decode
// roundtrip that the img-based PreviewPane uses (faster, sharper at 1:1).
// UXP canvas createImageData has historically been broken, so we use the `new ImageData(buffer, w, h)`
// constructor instead, which is a separate API path.

import { useEffect, useRef } from "react";

export interface CanvasPreviewHandle {
  setPixels: (rgba: Uint8Array, width: number, height: number) => void;
}

export function CanvasPreview(props: {
  height: number;
  handleRef: React.MutableRefObject<CanvasPreviewHandle | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    props.handleRef.current = {
      setPixels: (rgba, w, h) => {
        const c = canvasRef.current;
        if (!c) return;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d");
        if (!ctx) return;
        try {
          // @ts-ignore — ImageData(Uint8ClampedArray, w, h) constructor is supported but TS overload picks the (sw, sh) form.
          const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h);
          ctx.putImageData(imgData, 0, 0);
        } catch {
          // Fallback: try via createImageData if available.
          try {
            const id = ctx.createImageData(w, h);
            id.data.set(rgba);
            ctx.putImageData(id, 0, 0);
          } catch { /* canvas unsupported in this UXP build */ }
        }
      },
    };
    return () => { props.handleRef.current = null; };
  }, [props.handleRef]);

  return (
    <div style={{ background: "#111", border: "1px solid #555", borderRadius: 2, height: props.height, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
      <canvas
        ref={canvasRef}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", imageRendering: "auto" }}
      />
    </div>
  );
}
