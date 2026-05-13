// SmashAudit functional builder.
// Pure functions — every operation returns a new audit object; inputs are never
// mutated. Designed so transform.ts can populate audit fields incrementally
// during the smash pass without imperative state gymnastics.
// See ColorSmash_Masterplan_v1.md §4.3 (Smash Audit / Decision Inspector).

import type { SmashAudit, TraitAmounts } from './types';

/** Returns a fresh empty SmashAudit with zero contributions, no flagged
 *  bands/clusters, no gamut clipping, and elapsed=0. */
export function createAudit(): SmashAudit {
  return {
    traitContributions: { value: 0, hue: 0, saturation: 0, chroma: 0, neutral: 0, accent: 0 },
    bandsUsed: [],
    clustersAnchored: [],
    clustersLocked: [],
    gamutClipped: false,
    elapsedMs: 0,
  };
}

/** Returns a new audit with the given trait's contribution overwritten. */
export function withTraitContribution(
  audit: SmashAudit,
  trait: keyof TraitAmounts,
  contribution: number,
): SmashAudit {
  return {
    ...audit,
    traitContributions: { ...audit.traitContributions, [trait]: contribution },
  };
}

/** Returns a new audit recording that the band at `index` was used.
 *  Idempotent: calling twice with the same index replaces the entry rather
 *  than duplicating it, so `fellBack` can be updated. */
export function withBandUsed(
  audit: SmashAudit,
  index: number,
  fellBack: boolean,
): SmashAudit {
  const entry = { index, fellBack };
  const exists = audit.bandsUsed.some((b) => b.index === index);
  const bandsUsed = exists
    ? audit.bandsUsed.map((b) => (b.index === index ? entry : b))
    : [...audit.bandsUsed, entry];
  return { ...audit, bandsUsed };
}

/** Returns a new audit with the given cluster index appended to
 *  clustersAnchored (deduped). */
export function withClusterAnchored(
  audit: SmashAudit,
  index: number,
): SmashAudit {
  if (audit.clustersAnchored.includes(index)) return audit;
  return { ...audit, clustersAnchored: [...audit.clustersAnchored, index] };
}

/** Returns a new audit with the given cluster index appended to
 *  clustersLocked (deduped). */
export function withClusterLocked(
  audit: SmashAudit,
  index: number,
): SmashAudit {
  if (audit.clustersLocked.includes(index)) return audit;
  return { ...audit, clustersLocked: [...audit.clustersLocked, index] };
}

/** Returns a new audit with the gamutClipped flag set. */
export function withGamutClipped(
  audit: SmashAudit,
  clipped: boolean,
): SmashAudit {
  return { ...audit, gamutClipped: clipped };
}

/** Returns a new audit with the elapsedMs measurement set. Typically the
 *  final step before handing the audit to the UI. */
export function finalize(audit: SmashAudit, elapsedMs: number): SmashAudit {
  return { ...audit, elapsedMs };
}

/** True if any trait contribution is non-zero. Useful for "did Smash do
 *  anything?" diagnostics. */
export function isActive(audit: SmashAudit): boolean {
  return Object.values(audit.traitContributions).some((v) => v !== 0);
}
