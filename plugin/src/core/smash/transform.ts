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
import { srgbByteToOklab } from '../perceptual/oklab';

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

/** Linear interpolation between two scalar values. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

  // Record trait contributions from controls. Phase 1 mirrors what the
  // controls say; actual per-trait curve weighting is deferred to Phase 2.
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

  return { profile, controls: c, bandTransforms, audit };
}

/**
 * Apply a Smash transform to a single sRGB byte triple. Soft band membership:
 * the pixel's perceptual luma is used to interpolate between adjacent band
 * curves with a Gaussian falloff scaled by controls.bandSoftness. The blended
 * result is then ACES-gamut-compressed at full strength and returned as bytes.
 *
 * Identity for empty input: if all band transforms fellBack, the input pixel
 * is returned unchanged (after gamut compression, which leaves in-gamut input
 * alone).
 */
export function applyTransform(
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

  // Phase 2 — apply trait amounts.
  //
  // For Phase 2a, two traits differentially affect the output:
  //   - traits.value: scales the entire transfer strength (master gate).
  //   - traits.neutral: protects near-neutral input pixels by pulling the
  //     mix back toward identity in proportion to the input's neutralness
  //     (Oklab chroma below 0.15 means "near neutral").
  //
  // The other four traits (hue, saturation, chroma, accent) are recorded in
  // the audit during smash() but are no-ops in applyTransform until Phase 2b
  // factors the per-band fit into perceptual components that can be gated
  // separately. The UI surfaces all six so users can see the future control
  // surface; transparent docs note the partial coverage.
  const traits = controls.traits;
  const valueGate = Math.max(0, Math.min(1, traits.value));
  const baseMix = Math.max(0, Math.min(1, controls.global)) * valueGate;

  // Neutral protection: compute input chroma in Oklab. Low chroma → strong
  // neutralness signal. Multiply by traits.neutral so the slider scales how
  // much we protect. protectionFactor ∈ [0, 1]; 1 means full identity here.
  const [, aIn, bIn] = srgbByteToOklab(r, g, b);
  const inputChroma = Math.sqrt(aIn * aIn + bIn * bIn);
  const neutralness = 1 - Math.min(1, inputChroma / 0.15);
  const protectionFactor = Math.max(0, Math.min(1, traits.neutral)) * neutralness;
  const finalMix = baseMix * (1 - protectionFactor);

  const finalR = Math.max(0, Math.min(255, Math.round(lerp(r, smashR, finalMix))));
  const finalG = Math.max(0, Math.min(255, Math.round(lerp(g, smashG, finalMix))));
  const finalB = Math.max(0, Math.min(255, Math.round(lerp(b, smashB, finalMix))));

  return [finalR, finalG, finalB];
}
