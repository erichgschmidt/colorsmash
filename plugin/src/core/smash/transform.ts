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

  // Phase 3 — build global CDF-match LUTs on the L and C OkLCh dimensions.
  // applyTransform uses these as the canonical "smashed L" and "smashed C"
  // values (replacing what was previously derived from per-channel curves).
  // Per-channel curves still exist in bandTransforms above and are used by
  // applyTransform to derive a "smashed hue" — that path is the next thing
  // to migrate to a circular CDF match.
  let lumaCdf: CdfMatchLut | null = null;
  let chromaCdf: CdfMatchLut | null = null;
  if (sourceFeatures.length > 0 && targetFeatures.length > 0) {
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
    lumaCdf = buildCdfMatchLut(srcLuma, tgtLuma);
    chromaCdf = buildCdfMatchLut(srcChroma, tgtChroma);
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

  return { profile, controls: c, bandTransforms, audit, lumaCdf, chromaCdf };
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

  // ───── Phase 3 — CDF histogram-match in perceptual space ─────
  //
  // For L and C dimensions: the global CDF-match LUTs built in smash() force
  // the target's distribution on each spectrum to mirror the source's, adapted
  // to whatever range the target actually occupies. That's the user's literal
  // "compressor that takes the dark 50% of a high-key target and clamps it to
  // 10% pure black, 15% dark gray, 25% medium yellow gray" — i.e. textbook
  // CDF histogram match per dimension.
  //
  // For h (hue): we still use the per-channel-curves-derived smashed hue from
  // the band fit above. Circular CDF match is the next dimension to migrate.
  //
  // Each dimension's delta is then gated by its trait amount (which can exceed
  // 1 for oversample / crank — the lerps extrapolate past the matched value).
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
  // Use the smashed hue when input chroma is near zero — atan2(0, 0) is
  // ambiguous and would propagate noise.
  const hin = Cin > 1e-6 ? Math.atan2(bIn, aIn) : (CsmBand > 1e-6 ? Math.atan2(bSm, aSm) : 0);
  const hsm = CsmBand > 1e-6 ? Math.atan2(bSm, aSm) : hin;

  // Phase 3 — replace band-derived Lsm/Csm with proper CDF match when LUTs
  // are available. Falls back to band-derived values for degenerate inputs
  // (empty feature arrays at build time → null LUTs).
  const Lsm = out.lumaCdf ? lookupCdfMatch(out.lumaCdf, Lin) : LsmBand;
  const Csm = out.chromaCdf ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;

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
  const [finalR, finalG, finalB] = oklabToSrgbByte(Lout, aOut, bOut);

  return [finalR, finalG, finalB];
}
