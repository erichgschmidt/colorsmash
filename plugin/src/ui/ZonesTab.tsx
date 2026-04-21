// Zones tab with variable N zones (3/5/7).

import { useEffect, useRef, useState } from "react";
import {
  applyZones, autoDetectTonal, labStatsInBand, lMeanStddev, buildLabCorrelationLUTInBand,
  buildHistogramMatchLUT, fadeLUT, IDENTITY_TONAL, defaultBoundaries,
  type ZonesState, type ZoneState, type TonalState,
} from "../core/zoneTransform";
import { useLayerPreview } from "./useLayerPreview";
import { useLayers } from "./useLayers";
import { bakeZones } from "../app/bakeZones";
import { TonalZonesSlider, type TonalBounds, boundsToRanges, paletteFor } from "./TonalZonesSlider";
import { Histogram } from "./Histogram";
import { PreviewPane, type PreviewImgHandle } from "./PreviewPane";

const DEFAULT_ZONE: ZoneState = {
  hue: 0, sat: 0,
  colorR: 128, colorG: 128, colorB: 128, colorIntensity: 0,
  rangeStart: 0, rangeEnd: 100, featherLeft: 0, featherRight: 0,
};

function buildDefaultState(zoneCount: number): { zones: ZonesState; bounds: TonalBounds } {
  const bounds = defaultBoundaries(zoneCount);
  const ranges = boundsToRanges(bounds);
  const zones: ZoneState[] = ranges.map(r => ({ ...DEFAULT_ZONE, ...r }));
  return {
    zones: { tonal: { ...IDENTITY_TONAL }, zones },
    bounds,
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
  const preview = targetSnap;

  const [zoneCount, setZoneCountState] = useState(3);
  const initial = buildDefaultState(3);
  const boundsRef = useRef<TonalBounds>(initial.bounds);
  const zonesRef = useRef<ZonesState>(initial.zones);
  const [activeZoneIdx, setActiveZoneIdx] = useState(0);
  const [valuesEpoch, setValuesEpoch] = useState(0);
  const [zoneColors, setZoneColors] = useState<string[]>(paletteFor(3));

  // Atomic zone-count change: rebuild refs FIRST, then trigger React render. Avoids a render
  // pass where zonesRef still has old length but state already has new count.
  const setZoneCount = (n: number) => {
    const s = buildDefaultState(n);
    boundsRef.current = s.bounds;
    zonesRef.current = s.zones;
    setActiveZoneIdx(0);
    setZoneColors(paletteFor(n));
    setValuesEpoch(v => v + 1);
    setTonalEpoch(v => v + 1);
    setZoneCountState(n);
    setTimeout(() => scheduleRedraw(), 0);
  };
  const [tonalEpoch, setTonalEpoch] = useState(0);
  const matchStrengthRef = useRef(60);

  const transformedTargetRef = useRef<Uint8Array | null>(null);
  const targetImgHandle = useRef<PreviewImgHandle | null>(null);
  const rafPending = useRef(false);
  const [status, setStatus] = useState("Auto Match copies source's per-zone Lab characteristics into target. Bake emits the stack.");

  const scheduleRedraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      if (!preview) return;
      const transformed = applyZones(preview.data, zonesRef.current);
      transformedTargetRef.current = transformed;
      targetImgHandle.current?.setPixels(transformed, preview.width, preview.height);
    });
  };

  const highlightRafPending = useRef(false);
  const [, setHighlightTick] = useState(0);
  const scheduleHighlightRefresh = () => {
    if (highlightRafPending.current) return;
    highlightRafPending.current = true;
    requestAnimationFrame(() => {
      highlightRafPending.current = false;
      setHighlightTick(n => n + 1);
    });
  };

  useEffect(scheduleRedraw, [preview]); // eslint-disable-line react-hooks/exhaustive-deps


  const onBoundsChange = (b: TonalBounds) => {
    boundsRef.current = b;
    const ranges = boundsToRanges(b);
    zonesRef.current.zones = zonesRef.current.zones.map((z, i) => ({ ...z, ...(ranges[i] ?? {}) }));
    scheduleRedraw();
    scheduleHighlightRefresh();
  };

  const onTonalChange = (patch: Partial<TonalState>) => {
    zonesRef.current.tonal = { ...zonesRef.current.tonal, ...patch, matchCurve: undefined, matchPerChannel: undefined };
    scheduleRedraw();
  };

  const onAutoLevel = () => {
    if (!preview) return;
    const { blackPoint, whitePoint } = autoDetectTonal(preview.data);
    zonesRef.current.tonal = {
      ...zonesRef.current.tonal, blackPoint, whitePoint, outputBlack: 0, outputWhite: 255,
    };
    scheduleRedraw();
    setTonalEpoch(n => n + 1);
  };

  const onAutoMatch = () => {
    if (!sourceSnap || !targetSnap) { setStatus("Pick both source and target."); return; }
    const k = matchStrengthRef.current / 100;

    // Global pass: L histogram match (composite Curves) remaps target's L distribution to source's.
    // Per-zone Lab LUTs below handle chroma refinement without double-counting luminance since
    // Lab's L axis changes won't affect a/b axes. Faded by Match Strength.
    const lLUT = buildHistogramMatchLUT(targetSnap.data, sourceSnap.data);
    zonesRef.current.tonal = {
      ...IDENTITY_TONAL,
      matchCurve: fadeLUT(lLUT, k),
    };

    const ranges = boundsToRanges(boundsRef.current);
    let matched = 0;
    const newZones: ZoneState[] = ranges.map((r, i) => {
      const prev = zonesRef.current.zones[i] ?? { ...DEFAULT_ZONE, ...r };
      const bandLo = Math.max(0, r.rangeStart - r.featherLeft);
      const bandHi = Math.min(100, r.rangeEnd + r.featherRight);
      const srcStats = labStatsInBand(sourceSnap.data, bandLo, bandHi);
      const tgtStats = labStatsInBand(targetSnap.data, bandLo, bandHi);
      const out: ZoneState = { ...prev, ...r };
      if (!srcStats || !tgtStats) {
        out.colorR = 128; out.colorG = 128; out.colorB = 128;
        out.colorIntensity = 0; out.sat = 0; out.hue = 0; out.colorLUT = undefined;
        return out;
      }
      const dR = (srcStats.meanRGB.r - tgtStats.meanRGB.r) * k;
      const dG = (srcStats.meanRGB.g - tgtStats.meanRGB.g) * k;
      const dB = (srcStats.meanRGB.b - tgtStats.meanRGB.b) * k;
      out.colorR = Math.round(Math.max(0, Math.min(255, 128 + dR)));
      out.colorG = Math.round(Math.max(0, Math.min(255, 128 + dG)));
      out.colorB = Math.round(Math.max(0, Math.min(255, 128 + dB)));
      out.colorIntensity = Math.sqrt(dR * dR + dG * dG + dB * dB) < 2 ? 0 : 100;

      const srcChroma = (srcStats.sA + srcStats.sB) / 2;
      const tgtChroma = (tgtStats.sA + tgtStats.sB) / 2;
      const ratio = srcChroma / Math.max(1e-3, tgtChroma);
      const satFull = Math.round((ratio - 1) * 100);
      out.sat = Math.abs(satFull) < 2 ? 0 : Math.max(-100, Math.min(100, Math.round(satFull * k)));

      const dA = srcStats.muA - tgtStats.muA;
      const dBlab = srcStats.muB - tgtStats.muB;
      const shiftMag = Math.sqrt(dA * dA + dBlab * dBlab);
      const hueFull = shiftMag > 5 ? Math.round(Math.atan2(dBlab, dA) * 180 / Math.PI / 6) : 0;
      out.hue = Math.max(-30, Math.min(30, Math.round(hueFull * k)));

      const bandFull = buildLabCorrelationLUTInBand(
        targetSnap.data, sourceSnap.data,
        bandLo, bandHi, bandLo, bandHi,
      );
      out.colorLUT = { r: fadeLUT(bandFull.r, k), g: fadeLUT(bandFull.g, k), b: fadeLUT(bandFull.b, k) };
      matched++;
      return out;
    });
    zonesRef.current.zones = newZones;

    // Retint zones with sampled source means.
    const newColors = newZones.map((_, i) => {
      const r = ranges[i];
      const bandLo = Math.max(0, r.rangeStart - r.featherLeft);
      const bandHi = Math.min(100, r.rangeEnd + r.featherRight);
      const stats = labStatsInBand(sourceSnap.data, bandLo, bandHi);
      return stats ? `rgb(${stats.meanRGB.r}, ${stats.meanRGB.g}, ${stats.meanRGB.b})` : paletteFor(zoneCount)[i];
    });
    setZoneColors(newColors);

    setTonalEpoch(n => n + 1);
    setValuesEpoch(n => n + 1);
    scheduleRedraw();

    const tgtStat = lMeanStddev(targetSnap.data);
    const srcStat = lMeanStddev(sourceSnap.data);
    setStatus(`Auto-match (Lab per-zone, ${zoneCount} zones): target μ${tgtStat.mean.toFixed(0)}/σ${tgtStat.stddev.toFixed(0)} → source μ${srcStat.mean.toFixed(0)}/σ${srcStat.stddev.toFixed(0)}; ${matched}/${zoneCount} zones fit.`);
  };

  const reset = () => {
    const s = buildDefaultState(zoneCount);
    boundsRef.current = s.bounds;
    zonesRef.current = s.zones;
    setValuesEpoch(n => n + 1);
    setZoneColors(paletteFor(zoneCount));
    setStatus("Reset.");
    scheduleRedraw();
  };

  const onBake = async () => {
    setStatus("Baking...");
    try { setStatus(await bakeZones(zonesRef.current)); }
    catch (e) { setStatus(`Error: ${(e as Error).message}`); }
  };

  const tabBtn = (idx: number): React.CSSProperties => ({
    flex: 1, padding: "4px 4px", fontSize: 9, cursor: "pointer",
    background: activeZoneIdx === idx ? "#444" : "transparent",
    color: activeZoneIdx === idx ? "white" : "#aaa",
    borderTop: `2px solid ${zoneColors[idx]}`,
    borderLeft: "1px solid #444",
    borderRight: "1px solid #444",
    borderBottom: "1px solid #444",
  });

  const zoneLabel = (idx: number, n: number): string => {
    if (n === 3) return ["shadows", "midtones", "highlights"][idx];
    if (n === 5) return ["shadows", "low-mids", "mids", "high-mids", "highlights"][idx];
    return `zone ${idx + 1}`;
  };

  // Per-zone value slider rows (uncontrolled)
  function ZoneSliderRow(p: { label: string; min: number; max: number; step: number; valueKey: keyof ZoneState; zoneIdx: number; format: (v: number) => string }) {
    const lblRef = useRef<HTMLSpanElement>(null);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, fontSize: 11 }}>
        <span style={{ width: 64, opacity: 0.7 }}>{p.label}</span>
        <input type="range" min={p.min} max={p.max} step={p.step}
          defaultValue={zonesRef.current.zones[p.zoneIdx][p.valueKey] as number}
          onInput={e => {
            const v = Number((e.target as HTMLInputElement).value);
            (zonesRef.current.zones[p.zoneIdx] as any)[p.valueKey] = v;
            // Clear Lab LUT for this zone so manual edits drive the picker math.
            zonesRef.current.zones[p.zoneIdx].colorLUT = undefined;
            if (lblRef.current) lblRef.current.textContent = p.format(v);
            scheduleRedraw();
          }}
          style={{ flex: 1, minWidth: 0 }} />
        <span ref={lblRef} style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{p.format(zonesRef.current.zones[p.zoneIdx][p.valueKey] as number)}</span>
      </div>
    );
  }

  function TonalSliderRow(props: { label: string; min: number; max: number; step: number; defaultValue: number; format: (v: number) => string; onInput: (v: number) => void }) {
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

  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 4, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };
  const btnSecondary: React.CSSProperties = { ...btn, background: "transparent", color: "#aaa", border: "1px solid #555" };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <PreviewPane
          label="Source" layers={layers} selectedId={sourceId} onSelect={setSourceId}
          snapshot={sourceSnap} onRefresh={refreshSource}
          onPickColor={rgb => {
            zonesRef.current.zones[activeZoneIdx].colorR = rgb.r;
            zonesRef.current.zones[activeZoneIdx].colorG = rgb.g;
            zonesRef.current.zones[activeZoneIdx].colorB = rgb.b;
            zonesRef.current.zones[activeZoneIdx].colorLUT = undefined;
            setValuesEpoch(n => n + 1);
            scheduleRedraw();
          }}
          height={120}
        />
        <PreviewPane
          label="Target" layers={layers} selectedId={targetId} onSelect={setTargetId}
          snapshot={targetSnap} transformedRgba={transformedTargetRef.current}
          onRefresh={refreshTarget} imgHandleRef={targetImgHandle} height={120}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11 }}>
        <span style={{ opacity: 0.7 }}>Zones:</span>
        {[3, 5, 7].map(n => (
          <button key={n} onClick={() => setZoneCount(n)} style={{
            padding: "2px 10px", fontSize: 10, cursor: "pointer",
            background: zoneCount === n ? "#1473e6" : "transparent",
            color: zoneCount === n ? "white" : "#aaa",
            border: "1px solid #555", borderRadius: 3,
          }}>{n}</button>
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
        key={`bounds-${valuesEpoch}-${zoneCount}`}
        bounds={boundsRef.current}
        onChange={onBoundsChange}
        zoneColors={zoneColors}
      />

      <div style={{ display: "flex", marginTop: 4 }}>
        {zonesRef.current.zones.map((_, i) => (
          <button key={i} style={tabBtn(i)} onClick={() => setActiveZoneIdx(i)}>
            {zoneLabel(i, zonesRef.current.zones.length)}
          </button>
        ))}
      </div>

      <div key={`zsliders-${valuesEpoch}-${activeZoneIdx}`}>
        <ZoneSliderRow label="Hue"       min={-180} max={180} step={1}    valueKey="hue"            zoneIdx={activeZoneIdx} format={v => String(v)} />
        <ZoneSliderRow label="Sat"       min={-100} max={100} step={1}    valueKey="sat"            zoneIdx={activeZoneIdx} format={v => String(v)} />
        <ZoneSliderRow label="Color int" min={0}    max={100} step={1}    valueKey="colorIntensity" zoneIdx={activeZoneIdx} format={v => String(v)} />
      </div>

      {/* Color swatches per zone */}
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        {zonesRef.current.zones.map((z, i) => {
          const hex = `#${z.colorR.toString(16).padStart(2, "0")}${z.colorG.toString(16).padStart(2, "0")}${z.colorB.toString(16).padStart(2, "0")}`;
          return (
            <input key={`swatch-${i}-${valuesEpoch}`} type="color"
              defaultValue={hex}
              onChange={e => {
                const h = e.target.value;
                const r = parseInt(h.slice(1, 3), 16) || 0;
                const g = parseInt(h.slice(3, 5), 16) || 0;
                const b = parseInt(h.slice(5, 7), 16) || 0;
                zonesRef.current.zones[i].colorR = r;
                zonesRef.current.zones[i].colorG = g;
                zonesRef.current.zones[i].colorB = b;
                zonesRef.current.zones[i].colorLUT = undefined;
                scheduleRedraw();
              }}
              style={{ flex: 1, height: 18, padding: 0, border: `2px solid ${zoneColors[i]}`, background: "transparent", cursor: "pointer" }} />
          );
        })}
      </div>

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

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11 }}>
        <span style={{ width: 100, opacity: 0.7 }}>Match Strength</span>
        <input type="range" min={0} max={100} defaultValue={matchStrengthRef.current}
          onInput={e => { matchStrengthRef.current = Number((e.target as HTMLInputElement).value); }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 36, textAlign: "right", opacity: 0.8, fontSize: 9 }}>Auto Match</span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{ ...btnSecondary, flex: 1 }}>Reset</button>
        <button onClick={onAutoMatch} style={{ ...btnSecondary, color: "#ddd", border: "1px solid #1473e6", flex: 2 }}>Auto Match</button>
        <button onClick={onBake} style={{ ...btn, flex: 2 }}>Bake</button>
      </div>

      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
