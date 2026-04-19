import { describe, it, expect } from "vitest";
import { rgbToLab, labToRgb, deltaE76 } from "../lab";

describe("Lab conversion", () => {
  it("round-trips common colors within ΔE < 0.5", () => {
    const samples = [
      { r: 1, g: 1, b: 1 },
      { r: 0, g: 0, b: 0 },
      { r: 0.5, g: 0.5, b: 0.5 },
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
      { r: 0.2, g: 0.7, b: 0.4 },
    ];
    for (const s of samples) {
      const lab = rgbToLab(s);
      const back = labToRgb(lab);
      const labBack = rgbToLab(back);
      expect(deltaE76(lab, labBack)).toBeLessThan(0.5);
    }
  });

  it("D65 white -> L≈100, a≈0, b≈0", () => {
    const lab = rgbToLab({ r: 1, g: 1, b: 1 });
    expect(lab.L).toBeGreaterThan(99.9);
    expect(Math.abs(lab.a)).toBeLessThan(0.01);
    expect(Math.abs(lab.b)).toBeLessThan(0.01);
  });
});
