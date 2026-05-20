// Per-anchor mini-Smash analysis.
//
// Each focal anchor used to mean "paint ONE source pool's transform softstep-
// blended through a falloff circle around the target click". That gave an
// airbrushed result — there was no internal structure inside the anchor.
//
// This module replaces that single-pool model with a localised mini-Smash:
//   1. Take the SOURCE pixels inside the anchor's source-side circle and the
//      TARGET pixels inside the anchor's target-side circle.
//   2. Run segmentPixelSet (the same engine used globally) on each set
//      independently, producing local source pools and local target pools.
//   3. matchPools(localSource, localTarget) to pair them by structural role.
//   4. Build per-local-target-pool sub-mappings exactly like the global
//      transfer does (buildSubMappings over the lightness-sorted sub-colour
//      lists). The result is a per-pixel local label map at TARGET resolution
//      plus a Map<localPoolId, SubMapping[]>.
//
// transferColors then consumes that result: inside the anchor's falloff the
// local mini-Smash REPLACES the global delta, smoothstep-gated by the
// falloff so the transition to the global solution at the edge is smooth.

import {
  segmentPixelSet,
  type SegmentOptions,
  type Pool,
} from "./clusters";
import { matchPools } from "./match";
import {
  buildSubMappings,
  poolSubColors,
  type SubMapping,
} from "./transfer";

// One anchor's analysed local correspondence — what transferColors needs per
// pixel inside that anchor's falloff.
export interface AnchorAnalysis {
  // Geometry in normalized 0..1 over the TARGET image — duplicated from the
  // input so transferColors can read everything it needs off the anchor.
  targetX: number;
  targetY: number;
  radius: number;
  // Per-pixel local target labels at TARGET resolution. -1 outside the
  // anchor's reach OR transparent. Inside the falloff, holds a local target
  // pool id (its own id space, independent of the global pool ids).
  localTargetLabels: Int32Array;
  // Local-target-pool id → sub-mappings to its matched local donor pool.
  localMappingsByPool: Map<number, SubMapping[]>;
}

export interface AnchorAnalysisInput {
  sourceRgba: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  sourceX: number;       // normalized 0..1 (center of the source-side circle)
  sourceY: number;
  targetRgba: Uint8Array;
  targetWidth: number;
  targetHeight: number;
  targetX: number;       // normalized 0..1 (center of the target-side circle)
  targetY: number;
  radius: number;        // normalized 0..1 of max(width, height) on each side
  // Global segmentation opts as a basis. The local pool count is derived by
  // multiplying poolCount by an anchor-detail-driven factor (see DETAIL_*).
  baseSegmentOpts: SegmentOptions;
  // Local pool density — the user's "Anchor detail" 0..1 slider. Maps to a
  // multiplier on baseSegmentOpts.poolCount, capped at LOCAL_POOL_CAP.
  detail: number;
}

// Below this pixel count on either side, the mini-Smash is too thin to be
// meaningful — return an empty analysis (it becomes a no-op).
const MIN_PIXELS = 32;
// detail 0 ≈ 0.5×, detail 0.5 ≈ 1.5×, detail 1 ≈ 2.5×, then clamped.
const DETAIL_BASE = 0.5;
const DETAIL_RANGE = 2.0;
const LOCAL_POOL_MIN = 2;
const LOCAL_POOL_CAP = 16;

// Collect the indices of pixels whose normalised centre falls inside a circle
// of radius `r` around (cx, cy) in the unit square. Transparent pixels are
// skipped. The radius is scaled by max(width, height) to match the same
// convention transferColors uses for its falloff geometry.
function collectIndicesInCircle(
  rgba: Uint8Array,
  width: number,
  height: number,
  cxN: number,
  cyN: number,
  rN: number,
): number[] {
  const cx = cxN * Math.max(0, width - 1);
  const cy = cyN * Math.max(0, height - 1);
  const r = Math.max(1, rN * Math.max(width, height));
  const r2 = r * r;
  // Bounding box in pixel coords — clamped to the image rect.
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy2 > r2) continue;
      const i = y * width + x;
      if (rgba[i * 4 + 3] < 128) continue;
      out.push(i);
    }
  }
  return out;
}

