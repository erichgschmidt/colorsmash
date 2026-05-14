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
