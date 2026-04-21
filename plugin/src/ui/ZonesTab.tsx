// Zones tab — Lumetri-wheels-style with multi-thumb sliders.
// Each parameter slider shows all 3 zones at once; range sliders cascade so zones don't cross.

import { useEffect, useRef, useState } from "react";
import { applyZones, autoDetectTonal, labStatsInBand, lPercentiles, lMeanStddev, IDENTITY_TONAL, type ZonesState, type ZoneState, type TonalState } from "../core/zoneTransform";
import { useLayerPreview } from "./useLayerPreview";
import { useLayers } from "./useLayers";
import { bakeZones } from "../app/bakeZones";
import { MultiThumbSlider, type ZoneKey, ZONE_COLORS } from "./MultiThumbSlider";
import { TonalZonesSlider, type TonalBounds, boundsToRanges as boundsToRangesFn } from "./TonalZonesSlider";
import { Histogram } from "./Histogram";
import { PreviewPane } from "./PreviewPane";

const DEFAULT_ZONE: ZoneState = {
  hue: 0, sat: 0,
  colorR: 128, colorG: 128, colorB: 128, colorIntensity: 0,
  rangeStart: 0, rangeEnd: 100, featherLeft: 15, featherRight: 15,
};

interface FieldSpec {
  key: keyof ZoneState; label: string; min: number; max: number;
}
// Per-zone parameters only — value/range/feather now global or in TonalZonesSlider.
const FIELDS: FieldSpec[] = [
  { key: "hue",            label: "Hue",       min: -180, max: 180 },
  { key: "sat",            label: "Sat",       min: -100, max: 100 },
  { key: "colorIntensity", label: "Color int", min: 0,    max: 100 },
];

const DEFAULT_BOUNDS: TonalBounds = { t1: 25, t2: 40, t3: 60, t4: 75, pad1: 0, pad2: 0 };

// Uncontrolled tonal slider row — value updates label via ref, no React re-render per drag tick.
function TonalSliderRow(props: {
  label: string; min: number; max: number; step: number;
  defaultValue: number; format: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7 }}>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step}
        defaultValue={props.defaultValue}
        onInput={e => {
          const v = Number((e.target as HTMLInputElement).value);
          if (labelRef.current) labelRef.current.textContent = props.format(v);
          props.onInput(v);
        }}
        style={{ flex: 1, minWidth: 0 }} />
      <span ref={labelRef} style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{props.format(props.defaultValue)}</span>
    </div>
  );
}

function applyBoundsToDefaults(b: TonalBounds): ZonesState {
  const ranges = boundsToRangesFn(b);
  return {
    tonal: { ...IDENTITY_TONAL },
    shadows:    { ...DEFAULT_ZONE, ...ranges.shadows },
    midtones:   { ...DEFAULT_ZONE, ...ranges.midtones },
    highlights: { ...DEFAULT_ZONE, ...ranges.highlights },
  };
}

