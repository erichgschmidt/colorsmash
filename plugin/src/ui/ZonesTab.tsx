// Zones tab — Lumetri-wheels-style tonal-zone color grading.
// Uncontrolled sliders + RAF preview redraw, to avoid PS font-renderer crashes from per-tick React re-renders.

import { useEffect, useRef, useState } from "react";
import { applyZones, type ZonesState, type ZoneState } from "../core/zoneTransform";
import { useTargetPreview } from "./useTargetPreview";

type Zone = "shadows" | "midtones" | "highlights";

const DEFAULTS: ZonesState = {
  shadows:    { hue: 0, sat: 0, lift: 0, rangeStart: 0,  rangeEnd: 35,  feather: 15 },
  midtones:   { hue: 0, sat: 0, lift: 0, rangeStart: 25, rangeEnd: 75,  feather: 15 },
  highlights: { hue: 0, sat: 0, lift: 0, rangeStart: 65, rangeEnd: 100, feather: 15 },
};

interface SliderSpec { key: keyof ZoneState; label: string; min: number; max: number }
const FIELDS: SliderSpec[] = [
  { key: "hue",        label: "Hue",     min: -180, max: 180 },
  { key: "sat",        label: "Sat",     min: -100, max: 100 },
  { key: "lift",       label: "Lift",    min: -100, max: 100 },
  { key: "rangeStart", label: "Range L", min: 0,    max: 100 },
  { key: "rangeEnd",   label: "Range R", min: 0,    max: 100 },
  { key: "feather",    label: "Feather", min: 0,    max: 50 },
];

export function ZonesTab() {
  const preview = useTargetPreview();
  const zonesRef = useRef<ZonesState>(JSON.parse(JSON.stringify(DEFAULTS)));
  const [activeZone, setActiveZone] = useState<Zone>("midtones");
  const [, forceTabRerender] = useState(0); // only used when switching zone tabs (cheap)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const sliderRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const rafPending = useRef(false);

  const scheduleRedraw = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const c = canvasRef.current;
      if (!c || !preview) return;
      c.width = preview.width;
      c.height = preview.height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const transformed = applyZones(preview.data, zonesRef.current);
      const id = ctx.createImageData(preview.width, preview.height);
      id.data.set(transformed);
      ctx.putImageData(id, 0, 0);
    });
  };

  // Initial render + when target preview changes.
  useEffect(scheduleRedraw, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync slider DOM values to the active zone whenever the zone tab changes.
  useEffect(() => {
    const z = zonesRef.current[activeZone];
    for (const f of FIELDS) {
      const el = sliderRefs.current[f.key];
      const lbl = labelRefs.current[f.key];
      const v = z[f.key];
      if (el) el.value = String(v);
      if (lbl) lbl.textContent = String(v);
    }
  }, [activeZone]);

  const onSliderInput = (key: keyof ZoneState) => (e: React.FormEvent<HTMLInputElement>) => {
    const v = Number((e.target as HTMLInputElement).value);
    zonesRef.current[activeZone][key] = v;
    const lbl = labelRefs.current[key];
    if (lbl) lbl.textContent = String(v);
    scheduleRedraw();
  };

  const reset = () => {
    zonesRef.current = JSON.parse(JSON.stringify(DEFAULTS));
    forceTabRerender(n => n + 1);
    // Sync slider DOM values now (effect above will fire on activeZone change too).
    const z = zonesRef.current[activeZone];
    for (const f of FIELDS) {
      const el = sliderRefs.current[f.key];
      const lbl = labelRefs.current[f.key];
      if (el) el.value = String(z[f.key]);
      if (lbl) lbl.textContent = String(z[f.key]);
    }
    scheduleRedraw();
  };

  const tabBtn = (z: Zone): React.CSSProperties => ({
    flex: 1, padding: "4px 6px", fontSize: 10, cursor: "pointer",
    background: activeZone === z ? "#444" : "transparent",
    color: activeZone === z ? "white" : "#aaa",
    border: "1px solid #444",
  });

  const z = zonesRef.current[activeZone];

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        background: "#111", border: "1px solid #555",
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: 80, padding: 4,
      }}>
        {preview
          ? <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: 200 }} />
          : <span style={{ color: "#666", fontSize: 10 }}>Select a layer to preview</span>}
      </div>

      <div style={{ display: "flex" }}>
        <button style={tabBtn("shadows")}    onClick={() => setActiveZone("shadows")}>Shadows</button>
        <button style={tabBtn("midtones")}   onClick={() => setActiveZone("midtones")}>Midtones</button>
        <button style={tabBtn("highlights")} onClick={() => setActiveZone("highlights")}>Highlights</button>
      </div>

      {FIELDS.map(f => (
        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}>
          <span style={{ width: 56, opacity: 0.7 }}>{f.label}</span>
          <input
            ref={el => { sliderRefs.current[f.key] = el; }}
            type="range" min={f.min} max={f.max} defaultValue={z[f.key]}
            onInput={onSliderInput(f.key)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <span ref={el => { labelRefs.current[f.key] = el; }}
            style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{z[f.key]}</span>
        </div>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={reset} style={{
          padding: "6px 12px", background: "transparent", color: "#aaa",
          border: "1px solid #555", borderRadius: 3, cursor: "pointer", flex: 1,
        }}>Reset</button>
        <button disabled style={{
          padding: "6px 12px", background: "#1473e6", color: "white",
          border: "none", borderRadius: 3, opacity: 0.5, cursor: "not-allowed", flex: 2,
        }}>Bake (coming soon)</button>
      </div>

      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
        Live preview shows the active layer with current zone settings.
      </div>
    </div>
  );
}
