import { describe, it, expect } from "vitest";
import { generateReinhardLUT } from "../lutGenerator";
import { writeCubeLUT } from "../cubeWriter";
import { DEFAULT_WEIGHTS, computeLabStats } from "../reinhard";

function solidRgba(r: number, g: number, b: number, n = 8): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < out.length; i += 4) { out[i]=r; out[i+1]=g; out[i+2]=b; out[i+3]=255; }
  return out;
}

describe("3D LUT generator", () => {
  it("identity stats produces near-identity LUT", () => {
    const stats = computeLabStats(solidRgba(128, 128, 128));
    const lut = generateReinhardLUT(17, stats, stats, DEFAULT_WEIGHTS);
    // Sample a few grid points and confirm round-trip ΔRGB < 0.02.
    const size = lut.size;
    const idx = (r: number, g: number, b: number) => (b * size * size + g * size + r) * 3;
    for (const [r, g, b] of [[0, 0, 0], [size - 1, size - 1, size - 1], [size >> 1, size >> 1, size >> 1]]) {
      const i = idx(r, g, b);
      expect(Math.abs(lut.data[i] - r / (size - 1))).toBeLessThan(0.02);
      expect(Math.abs(lut.data[i + 1] - g / (size - 1))).toBeLessThan(0.02);
      expect(Math.abs(lut.data[i + 2] - b / (size - 1))).toBeLessThan(0.02);
    }
  });

  it("writes a valid .cube file", () => {
    const stats = computeLabStats(solidRgba(128, 128, 128));
    const lut = generateReinhardLUT(5, stats, stats, DEFAULT_WEIGHTS);
    const text = writeCubeLUT(lut);
    expect(text).toContain("LUT_3D_SIZE 5");
    expect(text).toContain("DOMAIN_MIN 0.0 0.0 0.0");
    // 5^3 = 125 triplets + 4 header lines + trailing newline
    const dataLines = text.trim().split("\n").slice(4);
    expect(dataLines.length).toBe(125);
    // Each data line has 3 numeric tokens.
    for (const line of dataLines) {
      const parts = line.split(/\s+/);
      expect(parts.length).toBe(3);
      for (const p of parts) expect(Number.isFinite(Number(p))).toBe(true);
    }
  });
});
