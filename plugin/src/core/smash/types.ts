// Pro Smash Engine — type definitions.
//
// All structs in this file are persisted, versioned, or both. Treat changes
// here as semver-impacting: a wire-format bump should accompany any rename or
// removal. The Phase 0 versions are deliberately permissive (most fields
// optional) so the engine can be filled in incrementally.
//
// See ColorSmash_Masterplan_v1.md §3.2 for the canonical shape and rationale.

/** Current SmashPreset / SourceDNA / TargetStructure schema version. */
export const SMASH_SCHEMA_VERSION = 1;

export type Vec3 = readonly [number, number, number];

/** A pair of percentile bounds with a soft transition width on either side. */
export interface BandBounds {
  readonly bounds: readonly [number, number];
  readonly softWidth: number;
}

/**
 * Per-pixel feature vector. Computed at preview-tier resolution (256–512 px
 * longest edge). Not persisted — derived on demand from RGB samples.
 */
export interface PixelFeatures {
  readonly rgb: Vec3;
  readonly oklab: Vec3;
  readonly oklch: { readonly L: number; readonly C: number; readonly h: number };
  readonly luma: number;
  readonly hueAngle: number;
  readonly chroma: number;
  readonly saturation: number;
  readonly neutralScore: number;
  readonly accentScore: number;
  readonly bandId: number;
  readonly clusterId: number;
}

/** Axis along which bands are constructed. v0 ships `value` only. */
export type BandAxis = 'value' | 'hue' | 'saturation' | 'chroma';

/**
 * Statistics for one band on one image. Computed for both source and target.
 * `sampleCount` drives fallback decisions when a band is too sparse for
 * meaningful transfer.
 */
export interface BandStats {
  readonly axis: BandAxis;
  readonly index: number;
  readonly label: string;
  readonly bounds: readonly [number, number];
  readonly softWidth: number;
  readonly center: number;
  readonly pixelRatio: number;
  readonly meanOklab: Vec3;
  readonly medianOklab: Vec3;
  readonly dominantHue: number;
  readonly hueSpread: number;
  readonly satMedian: number;
  readonly chromaMedian: number;
  readonly chromaSpread: number;
  readonly neutralDensity: number;
  readonly accentDensity: number;
  readonly histogram: Float32Array;
  readonly sampleCount: number;
}

/**
 * Per-cluster statistics. Aligned with the existing palette code
 * (`core/palette.ts`), extended with Smash-specific fields (locked / anchor).
 */
export interface ClusterStats {
  readonly id: number;
  readonly centroidOklab: Vec3;
  readonly rgb: Vec3;
  readonly weight: number;
  readonly natural: number;
  readonly multiplier: number;
  readonly locked: boolean;
  readonly anchor: boolean;
}

/** Image-wide stats used as a context for band / cluster comparisons. */
export interface GlobalStats {
  readonly meanOklab: Vec3;
  readonly medianOklab: Vec3;
  readonly chromaMean: number;
  readonly chromaMedian: number;
  readonly neutralRatio: number;
  readonly accentRatio: number;
}

/** Compact summary of an image's color organization. Persisted in presets. */
export interface SourceDNA {
  readonly version: number;
  readonly capturedAt: string;
  readonly thumbnail?: string;
  readonly bands: readonly BandStats[];
  readonly clusters: readonly ClusterStats[];
  readonly global: GlobalStats;
}

/** Same shape as SourceDNA, but extracted from the target. */
export type TargetStructure = SourceDNA;

/** Trait knobs. Each is a normalized amount in [0, 1]. */
export interface TraitAmounts {
  readonly value: number;
  readonly hue: number;
  readonly saturation: number;
  readonly chroma: number;
  /** Higher = more aggressive neutral protection. */
  readonly neutral: number;
  readonly accent: number;
}

/** v1.21 Phase 4.5+ — cross-dimensional colorization toggles. Activate when
 *  per-dimension CDF can't redistribute color the target lacks (grayscale
 *  target case). Each toggle is one of the four mechanics in v1.1 addendum
 *  Phase 5+. v0 ships only hueByLuma; future toggles slot in alongside. */
