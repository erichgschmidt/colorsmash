// Color-match tab. One Curves layer fitted via per-channel histogram specification.
// Source is one of three modes (tabbed): Layer / Preset / Selection.
// Selection mode supports auto-update — re-snapshots when the marquee changes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane, PreviewImgHandle } from "./PreviewPane";
import { CurvesGraph } from "./CurvesGraph";
import { ZoneCompoundSlider } from "./ZoneCompoundSlider";
import { ChannelCurves } from "../core/histogramMatch";
import {
  fitHistogramCurves, processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
  applyDimensions, applyZoneWeightsToChannels,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
} from "../core/histogramMatch";
import { applyMatch } from "../app/applyMatch";
import { readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds } from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";
import {
  listPresets, savePreset, deletePreset, loadPresetSnap,
  SourcePreset, SourcePresetSnapshot,
} from "../services/sourcePresets";
import {
  snapshotFromClipboard, importRecentScreenshots, resetScreenshotFolder,
} from "../services/sourceCapture";

const SOURCE_MAX_EDGE = 256;

type SrcMode = "layer" | "preset" | "selection";

export function MatchTab() {
  const layers = useLayers();
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const smoothRef = useRef(0);
  const stretchRef = useRef(8);
  const [chromaOnly, setChromaOnly] = useState(false);
  const [amountLabel, setAmountLabel] = useState(100);
  const [smoothLabel, setSmoothLabel] = useState(0);
  const [stretchLabel, setStretchLabel] = useState(8);
  const [status, setStatus] = useState("Pick source + target.");

  const dimsRef = useRef<DimensionOpts>({ ...DEFAULT_DIMENSIONS });
  const [dimsLabel, setDimsLabel] = useState<DimensionOpts>({ ...DEFAULT_DIMENSIONS });

  const zonesRef = useRef<ZoneOpts>({ ...DEFAULT_ZONES });
  const [zonesLabel, setZonesLabel] = useState<ZoneOpts>({ ...DEFAULT_ZONES });

  const [srcMode, setSrcMode] = useState<SrcMode>("layer");
  const [srcOverride, setSrcOverride] = useState<SourcePresetSnapshot | null>(null);
  const [presets, setPresets] = useState<SourcePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [importN, setImportN] = useState(10);
  const [presetMore, setPresetMore] = useState(false);
  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | null>("basic");
  const toggleSection = (s: "basic" | "dims" | "zones") => setOpenSection(o => o === s ? null : s);

  useEffect(() => { listPresets().then(setPresets).catch(() => {}); }, []);

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(srcMode === "layer" ? sourceId : null);
  const tgt = useLayerPreview(targetId);

  // Effective source = override (preset/selection) or live layer snap.
  const srcSnap = srcOverride ?? src.snap;

  const fittedRaw = useMemo(() => {
    if (!srcSnap || !tgt.snap) return null;
    return fitHistogramCurves(srcSnap.data, tgt.snap.data);
  }, [srcSnap, tgt.snap]);

  const matchedHandleRef = useRef<PreviewImgHandle | null>(null);
  const rafPendingRef = useRef(false);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const curvesPendingRef = useRef<ChannelCurves | null>(null);
  const curvesTimeoutRef = useRef<any>(null);

  const redrawMatched = () => {
    if (!tgt.snap || !matchedHandleRef.current) return;
    if (showOriginal) {
      matchedHandleRef.current.setPixels(tgt.snap.data, tgt.snap.width, tgt.snap.height);
      return;
    }
    if (!fittedRaw) return;
    const processed = processChannelCurves(fittedRaw, {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
    });
    const dim = applyDimensions(processed, dimsRef.current);
    const c = applyZoneWeightsToChannels(dim, zonesRef.current);
    // Throttle the React state update for the curves graph (SVG re-render is the bottleneck).
    curvesPendingRef.current = c;
    if (!curvesTimeoutRef.current) {
      curvesTimeoutRef.current = setTimeout(() => {
        curvesTimeoutRef.current = null;
        if (curvesPendingRef.current) setRenderedCurves(curvesPendingRef.current);
      }, 100);
    }
    let out = applyChannelCurvesToRgba(tgt.snap.data, c);
    if (chromaOnly) out = applyChromaOnly(tgt.snap.data, out);
    matchedHandleRef.current.setPixels(out, tgt.snap.width, tgt.snap.height);
  };

  const scheduleRedraw = () => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => { rafPendingRef.current = false; redrawMatched(); });
  };

  useEffect(() => { scheduleRedraw(); }, [fittedRaw, tgt.snap, chromaOnly, showOriginal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Source-mode actions ────────────────────────────────────────────────
  const snapshotSelectionInner = async (): Promise<SourcePresetSnapshot> => {
    return executeAsModal("Color Smash snap selection", async () => {
      const doc = getActiveDoc();
      const sel = getSelectionBounds();
      if (!sel) throw new Error("No active marquee selection.");
      const layer = doc.activeLayers?.[0];
      if (!layer) throw new Error("No active layer.");
      const buf = await readLayerPixels(layer, sel);
      const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
      return { width: small.width, height: small.height, data: small.data, name: `${layer.name} (selection)` };
    });
  };

  const onSnapSelection = async () => {
    setStatus("Snapping selection...");
    try {
      const snap = await snapshotSelectionInner();
      setSrcOverride(snap);
      setStatus(`Source = ${snap.name}`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  // Auto-update polling when in Selection mode + autoUpdate on. Debounced via stability count.
  const lastBoundsRef = useRef<string>("");
  const stableTicksRef = useRef(0);
  useEffect(() => {
    if (srcMode !== "selection" || !autoUpdate) return;
    const interval = setInterval(async () => {
      let bounds: any = null;
      try { bounds = getSelectionBounds(); } catch { /* */ }
      if (!bounds) { lastBoundsRef.current = ""; stableTicksRef.current = 0; return; }
      const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
      if (key === lastBoundsRef.current) {
        stableTicksRef.current++;
        if (stableTicksRef.current === 1) {
          try { setSrcOverride(await snapshotSelectionInner()); } catch { /* ignore transient */ }
        }
      } else {
        lastBoundsRef.current = key;
        stableTicksRef.current = 0;
      }
    }, 200);
    return () => clearInterval(interval);
  }, [srcMode, autoUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching mode: clear conflicting state.
  const switchMode = (m: SrcMode) => {
    setSrcMode(m);
    if (m === "layer") { setSrcOverride(null); setAutoUpdate(false); }
    if (m === "preset") setAutoUpdate(false);
    // Selection mode: leave srcOverride; user can Snap now or enable auto-update.
  };

  const onLoadPreset = (id: string) => {
    setSelectedPresetId(id);
    if (!id) { setSrcOverride(null); return; }
    const p = presets.find(x => x.id === id);
    if (!p) return;
    setSrcOverride(loadPresetSnap(p));
    setStatus(`Source = preset "${p.name}"`);
  };

  const onSavePreset = async () => {
    if (!srcSnap) { setStatus("No source snapshot to save."); return; }
    const defaultName = srcOverride?.name ?? src.snap?.layerName ?? "Untitled";
    const name = prompt("Preset name:", defaultName);
    if (!name) return;
    try {
      await savePreset({ width: srcSnap.width, height: srcSnap.height, data: srcSnap.data, name });
      setPresets(await listPresets());
      setStatus(`Saved preset "${name}".`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const onDeletePreset = async () => {
    if (!selectedPresetId) { setStatus("Pick a preset to delete."); return; }
    const p = presets.find(x => x.id === selectedPresetId);
    if (!p) return;
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    await deletePreset(selectedPresetId);
    setPresets(await listPresets());
    setSelectedPresetId("");
    if (srcOverride?.name === p.name) setSrcOverride(null);
    setStatus("Preset deleted.");
  };

  const onSnapshotClipboard = async (alsoSave: boolean) => {
    setStatus("Pasting from clipboard...");
    try {
      const snap = await snapshotFromClipboard();
      setSrcOverride(snap);
      let msg = `Source = ${snap.name}`;
      if (alsoSave) {
        const name = prompt("Preset name:", snap.name);
        if (name) {
          await savePreset({ ...snap, name });
          setPresets(await listPresets());
          msg += ` · saved as "${name}"`;
        }
      }
      setStatus(msg);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const onImportFolder = async () => {
    setStatus(`Importing last ${importN}...`);
    try {
      const existing = new Set(presets.map(p => p.name));
      const snaps = await importRecentScreenshots(importN, existing);
      if (snaps.length === 0) { setStatus("No new images (already imported or folder empty)."); return; }
      for (const s of snaps) await savePreset(s);
      const fresh = await listPresets();
      setPresets(fresh);
      const newest = fresh.find(p => p.name === snaps[0].name);
      if (newest) { setSrcOverride(loadPresetSnap(newest)); setSelectedPresetId(newest.id); }
      setStatus(`Imported ${snaps.length} preset${snaps.length === 1 ? "" : "s"}.`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const onResetFolder = async () => { setStatus(await resetScreenshotFolder()); };

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (srcMode === "layer" && sourceId == null) { setStatus("Pick source layer."); return; }
    if (srcMode !== "layer" && !srcOverride) { setStatus("No source snapshot — capture one first."); return; }
    setStatus("Applying match...");
    try {
      setStatus(await applyMatch({
        sourceLayerId: sourceId ?? -1,
        targetLayerId: targetId,
        amount: amountRef.current / 100,
        smoothRadius: smoothRef.current,
        maxStretch: stretchRef.current,
        chromaOnly,
        dimensions: dimsRef.current,
        zones: zonesRef.current,
        sourcePixelsOverride: srcOverride?.data,
        sourceLabel: srcOverride?.name,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  // ─── UI helpers ─────────────────────────────────────────────────────────
  const btn: React.CSSProperties = { padding: "6px 12px", marginTop: 6, background: "#1473e6", color: "white", border: "none", cursor: "pointer", borderRadius: 3 };
  const tinyBtn: React.CSSProperties = { padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 };
  const sel: React.CSSProperties = { flex: 1, padding: "2px 4px", fontSize: 10, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" };
  const tabBtn = (active: boolean): React.CSSProperties => ({
    width: 20, height: 16, padding: 0, fontSize: 10, cursor: "pointer", textAlign: "center",
    lineHeight: "14px",
    background: active ? "#1473e6" : "transparent",
    color: active ? "white" : "#aaa",
    border: "1px solid #555",
    fontWeight: 600,
    boxSizing: "border-box",
  });

  const slider = (
    label: string, ref: React.MutableRefObject<number>, value: number, setValue: (n: number) => void,
    min: number, max: number, suffix = "",
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
      <input type="range" min={min} max={max} defaultValue={value}
        onInput={e => { const v = Number((e.target as HTMLInputElement).value); ref.current = v; setValue(v); scheduleRedraw(); }}
        style={{ flex: 1, minWidth: 0 }} />
      <span style={{ width: 36, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
    </div>
  );

const dimSlider = (label: string, key: keyof DimensionOpts, min: number, max: number, suffix = "") => {
    const value = dimsLabel[key];
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <span style={{ width: 64, opacity: 0.7 }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => { const v = Number((e.target as HTMLInputElement).value); dimsRef.current = { ...dimsRef.current, [key]: v }; setDimsLabel(d => ({ ...d, [key]: v })); scheduleRedraw(); }}
          style={{ flex: 1, minWidth: 0 }} />
        <span style={{ width: 40, textAlign: "right", opacity: 0.8 }}>{value}{suffix}</span>
      </div>
    );
  };

  // ─── Source mode tab content ────────────────────────────────────────────
  const sourceModeContent = () => {
    if (srcMode === "layer") {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
          <select style={sel} value={sourceId ?? ""} onChange={e => setSourceId(Number(e.target.value))}>
            {layers.length === 0 && <option value="">— none —</option>}
            {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      );
    }
    if (srcMode === "preset") {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
          <select style={sel} value={selectedPresetId} onChange={e => onLoadPreset(e.target.value)}>
            <option value="">— pick a preset —</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={onDeletePreset} style={tinyBtn} title="Delete selected preset">Del</button>
          <button onClick={() => setPresetMore(m => !m)} style={tinyBtn} title="Show preset creation options">{presetMore ? "▾" : "+"}</button>
        </div>
      );
    }
    // selection
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, whiteSpace: "nowrap", overflow: "hidden" }}>
        <button onClick={onSnapSelection} style={tinyBtn}>Snap now</button>
        <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer", opacity: 0.85 }} title="Auto-update from selection">
          <input type="checkbox" checked={autoUpdate} onChange={e => setAutoUpdate(e.target.checked)} />
          Auto{autoUpdate && <span style={{ color: "#7d7" }}> ●</span>}
        </label>
      </div>
    );
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Two flex columns + center divider. Stretch makes columns equal height,
          marginTop:auto on previews pushes them to bottom so they align. */}
      {useMemo(() => (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 0, height: 18 }}>
              <span style={{ fontSize: 10, opacity: 0.7, width: 22 }}>Src</span>
              <button style={tabBtn(srcMode === "layer")}     onClick={() => switchMode("layer")}     title="Layer">L</button>
              <button style={tabBtn(srcMode === "preset")}    onClick={() => switchMode("preset")}    title="Preset">P</button>
              <button style={tabBtn(srcMode === "selection")} onClick={() => switchMode("selection")} title="Selection">S</button>
            </div>
            <div style={{ height: 22, display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>{sourceModeContent()}</div>
            <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}}
              snapshot={srcOverride ? { ...srcOverride, layerId: -1, layerName: srcOverride.name } : src.snap}
              onRefresh={srcMode === "layer" ? src.refresh : undefined}
              hideSelector fitAspect maxHeight={160} />
          </div>
          <div style={{ width: 1, background: "#444", alignSelf: "stretch" }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 0, height: 18 }}>
              <span style={{ fontSize: 10, opacity: 0.7, width: 22 }}>Tgt</span>
              <button style={{ ...tabBtn(true), cursor: "default" }} title="Layer" disabled>L</button>
            </div>
            <div style={{ height: 22, display: "flex" }}>
              <select style={sel} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}>
                {layers.length === 0 && <option value="">— none —</option>}
                {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} onRefresh={tgt.refresh}
              hideSelector fitAspect maxHeight={160} />
          </div>
        </div>
      ), [src.snap, src.refresh, tgt.snap, tgt.refresh, sourceId, targetId, srcMode, srcOverride, layers, selectedPresetId, presets, autoUpdate, importN, presetMore])}

{srcMode === "preset" && presetMore && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 10, padding: "4px 6px", background: "#1a1a1a", borderRadius: 3, border: "1px solid #333" }}>
          <span style={{ opacity: 0.6 }}>New preset:</span>
          <button onClick={onSavePreset} style={tinyBtn}>Save current</button>
          <button onClick={() => onSnapshotClipboard(false)} style={tinyBtn}>Clipboard</button>
          <button onClick={() => onSnapshotClipboard(true)} style={tinyBtn}>Clip → preset</button>
          <span style={{ opacity: 0.6, marginLeft: 4 }}>folder last</span>
          <input type="number" min={1} max={30} value={importN} tabIndex={-1}
            onChange={e => setImportN(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            style={{ width: 36, padding: "1px 4px", background: "#333", color: "#ddd", border: "1px solid #555", fontSize: 10 }} />
          <button onClick={onImportFolder} style={tinyBtn}>Import</button>
          <button onClick={onResetFolder} style={tinyBtn} title="Forget saved screenshot folder">⟲</button>
        </div>
      )}

<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <span style={{ fontSize: 10, opacity: 0.7 }}>Matched preview {showOriginal && <span style={{ color: "#e80" }}>· showing original</span>}</span>
        <button
          onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)}
          onTouchStart={() => setShowOriginal(true)} onTouchEnd={() => setShowOriginal(false)}
          style={{ padding: "1px 8px", background: showOriginal ? "#e80" : "transparent", color: showOriginal ? "white" : "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 }}
        >Hold for A/B</button>
      </div>
      {useMemo(() => (
        <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} imgHandleRef={matchedHandleRef} hideSelector fitAspect />
      ), [tgt.snap])}

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
      <CurvesGraph curves={renderedCurves} />

      {/* ── Accordion: Basic ────────────────────────────── */}
      <div style={{ borderTop: "1px solid #444", margin: "8px 0 0" }} />
      <button onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
        <span>{openSection === "basic" ? "▾" : "▸"} Match controls</span>
      </button>
      {openSection === "basic" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {slider("Amount",     amountRef,  amountLabel,  setAmountLabel,  0, 100, "%")}
          {slider("Smoothing",  smoothRef,  smoothLabel,  setSmoothLabel,  0,  32)}
          {slider("Max stretch",stretchRef, stretchLabel, setStretchLabel, 1,  32)}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginTop: 2, cursor: "pointer", opacity: 0.85 }}>
            <input type="checkbox" checked={chromaOnly} onChange={e => setChromaOnly(e.target.checked)} />
            Chroma only (preserve target luminance)
          </label>
        </div>
      )}

      {/* ── Accordion: Dimensions ──────────────────────── */}
      <div style={{ borderTop: "1px solid #444" }} />
      <button onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
        <span>{openSection === "dims" ? "▾" : "▸"} Dimension warps</span>
        {openSection === "dims" && <span onClick={(e: any) => { e.stopPropagation(); dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>}
      </button>
      {openSection === "dims" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {dimSlider("Value",       "value",      0, 200, "%")}
          {dimSlider("Chroma",      "chroma",     0, 200, "%")}
          {dimSlider("Hue shift",   "hueShift", -180, 180, "°")}
          {dimSlider("Contrast",    "contrast",   1, 200, "%")}
          {dimSlider("Neutralize",  "neutralize", 0, 100, "%")}
          {dimSlider("Separation",  "separation", 0, 200, "%")}
        </div>
      )}

      {/* ── Accordion: Zones ───────────────────────────── */}
      <div style={{ borderTop: "1px solid #444" }} />
      <button onClick={() => toggleSection("zones")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
        <span>{openSection === "zones" ? "▾" : "▸"} Zone targeting</span>
        {openSection === "zones" && <span onClick={(e: any) => { e.stopPropagation(); zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>}
      </button>
      {openSection === "zones" && (["shadows", "mids", "highlights"] as const).map(zone => {
        const colorMap: Record<string, string> = { shadows: "#4a7fc1", mids: "#bbb", highlights: "#e0b85a" };
        const ankKey = `${zone}Anchor` as keyof ZoneOpts;
        const falKey = `${zone}Falloff` as keyof ZoneOpts;
        return (
          <ZoneCompoundSlider
            key={zone}
            label={zone}
            color={colorMap[zone]}
            value={{ amount: zonesLabel[zone], anchor: zonesLabel[ankKey], falloff: zonesLabel[falKey] }}
            onChange={next => {
              zonesRef.current = {
                ...zonesRef.current,
                [zone]: next.amount,
                [ankKey]: next.anchor,
                [falKey]: next.falloff,
              } as ZoneOpts;
              setZonesLabel(z => ({ ...z, [zone]: next.amount, [ankKey]: next.anchor, [falKey]: next.falloff }));
              scheduleRedraw();
            }}
          />
        );
      })}

      <button onClick={onApply} style={btn}>Apply Match (1 Curves layer)</button>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
