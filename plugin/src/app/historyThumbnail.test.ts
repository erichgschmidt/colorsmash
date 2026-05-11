import { describe, it, expect } from "vitest";
import { lutGradientCSS } from "./historyThumbnail";
import { LutLayerState, SerializedSwatch } from "./lutXmp";

function baseState(overrides: Partial<LutLayerState> = {}): LutLayerState {
  return {
    xmpVersion: 1,
    preset: "color",
    paletteCount: 0,
    ...overrides,
  };
}

function sw(r: number, g: number, b: number, L: number, a = 0, B = 0): SerializedSwatch {
  return { r, g, b, weight: 1, labL: L, labA: a, labB: B };
}

function extractStops(css: string): Array<{ r: number; g: number; b: number; pct: number }> {
  const re = /rgb\((\d+),(\d+),(\d+)\)\s+([\d.]+)%/g;
  const stops: Array<{ r: number; g: number; b: number; pct: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    stops.push({ r: +m[1], g: +m[2], b: +m[3], pct: parseFloat(m[4]) });
  }
  return stops;
}

describe("lutGradientCSS", () => {
  it("produces a well-formed gradient string with 32 rgb stops", () => {
    const css = lutGradientCSS(baseState());
    expect(css.startsWith("linear-gradient(to right,")).toBe(true);
    expect(css.endsWith(")")).toBe(true);
    const matches = css.match(/rgb\(/g);
    expect(matches?.length).toBe(32);
  });

  it("empty state → grayscale passthrough (r == g == b == input gray)", () => {
    const css = lutGradientCSS(baseState());
    const stops = extractStops(css);
    expect(stops.length).toBe(32);
    for (let i = 0; i < stops.length; i++) {
      const expected = Math.round((i / 31) * 255);
      expect(stops[i].r).toBe(expected);
      expect(stops[i].g).toBe(expected);
      expect(stops[i].b).toBe(expected);
    }
    expect(stops[0].pct).toBeCloseTo(0, 5);
    expect(stops[31].pct).toBeCloseTo(100, 5);
  });

  it("single-swatch target → every stop saturates to that swatch's color", () => {
    const state = baseState({
      targetPaletteSwatches: [sw(200, 50, 100, 50)],
    });
    const css = lutGradientCSS(state);
    const stops = extractStops(css);
    for (const s of stops) {
      expect(s.r).toBe(200);
      expect(s.g).toBe(50);
      expect(s.b).toBe(100);
    }
  });

  it("multi-swatch shows visible transitions at Lab-L boundaries", () => {
    // Two swatches: dark red (L=20) and bright yellow (L=90).
    // Grays with L<55 should hit the red, L>55 should hit the yellow.
    const state = baseState({
      targetPaletteSwatches: [
        sw(150, 20, 20, 20),
        sw(240, 230, 30, 90),
      ],
    });
    const css = lutGradientCSS(state);
    const stops = extractStops(css);
    // First stop (gray=0, L≈0) → red swatch.
    expect(stops[0].r).toBe(150);
    expect(stops[0].g).toBe(20);
    // Last stop (gray=255, L=100) → yellow swatch.
    expect(stops[31].r).toBe(240);
    expect(stops[31].g).toBe(230);
    // Somewhere in the middle the color must change → at least 2 distinct colors.
    const distinct = new Set(stops.map(s => `${s.r},${s.g},${s.b}`));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it("falls back to sourcePaletteSwatches when target missing", () => {
    const state = baseState({
      sourcePaletteSwatches: [sw(10, 220, 30, 70)],
    });
    const css = lutGradientCSS(state);
    const stops = extractStops(css);
    for (const s of stops) {
      expect(s.r).toBe(10);
      expect(s.g).toBe(220);
      expect(s.b).toBe(30);
    }
  });

  it("missing preset is treated as 'color' (no postprocess)", () => {
    const state: LutLayerState = {
      xmpVersion: 1,
      preset: undefined as unknown as string,
      paletteCount: 0,
      targetPaletteSwatches: [sw(123, 45, 67, 50)],
    };
    const css = lutGradientCSS(state);
    const stops = extractStops(css);
    expect(stops[0].r).toBe(123);
    expect(stops[0].g).toBe(45);
    expect(stops[0].b).toBe(67);
  });

  it("clamps NaN/out-of-range Lab values without throwing", () => {
    const state = baseState({
      targetPaletteSwatches: [
        { r: 999, g: -5, b: NaN as unknown as number, weight: 1, labL: NaN, labA: 0, labB: 0 },
      ],
    });
    expect(() => lutGradientCSS(state)).not.toThrow();
    const stops = extractStops(lutGradientCSS(state));
    for (const s of stops) {
      expect(s.r).toBeGreaterThanOrEqual(0);
      expect(s.r).toBeLessThanOrEqual(255);
      expect(s.g).toBeGreaterThanOrEqual(0);
      expect(s.g).toBeLessThanOrEqual(255);
      expect(s.b).toBeGreaterThanOrEqual(0);
      expect(s.b).toBeLessThanOrEqual(255);
    }
  });
});
