// Palette extraction via k-means clustering in CIE Lab space. Lab gives perceptually
// uniform distance, so cluster centroids represent visually distinct color groups
// rather than sRGB-cube neighborhoods. Used for the source-palette display strip.
//
// Self-contained on purpose — duplicates the small RGB↔Lab functions from
// histogramMatch.ts. Phase A is display-only; if we keep this feature long-term
// we can refactor to share the conversion code.

// ────────── sRGB ↔ Lab (D65, sRGB primaries) ──────────

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  const x = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  const xn = X / 0.95047, yn = Y, zn = Z / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  return [116 * f(yn) - 16, 500 * (f(xn) - f(yn)), 200 * (f(yn) - f(zn))];
}
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const finv = (t: number) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = finv(fx) * 0.95047, Y = finv(fy), Z = finv(fz) * 1.08883;
  const R = X *  3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const G = X * -0.9692660 + Y *  1.8760108 + Z *  0.0415560;
  const B = X *  0.0556434 + Y * -0.2040259 + Z *  1.0572252;
  return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
}

// ────────── k-means ──────────

export interface PaletteSwatch {
  // RGB triplet in 0..255 for rendering. Derived from the cluster centroid in Lab,
  // converted back to sRGB at extraction time.
  r: number; g: number; b: number;
  // Fraction of sampled pixels that fell into this cluster (0..1). Used to size
  // segments in the weighted-bar UI by natural prevalence.
  weight: number;
  // Cluster centroid in CIE Lab — kept so callers can assign any source pixel to
  // its nearest centroid post-extraction (needed for the weighted-source
  // synthesis path that drives per-cluster boost/exclude in the histogram match).
  labL: number; labA: number; labB: number;
}

// Sample stride: how many pixels to skip when collecting input for k-means. For a
// 256x256 source (max edge), 65k pixels × 4 channels — we can run on every pixel,
// but k-means iterations scale linearly with sample size. 4× decimation gives ~16k
// samples; clusters look visually identical and iterations finish in under 30ms.
const SAMPLE_STRIDE = 4;
const MAX_ITERATIONS = 12;
const CONVERGENCE_THRESHOLD = 0.5; // mean centroid shift in Lab below which we stop

// Extract N dominant colors from RGBA pixel data via k-means in Lab space.
// Pixels with alpha < 128 are skipped (transparent areas don't count). Returns
// swatches sorted by weight (most-prevalent first).
export function extractPalette(rgba: Uint8Array, width: number, height: number, k = 5): PaletteSwatch[] {
  // Collect Lab samples from opaque pixels with stride decimation.
  const samples: number[] = [];
  for (let i = 0; i < width * height; i += SAMPLE_STRIDE) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    samples.push(L, a, b);
  }
  const n = samples.length / 3;
  if (n === 0) return [];
  if (n <= k) {
    // Fewer samples than requested clusters — return each sample as its own swatch.
    const out: PaletteSwatch[] = [];
    for (let i = 0; i < n; i++) {
      const L = samples[i * 3], A = samples[i * 3 + 1], B = samples[i * 3 + 2];
      const [r, g, bb] = labToRgb(L, A, B);
      out.push({ r, g, b: bb, weight: 1 / n, labL: L, labA: A, labB: B });
    }
    return out;
  }

  // Initialize centroids: k-means++ would be ideal, but for k=5 on ~16k samples
  // a deterministic spread by index is fine. Pick equally-spaced indices so we
  // get reasonable initial diversity without the randomness penalty.
  const centroids = new Float32Array(k * 3);
  for (let c = 0; c < k; c++) {
    const idx = Math.floor(((c + 0.5) / k) * n);
    centroids[c * 3] = samples[idx * 3];
    centroids[c * 3 + 1] = samples[idx * 3 + 1];
    centroids[c * 3 + 2] = samples[idx * 3 + 2];
  }

  const assignments = new Int32Array(n);
  const sums = new Float32Array(k * 3);
  const counts = new Int32Array(k);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Assignment step.
    for (let i = 0; i < n; i++) {
      const sl = samples[i * 3], sa = samples[i * 3 + 1], sb = samples[i * 3 + 2];
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = sl - centroids[c * 3];
        const da = sa - centroids[c * 3 + 1];
        const db = sb - centroids[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assignments[i] = best;
    }
    // Update step.
    sums.fill(0); counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      sums[c * 3] += samples[i * 3];
      sums[c * 3 + 1] += samples[i * 3 + 1];
      sums[c * 3 + 2] += samples[i * 3 + 2];
      counts[c]++;
    }
    let totalShift = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // dead cluster — leave centroid in place
      const newL = sums[c * 3] / counts[c];
      const newA = sums[c * 3 + 1] / counts[c];
      const newB = sums[c * 3 + 2] / counts[c];
      const dL = newL - centroids[c * 3];
      const dA = newA - centroids[c * 3 + 1];
      const dB = newB - centroids[c * 3 + 2];
      totalShift += Math.sqrt(dL * dL + dA * dA + dB * dB);
      centroids[c * 3] = newL;
      centroids[c * 3 + 1] = newA;
      centroids[c * 3 + 2] = newB;
    }
    if (totalShift / k < CONVERGENCE_THRESHOLD) break;
  }

  // Build output swatches, dropping dead clusters, sorted by weight desc.
  const out: PaletteSwatch[] = [];
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) continue;
    const L = centroids[c * 3], A = centroids[c * 3 + 1], B = centroids[c * 3 + 2];
    const [r, g, bb] = labToRgb(L, A, B);
    out.push({ r, g, b: bb, weight: counts[c] / n, labL: L, labA: A, labB: B });
  }
  out.sort((p, q) => q.weight - p.weight);
  return out;
}