export interface ColorizationOptions {
  /** Phase 4.5 — Hue-by-L lookup. On: smashed hue is the source's L→(a,b)
   *  direction at the smashed L (broad source-driven color story). Off:
   *  smashed hue comes from the per-pixel hue CDF (preserves target's own
   *  hue layout, rank-mapped). Default true. */
  readonly hueByLuma?: boolean;
  /** Phase 4.5b — Lift neutrals. On: near-neutral target pixels get a chroma
   *  floor at source's median chroma so shadows colorize broadly instead of
   *  collapsing to source's bottom-rank chroma (which is ~0 for typical
   *  sources with dark backgrounds). Off: chroma comes from per-dim CDF
   *  unchanged — faithful to source's L→C structure but produces monochrome
   *  shadows when source's shadows are also neutral. Default true. */
  readonly liftNeutrals?: boolean;
  /** Phase 4.5d — Palette snap. On: each pixel's hue snaps to the nearest
   *  source CLUSTER (in hue + L) rather than the per-L average. Preserves
   *  source's color identity — minority colors get expressed instead of
   *  averaged away. Diversity emerges when the target has any chromatic
   *  variation (edges, JPEG noise, real color). Off: hue follows the
   *  averaged L→(a,b) direction (Hue-by-L default). Default false — opt-in
   *  because the smooth-vs-discrete tradeoff isn't universally preferred. */
  readonly paletteSnap?: boolean;
  /** Phase 4.5g — Proportion match. Controls how tightly the lift floor
   *  tracks source's L-conditional chroma structure vs averaging across
   *  the whole source. Range [0, 1]:
   *    1.0 (tight, default): liftFloor = source's chroma magnitude AT THE
   *        TARGET'S smashed L. Output color/neutral ratio mirrors source's
   *        — dark areas of the source come through as dark in the output,
   *        bright/chromatic areas come through as chromatic.
   *    0.0 (loose): liftFloor = source's GLOBAL median chroma. Every
   *        near-neutral pixel gets the same lift regardless of L → more
   *        uniform colorization, less faithful to source's structure.
   *    0.5: 50/50 blend.
   *  Only affects the engine when liftNeutrals is on. */
  readonly proportionMatch?: number;
  /** Phase 4.5h — Posterize. Lerps the final RGB output toward the
   *  nearest source CLUSTER's full RGB (L + a + b — not just hue, unlike
   *  paletteSnap). Cluster nearness scored by L distance (matches user's
   *  L-band-routing mockup: dark target pixels snap to dark cluster,
   *  highlights snap to bright cluster, etc.). Range [0, 1]:
   *    0.0 (default): no posterize, output is the engine's smooth result
   *    0.5: 50/50 blend between smooth output and cluster's RGB
   *    1.0: full snap — output IS the cluster's RGB, hard posterized
   *         banding into N source-derived colors
   *  Cluster count is fixed at SourceDNA extraction time; finer control
   *  over band count is future work. */
  readonly posterize?: number;
  /** Phase 4.5i — Distribution. Soft Gaussian-weighted cluster blend in
   *  joint Oklab (L+a+b) space. Each output pixel is influenced by ALL
   *  source clusters, weighted by both spatial proximity (gaussian
   *  falloff) and cluster population (frequency in source). Produces a
   *  smooth, banding-free output that naturally emphasizes source's
   *  high-density color modes — the "smash with structure" knob.
   *
   *  Range [0, 1]:
   *    0.0 (default): no blend, output is engine's smooth result
   *    0.5: 50/50 lerp between smooth output and weighted cluster mean
   *    1.0: full lerp to weighted cluster mean
   *
   *  Different from posterize: posterize SNAPS to one cluster (banded);
   *  distribution BLENDS across all clusters (smooth). Different from
   *  per-dim CDFs: those treat L, C, h independently; distribution
   *  respects the joint distribution where source's pixels actually
   *  co-cluster. Different from paletteSnap: paletteSnap re-aims hue
   *  only; distribution influences the entire pixel color. */
  readonly distribution?: number;
  /** Phase 4.5j — Zone Influence. How strongly the cluster-routed
   *  ("zone") path replaces the engine's default Hue-by-L when a target
   *  pixel is mapped to a source cluster.
   *
   *  Range [0, 1]:
   *    0.0 (default): no zone routing, output uses default Hue-by-L /
   *        CDF / lift path unchanged
   *    1.0: zone path fully replaces the default hue+chroma magnitude
   *        with the cluster's contribution
   *
   *  Pairs with `detailRichness` to control what the zone path emits:
   *  cluster centroid (no internal variation) vs the cluster's own
   *  Hue-by-L sub-LUT (preserves intra-cluster L→(a,b) variation). */
  readonly zoneInfluence?: number;
  /** Phase 4.5j — Detail Richness. Inside the zone path, controls how
   *  much intra-cluster variation is preserved.
   *
   *  Range [0, 1]:
   *    0.0: zone emits the cluster's CENTROID (single (a,b) for every
   *        pixel mapped to this cluster — flat within zone)
   *    1.0 (default when zone path active): zone emits the cluster's
   *        Hue-by-L SUB-LUT at the input pixel's L — preserves the
   *        source's intra-cluster value→color variation
   *  Intermediate: lerp between the two.
   *
   *  Only has effect when `zoneInfluence > 0`. */
  readonly detailRichness?: number;
  /** Phase 4.5k — Zone Ratio. Modulates the source clusters' weight
   *  distribution. Applied as a power exponent: adjusted_weight ∝
   *  natural_weight^k where k = exp(zoneRatio × LN_SCALE). Affects every
   *  mechanic that reads cluster.weight (today: `distribution`'s soft
   *  Gaussian blend; tomorrow: anything that uses cluster population).
   *
   *  Range [-1, +1]:
   *    -1.0: k ≈ 1/e — flatten weights toward uniform. All zones
   *          contribute more equally — minority colors get equal voice.
   *     0.0 (default): k = 1 — natural weights unchanged.
   *    +1.0: k ≈ e — exaggerate dominance. High-population clusters
   *          dominate even more; minorities recede.
   *
   *  "Tighten" the zones (make them more similar) ↔ slide toward −1.
   *  "Loosen" (let the source's natural prevalence show through more) ↔
   *  slide toward +1. */
  readonly zoneRatio?: number;
  /** Phase 4.5m/n/o/p — Temperature. IMAGE-RELATIVE contrast stretch in
   *  the warm/cool direction. The image's own estimated output-warmth
   *  median is the neutral center; pixels' "warmness" is measured
   *  relative to that center, not relative to Oklab's absolute warm axis.
   *
   *  This solves the "if the image is mostly warm, cranking warm does
   *  nothing" problem: even an all-warm image has pixels that are
   *  less-warm-than-median (image-relatively cool) and more-warm-than-
   *  median (image-relatively warm). Temperature operates on those
   *  relative distinctions.
   *
   *  Range [-1, +1]:
   *    -1.0: pull image-relative-warm pixels DOWN toward the median
   *          (warms compress; cools untouched)
   *     0.0 (default): no change
   *    +1.0: push image-relative-warm pixels UP away from the median
   *          (warms stretch; cools untouched)
   *
   *  Negative t mirrors: pulls image-relative-cool pixels UP toward
   *  median (cools compress; warms untouched) — wait, that's wrong.
   *  Actually: negative t pushes image-relative-COOL pixels DOWN (more
   *  cool); image-relative-WARM pixels untouched. Symmetric.
   *
   *  Same-polarity pixels are always untouched. Pixels straddling the
   *  median get continuously-varying treatment via the sensitivity
   *  exponent. */
  readonly temperature?: number;
  /** Phase 4.5p — Temperature Sensitivity. Controls how sharp the
   *  warm/cool split is around the image's median warmth. Applied as
   *  a power exponent on |relativeWarmth|:
   *
   *    sensitivity ∈ [0, 1]
   *    exp = 3^(1 − 2·sensitivity)
   *    relWarmth_adj = sign(relWarmth) × |relWarmth|^exp
   *
   *  Range [0, 1]:
   *    0.0: exp = 3 — very SOFT split; pixels near median get little
   *         change, the effect is concentrated on extreme outliers
   *    0.5 (default): exp = 1 — linear, no sensitivity adjustment
   *    1.0: exp = 1/3 — very SHARP split; even pixels slightly past
   *         median get strong boost, producing distinct warm/cool zones */
  readonly temperatureSensitivity?: number;
  /** Phase 4.5l — Zone Edge Softness. How sharp the boundaries between
   *  source clusters are during zone routing. 0 = hard pick (argmin —
   *  matches Phase 4.5j behavior). 1 = wide gaussian blur across
   *  neighbouring clusters. Only takes effect when zoneInfluence > 0.
   *  Short-circuits to the existing argmin path when value < 0.005,
   *  preserving byte-exact bakes for presets that use the default. */
  readonly zoneEdgeSoftness?: number;
  /** Phase 4.5l — Zone Edge Shift. Slides the K-1 boundary midpoints
   *  between adjacent source clusters along the target L axis.
   *
   *  Range [-1, +1]:
   *    -1: boundaries pulled toward L=0 (shadow zones squeezed; mid/
   *        highlight zones expand to cover more of target L)
   *     0 (default): boundaries at natural sorted-cluster midpoints
   *        (matches Phase 4.5j behavior exactly)
   *    +1: boundaries pushed toward L=1 (highlight zones squeezed)
   *
   *  Bias function `sin(π × (i+1)/K)` makes inner boundaries move more
   *  than outer boundaries — keeps the extreme zones from collapsing
   *  to zero width.
   *
   *  Captures the user's "MOVE those edges to COMPRESS" intent. Moving
   *  a boundary from L=0.5 to L=0.25 automatically compresses target's
   *  [0, 0.5] L range into the [0, 0.25] routing band; that "compression"
   *  is just endpoint sliding on the routing function. */
  readonly zoneEdgeShift?: number;
  // Future toggles (Phase 5+) added here:
  //   readonly stochasticPerL?: boolean;
  //   readonly conditionalCdf?: boolean;
  //   readonly slicedOt?: boolean;
}

