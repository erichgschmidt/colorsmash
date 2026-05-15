// Pro Smash Engine — per-band histogram-match transform.
// Smash = Match applied N times, once per luma band. reuses fitHistogramCurves
// from core/histogramMatch.ts so band==1 collapses to the existing global Match
// by construction. ACES gamut compression is applied at the output stage.

import { fitHistogramCurves } from '../histogramMatch';
import type { ChannelCurves } from '../histogramMatch';
import type { ImagePairProfile, SmashControls, SmashAudit, PixelFeatures, Vec3 } from './types';
import { createAudit, withTraitContribution, withBandUsed, finalize } from './audit';
import { acesGamutCompress } from './gamut';
import { perceptualLuma } from '../perceptual/luma';
import { srgbByteToOklab, oklabToSrgbByte } from '../perceptual/oklab';
import { buildCdfMatchLut, lookupCdfMatch, type CdfMatchLut } from './cdfMatch';
import { buildHueByLumaLut, lookupHueByLuma, type HueByLumaLut } from './hueByLuma';

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
  /** Phase 4.5k — per-cluster effective weights AFTER applying the
   *  `zoneRatio` power exponent. At zoneRatio=0 these match natural
   *  weights; negative ratios flatten; positive ratios exaggerate
   *  dominance. Used wherever cluster.weight participates (currently
   *  the `distribution` mechanic). Always normalized so Σ = 1.
   *  Parallel to clusterSubLuts / clusterLs. */
  readonly adjustedClusterWeights: Float32Array;
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

  return {
    lumaCdf, chromaCdf, hueCdf, hueByLumaLut,
    targetMedianChroma, sourceMedianChroma,
    clusterSubLuts, clusterLs, clusterRgbs,
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
  const lumaCdf = cdfs.lumaCdf;
  const chromaCdf = cdfs.chromaCdf;
  const hueCdf = cdfs.hueCdf;
  const hueByLumaLut = cdfs.hueByLumaLut;
  const targetMedianChroma = cdfs.targetMedianChroma;
  const sourceMedianChroma = cdfs.sourceMedianChroma;
  const clusterSubLuts = cdfs.clusterSubLuts;
  const clusterLs = cdfs.clusterLs;
  const clusterRgbs = cdfs.clusterRgbs;

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
  if (K > 0) {
    // Map zoneRatio ∈ [-1, +1] → exponent k ∈ [1/e, e] via exp(x). This
    // gives a symmetric "tighten / loosen" feel — −1 fully flattens
    // (still some variance because weights are nonzero), +1 sharply
    // amplifies dominance.
    const k = Math.exp(zoneRatio);
    let sum = 0;
    for (let i = 0; i < K; i++) {
      const w = profile.source.clusters[i].weight;
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

  return {
    profile, controls: c, bandTransforms, audit,
    lumaCdf, chromaCdf, hueCdf,
    hueByLumaLut, targetMedianChroma, sourceMedianChroma,
    clusterSubLuts, clusterLs, clusterRgbs,
    adjustedClusterWeights,
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
  const cdfMag = out.chromaCdf ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;
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
    hsm = (out.hueCdf && Cin >= HUE_FILTER_CHROMA)
      ? lookupCdfMatch(out.hueCdf, hin)
      : hsmBand;
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
  const rawZoneInfluence = controls.colorization?.zoneInfluence;
  const zoneInfluence =
    typeof rawZoneInfluence === "number" && Number.isFinite(rawZoneInfluence)
      ? Math.max(0, Math.min(1, rawZoneInfluence))
      : 0;
  if (zoneInfluence > 0 && out.clusterSubLuts.length > 0) {
    const rawDetail = controls.colorization?.detailRichness;
    const detail =
      typeof rawDetail === "number" && Number.isFinite(rawDetail)
        ? Math.max(0, Math.min(1, rawDetail))
        : 1;
    // Step 1: nearest cluster by L (1D scan, ~16-32 clusters)
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
    // Step 2: cluster's (a, b) contribution
    const centroid = out.profile.source.clusters[bestIdx].centroidOklab;
    const aCen = centroid[1];
    const bCen = centroid[2];
    const [aSub, bSub] = lookupHueByLuma(out.clusterSubLuts[bestIdx], Lin);
    const aZone = aCen + (aSub - aCen) * detail;
    const bZone = bCen + (bSub - bCen) * detail;
    const CZone = Math.sqrt(aZone * aZone + bZone * bZone);
    // Step 3: lerp current (hsm, Csm) toward (hZone, CZone) by zoneInfluence
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

  // Reconstruct Oklab and convert back to bytes.
  const aOut = Cout * Math.cos(hout);
  const bOut = Cout * Math.sin(hout);
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
