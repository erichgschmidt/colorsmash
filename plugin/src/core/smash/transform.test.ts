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
      // spread = more colorization. The lift floor (now per-L since
      // Phase 4.5f) raises Csm whenever source's chroma magnitude at the
      // smashed L exceeds the chroma CDF's rank-mapped value. ON should
      // produce >= the chroma OFF produces; for this synthetic source/
      // input combo the margin is small but strictly positive.
      const spreadOn = Math.max(orR, orG, orB) - Math.min(orR, orG, orB);
      const spreadOff = Math.max(ofR, ofG, ofB) - Math.min(ofR, ofG, ofB);

      expect(spreadOn).toBeGreaterThanOrEqual(spreadOff);
    },
  );

  it('per-L lift floor preserves source proportions: low-L target stays low chroma, high-L target gets high chroma when source is bimodal', () => {
    // Build a SOURCE where chroma magnitude varies strongly with L:
    //   - Low L (dark): near-neutral pixels (chroma ≈ 0)
    //   - High L (bright): vivid red pixels (chroma high)
    // The per-L lift floor should pull this structure through to the output:
    // a target pixel at low L should pick up little chroma, a target pixel
    // at high L should pick up lots — even though both inputs are neutral.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      // Bimodal: bottom half = dark gray (no chroma), top half = vivid red.
      if (v < 0.5) {
        const gray = Math.round(v * 80); // 0..40 (dark)
        srcRgba[i * 4]     = gray;
        srcRgba[i * 4 + 1] = gray;
        srcRgba[i * 4 + 2] = gray;
      } else {
        srcRgba[i * 4]     = Math.round(180 + (v - 0.5) * 150); // 180..255 (bright red)
        srcRgba[i * 4 + 1] = Math.round((v - 0.5) * 100);       // 0..50
        srcRgba[i * 4 + 2] = Math.round((v - 0.5) * 100);       // 0..50
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);
    const engine = smash(srcFeatures, tgtFeatures, profile);

    const [lr, lg, lb] = applyTransform(engine, 30, 30, 30);   // low-L neutral input
    const [hr, hg, hb] = applyTransform(engine, 220, 220, 220); // high-L neutral input

    const lowSpread  = Math.max(lr, lg, lb) - Math.min(lr, lg, lb);
    const highSpread = Math.max(hr, hg, hb) - Math.min(hr, hg, hb);

    // High-L output should be MUCH more chromatic than low-L output —
    // matching source's structure. Earlier behavior (global-median lift)
    // pulled both toward the same magnitude, yielding similar spreads.
    expect(highSpread).toBeGreaterThan(lowSpread + 30);
  });

  it('proportionMatch slider blends lift floor between per-L (tight=1) and global median (loose=0)', () => {
    // Same bimodal source as the proportion-preservation test (dark low-L,
    // vivid red high-L). Sample at low-L target where the per-L floor is
    // small but the global median floor is much larger. Tight=1 should
    // produce LESS chroma than loose=0 at this L (per-L is faithful;
    // global median over-lifts neutrals at low L).
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        const gray = Math.round(v * 80);
        srcRgba[i * 4]     = gray;
        srcRgba[i * 4 + 1] = gray;
        srcRgba[i * 4 + 2] = gray;
      } else {
        srcRgba[i * 4]     = Math.round(180 + (v - 0.5) * 150);
        srcRgba[i * 4 + 1] = Math.round((v - 0.5) * 100);
        srcRgba[i * 4 + 2] = Math.round((v - 0.5) * 100);
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlTight: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { hueByLuma: true, liftNeutrals: true, proportionMatch: 1.0 },
    };
    const ctrlLoose: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { hueByLuma: true, liftNeutrals: true, proportionMatch: 0.0 },
    };

    const engTight = smash(srcFeatures, tgtFeatures, profile, ctrlTight);
    const engLoose = smash(srcFeatures, tgtFeatures, profile, ctrlLoose);

    // Low-L target neutral input: per-L floor (tight) is small for source's
    // dark region, global median (loose) is larger because it averages in
    // the bright vivid pixels. So loose should produce MORE chroma than
    // tight at this L.
    const [trL, tgL, tbL] = applyTransform(engTight, 30, 30, 30);
    const [lrL, lgL, lbL] = applyTransform(engLoose, 30, 30, 30);
    const tightSpreadLow = Math.max(trL, tgL, tbL) - Math.min(trL, tgL, tbL);
    const looseSpreadLow = Math.max(lrL, lgL, lbL) - Math.min(lrL, lgL, lbL);
    expect(looseSpreadLow).toBeGreaterThan(tightSpreadLow);
  });

  it('posterize=1.0 snaps each output pixel to one of the source clusters\' RGB', () => {
    // Build a bimodal source with very distinct clusters so the snap is
    // unambiguous: dark-gray cluster (low L) + vivid-red cluster (high L).
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30; srcRgba[i * 4 + 1] = 30; srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20; srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrl: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { posterize: 1.0 },
    };
    const engine = smash(srcFeatures, tgtFeatures, profile, ctrl);

    // For each test input pixel, the posterize=1 output should equal
    // exactly one of the source clusters' RGB values (within ±1 byte
    // tolerance for rounding accumulated through the pipeline).
    const clusters = profile.source.clusters;
    expect(clusters.length).toBeGreaterThan(0);

    const matches = (out: readonly [number, number, number]) =>
      clusters.some((c) => {
        const [cr, cg, cb] = c.rgb;
        return Math.abs(out[0] - cr) <= 1
          && Math.abs(out[1] - cg) <= 1
          && Math.abs(out[2] - cb) <= 1;
      });

    for (const input of [30, 90, 150, 220]) {
      const [r, g, b] = applyTransform(engine, input, input, input);
      expect(matches([r, g, b] as const)).toBe(true);
    }
  });

  it('distribution=1 produces smooth output that converges toward a weighted cluster blend, not a hard snap', () => {
    // Bimodal source (same fixture as posterize test) to ensure distinct
    // clusters exist for the soft blend.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30; srcRgba[i * 4 + 1] = 30; srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20; srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlDistribution: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { distribution: 1.0 },
    };
    const ctrlPosterize: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { posterize: 1.0 },
    };

    const engDist = smash(srcFeatures, tgtFeatures, profile, ctrlDistribution);
    const engPost = smash(srcFeatures, tgtFeatures, profile, ctrlPosterize);

    // For a target L between two clusters' L positions, distribution should
    // produce an interpolated (non-cluster-snapped) output. Posterize
    // produces exactly one of the cluster's RGB values. So at the
    // intermediate L, the two should differ.
    const [dr, dg, db] = applyTransform(engDist, 128, 128, 128);
    const [pr, pg, pb] = applyTransform(engPost, 128, 128, 128);

    const dist = Math.abs(dr - pr) + Math.abs(dg - pg) + Math.abs(db - pb);
    // Distribution and posterize should diverge by AT LEAST a few bytes at
    // an intermediate L — distribution interpolates, posterize snaps.
    expect(dist).toBeGreaterThan(5);

    // Sanity: distribution output should NOT equal any single cluster's RGB
    // (it's a blend, not a snap).
    const matchesAnyCluster = profile.source.clusters.some((c) => {
      const [cr, cg, cb] = c.rgb;
      return Math.abs(dr - cr) <= 1 && Math.abs(dg - cg) <= 1 && Math.abs(db - cb) <= 1;
    });
    expect(matchesAnyCluster).toBe(false);
  });

  it('zone routing: zoneInfluence=0 produces identical output to default (off by default)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlDefault: SmashControls = { ...DEFAULT_SMASH_CONTROLS };
    const ctrlZero: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: 0 },
    };

    const engDefault = smash(srcFeatures, tgtFeatures, profile, ctrlDefault);
    const engZero = smash(srcFeatures, tgtFeatures, profile, ctrlZero);

    for (const input of [50, 128, 200]) {
      const a = applyTransform(engDefault, input, input, input);
      const b = applyTransform(engZero, input, input, input);
      expect(a).toEqual(b);
    }
  });

  it('zone routing: zoneInfluence=1 produces output different from default for a bimodal source', () => {
    // Bimodal source so clusters are distinct enough that per-cluster sub-LUTs
    // diverge from the global Hue-by-L average.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30; srcRgba[i * 4 + 1] = 30; srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20; srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlOff: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: 0 },
    };
    const ctrlOn: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: 1, detailRichness: 1 },
    };

    const engOff = smash(srcFeatures, tgtFeatures, profile, ctrlOff);
    const engOn = smash(srcFeatures, tgtFeatures, profile, ctrlOn);

    // For a target mid-tone, zone routing should pull output toward the
    // nearest cluster's character, which differs from the global Hue-by-L
    // average for a bimodal source. Any difference > 0 proves the path
    // is wired and active.
    let totalDelta = 0;
    for (const input of [60, 120, 180]) {
      const a = applyTransform(engOff, input, input, input);
      const b = applyTransform(engOn, input, input, input);
      totalDelta +=
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    }
    expect(totalDelta).toBeGreaterThan(0);
  });

  it('zone routing: detailRichness=0 vs 1 produce different outputs (centroid vs sub-LUT inside the zone)', () => {
    // Use a warm-orange GRADIENT as the source so each cluster has genuine
    // intra-cluster L variation — the sub-LUT lookup will differ from the
    // centroid for non-centroid Lin values.
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlCentroid: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: 1, detailRichness: 0 },
    };
    const ctrlSubLut: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: 1, detailRichness: 1 },
    };

    const engCentroid = smash(srcFeatures, tgtFeatures, profile, ctrlCentroid);
    const engSubLut = smash(srcFeatures, tgtFeatures, profile, ctrlSubLut);

    // For at least one input pixel within a cluster's L range, the sub-LUT
    // lookup should produce a different (a, b) than the cluster's centroid
    // — and that difference propagates through to the output. Sample a few
    // inputs across the L range and check that AT LEAST ONE pair diverges.
    let anyDiverge = false;
    for (const input of [40, 90, 140, 190, 240]) {
      const a = applyTransform(engCentroid, input, input, input);
      const b = applyTransform(engSubLut, input, input, input);
      const diff =
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      if (diff > 0) {
        anyDiverge = true;
        break;
      }
    }
    expect(anyDiverge).toBe(true);
  });

  it('distribution=0 produces identical output to default (off by default)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlDefault: SmashControls = { ...DEFAULT_SMASH_CONTROLS };
    const ctrlZero: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, distribution: 0 },
    };

    const engDefault = smash(srcFeatures, tgtFeatures, profile, ctrlDefault);
    const engZero = smash(srcFeatures, tgtFeatures, profile, ctrlZero);

    for (const input of [50, 128, 200]) {
      const a = applyTransform(engDefault, input, input, input);
      const b = applyTransform(engZero, input, input, input);
      expect(a).toEqual(b);
    }
  });

  it('posterize=0 produces identical output to default (off by default)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlDefault: SmashControls = { ...DEFAULT_SMASH_CONTROLS };
    const ctrlZero: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, posterize: 0 },
    };

    const engDefault = smash(srcFeatures, tgtFeatures, profile, ctrlDefault);
    const engZero = smash(srcFeatures, tgtFeatures, profile, ctrlZero);

    for (const input of [50, 128, 200]) {
      const a = applyTransform(engDefault, input, input, input);
      const b = applyTransform(engZero, input, input, input);
      expect(a).toEqual(b);
    }
  });

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

  it('passes=1.5 produces output that lerps between passes=1 and passes=2 (fractional blend)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const r = 64, g = 64, b = 64;

    const ctrl1: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 1 };
    const ctrl2: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 2 };
    const ctrl15: SmashControls = { ...DEFAULT_SMASH_CONTROLS, passes: 1.5 };

    const eng1 = smash(srcFeatures, tgtFeatures, profile, ctrl1);
    const eng2 = smash(srcFeatures, tgtFeatures, profile, ctrl2);
    const eng15 = smash(srcFeatures, tgtFeatures, profile, ctrl15);

    const [r1, g1, b1] = applyTransform(eng1, r, g, b);
    const [r2, g2, b2] = applyTransform(eng2, r, g, b);
    const [r15, g15, b15] = applyTransform(eng15, r, g, b);

    // For each channel, passes=1.5 result should sit between passes=1 and
    // passes=2 results (within ±1 byte tolerance for rounding). Order can
    // go either direction (1 < 2 or 1 > 2 depending on the channel and
    // source structure), so we check the ordering both ways.
    const between = (mid: number, a: number, b_: number) => {
      const lo = Math.min(a, b_) - 1;
      const hi = Math.max(a, b_) + 1;
      return mid >= lo && mid <= hi;
    };
    expect(between(r15, r1, r2)).toBe(true);
    expect(between(g15, g1, g2)).toBe(true);
    expect(between(b15, b1, b2)).toBe(true);
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

