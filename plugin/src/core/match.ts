// Pool-to-pool correspondence for color transfer.
//
// Given a SOURCE image's color pools and a TARGET image's color pools, decide
// which source pool each target pool should draw its colors from.
//
// Design philosophy — match by STRUCTURAL ROLE, not by current color. The
// transfer step recolors the target, so the goal is "the target's dark
// dominant region receives the source's dark dominant region's colors". If we
// matched by hue (target-blue → source-blue) the transfer would be a no-op.
// Therefore the score deliberately ignores hue / color identity and looks only
// at value band, relative area, chroma magnitude and spatial position.

import type { Pool } from "./clusters";
import { deltaE2000 } from "./deltaE";

export interface PoolMatch {
  targetPoolId: number;
  sourcePoolId: number;
  score: number; // match cost, lower = better
}

export interface Correspondence {
  matches: PoolMatch[];          // exactly one per target pool
  unmatchedSourceIds: number[];  // source pools no target pool drew from
}

// ────────── Scoring weights ──────────
//
// Score = weighted sum of four normalized (≈0..1) penalty terms. Value band is
// the backbone of the match and clearly dominates; area and chroma keep
// dominant↔dominant / vivid↔vivid alignment; spatial position is a gentle
// nudge. A ΔE00 term is folded in at a tiny weight purely as a deterministic
// tiebreaker between source pools that are otherwise scored identically.
const W_VALUE_BAND = 1.0;   // dominant — tonal structure is the backbone
const W_AREA = 0.35;        // dominant region → dominant region
const W_CHROMA = 0.30;      // vivid accent → vivid accent (magnitude, not hue)
const W_SPATIAL = 0.15;     // minor — top region leans toward top region
const W_TIEBREAK = 0.02;    // negligible — only separates otherwise-equal ties

// Value-band penalty (already in 0..1): 0 same band, 0.5 adjacent, 1 opposite.
const BAND_INDEX: Record<string, number> = { shadow: 0, mid: 1, highlight: 2 };

function bandPenalty(a: string, b: string): number {
  const diff = Math.abs(BAND_INDEX[a] - BAND_INDEX[b]);
  return diff / 2; // 0, 0.5 or 1
}

// Chroma is ~0..130; normalize differences onto a comparable 0..1 scale.
const CHROMA_SCALE = 130;
// ΔE00 between typical pool means is ~0..100; scale so the tiebreaker term
// stays in roughly 0..1 like the others before its tiny weight is applied.
const DELTAE_SCALE = 100;

// Cost of matching target pool T to source pool S. Lower = better.
function scorePair(t: Pool, s: Pool): number {
  const td = t.descriptor;
  const sd = s.descriptor;

  const band = bandPenalty(td.valueBand, sd.valueBand);
  const area = Math.abs(td.weight - sd.weight); // weights already 0..1
  const chroma = Math.abs(td.chroma - sd.chroma) / CHROMA_SCALE;

  const dx = td.centroidX - sd.centroidX;
  const dy = td.centroidY - sd.centroidY;
  const spatial = Math.sqrt(dx * dx + dy * dy); // 0..~1.414 over the unit square

  // Low-weight tiebreaker: perceptual ΔE of the mean colors. Weighted so low
  // it can never override a structural decision — it only orders source pools
  // that the structural terms leave tied.
  const tie =
    deltaE2000(td.labL, td.labA, td.labB, sd.labL, sd.labA, sd.labB) /
    DELTAE_SCALE;

  return (
    W_VALUE_BAND * band +
    W_AREA * area +
    W_CHROMA * chroma +
    W_SPATIAL * spatial +
    W_TIEBREAK * tie
  );
}

// Build a correspondence: each TARGET pool independently picks the SOURCE pool
// with the lowest score (many-to-one — source pools may be reused, since a
// target may have more regions than the source has color groups).
export function matchPools(
  sourcePools: Pool[],
  targetPools: Pool[],
): Correspondence {
  if (sourcePools.length === 0 || targetPools.length === 0) {
    return { matches: [], unmatchedSourceIds: sourcePools.map(p => p.id) };
  }

  const matches: PoolMatch[] = [];
  const usedSourceIds = new Set<number>();

  for (const target of targetPools) {
    let best = sourcePools[0];
    let bestScore = scorePair(target, best);
    for (let i = 1; i < sourcePools.length; i++) {
      const score = scorePair(target, sourcePools[i]);
      if (score < bestScore) {
        bestScore = score;
        best = sourcePools[i];
      }
    }
    matches.push({
      targetPoolId: target.id,
      sourcePoolId: best.id,
      score: bestScore,
    });
    usedSourceIds.add(best.id);
  }

  const unmatchedSourceIds = sourcePools
    .filter(p => !usedSourceIds.has(p.id))
    .map(p => p.id);

  return { matches, unmatchedSourceIds };
}
