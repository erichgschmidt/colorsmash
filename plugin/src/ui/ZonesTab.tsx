// Zones tab — Lumetri-wheels-style with multi-thumb sliders.
// Each parameter slider shows all 3 zones at once; range sliders cascade so zones don't cross.

import { useEffect, useRef, useState } from "react";
import { applyZones, autoDetectTonal, labStatsInBand, lPercentiles, lMeanStddev, buildHistogramMatchLUTPerChannel, fadeLUT, IDENTITY_TONAL, type ZonesState, type ZoneState, type TonalState } from "../core/zoneTransform";
import { useLayerPreview } from "./useLayerPreview";
import { useLayers } from "./useLayers";
import { bakeZones } from "../app/bakeZones";
import { MultiThumbSlider, type ZoneKey, ZONE_COLORS as DEFAULT_ZONE_COLORS } from "./MultiThumbSlider";
import { TonalZonesSlider, type TonalBounds, boundsToRanges as boundsToRangesFn } from "./TonalZonesSlider";
import { Histogram } from "./Histogram";
import { PreviewPane, type PreviewImgHandle } from "./PreviewPane";

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
  const transformedTargetRef = useRef<Uint8Array | null>(null);
  const targetImgHandle = useRef<PreviewImgHandle | null>(null);
  const rafPending = useRef(false);
  const [status, setStatus] = useState("Live preview · drag any thumb (zone-colored) to edit that zone. Range sliders cascade so zones can't cross.");

  const scheduleRedraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      if (!preview) return;
      const transformed = applyZones(preview.data, zonesRef.current);
      transformedTargetRef.current = transformed;
      // Push directly to the img element, no React state change → no re-render flicker.
      targetImgHandle.current?.setPixels(transformed, preview.width, preview.height);
    });
  };

  useEffect(scheduleRedraw, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep three independent hex strings, one per zone, so all three color pickers stay in sync.
  const [zoneHex, setZoneHex] = useState<Record<ZoneKey, string>>({ shadows: "#808080", midtones: "#808080", highlights: "#808080" });
  const refreshAllHexFromRef = () => {
    const z = zonesRef.current;
    const mk = (zz: ZoneState) => `#${zz.colorR.toString(16).padStart(2, "0")}${zz.colorG.toString(16).padStart(2, "0")}${zz.colorB.toString(16).padStart(2, "0")}`;
    setZoneHex({ shadows: mk(z.shadows), midtones: mk(z.midtones), highlights: mk(z.highlights) });
  };

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

  const onTonalChange = (patch: Partial<TonalState>) => {
    zonesRef.current.tonal = { ...zonesRef.current.tonal, ...patch, matchCurve: undefined, matchPerChannel: undefined };
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

    // Per-channel histogram match (R, G, B independently). Captures both luminance and color
    // transfer in one shot. Faded by Match Strength toward identity per channel.
    const k = matchStrengthRef.current / 100;
    const full = buildHistogramMatchLUTPerChannel(targetSnap.data, sourceSnap.data);
    const fadedPerChannel = {
      r: fadeLUT(full.r, k),
      g: fadeLUT(full.g, k),
      b: fadeLUT(full.b, k),
    };
    zonesRef.current.tonal = {
      ...zonesRef.current.tonal,
      matchPerChannel: fadedPerChannel,
      matchCurve: undefined,
      blackPoint: 0, whitePoint: 255, gamma: 1.0, outputBlack: 0, outputWhite: 255,
    };
    // For boundary clamping: use source's actual min/max from the LUT (first/last non-flat values).
    const srcRange = autoDetectTonal(sourceSnap.data);

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

    // Per-zone match. Color picker stores the DELTA (source - target) centered at gray (128,128,128),
    // so the per-channel shift is exactly (color - 128) * intensity → exact channel-mean transfer
    // at intensity=100. Critically: source=target → delta=0 → color=gray → no shift = identity.
    let matched = 0;
    for (const zoneName of ["shadows", "midtones", "highlights"] as ZoneKey[]) {
      const band = bands[zoneName];
      const srcStats = labStatsInBand(sourceSnap.data, band.lo, band.hi);
      const tgtStats = labStatsInBand(targetSnap.data, band.lo, band.hi);
      const z = zonesRef.current[zoneName];
      if (!srcStats || !tgtStats) {
        // Fallback: leave color at gray = no shift.
        z.colorR = 128; z.colorG = 128; z.colorB = 128;
        z.colorIntensity = 0; z.sat = 0; z.hue = 0;
        continue;
      }

      // Per-zone delta scaled by Match Strength. At k=0, all per-zone effects collapse to identity.
      const dR = (srcStats.meanRGB.r - tgtStats.meanRGB.r) * k;
      const dG = (srcStats.meanRGB.g - tgtStats.meanRGB.g) * k;
      const dB = (srcStats.meanRGB.b - tgtStats.meanRGB.b) * k;
      z.colorR = Math.round(Math.max(0, Math.min(255, 128 + dR)));
      z.colorG = Math.round(Math.max(0, Math.min(255, 128 + dG)));
      z.colorB = Math.round(Math.max(0, Math.min(255, 128 + dB)));
      const deltaMag = Math.sqrt(dR * dR + dG * dG + dB * dB);
      z.colorIntensity = deltaMag < 2 ? 0 : 100;

      const srcChroma = (srcStats.sA + srcStats.sB) / 2;
      const tgtChroma = (tgtStats.sA + tgtStats.sB) / 2;
      const ratio = srcChroma / Math.max(1e-3, tgtChroma);
      const satFull = Math.round((ratio - 1) * 100);
      z.sat = Math.abs(satFull) < 2 ? 0 : Math.max(-100, Math.min(100, Math.round(satFull * k)));

      const dA = srcStats.muA - tgtStats.muA;
      const dBlab = srcStats.muB - tgtStats.muB;
      const shiftMag = Math.sqrt(dA * dA + dBlab * dBlab);
      const hueFull = shiftMag > 5 ? Math.round(Math.atan2(dBlab, dA) * 180 / Math.PI / 6) : 0;
      z.hue = Math.max(-30, Math.min(30, Math.round(hueFull * k)));

      matched++;
    }

    setTonalEpoch(n => n + 1);
    setValuesEpoch(n => n + 1);
    refreshAllHexFromRef();

    // Swap tonal-zone colors to the per-band source means so the visual track matches the sampled
    // palette (shadows = dark-band color, mids = mid-band color, highlights = bright-band color).
    const zoneBandColors: Record<ZoneKey, string> = { ...DEFAULT_ZONE_COLORS };
    for (const zoneName of ["shadows", "midtones", "highlights"] as ZoneKey[]) {
      const band = bands[zoneName];
      const stats = labStatsInBand(sourceSnap.data, band.lo, band.hi);
      if (stats) {
        const { r, g, b } = stats.meanRGB;
        zoneBandColors[zoneName] = `rgb(${r}, ${g}, ${b})`;
      }
    }
    setZoneColors(zoneBandColors);
    scheduleRedraw();
    const tgtStat = lMeanStddev(targetSnap.data);
    const srcStat = lMeanStddev(sourceSnap.data);
    const z = zonesRef.current;
    setStatus(
      `Auto-match (histogram): target μ${tgtStat.mean.toFixed(0)}/σ${tgtStat.stddev.toFixed(0)} → source μ${srcStat.mean.toFixed(0)}/σ${srcStat.stddev.toFixed(0)}\n` +
      `shadows: hue ${z.shadows.hue}, sat ${z.shadows.sat}, color int ${z.shadows.colorIntensity}\n` +
      `midtones: hue ${z.midtones.hue}, sat ${z.midtones.sat}, color int ${z.midtones.colorIntensity}\n` +
      `highlights: hue ${z.highlights.hue}, sat ${z.highlights.sat}, color int ${z.highlights.colorIntensity}`
    );
  };
  const [tonalEpoch, setTonalEpoch] = useState(0);
  const matchStrengthRef = useRef(60);
  // Dynamic zone colors: default to blue/gray/amber, swap to sampled colors from source after Auto Match.
  const [zoneColors, setZoneColors] = useState<Record<ZoneKey, string>>({ ...DEFAULT_ZONE_COLORS });
  const ZONE_COLORS = zoneColors;

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

  const onZoneColorChange = (zone: ZoneKey, hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    zonesRef.current[zone].colorR = r;
    zonesRef.current[zone].colorG = g;
    zonesRef.current[zone].colorB = b;
    setZoneHex(prev => ({ ...prev, [zone]: hex }));
    scheduleRedraw();
  };

  const reset = () => {
    boundsRef.current = { ...DEFAULT_BOUNDS };
    zonesRef.current = applyBoundsToDefaults({ ...DEFAULT_BOUNDS });
    setValuesEpoch(n => n + 1);
    setZoneColors({ ...DEFAULT_ZONE_COLORS });
    refreshAllHexFromRef();
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
            const hex = `#${rgb.r.toString(16).padStart(2, "0")}${rgb.g.toString(16).padStart(2, "0")}${rgb.b.toString(16).padStart(2, "0")}`;
            onZoneColorChange(activeZone, hex);
          }}
          height={120}
        />
        <PreviewPane
          label="Target"
          layers={layers}
          selectedId={targetId}
          onSelect={setTargetId}
          snapshot={targetSnap}
          transformedRgba={transformedTargetRef.current}
          onRefresh={refreshTarget}
          imgHandleRef={targetImgHandle}
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

      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, fontSize: 9, opacity: 0.6 }}>
        <span style={{ width: 40, textAlign: "right" }}>source</span>
        <div style={{ flex: 1 }}><Histogram rgba={sourceSnap?.data ?? null} height={16} /></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, opacity: 0.6 }}>
        <span style={{ width: 40, textAlign: "right" }}>target</span>
        <div style={{ flex: 1 }}><Histogram rgba={transformedTargetRef.current ?? preview?.data ?? null} height={16} /></div>
      </div>
      <TonalZonesSlider
        key={`bounds-${valuesEpoch}`}
        bounds={boundsRef.current}
        onChange={onBoundsChange}
        zoneColors={zoneColors}
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

      <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "stretch" }}>
        {(["shadows", "midtones", "highlights"] as ZoneKey[]).map(zone => (
          <div key={zone} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{
              fontSize: 9, textAlign: "center", opacity: 0.7,
              borderTop: `2px solid ${ZONE_COLORS[zone]}`, paddingTop: 2,
            }}>{zone}</span>
            <input type="color" value={zoneHex[zone]}
              onChange={e => onZoneColorChange(zone, e.target.value)}
              style={{ width: "100%", height: 24, padding: 0, border: "1px solid #555", background: "transparent", cursor: "pointer" }} />
            <span style={{ fontSize: 9, textAlign: "center", opacity: 0.7, fontFamily: "monospace" }}>{zoneHex[zone]}</span>
          </div>
        ))}
      </div>

      {/* Match Strength controls how aggressively Auto Match transforms target. 50-60% is natural. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11 }}>
        <span style={{ width: 100, opacity: 0.7 }}>Match Strength</span>
        <input type="range" min={0} max={100} defaultValue={matchStrengthRef.current}
          onInput={e => { matchStrengthRef.current = Number((e.target as HTMLInputElement).value); }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 36, textAlign: "right", opacity: 0.8, fontSize: 9 }}>(applies on Auto Match)</span>
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
