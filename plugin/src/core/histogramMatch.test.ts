import { describe, it, expect } from "vitest";
import {
  fitHistogramCurves,
  fitHistogramCurvesLab,
  processChannelCurves,
  capStretch,
  buildZoneWeights,
  buildEnvelopeWeights,
  lumaRange,
  computeLumaBins,
  applyZoneAndEnvelopeToChannels,
  DEFAULT_ZONES,
  DEFAULT_ENVELOPE,
  type ChannelCurves,
  type EnvelopePoint,
} from "../core/histogramMatch";

// ─── Helpers ──────────────────────────────────────────────────────────────

// Random-ish but deterministic RGBA buffer (alpha = 255).
function makeRgba(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n * 4);
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s & 0xff;
  };
  for (let i = 0; i < n; i++) {
    out[i * 4]     = rand();
    out[i * 4 + 1] = rand();
    out[i * 4 + 2] = rand();
    out[i * 4 + 3] = 255;
  }
  return out;
}

function identityCurve(): Uint8Array {
  const c = new Uint8Array(256);
  for (let i = 0; i < 256; i++) c[i] = i;
  return c;
}

function maxAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

// ─── fitHistogramCurves ───────────────────────────────────────────────────

describe("fitHistogramCurves", () => {
  it("returns ChannelCurves with .r/.g/.b each Uint8Array(256)", () => {
    const buf = makeRgba(64);
    const c = fitHistogramCurves(buf, buf);
    for (const ch of ["r", "g", "b"] as const) {
      expect(c[ch]).toBeInstanceOf(Uint8Array);
      expect(c[ch].length).toBe(256);
    }
  });

  it("identity: src === tgt produces ~identity curves", () => {
    const buf = makeRgba(2048, 42);
    const c = fitHistogramCurves(buf, buf);
    const id = identityCurve();
    // CDF-based specification on the same histogram is approximately identity, but
    // bins missing in the data are filled by the "smallest u with srcCDF[u] >= target"
    // rule, which can drift on empty bins. Allow small drift.
    expect(maxAbsDiff(c.r, id)).toBeLessThan(2);
    expect(maxAbsDiff(c.g, id)).toBeLessThan(2);
    expect(maxAbsDiff(c.b, id)).toBeLessThan(2);
  });
});

// ─── fitHistogramCurvesLab ────────────────────────────────────────────────

describe("fitHistogramCurvesLab", () => {
  it("returns ChannelCurves with .r/.g/.b each Uint8Array(256)", () => {
    const buf = makeRgba(64);
    const c = fitHistogramCurvesLab(buf, buf);
    for (const ch of ["r", "g", "b"] as const) {
      expect(c[ch]).toBeInstanceOf(Uint8Array);
      expect(c[ch].length).toBe(256);
    }
  });

  it("identity: src === tgt produces approximately identity curves on populated bins", () => {
    const buf = makeRgba(4096, 7);
    const c = fitHistogramCurvesLab(buf, buf);
    // Lab→spec→Lab→RGB round trip introduces small drift even at identity (sRGB↔Lab
    // quantization, Round/clamp, monotonic enforcement, back-fill from front). On bins
    // that the sample buffer actually covers, the curve should track identity within
    // a few units.
    const present = new Set<number>();
    for (let i = 0; i < buf.length; i += 4) present.add(buf[i]);
    let maxR = 0;
    for (const v of present) maxR = Math.max(maxR, Math.abs(c.r[v] - v));
    expect(maxR).toBeLessThan(8);
  });
});

// ─── processChannelCurves ─────────────────────────────────────────────────