// Synthesize a weighted source buffer from RGBA + per-cluster weights. For each
// pixel: assign it to the nearest centroid (Lab distance), then emit
// `floor(weight)` copies plus 1 more with probability `weight - floor(weight)`.
// Heavy clusters → pixels appear multiple times → contribute more to histograms.
// Light clusters → pixels appear less often or not at all → contribute less.
//
// The fit functions (full / mean / median / percentile / multi-zone) consume the
// resulting buffer unchanged, so weighting works across every match mode without
// touching the math.
//
// Weights at length k must align positionally with the swatches returned by
// extractPalette — caller is responsible for keeping that mapping intact.
export function synthesizeWeightedSource(
  rgba: Uint8Array,
  swatches: PaletteSwatch[],
  weights: number[],
): Uint8Array {
  const k = swatches.length;
  if (k === 0 || weights.length !== k) return rgba;
  // Fast path: weights all ≈ 1 (natural / no override). Return original buffer
  // unchanged so the existing fit pipeline is bit-for-bit identical.
  let isNeutral = true;
  for (let i = 0; i < k; i++) if (Math.abs(weights[i] - 1) > 0.01) { isNeutral = false; break; }
  if (isNeutral) return rgba;

  // Precompute centroid array (Float32 for tight inner loop).
  const cents = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    cents[i * 3] = swatches[i].labL;
    cents[i * 3 + 1] = swatches[i].labA;
    cents[i * 3 + 2] = swatches[i].labB;
  }

  // First pass: determine output length so we allocate exactly. Same iteration
  // structure as the second pass so probabilistic rounding lands in both.
  const pxCount = rgba.length / 4;
  // Cluster id per pixel (cached so the assignment cost is paid once).
  const assign = new Int32Array(pxCount);
  // Per-pixel emit count (floor + stochastic 1 if frac roll succeeds).
  const emitCount = new Uint8Array(pxCount);

  let total = 0;
  for (let i = 0; i < pxCount; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) { emitCount[i] = 0; continue; }
    const [L, a, b] = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    let best = 0, bestDist = Infinity;
    for (let c = 0; c < k; c++) {
      const dl = L - cents[c * 3];
      const da = a - cents[c * 3 + 1];
      const db = b - cents[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < bestDist) { bestDist = d; best = c; }
    }
    assign[i] = best;
    const w = Math.max(0, weights[best]);
    const floor = Math.floor(w);
    const frac = w - floor;
    const extra = Math.random() < frac ? 1 : 0;
    const n = Math.min(255, floor + extra);
    emitCount[i] = n;
    total += n;
  }

  // Second pass: emit. Skip A=0 pixels (the fit functions skip them anyway, but
  // we'd rather not waste output buffer space on them).
  if (total === 0) return new Uint8Array(0);
  const out = new Uint8Array(total * 4);
  let w = 0;
  for (let i = 0; i < pxCount; i++) {
    const n = emitCount[i];
    if (n === 0) continue;
    const o = i * 4;
    for (let j = 0; j < n; j++) {
      out[w] = rgba[o];
      out[w + 1] = rgba[o + 1];
      out[w + 2] = rgba[o + 2];
      out[w + 3] = rgba[o + 3];
      w += 4;
    }
  }
  return out;
}
