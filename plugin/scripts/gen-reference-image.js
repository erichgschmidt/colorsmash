// Generate the standardized reference image used by Pro Smash Engine for preset
// gallery thumbnails, regression tests, and side-by-side preset previews.
// 1024x1024 RGBA PNG. Content is procedural so the asset is reproducible:
//   - 4x6 X-Rite ColorChecker grid (24 standard patches)
//   - 8-swatch Fitzpatrick-inspired skin row
//   - 8-swatch foliage row
//   - Sky gradient strip (cool zenith to warm horizon)
//   - Neutral ramp (black to white)
// See ColorSmash_Research_06_inspiration.md §U6 for rationale.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── PNG encoding (same pattern as gen-placeholder-icons.js) ────────────────

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
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Reference content ─────────────────────────────────────────────────────

// X-Rite ColorChecker 24 patches (sRGB byte values; widely-cited 2014 reference set).
// Order: row-major, top-left to bottom-right.
const COLORCHECKER = [
  [115,  82,  68],  // 1  dark skin
  [194, 150, 130],  // 2  light skin
  [ 98, 122, 157],  // 3  blue sky
  [ 87, 108,  67],  // 4  foliage
  [133, 128, 177],  // 5  blue flower
  [103, 189, 170],  // 6  bluish green
  [214, 126,  44],  // 7  orange
  [ 80,  91, 166],  // 8  purplish blue
  [193,  90,  99],  // 9  moderate red
  [ 94,  60, 108],  // 10 purple
  [157, 188,  64],  // 11 yellow green
  [224, 163,  46],  // 12 orange yellow
  [ 56,  61, 150],  // 13 blue
  [ 70, 148,  73],  // 14 green
  [175,  54,  60],  // 15 red
  [231, 199,  31],  // 16 yellow
  [187,  86, 149],  // 17 magenta
  [  8, 133, 161],  // 18 cyan
  [243, 243, 242],  // 19 white
  [200, 200, 200],  // 20 neutral 8
  [160, 160, 160],  // 21 neutral 6.5
  [122, 122, 121],  // 22 neutral 5
  [ 85,  85,  85],  // 23 neutral 3.5
  [ 52,  52,  52],  // 24 black
];

// Fitzpatrick-inspired skin tones, light to deep (sRGB).
const SKIN = [
  [250, 220, 200],
  [240, 200, 175],
  [220, 180, 150],
  [200, 160, 130],
  [175, 130,  95],
  [140, 100,  70],
  [100,  65,  45],
  [ 60,  40,  30],
];

// Foliage greens, light/yellow to dark/cool.
const FOLIAGE = [
  [180, 195,  80],
  [130, 180,  60],
  [ 90, 160,  75],
  [ 50, 110,  50],
  [110, 100,  50],
  [ 35,  80,  35],
  [ 25,  60,  45],
  [ 80,  95,  60],
];

// Sky stops along x (left to right): cool zenith → mid → warm horizon.
const SKY_STOPS = [
  { x: 0.0,  rgb: [ 60, 100, 200] },
  { x: 0.5,  rgb: [160, 200, 230] },
  { x: 1.0,  rgb: [250, 200, 140] },
];

const BG = [80, 80, 80]; // mid-gray surround so the ColorChecker reads as a separate field

// ── Layout (image = 1024 x 1024) ──────────────────────────────────────────

const W = 1024, H = 1024;
const CC_LEFT = 128, CC_RIGHT = 896;      // ColorChecker centered horizontally (768px wide)
const CC_TOP = 0, CC_BOTTOM = 512;        // top half, 512px tall
const CC_COLS = 6, CC_ROWS = 4;
const CC_PATCH_W = (CC_RIGHT - CC_LEFT) / CC_COLS;  // 128
const CC_PATCH_H = (CC_BOTTOM - CC_TOP) / CC_ROWS;  // 128

const SKIN_TOP = 512, SKIN_BOTTOM = 640;
const FOLIAGE_TOP = 640, FOLIAGE_BOTTOM = 768;
const SKY_TOP = 768, SKY_BOTTOM = 896;
const RAMP_TOP = 896, RAMP_BOTTOM = 1024;

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpRgb(a, b, t) {
  return [Math.round(lerp(a[0], b[0], t)),
          Math.round(lerp(a[1], b[1], t)),
          Math.round(lerp(a[2], b[2], t))];
}

function sampleSky(tx) {
  // tx in [0, 1]; piecewise linear over SKY_STOPS.
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const a = SKY_STOPS[i], b = SKY_STOPS[i + 1];
    if (tx >= a.x && tx <= b.x) {
      const local = (tx - a.x) / (b.x - a.x);
      return lerpRgb(a.rgb, b.rgb, local);
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1].rgb;
}

function pixel(x, y) {
  // ColorChecker patches (centered field, mid-gray outside)
  if (y < CC_BOTTOM) {
    if (x >= CC_LEFT && x < CC_RIGHT) {
      const col = Math.min(CC_COLS - 1, Math.floor((x - CC_LEFT) / CC_PATCH_W));
      const row = Math.min(CC_ROWS - 1, Math.floor((y - CC_TOP) / CC_PATCH_H));
      const [r, g, b] = COLORCHECKER[row * CC_COLS + col];
      return [r, g, b, 255];
    }
    return [BG[0], BG[1], BG[2], 255];
  }

  // Skin row: 8 swatches across full width
  if (y < SKIN_BOTTOM) {
    const idx = Math.min(SKIN.length - 1, Math.floor((x / W) * SKIN.length));
    const [r, g, b] = SKIN[idx];
    return [r, g, b, 255];
  }

  // Foliage row: 8 swatches across full width
  if (y < FOLIAGE_BOTTOM) {
    const idx = Math.min(FOLIAGE.length - 1, Math.floor((x / W) * FOLIAGE.length));
    const [r, g, b] = FOLIAGE[idx];
    return [r, g, b, 255];
  }

  // Sky strip: horizontal piecewise-linear gradient
  if (y < SKY_BOTTOM) {
    const [r, g, b] = sampleSky(x / (W - 1));
    return [r, g, b, 255];
  }

  // Neutral ramp: pure linear black → white
  const v = Math.round((x / (W - 1)) * 255);
  return [v, v, v, 255];
}

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

const png = makePng(W, H, pixel);
const outPath = path.join(outDir, "reference.png");
fs.writeFileSync(outPath, png);
console.log(`wrote assets/reference.png (${W}x${H}, ${png.length} bytes)`);
