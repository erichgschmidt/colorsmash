// Color Match: fits per-channel R/G/B Curves so target's histograms match source's.
// Source = a layer in the active doc, OR a snapshot of the active marquee selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { PreviewPane } from "./PreviewPane";
import { CurvesGraph } from "./CurvesGraph";
import { ZoneCompoundSlider } from "./ZoneCompoundSlider";
import { Icon } from "./Icon";
import { MatchedPreview, MatchedPreviewHandle } from "./MatchedPreview";
import { SourceSelector } from "./SourceSelector";
import { BottomActionBar } from "./BottomActionBar";
import { BasicSlider, DimSlider, matchStyles } from "./MatchSliders";
import { ChannelCurves } from "../core/histogramMatch";
import {
  fitHistogramCurves, fitHistogramCurvesLab, processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
  applyDimensions, applyZoneAndEnvelopeToChannels, MERGED_LAYER_ID,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
  computeLumaBins, bandMeanColor,
  EnvelopePoint, DEFAULT_ENVELOPE,
} from "../core/histogramMatch";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { applyMatch } from "../app/applyMatch";
import {
  app, action as psAction, readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const SOURCE_MAX_EDGE = 256;
type SrcMode = "layer" | "selection" | "folder";

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
  const [lockZoneTotal, setLockZoneTotal] = useState(false);

  const envelopeRef = useRef<EnvelopePoint[]>([...DEFAULT_ENVELOPE]);
  const [envelopeLabel, setEnvelopeLabel] = useState<EnvelopePoint[]>([...DEFAULT_ENVELOPE]);

  const [srcMode, setSrcMode] = useState<SrcMode>("layer");
  const [srcOverride, setSrcOverride] = useState<SourceSnap | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [sampleMerged, setSampleMerged] = useState(false);
  const [sampleLock, setSampleLock] = useState(false);
  const sampleLockRef = useRef(false);
  useEffect(() => { sampleLockRef.current = sampleLock; }, [sampleLock]);

  // Browse Image source: pick a single image file from disk; loads as srcOverride.
  const [browsedFile, setBrowsedFile] = useState<string>("");

  const onBrowseImage = async () => {
    setStatus("Picking image...");
    try {
      const uxp = require("uxp");
      const file = await uxp.storage.localFileSystem.getFileForOpening({
        types: ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp"],
      });
      if (!file) { setStatus("Cancelled."); return; }
      const { app, action: psA } = require("photoshop");
      const snap = await executeAsModal("Color Smash load image", async () => {
        const token = uxp.storage.localFileSystem.createSessionToken(file);
        const beforeId = app.activeDocument?.id ?? null;
        await psA.batchPlay([{ _obj: "open", null: { _path: token } }], {});
        const opened = app.activeDocument;
        if (!opened || opened.id === beforeId) throw new Error("Open failed.");
        const bg = opened.backgroundLayer ?? opened.layers[opened.layers.length - 1];
        const buf = await readLayerPixels(bg);
        const small = downsampleToMaxEdge(buf, SOURCE_MAX_EDGE);
        try { await opened.closeWithoutSaving(); } catch { /* ignore */ }
        return { width: small.width, height: small.height, data: small.data, name: file.name };
      });
      setSrcOverride(snap);
      setSrcMode("folder");
      setBrowsedFile(file.name);
      setStatus(`Source = ${file.name}`);
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };
  const [colorSpace, setColorSpace] = useState<"rgb" | "lab">("rgb");
  const [deselectOnApply, setDeselectOnApply] = useState(true);
  const [overwriteOnApply, setOverwriteOnApply] = useState(true);

  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | "envelope" | null>(null);
  const toggleSection = (s: "basic" | "dims" | "zones" | "envelope") => setOpenSection(o => o === s ? null : s);

  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  const [activeDocId, setActiveDocId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const readNow = () => {
      if (cancelled) return;
      try {
        const list = (app.documents ?? []).map((d: any) => ({ id: d.id, name: d.name }));
        setDocs(list);
        setActiveDocId(app.activeDocument?.id ?? null);
      } catch { /* */ }
    };
    // PS fires events during modal scope before doc.documents reflects the mutation;
    // defer so we read after the tree settles. Two passes for fast vs late settle.
    const refresh = () => { setTimeout(readNow, 0); setTimeout(readNow, 120); };
    readNow();
    const events = ["open", "close", "select", "make"];
    psAction.addNotificationListener(events, refresh);
    return () => { cancelled = true; psAction.removeNotificationListener?.(events, refresh); };
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
      let buf;
      let sourceName: string;
      if (sampleMerged) {
        // Read the merged composite within sel: imaging.getPixels with no layerID returns the doc composite.
        try {
          const { imaging } = require("photoshop");
          const result = await imaging.getPixels({ documentID: doc.id, sourceBounds: sel, componentSize: 8, applyAlpha: false, colorSpace: "RGB" });
          const id = result.imageData;
          const raw = await id.getData();
          const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const w = id.width, h = id.height;
          const components = id.components ?? (src.length / (w * h));
          const data = new Uint8Array(w * h * 4);
          if (components === 4) data.set(src);
          else for (let i = 0, j = 0; i < w * h; i++, j += 3) { const o = i * 4; data[o] = src[j]; data[o + 1] = src[j + 1]; data[o + 2] = src[j + 2]; data[o + 3] = 255; }
          if (id.dispose) id.dispose();
          buf = { width: w, height: h, data, bounds: sel };
          sourceName = "Composite (selection)";
        } catch (e: any) {
          throw new Error(`Merged sample failed (UXP version may not support compositeless getPixels): ${e?.message ?? e}`);
        }
      } else {
        const layer = doc.activeLayers?.[0];
        if (!layer) throw new Error("No active layer.");
        buf = await readLayerPixels(layer, sel);
        sourceName = `${layer.name} (selection)`;
      }
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
      return { width: small.width, height: small.height, data: small.data, name: sourceName };
    });
  };

  // Auto-update: re-snap on EITHER selection-bounds change OR PS pixel-changing events.
  const lastBoundsRef = useRef<string>("");
  const snapInFlightRef = useRef(false);
  // Ref the latest snapshot fn so the long-lived effect doesn't capture a stale closure.
  const snapshotFnRef = useRef(snapshotSelectionInner);
  useEffect(() => { snapshotFnRef.current = snapshotSelectionInner; });

  useEffect(() => {
    if (srcMode !== "selection" || !autoUpdate) return;
    let cancelled = false;
    const trySnap = async () => {
      if (snapInFlightRef.current || sampleLockRef.current) return;
      let bounds: any = null;
      try { bounds = getSelectionBounds(); } catch { /* */ }
      if (!bounds) return;
      snapInFlightRef.current = true;
      try { const snap = await snapshotFnRef.current(); if (!cancelled) setSrcOverride(snap); }
      catch { /* ignore transient auto-update failures */ }
      finally { snapInFlightRef.current = false; }
    };
    // Immediate re-snap on bounds change (cheap poll: just reads doc.selection.bounds).
    const boundsTimer = setInterval(() => {
      let bounds: any = null;
      try { bounds = getSelectionBounds(); } catch { /* */ }
      const key = bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : "";
      if (key && key !== lastBoundsRef.current) { lastBoundsRef.current = key; trySnap(); }
      else if (!key) { lastBoundsRef.current = ""; }
    }, 200);
    // Re-snap on any PS event that could change pixels under the marquee.
    const events = ["set", "make", "delete", "paste", "fill", "stroke", "move", "applyImage", "rasterizeLayer", "modifyLayerEffect"];
    const onPsEvent = () => trySnap();
    psAction.addNotificationListener(events, onPsEvent);
    // Periodic backup (some events like brush strokes don't notify reliably).
    const pollTimer = setInterval(() => trySnap(), 1000);
    trySnap(); // initial
    return () => {
      cancelled = true;
      clearInterval(boundsTimer);
      clearInterval(pollTimer);
      psAction.removeNotificationListener?.(events, onPsEvent);
    };
  }, [srcMode, autoUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchSrcMode = (m: SrcMode) => {
    setSrcMode(m);
    if (m === "layer") { setSrcOverride(null); setBrowsedFile(""); }
  };

  const fittedRaw = useMemo(() => {
    if (!srcSnap || !tgt.snap) return null;
    const fit = colorSpace === "lab" ? fitHistogramCurvesLab : fitHistogramCurves;
    return fit(srcSnap.data, tgt.snap.data);
  }, [srcSnap, tgt.snap, colorSpace]);

  // Luma-binned color stats from target pixels — used to color the zone band swatches with the
  // actual mean color of pixels at each luminance level. Recomputed only when target pixels change.
  const lumaBins = useMemo(() => tgt.snap ? computeLumaBins(tgt.snap.data) : null, [tgt.snap]);

  // Matched preview is rendered by <MatchedPreview/>; we drive it imperatively via a handle.
  const matchedHandleRef = useRef<MatchedPreviewHandle | null>(null);
  const rafPendingRef = useRef(false);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  const curvesPendingRef = useRef<ChannelCurves | null>(null);
  const curvesTimeoutRef = useRef<any>(null);

  const redrawMatched = () => {
    if (!tgt.snap || !fittedRaw) return;
    // Handle ref may not be bound yet on first render — retry shortly.
    if (!matchedHandleRef.current) {
      setTimeout(() => redrawMatched(), 100);
      return;
    }
    const processed = processChannelCurves(fittedRaw, {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
    });
    const dim = applyDimensions(processed, dimsRef.current);
    const c = applyZoneAndEnvelopeToChannels(dim, zonesRef.current, envelopeRef.current);
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

  useEffect(() => {
    // Reset throttle so an in-flight no-op (from before snapshots loaded) doesn't block
    // this redraw — fixes "preview blank until I wiggle a slider" on first mount.
    rafPendingRef.current = false;
    scheduleRedraw();
  }, [fittedRaw, tgt.snap, chromaOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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
        envelope: envelopeRef.current,
        sourcePixelsOverride: srcOverride?.data,
        sourceLabel: srcOverride?.name,
        colorSpace,
        deselectFirst: deselectOnApply,
        overwritePrior: overwriteOnApply,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const sel = matchStyles.sel;
  const tinyBtn = matchStyles.tinyBtn;

  const onRefreshAll = async () => {
    src.refresh();
    tgt.refresh();
    if (srcMode === "selection" && srcOverride) {
      try { setSrcOverride(await snapshotSelectionInner()); } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
    }
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Top: source + target side-by-side mini panes (each: doc dropdown + layer picker + small preview) */}
      {useMemo(() => (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <SourceSelector
              docs={docs} activeDocId={activeDocId} srcMode={srcMode} browsedFile={browsedFile}
              onSwitchDoc={onSwitchDoc} onSwitchSrcMode={switchSrcMode}
              setBrowsedFile={setBrowsedFile} onBrowseImage={onBrowseImage}
              layers={layers} sourceId={sourceId} setSourceId={setSourceId}
              autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate}
              sampleMerged={sampleMerged} setSampleMerged={setSampleMerged}
              sampleLock={sampleLock} setSampleLock={setSampleLock}
              selStyle={sel}
            />
            <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}}
              snapshot={srcOverride ? { ...srcOverride, layerId: -1, layerName: srcOverride.name } : src.snap}
              hideSelector fitAspect maxHeight={120} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ height: 26 }}>
              <select style={sel} value={activeDocId ?? ""} onChange={e => onSwitchDoc(Number(e.target.value))}>
                {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div style={{ height: 26 }}>
              <select style={sel} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}>
                {layers.length === 0 && <option value="">— none —</option>}
                {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                <option value={MERGED_LAYER_ID}>🔀 Merged</option>
              </select>
            </div>
            <PreviewPane label="" layers={[]} selectedId={null} onSelect={() => {}} snapshot={tgt.snap}
              hideSelector fitAspect maxHeight={120} />
          </div>
        </div>
      ), [src.snap, tgt.snap, sourceId, targetId, layers, srcMode, srcOverride, autoUpdate, sampleMerged, sampleLock, browsedFile, docs, activeDocId])}

      {/* Matched preview (full-width, large) with zoom controls */}
      <MatchedPreview ref={matchedHandleRef} />

      {/* Accordion controls */}
      <div style={{ borderTop: "1px solid #444", margin: "6px 0 0" }} />
      <div onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: "#dddddd", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        <span><Icon name={openSection === "basic" ? "chevronDown" : "chevronRight"} size={11} /> Match controls</span>
      </div>
      {openSection === "basic" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0 }}>
          <BasicSlider label="Amount"  refObj={amountRef}  value={amountLabel}  setValue={setAmountLabel}  min={0} max={100} suffix="%" defaultVal={100} scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Smooth"  refObj={smoothRef}  value={smoothLabel}  setValue={setSmoothLabel}  min={0} max={32}  defaultVal={0}   scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Stretch" refObj={stretchRef} value={stretchLabel} setValue={setStretchLabel} min={1} max={32}  defaultVal={8}   scheduleRedraw={scheduleRedraw} />
          {/* @ts-ignore Spectrum web component */}
          <sp-checkbox checked={chromaOnly || undefined} onInput={(e: any) => setChromaOnly(e.target.checked)} style={{ marginTop: 4, fontSize: 11 }}>
            Chroma only (preserve target luminance)
          {/* @ts-ignore */}
          </sp-checkbox>
        </div>
      )}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: "#dddddd", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        <span><Icon name={openSection === "dims" ? "chevronDown" : "chevronRight"} size={11} /> Dimension warps</span>
        {openSection === "dims" && <span onClick={(e: any) => { e.stopPropagation(); dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>}
      </div>
      {openSection === "dims" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0 }}>
          {([
            ["Value",      "value",      0, 200, "%"],
            ["Chroma",     "chroma",     0, 200, "%"],
            ["Hue shift",  "hueShift", -180, 180, "°"],
            ["Contrast",   "contrast",   1, 200, "%"],
            ["Neutralize", "neutralize", 0, 100, "%"],
            ["Separation", "separation", 0, 200, "%"],
          ] as Array<[string, keyof DimensionOpts, number, number, string]>).map(([lbl, k, mn, mx, sfx]) => (
            <DimSlider key={k} label={lbl} dimKey={k} min={mn} max={mx} suffix={sfx}
              dimsLabel={dimsLabel} dimsRef={dimsRef} setDimsLabel={setDimsLabel} scheduleRedraw={scheduleRedraw} />
          ))}
        </div>
      )}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("zones")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: "#dddddd", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        <span><Icon name={openSection === "zones" ? "chevronDown" : "chevronRight"} size={11} /> Zone targeting</span>
        {openSection === "zones" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <label onClick={(e: any) => e.stopPropagation()} title="Lock total: when one amount changes, the other two rebalance proportionally to preserve the sum"
              style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 400, opacity: 0.85, cursor: "pointer" }}>
              <input type="checkbox" checked={lockZoneTotal} onChange={e => setLockZoneTotal(e.target.checked)}
                style={{ cursor: "pointer", margin: 0 }} />
              Lock total
            </label>
            <span onClick={(e: any) => { e.stopPropagation(); zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>
          </span>
        )}
      </div>
      {openSection === "zones" && (["shadows", "mids", "highlights"] as const).map(zone => {
        const fallback: Record<string, string> = { shadows: "#4a7fc1", mids: "#bbb", highlights: "#e0b85a" };
        const ankKey = `${zone}Anchor` as keyof ZoneOpts;
        const falKey = `${zone}Falloff` as keyof ZoneOpts;
        const biasKey = `${zone}Bias` as keyof ZoneOpts;
        // Derive band color from target pixels at this zone's luma range. Falls back to
        // fixed palette if no target snapshot yet or if the zone has no pixels in range.
        let bandColor = fallback[zone];
        if (lumaBins) {
          const c = bandMeanColor(lumaBins, zonesLabel[ankKey], zonesLabel[falKey]);
          if (c) bandColor = `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
        }
        return (
          <div key={zone} style={{ padding: 0 }}>
            <ZoneCompoundSlider
              label={zone}
              color={bandColor}
              value={{ amount: zonesLabel[zone], anchor: zonesLabel[ankKey], falloff: zonesLabel[falKey], bias: zonesLabel[biasKey] }}
              defaults={{ amount: DEFAULT_ZONES[zone], anchor: DEFAULT_ZONES[ankKey], falloff: DEFAULT_ZONES[falKey], bias: DEFAULT_ZONES[biasKey] }}
              onChange={next => {
                const cur = zonesRef.current;
                const amountChanged = next.amount !== cur[zone];
                let patch: Partial<ZoneOpts> = { [zone]: next.amount, [ankKey]: next.anchor, [falKey]: next.falloff, [biasKey]: next.bias } as Partial<ZoneOpts>;
                // Lock-total: if this drag changed the amount, redistribute the delta across the other two zones
                // proportionally to their current values (so their ratio is preserved).
                if (lockZoneTotal && amountChanged) {
                  const others = (["shadows", "mids", "highlights"] as const).filter(z => z !== zone);
                  const [a, b] = others;
                  const prevTotal = cur.shadows + cur.mids + cur.highlights;
                  const remaining = Math.max(0, prevTotal - next.amount);
                  const otherSum = cur[a] + cur[b];
                  let na: number, nb: number;
                  if (otherSum <= 0) { na = remaining / 2; nb = remaining / 2; }
                  else { na = (cur[a] / otherSum) * remaining; nb = remaining - na; }
                  patch[a] = Math.max(0, Math.min(200, Math.round(na)));
                  patch[b] = Math.max(0, Math.min(200, Math.round(nb)));
                }
                zonesRef.current = { ...cur, ...patch } as ZoneOpts;
                setZonesLabel(z => ({ ...z, ...patch }));
                scheduleRedraw();
              }}
            />
          </div>
        );
      })}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("envelope")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: "#dddddd", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        <span><Icon name={openSection === "envelope" ? "chevronDown" : "chevronRight"} size={11} /> Envelope <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.55 }}>(test)</span>{envelopeLabel.length > 0 && <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>· {envelopeLabel.length} pt{envelopeLabel.length === 1 ? "" : "s"} active</span>}</span>
        {openSection === "envelope" && envelopeLabel.length > 0 && (
          <span onClick={(e: any) => { e.stopPropagation(); envelopeRef.current = []; setEnvelopeLabel([]); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Clear</span>
        )}
      </div>
      {openSection === "envelope" && (
        <div style={{ padding: "2px 0" }}>
          <EnvelopeEditor
            points={envelopeLabel}
            lumaBins={lumaBins}
            onChange={pts => {
              envelopeRef.current = pts;
              setEnvelopeLabel(pts);
              scheduleRedraw();
            }}
          />
        </div>
      )}

      <BottomActionBar
        deselectOnApply={deselectOnApply} setDeselectOnApply={setDeselectOnApply}
        overwriteOnApply={overwriteOnApply} setOverwriteOnApply={setOverwriteOnApply}
        colorSpace={colorSpace} setColorSpace={setColorSpace}
        onRefreshAll={onRefreshAll}
      />

      {/* @ts-ignore Spectrum web component */}
      <sp-button variant="secondary" onClick={onApply} style={{ marginTop: 10, width: "100%" }}>Apply Curves</sp-button>

      {/* Curves graph below Apply */}
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
      <CurvesGraph curves={renderedCurves} />

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