export interface SmashControls {
  readonly global: number;
  readonly traits: TraitAmounts;
  readonly perBand?: Readonly<Record<number, Partial<TraitAmounts>>>;
  readonly compression: number;
  readonly expansion: number;
  readonly outlierGuard: number;
  readonly bandSoftness: number;
  readonly bandCount: 3 | 5 | 7;
  readonly bandAxis: BandAxis;
  /** v1.21 Phase 4.5+ — colorization toggle state. Optional for backward
   *  compatibility; engine treats undefined as `{ hueByLuma: true }`. */
  readonly colorization?: ColorizationOptions;
  /** v1.21 Phase 4.5c — number of times applyTransform iterates per pixel.
   *  Compounding effect: each pass re-runs the transform on the previous
   *  output, pushing chroma further up source's CDF. 1 = current behavior;
   *  2-3 = the "stale-preview" vivid look baked into the LUT. Clamped to
   *  [1, 4] at apply-time. Optional for backward compat — undefined = 1. */
  readonly passes?: number;
}

/** Sentinel kinds in a persisted ColorSmash preset. */
export type SmashPresetKind = 'match' | 'smash';

/** Persisted preset. Lives next to the future `.colorsmash` extension. */
export interface SmashPreset {
  readonly format: 'colorsmash/preset';
  readonly version: number;
  readonly kind: SmashPresetKind;
  readonly thumbnail: string;
  readonly dna?: SourceDNA;
  // `controls` is intentionally unioned with `unknown` for now — the free
  // MatchControls type will be reconciled when the preset format is unified
  // in Phase 0 step 5 (see masterplan §5 Phase 0).
  readonly controls: SmashControls | unknown;
  readonly cube?: string;
  readonly notes?: string;
}

