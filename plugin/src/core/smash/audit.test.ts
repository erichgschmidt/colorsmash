// Tests for the SmashAudit functional builder (audit.ts).
// Every function must be pure — we verify that after each operation the
// original audit is unchanged and the returned object differs only where
// specified.

import { describe, it, expect } from 'vitest';
import {
  createAudit,
  finalize,
  isActive,
  withBandUsed,
  withClusterAnchored,
  withClusterLocked,
  withGamutClipped,
  withTraitContribution,
} from './audit';

// ────────── createAudit ──────────

describe('createAudit', () => {
  it('has all zero traitContributions', () => {
    const a = createAudit();
    expect(a.traitContributions).toEqual({
      value: 0,
      hue: 0,
      saturation: 0,
      chroma: 0,
      neutral: 0,
      accent: 0,
    });
  });

  it('has empty bandsUsed, clustersAnchored, clustersLocked', () => {
    const a = createAudit();
    expect(a.bandsUsed).toEqual([]);
    expect(a.clustersAnchored).toEqual([]);
    expect(a.clustersLocked).toEqual([]);
  });

  it('has gamutClipped=false and elapsedMs=0', () => {
    const a = createAudit();
    expect(a.gamutClipped).toBe(false);
    expect(a.elapsedMs).toBe(0);
  });

  it('returns a fresh object on each call (not a shared singleton)', () => {
    const a = createAudit();
    const b = createAudit();
    expect(a).not.toBe(b);
    expect(a.traitContributions).not.toBe(b.traitContributions);
    expect(a.bandsUsed).not.toBe(b.bandsUsed);
  });
});

// ────────── withTraitContribution ──────────

describe('withTraitContribution', () => {
  it('sets value on a new audit without mutating the original', () => {
    const orig = createAudit();
    const next = withTraitContribution(orig, 'value', 0.7);
    expect(next.traitContributions.value).toBe(0.7);
    expect(orig.traitContributions.value).toBe(0); // original unchanged
  });

  it('returns a new object reference', () => {
    const orig = createAudit();
    const next = withTraitContribution(orig, 'value', 0.7);
    expect(next).not.toBe(orig);
    expect(next.traitContributions).not.toBe(orig.traitContributions);
  });

  it('handles each of the 6 trait keys', () => {
    const keys = ['value', 'hue', 'saturation', 'chroma', 'neutral', 'accent'] as const;
    keys.forEach((key) => {
      const a = withTraitContribution(createAudit(), key, 0.5);
      expect(a.traitContributions[key]).toBe(0.5);
      // All other keys remain 0
      keys.filter((k) => k !== key).forEach((other) => {
        expect(a.traitContributions[other]).toBe(0);
      });
    });
  });
});

// ────────── withBandUsed ──────────

describe('withBandUsed', () => {
  it('appends a new band entry', () => {
    const a = withBandUsed(createAudit(), 0, false);
    expect(a.bandsUsed).toHaveLength(1);
    expect(a.bandsUsed[0]).toEqual({ index: 0, fellBack: false });
  });

  it('does not mutate the original audit', () => {
    const orig = createAudit();
    withBandUsed(orig, 0, false);
    expect(orig.bandsUsed).toHaveLength(0);
  });

  it('replaces (not duplicates) when called twice with the same index', () => {
    const a = withBandUsed(createAudit(), 0, false);
    const b = withBandUsed(a, 0, true);
    expect(b.bandsUsed).toHaveLength(1);
    expect(b.bandsUsed[0]).toEqual({ index: 0, fellBack: true });
  });

  it('appends distinct entries for different indices', () => {
    const a = withBandUsed(withBandUsed(createAudit(), 0, false), 1, true);
    expect(a.bandsUsed).toHaveLength(2);
    expect(a.bandsUsed[0]).toEqual({ index: 0, fellBack: false });
    expect(a.bandsUsed[1]).toEqual({ index: 1, fellBack: true });
  });

  it('returns a new array reference', () => {
    const orig = createAudit();
    const next = withBandUsed(orig, 2, false);
    expect(next.bandsUsed).not.toBe(orig.bandsUsed);
  });
});

// ────────── withClusterAnchored ──────────

