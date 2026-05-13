// Adaptive band construction over the per-pixel feature set.
// Phase 0 implements the `value` (luma) axis only; hue/saturation/chroma axes
// are reserved for Phase 2 and throw until then.

import type { PixelFeatures, BandAxis, BandStats } from './types';

const LABELS_3 = ['Shadows', 'Mids', 'Highlights'] as const;
const LABELS_5 = ['Deep', 'Shadow', 'Mid', 'Light', 'Highlight'] as const;
const LABELS_7 = ['Deep', 'Shadow', 'Low Mid', 'Mid', 'High Mid', 'Light', 'Highlight'] as const;

function bandLabels(count: 3 | 5 | 7): readonly string[] {
  if (count === 3) return LABELS_3;
  if (count === 5) return LABELS_5;
  return LABELS_7;
}

// Percentile indices for adaptive edge computation.
// Returns (count+1) fractional positions in [0, 1].
function percentilePositions(count: 3 | 5 | 7): number[] {
  if (count === 3) return [0, 1 / 3, 2 / 3, 1];
  if (count === 5) return [0, 0.2, 0.4, 0.6, 0.8, 1];
  // count === 7
  return [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1];
}

// Linearly-interpolated percentile from a sorted Float32Array (0-indexed).
function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Componentwise median for a list of Vec3.
function medianVec3(values: ReadonlyArray<readonly [number, number, number]>): readonly [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const a0 = new Float32Array(values.length);
  const a1 = new Float32Array(values.length);
  const a2 = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    a0[i] = values[i][0];
    a1[i] = values[i][1];
    a2[i] = values[i][2];
  }
  a0.sort();
  a1.sort();
  a2.sort();
  return [percentile(a0, 0.5), percentile(a1, 0.5), percentile(a2, 0.5)];
}

/**
 * Construct adaptive bands from a feature set along the given axis.
 * For Phase 0 only `axis === 'value'` is supported; all others throw.
 * Returns `count` BandStats in ascending center order.
 */
