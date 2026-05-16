// Pro Smash Engine — per-band histogram-match transform.
// Smash = Match applied N times, once per luma band. reuses fitHistogramCurves
// from core/histogramMatch.ts so band==1 collapses to the existing global Match
// by construction. ACES gamut compression is applied at the output stage.

import { fitHistogramCurves } from '../histogramMatch';
import type { ChannelCurves } from '../histogramMatch';
import type { ImagePairProfile, SmashControls, SmashAudit, PixelFeatures, Vec3, AxisRatio } from './types';
import { createAudit, withTraitContribution, withBandUsed, finalize } from './audit';
import { acesGamutCompress } from './gamut';
import { perceptualLuma } from '../perceptual/luma';
import { srgbByteToOklab, oklabToSrgbByte } from '../perceptual/oklab';
import { buildCdfMatchLut, lookupCdfMatch, type CdfMatchLut } from './cdfMatch';
import { buildHueByLumaLut, lookupHueByLuma, type HueByLumaLut } from './hueByLuma';
import { buildConditionalCdf, type ConditionalCdf } from './conditionalCdf';
import { naturalBandWeights, reweightSourceByBands, isNeutralRatio } from './axisRatio';

// ────────── constants ──────────

/**
 * Minimum pixel samples required in a filtered band bucket before we attempt
 * to fit curves. Below this threshold the band falls back to identity.
 * Mirrors the same constant in profile.ts; kept local to avoid re-export
 * conflicts when both modules are re-exported from index.ts.
 */
const VIABILITY_THRESHOLD = 16;

/**
 * Exposed for tests so they can construct profiles with exactly threshold-1
 * samples to verify fallback behaviour.
 */
export const TRANSFORM_VIABILITY_THRESHOLD = VIABILITY_THRESHOLD;

// ────────── types ──────────

/** Result of histogram-matching one band's source pixels to its target pixels. */
export interface BandTransform {
  readonly bandIndex: number;
  /** ChannelCurves from core/histogramMatch.ts. Undefined when fellBack. */
  readonly curves: ChannelCurves | undefined;
  /**
   * True when the band wasn't viable (insufficient samples on either side)
   * or histogramMatch returned an identity curve.
   */
  readonly fellBack: boolean;
  /** Band luma center, used for soft band membership at apply time. */
  readonly center: number;
}

/** Output of smash() — the buildable engine state plus audit trace. */
export interface SmashEngineOutput {
  readonly profile: ImagePairProfile;
  readonly controls: SmashControls;
  readonly bandTransforms: readonly BandTransform[];
  readonly audit: SmashAudit;
  /**
   * Phase 3 — global CDF-match LUTs on the L and C dimensions of OkLCh. Built
   * from the full source/target feature distributions (not per-band). These
   * are the user's "compressor that forces target dimension distribution to
   * mirror source's" mechanic; applyTransform uses them as the source of
   * "smashed L" and "smashed C" instead of deriving from per-channel curves.
   * Null when no features were provided (degenerate input).
   */
  readonly lumaCdf: CdfMatchLut | null;
  readonly chromaCdf: CdfMatchLut | null;
  /**
   * Phase 4 — hue CDF match in the [-π, π] linear range. Pixels with chroma
   * below HUE_FILTER_CHROMA are excluded from both source and target arrays
   * (their hue angle is unstable and would skew the histogram). Linear CDF
   * match here works because the apply-side circular shortest-arc lerp
   * already handles wrap cases; the only cost is potential mild distortion
   * for distributions that span the full circle. Null when filtered samples
   * fall below the viability threshold or no features at all.
   */
  readonly hueCdf: CdfMatchLut | null;
  /**
   * Phase 4.5 — source-derived L → (avg a, avg b) lookup. applyTransform
   * uses its DIRECTION (atan2 of avg a, avg b) as the smashed hue when the
   * user's colorization.hueByLuma toggle is on (the default). Chroma still
   * comes from the per-dim chroma CDF, so toggle ON is ALWAYS at least as
   * colorful as toggle OFF.
   */
  readonly hueByLumaLut: HueByLumaLut | null;
  /**
   * Phase 4.5 — target's median chroma. Recorded on the engine output for
   * inspection / audit purposes; no longer used as an eligibility gate
   * (the Hue-by-L path now activates whenever the toggle is on, regardless
   * of how much chroma the target has).
   */
  readonly targetMedianChroma: number;
  /**
   * Phase 4.5b — source's median chroma. Used as the floor magnitude for
   * the liftNeutrals toggle: when a target pixel is near-neutral (Cin low),
   * the rank-mapped chroma CDF would return source's near-zero minimum
   * (faithful, but unhelpful — the user perceives the result as monochrome).
   * Flooring Csm at sourceMedianChroma weighted by neutralness gives near-
   * neutral pixels the source's TYPICAL chroma magnitude paired with
   * Hue-by-L's direction, producing broad colorization across L.
   */
  readonly sourceMedianChroma: number;
  /** Phase 4.5j — per-cluster Hue-by-L sub-LUTs for zone routing. See
   *  SmashCdfs for details. */
  readonly clusterSubLuts: readonly HueByLumaLut[];
  /** Phase 4.5j — per-cluster centroid L values. Parallel to clusterSubLuts. */
  readonly clusterLs: Float32Array;
  /** Phase 4.5j — per-cluster RGB centroids. Parallel to clusterSubLuts. */
  readonly clusterRgbs: readonly Vec3[];
  /** Phase 4.5l — permutation that maps sorted-by-L position → kmeans
   *  index. `clusterOrderByL[i]` is the kmeans index of the i-th cluster
   *  in ascending L order. Used by the soft-routing path to iterate
   *  clusters in L order without mutating any underlying array (other
   *  consumers like paletteSnap and distribution read clusters in their
   *  kmeans index order). */
  readonly clusterOrderByL: Int32Array;
  /** Phase 4.5l — sorted centroid Ls (ascending). Parallel to
   *  clusterOrderByL: `sortedClusterLs[i] === clusterLs[clusterOrderByL[i]]`. */
  readonly sortedClusterLs: Float32Array;
  /** Phase 4.5l — shifted zone boundaries between adjacent sorted clusters
   *  in ascending L order. Length = K-1. `zoneBoundaries[i]` is the L
   *  position separating sorted clusters i and i+1. Computed from natural
   *  midpoints + zoneEdgeShift via a sin-biased lerp toward uniform
   *  spacing (so inner boundaries move more than extreme ones). Empty
   *  array when K <= 1. */
  readonly zoneBoundaries: Float32Array;
  /** Phase 4.5k — per-cluster effective weights AFTER applying the
   *  `zoneRatio` power exponent. At zoneRatio=0 these match natural
   *  weights; negative ratios flatten; positive ratios exaggerate
   *  dominance. Used wherever cluster.weight participates (currently
   *  the `distribution` mechanic). Always normalized so Σ = 1.
   *  Parallel to clusterSubLuts / clusterLs. */
  readonly adjustedClusterWeights: Float32Array;
  /** Phase 4.5p — estimated median warmth of the engine's OUTPUT across
   *  a 3×3×3 RGB sampling grid (27 points). Used as the "neutral center"
   *  for the image-relative temperature mechanic. Computed at smash()
   *  time by sampling applyTransform with temperature=0 (everything else
   *  matching user controls), projecting each output onto the Oklab warm
   *  axis, and taking the median. Approximate but cheap (~27 samples is
   *  enough to anchor the median for typical natural images). */
  readonly estimatedOutputMedianWarmth: number;
  /** Phase 4.5t — 95th-percentile INPUT chroma of the target image, in Oklab
   *  C units. Normalization anchor for `temperatureCBias`'s weight ramp: a
   *  pixel at this chroma maps to cNorm = 1. p95 (not max) so specular/noise
   *  outliers don't compress the ramp. 0 on a fully-neutral target. */
  readonly targetChromaP95: number;
  /** Phase 4.5t — 95th-percentile INPUT saturation (S = C/L, clamped [0,2]
   *  as in features.ts) of the target image. Normalization anchor for
   *  `temperatureSBias`. */
  readonly targetSaturationP95: number;
  /** Phase 6 — natural per-band weights of the SOURCE's histogram for each
   *  source-ratio axis (Value / Hue / Chroma), binned into that axis's
   *  `bandCount` equal-width bands (default 5 when no control is set).
   *  Normalized to sum 1. The UI reads these to draw each ratio bar's
   *  segment widths at their unedited proportions. The `*BandColors` arrays
   *  are the mean source RGB of each band — the bar's segment fill colors,
   *  so a segment genuinely shows the source content it represents. */
  readonly valueRatioNaturalWeights: Float32Array;
  readonly valueRatioBandColors: readonly Vec3[];
  readonly hueRatioNaturalWeights: Float32Array;
  readonly hueRatioBandColors: readonly Vec3[];
  readonly chromaRatioNaturalWeights: Float32Array;
  readonly chromaRatioBandColors: readonly Vec3[];
  /** Phase 5 — per-L-bucket chroma + hue CDFs for the conditionalCdf
   *  mechanic. Built once per snap change. Null when no features were
   *  provided (degenerate input). Null entries inside it are sparse
   *  buckets that fall back to the global chromaCdf / hueCdf. */
  readonly conditionalCdf: ConditionalCdf | null;
}

/** Chroma below this is too low to give a stable hue angle (atan2 noise
 *  amplifies). Used to filter the hue CDF inputs. */
const HUE_FILTER_CHROMA = 0.02;

/** Pre-computed CDF LUTs (plus Phase 4.5 colorization data) that smash() can
 *  accept to skip the build cost. Computed once per (source, target) pair;
 *  reused across slider drags that only change controls, not the underlying
 *  feature data. */