describe("processChannelCurves", () => {
  it("amount=0 produces identity curves regardless of input", () => {
    const buf = makeRgba(512);
    const raw = fitHistogramCurves(buf, makeRgba(512, 99));
    const out = processChannelCurves(raw, {
      amount: 0,
      smoothRadius: 0,
      maxStretch: 100, // disable cap
    });
    const id = identityCurve();
    expect(maxAbsDiff(out.r, id)).toBe(0);
    expect(maxAbsDiff(out.g, id)).toBe(0);
    expect(maxAbsDiff(out.b, id)).toBe(0);
  });

  it("amount=1 with no cap & no smooth passes raw through (modulo monotonic)", () => {
    // Construct a strictly monotonic raw curve so enforceMonotonic is a no-op.
    const raw: ChannelCurves = {
      r: identityCurve(),
      g: identityCurve(),
      b: identityCurve(),
    };
    // Tweak slightly but keep monotonic.
    for (let i = 0; i < 256; i++) raw.r[i] = Math.min(255, i + (i % 2));
    const out = processChannelCurves(raw, {
      amount: 1,
      smoothRadius: 0,
      maxStretch: 100, // ≥ 100 disables cap branch
    });
    // Enforcing monotonic on a near-monotonic curve shouldn't change much.
    expect(maxAbsDiff(out.r, raw.r)).toBeLessThanOrEqual(1);
    expect(maxAbsDiff(out.g, raw.g)).toBe(0);
    expect(maxAbsDiff(out.b, raw.b)).toBe(0);
  });
});

// ─── capStretch ───────────────────────────────────────────────────────────

describe("capStretch", () => {
  it("maxRatio=1: |Δoutput| ≤ 1 between adjacent samples in anchored range", () => {
    // Steep ramp 0→255 across input → 1px-jumps everywhere violate the cap.
    const steep = new Uint8Array(256);
    for (let i = 0; i < 256; i++) steep[i] = Math.min(255, i * 4);
    const out = capStretch(steep, 1);
    for (let v = 1; v < 256; v++) {
      expect(Math.abs(out[v] - out[v - 1])).toBeLessThanOrEqual(1);
    }
  });

  it("with `range`, values outside the range equal the input curve unchanged", () => {
    const steep = new Uint8Array(256);
    for (let i = 0; i < 256; i++) steep[i] = Math.min(255, i * 3);
    const out = capStretch(steep, 1, { start: 50, end: 200 });
    // Outside the range the function should leave the input untouched.
    for (let v = 0; v < 50; v++) expect(out[v]).toBe(steep[v]);
    for (let v = 201; v < 256; v++) expect(out[v]).toBe(steep[v]);
    // Inside the range the cap holds: |Δ| ≤ 1.
    for (let v = 51; v <= 200; v++) {
      expect(Math.abs(out[v] - out[v - 1])).toBeLessThanOrEqual(1);
    }
  });
});

// ─── buildZoneWeights ─────────────────────────────────────────────────────

describe("buildZoneWeights", () => {
  it("all amounts=100 and biases=0 → weights ≈ 1.0 everywhere (partition of unity)", () => {
    const w = buildZoneWeights(DEFAULT_ZONES);
    for (let v = 0; v < 256; v++) {
      expect(w[v]).toBeGreaterThan(0.999);
      expect(w[v]).toBeLessThan(1.001);
    }
  });

  it("one zone amount=0 → weight dips near that zone's anchor", () => {
    const opts = { ...DEFAULT_ZONES, mids: 0 };
    const w = buildZoneWeights(opts);
    // Near the mids anchor (127), weight should be noticeably less than at endpoints
    // (which are dominated by shadows/highlights at full strength).
    expect(w[127]).toBeLessThan(0.5);
    expect(w[0]).toBeGreaterThan(0.9);
    expect(w[255]).toBeGreaterThan(0.9);
  });

  it("one zone bias=+100 → that zone's weight dominates near its anchor", () => {
    // To make bias observable we need the amounts to differ — otherwise the
    // partition-of-unity normalization cancels the relative weighting and the
    // output is 1 everywhere regardless of bias. Drop mids amount and boost mids
    // bias: the boost should pull the mid-region weight UP toward mids' (lower)
    // amount, dragging the average at v=127 noticeably lower than the unboosted
    // baseline.
    const baseline = buildZoneWeights({ ...DEFAULT_ZONES, mids: 0 });
    const boosted  = buildZoneWeights({ ...DEFAULT_ZONES, mids: 0, midsBias: 100 });
    // At v=127 mids dominates more strongly under bias → weight closer to mids' 0.
    expect(boosted[127]).toBeLessThan(baseline[127]);
    expect(boosted[127]).toBeLessThan(0.1); // mids (=0) basically wins
    // Sanity: the two weight arrays differ overall.
    let differs = false;
    for (let v = 0; v < 256; v++) if (Math.abs(boosted[v] - baseline[v]) > 1e-6) { differs = true; break; }
    expect(differs).toBe(true);
  });
});

