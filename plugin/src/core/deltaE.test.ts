import { describe, it, expect } from "vitest";
import { deltaE2000 } from "./deltaE";

describe("deltaE2000", () => {
  it("returns 0 for identical colors", () => {
    expect(deltaE2000(50, 2.6772, -79.7751, 50, 2.6772, -79.7751)).toBe(0);
    expect(deltaE2000(0, 0, 0, 0, 0, 0)).toBe(0);
    expect(deltaE2000(100, -50, 30, 100, -50, 30)).toBe(0);
  });

  it("matches the Sharma reference pair (≈2.0425)", () => {
    // Sharma et al. supplementary test data, pair #1.
    const d = deltaE2000(50, 2.6772, -79.7751, 50, 0, -82.7485);
    expect(d).toBeCloseTo(2.0425, 3);
  });

  it("matches a second Sharma reference pair (≈2.8615)", () => {
    // Sharma et al. supplementary test data, pair #15 (large-ΔL case).
    const d = deltaE2000(60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387);
    expect(d).toBeCloseTo(1.2644, 3);
  });

  it("is symmetric in its two color arguments", () => {
    const fwd = deltaE2000(63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864);
    const rev = deltaE2000(62.8187, -29.7946, -4.0864, 63.0109, -31.0961, -5.8663);
    expect(fwd).toBeCloseTo(rev, 10);
  });
});
