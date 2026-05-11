// Shared helpers for multi-zone band processing. Consumed by applyMatch.ts
// (Curves multi-zone path) and applyLut.ts (LUT multi-zone path).
//
// Extracted from applyMatch.ts: the composite-read + the three triangular
// luma band masks are identical across both consumers, so they live here.

export interface MultiZonePeaks { shadow: number; mid: number; highlight: number }
export interface MultiZoneExtents { min: number; max: number }

export interface ClampedBandRange {
  sP: number; mP: number; hP: number;
  eMin: number; eMax: number;
}

export interface CompositeBuffer {
  data: Uint8Array;   // RGBA or RGB bytes
  width: number;
  height: number;
  components: 3 | 4;
  hasAlpha: boolean;
}

/** Clamp + order peaks against the histogram extents so each band has a
 *  non-zero range and bands don't overlap pathologically. */
export function clampBandRange(
  peaks: MultiZonePeaks,
  extents: MultiZoneExtents,
): ClampedBandRange {
  const sP = Math.max(0, Math.min(253, peaks.shadow));
  const mP = Math.max(sP + 1, Math.min(254, peaks.mid));
  const hP = Math.max(mP + 1, Math.min(255, peaks.highlight));
  const eMin = Math.max(0, Math.min(sP, extents.min));
  const eMax = Math.max(hP, Math.min(255, extents.max));
  return { sP, mP, hP, eMin, eMax };
}

/** Read the document's full-quality composite for band-mask + LUT
 *  computations. Returns the buffer + dispose helper for the underlying
 *  ImageData (caller must call dispose() when done).
 *
 *  Note: the `bounds` parameter is accepted for API symmetry with future
 *  bounded reads, but imaging.getPixels without bounds returns the full
 *  document composite — matching applyMatch.ts's existing behavior. */
export async function readCompositeForBands(
  documentId: number,
  _bounds?: { left: number; top: number; right: number; bottom: number },
): Promise<{ composite: CompositeBuffer; dispose: () => void }> {
  const { imaging } = require("photoshop");
  const compResult = await imaging.getPixels({ documentID: documentId, componentSize: 8, applyAlpha: false });
  const compId = compResult.imageData;
  const compRaw = await compId.getData();
  const data = compRaw instanceof Uint8Array ? compRaw : new Uint8Array(compRaw);
  const width = compId.width, height = compId.height;
  const rawComponents = compId.components ?? (data.length / (width * height));
  const components: 3 | 4 = rawComponents === 4 ? 4 : 3;
  const hasAlpha = components === 4;
  return {
    composite: { data, width, height, components, hasAlpha },
    dispose: () => { if (compId.dispose) compId.dispose(); },
  };
}

/** Compute the three triangular band masks from a composite buffer.
 *  Each mask is `width * height` bytes; `mask[i]` = round(255 * alpha * band_weight).
 *  Pixels with alpha < 1/255 OR luma outside [eMin, eMax] get 0 across all bands. */
export function buildLumaBandMasks(
  comp: CompositeBuffer,
  range: ClampedBandRange,
): { shadow: Uint8Array; mid: Uint8Array; highlight: Uint8Array } {
  const { sP, mP, hP, eMin, eMax } = range;
  const { data, width, height, components, hasAlpha } = comp;
  const pxCount = width * height;
  const shadow = new Uint8Array(pxCount);
  const mid = new Uint8Array(pxCount);
  const highlight = new Uint8Array(pxCount);
  for (let i = 0, j = 0; i < pxCount; i++, j += components) {
    const a = hasAlpha ? data[j + 3] / 255 : 1;
    if (a < 1 / 255) {
      shadow[i] = 0; mid[i] = 0; highlight[i] = 0;
      continue;
    }
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < eMin || luma > eMax) {
      shadow[i] = 0; mid[i] = 0; highlight[i] = 0;
      continue;
    }
    // Linear ramps anchored at peaks AND extents (shadow ramps up from eMin to sP,
    // highlight ramps down from hP to eMax — matches the visual histogram bounds).
    const sw = luma <= sP ? (sP === eMin ? 1 : (luma - eMin) / (sP - eMin))
                          : (luma <= mP ? (mP - luma) / (mP - sP) : 0);
    const mw = luma <= sP ? 0 : (luma <= mP ? (luma - sP) / (mP - sP) : (luma <= hP ? (hP - luma) / (hP - mP) : 0));
    const hw = luma <= mP ? 0 : (luma <= hP ? (luma - mP) / (hP - mP)
                                             : (eMax === hP ? 1 : (eMax - luma) / (eMax - hP)));
    shadow[i]    = Math.max(0, Math.min(255, Math.round(a * sw * 255)));
    mid[i]       = Math.max(0, Math.min(255, Math.round(a * mw * 255)));
    highlight[i] = Math.max(0, Math.min(255, Math.round(a * hw * 255)));
  }
  return { shadow, mid, highlight };
}
