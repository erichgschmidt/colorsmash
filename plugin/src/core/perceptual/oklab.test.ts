import { describe, it, expect } from "vitest";
import {
  srgbByteToOklab,
  oklabToSrgbByte,
  oklabToOklch,
  oklchToOklab,
} from "./oklab";
import { perceptualLuma } from "./luma";
import { adaptiveBandEdges } from "./bandEdges";

// ────────── Round-trip sRGB → Oklab → sRGB ──────────

const ROUND_TRIP_COLORS: [string, number, number, number][] = [
  ["red",            255,   0,   0],
  ["green",            0, 255,   0],
  ["blue",             0,   0, 255],
  ["white",          255, 255, 255],
  ["black",            0,   0,   0],
  ["50% gray",       128, 128, 128],
  ["magenta",        255,   0, 255],
  ["cyan",             0, 255, 255],
  ["yellow",         255, 255,   0],
  ["saturated orange", 255, 128,  32],
  ["deep teal",       12,  80, 100],
];

describe("srgbByteToOklab / oklabToSrgbByte round trip", () => {
  for (const [name, r, g, b] of ROUND_TRIP_COLORS) {
    it(`round trips within 1 byte: ${name} (${r},${g},${b})`, () => {
      const [L, a, ob] = srgbByteToOklab(r, g, b);
      const [rOut, gOut, bOut] = oklabToSrgbByte(L, a, ob);
      expect(Math.abs(rOut - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(gOut - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(bOut - b)).toBeLessThanOrEqual(1);
    });
  }
});

// ────────── Oklab L anchor values ──────────

describe("Oklab L for known anchors", () => {
  it("white L is within 0.01 of 1.0", () => {
    const [L] = srgbByteToOklab(255, 255, 255);
    expect(Math.abs(L - 1.0)).toBeLessThan(0.01);
  });

  it("black L is within 0.01 of 0.0", () => {
    const [L] = srgbByteToOklab(0, 0, 0);
    expect(Math.abs(L - 0.0)).toBeLessThan(0.01);
  });

  it("sRGB 50% gray L is in [0.55, 0.65] (perceptually lighter than half)", () => {
    const [L] = srgbByteToOklab(128, 128, 128);
    expect(L).toBeGreaterThanOrEqual(0.55);
    expect(L).toBeLessThanOrEqual(0.65);
  });
});

// ────────── Chrominance for neutrals ──────────

describe("Oklab a, b for pure white", () => {
  it("a is within 1e-4 of 0", () => {
    const [, a] = srgbByteToOklab(255, 255, 255);
    expect(Math.abs(a)).toBeLessThan(1e-4);
  });

  it("b is within 1e-4 of 0", () => {
    const [, , ob] = srgbByteToOklab(255, 255, 255);
    expect(Math.abs(ob)).toBeLessThan(1e-4);
  });
});

// ────────── OkLCh round trip ──────────

describe("OkLCh round trip", () => {
  it("oklabToOklch then oklchToOklab matches within 1e-9 for a saturated color", () => {
    const [L, a, b] = srgbByteToOklab(255, 128, 32);
    const { L: Lc, C, h } = oklabToOklch(L, a, b);
    const [Lo, ao, bo] = oklchToOklab(Lc, C, h);
    expect(Math.abs(Lo - L)).toBeLessThan(1e-9);
    expect(Math.abs(ao - a)).toBeLessThan(1e-9);
    expect(Math.abs(bo - b)).toBeLessThan(1e-9);
  });

  it("oklabToOklch then oklchToOklab matches within 1e-9 for a neutral color", () => {
    const [L, a, b] = srgbByteToOklab(128, 128, 128);
    const { L: Lc, C, h } = oklabToOklch(L, a, b);
    const [Lo, ao, bo] = oklchToOklab(Lc, C, h);
    expect(Math.abs(Lo - L)).toBeLessThan(1e-9);
    expect(Math.abs(ao - a)).toBeLessThan(1e-9);
    expect(Math.abs(bo - b)).toBeLessThan(1e-9);
  });
});

// ────────── perceptualLuma ──────────

describe("perceptualLuma", () => {
  const TEST_COLORS: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128],
    [255, 128, 32],
    [12, 80, 100],
  ];

  for (const [r, g, b] of TEST_COLORS) {
    it(`perceptualLuma matches srgbByteToOklab L for (${r},${g},${b})`, () => {
      const [L] = srgbByteToOklab(r, g, b);
      const luma = perceptualLuma(r, g, b);
      expect(Math.abs(luma - L)).toBeLessThan(1e-9);
    });
  }
});

// ────────── adaptiveBandEdges ──────────

describe("adaptiveBandEdges", () => {
  it("3-band of a uniform 0..1 ramp gives edges approx [0, 0.33, 0.67, 1.0] within 0.05", () => {
    const n = 1000;
    const lumas = new Float32Array(n);
    for (let i = 0; i < n; i++) lumas[i] = i / (n - 1);
    const edges = adaptiveBandEdges(lumas, 3);
    expect(edges).toHaveLength(4);
    expect(Math.abs(edges[0]! - 0)).toBeLessThan(0.05);
    expect(Math.abs(edges[1]! - 1 / 3)).toBeLessThan(0.05);
    expect(Math.abs(edges[2]! - 2 / 3)).toBeLessThan(0.05);
    expect(Math.abs(edges[3]! - 1)).toBeLessThan(0.05);
  });

  it("returns count+1 elements for count=3", () => {
    const lumas = new Float32Array([0.1, 0.5, 0.9]);
    expect(adaptiveBandEdges(lumas, 3)).toHaveLength(4);
  });

  it("returns count+1 elements for count=5", () => {
    const lumas = new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]);
    expect(adaptiveBandEdges(lumas, 5)).toHaveLength(6);
  });

  it("returns count+1 elements for count=7", () => {
    const lumas = new Float32Array([0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9]);
    expect(adaptiveBandEdges(lumas, 7)).toHaveLength(8);
  });

  it("edges are monotonically non-decreasing for count=3", () => {
    const n = 500;
    const lumas = new Float32Array(n);
    // Non-uniform distribution: more darks.
    for (let i = 0; i < n; i++) lumas[i] = (i / (n - 1)) ** 2;
    const edges = adaptiveBandEdges(lumas, 3);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]!).toBeGreaterThanOrEqual(edges[i - 1]!);
    }
  });

  it("edges are monotonically non-decreasing for count=5", () => {
    const n = 800;
    const lumas = new Float32Array(n);
    for (let i = 0; i < n; i++) lumas[i] = Math.random();
    const edges = adaptiveBandEdges(lumas, 5);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]!).toBeGreaterThanOrEqual(edges[i - 1]!);
    }
  });

  it("edges are monotonically non-decreasing for count=7", () => {
    const n = 600;
    const lumas = new Float32Array(n);
    for (let i = 0; i < n; i++) lumas[i] = Math.sqrt(i / (n - 1));
    const edges = adaptiveBandEdges(lumas, 7);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]!).toBeGreaterThanOrEqual(edges[i - 1]!);
    }
  });
});
