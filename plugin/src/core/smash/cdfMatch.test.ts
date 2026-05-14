import { describe, it, expect } from "vitest";
import { buildCdfMatchLut, lookupCdfMatch } from "./cdfMatch";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function f32(...values: number[]): Float32Array {
  return new Float32Array(values);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildCdfMatchLut + lookupCdfMatch", () => {
  // 1. Identity: source === target -> matched value === input value.
  // With a 256-bin LUT, the CDF match is exact at tMin and tMax (bucket 0 and
  // bucket 255 are built at the exact target boundary values). For intermediate
  // values we verify closeness within the quantization error of a 256-bin LUT
  // built over a uniform dense sample, which should be within ~1 bucket width.
  it("identity: src === tgt maps each target value back to itself (within LUT tolerance)", () => {
    // Dense uniform sample so each LUT bucket is closely matched.
    const n = 256;
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = i / (n - 1);
    const lut = buildCdfMatchLut(arr, arr);

    // At the endpoints, the match must be exact (bucket 0 and bins-1).
    expect(lookupCdfMatch(lut, 0.0)).toBeCloseTo(0.0, 4);
    expect(lookupCdfMatch(lut, 1.0)).toBeCloseTo(1.0, 4);

    // For mid-range values, the 256-bin LUT introduces at most ~1/(n-1) quantization error.
    const bucketWidth = 1 / (n - 1);
    for (let i = 10; i < n - 10; i += 10) {
      const v = arr[i];
      const out = lookupCdfMatch(lut, v);
      expect(Math.abs(out - v)).toBeLessThan(bucketWidth * 2);
    }
  });

  // 2. User's worked example: src=[0,0,1] (2 black, 1 white), tgt=[0.2,0.5,0.8].
  // The source CDF is a step function: 2/3 of the mass is at 0, 1/3 at 1.
  // The LUT + linear interpolation smooths steps into ramps, so at exact step
  // boundaries the output interpolates between adjacent step values. We test that:
  //   - the lowest target value (0.2) clearly maps to the low source region (near 0)
  //   - the highest target value (0.8) clearly maps to the high source region (near 1)
  //   - values BEFORE the step (well below 0.5) map to the low source value
  //   - values AFTER the step (well above 0.5) map to the high source value
  it("worked example: src=[0,0,1] tgt=[0.2,0.5,0.8] — 2/3 map to 0, 1/3 to 1", () => {
    const src = f32(0, 0, 1);
    const tgt = f32(0.2, 0.5, 0.8);
    const lut = buildCdfMatchLut(src, tgt);

    // 0.2 -> percentile 0/3=0 -> srcIdx=0 -> source value 0. Boundary bucket is exact.
    expect(lookupCdfMatch(lut, 0.2)).toBeCloseTo(0, 4);
    // 0.8 -> at the upper boundary bucket. percentile=2/3 -> srcIdx=2 -> source value 1.
    expect(lookupCdfMatch(lut, 0.8)).toBeCloseTo(1, 4);
    // Values well within the "two zeros" zone map clearly to the low source value.
    // 0.3 is 1/6 into [0.2,0.8]; the step from 0->1 in source is at 2/3 target percentile
    // (= target value 0.6). So 0.3 is safely in the low zone.
    expect(lookupCdfMatch(lut, 0.3)).toBeLessThan(0.1);
    // Values well within the "one white" zone map clearly to the high source value.
    // 0.75 is near the top, above the step at 0.6.
    expect(lookupCdfMatch(lut, 0.75)).toBeGreaterThan(0.9);
  });

  // 3. Distribution ratios: src=[0,0,0,0,1,1] (67% zeros, 33% ones).
  // tgt spans [0,1] uniformly with 6 values. The CDF step in source goes from 0 to 1 at
  // percentile 4/6=0.667, so target percentile 0.667 maps to tMin + 0.667*tRange = 0.667.
  // Values clearly below 0.667 (0.0, 0.2, 0.4) -> 0. Values above 0.667 (0.8, 1.0) -> 1.
  // Using values 0/5..5/5 avoids float32 quantization gaps (these fractions are exact
  // multiples of 1/5 which Float32 can represent without stepping on CDF boundaries).
  it("distribution ratios: 4/6 -> 0, 2/6 -> 1 after CDF match", () => {
    const src = f32(0, 0, 0, 0, 1, 1);
    // Target: 6 evenly-spaced values from 0 to 1. Float32 exact at 0.0, 0.2, 0.4, 0.6, 0.8, 1.0.
    const tgt = f32(0.0, 0.2, 0.4, 0.6, 0.8, 1.0);
    const lut = buildCdfMatchLut(src, tgt, 256);

    // The CDF step from 0->1 in source is at target percentile 4/6=0.667.
    // In target space [0,1]: step boundary at 0.667. Values 0.0,0.2,0.4 are below; 0.6,0.8,1.0 above.
    // But 0.6 is close to 0.667 so we test with a clear margin: 0.0, 0.2, 0.4 -> zero-zone.
    // The lookup is from the float64-promoted float32 stored values.
    const tgtF32 = Array.from(tgt);
    const outputs = tgtF32.map(v => lookupCdfMatch(lut, v));
    const nearZero = outputs.filter(v => v <= 0.05).length;
    const nearOne  = outputs.filter(v => v >= 0.95).length;
    expect(nearZero).toBe(4);
    expect(nearOne).toBe(2);
  });

  // 4. Compressed range adaptation: src spans [0,1], tgt is narrow [0.4,0.6].
  // After remap, tgt's lowest value (0.4) maps to ~0.0 and highest (0.6) maps to ~1.0.
  it("compressed range adaptation: narrow tgt range expands to full src range", () => {
    const src = f32(0.0, 0.1, 0.9, 1.0);
    const tgt = f32(0.4, 0.45, 0.55, 0.6);
    const lut = buildCdfMatchLut(src, tgt);

    // Lowest target value -> lowest source value.
    expect(lookupCdfMatch(lut, 0.4)).toBeCloseTo(0.0, 3);
    // Highest target value -> highest source value.
    expect(lookupCdfMatch(lut, 0.6)).toBeCloseTo(1.0, 3);
  });

  // 5. Bucket count: bins=32 and bins=512 both produce valid LUTs.
  it("bucket count: bins=32 and bins=512 both produce valid LUTs", () => {
    const src = f32(0, 0.25, 0.5, 0.75, 1.0);
    const tgt = f32(0.1, 0.3, 0.5, 0.7, 0.9);

    const lut32  = buildCdfMatchLut(src, tgt, 32);
    const lut512 = buildCdfMatchLut(src, tgt, 512);

    expect(lut32.bins).toBe(32);
    expect(lut32.values.length).toBe(32);
    expect(lut512.bins).toBe(512);
    expect(lut512.values.length).toBe(512);

    // Both return finite values in source's range [0, 1].
    for (const v of tgt) {
      const out32  = lookupCdfMatch(lut32,  v);
      const out512 = lookupCdfMatch(lut512, v);
      expect(isFinite(out32)).toBe(true);
      expect(isFinite(out512)).toBe(true);
      expect(out32).toBeGreaterThanOrEqual(0 - 1e-6);
      expect(out32).toBeLessThanOrEqual(1 + 1e-6);
      expect(out512).toBeGreaterThanOrEqual(0 - 1e-6);
      expect(out512).toBeLessThanOrEqual(1 + 1e-6);
    }

    // 512-bin version matches better near the control points; both are reasonable.
    // Verify they are at least consistent direction (both map 0.1 below 0.9 output).
    expect(lookupCdfMatch(lut32,  0.1)).toBeLessThan(lookupCdfMatch(lut32,  0.9));
    expect(lookupCdfMatch(lut512, 0.1)).toBeLessThan(lookupCdfMatch(lut512, 0.9));
  });

  // 6. Empty source: returns identity LUT.
  it("empty source: returns identity LUT", () => {
    const lut = buildCdfMatchLut(new Float32Array(0), f32(0.2, 0.5, 0.8));
    expect(lut.tMin).toBe(0);
    expect(lut.tMax).toBe(1);
    // Identity: bucket i maps to i/(bins-1).
    for (let i = 0; i < lut.bins; i++) {
      expect(lut.values[i]).toBeCloseTo(i / (lut.bins - 1), 5);
    }
  });

  // 7. Empty target: returns identity LUT.
  it("empty target: returns identity LUT", () => {
    const lut = buildCdfMatchLut(f32(0.1, 0.9), new Float32Array(0));
    expect(lut.tMin).toBe(0);
    expect(lut.tMax).toBe(1);
    for (let i = 0; i < lut.bins; i++) {
      expect(lut.values[i]).toBeCloseTo(i / (lut.bins - 1), 5);
    }
  });

  // 8. Collapsed target (all-same): LUT must be valid, no NaN/Inf.
  it("collapsed target (all same): LUT is valid and output is within source range", () => {
    const src = f32(0.1, 0.9);
    const tgt = f32(0.5, 0.5, 0.5);
    const lut = buildCdfMatchLut(src, tgt);

    for (let i = 0; i < lut.bins; i++) {
      expect(isFinite(lut.values[i])).toBe(true);
      expect(isNaN(lut.values[i])).toBe(false);
    }

    // lookupCdfMatch at the collapsed value: output in source's range.
    const out = lookupCdfMatch(lut, 0.5);
    expect(isFinite(out)).toBe(true);
    expect(out).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(out).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  // 9. Out-of-range input clamping: no NaN/Inf, clamps to first/last bucket.
  it("out-of-range input clamping: values outside [tMin,tMax] clamp without NaN/Inf", () => {
    const src = f32(0, 0.5, 1);
    const tgt = f32(0.2, 0.4, 0.6, 0.8);
    const lut = buildCdfMatchLut(src, tgt);

    const low  = lookupCdfMatch(lut, -1);
    const high = lookupCdfMatch(lut, 5);

    expect(isFinite(low)).toBe(true);
    expect(isFinite(high)).toBe(true);
    expect(isNaN(low)).toBe(false);
    expect(isNaN(high)).toBe(false);

    // Clamp: out-of-range input returns the boundary bucket's value.
    expect(low).toBe(lut.values[0]);
    expect(high).toBe(lut.values[lut.bins - 1]);
  });

  // 10. Monotonicity: if source is sorted ascending, LUT values are non-decreasing.
  it("monotonicity: sorted ascending source produces non-decreasing LUT values", () => {
    const src = f32(0, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0);
    const tgt = f32(0.05, 0.15, 0.3, 0.5, 0.7, 0.9);
    const lut = buildCdfMatchLut(src, tgt);

    // Sample 32 evenly-spaced points across [tMin, tMax] and verify monotonicity.
    const n = 32;
    const step = (lut.tMax - lut.tMin) / (n - 1);
    let prev = lookupCdfMatch(lut, lut.tMin);
    for (let i = 1; i < n; i++) {
      const v = lut.tMin + i * step;
      const out = lookupCdfMatch(lut, v);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = out;
    }
  });
});
