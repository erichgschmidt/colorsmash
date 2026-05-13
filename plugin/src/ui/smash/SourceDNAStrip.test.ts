// Tests for SourceDNAStrip — pure presentational, no hooks, no DOM needed.
// We call the component as a plain function and inspect the returned React
// element tree directly; no @testing-library/react is required.

import { describe, it, expect } from "vitest";
import React from "react";
import { SourceDNAStrip } from "./SourceDNAStrip";
import type { BandStats } from "../../core/smash/types";

// Minimal BandStats fixture. Only the fields SourceDNAStrip actually reads are
// populated; the rest are zero/empty to keep setup noise low.
function makeBand(overrides: {
  label: string;
  pixelRatio: number;
  medianOklab: [number, number, number];
  neutralDensity: number;
  accentDensity: number;
  sampleCount: number;
}): BandStats {
  return {
    axis: "value",
    index: 0,
    label: overrides.label,
    bounds: [0, 1],
    softWidth: 0,
    center: 0.5,
    pixelRatio: overrides.pixelRatio,
    meanOklab: overrides.medianOklab,
    medianOklab: overrides.medianOklab,
    dominantHue: 0,
    hueSpread: 0,
    satMedian: 0,
    chromaMedian: 0,
    chromaSpread: 0,
    neutralDensity: overrides.neutralDensity,
    accentDensity: overrides.accentDensity,
    histogram: new Float32Array(0),
    sampleCount: overrides.sampleCount,
  } as unknown as BandStats;
}

const shadowsBand = makeBand({
  label: "Shadows",
  pixelRatio: 0.3,
  medianOklab: [0.2, 0.0, 0.0],
  neutralDensity: 0.8,
  accentDensity: 0.1,
  sampleCount: 1000,
});

const midsBand = makeBand({
  label: "Mids",
  pixelRatio: 0.5,
  medianOklab: [0.5, 0.05, -0.05],
  neutralDensity: 0.4,
  accentDensity: 0.5,
  sampleCount: 2000,
});

const highlightsBand = makeBand({
  label: "Highlights",
  pixelRatio: 0.2,
  medianOklab: [0.85, 0.0, 0.0],
  neutralDensity: 0.9,
  accentDensity: 0.05,
  sampleCount: 800,
});

const emptyBand = makeBand({
  label: "Mids",
  pixelRatio: 0.0,
  medianOklab: [0.5, 0.0, 0.0],
  neutralDensity: 0.0,
  accentDensity: 0.0,
  sampleCount: 0,
});

// Helper: given a React element (div with children), return an array of its
// children as React elements.
function getChildren(el: React.ReactElement): React.ReactElement[] {
  const children = el.props.children;
  if (!children) return [];
  if (Array.isArray(children)) return children as React.ReactElement[];
  return [children as React.ReactElement];
}

describe("SourceDNAStrip", () => {
  it("returns null for empty bands array", () => {
    const result = SourceDNAStrip({ bands: [] });
    expect(result).toBeNull();
  });

  it("returns a non-null element for a single band", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    expect(result).not.toBeNull();
  });

  it("renders one segment child per band", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand, midsBand, highlightsBand] });
    expect(result).not.toBeNull();
    const segments = getChildren(result as React.ReactElement);
    expect(segments).toHaveLength(3);
  });

  it("attaches an onClick handler to each segment when onBandClick is provided", () => {
    const clickedIndices: number[] = [];
    const result = SourceDNAStrip({
      bands: [shadowsBand, midsBand],
      onBandClick: (i) => clickedIndices.push(i),
    });
    const segments = getChildren(result as React.ReactElement);
    // Each segment should have an onClick prop.
    expect(segments[0].props.onClick).toBeTypeOf("function");
    expect(segments[1].props.onClick).toBeTypeOf("function");
    // Calling them should forward the correct band index.
    segments[0].props.onClick();
    segments[1].props.onClick();
    expect(clickedIndices).toEqual([0, 1]);
  });

  it("does not attach onClick when onBandClick is absent", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const segments = getChildren(result as React.ReactElement);
    expect(segments[0].props.onClick).toBeUndefined();
  });

  it("marks an empty-band segment with the diagonal stripe background", () => {
    const result = SourceDNAStrip({ bands: [emptyBand] });
    const segments = getChildren(result as React.ReactElement);
    const bg: string = segments[0].props.style.background;
    // The stripe pattern is applied via repeating-linear-gradient for sampleCount === 0.
    expect(bg).toContain("repeating-linear-gradient");
  });

  it("does not apply stripe pattern to non-empty bands", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const segments = getChildren(result as React.ReactElement);
    const bg: string = segments[0].props.style.background;
    expect(bg).not.toContain("repeating-linear-gradient");
  });

  it("segment flexGrow values are proportional to pixelRatio", () => {
    const bands = [shadowsBand, midsBand, highlightsBand]; // ratios: 0.3, 0.5, 0.2
    const result = SourceDNAStrip({ bands });
    const segments = getChildren(result as React.ReactElement);

    const growValues: number[] = segments.map((s) => s.props.style.flexGrow as number);
    const growSum = growValues.reduce((a, b) => a + b, 0);

    // Each segment's flexGrow / total should approximate its pixelRatio.
    const totalRatio = bands.reduce((s, b) => s + b.pixelRatio, 0);
    bands.forEach((band, i) => {
      const expected = band.pixelRatio / totalRatio;
      const actual = growValues[i] / growSum;
      expect(actual).toBeCloseTo(expected, 2);
    });
  });

  it("uses white text for dark bands (L <= 0.55)", () => {
    // shadowsBand has L=0.2, well below threshold.
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const segments = getChildren(result as React.ReactElement);
    // First child of the segment is the label div.
    const labelDiv = getChildren(segments[0])[0];
    expect(labelDiv.props.style.color).toBe("#ffffff");
  });

  it("uses black text for bright bands (L > 0.55)", () => {
    // highlightsBand has L=0.85, above threshold.
    const result = SourceDNAStrip({ bands: [highlightsBand] });
    const segments = getChildren(result as React.ReactElement);
    const labelDiv = getChildren(segments[0])[0];
    expect(labelDiv.props.style.color).toBe("#000000");
  });

  it("respects custom height prop", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand], height: 48 });
    const el = result as React.ReactElement;
    expect(el.props.style.height).toBe(48);
  });

  it("uses default height of 32 when no height prop is given", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const el = result as React.ReactElement;
    expect(el.props.style.height).toBe(32);
  });

  it("neutral pip opacity reflects band.neutralDensity", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const segments = getChildren(result as React.ReactElement);
    // segment children: [labelDiv, pipRowDiv]
    const pipRow = getChildren(segments[0])[1];
    const [neutralPip] = getChildren(pipRow);
    expect(neutralPip.props.style.opacity).toBe(shadowsBand.neutralDensity);
  });

  it("accent pip opacity reflects band.accentDensity", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const segments = getChildren(result as React.ReactElement);
    const pipRow = getChildren(segments[0])[1];
    const [, accentPip] = getChildren(pipRow);
    expect(accentPip.props.style.opacity).toBe(shadowsBand.accentDensity);
  });

  it("strip container has a 1px dark border and 4px rounded corners", () => {
    const result = SourceDNAStrip({ bands: [shadowsBand] });
    const el = result as React.ReactElement;
    expect(el.props.style.border).toBe("1px solid #1a1a1a");
    expect(el.props.style.borderRadius).toBe(4);
  });
});
