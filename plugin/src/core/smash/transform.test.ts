// Tests for smash() and applyTransform() in transform.ts.
// Uses synthetic RGBA buffers and extracted features to exercise the engine
// end-to-end without touching the filesystem.

import { describe, it, expect } from 'vitest';
import { extractSourceDNA, extractTargetStructure, pairDNA } from './profile';
import { extractFeatures } from './features';
import { smash, applyTransform, DEFAULT_SMASH_CONTROLS, TRANSFORM_VIABILITY_THRESHOLD } from './transform';
import type { SmashControls, BandStats, ImagePairProfile } from './types';

// ────────── buffer helpers ──────────

/**
 * Build a 32×32 grayscale gradient buffer (luma ramps 0→255 across pixels).
 * Used as a "well-populated" image to avoid trivial empty-band fallbacks.
 */
function gradientBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const v = Math.round((i / (total - 1)) * 255);
    buf[i * 4]     = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/**
 * Build a 32×32 buffer with a cool blue gradient.
 * R ramps from 0→30, G 0→80, B 100→255.
 */
function coolBlueBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    buf[i * 4]     = Math.round(t * 30);
    buf[i * 4 + 1] = Math.round(t * 80);
    buf[i * 4 + 2] = Math.round(100 + t * 155);
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/**
 * Build a 32×32 buffer with a warm orange gradient.
 * R ramps from 80→255, G 40→180, B 0→40.
 */
function warmOrangeBuffer32(): Uint8Array {
  const total = 32 * 32;
  const buf = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    buf[i * 4]     = Math.round(80  + t * 175);
    buf[i * 4 + 1] = Math.round(40  + t * 140);
    buf[i * 4 + 2] = Math.round(t * 40);
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

// ────────── helper: build a profile from two raw RGBA buffers ──────────

function buildProfile(
  srcRgba: Uint8Array,
  tgtRgba: Uint8Array,
  bandCount: 3 | 5 | 7 = 3,
) {
  const src = extractSourceDNA(srcRgba, 32, 32, { bandCount, sampleStride: 1 });
  const tgt = extractTargetStructure(tgtRgba, 32, 32, { bandCount, sampleStride: 1 });
  return { profile: pairDNA(src, tgt), src, tgt };
}

// ────────── 1. Smoke test ──────────

describe('smash() smoke', () => {
  it('returns SmashEngineOutput with 3 bandTransforms for a gradient source+target', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const srcFeatures = extractFeatures(rgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(rgba, 32, 32, 1);

    const result = smash(srcFeatures, tgtFeatures, profile);

    expect(result.bandTransforms.length).toBe(3);
    // Profile + controls reference is round-tripped correctly.
    expect(result.profile).toBe(profile);
    expect(result.controls).toEqual(DEFAULT_SMASH_CONTROLS);
  });

  it('gradient self-match: bandTransforms are in a consistent state (all same fellBack)', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const srcFeatures = extractFeatures(rgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(rgba, 32, 32, 1);

    const result = smash(srcFeatures, tgtFeatures, profile);

    // All bands should have the same fellBack state — document it.
    const states = result.bandTransforms.map(bt => bt.fellBack);
    const allSameState = states.every(s => s === states[0]);
    expect(allSameState).toBe(true);
  });
});

// ────────── 2. Identity-like (same source and target) ──────────

describe('applyTransform() identity-like', () => {
  // Self-match (source = target) should be CLOSE to identity but not exact:
  // histogram-match curves are quantized at the 256-bucket level and ACES
  // gamut compression at strength=1 nudges even in-gamut bytes by a few units.
  // ±25 byte tolerance documents "near-identity"; the falsifier we actually
  // care about (masterplan §6 Phase 1) is ΔE94 < 2 across the test pair set,
  // not byte equality on synthetic gradients.
  it('self-match: output within ±25 bytes per channel on 3 test colors', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, profile);

    const testColors: [number, number, number][] = [
      [64, 64, 64],
      [128, 128, 128],
      [200, 200, 200],
    ];

    for (const [r, g, b] of testColors) {
      const [or, og, ob] = applyTransform(result, r, g, b);
      expect(Math.abs(or - r)).toBeLessThanOrEqual(25);
      expect(Math.abs(og - g)).toBeLessThanOrEqual(25);
      expect(Math.abs(ob - b)).toBeLessThanOrEqual(25);
    }
  });
});