/** Decision-trace data produced for the Smash Audit panel. */
export interface SmashAudit {
  readonly traitContributions: Readonly<Record<keyof TraitAmounts, number>>;
  readonly bandsUsed: readonly { readonly index: number; readonly fellBack: boolean }[];
  readonly clustersAnchored: readonly number[];
  readonly clustersLocked: readonly number[];
  readonly gamutClipped: boolean;
  readonly elapsedMs: number;
}

/** Empty-DNA factory for tests / placeholders. */
export function emptySourceDNA(): SourceDNA {
  return {
    version: SMASH_SCHEMA_VERSION,
    capturedAt: new Date(0).toISOString(),
    bands: [],
    clusters: [],
    global: {
      meanOklab: [0, 0, 0],
      medianOklab: [0, 0, 0],
      chromaMean: 0,
      chromaMedian: 0,
      neutralRatio: 0,
      accentRatio: 0,
    },
  };
}

/** A pair of source/target bands assumed to correspond (same axis index). */
export interface BandPair {
  readonly source: BandStats;
  readonly target: BandStats;
  /** Whether this pair has enough data on both sides to be used. False when
   *  either band has sampleCount below the fallback threshold. */
  readonly viable: boolean;
}

/** Result of pairing SourceDNA with TargetStructure. */
export interface ImagePairProfile {
  readonly source: SourceDNA;
  readonly target: TargetStructure;
  readonly bands: readonly BandPair[];
  /** Bands where viability is false; the engine will fall back to identity here. */
  readonly weakBands: readonly number[];
}