export interface SmashCdfs {
  readonly lumaCdf: CdfMatchLut | null;
  readonly chromaCdf: CdfMatchLut | null;
  readonly hueCdf: CdfMatchLut | null;
  readonly hueByLumaLut: HueByLumaLut | null;
  readonly targetMedianChroma: number;
  readonly sourceMedianChroma: number;
  /** Phase 4.5j — per-cluster Hue-by-L sub-LUTs. Built by filtering source
   *  features to those nearest each cluster (Oklab Euclidean) and then
   *  running the same magnitude-preserving Hue-by-L builder on the subset.
   *  Indexed parallel to `clusterLs`; empty when no clusters are supplied
   *  to buildSmashCdfs. Used by applyTransform's zone-routing path so each
   *  cluster gets its own L→(a,b) curve, preserving intra-cluster color
   *  variation instead of collapsing to centroid. */
  readonly clusterSubLuts: readonly HueByLumaLut[];
  /** Phase 4.5j — per-cluster centroid L values (Oklab), one per entry in
   *  `clusterSubLuts`. Used at apply time to route an input pixel to its
   *  nearest cluster by 1D L distance. */
  readonly clusterLs: Float32Array;
  /** Phase 4.5j — per-cluster RGB centroid (matches `cluster.rgb`), parallel
   *  to `clusterSubLuts` / `clusterLs`. Used as the "no internal variation"
   *  endpoint of the detailRichness lerp inside the zone path. */
  readonly clusterRgbs: readonly Vec3[];
  /** Phase 4.5l — permutation: sorted-by-L position → kmeans index.
   *  See SmashEngineOutput.clusterOrderByL for details. */
  readonly clusterOrderByL: Int32Array;
  /** Phase 4.5l — sorted centroid Ls (ascending). */
  readonly sortedClusterLs: Float32Array;
  /** Phase 5 — per-L-bucket chroma + hue CDFs for the conditionalCdf
   *  mechanic. Null on degenerate (empty-feature) input. */
  readonly conditionalCdf: ConditionalCdf | null;
  /** Phase 6 — source / target Oklab L values, ascending. Kept so smash()
   *  can cheaply rebuild a reweighted lumaCdf for the Value source-ratio
   *  bar without re-deriving features. Empty on degenerate input. */
  readonly srcLumaSorted: Float32Array;
  readonly tgtLumaSorted: Float32Array;
  /** Phase 6 — source / target hue angles, chroma-filtered (same filter as
   *  the hue CDF) and ascending. For the Hue source-ratio bar. */
  readonly srcHueSorted: Float32Array;
  readonly tgtHueSorted: Float32Array;
  /** Phase 6 — source / target chroma values, ascending. For the Chroma
   *  source-ratio bar. */
  readonly srcChromaSorted: Float32Array;
  readonly tgtChromaSorted: Float32Array;
}

/** Build the L/C/h CDF LUTs from a source/target feature pair. Pure work,
 *  no controls, no audit — call once per snap change and cache the result.
 *  smash() will use the cached CDFs if passed via the precomputedCdfs arg.
 *
 *  When `sourceClusters` is supplied, additionally builds per-cluster
 *  Hue-by-L sub-LUTs for the zone-routing path (§8.4f). The clusters'
 *  centroids drive nearest-cluster assignment via Oklab Euclidean distance;
 *  features that land in each cluster are then fed through buildHueByLumaLut
 *  to produce the cluster's sub-LUT. Total cost: ~N_features × N_clusters
 *  assignment scan + N_clusters HueByLuma builds. ~10-30ms at 16k features
 *  and 16 clusters — fine for snap-cached recompute, not for slider drag. */
export function buildSmashCdfs(
  sourceFeatures: PixelFeatures[],
  targetFeatures: PixelFeatures[],
  sourceClusters?: readonly { readonly centroidOklab: Vec3; readonly rgb: Vec3 }[],
): SmashCdfs {
  if (sourceFeatures.length === 0 || targetFeatures.length === 0) {
    return {
      lumaCdf: null, chromaCdf: null, hueCdf: null,
      hueByLumaLut: null, targetMedianChroma: 0, sourceMedianChroma: 0,
      clusterSubLuts: [], clusterLs: new Float32Array(0), clusterRgbs: [],
      clusterOrderByL: new Int32Array(0), sortedClusterLs: new Float32Array(0),
      conditionalCdf: null,
      srcLumaSorted: new Float32Array(0), tgtLumaSorted: new Float32Array(0),
      srcHueSorted: new Float32Array(0), tgtHueSorted: new Float32Array(0),
      srcChromaSorted: new Float32Array(0), tgtChromaSorted: new Float32Array(0),
    };
  }
  const srcLuma = new Float32Array(sourceFeatures.length);
  const tgtLuma = new Float32Array(targetFeatures.length);
  const srcChroma = new Float32Array(sourceFeatures.length);
  const tgtChroma = new Float32Array(targetFeatures.length);
  for (let i = 0; i < sourceFeatures.length; i++) {
    srcLuma[i] = sourceFeatures[i].luma;
    srcChroma[i] = sourceFeatures[i].chroma;
  }
  for (let i = 0; i < targetFeatures.length; i++) {
    tgtLuma[i] = targetFeatures[i].luma;
    tgtChroma[i] = targetFeatures[i].chroma;
  }
  const lumaCdf = buildCdfMatchLut(srcLuma, tgtLuma);
  const chromaCdf = buildCdfMatchLut(srcChroma, tgtChroma);

  // Hue: chroma-filter both sides, then build linear-on-[-π,π] CDF.
  const srcHueArr: number[] = [];
  const tgtHueArr: number[] = [];
  for (const f of sourceFeatures) {
    if (f.chroma >= HUE_FILTER_CHROMA) srcHueArr.push(f.hueAngle);
  }
  for (const f of targetFeatures) {
    if (f.chroma >= HUE_FILTER_CHROMA) tgtHueArr.push(f.hueAngle);
  }
  let hueCdf: CdfMatchLut | null = null;
  if (srcHueArr.length >= VIABILITY_THRESHOLD && tgtHueArr.length >= VIABILITY_THRESHOLD) {
    hueCdf = buildCdfMatchLut(Float32Array.from(srcHueArr), Float32Array.from(tgtHueArr));
  }

  // Phase 4.5 — colorization data. hueByLumaLut is the source-only L→(a,b)
  // lookup. targetMedianChroma is recorded for inspection (was previously
  // an eligibility gate). sourceMedianChroma is the floor used by the
  // liftNeutrals toggle to keep near-neutral target pixels from collapsing
  // to source's minimum chroma. Median (vs mean) is the stable estimator
  // for typically right-skewed chroma distributions.
  const hueByLumaLut = buildHueByLumaLut(sourceFeatures);
  const tgtChromaSorted = tgtChroma.slice().sort();
  const srcChromaSorted = srcChroma.slice().sort();
  const targetMedianChroma = tgtChromaSorted[Math.floor(tgtChromaSorted.length / 2)] ?? 0;
  const sourceMedianChroma = srcChromaSorted[Math.floor(srcChromaSorted.length / 2)] ?? 0;

  // Phase 4.5j — per-cluster sub-LUTs for zone routing. For each cluster,
  // collect the source features whose nearest centroid (by Oklab Euclidean)
  // is this cluster, then build a Hue-by-L sub-LUT from that subset. The
  // sub-LUT captures the cluster's INTERNAL L→(a,b) variation, which the
  // engine then routes target pixels to via the zone-influence path.
  let clusterSubLuts: HueByLumaLut[] = [];
  let clusterLs: Float32Array = new Float32Array(0);
  let clusterRgbs: Vec3[] = [];
  if (sourceClusters && sourceClusters.length > 0) {
    const K = sourceClusters.length;
    const cLs = new Float32Array(K);
    const cAs = new Float32Array(K);
    const cBs = new Float32Array(K);
    clusterRgbs = new Array<Vec3>(K);
    for (let k = 0; k < K; k++) {
      const c = sourceClusters[k];
      cLs[k] = c.centroidOklab[0];
      cAs[k] = c.centroidOklab[1];
      cBs[k] = c.centroidOklab[2];
      clusterRgbs[k] = c.rgb;
    }
    // Bucket features by nearest centroid in Oklab space.
    const buckets: PixelFeatures[][] = new Array(K);
    for (let k = 0; k < K; k++) buckets[k] = [];
    for (let i = 0; i < sourceFeatures.length; i++) {
      const f = sourceFeatures[i];
      const [fL, fA, fB] = f.oklab;
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < K; k++) {
        const dL = fL - cLs[k];
        const dA = fA - cAs[k];
        const dB = fB - cBs[k];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      buckets[bestK].push(f);
    }
    clusterSubLuts = buckets.map((bucket) => buildHueByLumaLut(bucket));
    clusterLs = cLs;
  }

  // Phase 4.5l — sort permutation. Need ascending-by-L iteration order for
  // zone-routing boundary math (4.5l). Build a permutation index instead
  // of resorting the source arrays so downstream consumers (paletteSnap,
  // distribution) that read clusters in kmeans index order are unaffected.
  let clusterOrderByL: Int32Array;
  let sortedClusterLs: Float32Array;
  if (clusterLs.length > 0) {
    const K = clusterLs.length;
    const indices = new Array<number>(K);
    for (let i = 0; i < K; i++) indices[i] = i;
    indices.sort((a, b) => clusterLs[a] - clusterLs[b]);
    clusterOrderByL = Int32Array.from(indices);
    sortedClusterLs = new Float32Array(K);
    for (let i = 0; i < K; i++) sortedClusterLs[i] = clusterLs[clusterOrderByL[i]];
  } else {
    clusterOrderByL = new Int32Array(0);
    sortedClusterLs = new Float32Array(0);
  }

  // Phase 5 — per-L-bucket chroma + hue CDFs. Built from the full feature
  // pair (not the cluster subsets) using the same viability + hue-filter
  // thresholds as the global CDFs above.
  const conditionalCdf = buildConditionalCdf(
    sourceFeatures, targetFeatures, VIABILITY_THRESHOLD, HUE_FILTER_CHROMA);

  // Phase 6 — sorted axis arrays, kept for the source-ratio bars' per-drag
  // CDF rebuilds (reweight + buildCdfMatchLut, ~1-3ms each). Hue uses the
  // chroma-filtered arrays (same population the hue CDF was built from).
  const srcLumaSorted = srcLuma.slice().sort();
  const tgtLumaSorted = tgtLuma.slice().sort();
  const srcHueSorted = Float32Array.from(srcHueArr).sort();
  const tgtHueSorted = Float32Array.from(tgtHueArr).sort();

  return {
    lumaCdf, chromaCdf, hueCdf, hueByLumaLut,
    targetMedianChroma, sourceMedianChroma,
    clusterSubLuts, clusterLs, clusterRgbs,
    clusterOrderByL, sortedClusterLs,
    conditionalCdf,
    srcLumaSorted, tgtLumaSorted,
    srcHueSorted, tgtHueSorted,
    srcChromaSorted, tgtChromaSorted,
  };
}

