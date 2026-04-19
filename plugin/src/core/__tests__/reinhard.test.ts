import { describe, it, expect } from "vitest";
import { computeLabStats, applyReinhard } from "../reinhard";

function solidRgba(r: number, g: number, b: number, n = 16): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < out.length; i += 4) { out[i]=r; out[i+1]=g; out[i+2]=b; out[i+3]=255; }
  return out;
}

describe("Reinhard transfer", () => {
  it("solid target shifts toward source mean", () => {
    const src = solidRgba(200, 100, 50);
    const tgt = solidRgba(100, 100, 100);
    const sStats = computeLabStats(src);
    const tStats = computeLabStats(tgt);
    applyReinhard(tgt, sStats, tStats);
    // After transfer, target should now approximate source color (σ on solids is 0 → mean shift only).
    expect(Math.abs(tgt[0] - 200)).toBeLessThan(3);
    expect(Math.abs(tgt[1] - 100)).toBeLessThan(3);
    expect(Math.abs(tgt[2] - 50)).toBeLessThan(3);
  });
});
