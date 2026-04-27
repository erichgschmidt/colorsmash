// Generate placeholder UXP panel icons (light/dark @ 1x/2x).
// Glyph: hollow ring with a smaller centered dot — abstract, neutral, recognizable at 23px.
// Replace these with proper artwork before marketplace submission.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(width, height, getPixel) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rowLen = 1 + width * 4;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Filled disc with a smaller transparent inner hole and an even smaller solid center dot.
// Sub-pixel anti-aliasing for clean edges at small sizes.
function ringIcon(size, gray) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.22;
  const rDot = size * 0.10;
  return makePng(size, size, (x, y) => {
    // Multi-sample for anti-aliasing
    let coverage = 0;
    const samples = 4;
    for (let sy = 0; sy < samples; sy++) {
      for (let sx = 0; sx < samples; sx++) {
        const px = x + (sx + 0.5) / samples - 0.5;
        const py = y + (sy + 0.5) / samples - 0.5;
        const dx = px - cx, dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const inRing = d <= rOuter && d >= rInner;
        const inDot = d <= rDot;
        if (inRing || inDot) coverage++;
      }
    }
    const a = Math.round((coverage / (samples * samples)) * 255);
    return [gray, gray, gray, a];
  });
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });

// Panel icons: light theme = dark glyph; dark theme = light glyph.
const panelVariants = [
  { name: "icon-light.png",     size: 23, gray: 0x1a },
  { name: "icon-light@2x.png",  size: 46, gray: 0x1a },
  { name: "icon-dark.png",      size: 23, gray: 0xdd },
  { name: "icon-dark@2x.png",   size: 46, gray: 0xdd },
];

// Marketplace listing icons: required at 48, 96, 192. Adobe shows these against a
// neutral background so a mid-gray glyph reads on either light or dark. Using the
// dark-theme luminance (#dd) so it pops on Adobe's typical dark listing chrome.
const marketVariants = [
  { name: "marketplace-48.png",  size: 48,  gray: 0xdd },
  { name: "marketplace-96.png",  size: 96,  gray: 0xdd },
  { name: "marketplace-192.png", size: 192, gray: 0xdd },
];

for (const v of [...panelVariants, ...marketVariants]) {
  const png = ringIcon(v.size, v.gray);
  fs.writeFileSync(path.join(outDir, v.name), png);
  console.log(`wrote icons/${v.name} (${png.length} bytes)`);
}