// ─── buildEnvelopeWeights ─────────────────────────────────────────────────

describe("buildEnvelopeWeights", () => {
  it("empty array → all 1.0", () => {
    const w = buildEnvelopeWeights([]);
    for (let v = 0; v < 256; v++) expect(w[v]).toBe(1);
  });

  it("single point at weight=0.5 → all 0.5", () => {
    const w = buildEnvelopeWeights([{ position: 100, weight: 0.5 }]);
    for (let v = 0; v < 256; v++) expect(w[v]).toBeCloseTo(0.5, 10);
  });

  it("two linear (smooth=false) points → linear interpolation; clamps outside the range", () => {
    const pts: EnvelopePoint[] = [
      { position: 64,  weight: 0.0, smooth: false },
      { position: 192, weight: 1.0, smooth: false },
    ];
    const w = buildEnvelopeWeights(pts);
    // Outside the range clamps to endpoint weight.
    for (let v = 0; v < 64; v++) expect(w[v]).toBeCloseTo(0.0, 10);
    for (let v = 192; v < 256; v++) expect(w[v]).toBeCloseTo(1.0, 10);
    // Midpoint of the segment (64+192)/2 = 128 → 0.5.
    expect(w[128]).toBeCloseTo(0.5, 2);
    // 96 is one quarter into the segment → 0.25.
    expect(w[96]).toBeCloseTo(0.25, 2);
  });

  it("smooth=true 3-point envelope with peak in middle: strict no-overshoot (Fritsch-Carlson)", () => {
    // Regression test for the FC peak-tangent bug: at extremum points where adjacent
    // secants change sign, the tangent must be forced to 0 to prevent overshoot. Without
    // that step, this peak-in-middle envelope bulges visibly above weight=2.
    const pts: EnvelopePoint[] = [
      { position: 0,   weight: 1, smooth: true },
      { position: 127, weight: 2, smooth: true },
      { position: 255, weight: 0, smooth: true },
    ];
    const w = buildEnvelopeWeights(pts);
    // Strict bounds — no value should exceed the peak weight or dip below 0. Allow only
    // float-rounding epsilon (1e-9), not algorithmic slop.
    for (let v = 0; v < 256; v++) {
      expect(w[v]).toBeGreaterThanOrEqual(-1e-9);
      expect(w[v]).toBeLessThanOrEqual(2 + 1e-9);
    }
    // Strictly monotonic on each side of the peak.
    for (let v = 1; v <= 127; v++) expect(w[v]).toBeGreaterThanOrEqual(w[v - 1] - 1e-9);
    for (let v = 128; v < 256; v++) expect(w[v]).toBeLessThanOrEqual(w[v - 1] + 1e-9);
    // Endpoints + peak exact.
    expect(w[0]).toBeCloseTo(1, 9);
    expect(w[127]).toBeCloseTo(2, 9);
    expect(w[255]).toBeCloseTo(0, 9);
  });

  it("smooth=true 3-point envelope with valley in middle: strict no-undershoot", () => {
    // Mirror of the peak test — same FC sign-change rule applies at valleys.
    const pts: EnvelopePoint[] = [
      { position: 0,   weight: 1.5, smooth: true },
      { position: 127, weight: 0.0, smooth: true },
      { position: 255, weight: 1.5, smooth: true },
    ];
    const w = buildEnvelopeWeights(pts);
    for (let v = 0; v < 256; v++) {
      expect(w[v]).toBeGreaterThanOrEqual(-1e-9); // never dips below the valley
      expect(w[v]).toBeLessThanOrEqual(1.5 + 1e-9); // never exceeds the endpoints
    }
    // Strictly monotonic decreasing then increasing.
    for (let v = 1; v <= 127; v++) expect(w[v]).toBeLessThanOrEqual(w[v - 1] + 1e-9);
    for (let v = 128; v < 256; v++) expect(w[v]).toBeGreaterThanOrEqual(w[v - 1] - 1e-9);
    expect(w[127]).toBeCloseTo(0, 9);
  });
});

