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
   * Phase 4.5 — source-derived L → (avg a, avg b) lookup used by the
   * colorization path. applyTransform engages it when (a) the target's
   * median chroma is below the colorization threshold AND (b) the user's
   * colorization.hueByLuma toggle is on. Otherwise unused.
   */
  readonly hueByLumaLut: HueByLumaLut | null;
  /**
   * Phase 4.5 — target's median chroma. Used as the auto-detect signal for
   * "is this target effectively grayscale?" Below GRAYSCALE_TARGET_THRESHOLD
   * (≈2× HUE_FILTER_CHROMA), the colorization path engages. Stored on
   * SmashEngineOutput so applyTransform can branch without re-scanning the
   * target features.
   */
  readonly targetMedianChroma: number;
}

/** Below this target median chroma, the colorization path is eligible.
 *  Tuned at 0.015 (roughly 75% of HUE_FILTER_CHROMA) so we ONLY activate on
 *  effectively-monochrome targets. Earlier 0.04 was too eager — caught
 *  typical photos with low-saturation backgrounds and produced visibly
 *  different output from per-dimension CDF even when the target had real
 *  chroma to redistribute. */
const GRAYSCALE_TARGET_THRESHOLD = 0.015;

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
}

/** Build the L/C/h CDF LUTs from a source/target feature pair. Pure work,
 *  no controls, no audit — call once per snap change and cache the result.
 *  smash() will use the cached CDFs if passed via the precomputedCdfs arg. */
export function buildSmashCdfs(
  sourceFeatures: PixelFeatures[],
  targetFeatures: PixelFeatures[],
): SmashCdfs {
  if (sourceFeatures.length === 0 || targetFeatures.length === 0) {
    return {
      lumaCdf: null, chromaCdf: null, hueCdf: null,
      hueByLumaLut: null, targetMedianChroma: 0,
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
  // lookup. targetMedianChroma is the auto-detect signal for "target is
  // grayscale-ish" (median is a more stable estimator than mean for chroma
  // distributions which are typically right-skewed). Median computed via
  // sort-and-pick at the half-rank; cheap on the already-allocated tgtChroma
  // Float32Array.
  const hueByLumaLut = buildHueByLumaLut(sourceFeatures);
  const tgtChromaSorted = tgtChroma.slice().sort();
  const targetMedianChroma = tgtChromaSorted[Math.floor(tgtChromaSorted.length / 2)] ?? 0;

  return { lumaCdf, chromaCdf, hueCdf, hueByLumaLut, targetMedianChroma };
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
    // Phase 4.5: enabled by default. Engine auto-detects grayscale-ish
    // targets and activates the hueByLuma path; colorful targets continue
    // to use per-dimension CDF unchanged.
    hueByLuma: true,
  },
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
  const cdfs = precomputedCdfs ?? buildSmashCdfs(sourceFeatures, targetFeatures);
  const lumaCdf = cdfs.lumaCdf;
  const chromaCdf = cdfs.chromaCdf;
  const hueCdf = cdfs.hueCdf;
  const hueByLumaLut = cdfs.hueByLumaLut;
  const targetMedianChroma = cdfs.targetMedianChroma;

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
    hueByLumaLut, targetMedianChroma,
  };
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

  // Phase 4 + 4.5 — C and h depend on the target's chroma profile:
  //
  //   Colorful target (median chroma ≥ GRAYSCALE_TARGET_THRESHOLD):
  //     C, h from per-dimension CDF match (Phase 3/4 behavior).
  //   Grayscale-ish target AND user has hueByLuma toggle ON:
  //     C, h derived from source's L → (a,b) lookup at Lsm. The target's
  //     own C/h distributions are too sparse to redistribute meaningfully,
  //     so we INVENT color structure from source's color-by-L correlation.
  //   Grayscale-ish target AND toggle is OFF:
  //     Fall back to per-dimension CDF (which produces near-grayscale output).
  const colorizationEligible =
    out.hueByLumaLut !== null
    && out.targetMedianChroma < GRAYSCALE_TARGET_THRESHOLD
    && controls.colorization?.hueByLuma !== false;

  let Csm: number;
  let hsm: number;
  if (colorizationEligible && out.hueByLumaLut) {
    // Look up source's average (a, b) at the SMASHED L (after L CDF match)
    // so the invented color matches the new lightness, not the input lightness.
    const [aSrc, bSrc] = lookupHueByLuma(out.hueByLumaLut, Lsm);
    Csm = Math.sqrt(aSrc * aSrc + bSrc * bSrc);
    hsm = Csm > 1e-6 ? Math.atan2(bSrc, aSrc) : hin;
  } else {
    Csm = out.chromaCdf ? Math.max(0, lookupCdfMatch(out.chromaCdf, Cin)) : CsmBand;
    hsm = (out.hueCdf && Cin >= HUE_FILTER_CHROMA)
      ? lookupCdfMatch(out.hueCdf, hin)
      : hsmBand;
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
  const [finalR, finalG, finalB] = oklabToSrgbByte(Lout, aOut, bOut);

  return [finalR, finalG, finalB];
}
