// Ported from the CutWise plugin (plugin/src/core/smooth.ts). Faithful copy of
// the majority-filter label smoother; no algorithm changes.
//
// Shape-edge smoothing — a majority filter over the per-pixel cluster map.
//
// Connected-component merging produces clean *regions* but pixel-exact edges,
// so shape borders keep the 1px staircase of the source photo. A majority
// filter (each pixel takes the most common label in its 3×3 neighbourhood)
// dissolves those jaggies and stray pixels into the smooth, paper-cut contours
// that make a cutout read as graphic art rather than a downscaled photo.

// Run `passes` rounds of 3×3 majority filtering over a cluster-label map.
// Transparent pixels (-1) are left untouched and excluded from neighbour
// counts. Ties keep the centre pixel, so stable shapes don't drift.
export function smoothLabels(
  labels: Int32Array,
  width: number,
  height: number,
  passes: number,
): Int32Array {
  if (passes <= 0) return labels;
  let src = labels;

  for (let pass = 0; pass < passes; pass++) {
    const dst = new Int32Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const center = src[p];
        if (center === -1) { dst[p] = -1; continue; }

        // Tally labels across the 3×3 neighbourhood (clamped at edges).
        let bestLabel = center;
        let bestCount = 0;
        let centerCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const lbl = src[yy * width + xx];
            if (lbl === -1) continue;
            // Count how many neighbours share `lbl`.
            let c = 0;
            for (let ey = -1; ey <= 1; ey++) {
              const ny = y + ey;
              if (ny < 0 || ny >= height) continue;
              for (let ex = -1; ex <= 1; ex++) {
                const nx = x + ex;
                if (nx < 0 || nx >= width) continue;
                if (src[ny * width + nx] === lbl) c++;
              }
            }
            if (lbl === center) centerCount = c;
            if (c > bestCount) { bestCount = c; bestLabel = lbl; }
          }
        }
        // Tie-break toward the centre label to keep stable shapes still.
        dst[p] = bestCount === centerCount ? center : bestLabel;
      }
    }
    src = dst;
  }
  return src;
}
