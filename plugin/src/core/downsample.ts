// Box-filter downsample to a max edge of N pixels. Used for stats-on-downsample (§16).

import type { PixelBuffer } from "../services/photoshop";

export function downsampleToMaxEdge(buf: PixelBuffer, maxEdge: number): PixelBuffer {
  const scale = Math.min(1, maxEdge / Math.max(buf.width, buf.height));
  if (scale >= 1) return buf;
  const w = Math.max(1, Math.round(buf.width * scale));
  const h = Math.max(1, Math.round(buf.height * scale));
  const out = new Uint8Array(w * h * 4);
  const sx = buf.width / w;
  const sy = buf.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(buf.height, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(buf.width, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * buf.width + xx) * 4;
          r += buf.data[i]; g += buf.data[i + 1]; b += buf.data[i + 2]; a += buf.data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out, bounds: buf.bounds };
}
