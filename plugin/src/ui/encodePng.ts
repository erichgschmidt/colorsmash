// Minimal PNG encoder — 8-bit RGBA, no compression (stored deflate blocks).
// Output is a base64 data URL suitable for <img src>. Pure JS, no deps.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, v: number) {
  buf[offset]     = (v >>> 24) & 0xff;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

function writeChunk(out: number[], type: string, data: Uint8Array) {
  const len = data.length;
  const chunk = new Uint8Array(8 + len + 4);
  writeUint32BE(chunk, 0, len);
  chunk[4] = type.charCodeAt(0); chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2); chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  const crc = crc32(chunk, 4, 8 + len);
  writeUint32BE(chunk, 8 + len, crc);
  for (let i = 0; i < chunk.length; i++) out.push(chunk[i]);
}

// Deflate using stored blocks (no compression). Each block holds up to 65535 bytes.
function deflateStored(input: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(input.length / MAX));
  const out = new Uint8Array(input.length + blocks * 5);
  let dst = 0;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const end = Math.min(start + MAX, input.length);
    const blockLen = end - start;
    const isLast = i === blocks - 1 ? 1 : 0;
    out[dst++] = isLast;          // BFINAL on last, BTYPE=00 (stored)
    out[dst++] = blockLen & 0xff;
    out[dst++] = (blockLen >>> 8) & 0xff;
    out[dst++] = (~blockLen) & 0xff;
    out[dst++] = ((~blockLen) >>> 8) & 0xff;
    out.set(input.subarray(start, end), dst);
    dst += blockLen;
  }
  return out;
}

function zlibWrap(deflated: Uint8Array, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78; out[1] = 0x01; // CMF, FLG (no compression)
  out.set(deflated, 2);
  writeUint32BE(out, 2 + deflated.length, adler32(raw));
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

export function rgbaToPngDataUrl(rgba: Uint8Array, width: number, height: number): string {
  // PNG IHDR
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // Filtered scanlines: 1 filter byte (0 = None) per row + raw pixel bytes.
  const rowBytes = width * 4;
  const filtered = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const dstOff = y * (1 + rowBytes);
    filtered[dstOff] = 0;
    filtered.set(rgba.subarray(srcOff, srcOff + rowBytes), dstOff + 1);
  }

  const deflated = deflateStored(filtered);
  const idat = zlibWrap(deflated, filtered);

  // Assemble: signature + IHDR + IDAT + IEND
  const out: number[] = [137, 80, 78, 71, 13, 10, 26, 10]; // PNG signature
  writeChunk(out, "IHDR", ihdr);
  writeChunk(out, "IDAT", idat);
  writeChunk(out, "IEND", new Uint8Array(0));

  return `data:image/png;base64,${bytesToBase64(new Uint8Array(out))}`;
}