export function constructBands(
  features: PixelFeatures[],
  axis: BandAxis,
  count: 3 | 5 | 7,
): BandStats[] {
  if (axis !== 'value') {
    throw new Error('band axis ' + axis + ' not yet supported');
  }

  const labels = bandLabels(count);
  const positions = percentilePositions(count);
  const total = features.length;

  // Extract and sort luma for adaptive edge computation.
  const lumaArr = new Float32Array(total);
  for (let i = 0; i < total; i++) lumaArr[i] = features[i].luma;
  const sorted = lumaArr.slice().sort();

  // Build adaptive edges: outer values come from data min/max.
  const edges = new Float32Array(count + 1);
  const dataMin = sorted.length > 0 ? sorted[0] : 0;
  const dataMax = sorted.length > 0 ? sorted[sorted.length - 1] : 1;
  edges[0] = dataMin;
  edges[count] = dataMax;
  for (let i = 1; i < count; i++) {
    edges[i] = percentile(sorted, positions[i]);
  }

  // When all data collapses to one value (degenerate case), adaptive percentiles also
  // collapse. Fall back to fixed linear edges in [0, 1] so bucketing still places
  // pixels in the semantically correct band (black → Shadows, white → Highlights).
  const degenerate = dataMax === dataMin;
  const fixedEdges = new Float32Array(count + 1);
  for (let i = 0; i <= count; i++) fixedEdges[i] = i / count;
  const effectiveEdges = degenerate ? fixedEdges : edges;

  // Bucket each feature into a band.
  // Tie-breaks at interior edges go to the higher band (spec). The last band
  // is the final fallback so pixels at data_max always land somewhere.
  const buckets: PixelFeatures[][] = Array.from({ length: count }, () => []);
  for (let fi = 0; fi < total; fi++) {
    const luma = features[fi].luma;
    let band = count - 1; // default: last band
    for (let b = 0; b < count - 1; b++) {
      if (luma < effectiveEdges[b + 1]) {
        band = b;
        break;
      }
    }
    buckets[band].push(features[fi]);
  }

  // Build BandStats for each band.
  const result: BandStats[] = [];
  for (let b = 0; b < count; b++) {
    const bFeatures = buckets[b];
    const sc = bFeatures.length;
    const bounds: readonly [number, number] = [edges[b], edges[b + 1]];
    const center = (bounds[0] + bounds[1]) / 2;

    if (sc === 0) {
      result.push({
        axis,
        index: b,
        label: labels[b],
        bounds,
        softWidth: 0.05,
        center,
        pixelRatio: 0,
        meanOklab: [0, 0, 0],
        medianOklab: [0, 0, 0],
        dominantHue: 0,
        hueSpread: 0,
        satMedian: 0,
        chromaMedian: 0,
        chromaSpread: 0,
        neutralDensity: 0,
        accentDensity: 0,
        histogram: new Float32Array(32),
        sampleCount: 0,
      });
      continue;
    }

    // meanOklab: componentwise arithmetic mean.
    let sumL = 0, sumA = 0, sumBk = 0;
    for (const f of bFeatures) {
      sumL += f.oklab[0];
      sumA += f.oklab[1];
      sumBk += f.oklab[2];
    }
    const meanOklab: readonly [number, number, number] = [sumL / sc, sumA / sc, sumBk / sc];

    // medianOklab: componentwise median.
    const medianOklab = medianVec3(bFeatures.map(f => f.oklab as readonly [number, number, number]));

    // dominantHue and hueSpread via chroma-weighted circular mean.
    // Weights are feature.chroma; low-chroma pixels have unstable hue.
    let sumCos = 0, sumSin = 0, sumW = 0;
    for (const f of bFeatures) {
      const w = f.chroma;
      sumCos += w * Math.cos(f.hueAngle);
      sumSin += w * Math.sin(f.hueAngle);
      sumW += w;
    }
    let dominantHue = 0;
    let hueSpread = 1;
    if (sumW > 0) {
      const meanCos = sumCos / sumW;
      const meanSin = sumSin / sumW;
      dominantHue = Math.atan2(meanSin, meanCos);
      const R = Math.sqrt(meanCos * meanCos + meanSin * meanSin);
      hueSpread = 1 - R;
    }

    // Median / IQR statistics.
    const satArr = new Float32Array(sc);
    const chromaArr = new Float32Array(sc);
    for (let i = 0; i < sc; i++) {
      satArr[i] = bFeatures[i].saturation;
      chromaArr[i] = bFeatures[i].chroma;
    }
    satArr.sort();
    chromaArr.sort();
    const satMedian = percentile(satArr, 0.5);
    const chromaMedian = percentile(chromaArr, 0.5);
    const chromaSpread = percentile(chromaArr, 0.75) - percentile(chromaArr, 0.25);

    // neutralDensity and accentDensity: unweighted means.
    let sumNeutral = 0, sumAccent = 0;
    for (const f of bFeatures) {
      sumNeutral += f.neutralScore;
      sumAccent += f.accentScore;
    }
    const neutralDensity = sumNeutral / sc;
    const accentDensity = sumAccent / sc;

    // 32-bin histogram over [bounds[0], bounds[1]].
    const histogram = new Float32Array(32);
    const bandSpan = bounds[1] - bounds[0];
    if (bandSpan > 0) {
      for (const f of bFeatures) {
        const binPos = (f.luma - bounds[0]) / bandSpan;
        const bin = Math.min(31, Math.max(0, Math.floor(binPos * 32)));
        histogram[bin] += 1;
      }
    } else {
      // Zero-width band: all samples go to bin 0.
      histogram[0] = sc;
    }

    result.push({
      axis,
      index: b,
      label: labels[b],
      bounds,
      softWidth: 0.05,
      center,
      pixelRatio: sc / total,
      meanOklab,
      medianOklab,
      dominantHue,
      hueSpread,
      satMedian,
      chromaMedian,
      chromaSpread,
      neutralDensity,
      accentDensity,
      histogram,
      sampleCount: sc,
    });
  }

  // Sort by ascending center (should already be monotonic but be explicit).
  result.sort((a, b) => a.center - b.center);
  return result;
}