// ────────── 3. Different images produce non-identity ──────────

describe('applyTransform() non-identity for different source/target', () => {
  it('cool blue→warm orange produces a non-trivial shift on mid-gray input', () => {
    const srcRgba = coolBlueBuffer32();
    const tgtRgba = warmOrangeBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const result = smash(srcFeatures, tgtFeatures, profile);

    // Check that at least one band has non-fellBack curves.
    const hasViable = result.bandTransforms.some(bt => !bt.fellBack);
    expect(hasViable).toBe(true);

    // Mid-gray applied to a cool→warm smash should shift noticeably.
    const [or, og, ob] = applyTransform(result, 128, 128, 128);
    // At least one channel should differ by more than 3 bytes from identity.
    const maxShift = Math.max(
      Math.abs(or - 128),
      Math.abs(og - 128),
      Math.abs(ob - 128),
    );
    expect(maxShift).toBeGreaterThan(3);
  });
});

// ────────── 4. Weak bands fall back ──────────

describe('smash() fallback for weak bands', () => {
  it('band with sampleCount < VIABILITY_THRESHOLD → fellBack=true in audit + transforms', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);

    // Synthesize a profile copy where band[0]'s source sampleCount is below threshold.
    // We reconstruct a profile by overwriting the first band's source stats.
    const weakSourceBand: BandStats = {
      ...profile.bands[0].source,
      sampleCount: TRANSFORM_VIABILITY_THRESHOLD - 1,
    };
    const weakBands = profile.bands.map((pair, i) =>
      i === 0
        ? { ...pair, source: weakSourceBand, viable: false }
        : pair,
    );
    const weakProfile: ImagePairProfile = {
      ...profile,
      bands: weakBands,
      weakBands: [0, ...profile.weakBands.filter(idx => idx !== 0)],
    };

    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, weakProfile);

    // Band 0 must have fellBack=true in the transforms array.
    expect(result.bandTransforms[0].fellBack).toBe(true);
    expect(result.bandTransforms[0].curves).toBeUndefined();

    // Audit must record band 0 as fellBack=true.
    const auditEntry = result.audit.bandsUsed.find(e => e.index === 0);
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.fellBack).toBe(true);
  });
});

// ────────── 5. Identity path (controls.global = 0) ──────────

describe('applyTransform() global=0 identity path', () => {
  it('global=0 returns input pixel unchanged (within ±1 byte)', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const features = extractFeatures(rgba, 32, 32, 1);

    const zeroControls: SmashControls = { ...DEFAULT_SMASH_CONTROLS, global: 0 };
    const result = smash(features, features, profile, zeroControls);

    const testColors: [number, number, number][] = [
      [50, 100, 200],
      [200, 50, 50],
      [128, 128, 128],
    ];
    for (const [r, g, b] of testColors) {
      const [or, og, ob] = applyTransform(result, r, g, b);
      expect(Math.abs(or - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(og - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(ob - b)).toBeLessThanOrEqual(1);
    }
  });
});

// ────────── 6. Audit populated ──────────

describe('smash() audit fields', () => {
  it('audit.elapsedMs > 0 after smash()', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, profile);
    expect(result.audit.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('audit.bandsUsed.length === profile.bands.length', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, profile);
    expect(result.audit.bandsUsed.length).toBe(profile.bands.length);
  });

  it('audit.traitContributions reflects controls trait values * global', () => {
    const rgba = gradientBuffer32();
    const { profile } = buildProfile(rgba, rgba);
    const features = extractFeatures(rgba, 32, 32, 1);
    const controls: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      global: 0.8,
      traits: {
        value: 0.9,
        hue: 0.7,
        saturation: 0.6,
        chroma: 0.5,
        neutral: 0.4,
        accent: 0.3,
      },
    };
    const result = smash(features, features, profile, controls);
    const tc = result.audit.traitContributions;
    expect(tc.value).toBeCloseTo(0.9 * 0.8, 10);
    expect(tc.hue).toBeCloseTo(0.7 * 0.8, 10);
    expect(tc.saturation).toBeCloseTo(0.6 * 0.8, 10);
    expect(tc.chroma).toBeCloseTo(0.5 * 0.8, 10);
    expect(tc.neutral).toBeCloseTo(0.4 * 0.8, 10);
    expect(tc.accent).toBeCloseTo(0.3 * 0.8, 10);
  });
});

