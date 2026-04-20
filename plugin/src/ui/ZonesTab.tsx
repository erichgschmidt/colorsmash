// Zones tab — Lumetri-wheels-style tonal-zone color grading.
// V0 scaffolding. See docs/zone-editor-spec.md for the full design.

import { useState } from "react";

type Zone = "shadows" | "midtones" | "highlights";

interface ZoneState {
  hue: number;        // -180..180
  sat: number;        // -100..100
  lift: number;       // -100..100
  rangeStart: number; // 0..100 (for highlights, this is the LOW edge of the range)
  rangeEnd: number;   // 0..100
  feather: number;    // 0..50 (Blend If split slider feather amount)
}

const DEFAULT_ZONES: Record<Zone, ZoneState> = {
  shadows:    { hue: 0, sat: 0, lift: 0, rangeStart: 0,  rangeEnd: 35, feather: 15 },
  midtones:   { hue: 0, sat: 0, lift: 0, rangeStart: 25, rangeEnd: 75, feather: 15 },
  highlights: { hue: 0, sat: 0, lift: 0, rangeStart: 65, rangeEnd: 100, feather: 15 },
};

export function ZonesTab() {
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [activeZone, setActiveZone] = useState<Zone>("midtones");
  const [status] = useState("Zone editor — coming soon. UI scaffolding only; preview + bake unimplemented.");

  const update = (zone: Zone, patch: Partial<ZoneState>) =>
    setZones(prev => ({ ...prev, [zone]: { ...prev[zone], ...patch } }));

  const tabBtn = (z: Zone): React.CSSProperties => ({
    flex: 1, padding: "4px 6px", fontSize: 10, cursor: "pointer",
    background: activeZone === z ? "#444" : "transparent",
    color: activeZone === z ? "white" : "#aaa",
    border: "1px solid #444",
  });

  const Field = (p: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7 }}>{p.label}</span>
      <input type="range" min={p.min} max={p.max} value={p.value}
        onChange={e => p.onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }} />
      <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{p.value}</span>
    </div>
  );

  const z = zones[activeZone];

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* TODO: live histogram preview with draggable zone bands */}
      <div style={{
        height: 60, background: "#333", border: "1px solid #555",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#666", fontSize: 10,
      }}>
        Histogram preview (TODO)
      </div>

      <div style={{ display: "flex", marginTop: 4 }}>
        <button style={tabBtn("shadows")}    onClick={() => setActiveZone("shadows")}>Shadows</button>
        <button style={tabBtn("midtones")}   onClick={() => setActiveZone("midtones")}>Midtones</button>
        <button style={tabBtn("highlights")} onClick={() => setActiveZone("highlights")}>Highlights</button>
      </div>

      <Field label="Hue"     min={-180} max={180} value={z.hue}  onChange={v => update(activeZone, { hue: v })} />
      <Field label="Sat"     min={-100} max={100} value={z.sat}  onChange={v => update(activeZone, { sat: v })} />
      <Field label="Lift"    min={-100} max={100} value={z.lift} onChange={v => update(activeZone, { lift: v })} />
      <Field label="Range L" min={0}    max={100} value={z.rangeStart} onChange={v => update(activeZone, { rangeStart: v })} />
      <Field label="Range R" min={0}    max={100} value={z.rangeEnd}   onChange={v => update(activeZone, { rangeEnd: v })} />
      <Field label="Feather" min={0}    max={50}  value={z.feather}    onChange={v => update(activeZone, { feather: v })} />

      <button disabled style={{
        padding: "6px 12px", marginTop: 6, background: "#1473e6", color: "white",
        border: "none", borderRadius: 3, opacity: 0.5, cursor: "not-allowed",
      }}>Bake to layer stack (coming soon)</button>

      <div style={{ marginTop: 8, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