// ─── lumaRange ────────────────────────────────────────────────────────────

describe("lumaRange", () => {
  it("returns approximately the bin range with non-trivial mass", () => {
    // Build a fake LumaBins where only bins 50..200 have count > 0.
    const bins = {
      sumR: new Float64Array(256),
      sumG: new Float64Array(256),
      sumB: new Float64Array(256),
      count: new Uint32Array(256),
    };
    for (let i = 50; i <= 200; i++) bins.count[i] = 1000;
    const r = lumaRange(bins);
    expect(r.start).toBe(50);
    expect(r.end).toBe(200);
  });
});

// ─── computeLumaBins ──────────────────────────────────────────────────────

describe("computeLumaBins", () => {
  it("counts pixels at expected luma bins (Rec.709)", () => {
    // Build buffer of known colors. Rec.709: 0.2126*R + 0.7152*G + 0.0722*B.
    // Pure black, pure white, pure red, pure green, pure blue.
    const px = new Uint8Array([
      0,   0,   0,   255,   // luma 0
      255, 255, 255, 255,   // luma 255
      255, 0,   0,   255,   // luma round(0.2126*255)=54
      0,   255, 0,   255,   // luma round(0.7152*255)=182
      0,   0,   255, 255,   // luma round(0.0722*255)=18
    ]);
    const bins = computeLumaBins(px);
    expect(bins.count[0]).toBe(1);
    expect(bins.count[255]).toBe(1);
    expect(bins.count[54]).toBe(1);
    expect(bins.count[182]).toBe(1);
    expect(bins.count[18]).toBe(1);
    // sumR at the red bin should be 255.
    expect(bins.sumR[54]).toBe(255);
    expect(bins.sumG[182]).toBe(255);
    expect(bins.sumB[18]).toBe(255);
  });

  it("skips transparent pixels (alpha < 8)", () => {
    const px = new Uint8Array([
      255, 255, 255, 0,    // transparent → skipped
      128, 128, 128, 255,  // counted, luma 128
    ]);
    const bins = computeLumaBins(px);
    let total = 0;
    for (let i = 0; i < 256; i++) total += bins.count[i];
    expect(total).toBe(1);
    expect(bins.count[128]).toBe(1);
  });
});

// ─── applyZoneAndEnvelopeToChannels ───────────────────────────────────────

describe("applyZoneAndEnvelopeToChannels", () => {
  it("default zones + default envelope is a no-op (output ≈ input curves)", () => {
    // Construct non-trivial input curves.
    const raw: ChannelCurves = {
      r: new Uint8Array(256),
      g: new Uint8Array(256),
      b: new Uint8Array(256),
    };
    for (let i = 0; i < 256; i++) {
      raw.r[i] = Math.min(255, Math.max(0, Math.round(i * 0.9 + 10)));
      raw.g[i] = Math.min(255, Math.max(0, Math.round(i * 1.1)));
      raw.b[i] = Math.min(255, Math.max(0, i));
    }
    const out = applyZoneAndEnvelopeToChannels(raw, DEFAULT_ZONES, DEFAULT_ENVELOPE);
    // Default weights ≈ 1 everywhere → applyZoneWeights returns ~raw, then enforceMonotonic.
    // Tolerance of 1 covers rounding (Math.round in the blend).
    expect(maxAbsDiff(out.r, raw.r)).toBeLessThanOrEqual(1);
    expect(maxAbsDiff(out.g, raw.g)).toBeLessThanOrEqual(1);
    expect(maxAbsDiff(out.b, raw.b)).toBeLessThanOrEqual(1);
  });
});