// ────────── defaults ──────────

/**
 * Default SmashControls for Phase 1: global full-strength match over 3 value
 * bands, no per-trait slider adjustments, no outlier guard.
 */
export const DEFAULT_SMASH_CONTROLS: SmashControls = {
  global: 1,
  traits: {
    value: 1,
    hue: 1,
    saturation: 1,
    chroma: 1,
    neutral: 0.5,
    accent: 0,
  },
  compression: 0,
  expansion: 0,
  outlierGuard: 0.5,
  bandSoftness: 0.15,
  bandCount: 3,
  bandAxis: 'value',
  colorization: {
    // Phase 4.5: hueByLuma enabled by default — smashed hue follows source's
    // L→(a,b) direction at every L.
    hueByLuma: true,
    // Phase 4.5b: liftNeutrals enabled by default — near-neutral target
    // pixels get a chroma floor at source's median chroma so shadows in a
    // grayscale target colorize broadly instead of staying monochrome.
    liftNeutrals: true,
    // Phase 4.5g: proportionMatch defaults to 1.0 (tight) — lift floor uses
    // source's chroma at the smashed L, preserving source's L→C structure
    // and the output's color/neutral proportions.
    proportionMatch: 1.0,
    // Phase 4.5h: posterize defaults to 0 (off) — output is the engine's
    // smooth result. Users dial it up for the L-banded cluster-snap look.
    posterize: 0,
    // Phase 4.5i: distribution defaults to 0 (off) — smooth alternative
    // to posterize. Users dial it up for joint-mode-aware smash without
    // banding.
    distribution: 0,
    // Phase 4.5j: zoneInfluence + detailRichness default to 0 (off) —
    // zone routing replaces nothing by default. Users dial up to engage
    // per-cluster Hue-by-L sub-LUTs.
    zoneInfluence: 0,
    detailRichness: 1,
    // Phase 4.5k: zoneRatio defaults to 0 — natural cluster weights
    // preserved as the source extracted them.
    zoneRatio: 0,
    // Phase 4.5m: temperature defaults to 0 — no warm/cool shift.
    temperature: 0,
    // Phase 4.5p: temperatureSensitivity defaults to 0.5 — linear
    // exponent (no sharpening or softening of the median split).
    temperatureSensitivity: 0.5,
    // Phase 4.5l: target-side zone routing controls. Both default to 0
    // — boundaries at natural cluster midpoints with hard pick (matches
    // Phase 4.5j behavior byte-for-byte).
    zoneEdgeSoftness: 0,
    zoneEdgeShift: 0,
    // Phase 4.5r: temperatureLBias defaults to 0 — uniform across all
    // L values (matches Phase 4.5p behavior).
    temperatureLBias: 0,
    // Phase 4.5t: temperatureCBias / temperatureSBias default to 0 —
    // uniform across all chroma / saturation, temperature unrestricted.
    temperatureCBias: 0,
    temperatureSBias: 0,
    // Phase 5: conditionalCdf defaults to 0 — global chroma / hue CDFs
    // only, byte-identical to the Phase 4 path. Users dial it up to
    // match chroma + hue against per-L-bucket source distributions.
    conditionalCdf: 0,
  },
  // Phase 4.5c: passes = 1 by default (one transform per pixel). Users can
  // dial up to 2 or 3 to bake the compounded "multi-pass" look into the LUT.
  passes: 1,
};

// ────────── internal helpers ──────────

/**
 * Build an RGBA Uint8Array suitable for fitHistogramCurves from an array of
 * PixelFeatures. Each feature's rgb Vec3 (0..255 ints) becomes one opaque
 * pixel (alpha=255). Returns null when the feature list is empty.
 */
function featuresToRgba(features: readonly PixelFeatures[]): Uint8Array | null {
  const n = features.length;
  if (n === 0) return null;
  const buf = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = features[i].rgb;
    buf[i * 4]     = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

// (lerp helper removed in Phase 2b — output is reconstructed in OkLCh
// rather than RGB-mixed, so the only lerps are inline component deltas.)

/**
 * Phase 6 — mean source RGB per band, for a source-ratio bar's segment
 * fill colors. Bins `features` into `bandCount` equal-width bands over
 * [lMin, lMax] by `axisOf`, optionally filtered, and averages each band's
 * RGB. Empty bands fall back to a neutral gray ramp so the bar still draws.
 */
function computeBandColors(
  features: readonly PixelFeatures[],
  axisOf: (f: PixelFeatures) => number,
  filter: ((f: PixelFeatures) => boolean) | null,
  lMin: number,
  lMax: number,
  bandCount: number,
): Vec3[] {
  const sumR = new Float64Array(bandCount);
  const sumG = new Float64Array(bandCount);
  const sumB = new Float64Array(bandCount);
  const cnt = new Int32Array(bandCount);
  const range = lMax - lMin;
  if (range > 0) {
    for (const f of features) {
      if (filter && !filter(f)) continue;
      const b = Math.min(bandCount - 1, Math.max(0,
        Math.floor(((axisOf(f) - lMin) / range) * bandCount)));
      sumR[b] += f.rgb[0];
      sumG[b] += f.rgb[1];
      sumB[b] += f.rgb[2];
      cnt[b]++;
    }
  }
  const out: Vec3[] = new Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    if (cnt[b] > 0) {
      out[b] = [sumR[b] / cnt[b], sumG[b] / cnt[b], sumB[b] / cnt[b]];
    } else {
      const g = Math.round(((b + 0.5) / bandCount) * 255);
      out[b] = [g, g, g];
    }
  }
  return out;
}

/** Phase 4.5t — p-th percentile of a numeric array (p in [0,1]). Used for
 *  the temperature C/S bias normalization anchors. p95 (not max) rejects
 *  single-pixel specular / noise outliers. Returns 0 for an empty array. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/** Resolved state for one source-ratio axis: the (possibly reweighted) CDF
 *  plus the bar's natural per-band weights and segment colors. */
interface ResolvedAxisRatio {
  readonly cdf: CdfMatchLut | null;
  readonly naturalWeights: Float32Array;
  readonly bandColors: Vec3[];
}

/**
 * Phase 6 — resolve one source-ratio axis. Always computes the natural
 * per-band weights + colors (for the UI); rebuilds the axis CDF from the
 * reweighted source only when the ratio is present, non-neutral, and the
 * data is viable — otherwise the base CDF passes through byte-for-byte.
 */
function resolveAxisRatio(
  ratio: AxisRatio | undefined,
  srcSorted: Float32Array,
  tgtSorted: Float32Array,
  baseCdf: CdfMatchLut | null,
  features: readonly PixelFeatures[],
  axisOf: (f: PixelFeatures) => number,
  filter: ((f: PixelFeatures) => boolean) | null,
): ResolvedAxisRatio {
  const bandCount =
    ratio && Number.isInteger(ratio.bandCount) && ratio.bandCount >= 2
      ? ratio.bandCount
      : 5;
  const naturalWeights = naturalBandWeights(srcSorted, bandCount);
  const lMin = srcSorted.length > 0 ? srcSorted[0] : 0;
  const lMax = srcSorted.length > 0 ? srcSorted[srcSorted.length - 1] : 1;
  const bandColors = computeBandColors(features, axisOf, filter, lMin, lMax, bandCount);
  let cdf = baseCdf;
  if (
    ratio &&
    baseCdf &&
    srcSorted.length > 0 &&
    tgtSorted.length > 0 &&
    !isNeutralRatio(ratio.multipliers, bandCount)
  ) {
    const reweighted = reweightSourceByBands(srcSorted, bandCount, ratio.multipliers);
    cdf = buildCdfMatchLut(reweighted, tgtSorted);
  }
  return { cdf, naturalWeights, bandColors };
}

// ────────── public API ──────────

/**
 * Build a Smash transform by fitting per-band histogram-match curves.
 * Phase 1 reuses core/histogramMatch.ts on per-band slices of features.
 *
 * @param sourceFeatures features from the source image (from extractFeatures)
 * @param targetFeatures features from the target image
 * @param profile        pairing of source/target bands (from pairDNA)
 * @param controls       optional; defaults to DEFAULT_SMASH_CONTROLS
 * @returns SmashEngineOutput with per-band curves + decision-trace audit
 */