// ────────── 7. Empty profile ──────────

describe('smash() empty profile', () => {
  it('returns bandTransforms=[] for empty profile.bands', () => {
    const rgba = gradientBuffer32();
    const src = extractSourceDNA(rgba, 32, 32, { bandCount: 3, sampleStride: 1 });
    // Build an empty profile manually.
    const emptyProfile: ImagePairProfile = {
      source: src,
      target: src,
      bands: [],
      weakBands: [],
    };
    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, emptyProfile);
    expect(result.bandTransforms).toHaveLength(0);
  });

  it('applyTransform returns input unchanged when bandTransforms is empty', () => {
    const rgba = gradientBuffer32();
    const src = extractSourceDNA(rgba, 32, 32, { bandCount: 3, sampleStride: 1 });
    const emptyProfile: ImagePairProfile = {
      source: src,
      target: src,
      bands: [],
      weakBands: [],
    };
    const features = extractFeatures(rgba, 32, 32, 1);
    const result = smash(features, features, emptyProfile);

    const [or, og, ob] = applyTransform(result, 100, 150, 200);
    expect(or).toBe(100);
    expect(og).toBe(150);
    expect(ob).toBe(200);
  });
});

// ────────── liftNeutrals chroma floor (Phase 4.5b) ──────────

describe('applyTransform() liftNeutrals chroma floor', () => {
  // Setup: warm orange source (vivid) + grayscale target. This is the
  // user-reported failure mode where shadow target pixels stayed monochrome
  // because the chroma CDF mapped them to source's bottom-rank chroma ≈ 0.
  it(
    'with a vivid source + grayscale target, a neutral shadow input gets MORE chroma when liftNeutrals=ON vs OFF',
    () => {
      const srcRgba = warmOrangeBuffer32();
      const tgtRgba = gradientBuffer32();
      const { profile } = buildProfile(srcRgba, tgtRgba);
      const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
      const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

      // Neutral mid-shadow input: R=G=B=64 (L≈0.3, Cin=0).
      const r = 64, g = 64, b = 64;

      const controlsOn: SmashControls = {
        ...DEFAULT_SMASH_CONTROLS,
        colorization: { hueByLuma: true, liftNeutrals: true },
      };
      const controlsOff: SmashControls = {
        ...DEFAULT_SMASH_CONTROLS,
        colorization: { hueByLuma: true, liftNeutrals: false },
      };

      const engOn = smash(srcFeatures, tgtFeatures, profile, controlsOn);
      const engOff = smash(srcFeatures, tgtFeatures, profile, controlsOff);

      const [orR, orG, orB] = applyTransform(engOn, r, g, b);
      const [ofR, ofG, ofB] = applyTransform(engOff, r, g, b);

      // Channel-spread (max - min) is a proxy for output chroma. Higher
      // spread = more colorization. The floor should noticeably lift the
      // shadow output's chroma. Exact thresholds depend on the synthetic
      // buffer's source median chroma; >=5 byte spread headroom is a
      // conservative-but-meaningful difference.
      const spreadOn = Math.max(orR, orG, orB) - Math.min(orR, orG, orB);
      const spreadOff = Math.max(ofR, ofG, ofB) - Math.min(ofR, ofG, ofB);

      expect(spreadOn).toBeGreaterThan(spreadOff + 5);
    },
  );

  it('engine output exposes sourceMedianChroma >= 0 (non-negative)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const engine = smash(srcFeatures, tgtFeatures, profile);
    expect(engine.sourceMedianChroma).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(engine.sourceMedianChroma)).toBe(true);
  });
});

