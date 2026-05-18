import { describe, it, expect } from "vitest";
import { srgbByteToOklab } from "../perceptual/oklab";
import {
  DEFAULT_BIN_COUNT,
  ASPECT_KEYS,
  neutralSmashControls,
  neutralAspectControl,
  initControls,
  setAspectRank,
  extractAspectHistograms,
  buildSmashEngine,
  applySmash,
  bakeEngineLut,
  type AspectKey,
  type AspectControl,
  type SmashControls,
  type AspectHistogramSet,
  type ImageBuffer,
} from "./engine";

// ────────── fixtures ──────────

function makeImg(w: number, h: number, fn: (t: number) => [number, number, number]): ImageBuffer {
  const data = new Uint8Array(w * h * 4);
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const [r, g, b] = fn(total > 1 ? i / (total - 1) : 0);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

const grayGradient = (lo = 0, hi = 255) =>
  makeImg(32, 32, (t) => {
    const v = Math.round(lo + t * (hi - lo));
    return [v, v, v];
  });

const colorGradient = () =>
  makeImg(32, 32, (t) => [Math.round(255 * t), 60, Math.round(255 * (1 - t))]);

const bimodalSource = () =>
  makeImg(32, 32, (t) =>
    t < 0.5 ? [40, 60, 110] : [220, 130, 30],
  );

/** Build controls with bands seeded from the histograms, then apply overrides. */
function ctrlWith(
  histograms: AspectHistogramSet,
  overrides: Partial<Record<AspectKey, Partial<AspectControl>>> = {},
): SmashControls {
  const base = initControls(histograms);
  for (const k of Object.keys(overrides) as AspectKey[]) {
    base[k] = { ...base[k], ...overrides[k] } as AspectControl;
  }
  return base;
}

// ────────── tests ──────────

describe("Smash engine v2 — per-aspect band transfer", () => {
  it("neutral controls → inert engine, applySmash is a strict no-op", () => {
    const histograms = extractAspectHistograms(colorGradient(), grayGradient());
    const engine = buildSmashEngine(histograms, neutralSmashControls());
    expect(engine.inert).toBe(true);
    for (const [r, g, b] of [
      [0, 0, 0],
      [128, 64, 200],
      [255, 255, 255],
      [33, 199, 77],
    ]) {
      expect(applySmash(engine, r, g, b)).toEqual([r, g, b]);
    }
  });

  it("amount 0 stays inert even with edited bands", () => {
    const histograms = extractAspectHistograms(colorGradient(), grayGradient());
    const spiky = new Array(DEFAULT_BIN_COUNT).fill(0).map((_, i) => (i % 3 === 0 ? 5 : 0.1));
    const engine = buildSmashEngine(
      histograms,
      ctrlWith(histograms, {
        value: { sourceBand: spiky, targetBand: spiky, amount: 0 },
        hue: { sourceBand: spiky, amount: 0 },
      }),
    );
    expect(engine.inert).toBe(true);
    expect(applySmash(engine, 90, 140, 30)).toEqual([90, 140, 30]);
  });

  it("extractAspectHistograms — 16-bin histograms that sum to ~1", () => {
    const histograms = extractAspectHistograms(colorGradient(), grayGradient());
    for (const key of ASPECT_KEYS) {
      const h = histograms[key];
      expect(h.source.length).toBe(DEFAULT_BIN_COUNT);
      expect(h.target.length).toBe(DEFAULT_BIN_COUNT);
      expect(h.sourceColors.length).toBe(DEFAULT_BIN_COUNT);
      const sum = h.source.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.99);
      expect(sum).toBeLessThan(1.01);
    }
  });

  it("the hue histogram is chroma-weighted — neutral pixels don't pollute it", () => {
    // A fully grayscale image has no meaningful hue (atan2 noise), so its
    // hue histogram is ~empty — it can't scatter spurious hues into a match.
    const grayH = extractAspectHistograms(grayGradient(0, 255), grayGradient(0, 255));
    expect(grayH.hue.source.reduce((a, b) => a + b, 0)).toBeLessThan(0.01);
    // A colourful image still has a full hue histogram.
    const colorH = extractAspectHistograms(colorGradient(), colorGradient());
    expect(colorH.hue.source.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.99);
  });

  it("applySmash is deterministic", () => {
    const histograms = extractAspectHistograms(colorGradient(), grayGradient());
    const engine = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 1 } }));
    expect(applySmash(engine, 120, 120, 120)).toEqual(applySmash(engine, 120, 120, 120));
  });

  it("value transfer (amount 1) pulls a bright input toward a dark source", () => {
    const source = grayGradient(0, 80);
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const engine = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 1 } }));
    const [r] = applySmash(engine, 200, 200, 200);
    expect(r).toBeLessThan(160);
  });

  it("matching a distribution to itself (amount 1) is ~identity", () => {
    const img = grayGradient(0, 255);
    const histograms = extractAspectHistograms(img, img);
    const engine = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 1 } }));
    for (const v of [40, 128, 210]) {
      const [r, g, b] = applySmash(engine, v, v, v);
      expect(Math.abs(r - v)).toBeLessThanOrEqual(12);
      expect(Math.abs(g - v)).toBeLessThanOrEqual(12);
      expect(Math.abs(b - v)).toBeLessThanOrEqual(12);
    }
  });

  it("colorizes a grayscale target — gray input gains chroma via the value rank", () => {
    const source = colorGradient();
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const engine = buildSmashEngine(
      histograms,
      ctrlWith(histograms, { hue: { amount: 1 }, chroma: { amount: 1 } }),
    );
    const [r, g, b] = applySmash(engine, 128, 128, 128);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(15);
  });

  it("an edited source band changes the transform (bands are live)", () => {
    const source = colorGradient();
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const natural = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 1 } }));
    // Reshape the source value band to a heavy low-end bias.
    const skew = new Array(DEFAULT_BIN_COUNT).fill(0).map((_, i) => (i < 4 ? 8 : 0.05));
    const edited = buildSmashEngine(
      histograms,
      ctrlWith(histograms, { value: { amount: 1, sourceBand: skew } }),
    );
    let anyDifference = false;
    for (let v = 16; v <= 240 && !anyDifference; v += 16) {
      const a = applySmash(natural, v, v, v);
      const b = applySmash(edited, v, v, v);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) anyDifference = true;
    }
    expect(anyDifference).toBe(true);
  });

  it("softness smooths the transfer — softness 1 differs from softness 0", () => {
    const source = bimodalSource(); // spiky histograms → softness has real bite
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const sharp = buildSmashEngine(
      histograms,
      ctrlWith(histograms, { value: { amount: 1, softness: 0 } }),
    );
    const soft = buildSmashEngine(
      histograms,
      ctrlWith(histograms, { value: { amount: 1, softness: 1 } }),
    );
    let anyDifference = false;
    for (let v = 16; v <= 240 && !anyDifference; v += 16) {
      const a = applySmash(sharp, v, v, v);
      const b = applySmash(soft, v, v, v);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) anyDifference = true;
    }
    expect(anyDifference).toBe(true);
  });

  it("rank-by cross-feed: ranking Hue by Value differs from its own axis", () => {
    const source = colorGradient();
    const target = colorGradient(); // colour target → hue is NOT degenerate
    const histograms = extractAspectHistograms(source, target);
    const ownC = ctrlWith(histograms, { hue: { amount: 1 } }); // hue ranks by hue
    const byValueC: SmashControls = {
      ...ownC,
      hue: setAspectRank(ownC.hue, "value", histograms),
    };
    const own = buildSmashEngine(histograms, ownC);
    const byValue = buildSmashEngine(histograms, byValueC);
    let anyDifference = false;
    for (let v = 16; v <= 240 && !anyDifference; v += 16) {
      const a = applySmash(own, v, 80, 255 - v);
      const b = applySmash(byValue, v, 80, 255 - v);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) anyDifference = true;
    }
    expect(anyDifference).toBe(true);
  });

  it("pickRankAxis / initControls smart-pick Value for a flat channel", () => {
    // A grayscale target has no hue/chroma spread → those channels rank by
    // Value; a coloured target keeps each channel's own axis.
    const grayC = initControls(extractAspectHistograms(colorGradient(), grayGradient(0, 255)));
    expect(grayC.hue.rankBy).toBe("value");
    expect(grayC.chroma.rankBy).toBe("value");
    expect(grayC.saturation.rankBy).toBe("value");
    expect(grayC.value.rankBy).toBe("value");

    const colorC = initControls(extractAspectHistograms(colorGradient(), colorGradient()));
    expect(colorC.hue.rankBy).toBe("hue"); // colour target → hue keeps its own axis
  });

  it("gamut-maps over-saturated colour by desaturating, not hue-clipping", () => {
    // Cranking chroma + saturation pushes colour past the sRGB gamut. The
    // output hue must stay ~equal to a moderate-chroma version (gamut mapping
    // preserves hue) — per-channel clipping would shift it to a garish hue.
    const source = colorGradient();
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const moderate = buildSmashEngine(
      histograms,
      ctrlWith(histograms, { hue: { amount: 1 }, chroma: { amount: 0.35 } }),
    );
    const cranked = buildSmashEngine(
      histograms,
      ctrlWith(histograms, {
        hue: { amount: 1 }, chroma: { amount: 1 }, saturation: { amount: 1 },
      }),
    );
    const hueOf = (rgb: readonly [number, number, number]): number => {
      const [, a, b] = srgbByteToOklab(rgb[0], rgb[1], rgb[2]);
      return Math.atan2(b, a);
    };
    for (const v of [90, 150, 210]) {
      const hm = hueOf(applySmash(moderate, v, v, v));
      const hc = hueOf(applySmash(cranked, v, v, v));
      let d = Math.abs(hm - hc);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThan(0.6); // ~34° — gamut map keeps hue; clipping wouldn't
    }
  });

  it("saturation + chroma together don't blow low-chroma pixels to neon", () => {
    const source = colorGradient();
    const target = grayGradient(0, 255);
    const histograms = extractAspectHistograms(source, target);
    const engine = buildSmashEngine(
      histograms,
      ctrlWith(histograms, {
        hue: { amount: 1 },
        chroma: { amount: 1 },
        saturation: { amount: 1 },
      }),
    );
    const a = applySmash(engine, 128, 128, 128);
    const b = applySmash(engine, 130, 128, 128);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(25);
    }
  });

  it("bakeEngineLut produces an N³×3 buffer of in-range values", () => {
    const histograms = extractAspectHistograms(colorGradient(), grayGradient());
    const engine = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 0.5 } }));
    const lut = bakeEngineLut(engine, 9);
    expect(lut.size).toBe(9);
    expect(lut.values.length).toBe(9 * 9 * 9 * 3);
    for (let i = 0; i < lut.values.length; i++) {
      expect(lut.values[i]).toBeGreaterThanOrEqual(0);
      expect(lut.values[i]).toBeLessThanOrEqual(1);
    }
  });

  it("neutralAspectControl is a no-op control", () => {
    const c = neutralAspectControl();
    expect(c.amount).toBe(0);
    expect(c.softness).toBe(0);
    expect(c.binCount).toBe(DEFAULT_BIN_COUNT);
    expect(c.sourceBand.length).toBe(DEFAULT_BIN_COUNT);
  });

  it("extracts histograms at per-aspect bin counts", () => {
    const histograms = extractAspectHistograms(
      colorGradient(),
      grayGradient(),
      { value: 8, hue: 4, saturation: 32, chroma: 16 },
    );
    expect(histograms.value.source.length).toBe(8);
    expect(histograms.hue.source.length).toBe(4);
    expect(histograms.hue.sourceColors.length).toBe(4);
    expect(histograms.saturation.target.length).toBe(32);
    expect(histograms.chroma.source.length).toBe(16);
  });

  it("a coarse-binned (4-slice) engine still transfers", () => {
    const histograms = extractAspectHistograms(
      grayGradient(0, 80),
      grayGradient(0, 255),
      { value: 4, hue: 4, saturation: 4, chroma: 4 },
    );
    const engine = buildSmashEngine(histograms, ctrlWith(histograms, { value: { amount: 1 } }));
    const [r] = applySmash(engine, 200, 200, 200);
    expect(r).toBeLessThan(170);
  });
});
