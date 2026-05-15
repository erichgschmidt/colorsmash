// Pro Smash Engine — DNA assembly and band pairing.
// Turns raw RGBA buffers into SourceDNA / TargetStructure by composing the
// features, bands, clusters, and global stats primitives; then pairs two DNAs
// index-wise into an ImagePairProfile consumed by downstream transform code.

import type {
  SourceDNA,
  TargetStructure,
  ImagePairProfile,
  BandPair,
  GlobalStats,
  BandAxis,
  Vec3,
} from './types';
import { SMASH_SCHEMA_VERSION } from './types';
import { extractFeatures } from './features';
import { constructBands } from './bands';
import { extractClusters } from './clusters';

// ────────── public constants ──────────

/** Minimum samples in a band for pairing to be viable. Exposed for tests. */
export const VIABILITY_THRESHOLD = 16;

// ────────── option types ──────────

export interface DnaExtractOptions {
  /** Default 3. */
  readonly bandCount?: 3 | 5 | 7;
  /** Default 'value'. Only 'value' supported in Phase 1. */
  readonly bandAxis?: BandAxis;
  /** Default 5. Number of palette clusters; must be an integer in [3, 32]. */
  readonly clusterCount?: number;
  /** Default 4 (matches features.ts default stride). */
  readonly sampleStride?: number;
  /** Optional base64 PNG thumbnail to embed. */
  readonly thumbnail?: string;
}

// ────────── internal helpers ──────────

// Linearly-interpolated percentile from a sorted Float32Array, matching
// the same convention used in bands.ts.
function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Componentwise median of a Vec3 array, sorting each axis independently.
function medianVec3(values: readonly Vec3[]): Vec3 {
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

// Arithmetic mean of a number array.
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Median of a number array.
function medianNumbers(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = new Float32Array(values);
  sorted.sort();
  return percentile(sorted, 0.5);
}

// ────────── core extraction (shared path) ──────────

function extractDna(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: DnaExtractOptions | undefined,
): SourceDNA {
  const bandCount = options?.bandCount ?? 3;
  const bandAxis: BandAxis = options?.bandAxis ?? 'value';
  const clusterCount = options?.clusterCount ?? 5;
  const sampleStride = options?.sampleStride ?? 4;

  const features = extractFeatures(rgba, width, height, sampleStride);
  const bands = constructBands(features, bandAxis, bandCount);
  const clusters = extractClusters(rgba, width, height, clusterCount);

  let global: GlobalStats;
  if (features.length === 0) {
    global = {
      meanOklab: [0, 0, 0],
      medianOklab: [0, 0, 0],
      chromaMean: 0,
      chromaMedian: 0,
      neutralRatio: 0,
      accentRatio: 0,
    };
  } else {
    const n = features.length;

    // meanOklab: componentwise arithmetic mean.
    let sumL = 0, sumA = 0, sumB = 0;
    for (const f of features) {
      sumL += f.oklab[0];
      sumA += f.oklab[1];
      sumB += f.oklab[2];
    }
    const meanOklab: Vec3 = [sumL / n, sumA / n, sumB / n];

    const oklabVecs = features.map(f => f.oklab as Vec3);
    const chromaVals = features.map(f => f.chroma);

    global = {
      meanOklab,
      medianOklab: medianVec3(oklabVecs),
      chromaMean: mean(chromaVals),
      chromaMedian: medianNumbers(chromaVals),
      neutralRatio: mean(features.map(f => f.neutralScore)),
      accentRatio: mean(features.map(f => f.accentScore)),
    };
  }

  const dna: SourceDNA = {
    version: SMASH_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    bands,
    clusters,
    global,
    ...(options?.thumbnail !== undefined ? { thumbnail: options.thumbnail } : {}),
  };

  return dna;
}

// ────────── public API ──────────

/**
 * Extract a SourceDNA snapshot from an image's RGBA buffer.
 * Composes extractFeatures + constructBands + extractClusters and adds
 * image-wide GlobalStats derived from the full feature set.
 */
export function extractSourceDNA(
  rgba: Uint8Array,
  width: number,
  height: number,
  options?: DnaExtractOptions,
): SourceDNA {
  return extractDna(rgba, width, height, options);
}

/**
 * Extract a TargetStructure from an image's RGBA buffer. Same algorithm as
 * extractSourceDNA — TargetStructure is a type alias for SourceDNA at the
 * schema level.
 */
export function extractTargetStructure(
  rgba: Uint8Array,
  width: number,
  height: number,
  options?: DnaExtractOptions,
): TargetStructure {
  return extractDna(rgba, width, height, options);
}

/**
 * Pair a SourceDNA with a TargetStructure by band index. For Phase 1, bands
 * are paired 1-to-1 by their index (band[0] of source pairs with band[0] of
 * target, etc.). Both must have the same bandCount; throws otherwise.
 *
 * A pair is viable if both bands have sampleCount >= VIABILITY_THRESHOLD
 * (default 16). Weak bands are reported in weakBands and downstream code
 * should fall back to identity for them.
 */
export function pairDNA(
  source: SourceDNA,
  target: TargetStructure,
): ImagePairProfile {
  if (source.bands.length !== target.bands.length) {
    throw new Error('source and target band counts differ');
  }

  const bands: BandPair[] = source.bands.map((sourceBand, i) => {
    const targetBand = target.bands[i];
    const viable =
      sourceBand.sampleCount >= VIABILITY_THRESHOLD &&
      targetBand.sampleCount >= VIABILITY_THRESHOLD;
    return { source: sourceBand, target: targetBand, viable };
  });

  const weakBands: number[] = [];
  for (let i = 0; i < bands.length; i++) {
    if (!bands[i].viable) weakBands.push(i);
  }

  return { source, target, bands, weakBands };
}