export function ZonesTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    } else if (layers.length === 1) {
      if (targetId == null) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const { snap: sourceSnap, refresh: refreshSource } = useLayerPreview(sourceId);
  const { snap: targetSnap, refresh: refreshTarget } = useLayerPreview(targetId);
  const preview = targetSnap; // existing code paths reference `preview` for the target
  const boundsRef = useRef<TonalBounds>({ ...DEFAULT_BOUNDS });
  const zonesRef = useRef<ZonesState>(applyBoundsToDefaults({ ...DEFAULT_BOUNDS }));
  const [activeZone, setActiveZone] = useState<ZoneKey>("midtones");
  const [valuesEpoch, setValuesEpoch] = useState(0); // bumped when we want sliders to re-sync from refs
  const [tintHex, setTintHex] = useState("#808080");
  const [transformedTarget, setTransformedTarget] = useState<Uint8Array | null>(null);
  const rafPending = useRef(false);
  const [status, setStatus] = useState("Live preview · drag any thumb (zone-colored) to edit that zone. Range sliders cascade so zones can't cross.");

  const scheduleRedraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      if (!preview) return;
      const transformed = applyZones(preview.data, zonesRef.current);
      setTransformedTarget(transformed);
    });
  };

  useEffect(scheduleRedraw, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const z = zonesRef.current[activeZone];
    const r = z.colorR.toString(16).padStart(2, "0");
    const g = z.colorG.toString(16).padStart(2, "0");
    const b = z.colorB.toString(16).padStart(2, "0");
    setTintHex(`#${r}${g}${b}`);
  }, [activeZone]);

  const onSliderChange = (key: keyof ZoneState) => (zone: ZoneKey, v: number) => {
    (zonesRef.current[zone] as any)[key] = v;
    scheduleRedraw();
    scheduleHighlightRefresh();
  };

  const onBoundsChange = (b: TonalBounds) => {
    boundsRef.current = { ...b };
    const ranges = boundsToRangesFn(b);
    zonesRef.current.shadows = { ...zonesRef.current.shadows, ...ranges.shadows };
    zonesRef.current.midtones = { ...zonesRef.current.midtones, ...ranges.midtones };
    zonesRef.current.highlights = { ...zonesRef.current.highlights, ...ranges.highlights };
    scheduleRedraw();
    scheduleHighlightRefresh();
  };

  // Drag updates: only ref + redraw; no React state change so the slider doesn't re-mount mid-drag.
  const onTonalChange = (patch: Partial<TonalState>) => {
    zonesRef.current.tonal = { ...zonesRef.current.tonal, ...patch };
    scheduleRedraw();
  };

  const onAutoLevel = () => {
    if (!preview) return;
    // Stretch target to its own range (output = 0..255).
    const { blackPoint, whitePoint } = autoDetectTonal(preview.data);
    zonesRef.current.tonal = {
      ...zonesRef.current.tonal, blackPoint, whitePoint, outputBlack: 0, outputWhite: 255,
    };
    scheduleRedraw();
    setTonalEpoch(n => n + 1);
  };

  // Auto Match: detect target's value range AND source's value range, then map target into
  // source's range so the result occupies the same tonal extent as the source. Also samples
  // source's per-zone mean color into each zone's color picker.
  const onAutoMatch = () => {
    if (!sourceSnap || !targetSnap) { setStatus("Pick both source and target."); return; }

    // Reinhard L-axis affine via Levels:
    //   output_L = (input_L - μt) * (σs/σt) + μs
    // Set Levels black/white so the layer reproduces this exactly with gamma = 1:
    //   input  black/white = μt ± 2σt   (captures ~95% of target's distribution)
    //   output black/white = μs ± 2σs   (maps to ~95% of source's distribution)
    // Clamps prevent blow-outs when source's spread is wide; the data is rescaled, not stretched
    // beyond the bounds the source itself uses.
    const tgt = lMeanStddev(targetSnap.data);
    const src = lMeanStddev(sourceSnap.data);
    const SIGMA = 2;
    const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const tgtBlack = clampByte(tgt.mean - SIGMA * tgt.stddev);
    const tgtWhite = clampByte(tgt.mean + SIGMA * tgt.stddev);
    const srcBlack = clampByte(src.mean - SIGMA * src.stddev);
    const srcWhite = clampByte(src.mean + SIGMA * src.stddev);
    zonesRef.current.tonal = {
      ...zonesRef.current.tonal,
      blackPoint:  tgtBlack,
      whitePoint:  Math.max(tgtBlack + 1, tgtWhite),
      outputBlack: srcBlack,
      outputWhite: Math.max(srcBlack, srcWhite),
      gamma:       1.0,
    };
    // Keep srcRange around for boundary clamping below.
    const srcRange = { blackPoint: srcBlack, whitePoint: Math.max(srcBlack, srcWhite) };

    // Auto-place zone boundaries based on source's L distribution percentiles.
    // Zones operate on POST-tonal L values, so boundaries are in the same space as where the
    // tonal Levels pass remaps target pixels (= source's range). Clamp to [outputBlack..outputWhite]
    // in 0..100 scale to stay strictly inside the active tonal window.
    const [p25, p35, p65, p75] = lPercentiles(sourceSnap.data, [25, 35, 65, 75]);
    const outBlackL = (srcRange.blackPoint / 255) * 100;
    const outWhiteL = (srcRange.whitePoint / 255) * 100;
    const clamp = (v: number) => Math.max(outBlackL, Math.min(outWhiteL, v));
    boundsRef.current = {
      t1: clamp(p25),
      t2: clamp(Math.max(p25, p35)),
      t3: clamp(Math.max(p35, p65)),
      t4: clamp(Math.max(p65, p75)),
      pad1: 5, pad2: 5,
    };
    // Update zone range/feather from new bounds.
    const ranges = boundsToRangesFn(boundsRef.current);
    zonesRef.current.shadows = { ...zonesRef.current.shadows, ...ranges.shadows };
    zonesRef.current.midtones = { ...zonesRef.current.midtones, ...ranges.midtones };
    zonesRef.current.highlights = { ...zonesRef.current.highlights, ...ranges.highlights };

    const b = boundsRef.current;
    const bands = {
      shadows:    { lo: 0,    hi: b.t1 + (b.t2 - b.t1) / 2 },
      midtones:   { lo: b.t1 + (b.t2 - b.t1) / 2, hi: b.t3 + (b.t4 - b.t3) / 2 },
      highlights: { lo: b.t3 + (b.t4 - b.t3) / 2, hi: 100 },
    };

    // Per-zone Lab-aware match: source and target stats in each band drive color + saturation.
    let matched = 0;
    for (const zoneName of ["shadows", "midtones", "highlights"] as ZoneKey[]) {
      const band = bands[zoneName];
      const srcStats = labStatsInBand(sourceSnap.data, band.lo, band.hi);
      const tgtStats = labStatsInBand(targetSnap.data, band.lo, band.hi);
      if (!srcStats) continue;

      // Color picker = source's mean RGB in this band.
      zonesRef.current[zoneName].colorR = srcStats.meanRGB.r;
      zonesRef.current[zoneName].colorG = srcStats.meanRGB.g;
      zonesRef.current[zoneName].colorB = srcStats.meanRGB.b;

      // Color intensity scaled by Lab a/b mean shift magnitude vs target. No target → use 60%.
      let intensity = 60;
      if (tgtStats) {
        const dA = srcStats.muA - tgtStats.muA;
        const dB = srcStats.muB - tgtStats.muB;
        const shiftMag = Math.sqrt(dA * dA + dB * dB);
        // Lab a/b shift in [0..50] feels useful; map to [40..90% intensity].
        intensity = Math.round(40 + Math.min(50, shiftMag) * 1.0);
      }
      zonesRef.current[zoneName].colorIntensity = intensity;

      // Saturation = chroma stddev ratio source/target. >1 = boost, <1 = desat.
      if (tgtStats) {
        const srcChroma = (srcStats.sA + srcStats.sB) / 2;
        const tgtChroma = (tgtStats.sA + tgtStats.sB) / 2;
        const ratio = srcChroma / Math.max(1e-3, tgtChroma);
        // Clamp ±100. Most natural matches land in -50..+50 range.
        zonesRef.current[zoneName].sat = Math.max(-100, Math.min(100, Math.round((ratio - 1) * 100)));
      }

      // Hue = direction of the a/b shift, mapped to a small HSL hue rotation.
      // (Approximate: a→red axis, b→yellow axis. atan2 gives direction.)
      if (tgtStats) {
        const dA = srcStats.muA - tgtStats.muA;
        const dB = srcStats.muB - tgtStats.muB;
        const shiftMag = Math.sqrt(dA * dA + dB * dB);
        if (shiftMag > 5) {
          const angleDeg = Math.atan2(dB, dA) * 180 / Math.PI;
          // Subtle hue rotation toward source's color direction; cap at ±30°.
          zonesRef.current[zoneName].hue = Math.max(-30, Math.min(30, Math.round(angleDeg / 6)));
        } else {
          zonesRef.current[zoneName].hue = 0;
        }
      }

      matched++;
    }

    setTonalEpoch(n => n + 1);
    setValuesEpoch(n => n + 1);
    if (zonesRef.current[activeZone]) {
      const z = zonesRef.current[activeZone];
      const r = z.colorR.toString(16).padStart(2, "0");
      const g = z.colorG.toString(16).padStart(2, "0");
      const bx = z.colorB.toString(16).padStart(2, "0");
      setTintHex(`#${r}${g}${bx}`);
    }
    scheduleRedraw();
    setStatus(`Auto-match (μ±2σ): target ${tgtBlack}-${tgtWhite} (μ${tgt.mean.toFixed(0)}/σ${tgt.stddev.toFixed(0)}) → source ${srcBlack}-${srcWhite} (μ${src.mean.toFixed(0)}/σ${src.stddev.toFixed(0)}); ${matched}/3 zones. Dial + Bake.`);
  };
  const [tonalEpoch, setTonalEpoch] = useState(0);

  // Refresh highlight overlays on slider drag, but throttled to one rAF tick.
  // Note: this is a state bump (no text changes) so it doesn't trigger the font-renderer crash.
  const highlightRafPending = useRef(false);
  const scheduleHighlightRefresh = () => {
    if (highlightRafPending.current) return;
    highlightRafPending.current = true;
    requestAnimationFrame(() => {
      highlightRafPending.current = false;
      setHighlightTick(n => n + 1);
    });
  };
  const [, setHighlightTick] = useState(0);

  const onTintChange = (hex: string) => {
    setTintHex(hex);
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    zonesRef.current[activeZone].colorR = r;
    zonesRef.current[activeZone].colorG = g;
    zonesRef.current[activeZone].colorB = b;
    scheduleRedraw();
  };

  const reset = () => {
    boundsRef.current = { ...DEFAULT_BOUNDS };
    zonesRef.current = applyBoundsToDefaults({ ...DEFAULT_BOUNDS });
    setValuesEpoch(n => n + 1);
    setTintHex("#808080");
    scheduleRedraw();
  };

  const onBake = async () => {
    setStatus("Baking...");
    try { setStatus(await bakeZones(zonesRef.current)); }
    catch (e) { setStatus(`Error: ${(e as Error).message}`); }
  };

  const tabBtn = (z: ZoneKey): React.CSSProperties => ({
    flex: 1, padding: "4px 6px", fontSize: 10, cursor: "pointer",
    background: activeZone === z ? "#444" : "transparent",
    color: activeZone === z ? "white" : "#aaa",
    borderTop: `2px solid ${ZONE_COLORS[z]}`,
    borderLeft: "1px solid #444",
    borderRight: "1px solid #444",
    borderBottom: "1px solid #444",
  });

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <PreviewPane
          label="Source"
          layers={layers}
          selectedId={sourceId}
          onSelect={setSourceId}
          snapshot={sourceSnap}
          onRefresh={refreshSource}
          onPickColor={rgb => {
            zonesRef.current[activeZone].colorR = rgb.r;
            zonesRef.current[activeZone].colorG = rgb.g;
            zonesRef.current[activeZone].colorB = rgb.b;
            const r = rgb.r.toString(16).padStart(2, "0");
            const g = rgb.g.toString(16).padStart(2, "0");
            const b = rgb.b.toString(16).padStart(2, "0");
            setTintHex(`#${r}${g}${b}`);
            scheduleRedraw();
          }}
          height={120}
        />
        <PreviewPane
          label="Target"
          layers={layers}
          selectedId={targetId}
          onSelect={setTargetId}
          snapshot={targetSnap}
          transformedRgba={transformedTarget}
          onRefresh={refreshTarget}
          height={120}
        />
      </div>

      <div style={{ display: "flex" }}>
        {(["shadows", "midtones", "highlights"] as ZoneKey[]).map(z => (
          <button key={z} style={tabBtn(z)} onClick={() => setActiveZone(z)}>
            {z}
          </button>
        ))}
      </div>

      <Histogram rgba={preview?.data ?? null} height={20} />
      <TonalZonesSlider
        key={`bounds-${valuesEpoch}`}
        bounds={boundsRef.current}
        onChange={onBoundsChange}
      />

      {/* Global tonal controls: black/white/gamma applied as a Levels layer below all zones. */}
      <div style={{ borderTop: "1px solid #333", marginTop: 6, paddingTop: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 11, opacity: 0.7 }}>
          <span>Tonal (global)</span>
          <button onClick={onAutoLevel} style={{
            padding: "2px 8px", background: "transparent", color: "#aaa",
            border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9,
          }}>Auto Level</button>
        </div>
        <TonalSliderRow key={`black-${tonalEpoch}`} label="Black" min={0} max={254} step={1}
          defaultValue={zonesRef.current.tonal.blackPoint}
          format={v => String(Math.round(v))}
          onInput={v => onTonalChange({ blackPoint: v })} />
        <TonalSliderRow key={`white-${tonalEpoch}`} label="White" min={1} max={255} step={1}
          defaultValue={zonesRef.current.tonal.whitePoint}
          format={v => String(Math.round(v))}
          onInput={v => onTonalChange({ whitePoint: v })} />
        <TonalSliderRow key={`gamma-${tonalEpoch}`} label="Gamma" min={0.1} max={3.0} step={0.01}
          defaultValue={zonesRef.current.tonal.gamma}
          format={v => v.toFixed(2)}
          onInput={v => onTonalChange({ gamma: v })} />
      </div>

      {FIELDS.map(f => {
        const values: Record<ZoneKey, number> = {
          shadows: zonesRef.current.shadows[f.key] as number,
          midtones: zonesRef.current.midtones[f.key] as number,
          highlights: zonesRef.current.highlights[f.key] as number,
        };
        return (
          <MultiThumbSlider
            key={`${f.key}-${valuesEpoch}-${activeZone}`}
            label={f.label}
            min={f.min} max={f.max}
            values={values}
            activeZone={activeZone}
            onChange={onSliderChange(f.key)}
          />
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}>
        <span style={{ width: 64, opacity: 0.7 }}>Color</span>
        <input type="color" value={tintHex} onChange={e => onTintChange(e.target.value)}
          style={{ flex: 1, height: 22, padding: 0, border: "1px solid #555", background: "transparent", cursor: "pointer" }} />
        <span style={{ width: 36, textAlign: "right", opacity: 0.8, fontFamily: "monospace" }}>{tintHex}</span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{
          padding: "6px 12px", background: "transparent", color: "#aaa",
          border: "1px solid #555", borderRadius: 3, cursor: "pointer", flex: 1,
        }}>Reset</button>
        <button onClick={onAutoMatch} style={{
          padding: "6px 12px", background: "transparent", color: "#ddd",
          border: "1px solid #1473e6", borderRadius: 3, cursor: "pointer", flex: 2,
        }}>Auto Match from Source</button>
        <button onClick={onBake} style={{
          padding: "6px 12px", background: "#1473e6", color: "white",
          border: "none", borderRadius: 3, cursor: "pointer", flex: 2,
        }}>Bake</button>
      </div>

      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.6, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
