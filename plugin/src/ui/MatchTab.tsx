// Color Match: fits per-channel R/G/B Curves so target's histograms match source's.
// Source = a layer in the active doc, OR a snapshot of the active marquee selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane, PreviewImgHandle } from "./PreviewPane";
import { CurvesGraph } from "./CurvesGraph";
import { ZoneCompoundSlider } from "./ZoneCompoundSlider";
import { Icon } from "./Icon";
import { ChannelCurves } from "../core/histogramMatch";
import {
  fitHistogramCurves, fitHistogramCurvesLab, processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
  applyDimensions, applyZoneWeightsToChannels,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
} from "../core/histogramMatch";
import { applyMatch } from "../app/applyMatch";
import {
  app, action as psAction, readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const SOURCE_MAX_EDGE = 256;
type SrcMode = "layer" | "selection";

interface SourceSnap { width: number; height: number; data: Uint8Array; name: string; }

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
  const [srcOverride, setSrcOverride] = useState<SourceSnap | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [colorSpace, setColorSpace] = useState<"rgb" | "lab">("rgb");

  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | null>("basic");
  const toggleSection = (s: "basic" | "dims" | "zones") => setOpenSection(o => o === s ? null : s);

  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  const [activeDocId, setActiveDocId] = useState<number | null>(null);

  useEffect(() => {
    const refresh = () => {
      try {
        const list = (app.documents ?? []).map((d: any) => ({ id: d.id, name: d.name }));
        setDocs(list);
        setActiveDocId(app.activeDocument?.id ?? null);
      } catch { /* */ }
    };
    refresh();
    const events = ["open", "close", "select", "make"];
    psAction.addNotificationListener(events, refresh);
    return () => { psAction.removeNotificationListener?.(events, refresh); };
  }, []);

  const onSwitchDoc = (id: number) => {
    const d = (app.documents ?? []).find((x: any) => x.id === id);
    if (!d) return;
    try { app.activeDocument = d; setActiveDocId(id); } catch (e: any) { setStatus(`Error switching doc: ${e?.message ?? e}`); }
  };

  useEffect(() => {
    if (layers.length >= 2) {
      if (sourceId == null || !layers.find(l => l.id === sourceId)) setSourceId(layers[layers.length - 1].id);
      if (targetId == null || !layers.find(l => l.id === targetId)) setTargetId(layers[0].id);
    }
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(srcMode === "layer" ? sourceId : null);
  const tgt = useLayerPreview(targetId);
  const srcSnap = srcOverride ?? src.snap;

  // ─── Selection mode: snapshot from active marquee on active layer ───────
  const snapshotSelectionInner = async (): Promise<SourceSnap> => {
    return executeAsModal("Color Smash snap selection", async () => {
      const doc = getActiveDoc();
      const sel = getSelectionBounds();
      if (!sel) throw new Error("No active marquee selection.");
      const layer = doc.activeLayers?.[0];
      if (!layer) throw new Error("No active layer.");
      const buf = await readLayerPixels(layer, sel);
      // Read the selection mask within the same bbox; bake it into the alpha channel
      // so non-selected pixels are excluded from the histogram fit.
      try {
        const { imaging } = require("photoshop");
        const maskResult = await imaging.getSelection({ documentID: doc.id, sourceBounds: sel });
        const maskRaw = await maskResult.imageData.getData();
        const mask = maskRaw instanceof Uint8Array ? maskRaw : new Uint8Array(maskRaw);
        const px = buf.data;
        for (let i = 0, m = 0; i < px.length; i += 4, m++) {
          px[i + 3] = mask[m] ?? 0;
        }
        if (maskResult.imageData.dispose) maskResult.imageData.dispose();
      } catch { /* fallback: use full bbox if mask read fails */ }
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

  // Auto-update: poll selection bounds; re-snap when stable.
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
          try { setSrcOverride(await snapshotSelectionInner()); } catch { /* ignore */ }
        }
      } else {
        lastBoundsRef.current = key;
        stableTicksRef.current = 0;
      }
    }, 200);
    return () => clearInterval(interval);
  }, [srcMode, autoUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchSrcMode = (m: SrcMode) => {
    setSrcMode(m);
    if (m === "layer") { setSrcOverride(null); setAutoUpdate(false); }
  };

  const fittedRaw = useMemo(() => {
    if (!srcSnap || !tgt.snap) return null;
    const fit = colorSpace === "lab" ? fitHistogramCurvesLab : fitHistogramCurves;
    return fit(srcSnap.data, tgt.snap.data);
  }, [srcSnap, tgt.snap, colorSpace]);

  const matchedHandleRef = useRef<PreviewImgHandle | null>(null);
  const rafPendingRef = useRef(false);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  const curvesPendingRef = useRef<ChannelCurves | null>(null);
  const curvesTimeoutRef = useRef<any>(null);

  const redrawMatched = () => {
    if (!tgt.snap || !matchedHandleRef.current) return;
    if (!fittedRaw) return;
    const processed = processChannelCurves(fittedRaw, {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
    });
    const dim = applyDimensions(processed, dimsRef.current);
    const c = applyZoneWeightsToChannels(dim, zonesRef.current);
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
    setTimeout(() => { rafPendingRef.current = false; redrawMatched(); }, 33);
  };

  useEffect(() => { scheduleRedraw(); }, [fittedRaw, tgt.snap, chromaOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (srcMode === "layer" && sourceId == null) { setStatus("Pick source layer."); return; }
    if (srcMode === "selection" && !srcOverride) { setStatus("Snap a selection first."); return; }
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
        colorSpace,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  // ─── Styles ─────────────────────────────────────────────────────────────
  const tinyBtn: React.CSSProperties = { padding: "1px 6px", background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 9 };
  const sel: React.CSSProperties = { flex: 1, padding: "2px 4px", fontSize: 10, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" };
  const tabBtn = (active: boolean): React.CSSProperties => ({
    width: 20, height: 16, padding: 0, fontSize: 10, cursor: "pointer", textAlign: "center",
    lineHeight: "14px", background: active ? "#1473e6" : "transparent", color: active ? "white" : "#aaa",
    border: "1px solid #555", fontWeight: 600, boxSizing: "border-box",
  });
  const resetIconBtn: React.CSSProperties = {
    width: 16, height: 16, padding: 0, lineHeight: "14px", fontSize: 10, textAlign: "center",
    background: "transparent", color: "#888", border: "1px solid #444", borderRadius: 2, cursor: "pointer",
    flexShrink: 0, boxSizing: "border-box",
  };

  const sliderRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const slider = (
    label: string, ref: React.MutableRefObject<number>, value: number, setValue: (n: number) => void,
    min: number, max: number, suffix = "", defaultVal?: number,
  ) => {
    const reset = () => {
      if (defaultVal == null) return;
      ref.current = defaultVal; setValue(defaultVal);
      const el = sliderRefs.current[label];
      if (el) el.value = String(defaultVal);
      scheduleRedraw();
    };
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
        <span style={{ width: 56, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <input type="range" min={min} max={max} defaultValue={value}
          ref={el => { sliderRefs.current[label] = el; }}
          onInput={e => { const v = Math.round(Number((e.target as HTMLInputElement).value)); ref.current = v; setValue(v); scheduleRedraw(); }}
          style={{ flex: 1, minWidth: 30 }} />
        <span style={{ width: 30, textAlign: "right", opacity: 0.8, fontSize: 10 }}>{value}{suffix}</span>
        {defaultVal != null && <button onClick={reset} title={`Reset to ${defaultVal}${suffix}`} style={resetIconBtn}><Icon name="revert" size={11} /></button>}
      </div>
    );
  };

  const dimSlider = (label: string, key: keyof DimensionOpts, min: number, max: number, suffix = "") => {
    const value = dimsLabel[key];
    const def = DEFAULT_DIMENSIONS[key];
    const reset = () => {
      dimsRef.current = { ...dimsRef.current, [key]: def };
      setDimsLabel(d => ({ ...d, [key]: def }));
      scheduleRedraw();
    };
    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
        <span style={{ width: 56, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <input type="range" min={min} max={max} value={value}
          onInput={e => { const v = Math.round(Number((e.target as HTMLInputElement).value)); dimsRef.current = { ...dimsRef.current, [key]: v }; setDimsLabel(d => ({ ...d, [key]: v })); scheduleRedraw(); }}
          style={{ flex: 1, minWidth: 30 }} />
        <span style={{ width: 32, textAlign: "right", opacity: 0.8, fontSize: 10 }}>{value}{suffix}</span>
        <button onClick={reset} title={`Reset to ${def}${suffix}`} style={resetIconBtn}><Icon name="revert" size={11} /></button>
      </div>
    );
  };

  const onRefreshAll = () => { src.refresh(); tgt.refresh(); };

  const sourceModeContent = () => srcMode === "layer" ? (
    <select style={sel} value={sourceId ?? ""} onChange={e => setSourceId(Number(e.target.value))}>
      {layers.length === 0 && <option value="">— none —</option>}
      {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
      <input type="checkbox" checked={autoUpdate} onChange={e => setAutoUpdate(e.target.checked)}
        title={autoUpdate ? "Auto-sample on (selection changes re-sample)" : "Auto-sample on selection change"}
        style={{ cursor: "pointer", flexShrink: 0 }} />
      {autoUpdate && <span style={{ color: "#7d7", flexShrink: 0 }}>●</span>}
      <button onClick={onSnapSelection} style={{ ...tinyBtn, flexShrink: 0 }} title="Sample the current marquee selection now">Sample</button>
    </div>
  );

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Top row: source mode tabs + doc picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
        <span style={{ opacity: 0.7 }}>Src:</span>
        <button style={tabBtn(srcMode === "layer")}     onClick={() => switchSrcMode("layer")}     title="Layer source">
          <Icon name="layers" size={11} />
        </button>
        <button style={tabBtn(srcMode === "selection")} onClick={() => switchSrcMode("selection")} title="Selection source">
          <Icon name="selection" size={11} />
        </button>
        <span style={{ opacity: 0.7, marginLeft: 8 }}>Doc:</span>
        <select style={{ flex: 1, padding: "2px 4px", fontSize: 10, minWidth: 0, background: "#333", color: "#ddd", border: "1px solid #555" }}
          value={activeDocId ?? ""} onChange={e => onSwitchDoc(Number(e.target.value))}>
          {docs.length === 0 && <option value="">— no docs —</option>}
          {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={() => setColorSpace(c => c === "rgb" ? "lab" : "rgb")}
          title={`Color space: ${colorSpace.toUpperCase()} — click to toggle`}
          style={{ padding: "2px 6px", fontSize: 10, fontWeight: 600, minWidth: 32,
                   background: colorSpace === "lab" ? "#1473e6" : "transparent",
                   color: colorSpace === "lab" ? "white" : "#aaa",
                   border: "1px solid #555", borderRadius: 3, cursor: "pointer" }}>
          {colorSpace.toUpperCase()}
        </button>
        <button onClick={onRefreshAll} title="Refresh source + target previews" style={resetIconBtn}><Icon name="refresh" size={11} /></button>
      </div>

      {/* Body: previews left, controls right */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {useMemo(() => (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div style={{ height: 26, display: "flex", alignItems: "center" }}>{sourceModeContent()}</div>
                <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}}
                  snapshot={srcOverride ? { ...srcOverride, layerId: -1, layerName: srcOverride.name } : src.snap}
                  hideSelector fitAspect maxHeight={160} />
              </div>
              <div style={{ width: 1, background: "#444", alignSelf: "stretch" }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div style={{ height: 26, display: "flex", alignItems: "center" }}>
                  <select style={sel} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}>
                    {layers.length === 0 && <option value="">— none —</option>}
                    {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap}
                  hideSelector fitAspect maxHeight={160} />
              </div>
            </div>
          ), [src.snap, tgt.snap, sourceId, targetId, layers, srcMode, srcOverride, autoUpdate])}

          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, opacity: 0.7 }}>Matched preview</span>
          </div>
          <div style={{ height: 240 }}>
            {useMemo(() => (
              <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap} imgHandleRef={matchedHandleRef} hideSelector height={240} />
            ), [tgt.snap])}
          </div>
        </div>

        <div style={{ width: 1, background: "#444", alignSelf: "stretch" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
          <CurvesGraph curves={renderedCurves} />

          <div style={{ borderTop: "1px solid #444", margin: "8px 0 0" }} />
          <button onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
            <span><Icon name={openSection === "basic" ? "chevronDown" : "chevronRight"} size={11} /> Match controls</span>
          </button>
          {openSection === "basic" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {slider("Amount",     amountRef,  amountLabel,  setAmountLabel,  0, 100, "%", 100)}
              {slider("Smooth",     smoothRef,  smoothLabel,  setSmoothLabel,  0,  32, "",  0)}
              {slider("Stretch",    stretchRef, stretchLabel, setStretchLabel, 1,  32, "",  8)}
              {/* @ts-ignore Spectrum web component */}
              <sp-checkbox checked={chromaOnly || undefined} onInput={(e: any) => setChromaOnly(e.target.checked)} style={{ marginTop: 4, fontSize: 11 }}>
                Chroma only (preserve target luminance)
              {/* @ts-ignore */}
              </sp-checkbox>
            </div>
          )}

          <div style={{ borderTop: "1px solid #444" }} />
          <button onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
            <span><Icon name={openSection === "dims" ? "chevronDown" : "chevronRight"} size={11} /> Dimension warps</span>
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

          <div style={{ borderTop: "1px solid #444" }} />
          <button onClick={() => toggleSection("zones")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", background: "transparent", color: "#ccc", border: "none", cursor: "pointer", fontSize: 11 }}>
            <span><Icon name={openSection === "zones" ? "chevronDown" : "chevronRight"} size={11} /> Zone targeting</span>
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
                defaults={{ amount: DEFAULT_ZONES[zone], anchor: DEFAULT_ZONES[ankKey], falloff: DEFAULT_ZONES[falKey] }}
                onChange={next => {
                  zonesRef.current = { ...zonesRef.current, [zone]: next.amount, [ankKey]: next.anchor, [falKey]: next.falloff } as ZoneOpts;
                  setZonesLabel(z => ({ ...z, [zone]: next.amount, [ankKey]: next.anchor, [falKey]: next.falloff }));
                  scheduleRedraw();
                }}
              />
            );
          })}

          {/* @ts-ignore Spectrum web component */}
          <sp-button variant="secondary" onClick={onApply} style={{ marginTop: 6, width: "100%" }}>Apply Match (1 Curves layer)</sp-button>
          <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
        </div>
      </div>
    </div>
  );
}