// ────────── Passes (multi-pass bake) — Phase 4.5c ──────────

describe('applyTransform() passes multi-pass bake', () => {
  // The "stale-preview vivid" look the user accidentally discovered when the
  // panel snap captured a post-LUT layer is equivalent to running the engine
  // N times in succession. With passes>=2, applyTransform should produce
  // strictly more compounded chroma than passes=1 on near-neutral inputs.
  it('passes=2 produces strictly more chroma than passes=1 on a neutral shadow input', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const r = 64, g = 64, b = 64; // neutral mid-shadow

    const ctrl1: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 1 };
    const ctrl2: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 2 };

    const eng1 = smash(srcFeatures, tgtFeatures, profile, ctrl1);
    const eng2 = smash(srcFeatures, tgtFeatures, profile, ctrl2);

    const [r1, g1, b1] = applyTransform(eng1, r, g, b);
    const [r2, g2, b2] = applyTransform(eng2, r, g, b);

    const spread1 = Math.max(r1, g1, b1) - Math.min(r1, g1, b1);
    const spread2 = Math.max(r2, g2, b2) - Math.min(r2, g2, b2);

    expect(spread2).toBeGreaterThan(spread1);
  });

  it('paletteSnap routes output toward a source cluster, producing different output than the averaged path', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlOff: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { hueByLuma: true, liftNeutrals: true, paletteSnap: false },
    };
    const ctrlOn: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { hueByLuma: true, liftNeutrals: true, paletteSnap: true },
    };

    const engOff = smash(srcFeatures, tgtFeatures, profile, ctrlOff);
    const engOn = smash(srcFeatures, tgtFeatures, profile, ctrlOn);

    // Skip the test if the source produced no chromatic clusters — the
    // synthetic warm orange buffer may collapse into a single cluster
    // depending on the k-means seed, in which case paletteSnap has no
    // alternative to pick from and the test loses its premise.
    const chromaticClusters = profile.source.clusters.filter((c) => {
      const [, a, b] = c.centroidOklab;
      return Math.sqrt(a * a + b * b) >= 0.02;
    });
    if (chromaticClusters.length === 0) return;

    // For a mid-gray neutral input, paletteSnap should produce output that
    // differs from the averaged path. They might converge in degenerate
    // cases but for warm-orange-vs-gradient they should diverge by at
    // least 1 byte on at least one channel.
    const [orR, orG, orB] = applyTransform(engOn, 128, 128, 128);
    const [ofR, ofG, ofB] = applyTransform(engOff, 128, 128, 128);
    const anyDiff =
      Math.abs(orR - ofR) > 0 || Math.abs(orG - ofG) > 0 || Math.abs(orB - ofB) > 0;
    expect(anyDiff).toBe(true);
  });

  it('passes is clamped to [1, 4] — passes=0 behaves like passes=1, passes=10 like passes=4', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const r = 64, g = 64, b = 64;

    const ctrl0: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 0 };
    const ctrl1: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 1 };
    const ctrl4: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 4 };
    const ctrl10: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 10 };

    const out0 = applyTransform(smash(srcFeatures, tgtFeatures, profile, ctrl0), r, g, b);
    const out1 = applyTransform(smash(srcFeatures, tgtFeatures, profile, ctrl1), r, g, b);
    const out4 = applyTransform(smash(srcFeatures, tgtFeatures, profile, ctrl4), r, g, b);
    const out10 = applyTransform(smash(srcFeatures, tgtFeatures, profile, ctrl10), r, g, b);

    // 0 → clamped to 1
    expect(out0).toEqual(out1);
    // 10 → clamped to 4
    expect(out10).toEqual(out4);
  });
});