export function smash(
  sourceFeatures: PixelFeatures[],
  targetFeatures: PixelFeatures[],
  profile: ImagePairProfile,
  controls?: SmashControls,
  /** Optional pre-computed CDFs from buildSmashCdfs(). When provided, smash()
   *  skips the per-call CDF rebuild — turns 200-400ms of work into ~5ms.
   *  Callers that re-invoke smash() many times for the same source/target
   *  (slider drags) should compute CDFs once and pass them on every call. */
  precomputedCdfs?: SmashCdfs,
): SmashEngineOutput {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const c = controls ?? DEFAULT_SMASH_CONTROLS;
  let audit = createAudit();

  const bandTransforms: BandTransform[] = [];

  for (let i = 0; i < profile.bands.length; i++) {
    const pair = profile.bands[i];

    // Non-viable bands (flagged by pairDNA) fall back immediately.
    if (!pair.viable) {
      audit = withBandUsed(audit, i, true);
      bandTransforms.push({
        bandIndex: i,
        curves: undefined,
        fellBack: true,
        center: pair.source.center,
      });
      continue;
    }

    // Filter source and target features to those whose luma falls within this
    // band's bounds. The BandStats bounds are in Oklab L space (0..1).
    const [lo, hi] = pair.source.bounds;
    const [tlo, thi] = pair.target.bounds;

    const srcFiltered = sourceFeatures.filter(f => f.luma >= lo && f.luma <= hi);
    const tgtFiltered = targetFeatures.filter(f => f.luma >= tlo && f.luma <= thi);

    // Sanity check: require at least VIABILITY_THRESHOLD samples on both sides.
    if (srcFiltered.length < VIABILITY_THRESHOLD || tgtFiltered.length < VIABILITY_THRESHOLD) {
      audit = withBandUsed(audit, i, true);
      bandTransforms.push({
        bandIndex: i,
        curves: undefined,
        fellBack: true,
        center: pair.source.center,
      });
      continue;
    }

    // Build RGBA byte arrays for fitHistogramCurves (alpha=255, fully opaque).
    const srcRgba = featuresToRgba(srcFiltered)!;
    const tgtRgba = featuresToRgba(tgtFiltered)!;

    // Fit per-channel histogram-match curves using core/histogramMatch.ts.
    const curves = fitHistogramCurves(srcRgba, tgtRgba);

    audit = withBandUsed(audit, i, false);
    bandTransforms.push({
      bandIndex: i,
      curves,
      fellBack: false,
      center: pair.source.center,
    });
  }

  // Phase 3+4 — global CDF-match LUTs on L, C, h. Use the caller-provided
  // precomputed set when available (slider-drag fast path: ~5ms instead of
  // ~200-400ms per call). buildSmashCdfs is the canonical builder — call
  // it once per snap change and cache the result.
  const cdfs = precomputedCdfs ?? buildSmashCdfs(sourceFeatures, targetFeatures, profile.source.clusters);

  // Phase 6 — source ratios. For Value / Hue / Chroma the user reweights the
  // SOURCE's histogram for that axis BEFORE the CDF match, so the target's
  // distribution follows the edited source shape. Each axis's CDF is rebuilt
  // only when its ratio is non-neutral — neutral is byte-exact. The natural
  // per-band weights + mean band colors are always computed so the UI can
  // draw the bars even before the user touches them.
  const valueAxis = resolveAxisRatio(
    c.colorization?.valueRatio, cdfs.srcLumaSorted, cdfs.tgtLumaSorted,
    cdfs.lumaCdf, sourceFeatures, (f) => f.luma, null);
  const hueAxis = resolveAxisRatio(
    c.colorization?.hueRatio, cdfs.srcHueSorted, cdfs.tgtHueSorted,
    cdfs.hueCdf, sourceFeatures, (f) => f.hueAngle,
    (f) => f.chroma >= HUE_FILTER_CHROMA);
  const chromaAxis = resolveAxisRatio(
    c.colorization?.chromaRatio, cdfs.srcChromaSorted, cdfs.tgtChromaSorted,
    cdfs.chromaCdf, sourceFeatures, (f) => f.chroma, null);

  let lumaCdf = valueAxis.cdf;
  const chromaCdf = chromaAxis.cdf;
  const hueCdf = hueAxis.cdf;
  const valueRatioNaturalWeights = valueAxis.naturalWeights;
  const valueRatioBandColors = valueAxis.bandColors;
  const hueRatioNaturalWeights = hueAxis.naturalWeights;
  const hueRatioBandColors = hueAxis.bandColors;
  const chromaRatioNaturalWeights = chromaAxis.naturalWeights;
  const chromaRatioBandColors = chromaAxis.bandColors;
  const hueByLumaLut = cdfs.hueByLumaLut;
  const targetMedianChroma = cdfs.targetMedianChroma;
  const sourceMedianChroma = cdfs.sourceMedianChroma;
  const clusterSubLuts = cdfs.clusterSubLuts;
  const clusterLs = cdfs.clusterLs;
  const clusterRgbs = cdfs.clusterRgbs;
  const clusterOrderByL = cdfs.clusterOrderByL;
  const sortedClusterLs = cdfs.sortedClusterLs;
  const conditionalCdf = cdfs.conditionalCdf;

  // Phase 4.5l — Compute shifted zone boundaries from sorted cluster Ls
  // + zoneEdgeShift. K-1 boundaries between adjacent sorted clusters,
  // each shifted toward 0 (negative t) or 1 (positive t) using a
  // sin-shaped bias that moves inner boundaries more than outer ones —
  // keeps the extreme zones from collapsing to zero width even at ±1.
  // Re-runs per smash() call (sub-ms cost).
  const rawZoneEdgeShift = c.colorization?.zoneEdgeShift;
  const zoneEdgeShift =
    typeof rawZoneEdgeShift === 'number' && Number.isFinite(rawZoneEdgeShift)
      ? Math.max(-1, Math.min(1, rawZoneEdgeShift))
      : 0;
  const Kclusters = sortedClusterLs.length;
  const zoneBoundaries = new Float32Array(Math.max(0, Kclusters - 1));
  for (let i = 0; i < Kclusters - 1; i++) {
    const natural = (sortedClusterLs[i] + sortedClusterLs[i + 1]) * 0.5;
    if (zoneEdgeShift === 0) {
      zoneBoundaries[i] = natural;
    } else {
      // sin-biased lerp toward L=0 or L=1, scaled by |t| × (distance to
      // target endpoint). Inner boundaries (mid-range) move more than
      // outer boundaries (near L=0 or L=1).
      const bias = Math.sin(Math.PI * (i + 1) / Kclusters);
      if (zoneEdgeShift > 0) {
        zoneBoundaries[i] = natural + zoneEdgeShift * (1 - natural) * bias;
      } else {
        // zoneEdgeShift is negative — moves boundary toward 0
        zoneBoundaries[i] = natural + zoneEdgeShift * natural * bias;
      }
    }
  }

  // Phase 4.5k — adjusted cluster weights. Apply zoneRatio as a power
  // exponent on the natural weights, then normalize. Cheap (K ≤ 32 pow
  // ops + normalize), and lives on the engine output so per-pixel
  // mechanics that consume cluster weights (today: `distribution`)
  // don't have to recompute. Re-runs whenever smash() runs, which is
  // every slider tick — fine since the cost is sub-millisecond.
  const rawZoneRatio = c.colorization?.zoneRatio;
  const zoneRatio =
    typeof rawZoneRatio === 'number' && Number.isFinite(rawZoneRatio)
      ? Math.max(-1, Math.min(1, rawZoneRatio))
      : 0;
  const K = profile.source.clusters.length;
  const adjustedClusterWeights = new Float32Array(K);
  // Phase 4.5s — per-cluster user multipliers from the Smash ratio bar.
  // Read index-by-index; any missing/invalid entry falls back to 1.0 so a
  // stale-length array (e.g. mid-render after a clusterCount change)
  // degrades gracefully instead of corrupting the weight distribution.
  const rawMultipliers = c.colorization?.clusterMultipliers;
  const clusterMultiplierAt = (i: number): number => {
    if (!Array.isArray(rawMultipliers)) return 1;
    const m = rawMultipliers[i];
    return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : 1;
  };
  if (K > 0) {
    // Map zoneRatio ∈ [-1, +1] → exponent k ∈ [1/e, e] via exp(x). This
    // gives a symmetric "tighten / loosen" feel — −1 fully flattens
    // (still some variance because weights are nonzero), +1 sharply
    // amplifies dominance.
    const k = Math.exp(zoneRatio);
    let sum = 0;
    for (let i = 0; i < K; i++) {
      // Natural prevalence × user multiplier, THEN the zoneRatio exponent.
      // Multiplier first so the exponent acts on the user-adjusted ratio.
      const w = profile.source.clusters[i].weight * clusterMultiplierAt(i);
      const adj = w > 0 ? Math.pow(w, k) : 0;
      adjustedClusterWeights[i] = adj;
      sum += adj;
    }
    if (sum > 0) {
      for (let i = 0; i < K; i++) adjustedClusterWeights[i] /= sum;
    } else {
      // Degenerate: all weights zero (shouldn't happen). Fall back to
      // uniform so downstream mechanics don't divide by zero.
      const uniform = 1 / K;
      for (let i = 0; i < K; i++) adjustedClusterWeights[i] = uniform;
    }
  }

  // Record trait contributions from controls. The trait values can exceed 1
  // (Phase 3 oversample), so the audit stores raw products without clamping.
  const traits = c.traits;
  const g = c.global;
  audit = withTraitContribution(audit, 'value',      traits.value      * g);
  audit = withTraitContribution(audit, 'hue',        traits.hue        * g);
  audit = withTraitContribution(audit, 'saturation', traits.saturation * g);
  audit = withTraitContribution(audit, 'chroma',     traits.chroma     * g);
  audit = withTraitContribution(audit, 'neutral',    traits.neutral    * g);
  audit = withTraitContribution(audit, 'accent',     traits.accent     * g);

  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
  audit = finalize(audit, elapsed);

  // Phase 4.5p — estimate output warmth median. Build a partial engine
  // output with temperature explicitly forced to 0 so the sampled
  // applyTransform call doesn't read back its own (yet-unset) median.
  // Sample 27 RGB grid points (3×3×3), project each output onto the
  // Oklab warm axis, take the median. This becomes the "neutral center"
  // the image-relative temperature mechanic operates around.
  const tempZeroControls: SmashControls = {
    ...c,
    colorization: { ...(c.colorization ?? {}), temperature: 0 },
  };
  // Phase 4.5t — target chroma / saturation p95: normalization anchors for
  // the temperature C/S bias weight ramps. Computed once from the target
  // features (already extracted). Frozen on the engine output before the
  // bake samples anything, so the C/S modulators stay LUT-bakable.
  const targetChromaP95 = percentile(targetFeatures.map((f) => f.chroma), 0.95);
  const targetSaturationP95 = percentile(targetFeatures.map((f) => f.saturation), 0.95);
  const partialForSampling: SmashEngineOutput = {
    profile, controls: tempZeroControls, bandTransforms, audit,
    lumaCdf, chromaCdf, hueCdf,
    hueByLumaLut, targetMedianChroma, sourceMedianChroma,
    clusterSubLuts, clusterLs, clusterRgbs,
    clusterOrderByL, sortedClusterLs, zoneBoundaries,
    adjustedClusterWeights,
    estimatedOutputMedianWarmth: 0, // placeholder; sampling ignores this field
    targetChromaP95, targetSaturationP95,
    valueRatioNaturalWeights, valueRatioBandColors,
    hueRatioNaturalWeights, hueRatioBandColors,
    chromaRatioNaturalWeights, chromaRatioBandColors,
    conditionalCdf,
  };
  const WARM_A = 0.82;
  const WARM_B = 0.57;
  const samplePoints: readonly number[] = [16, 96, 176, 240];
  const warmthSamples: number[] = [];
  for (const r of samplePoints) {
    for (const g of samplePoints) {
      for (const b of samplePoints) {
        const [or, og, ob] = applyTransform(partialForSampling, r, g, b);
        const [, ao, bo] = srgbByteToOklab(or, og, ob);
        warmthSamples.push(ao * WARM_A + bo * WARM_B);
      }
    }
  }
  warmthSamples.sort((x, y) => x - y);
  const estimatedOutputMedianWarmth =
    warmthSamples[Math.floor(warmthSamples.length / 2)] ?? 0;

  return {
    profile, controls: c, bandTransforms, audit,
    lumaCdf, chromaCdf, hueCdf,
    hueByLumaLut, targetMedianChroma, sourceMedianChroma,
    clusterSubLuts, clusterLs, clusterRgbs,
    clusterOrderByL, sortedClusterLs, zoneBoundaries,
    adjustedClusterWeights,
    estimatedOutputMedianWarmth,
    targetChromaP95, targetSaturationP95,
    valueRatioNaturalWeights, valueRatioBandColors,
    hueRatioNaturalWeights, hueRatioBandColors,
    chromaRatioNaturalWeights, chromaRatioBandColors,
    conditionalCdf,
  };
}