// Map the 0..1 detail slider onto an integer local pool count.
function localPoolCount(basePoolCount: number, detail: number): number {
  const d = detail < 0 ? 0 : detail > 1 ? 1 : detail;
  const mult = DETAIL_BASE + d * DETAIL_RANGE;
  const raw = Math.round(basePoolCount * mult);
  if (raw < LOCAL_POOL_MIN) return LOCAL_POOL_MIN;
  if (raw > LOCAL_POOL_CAP) return LOCAL_POOL_CAP;
  return raw;
}

// Empty-analysis helper — when the source / target reach is too thin or no
// local correspondence could be built, the anchor becomes a no-op at transfer
// time. transferColors filters anchors with an empty mapping map out anyway.
function emptyAnalysis(input: AnchorAnalysisInput): AnchorAnalysis {
  return {
    targetX: input.targetX,
    targetY: input.targetY,
    radius: input.radius,
    localTargetLabels: new Int32Array(input.targetWidth * input.targetHeight).fill(-1),
    localMappingsByPool: new Map(),
  };
}

// Build one anchor's local correspondence. Mirrors the global Smash pipeline
// at a tiny scale: segment, match, build sub-mappings. The output is shaped
// exactly to what transferColors needs at draw time — a per-pixel target-
// resolution label map plus a per-local-pool sub-mapping table.
export function analyzeAnchor(input: AnchorAnalysisInput): AnchorAnalysis {
  const sourceIndices = collectIndicesInCircle(
    input.sourceRgba, input.sourceWidth, input.sourceHeight,
    input.sourceX, input.sourceY, input.radius,
  );
  const targetIndices = collectIndicesInCircle(
    input.targetRgba, input.targetWidth, input.targetHeight,
    input.targetX, input.targetY, input.radius,
  );

  if (sourceIndices.length < MIN_PIXELS || targetIndices.length < MIN_PIXELS) {
    return emptyAnalysis(input);
  }

  const localOpts: SegmentOptions = {
    ...input.baseSegmentOpts,
    poolCount: localPoolCount(input.baseSegmentOpts.poolCount, input.detail),
  };

  // Independent local segmentations. id space starts at 0 on both sides —
  // they live in separate pool maps so the ids don't collide outside this
  // module.
  const sourceLocal = segmentPixelSet(
    input.sourceRgba, input.sourceWidth, input.sourceHeight,
    sourceIndices, localOpts, 0,
  );
  const targetLocal = segmentPixelSet(
    input.targetRgba, input.targetWidth, input.targetHeight,
    targetIndices, localOpts, 0,
  );

  if (sourceLocal.pools.length === 0 || targetLocal.pools.length === 0) {
    return emptyAnalysis(input);
  }

  // Local target labels at TARGET resolution. -1 everywhere by default; for
  // each j in targetIndices, write the assigned local pool id at that pixel.
  const localTargetLabels = new Int32Array(input.targetWidth * input.targetHeight).fill(-1);
  for (let j = 0; j < targetIndices.length; j++) {
    localTargetLabels[targetIndices[j]] = targetLocal.assignment[j];
  }

  // matchPools pairs each local target pool with the best-scoring local
  // source pool; then for each local target pool we lightness-rank its
  // sub-colours against the donor's, exactly like the global transfer.
  const correspondence = matchPools(sourceLocal.pools, targetLocal.pools);
  const sourceById = new Map<number, Pool>();
  for (const p of sourceLocal.pools) sourceById.set(p.id, p);
  const targetById = new Map<number, Pool>();
  for (const p of targetLocal.pools) targetById.set(p.id, p);

  const localMappingsByPool = new Map<number, SubMapping[]>();
  for (const m of correspondence.matches) {
    const tp = targetById.get(m.targetPoolId);
    const sp = sourceById.get(m.sourcePoolId);
    if (!tp || !sp) continue;
    const mappings = buildSubMappings(poolSubColors(tp), poolSubColors(sp));
    if (mappings.length > 0) {
      localMappingsByPool.set(m.targetPoolId, mappings);
    }
  }

  return {
    targetX: input.targetX,
    targetY: input.targetY,
    radius: input.radius,
    localTargetLabels,
    localMappingsByPool,
  };
}
