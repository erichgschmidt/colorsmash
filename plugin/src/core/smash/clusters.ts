// Pro Smash Engine — cluster adapter.
// Wraps core/palette.ts k-means output into ClusterStats, converting each
// centroid through core/perceptual/oklab.ts rather than transforming CIE Lab
// directly (RGB is the rendering target; no direct CIE Lab → Oklab path exists
// without going back through XYZ).

import { extractPalette } from '../palette';
import { srgbByteToOklab } from '../perceptual/oklab';
import type { ClusterStats } from './types';

// Cluster count was historically constrained to {3, 5, 7} for the shipped
// palette UI. Pro's zone-routing path (§8.4f) needs finer granularity, so
// we widen the bounds to [3, 32]. Callers in the shipped Color Match flow
// still pass 3/5/7 and continue to work unchanged.
const MIN_K = 3;
const MAX_K = 32;

/**
 * Extracts clusters from an image's RGBA buffer.
 * Wraps core/palette.ts's k-means (CIE Lab) and converts each centroid to Oklab.
 * @param rgba interleaved RGBA bytes (length = width * height * 4)
 * @param width image width in pixels
 * @param height image height in pixels
 * @param k number of clusters. Default 5. Must be an integer in [3, 32]; values
 *          outside this range throw rather than silently clamping (callers
 *          should be explicit about the count they want).
 * @returns clusters sorted by weight (most-prevalent first, matching extractPalette).
 *          All clusters start unlocked, unanchored, with multiplier = 1.
 */
export function extractClusters(
  rgba: Uint8Array,
  width: number,
  height: number,
  k: number = 5,
): ClusterStats[] {
  if (!Number.isInteger(k) || k < MIN_K || k > MAX_K) {
    throw new Error(`k must be an integer in [${MIN_K}, ${MAX_K}]; got ${k}`);
  }

  const swatches = extractPalette(rgba, width, height, k);

  return swatches.map((swatch, index): ClusterStats => ({
    id: index,
    centroidOklab: srgbByteToOklab(swatch.r, swatch.g, swatch.b),
    rgb: [swatch.r, swatch.g, swatch.b],
    weight: swatch.weight,
    natural: swatch.weight,
    multiplier: 1,
    locked: false,
    anchor: false,
  }));
}

/**
 * Returns a new array where each cluster's weight is its natural prevalence
 * multiplied by the user-provided multiplier at the same index. Multipliers
 * length must match clusters length; throws otherwise. Original array unmutated.
 */
export function applyClusterMultipliers(
  clusters: ClusterStats[],
  multipliers: number[],
): ClusterStats[] {
  if (multipliers.length !== clusters.length) {
    throw new Error('multipliers length does not match clusters');
  }

  return clusters.map((cluster, index): ClusterStats => ({
    ...cluster,
    multiplier: multipliers[index],
    weight: cluster.natural * multipliers[index],
  }));
}

/**
 * Returns a new array with the cluster at `index` having `locked` set to the
 * provided value. Index out of range throws. Original array unmutated.
 */
export function lockCluster(
  clusters: ClusterStats[],
  index: number,
  locked: boolean,
): ClusterStats[] {
  if (index < 0 || index >= clusters.length) {
    throw new Error(`index ${index} out of range [0, ${clusters.length})`);
  }

  return clusters.map((cluster, i): ClusterStats =>
    i === index ? { ...cluster, locked } : cluster,
  );
}

/** Same shape as lockCluster, for the `anchor` flag. */
export function anchorCluster(
  clusters: ClusterStats[],
  index: number,
  anchor: boolean,
): ClusterStats[] {
  if (index < 0 || index >= clusters.length) {
    throw new Error(`index ${index} out of range [0, ${clusters.length})`);
  }

  return clusters.map((cluster, i): ClusterStats =>
    i === index ? { ...cluster, anchor } : cluster,
  );
}
