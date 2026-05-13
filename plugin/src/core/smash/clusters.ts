// Pro Smash Engine — cluster adapter.
// Wraps core/palette.ts k-means output into ClusterStats, converting each
// centroid through core/perceptual/oklab.ts rather than transforming CIE Lab
// directly (RGB is the rendering target; no direct CIE Lab → Oklab path exists
// without going back through XYZ).

import { extractPalette } from '../palette';
import { srgbByteToOklab } from '../perceptual/oklab';
import type { ClusterStats } from './types';

const VALID_K = new Set([3, 5, 7]);

/**
 * Extracts clusters from an image's RGBA buffer.
 * Wraps core/palette.ts's k-means (CIE Lab) and converts each centroid to Oklab.
 * @param rgba interleaved RGBA bytes (length = width * height * 4)
 * @param width image width in pixels
 * @param height image height in pixels
 * @param k number of clusters (3, 5, or 7 — matches the shipped 3/5/7 toggle).
 *          Default 5. Throws on values outside this set.
 * @returns clusters sorted by weight (most-prevalent first, matching extractPalette).
 *          All clusters start unlocked, unanchored, with multiplier = 1.
 */
export function extractClusters(
  rgba: Uint8Array,
  width: number,
  height: number,
  k: 3 | 5 | 7 = 5,
): ClusterStats[] {
  if (!VALID_K.has(k)) {
    throw new Error(`k must be 3, 5, or 7; got ${k}`);
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
