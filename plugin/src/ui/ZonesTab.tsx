// Zones tab — Lumetri-wheels-style with multi-thumb sliders.
// Each parameter slider shows all 3 zones at once; range sliders cascade so zones don't cross.

import { useEffect, useRef, useState } from "react";
import { applyZones, type ZonesState, type ZoneState } from "../core/zoneTransform";
import { useTargetPreview } from "./useTargetPreview";
import { bakeZones } from "../app/bakeZones";
import { MultiThumbSlider, type ZoneKey, ZONE_COLORS } from "./MultiThumbSlider";
import { TonalZonesSlider, type TonalBounds, boundsToRanges } from "./TonalZonesSlider";
import { rgbaToPngDataUrl } from "./encodePng";

const DEFAULT_ZONE: ZoneState = {
  hue: 0, sat: 0, lift: 0,
  tintR: 128, tintG: 128, tintB: 128, tintAmount: 0,
  rangeStart: 0, rangeEnd: 100, featherLeft: 15, featherRight: 15,
};

interface FieldSpec {
  key: keyof ZoneState; label: string; min: number; max: number;
}
// Per-zone parameters only — range/feather now live in the unified TonalZonesSlider.
const FIELDS: FieldSpec[] = [
  { key: "hue",        label: "Hue",      min: -180, max: 180 },
  { key: "sat",        label: "Sat",      min: -100, max: 100 },
  { key: "lift",       label: "Lift",     min: -100, max: 100 },
  { key: "tintAmount", label: "Tint mix", min: 0,    max: 100 },
];

const DEFAULT_BOUNDS: TonalBounds = { t1: 25, t2: 40, t3: 60, t4: 75 };

function applyBoundsToDefaults(b: TonalBounds): ZonesState {
  const ranges = boundsToRanges(b);
  return {
    shadows:    { ...DEFAULT_ZONE, ...ranges.shadows },
    midtones:   { ...DEFAULT_ZONE, ...ranges.midtones },
    highlights: { ...DEFAULT_ZONE, ...ranges.highlights },
  };
}

export function ZonesTab() {
  const { snap: preview, refresh: refreshPreview, error: previewError } = useTargetPreview();
  const boundsRef = useRef<TonalBounds>({ ...DEFAULT_BOUNDS });
  const zonesRef = useRef<ZonesState>(applyBoundsToDefaults({ ...DEFAULT_BOUNDS }));
  const [activeZone, setActiveZone] = useState<ZoneKey>("midtones");
  const [valuesEpoch, setValuesEpoch] = useState(0); // bumped when we want sliders to re-sync from refs
  const [tintHex, setTintHex] = useState("#808080");
  const imgRef = useRef<HTMLImageElement>(null);
  const rafPending = useRef(false);
  const [status, setStatus] = useState("Live preview · drag any thumb (zone-colored) to edit that zone. Range sliders cascade so zones can't cross.");

  const scheduleRedraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const img = imgRef.current;
      if (!img || !preview) return;
      const transformed = applyZones(preview.data, zonesRef.current);
      img.src = rgbaToPngDataUrl(transformed, preview.width, preview.height);
    });
  };

  useEffect(scheduleRedraw, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const z = zonesRef.current[activeZone];
    const r = z.tintR.toString(16).padStart(2, "0");
    const g = z.tintG.toString(16).padStart(2, "0");
    const b = z.tintB.toString(16).padStart(2, "0");
    setTintHex(`#${r}${g}${b}`);
  }, [activeZone]);

  const onSliderChange = (key: keyof ZoneState) => (zone: ZoneKey, v: number) => {
    (zonesRef.current[zone] as any)[key] = v;
    scheduleRedraw();
    scheduleHighlightRefresh();
  };

  const onBoundsChange = (b: TonalBounds) => {
    boundsRef.current = { ...b };
    const ranges = boundsToRanges(b);
    zonesRef.current.shadows = { ...zonesRef.current.shadows, ...ranges.shadows };
    zonesRef.current.midtones = { ...zonesRef.current.midtones, ...ranges.midtones };
    zonesRef.current.highlights = { ...zonesRef.current.highlights, ...ranges.highlights };
    scheduleRedraw();
    scheduleHighlightRefresh();
  };

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
    zonesRef.current[activeZone].tintR = r;
    zonesRef.current[activeZone].tintG = g;
    zonesRef.current[activeZone].tintB = b;
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
      <div style={{
        background: "#111", border: "1px solid #555",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        minHeight: 100, padding: 4, position: "relative",
      }}>
        {preview
          ? <img ref={imgRef} alt="preview" style={{ maxWidth: "100%", maxHeight: 200 }} />
          : <span style={{ color: "#666", fontSize: 10 }}>{previewError ?? "Loading preview…"}</span>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", marginTop: 4, fontSize: 9, opacity: 0.6 }}>
          <span>{preview ? `${preview.layerName} (${preview.width}×${preview.height})` : ""}</span>
          <button onClick={refreshPreview} style={{
            padding: "2px 8px", background: "transparent", color: "#aaa",
            border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9,
          }}>↻ Refresh</button>
        </div>
      </div>

      <div style={{ display: "flex" }}>
        {(["shadows", "midtones", "highlights"] as ZoneKey[]).map(z => (
          <button key={z} style={tabBtn(z)} onClick={() => setActiveZone(z)}>
            {z}
          </button>
        ))}
      </div>

      <TonalZonesSlider
        key={`bounds-${valuesEpoch}`}
        bounds={boundsRef.current}
        onChange={onBoundsChange}
      />

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
        <span style={{ width: 64, opacity: 0.7 }}>Tint color</span>
        <input type="color" value={tintHex} onChange={e => onTintChange(e.target.value)}
          style={{ flex: 1, height: 22, padding: 0, border: "1px solid #555", background: "transparent", cursor: "pointer" }} />
        <span style={{ width: 36, textAlign: "right", opacity: 0.8, fontFamily: "monospace" }}>{tintHex}</span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{
          padding: "6px 12px", background: "transparent", color: "#aaa",
          border: "1px solid #555", borderRadius: 3, cursor: "pointer", flex: 1,
        }}>Reset</button>
        <button onClick={onBake} style={{
          padding: "6px 12px", background: "#1473e6", color: "white",
          border: "none", borderRadius: 3, cursor: "pointer", flex: 2,
        }}>Bake to layer stack</button>
      </div>

      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.6, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
