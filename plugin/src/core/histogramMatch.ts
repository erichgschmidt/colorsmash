// Per-channel histogram specification: builds a 0..255 → 0..255 remap per RGB channel that
// makes target's per-channel histogram match source's. Captures range, contrast, value, and
// color cast in a single Curves-shaped function (no cross-channel coupling).

export interface ChannelCurves {
  r: Uint8Array; // length 256, input → output
  g: Uint8Array;
  b: Uint8Array;
}

function buildHistogram(rgba: Uint8Array, channelOffset: 0 | 1 | 2): Float64Array {
  const h = new Float64Array(256);
  for (let i = channelOffset; i < rgba.length; i += 4) h[rgba[i]]++;
  return h;
}

function cumulative(h: Float64Array): Float64Array {
  const c = new Float64Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; c[i] = acc; }
  if (acc > 0) for (let i = 0; i < 256; i++) c[i] /= acc;
  return c;
}

// For each input v, find smallest u such that srcCDF[u] >= tgtCDF[v]. Classic specification.
function specifyChannel(srcCDF: Float64Array, tgtCDF: Float64Array): Uint8Array {
  const out = new Uint8Array(256);
  let u = 0;
  for (let v = 0; v < 256; v++) {
    const target = tgtCDF[v];
    while (u < 255 && srcCDF[u] < target) u++;
    out[v] = u;
  }
  return out;
}

export function fitHistogramCurves(srcRgba: Uint8Array, tgtRgba: Uint8Array): ChannelCurves {
  const out: any = {};
  for (const [name, off] of [["r", 0], ["g", 1], ["b", 2]] as const) {
    const sH = buildHistogram(srcRgba, off);
    const tH = buildHistogram(tgtRgba, off);
    out[name] = specifyChannel(cumulative(sH), cumulative(tH));
  }
  return out as ChannelCurves;
}

// Lerp the fitted curve with identity by `amount` (0..1).
export function blendWithIdentity(curve: Uint8Array, amount: number): Uint8Array {
  const out = new Uint8Array(256);
  const a = Math.max(0, Math.min(1, amount));
  for (let v = 0; v < 256; v++) out[v] = Math.round(v + (curve[v] - v) * a);
  return out;
}

// Sample a 256-entry curve down to N control points evenly spaced on [0,255].
export function sampleControlPoints(curve: Uint8Array, n: number): { input: number; output: number }[] {
  const pts: { input: number; output: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((i / (n - 1)) * 255);
    pts.push({ input: x, output: curve[x] });
  }
  return pts;
}

export function applyChannelCurvesToRgba(rgba: Uint8Array, c: ChannelCurves): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i]     = c.r[rgba[i]];
    out[i + 1] = c.g[rgba[i + 1]];
    out[i + 2] = c.b[rgba[i + 2]];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}