/**
 * Apply a Smash transform N times to a single sRGB byte triple, where N is
 * `controls.passes` (default 1, clamped to [1, 4]). Each pass re-runs the
 * full transform on the previous pass's output. Compounding behavior: each
 * iteration pushes chroma further up source's CDF because the input's
 * chroma distribution shifts after pass 1.
 *
 * Fractional passes (e.g., 1.5, 2.3) are linearly interpolated between
 * consecutive integer-pass outputs:
 *
 *   passes = floor(N) + frac    (where 0 ≤ frac < 1)
 *   floor_result = applyTransform iterated floor(N) times
 *   ceil_result  = applyTransform once more on floor_result
 *   output       = floor_result + (ceil_result − floor_result) × frac
 *
 * Equivalent to applying the LUT layer N times in succession in PS for
 * integer N, with smooth interpolation between integer passes for finer
 * control. The slider's "1.5×" lands halfway between single-apply and
 * double-apply behavior.
 *
 * Identity for empty input: if all band transforms fellBack, the input pixel
 * is returned unchanged regardless of how many passes are requested.
 */
export function applyTransform(
  out: SmashEngineOutput,
  r: number,
  g: number,
  b: number,
): Vec3 {
  const rawPasses = out.controls.passes ?? 1;
  // Clamp to [1, 4] — engine ceiling. UI exposes 1.0–3.0 by default, but
  // direct callers (tests, future scripts) can push to 4.
  const passesFloat = Math.max(1, Math.min(4, rawPasses));
  const N_floor = Math.floor(passesFloat);
  const frac = passesFloat - N_floor;

  // Run N_floor full passes. Intermediate values stay byte-quantized
  // because applyTransformOnePass returns rounded sRGB bytes, so the
  // input to each subsequent pass is well-defined.
  let cr = r;
  let cg = g;
  let cb = b;
  for (let i = 0; i < N_floor; i++) {
    const [nr, ng, nb] = applyTransformOnePass(out, cr, cg, cb);
    cr = nr; cg = ng; cb = nb;
  }

  // Fractional remainder: run one more pass and lerp between the floor
  // result (cr/cg/cb) and the ceiling result by `frac`. Skipped at the
  // engine clamp ceiling (passesFloat == 4) where there's no headroom
  // for another pass.
  if (frac > 0 && N_floor < 4) {
    const [nr, ng, nb] = applyTransformOnePass(out, cr, cg, cb);
    return [
      Math.max(0, Math.min(255, Math.round(cr + (nr - cr) * frac))),
      Math.max(0, Math.min(255, Math.round(cg + (ng - cg) * frac))),
      Math.max(0, Math.min(255, Math.round(cb + (nb - cb) * frac))),
    ];
  }

  return [cr, cg, cb];
}

/**
 * Phase 5 — conditional chroma lookup. Maps `Lsm` to a fractional L-bucket
 * coordinate, looks the chroma sub-CDF up in the two straddling buckets, and
 * linearly blends the results so output is continuous across bucket edges.
 * Sparse buckets (null sub-CDF) fall back to `globalMag`, so a partially or
 * fully sparse ConditionalCdf degrades smoothly to the global-CDF value.
 */
function condChromaLookup(
  cc: ConditionalCdf,
  Lsm: number,
  Cin: number,
  globalMag: number,
): number {
  if (cc.lMax <= cc.lMin || cc.buckets < 2) return globalMag;
  const clampedL = Math.max(cc.lMin, Math.min(cc.lMax, Lsm));
  const t = ((clampedL - cc.lMin) / (cc.lMax - cc.lMin)) * (cc.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, cc.buckets - 1);
  const frac = t - k0;
  const lut0 = cc.chroma[k0];
  const lut1 = cc.chroma[k1];
  const v0 = lut0 ? Math.max(0, lookupCdfMatch(lut0, Cin)) : globalMag;
  const v1 = lut1 ? Math.max(0, lookupCdfMatch(lut1, Cin)) : globalMag;
  return v0 + (v1 - v0) * frac;
}

/**
 * Phase 5 — conditional hue lookup. Same bucket interpolation as
 * `condChromaLookup`, but the inter-bucket blend uses the engine's circular
 * shortest-arc convention so two buckets straddling the ±π wrap blend
 * correctly. Sparse buckets fall back to `globalHue`.
 */
function condHueLookup(
  cc: ConditionalCdf,
  Lsm: number,
  hin: number,
  globalHue: number,
): number {
  if (cc.lMax <= cc.lMin || cc.buckets < 2) return globalHue;
  const clampedL = Math.max(cc.lMin, Math.min(cc.lMax, Lsm));
  const t = ((clampedL - cc.lMin) / (cc.lMax - cc.lMin)) * (cc.buckets - 1);
  const k0 = Math.floor(t);
  const k1 = Math.min(k0 + 1, cc.buckets - 1);
  const frac = t - k0;
  const lut0 = cc.hue[k0];
  const lut1 = cc.hue[k1];
  const h0 = lut0 ? lookupCdfMatch(lut0, hin) : globalHue;
  const h1 = lut1 ? lookupCdfMatch(lut1, hin) : globalHue;
  let dh = h1 - h0;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  return h0 + dh * frac;
}

/**
 * Single-pass Smash transform. Soft band membership: the pixel's perceptual
 * luma is used to interpolate between adjacent band curves with a Gaussian
 * falloff scaled by controls.bandSoftness. The blended result is then
 * ACES-gamut-compressed at full strength and returned as bytes.
 *
 * Not exported — callers use applyTransform() which honors `controls.passes`.
 */