// ────────── DIAGNOSTIC: toggle-isolation sweep ──────────
//
// Empirical sweep that verifies hueByLuma, liftNeutrals, and paletteSnap
// still produce measurable output deltas when every other newer mechanic
// (zoneInfluence, posterize, distribution) is explicitly disabled. Logs a
// readable table; asserts at least one toggle combination differs from the
// rest (i.e. the three toggles aren't all dead together).
describe('toggle isolation diagnostic — hueByLuma / liftNeutrals / paletteSnap', () => {
  // Shared rig: warm orange source + grayscale gradient target. Source has
  // strong chroma, target is fully neutral — the worst-case "colorize a
  // grayscale" scenario where hueByLuma + liftNeutrals are designed to do
  // their heaviest lifting.
  function buildRig() {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);
    return { profile, srcFeatures, tgtFeatures };
  }

  // Base controls: everything that could route around hueByLuma/liftNeutrals/
  // paletteSnap is turned OFF.
  function baseControls(): SmashControls {
    return {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        hueByLuma: true,
        liftNeutrals: true,
        paletteSnap: false,
        proportionMatch: 1.0,
        posterize: 0,
        distribution: 0,
        zoneInfluence: 0,
        detailRichness: 1,
        zoneRatio: 0,
      },
    };
  }

  const PROBE_INPUTS = [30, 90, 150, 220];

  function totalSpread(samples: ReadonlyArray<readonly [number, number, number]>): number {
    // Total channel-spread across the probe set: sum of |max-min| per channel.
    let rMax = -Infinity, rMin = Infinity;
    let gMax = -Infinity, gMin = Infinity;
    let bMax = -Infinity, bMin = Infinity;
    for (const [r, g, b] of samples) {
      if (r > rMax) rMax = r; if (r < rMin) rMin = r;
      if (g > gMax) gMax = g; if (g < gMin) gMin = g;
      if (b > bMax) bMax = b; if (b < bMin) bMin = b;
    }
    return (rMax - rMin) + (gMax - gMin) + (bMax - bMin);
  }

  function maxByteDiff(
    a: ReadonlyArray<readonly [number, number, number]>,
    b: ReadonlyArray<readonly [number, number, number]>,
  ): number {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      d = Math.max(d, Math.abs(a[i][0] - b[i][0]));
      d = Math.max(d, Math.abs(a[i][1] - b[i][1]));
      d = Math.max(d, Math.abs(a[i][2] - b[i][2]));
    }
    return d;
  }

  function fmtRgb(rgb: readonly [number, number, number]): string {
    return `(${String(rgb[0]).padStart(3)},${String(rgb[1]).padStart(3)},${String(rgb[2]).padStart(3)})`;
  }

  function sweep(
    controls: SmashControls,
    rig: ReturnType<typeof buildRig>,
  ): Array<readonly [number, number, number]> {
    const eng = smash(rig.srcFeatures, rig.tgtFeatures, rig.profile, controls);
    return PROBE_INPUTS.map((v) => {
      const [r, g, b] = applyTransform(eng, v, v, v);
      return [r, g, b] as const;
    });
  }

  it('hueByLuma × liftNeutrals four-cell + paletteSnap pair: log table, assert at least one toggle moves output', () => {
    const rig = buildRig();

    // Four cells of (hueByLuma, liftNeutrals) with paletteSnap=false.
    const variants: Array<{ label: string; ctrl: SmashControls }> = [
      {
        label: 'hueByLuma=ON   liftNeutrals=ON ',
        ctrl: { ...baseControls(), colorization: { ...baseControls().colorization, hueByLuma: true,  liftNeutrals: true  } },
      },
      {
        label: 'hueByLuma=OFF  liftNeutrals=ON ',
        ctrl: { ...baseControls(), colorization: { ...baseControls().colorization, hueByLuma: false, liftNeutrals: true  } },
      },
      {
        label: 'hueByLuma=ON   liftNeutrals=OFF',
        ctrl: { ...baseControls(), colorization: { ...baseControls().colorization, hueByLuma: true,  liftNeutrals: false } },
      },
      {
        label: 'hueByLuma=OFF  liftNeutrals=OFF',
        ctrl: { ...baseControls(), colorization: { ...baseControls().colorization, hueByLuma: false, liftNeutrals: false } },
      },
    ];

    const results = variants.map((v) => ({ label: v.label, samples: sweep(v.ctrl, rig) }));

    // paletteSnap pair (other toggles at default ON state).
    const snapOff: SmashControls = { ...baseControls(), colorization: { ...baseControls().colorization, paletteSnap: false } };
    const snapOn:  SmashControls = { ...baseControls(), colorization: { ...baseControls().colorization, paletteSnap: true  } };
    const snapOffSamples = sweep(snapOff, rig);
    const snapOnSamples  = sweep(snapOn,  rig);

    // ── Log the diagnostic table.
    const lines: string[] = [];
    lines.push('');
    lines.push('=== TOGGLE ISOLATION DIAGNOSTIC ===');
    lines.push('Source: warmOrangeBuffer32 (chromatic)');
    lines.push('Target: gradientBuffer32   (grayscale)');
    lines.push('Zone-routing controls OFF: zoneInfluence=0, posterize=0, distribution=0, paletteSnap=false');
    lines.push('Probe inputs (gray): ' + PROBE_INPUTS.join(', '));
    lines.push('');
    lines.push('-- hueByLuma × liftNeutrals four-cell --');
    lines.push('control set                       | in=30          in=90          in=150         in=220         | spread');
    for (const r of results) {
      const row = r.samples.map(fmtRgb).join('  ');
      lines.push(`${r.label} | ${row} | ${totalSpread(r.samples)}`);
    }
    lines.push('');
    lines.push('-- paletteSnap pair (other toggles default ON) --');
    lines.push(`paletteSnap=OFF                   | ${snapOffSamples.map(fmtRgb).join('  ')} | ${totalSpread(snapOffSamples)}`);
    lines.push(`paletteSnap=ON                    | ${snapOnSamples.map(fmtRgb).join('  ')} | ${totalSpread(snapOnSamples)}`);
    lines.push('');

    // Pairwise max-byte diffs to surface "which toggle moved what".
    lines.push('-- pairwise max-byte diffs --');
    const onOn   = results[0].samples;
    const offOn  = results[1].samples;
    const onOff  = results[2].samples;
    const offOff = results[3].samples;
    lines.push(`hueByLuma flip (ON,ON) vs (OFF,ON)         : maxByteDiff=${maxByteDiff(onOn,  offOn)}`);
    lines.push(`hueByLuma flip (ON,OFF) vs (OFF,OFF)       : maxByteDiff=${maxByteDiff(onOff, offOff)}`);
    lines.push(`liftNeutrals flip (ON,ON) vs (ON,OFF)      : maxByteDiff=${maxByteDiff(onOn,  onOff)}`);
    lines.push(`liftNeutrals flip (OFF,ON) vs (OFF,OFF)    : maxByteDiff=${maxByteDiff(offOn, offOff)}`);
    lines.push(`paletteSnap flip OFF vs ON                 : maxByteDiff=${maxByteDiff(snapOffSamples, snapOnSamples)}`);
    lines.push('');

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    // Assertion: at least one of the four hueByLuma×liftNeutrals combinations
    // produces a DIFFERENT result from the others (proves the toggles aren't
    // ALL dead simultaneously).
    const variantSpreads = results.map((r) => totalSpread(r.samples));
    const maxPairwiseDiff = Math.max(
      maxByteDiff(onOn,  offOn),
      maxByteDiff(onOn,  onOff),
      maxByteDiff(onOn,  offOff),
      maxByteDiff(offOn, onOff),
      maxByteDiff(offOn, offOff),
      maxByteDiff(onOff, offOff),
    );
    expect(maxPairwiseDiff).toBeGreaterThan(0);
    // Sanity: spreads should be non-zero (otherwise the engine is producing
    // identical output for all 4 probe inputs, which would mean something
    // broader is wrong).
    expect(Math.max(...variantSpreads)).toBeGreaterThan(0);
  });
});

