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

// Box-blur a 256-entry curve. Radius 0 = no-op. Reflects at edges to avoid endpoint pull-in.
export function smoothCurve(curve: Uint8Array, radius: number): Uint8Array {
  if (radius < 1) return curve;
  const r = Math.min(64, Math.floor(radius));
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let acc = 0, n = 0;
    for (let k = -r; k <= r; k++) {
      let i = v + k;
      if (i < 0) i = -i; else if (i > 255) i = 510 - i;
      acc += curve[i]; n++;
    }
    out[v] = Math.round(acc / n);
  }
  return out;
}

// Force non-decreasing (running max). Prevents inversions after smoothing.
export function enforceMonotonic(curve: Uint8Array): Uint8Array {
  const out = new Uint8Array(256);
  let m = curve[0];
  for (let v = 0; v < 256; v++) { if (curve[v] > m) m = curve[v]; out[v] = m; }
  return out;
}

// Clamp local slope so |Δoutput / Δinput| ≤ maxRatio. Walks both directions to anchor the
// midpoint so caps don't drag everything toward 0 or 255. maxRatio < 1 means flatten.
export function capStretch(curve: Uint8Array, maxRatio: number): Uint8Array {
  if (maxRatio <= 0) return curve;
  const out = new Uint8Array(curve);
  // Forward pass.
  for (let v = 1; v < 256; v++) {
    const maxJump = Math.max(1, Math.round(maxRatio));
    if (out[v] > out[v - 1] + maxJump) out[v] = out[v - 1] + maxJump;
  }
  // Reverse pass to handle compressive (negative-slope-direction) extremes too.
  for (let v = 254; v >= 0; v--) {
    const maxDrop = Math.max(1, Math.round(maxRatio));
    if (out[v] < out[v + 1] - maxDrop) out[v] = out[v + 1] - maxDrop;
  }
  return out;
}

export interface CurveProcessOpts {
  amount: number;       // 0..1
  smoothRadius: number; // 0..64
  maxStretch: number;   // local slope cap; 1 = identity-only, large = no cap
}

// Full pipeline: stretch-cap → blend with identity by amount → smooth → enforce monotonic.
export function processCurve(raw: Uint8Array, opts: CurveProcessOpts): Uint8Array {
  let c = raw;
  if (opts.maxStretch > 0 && opts.maxStretch < 100) c = capStretch(c, opts.maxStretch);
  c = blendWithIdentity(c, opts.amount);
  if (opts.smoothRadius > 0) c = smoothCurve(c, opts.smoothRadius);
  c = enforceMonotonic(c);
  return c;
}

export function processChannelCurves(raw: ChannelCurves, opts: CurveProcessOpts): ChannelCurves {
  return {
    r: processCurve(raw.r, opts),
    g: processCurve(raw.g, opts),
    b: processCurve(raw.b, opts),
  };
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

// Simulate PS "Color" blend mode: keep target's HSL Lightness, take H+S from mapped pixels.
// Matches the visual effect of setting the Curves layer's blend mode to Color in PS.
export function applyChromaOnly(original: Uint8Array, mapped: Uint8Array): Uint8Array {
  const out = new Uint8Array(mapped.length);
  for (let i = 0; i < mapped.length; i += 4) {
    const [h, s] = rgbToHsl(mapped[i], mapped[i + 1], mapped[i + 2]);
    const [, , l] = rgbToHsl(original[i], original[i + 1], original[i + 2]);
    const [r, g, b] = hslToRgb(h, s, l);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = mapped[i + 3];
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1; else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}