function applyTransformOnePass(
  out: SmashEngineOutput,
  r: number,
  g: number,
  b: number,
): Vec3 {
  const { bandTransforms, controls } = out;

  // Degenerate: no bands — identity.
  if (bandTransforms.length === 0) {
    return [r, g, b];
  }

  // Compute perceptual luma for soft band membership (Oklab L).
  const luma = perceptualLuma(r, g, b);
  const sigma = Math.max(0.05, controls.bandSoftness);

  // Compute Gaussian weights for each band, then normalize.
  const rawWeights = bandTransforms.map(bt => {
    const diff = (luma - bt.center) / sigma;
    return Math.exp(-(diff * diff));
  });

  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const weights = weightSum > 0
    ? rawWeights.map(w => w / weightSum)
    : rawWeights.map(() => 1 / bandTransforms.length);

  // For each band, apply its curves (or identity) and accumulate weighted sum.
  let outR = 0;
  let outG = 0;
  let outB = 0;

  for (let i = 0; i < bandTransforms.length; i++) {
    const bt = bandTransforms[i];
    const w = weights[i];
    if (w === 0) continue;

    if (bt.fellBack || bt.curves === undefined) {
      // Identity contribution from this band.
      outR += r * w;
      outG += g * w;
      outB += b * w;
    } else {
      // Apply the per-channel LUT. Each lookup table maps 0..255 → 0..255.
      const ri = Math.max(0, Math.min(255, Math.round(r)));
      const gi = Math.max(0, Math.min(255, Math.round(g)));
      const bi = Math.max(0, Math.min(255, Math.round(b)));
      outR += bt.curves.r[ri] * w;
      outG += bt.curves.g[gi] * w;
      outB += bt.curves.b[bi] * w;
    }
  }

  // ACES gamut compress the blended result (operates in [0,1] linear space).
  const compressed = acesGamutCompress(
    [outR / 255, outG / 255, outB / 255],
    1,
  );

  // Quantize back to bytes.
  const smashR = Math.max(0, Math.min(255, Math.round(compressed[0] * 255)));
  const smashG = Math.max(0, Math.min(255, Math.round(compressed[1] * 255)));
  const smashB = Math.max(0, Math.min(255, Math.round(compressed[2] * 255)));

  // ───── Phase 3 + Phase 4 — CDF histogram-match in perceptual space ─────
  //
  // For L, C, and h dimensions: global CDF-match LUTs built in smash() force
  // the target's distribution on each spectrum to mirror the source's, adapted
  // to whatever range the target actually occupies. That's the user's literal
  // "compressor that takes the dark 50% of a high-key target and clamps it to
  // 10% pure black, 15% dark gray, 25% medium yellow gray" — textbook CDF
  // histogram match per dimension.
  //
  // Hue uses linear CDF match in [-π, π]. The circular shortest-arc lerp at
  // gate-application time below handles wrap cases naturally; the only cost
  // is potential mild distortion for distributions that span the full circle.
  //
  // Each dimension's delta is gated by its trait amount (which can exceed 1
  // for oversample / crank — the lerps extrapolate past the matched value).
  //
  // traits.neutral and traits.accent modulate the master gate per-pixel:
  //   neutralProtect = neutralness × traits.neutral  → pulls gate down on
  //                                                    near-neutral inputs
  //   accentBoost    = accentScore × traits.accent   → pushes gate up on
  //                                                    rare/vivid inputs
  const traits = controls.traits;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const [Lin, aIn, bIn] = srgbByteToOklab(r, g, b);
  const [LsmBand, aSm, bSm] = srgbByteToOklab(smashR, smashG, smashB);

  const Cin = Math.sqrt(aIn * aIn + bIn * bIn);
  const CsmBand = Math.sqrt(aSm * aSm + bSm * bSm);
  // Use the band-derived smashed hue when input chroma is near zero — atan2
  // on (0, 0) is ambiguous and would propagate noise.
  const hin = Cin > 1e-6 ? Math.atan2(bIn, aIn) : (CsmBand > 1e-6 ? Math.atan2(bSm, aSm) : 0);
  const hsmBand = CsmBand > 1e-6 ? Math.atan2(bSm, aSm) : hin;

  // Phase 3 — L always comes from L CDF match (no colorization variant for
  // the L dimension — target's L distribution always exists).
  const Lsm = out.lumaCdf ? lookupCdfMatch(out.lumaCdf, Lin) : LsmBand;

  // Phase 4 + 4.5 — chroma always comes from per-dim CDF (rank-maps target
  // chroma onto source's distribution, which produces vivid output for vivid
  // sources). The hue dimension splits:
  //
  //   Toggle ON (hueByLuma === true | undefined, the default):
  //     hue is the DIRECTION from the source's L → (a,b) lookup at Lsm.
  //     This is the "color story by lightness" mechanic — pixels at the
  //     same L get a consistent, predictable hue derived from the source.
  //     Works on every image type, not just grayscale targets: the LUT
  //     averages source's color over each L bucket regardless of how much
  //     chroma the target had.
  //   Toggle OFF:
  //     hue is from the per-pixel hue CDF (Phase 4 default). This is
  //     correct when the target itself has reliable hue structure to
  //     redistribute; gets noisy on grayscale targets where atan2(small,
  //     small) is unstable, but that's the user's explicit choice.
  //
  // Net effect: ON is ALWAYS at least as colorful as OFF, and gives a
  // source-driven color story (instead of OFF's "preserve target's own
  // hue layout, rank-mapped"). Earlier the path produced mean-chroma
  // direction, which was strictly weaker than the rank-mapped chroma CDF
  // for vivid sources — that's been replaced with "ON keeps the rank-
  // mapped chroma magnitude, just re-aims hue at the source's L→(a,b)
  // direction".
  const hueByLumaActive =
    out.hueByLumaLut !== null
    && controls.colorization?.hueByLuma !== false;

  // Phase 4.5d — paletteSnap routes each pixel's hue to the nearest source
  // CLUSTER instead of using the per-L bucket average. Preserves source's
  // color identity (minority colors get expressed, not averaged away).
  // Requires at least one cluster with meaningful chroma; falls back to the
  // hueByLuma/CDF path otherwise.
  const paletteSnapActive =
    controls.colorization?.paletteSnap === true
    && out.profile.source.clusters.length > 0;

  // Look up source's average (a, b) at the smashed L — used by BOTH the lift
  // floor (its magnitude tells us source's typical chroma at this L) and the
  // Hue-by-L direction below. Single call, two consumers. Falls back to the
  // global sourceMedianChroma if the LUT is null (degenerate input).
  let aSrcLut = 0;
  let bSrcLut = 0;
  let srcLutMag = 0;
  if (out.hueByLumaLut) {
    const lookup = lookupHueByLuma(out.hueByLumaLut, Lsm);
    aSrcLut = lookup[0];
    bSrcLut = lookup[1];
    srcLutMag = Math.sqrt(aSrcLut * aSrcLut + bSrcLut * bSrcLut);
  }

  // Phase 4.5g — proportionMatch controls how tightly liftFloor tracks
  // source's L-conditional chroma vs the global median. 1.0 = pure per-L
  // (Phase 4.5f behavior, faithful to source's color/neutral structure).
  // 0.0 = pure global median (pre-4.5f behavior, uniform lift across L).
  // Intermediate values lerp between the two. Defaults to 1.0 (tight) so
  // existing controls without the field still get the proportion-faithful
  // behavior. When hueByLumaLut is null (degenerate input), per-L isn't
  // available — falls back to global median regardless of slider value.
  const rawProportion = controls.colorization?.proportionMatch;
  const proportionMatch =
    typeof rawProportion === "number" && Number.isFinite(rawProportion)
      ? Math.max(0, Math.min(1, rawProportion))
      : 1;
  const liftFloor = out.hueByLumaLut
    ? proportionMatch * srcLutMag + (1 - proportionMatch) * out.sourceMedianChroma
    : out.sourceMedianChroma;

  // Phase 4.5b → 4.5f — liftNeutrals (ON by default) floors the rank-mapped
  // chroma CDF result at SOURCE'S CHROMA AT THE TARGET'S L. Earlier the
  // floor used a single global median across all source pixels — that
  // pushed every near-neutral target pixel to the same magnitude regardless
  // of L, which dilutes source's actual color proportions. A 15%-fire /
  // 85%-dark source ended up producing nearly-uniform warm output instead
  // of "warm where source is warm, dark where source is dark". The per-L
  // floor matches source's L-conditional chroma structure: low-L target
  // pixels inherit source's small low-L chroma (stay neutral), high-L
  // target pixels inherit source's large high-L chroma (become vivid).
  // Net effect: output proportions track source's L→C structure, which —
  // combined with lumaCdf rank-mapping target's L distribution onto
  // source's — preserves the source's overall color/neutral ratio.
  //
  // neutralness=1 at Cin=0 (full lift), neutralness=0 at Cin>=0.15 (no
  // lift — vivid inputs are left to the CDF as designed).
  const liftNeutralsActive = controls.colorization?.liftNeutrals !== false;
  // Phase 5 — Conditional CDF amount. 0 = global CDFs only (default, byte-
  // identical to the Phase 4 path); >0 lerps the global chroma + hue result
  // toward the per-L-bucket conditional result. Reused by the hue branch
  // below.
  const rawConditional = controls.colorization?.conditionalCdf;
  const conditionalAmt =
    typeof rawConditional === "number" && Number.isFinite(rawConditional)
      ? Math.max(0, Math.min(1, rawConditional))
      : 0;
  const cdfMagGlobal = out.chromaCdf ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;
  const cdfMag =
    conditionalAmt > 0 && out.conditionalCdf
      ? cdfMagGlobal
        + (condChromaLookup(out.conditionalCdf, Lsm, Cin, cdfMagGlobal) - cdfMagGlobal)
          * conditionalAmt
      : cdfMagGlobal;
  const liftNeutralness = 1 - Math.min(1, Cin / 0.15);
  const liftAmount = liftNeutralsActive
    ? liftNeutralness * Math.max(0, liftFloor - cdfMag)
    : 0;
  let Csm = cdfMag + liftAmount;

  // Hue: source's L→(a,b) direction (Hue-by-L) when toggle ON and lookup
  // has a usable magnitude; per-pixel hue CDF fallback otherwise.
  let hsm: number;
  if (hueByLumaActive && srcLutMag > 1e-6) {
    hsm = Math.atan2(bSrcLut, aSrcLut);
  } else {
    const hGlobal = (out.hueCdf && Cin >= HUE_FILTER_CHROMA)
      ? lookupCdfMatch(out.hueCdf, hin)
      : hsmBand;
    // Phase 5 — blend toward the per-L-bucket conditional hue. Gated on
    // Cin >= HUE_FILTER_CHROMA (same stability gate as the global hue CDF
    // above) so near-neutral pixels keep the band fallback unchanged.
    if (conditionalAmt > 0 && out.conditionalCdf && Cin >= HUE_FILTER_CHROMA) {
      const condH = condHueLookup(out.conditionalCdf, Lsm, hin, hGlobal);
      let dh = condH - hGlobal;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      hsm = hGlobal + dh * conditionalAmt;
    } else {
      hsm = hGlobal;
    }
  }

  // Phase 4.5d — paletteSnap override. Replaces the averaged hsm above with
  // the hue of the nearest source CLUSTER (scored by hue distance + L
  // distance). Different input pixels can pick different clusters → output
  // diversity. Discrete by design — preserves source's color identity at
  // the cost of cluster-boundary discontinuities on smooth inputs. Skipped
  // when source has no chromatic clusters (degenerate input or grayscale
  // source); the hueByLuma/CDF result above stays.
  if (paletteSnapActive) {
    const clusters = out.profile.source.clusters;
    const CLUSTER_CHROMA_FLOOR = 0.02; // skip near-neutral clusters
    const L_WEIGHT = 0.5;              // L distance weighted less than hue
    let bestScore = -Infinity;
    let bestHue: number | null = null;
    for (let i = 0; i < clusters.length; i++) {
      const [cL, cA, cB] = clusters[i].centroidOklab;
      const cChroma = Math.sqrt(cA * cA + cB * cB);
      if (cChroma < CLUSTER_CHROMA_FLOOR) continue;
      const cHue = Math.atan2(cB, cA);
      // Circular hue distance (shortest arc).
      let dh = Math.abs(hin - cHue);
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      const dL = Math.abs(Lsm - cL);
      const score = -(dh + L_WEIGHT * dL);
      if (score > bestScore) {
        bestScore = score;
        bestHue = cHue;
      }
    }
    if (bestHue !== null) {
      hsm = bestHue;
    }
    // else: keep the hueByLuma/CDF hsm — source had no chromatic clusters
  }

  // Phase 4.5j — Zone routing. Two-step structure-aware path:
  //   1. Route input pixel to its nearest source cluster by L distance
  //      (1D — keeps assignment proportions correct since lumaCdf rank-maps
  //      target's L distribution onto source's, and clusters tile source's
  //      L range).
  //   2. Compute the cluster's contribution in Oklab (a, b) space, blending
  //      between the cluster's CENTROID (detailRichness=0, flat within
  //      zone) and the cluster's own Hue-by-L SUB-LUT at Lin (detailRichness
  //      =1, preserves intra-cluster value→color variation).
  //   3. Lerp the existing (hsm, Csm) toward the zone result by zoneInfluence.
  //
  // This is the "use simplified zones as masks, but reference the non-
  // abstracted source within each zone" mechanic — coarse routing by
  // cluster, fine detail from the cluster's pixel distribution. Same
  // structure-with-richness intent as paletteSnap + posterize, but applied
  // in (a, b) space rather than full RGB so it composes with the engine's
  // Lout / gate math instead of bypassing them.
  // Phase 4.5j/n — zoneInfluence range expanded from [0,1] to [0,2] so
  // users can OVERDRIVE the cluster-routed effect past natural strength.
  // Values >1 over-rotate the hue past the zone's hue and overshoot Csm
  // past the zone's chroma magnitude — useful for cranking the cluster's
  // character beyond what straight replacement would produce. Outputs at
  // 200% can land in places the engine wouldn't normally visit, but
  // oklabToSrgbByte's clipping keeps the result in-gamut.
  const rawZoneInfluence = controls.colorization?.zoneInfluence;
  const zoneInfluence =
    typeof rawZoneInfluence === "number" && Number.isFinite(rawZoneInfluence)
      ? Math.max(0, Math.min(2, rawZoneInfluence))
      : 0;
  if (zoneInfluence > 0 && out.clusterSubLuts.length > 0) {
    const rawDetail = controls.colorization?.detailRichness;
    const detail =
      typeof rawDetail === "number" && Number.isFinite(rawDetail)
        ? Math.max(0, Math.min(1, rawDetail))
        : 1;
    // Phase 4.5l — read soft/shift controls. Short-circuit to the
    // existing argmin path when both are at default (preserves byte-
    // exact 4.5j behavior for users who don't engage these knobs).
    const rawSoftness = controls.colorization?.zoneEdgeSoftness;
    const softness =
      typeof rawSoftness === "number" && Number.isFinite(rawSoftness)
        ? Math.max(0, Math.min(1, rawSoftness))
        : 0;
    const rawShift = controls.colorization?.zoneEdgeShift;
    const shift =
      typeof rawShift === "number" && Number.isFinite(rawShift)
        ? Math.max(-1, Math.min(1, rawShift))
        : 0;
    const useSoftPath = softness >= 0.005 || Math.abs(shift) >= 0.005;

    let aZone: number;
    let bZone: number;
    if (useSoftPath && out.zoneBoundaries.length > 0) {
      // Phase 4.5l soft routing — boundary-aware soft assignment in
      // sorted-by-L order, with gaussian falloff outside each cluster's
      // band. Each cluster k owns L interval [zoneBoundaries[k-1],
      // zoneBoundaries[k]] (with implicit 0 / 1 endpoints). Weight is 1
      // inside the band and decays exp(-d²/2σ²) outside.
      const K = out.sortedClusterLs.length;
      const SIGMA_MAX = 0.10;
      const sigma = 1e-4 + softness * SIGMA_MAX;
      const twoSigmaSq = 2 * sigma * sigma;
      let sumW = 0;
      let sumA = 0;
      let sumB = 0;
      for (let k = 0; k < K; k++) {
        const lo = k === 0 ? 0 : out.zoneBoundaries[k - 1];
        const hi = k === K - 1 ? 1 : out.zoneBoundaries[k];
        let d = 0;
        if (Lin < lo) d = lo - Lin;
        else if (Lin > hi) d = Lin - hi;
        const w = Math.exp(-d * d / twoSigmaSq);
        const kmeansIdx = out.clusterOrderByL[k];
        const centroid = out.profile.source.clusters[kmeansIdx].centroidOklab;
        const [aSub, bSub] = lookupHueByLuma(out.clusterSubLuts[kmeansIdx], Lin);
        const aContrib = centroid[1] + (aSub - centroid[1]) * detail;
        const bContrib = centroid[2] + (bSub - centroid[2]) * detail;
        sumW += w;
        sumA += w * aContrib;
        sumB += w * bContrib;
      }
      if (sumW > 1e-9) {
        aZone = sumA / sumW;
        bZone = sumB / sumW;
      } else {
        aZone = 0;
        bZone = 0;
      }
    } else {
      // Phase 4.5j argmin path (byte-identical to pre-4.5l behavior).
      const K = out.clusterSubLuts.length;
      let bestIdx = 0;
      let bestDist = Math.abs(Lin - out.clusterLs[0]);
      for (let i = 1; i < K; i++) {
        const d = Math.abs(Lin - out.clusterLs[i]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const centroid = out.profile.source.clusters[bestIdx].centroidOklab;
      const aCen = centroid[1];
      const bCen = centroid[2];
      const [aSub, bSub] = lookupHueByLuma(out.clusterSubLuts[bestIdx], Lin);
      aZone = aCen + (aSub - aCen) * detail;
      bZone = bCen + (bSub - bCen) * detail;
    }

    const CZone = Math.sqrt(aZone * aZone + bZone * bZone);
    // Lerp current (hsm, Csm) toward (hZone, CZone) by zoneInfluence
    if (CZone > 1e-6) {
      const hZone = Math.atan2(bZone, aZone);
      let dh = hZone - hsm;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      hsm = hsm + dh * zoneInfluence;
    }
    Csm = Csm + (CZone - Csm) * zoneInfluence;
  }

  // Per-pixel modulation of the master gate. neutral and accent stay clamped
  // to [0,1] as protection / amplification *factors* — they're not gates.
  const neutralness = 1 - Math.min(1, Cin / 0.15);
  const neutralProtect = neutralness * clamp01(traits.neutral);
  const accentScore = Math.min(1, Math.max(0, (Cin - 0.10) / 0.15));
  const accentBoost = accentScore * clamp01(traits.accent);
  // Master gate can exceed 1 when traits.accent boosts it on accent pixels.
  // Clamp away negatives only — let positive overdrive through.
  const masterGate = Math.max(0, controls.global * (1 - neutralProtect) * (1 + accentBoost));

  // Per-trait gates. Allow >1 (oversample / "crank") so the user can extrapolate
  // PAST the literal CDF match — the TraitSliders UI exposes the 100–200% range
  // explicitly. We clamp away negatives but not the upper bound; the lerps
  // below then linearly extrapolate when gate > 1. Hue is clamped to ≤1 to
  // prevent circular wrap-overshoot that would visually look broken.
  const gateClampPos = (v: number) => Math.max(0, v);
  const valueGate  = masterGate * gateClampPos(traits.value);
  const hueGate    = masterGate * clamp01(traits.hue);  // hue stays in [0,1]
  const chromaGate = masterGate * gateClampPos(traits.chroma);
  const satGate    = masterGate * gateClampPos(traits.saturation);

  // Apply perceptual deltas.
  const Lout = Lin + (Lsm - Lin) * valueGate;
  // Circular hue lerp via shortest-arc Δh.
  let dh = hsm - hin;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  const hout = hin + dh * hueGate;
  let Cout = Cin + (Csm - Cin) * chromaGate;

  // Saturation gate: targets S = C/L of the smashed pixel, applied AFTER
  // value and chroma so it adjusts vibrancy at the newly-decided L. Skipped
  // when both pixels are near black (L close to zero) to avoid divide noise.
  if (Lin > 1e-3 && Lout > 1e-3) {
    const Sin = Cout / Math.max(Lout, 1e-3);
    const Ssm = Csm / Math.max(Lsm, 1e-3);
    const Sout = Sin + (Ssm - Sin) * satGate;
    Cout = Math.max(0, Sout * Lout);
  }

  // Reconstruct Oklab.
  let aOut = Cout * Math.cos(hout);
  let bOut = Cout * Math.sin(hout);

  // Phase 4.5p — Temperature, IMAGE-RELATIVE. The image's own estimated
  // output-warmth median (`out.estimatedOutputMedianWarmth`) is the
  // neutral center; "warm" and "cool" are decided relative to that
  // center, not relative to Oklab's absolute warm axis. This is what
  // makes the slider work on uniformly-warm or uniformly-cool images:
  // an all-warm image still has pixels that are LESS warm than the
  // median (image-relatively cool) and MORE warm than the median
  // (image-relatively warm), and the slider acts on that distinction.
  //
  // Algorithm:
  //   warmth = aOut · WARM_A + bOut · WARM_B
  //   relW   = warmth − medianW
  //   exp    = 3^(1 − 2·sensitivity)              # sensitivity ∈ [0, 1]
  //   relW_s = sign(relW) · |relW|^exp            # sharpened by exponent
  //
  //   if t > 0 ∧ relW_s > 0:                      # warm slider, image-warm pixel
  //     warmth' = warmth + t · relW_s · GAIN      # push further warm (contrast stretch)
  //   if t < 0 ∧ relW_s < 0:                      # cool slider, image-cool pixel
  //     warmth' = warmth + (−|t|) · |relW_s| · GAIN  # push further cool
  //   else: warmth' = warmth                      # untouched (same-side preserved)
  //
  // Same-polarity-as-slider pixels move further from the median in the
  // slider's direction; opposite-polarity pixels stay put. The result is
  // a CONTRAST STRETCH along the warm/cool axis, anchored at the image's
  // own center — distinct warm/cool zones emerge relative to the image's
  // own balance rather than to an absolute reference.
  const rawTemperature = controls.colorization?.temperature;
  const temperature =
    typeof rawTemperature === 'number' && Number.isFinite(rawTemperature)
      ? Math.max(-2, Math.min(2, rawTemperature))
      : 0;
  if (temperature !== 0) {
    const WARM_A = 0.82;
    const WARM_B = 0.57;
    const warmth = aOut * WARM_A + bOut * WARM_B;
    const medianW = out.estimatedOutputMedianWarmth;
    const relW = warmth - medianW;
    // Sensitivity controls migration SPEED (how quickly a pixel reaches
    // the median given its distance). High sensitivity = pixels just past
    // median migrate as if they were far (distinct zones emerge fast).
    // Low sensitivity = only far-from-median pixels migrate appreciably
    // (smooth gradient near median).
    //
    // Phase 4.5q: extended ranges. Temperature [-2, +2], Sensitivity
    // [0, 2]. effective_t is now capped at 3 (was 1) — values between 1
    // and 3 OVERDRIVE the migration: pixels push PAST the median into
    // opposite-color territory. Below 1, the prior "no-cross" guarantee
    // still holds. The 3 ceiling prevents arbitrary blowups; well below
    // any visible-saturation limit since sRGB gamut clipping kicks in
    // earlier.
    const rawSens = controls.colorization?.temperatureSensitivity;
    const sensitivity =
      typeof rawSens === 'number' && Number.isFinite(rawSens)
        ? Math.max(0, Math.min(2, rawSens))
        : 0.5;
    // sensitivity 0   → scale 1/3 (slow / soft)
    // sensitivity 0.5 → scale 1   (linear, default)
    // sensitivity 1   → scale 3   (sharp — distinct zones at default t)
    // sensitivity 2   → scale 27  (very sharp — even tiny relW gets full push)
    const sensScale = Math.pow(3, 2 * sensitivity - 1);
    // Effective migration fraction. Capped at 3 — at default t and
    // sensitivity≤1 still ≤1 (no-cross). Above 1, pixel pushes past
    // median into opposite-color territory (explicit overdrive).
    const effective_t = Math.min(3, Math.abs(temperature) * sensScale);
    // Only opposite-polarity-to-slider pixels migrate (the user's
    // intent: warm slider TARGETS image-cools and pushes them toward
    // image-warm; cool slider TARGETS image-warms and pushes toward
    // image-cool — both moves are toward the median).
    const shouldShift =
      (temperature > 0 && relW < 0) ||
      (temperature < 0 && relW > 0);
    if (shouldShift) {
      // Phase 4.5r — Temperature L Bias: linear weight on the migration
      // delta based on the pixel's output L. Lets the user restrict
      // temperature to highlights, shadows, or anywhere in between.
      const rawLBias = controls.colorization?.temperatureLBias;
      const lBias =
        typeof rawLBias === 'number' && Number.isFinite(rawLBias)
          ? Math.max(-1, Math.min(1, rawLBias))
          : 0;
      let lWeight = 1;
      if (lBias !== 0) {
        // Clamp Lout to [0, 1] for the weight curve. The post-gate Lout
        // can exceed [0, 1] under crank/overdrive — we clamp here so the
        // weight stays in a meaningful range without changing Lout itself.
        const L = Math.max(0, Math.min(1, Lout));
        const target = lBias > 0 ? L : 1 - L;
        const absBias = Math.abs(lBias);
        // lerp(1, target, |lBias|): at lBias=0 → 1 (uniform), at lBias=±1 → target
        lWeight = 1 + absBias * (target - 1);
      }
      // Phase 4.5t — Temperature C Bias: linear weight on the migration
      // delta from the pixel's INPUT chroma, normalized image-relatively
      // against the target's 95th-percentile chroma.
      const rawCBias = controls.colorization?.temperatureCBias;
      const cBias =
        typeof rawCBias === 'number' && Number.isFinite(rawCBias)
          ? Math.max(-1, Math.min(1, rawCBias))
          : 0;
      let cWeight = 1;
      if (cBias !== 0) {
        const cNorm = Math.max(0, Math.min(1,
          Cin / Math.max(out.targetChromaP95, 1e-4)));
        const target = cBias > 0 ? cNorm : 1 - cNorm;
        cWeight = 1 + Math.abs(cBias) * (target - 1);
      }

      // Phase 4.5t — Temperature S Bias: same, on INPUT saturation (S = C/L,
      // clamped [0,2] to match features.ts so the p95 anchor's units agree).
      const rawSBias = controls.colorization?.temperatureSBias;
      const sBias =
        typeof rawSBias === 'number' && Number.isFinite(rawSBias)
          ? Math.max(-1, Math.min(1, rawSBias))
          : 0;
      let sWeight = 1;
      if (sBias !== 0) {
        const Sin = Math.min(2, Cin / Math.max(Lin, 1e-6));
        const sNorm = Math.max(0, Math.min(1,
          Sin / Math.max(out.targetSaturationP95, 1e-4)));
        const target = sBias > 0 ? sNorm : 1 - sNorm;
        sWeight = 1 + Math.abs(sBias) * (target - 1);
      }

      // delta moves warmth toward (and possibly past) median, scaled by all
      // three TARGET biases. With every bias at 0 each weight is exactly 1,
      // so delta is byte-identical to the Phase 4.5r output.
      const delta = -relW * effective_t * lWeight * cWeight * sWeight;
      aOut += delta * WARM_A;
      bOut += delta * WARM_B;
    }
  }

  // Convert to bytes.
  let [finalR, finalG, finalB] = oklabToSrgbByte(Lout, aOut, bOut);

  // Phase 4.5i — Distribution. Soft Gaussian-weighted cluster blend in
  // joint Oklab (L+a+b) space. Each output pixel is pulled toward the
  // weighted mean of ALL source clusters, where each cluster's weight is
  // its population (fraction of source pixels) × gaussian proximity to
  // the input pixel's Oklab position. Smooth, banding-free, naturally
  // emphasizes source's high-density modes ("smash with structure"). Sigma
  // tuned at 0.15 in Oklab L+a+b combined — moderate softness: enough to
  // favor nearby clusters, soft enough to interpolate smoothly between
  // them. Applied BEFORE posterize so a user with both knobs >0 sees the
  // distribution-blended result get posterized (hard snap takes precedence).
  const rawDistribution = controls.colorization?.distribution;
  const distribution =
    typeof rawDistribution === "number" && Number.isFinite(rawDistribution)
      ? Math.max(0, Math.min(1, rawDistribution))
      : 0;
  if (distribution > 0 && out.profile.source.clusters.length > 0) {
    const clusters = out.profile.source.clusters;
    const adjWeights = out.adjustedClusterWeights;
    const SIGMA = 0.15;
    const sigmaSq2 = 2 * SIGMA * SIGMA;
    let sumW = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const [cL, cA, cB] = c.centroidOklab;
      const dL = Lin - cL;
      const dA = aIn - cA;
      const dB = bIn - cB;
      const dist2 = dL * dL + dA * dA + dB * dB;
      // Weight = adjusted population (zoneRatio-modulated, Phase 4.5k)
      // × gaussian falloff. zoneRatio < 0 flattens weights so minority
      // clusters get more voice; > 0 exaggerates dominance.
      const w = adjWeights[i] * Math.exp(-dist2 / sigmaSq2);
      sumW += w;
      sumR += c.rgb[0] * w;
      sumG += c.rgb[1] * w;
      sumB += c.rgb[2] * w;
    }
    if (sumW > 1e-9) {
      const blendR = sumR / sumW;
      const blendG = sumG / sumW;
      const blendB = sumB / sumW;
      finalR = Math.max(0, Math.min(255, Math.round(finalR + (blendR - finalR) * distribution)));
      finalG = Math.max(0, Math.min(255, Math.round(finalG + (blendG - finalG) * distribution)));
      finalB = Math.max(0, Math.min(255, Math.round(finalB + (blendB - finalB) * distribution)));
    }
  }

  // Phase 4.5h — Posterize. Lerp the final RGB toward the nearest source
  // CLUSTER's RGB (chosen by L distance to the INPUT pixel's L — matches
  // user's L-band-routing intuition: dark target pixels snap to dark
  // cluster, highlights to bright cluster, etc.). posterize ∈ [0, 1]:
  // 0 = no snap (default), 1 = full snap (output IS cluster's RGB).
  // Unlike paletteSnap which only re-aims hue direction, posterize
  // replaces the entire pixel — producing bold posterized banding when
  // dialed high, with the source's actual palette as the band colors.
  const rawPosterize = controls.colorization?.posterize;
  const posterize =
    typeof rawPosterize === "number" && Number.isFinite(rawPosterize)
      ? Math.max(0, Math.min(1, rawPosterize))
      : 0;
  if (posterize > 0 && out.profile.source.clusters.length > 0) {
    const clusters = out.profile.source.clusters;
    let bestIdx = 0;
    let bestDist = Math.abs(Lin - clusters[0].centroidOklab[0]);
    for (let i = 1; i < clusters.length; i++) {
      const d = Math.abs(Lin - clusters[i].centroidOklab[0]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [cR, cG, cB] = clusters[bestIdx].rgb;
    finalR = Math.max(0, Math.min(255, Math.round(finalR + (cR - finalR) * posterize)));
    finalG = Math.max(0, Math.min(255, Math.round(finalG + (cG - finalG) * posterize)));
    finalB = Math.max(0, Math.min(255, Math.round(finalB + (cB - finalB) * posterize)));
  }

  return [finalR, finalG, finalB];
}