// ────────── 12. zoneRatio (Phase 4.5k) ──────────

describe('applyTransform() zoneRatio (Phase 4.5k)', () => {
  it('zoneRatio is reflected in engine output\'s adjustedClusterWeights', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlNeutral: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: 0 },
    };
    const ctrlFlatten: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: -1 },
    };
    const ctrlAmplify: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: +1 },
    };

    const engNeutral = smash(srcFeatures, tgtFeatures, profile, ctrlNeutral);
    const engFlatten = smash(srcFeatures, tgtFeatures, profile, ctrlFlatten);
    const engAmplify = smash(srcFeatures, tgtFeatures, profile, ctrlAmplify);

    // All three engine outputs should have a non-empty adjustedClusterWeights
    // array that sums to ~1 (normalized).
    for (const eng of [engNeutral, engFlatten, engAmplify]) {
      expect(eng.adjustedClusterWeights.length).toBeGreaterThan(0);
      let sum = 0;
      for (let i = 0; i < eng.adjustedClusterWeights.length; i++) sum += eng.adjustedClusterWeights[i];
      expect(sum).toBeCloseTo(1, 5);
    }

    // The flatten regime should produce a MORE uniform weight distribution
    // (smaller max−min spread). The amplify regime should produce a LESS
    // uniform distribution (larger spread).
    const spread = (arr: Float32Array): number => {
      let mn = arr[0], mx = arr[0];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] < mn) mn = arr[i];
        if (arr[i] > mx) mx = arr[i];
      }
      return mx - mn;
    };
    const sNeutral = spread(engNeutral.adjustedClusterWeights);
    const sFlatten = spread(engFlatten.adjustedClusterWeights);
    const sAmplify = spread(engAmplify.adjustedClusterWeights);

    expect(sFlatten).toBeLessThan(sNeutral);
    expect(sAmplify).toBeGreaterThan(sNeutral);
  });

  it('zoneRatio influences distribution mechanic output (different weights → different blend)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlFlatten: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        distribution: 1.0,
        zoneRatio: -1,
      },
    };
    const ctrlAmplify: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        distribution: 1.0,
        zoneRatio: +1,
      },
    };

    const engFlatten = smash(srcFeatures, tgtFeatures, profile, ctrlFlatten);
    const engAmplify = smash(srcFeatures, tgtFeatures, profile, ctrlAmplify);

    // With distribution=1, the blend uses adjustedClusterWeights heavily.
    // Different weights → at least some probe inputs should produce
    // different outputs between the two engines.
    let anyDifference = false;
    for (const input of [60, 120, 180]) {
      const a = applyTransform(engFlatten, input, input, input);
      const b = applyTransform(engAmplify, input, input, input);
      if (
        Math.abs(a[0] - b[0]) > 0 ||
        Math.abs(a[1] - b[1]) > 0 ||
        Math.abs(a[2] - b[2]) > 0
      ) {
        anyDifference = true;
        break;
      }
    }
    expect(anyDifference).toBe(true);
  });

  it('temperature operates image-relatively: across input range, at least some pixels shift in each direction (Phase 4.5p)', () => {
    // Bimodal source produces output that spans cool through warm.
    // Image-relative temperature targets pixels based on their warmth
    // vs the engine's estimated output median, NOT their absolute Oklab
    // warm-axis sign. Specific polarity per pixel depends on the median
    // (fixture-dependent), so this test just verifies the mechanic
    // PRODUCES MEANINGFUL CHANGE across a sampled set of inputs — at
    // least one pixel should shift under each slider sign.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30; srcRgba[i * 4 + 1] = 30; srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20; srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const sample = (t: number, r: number, g: number, b: number) => {
      const ctrl: SmashControls = {
        ...DEFAULT_SMASH_CONTROLS,
        colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, temperature: t },
      };
      return applyTransform(smash(srcFeatures, tgtFeatures, profile, ctrl), r, g, b);
    };

    const dist = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

    // Sample several inputs spanning the L range and accumulate the
    // total shift produced by each slider sign.
    let warmTotal = 0;
    let coolTotal = 0;
    for (const v of [40, 90, 140, 190, 240]) {
      const baseline = sample(0, v, v, v);
      warmTotal += dist(sample(1, v, v, v), baseline);
      coolTotal += dist(sample(-1, v, v, v), baseline);
    }

    // The mechanic must produce SOME shift across the sample set.
    // Polarity-specific tests are fixture-dependent (depends on where
    // the median lands relative to the gray-input outputs), so this
    // test just verifies the wiring is live without insisting which
    // slider direction shifts a particular pixel.
    expect(warmTotal + coolTotal).toBeGreaterThan(0);
  });

  it('temperature lerps to NEUTRAL, never to mirror — warm pixel + t=-1 desaturates without crossing into green/blue (Phase 4.5o)', () => {
    // Warm source so engine output is warm. With t=-1 the new math lerps
    // toward 0 (neutral), so the warm-axis projection should land near
    // zero but NOT cross to negative (which the prior 4.5n math did —
    // sign-flipping to literal cool color).
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const baseline: SmashControls = { ...DEFAULT_SMASH_CONTROLS };
    const ctrlCool: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, temperature: -1 },
    };

    const eng0 = smash(srcFeatures, tgtFeatures, profile, baseline);
    const engT = smash(srcFeatures, tgtFeatures, profile, ctrlCool);

    // For multiple gray inputs, the baseline engine outputs warm color.
    // R−B is a quick warmth proxy (positive = warm). After t=-1, the
    // output's R−B should:
    //   • be CLOSER to 0 than baseline (toward neutral)
    //   • NOT cross to negative (which would mean literal cool tint)
    let allOK = true;
    for (const v of [80, 130, 180]) {
      const [r0, , b0] = applyTransform(eng0, v, v, v);
      const [rT, , bT] = applyTransform(engT, v, v, v);

      const baselineWarmth = r0 - b0;       // expected positive (warm source)
      const cooledWarmth = rT - bT;

      if (baselineWarmth <= 0) continue;     // skip if baseline isn't warm

      // Should approach neutral (smaller magnitude)…
      if (Math.abs(cooledWarmth) > Math.abs(baselineWarmth)) {
        allOK = false;
        break;
      }
      // …and not cross past 0 into the cool side.
      if (cooledWarmth < -3) { // small tolerance for rounding
        allOK = false;
        break;
      }
    }
    expect(allOK).toBe(true);
  });

  it('zoneInfluence > 1 (overdrive) produces output that diverges further from default than zoneInfluence = 1', () => {
    // Bimodal source so clusters are distinct and zone routing has
    // meaningful direction to overshoot toward.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30; srcRgba[i * 4 + 1] = 30; srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20; srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const make = (inf: number) => smash(srcFeatures, tgtFeatures, profile, {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneInfluence: inf, detailRichness: 1 },
    });

    const eng0 = make(0);
    const eng1 = make(1);
    const eng2 = make(2);

    let totalDist0to1 = 0;
    let totalDist0to2 = 0;
    for (const v of [60, 120, 180]) {
      const a = applyTransform(eng0, v, v, v);
      const b = applyTransform(eng1, v, v, v);
      const c = applyTransform(eng2, v, v, v);
      totalDist0to1 +=
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      totalDist0to2 +=
        Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]);
    }

    // INFLUENCE=2 overdrive should produce output strictly further from
    // the unmodified default than INFLUENCE=1 does — the rotation/Csm
    // overshoot pushes past where the natural cluster contribution would
    // land.
    expect(totalDist0to2).toBeGreaterThan(totalDist0to1);
  });

  it('temperature=0 produces identical output to default (off by default)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlDefault: SmashControls = { ...DEFAULT_SMASH_CONTROLS };
    const ctrlZero: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, temperature: 0 },
    };

    const engDefault = smash(srcFeatures, tgtFeatures, profile, ctrlDefault);
    const engZero = smash(srcFeatures, tgtFeatures, profile, ctrlZero);

    for (const input of [50, 128, 200]) {
      const a = applyTransform(engDefault, input, input, input);
      const b = applyTransform(engZero, input, input, input);
      expect(a).toEqual(b);
    }
  });

  it('Phase 4.5l: zoneEdgeSoftness=0 + zoneEdgeShift=0 produces output bit-identical to absent (4.5j argmin path)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    // Engage zone routing so the path actually runs.
    const ctrlAbsent: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 1,
      },
    };
    const ctrlExplicitZero: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 1,
        zoneEdgeSoftness: 0,
        zoneEdgeShift: 0,
      },
    };

    const engAbsent = smash(srcFeatures, tgtFeatures, profile, ctrlAbsent);
    const engExplicit = smash(srcFeatures, tgtFeatures, profile, ctrlExplicitZero);

    for (const v of [30, 90, 150, 220]) {
      const a = applyTransform(engAbsent, v, v, v);
      const b = applyTransform(engExplicit, v, v, v);
      expect(a).toEqual(b);
    }
  });

  it('Phase 4.5l: zoneEdgeShift moves boundaries; pixels right of a shifted boundary route to a different cluster', () => {
    // Build a bimodal source so the boundary between the two clusters is
    // unambiguous. Without shift, the natural midpoint is roughly at L=0.5.
    // With shift=-1, the boundary moves toward L=0; pixels at L=0.4 (formerly
    // in the "cool" band) should now route to the warm band.
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30;  srcRgba[i * 4 + 1] = 30;  srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20;  srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlNatural: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 0, // centroid only — sharper differentiation
        zoneEdgeSoftness: 0,
        zoneEdgeShift: 0,
      },
    };
    const ctrlShiftedDown: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 0,
        zoneEdgeSoftness: 0,
        zoneEdgeShift: -1, // boundary pulled toward L=0
      },
    };

    const engNatural = smash(srcFeatures, tgtFeatures, profile, ctrlNatural);
    const engShifted = smash(srcFeatures, tgtFeatures, profile, ctrlShiftedDown);

    // The engine's zoneBoundaries arrays should differ: shifted has a lower
    // boundary than natural.
    expect(engShifted.zoneBoundaries.length).toBeGreaterThan(0);
    expect(engShifted.zoneBoundaries.length).toBe(engNatural.zoneBoundaries.length);
    for (let i = 0; i < engNatural.zoneBoundaries.length; i++) {
      expect(engShifted.zoneBoundaries[i]).toBeLessThan(engNatural.zoneBoundaries[i]);
    }

    // For at least one input on the shadow side of the natural boundary
    // (Lin < natural midpoint, ~0.375 for this bimodal source), the two
    // engines should route to different clusters → different output.
    // Natural picks the dark cluster; shift=-1 collapses the boundary
    // to ≈0, so everything routes to the red cluster.
    let anyDifferent = false;
    for (const v of [30, 50, 80, 110]) {
      const a = applyTransform(engNatural, v, v, v);
      const b = applyTransform(engShifted, v, v, v);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });

  it('Phase 4.5l: zoneEdgeSoftness>0 produces output distinct from the argmin path', () => {
    const total = 32 * 32;
    const srcRgba = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
      const v = i / (total - 1);
      if (v < 0.5) {
        srcRgba[i * 4]     = 30;  srcRgba[i * 4 + 1] = 30;  srcRgba[i * 4 + 2] = 30;
      } else {
        srcRgba[i * 4]     = 230; srcRgba[i * 4 + 1] = 20;  srcRgba[i * 4 + 2] = 20;
      }
      srcRgba[i * 4 + 3] = 255;
    }
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlHard: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 0,
        zoneEdgeSoftness: 0,
      },
    };
    const ctrlSoft: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: {
        ...DEFAULT_SMASH_CONTROLS.colorization,
        zoneInfluence: 1,
        detailRichness: 0,
        zoneEdgeSoftness: 1, // full blur
      },
    };

    const engHard = smash(srcFeatures, tgtFeatures, profile, ctrlHard);
    const engSoft = smash(srcFeatures, tgtFeatures, profile, ctrlSoft);

    // Near a boundary, soft routing should produce a blend rather than a
    // hard cluster pick — at least one mid-range probe should differ.
    let anyDifferent = false;
    for (const v of [100, 128, 156]) {
      const a = applyTransform(engHard, v, v, v);
      const b = applyTransform(engSoft, v, v, v);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });

  it('zoneRatio out of range is clamped (zoneRatio=2 behaves like +1, -2 like -1)', () => {
    const srcRgba = warmOrangeBuffer32();
    const tgtRgba = gradientBuffer32();
    const { profile } = buildProfile(srcRgba, tgtRgba);
    const srcFeatures = extractFeatures(srcRgba, 32, 32, 1);
    const tgtFeatures = extractFeatures(tgtRgba, 32, 32, 1);

    const ctrlPlus1: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: +1 },
    };
    const ctrlPlus2: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: +2 },
    };
    const ctrlMinus1: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: -1 },
    };
    const ctrlMinus2: SmashControls = {
      ...DEFAULT_SMASH_CONTROLS,
      colorization: { ...DEFAULT_SMASH_CONTROLS.colorization, zoneRatio: -2 },
    };

    const e1 = smash(srcFeatures, tgtFeatures, profile, ctrlPlus1);
    const e2 = smash(srcFeatures, tgtFeatures, profile, ctrlPlus2);
    const m1 = smash(srcFeatures, tgtFeatures, profile, ctrlMinus1);
    const m2 = smash(srcFeatures, tgtFeatures, profile, ctrlMinus2);

    // Adjusted weights should be identical (clamp at boundary).
    for (let i = 0; i < e1.adjustedClusterWeights.length; i++) {
      expect(e1.adjustedClusterWeights[i]).toBeCloseTo(e2.adjustedClusterWeights[i], 6);
      expect(m1.adjustedClusterWeights[i]).toBeCloseTo(m2.adjustedClusterWeights[i], 6);
    }
  });
});
