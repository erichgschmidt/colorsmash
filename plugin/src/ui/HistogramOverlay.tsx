// Diagnostic histogram strip — overlays source / target / result luma histograms in
// a single small visualization. Photographers' baseline tool for understanding what
// a color match is actually doing.
//
// Visual:
//   - Filled gray bars   = target (current state)
//   - Orange polyline    = source (where the match is pulling toward)
//   - Cyan polyline      = result (after applying the current match math)
//
// All three are log-scaled and normalized to the same height so visual comparison is
// meaningful regardless of pixel-count differences. Updates reactively as the user tweaks.

import { LumaBins, computeLumaBins } from "../core/histogramMatch";

const HEIGHT = 60;

export interface HistogramOverlayProps {
  targetData: Uint8Array | null;   // RGBA, target image (current state)
  sourceData: Uint8Array | null;   // RGBA, source image (where match pulls toward)
  resultData: Uint8Array | null;   // RGBA, result of applying the match
}

// Convert a LumaBins to a normalized log-scaled height array (0..1 per bin).
function normalizeBars(bins: LumaBins | null): number[] | null {
  if (!bins) return null;
  const c = bins.count;
  let max = 0;
  for (let i = 0; i < 256; i++) { const v = Math.log1p(c[i]); if (v > max) max = v; }
  if (max < 1e-6) return null;
  const out = new Array(256);
  for (let i = 0; i < 256; i++) out[i] = Math.log1p(c[i]) / max;
  return out;
}

// Down-sample bin heights to a polyline points string for SVG. 64 segments smooths
// the line vs raw 256 bins (which look noisy at small visual scale).
function barsToPoly(bars: number[]): string {
  const N = 64;
  const stride = 256 / N;
  const out: string[] = [];
  for (let i = 0; i <= N; i++) {
    const idx = Math.min(255, Math.round(i * stride));
    out.push(`${((idx / 255) * 100).toFixed(2)},${((1 - bars[idx]) * 100).toFixed(2)}`);
  }
  return out.join(" ");
}

export function HistogramOverlay(props: HistogramOverlayProps) {
  const tgtBars = normalizeBars(props.targetData ? computeLumaBins(props.targetData) : null);
  const srcBars = normalizeBars(props.sourceData ? computeLumaBins(props.sourceData) : null);
  const resBars = normalizeBars(props.resultData ? computeLumaBins(props.resultData) : null);

  const hasAny = tgtBars || srcBars || resBars;

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
        <span>Histograms</span>
        <span style={{ fontSize: 9 }}>
          <span style={{ color: "#888" }}>■ target</span>
          {srcBars && <> · <span style={{ color: "#e8a060" }}>— source</span></>}
          {resBars && <> · <span style={{ color: "#5fd1c8" }}>— result</span></>}
        </span>
      </div>
      <div style={{ position: "relative", height: HEIGHT, background: "#1a1a1a", border: "1px solid #444", borderRadius: 3, overflow: "hidden" }}>
        {!hasAny && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, opacity: 0.4 }}>
            (load a source + target to see histograms)
          </div>
        )}
        {tgtBars && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", pointerEvents: "none" }}>
            {tgtBars.map((h, i) => (
              <div key={i} style={{ flex: 1, height: `${h * 100}%`, background: "#6a6a6a" }} />
            ))}
          </div>
        )}
        {srcBars && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polyline points={barsToPoly(srcBars)} fill="none" stroke="#e8a060" strokeWidth="0.7" vectorEffect="non-scaling-stroke" opacity="0.85" />
          </svg>
        )}
        {resBars && (
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polyline points={barsToPoly(resBars)} fill="none" stroke="#5fd1c8" strokeWidth="0.7" vectorEffect="non-scaling-stroke" opacity="0.95" />
          </svg>
        )}
      </div>
    </div>
  );
}