describe('withClusterAnchored', () => {
  it('appends a cluster index', () => {
    const a = withClusterAnchored(createAudit(), 0);
    expect(a.clustersAnchored).toEqual([0]);
  });

  it('deduplicates: calling twice with the same index keeps length 1', () => {
    const a = withClusterAnchored(createAudit(), 0);
    const b = withClusterAnchored(a, 0);
    expect(b.clustersAnchored).toHaveLength(1);
  });

  it('accumulates distinct indices', () => {
    const a = withClusterAnchored(createAudit(), 0);
    const b = withClusterAnchored(a, 1);
    expect(b.clustersAnchored).toEqual([0, 1]);
  });

  it('does not mutate the original audit', () => {
    const orig = createAudit();
    withClusterAnchored(orig, 0);
    expect(orig.clustersAnchored).toHaveLength(0);
  });

  it('returns a new array reference', () => {
    const orig = createAudit();
    const next = withClusterAnchored(orig, 0);
    expect(next.clustersAnchored).not.toBe(orig.clustersAnchored);
  });
});

// ────────── withClusterLocked ──────────

describe('withClusterLocked', () => {
  it('appends a cluster index', () => {
    const a = withClusterLocked(createAudit(), 0);
    expect(a.clustersLocked).toEqual([0]);
  });

  it('deduplicates: calling twice with the same index keeps length 1', () => {
    const a = withClusterLocked(createAudit(), 0);
    const b = withClusterLocked(a, 0);
    expect(b.clustersLocked).toHaveLength(1);
  });

  it('accumulates distinct indices', () => {
    const a = withClusterLocked(createAudit(), 0);
    const b = withClusterLocked(a, 1);
    expect(b.clustersLocked).toEqual([0, 1]);
  });

  it('does not mutate the original audit', () => {
    const orig = createAudit();
    withClusterLocked(orig, 0);
    expect(orig.clustersLocked).toHaveLength(0);
  });
});

// ────────── withGamutClipped ──────────

describe('withGamutClipped', () => {
  it('sets gamutClipped to true', () => {
    const a = withGamutClipped(createAudit(), true);
    expect(a.gamutClipped).toBe(true);
  });

  it('can clear gamutClipped back to false', () => {
    const a = withGamutClipped(createAudit(), true);
    const b = withGamutClipped(a, false);
    expect(b.gamutClipped).toBe(false);
  });

  it('does not mutate the original audit', () => {
    const orig = createAudit();
    withGamutClipped(orig, true);
    expect(orig.gamutClipped).toBe(false);
  });
});

// ────────── finalize ──────────

describe('finalize', () => {
  it('sets elapsedMs', () => {
    const a = finalize(createAudit(), 250);
    expect(a.elapsedMs).toBe(250);
  });

  it('does not mutate the original audit', () => {
    const orig = createAudit();
    finalize(orig, 250);
    expect(orig.elapsedMs).toBe(0);
  });

  it('returns a new object reference', () => {
    const orig = createAudit();
    const next = finalize(orig, 250);
    expect(next).not.toBe(orig);
  });
});

// ────────── isActive ──────────

describe('isActive', () => {
  it('returns false for a fresh audit (all zero contributions)', () => {
    expect(isActive(createAudit())).toBe(false);
  });

  it('returns true when any contribution is non-zero', () => {
    expect(isActive(withTraitContribution(createAudit(), 'value', 0.1))).toBe(true);
    expect(isActive(withTraitContribution(createAudit(), 'hue', 0.01))).toBe(true);
    expect(isActive(withTraitContribution(createAudit(), 'neutral', 1))).toBe(true);
  });

  it('returns false when a contribution is explicitly set to zero', () => {
    const a = withTraitContribution(createAudit(), 'value', 0);
    expect(isActive(a)).toBe(false);
  });
});

// ────────── chained pipeline ──────────

describe('chained pipeline', () => {
  it('produces the expected combined audit through a full pipeline', () => {
    const result = finalize(
      withGamutClipped(
        withBandUsed(
          withTraitContribution(createAudit(), 'hue', 0.5),
          0,
          false,
        ),
        true,
      ),
      100,
    );

    expect(result.traitContributions.hue).toBe(0.5);
    expect(result.traitContributions.value).toBe(0);
    expect(result.bandsUsed).toEqual([{ index: 0, fellBack: false }]);
    expect(result.gamutClipped).toBe(true);
    expect(result.elapsedMs).toBe(100);
    expect(result.clustersAnchored).toEqual([]);
    expect(result.clustersLocked).toEqual([]);
    expect(isActive(result)).toBe(true);
  });
});
