// Minimal 24-bit uncompressed BMP encoder. Returns a base64 data URL suitable for <img src>.
// BMP rows are bottom-up, BGR-ordered, padded to 4-byte boundaries.

export function rgbaToBmpDataUrl(rgba: Uint8Array, width: number, height: number): string {
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const paddedRow = rowBytes + padding;
  const pixelDataSize = paddedRow * height;
  const fileSize = 54 + pixelDataSize;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  // BITMAPFILEHEADER (14 bytes)
  buf[0] = 0x42; buf[1] = 0x4D;       // "BM"
  view.setUint32(2,  fileSize, true);
  view.setUint32(6,  0, true);         // reserved
  view.setUint32(10, 54, true);        // pixel data offset

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true);        // header size
  view.setInt32 (18, width, true);
  view.setInt32 (22, height, true);    // positive = bottom-up
  view.setUint16(26, 1, true);         // planes
  view.setUint16(28, 24, true);        // bits per pixel
  view.setUint32(30, 0, true);         // BI_RGB (no compression)
  view.setUint32(34, pixelDataSize, true);
  view.setUint32(38, 2835, true);      // x px/m
  view.setUint32(42, 2835, true);      // y px/m
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);

  // Pixel data: bottom-up, BGR, padded.
  let dst = 54;
  for (let y = height - 1; y >= 0; y--) {
    let src = y * width * 4;
    for (let x = 0; x < width; x++) {
      buf[dst++] = rgba[src + 2]; // B
      buf[dst++] = rgba[src + 1]; // G
      buf[dst++] = rgba[src];     // R
      src += 4;
    }
    for (let p = 0; p < padding; p++) buf[dst++] = 0;
  }

  return `data:image/bmp;base64,${bytesToBase64(buf)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to avoid stack overflow on large arrays.
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}
