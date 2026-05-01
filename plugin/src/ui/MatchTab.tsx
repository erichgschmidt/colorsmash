// Color Match: fits per-channel R/G/B Curves so target's histograms match source's.
// Source = a layer in the active doc, OR a snapshot of the active marquee selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayers } from "./useLayers";
import { useLayerPreview } from "./useLayerPreview";
import { CurvesGraph } from "./CurvesGraph";
import { ZoneCompoundSlider } from "./ZoneCompoundSlider";
import { Icon } from "./Icon";
import { MatchedPreview, MatchedPreviewHandle } from "./MatchedPreview";
import { SourceSelector } from "./SourceSelector";
import { PresetStrip } from "./PresetStrip";
import { BottomActionBar } from "./BottomActionBar";
import { BasicSlider, DimSlider, matchStyles } from "./MatchSliders";
import { ChannelCurves } from "../core/histogramMatch";
import {
  processChannelCurves, applyChannelCurvesToRgba, applyChromaOnly,
  applyDimensions, applyZoneAndEnvelopeToChannels, MERGED_LAYER_ID,
  transformCurvesForPreset, applyPresetPostprocess, generateLutCube,
  DimensionOpts, DEFAULT_DIMENSIONS, ZoneOpts, DEFAULT_ZONES,
  computeLumaBins, bandMeanColor, lumaRange,
  EnvelopePoint, DEFAULT_ENVELOPE,
  fitByMode, MatchMode, Preset,
  fitMultiZoneByMode, applyMultiZoneToRgba, processMultiZoneFit, MultiZoneFit, adaptiveBandPeaks,
} from "../core/histogramMatch";
import { EnvelopeEditor } from "./EnvelopeEditor";
import { HistogramOverlay } from "./HistogramOverlay";
import { loadSettings, makeDebouncedSaver, clearSettings, PersistedSettings } from "./persistence";
import { uxpInfo } from "./uxpInfo";
import { applyMatch } from "../app/applyMatch";
import {
  app, action as psAction, readLayerPixels, executeAsModal, getActiveDoc, getSelectionBounds,
} from "../services/photoshop";
import { downsampleToMaxEdge } from "../core/downsample";

const SOURCE_MAX_EDGE = 256;
type SrcMode = "layer" | "selection" | "folder";

interface SourceSnap { width: number; height: number; data: Uint8Array; name: string; }

export function MatchTab() {
  // Stale indicator — flips true when any PS event fires (layer rename, doc switch, paint,
  // etc.). User clicks ⟳ to refresh + clear. No live polling; everything is manual.
  const [stale, setStale] = useState(false);
  // Source and target each have their own doc — fully independent. Source can come from
  // doc A while target lives in doc B. Both default to PS's active doc on first mount.
  const [srcDocId, setSrcDocId] = useState<number | null>(null);
  const [tgtDocId, setTgtDocId] = useState<number | null>(null);
  const { layers: srcLayers, refresh: refreshSrcLayers } = useLayers(srcDocId);
  const { layers: tgtLayers, refresh: refreshTgtLayers } = useLayers(tgtDocId);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const amountRef = useRef(100);
  const smoothRef = useRef(0);
  const stretchRef = useRef(8);
  const [chromaOnly, setChromaOnly] = useState(false);
  const [anchorStretchToHist, setAnchorStretchToHist] = useState(false);
  // Match mode: full-distribution (default), mean shift, median shift, or percentile-anchored.
  // Lighter modes are gentler — useful when full-histogram match feels over-aggressive.
  const [matchMode, setMatchMode] = useState<MatchMode>("full");
  // Multi-zone output (beta): emit 3 stacked Curves layers (shadow/mid/highlight) limiting
  // each to its luminance band via mask, Blend If, or both. Default off so v1.0 behavior unchanged.
  const [multiZone, setMultiZone] = useState(false);
  const [multiZoneLimit, setMultiZoneLimit] = useState<"mask" | "blendIf" | "both">("mask");
  // Adaptive bands: when on, band peaks shift to target's P10/P50/P90 luma percentiles
  // so each band gets a meaningful pixel sample. When off, fixed peaks at 0/128/255.
  const [adaptiveBands, setAdaptiveBands] = useState(true);
  // Quick-select preset — staged in the UI, applied to the matched preview live, baked
  // into PS when the user hits Apply Curves. Defaults to "color" (full match) so the
  // initial behavior matches v1.0.
  const [activePreset, setActivePreset] = useState<Preset>("color");
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
        const buf = await readLayerPixels(bg, undefined, opened.id);
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
  const [remember, setRemember] = useState(false);
  // (liveUpdates and stale state declared above, before the hooks that consume them.)

  const [openSection, setOpenSection] = useState<"basic" | "dims" | "zones" | "envelope" | null>(null);
  // Per-section enable toggles: when off, that section's params revert to defaults at apply
  // time, letting the user A/B-test the contribution of each section without losing settings.
  const [enColor, setEnColor] = useState(true);
  const [enTone, setEnTone] = useState(true);
  const [enZones, setEnZones] = useState(true);
  const [enEnvelope, setEnEnvelope] = useState(true);
  const toggleSection = (s: "basic" | "dims" | "zones" | "envelope") => setOpenSection(o => o === s ? null : s);
  // Source / target document picker — collapsible. Default open so it's visible on first
  // launch; user can collapse to recover vertical space once docs are picked.
  const [showDocs, setShowDocs] = useState(true);

  // ─── Persistence ───────────────────────────────────────────────────────────
  // Load once on mount. Always read the file so we know whether 'remember' was on
  // last session; only restore the rest of the state if it was. After load,
  // set up a debounced saver that fires on any persisted state change while
  // remember=true.
  const loadedRef = useRef(false);
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      if (!s) { loadedRef.current = true; return; }
      // Always restore the toggle itself so users don't have to re-enable it.
      setRemember(!!s.remember);
      if (s.remember) {
        if (s.amount != null) { amountRef.current = s.amount; setAmountLabel(s.amount); }
        if (s.smooth != null) { smoothRef.current = s.smooth; setSmoothLabel(s.smooth); }
        if (s.stretch != null) { stretchRef.current = s.stretch; setStretchLabel(s.stretch); }
        if (s.anchorStretchToHist != null) setAnchorStretchToHist(s.anchorStretchToHist);
        if (s.matchMode) setMatchMode(s.matchMode as MatchMode);
        // Normalize legacy "both" persisted state to "blendIf" — Mask is now implicit
        // (used whenever Blend If is off), so "both" no longer makes sense in the UI.
        if (s.multiZoneLimit === "both" || s.multiZoneLimit === "blendIf") setMultiZoneLimit("blendIf");
        else if (s.multiZoneLimit === "mask") setMultiZoneLimit("mask");
        if (s.multiZone != null) setMultiZone(s.multiZone);
        if (s.multiZoneLimit) setMultiZoneLimit(s.multiZoneLimit);
        if (s.adaptiveBands != null) setAdaptiveBands(s.adaptiveBands);
        if (s.showDocs != null) setShowDocs(s.showDocs);
        if (s.chromaOnly != null) setChromaOnly(s.chromaOnly);
        if (s.colorSpace) setColorSpace(s.colorSpace);
        if (s.deselectOnApply != null) setDeselectOnApply(s.deselectOnApply);
        if (s.overwriteOnApply != null) setOverwriteOnApply(s.overwriteOnApply);
        if (s.openSection !== undefined) setOpenSection(s.openSection);
        if (s.zones) { zonesRef.current = { ...DEFAULT_ZONES, ...s.zones }; setZonesLabel({ ...DEFAULT_ZONES, ...s.zones }); }
        if (s.lockZoneTotal != null) setLockZoneTotal(s.lockZoneTotal);
        if (s.dimensions) { dimsRef.current = { ...DEFAULT_DIMENSIONS, ...s.dimensions }; setDimsLabel({ ...DEFAULT_DIMENSIONS, ...s.dimensions }); }
        if (s.envelope && Array.isArray(s.envelope) && s.envelope.length > 0) {
          envelopeRef.current = s.envelope as EnvelopePoint[];
          setEnvelopeLabel(s.envelope as EnvelopePoint[]);
        }
      }
      loadedRef.current = true;
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDebouncedRef = useRef<((s: PersistedSettings) => void) | null>(null);
  if (!saveDebouncedRef.current) saveDebouncedRef.current = makeDebouncedSaver(500);
  useEffect(() => {
    if (!loadedRef.current) return; // skip until initial load resolves
    const snapshot: PersistedSettings = {
      remember,
      amount: amountLabel, smooth: smoothLabel, stretch: stretchLabel,
      anchorStretchToHist, chromaOnly, colorSpace, matchMode, multiZone, multiZoneLimit, adaptiveBands,
      showDocs,
      deselectOnApply, overwriteOnApply,
      openSection,
      zones: zonesLabel, lockZoneTotal,
      dimensions: dimsLabel,
      envelope: envelopeLabel,
    };
    saveDebouncedRef.current!(snapshot);
  }, [remember, matchMode, multiZone, multiZoneLimit, adaptiveBands, showDocs, amountLabel, smoothLabel, stretchLabel, anchorStretchToHist, chromaOnly,
      colorSpace, deselectOnApply, overwriteOnApply, openSection,
      zonesLabel, lockZoneTotal, dimsLabel, envelopeLabel]);

  const [docs, setDocs] = useState<{ id: number; name: string }[]>([]);
  const refreshDocsRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const readNow = () => {
      if (cancelled) return;
      try {
        const list = (app.documents ?? []).map((d: any) => ({ id: d.id, name: d.name }));
        setDocs(list);
        // Auto-pick the active doc if nothing is selected yet, or if the previously selected
        // doc has been closed. Otherwise, keep the panel selection — don't follow PS chrome.
        const pickFallback = (prev: number | null) => {
          if (prev != null && list.some((d: { id: number }) => d.id === prev)) return prev;
          return app.activeDocument?.id ?? list[0]?.id ?? null;
        };
        setSrcDocId(pickFallback);
        setTgtDocId(pickFallback);
      } catch { /* */ }
    };
    refreshDocsRef.current = readNow;
    readNow();
    // No event listeners or poll — manual mode. The stale detector below sets `stale`
    // true on any PS event so the user knows to click ⟳, which calls readNow().
    return () => { cancelled = true; };
  }, []);

  // Stale detector: listens for PS events that would normally trigger an auto-refresh and
  // just flips `stale` true so the ⟳ button can warn the user. Cleared whenever any
  // refresh runs. No polling — pure event-driven flag.
  useEffect(() => {
    const events = [
      "select", "make", "delete", "set", "open", "close", "move",
      "duplicate", "paste", "rasterizeLayer", "groupLayer", "ungroupLayer",
      "mergeLayers", "mergeVisible", "rename", "historyStateChanged", "selectDocument",
    ];
    const onEvt = () => setStale(true);
    psAction.addNotificationListener(events, onEvt);
    return () => { psAction.removeNotificationListener?.(events, onEvt); };
  }, []);

  // Combined refresh: docs list + bounce the per-side docId to fully remount useLayers.
  // Bouncing the id drops every cached layer reference (DOM-side and our own state), then
  // re-fetches via batchPlay on remount. This is the nuclear option that works even when
  // PS's internal descriptor cache holds stale names from another plugin's silent batch ops.
  const refreshSrcAll = () => {
    refreshDocsRef.current();
    refreshSrcLayers();
    const id = srcDocId;
    if (id != null) {
      setSrcDocId(null);
      setTimeout(() => setSrcDocId(id), 50);
    }
  };
  const refreshTgtAll = () => {
    refreshDocsRef.current();
    refreshTgtLayers();
    const id = tgtDocId;
    if (id != null) {
      setTgtDocId(null);
      setTimeout(() => setTgtDocId(id), 50);
    }
  };

  // Picking a doc in our dropdown is panel-only — we do NOT change PS's active document.
  // Source and target each have their own setter so they can point to different docs.
  const onSwitchSrcDoc = (id: number) => {
    if ((app.documents ?? []).find((x: any) => x.id === id)) setSrcDocId(id);
  };
  const onSwitchTgtDoc = (id: number) => {
    if ((app.documents ?? []).find((x: any) => x.id === id)) setTgtDocId(id);
  };

  // When source layers list changes (doc switch or refresh), pick a sensible default if the
  // current sourceId no longer exists in the new list. Bottom-most layer for source.
  useEffect(() => {
    if (srcLayers.length > 0 && (sourceId == null || !srcLayers.find(l => l.id === sourceId))) {
      setSourceId(srcLayers[srcLayers.length - 1].id);
    }
  }, [srcLayers]); // eslint-disable-line react-hooks/exhaustive-deps
  // Same for target layers — top-most layer for target.
  useEffect(() => {
    if (tgtLayers.length > 0 && (targetId == null || !tgtLayers.find(l => l.id === targetId))) {
      setTargetId(tgtLayers[0].id);
    }
  }, [tgtLayers]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = useLayerPreview(srcDocId, srcMode === "layer" ? sourceId : null);
  const tgt = useLayerPreview(tgtDocId, targetId);
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
        buf = await readLayerPixels(layer, sel, doc.id);
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
    return fitByMode(matchMode, srcSnap.data, tgt.snap.data, colorSpace);
  }, [srcSnap, tgt.snap, colorSpace, matchMode]);

  // Multi-zone band peaks. Adaptive (P10/P50/P90 of target luma) when toggle is on,
  // fixed at 0/128/255 otherwise. Adaptive peaks make each band fit on a similar
  // pixel-count sample, producing more reliable shadow + highlight curves on images
  // with concentrated histograms.

  // Luma-binned color stats from target pixels — used to color the zone band swatches with the
  // actual mean color of pixels at each luminance level. Recomputed only when target pixels change.
  const lumaBins = useMemo(() => tgt.snap ? computeLumaBins(tgt.snap.data) : null, [tgt.snap]);
  const sourceLumaBins = useMemo(() => srcSnap ? computeLumaBins(srcSnap.data) : null, [srcSnap]);

  const multiZonePeaks = useMemo(() => {
    if (!adaptiveBands || !lumaBins) return { shadow: 0, mid: 128, highlight: 255 };
    return adaptiveBandPeaks(lumaBins);
  }, [adaptiveBands, lumaBins]);

  // Outer extents for multi-zone bands. When adaptive, derived from the target's actual
  // luma range (lumaRange) — pixels outside this range get zero band application and pass
  // through unchanged. Slider positions in PS Blend If panel match these extents so the
  // visualization is honest about where the bands actually have effect.
  const multiZoneExtents = useMemo(() => {
    if (!adaptiveBands || !lumaBins) return { min: 0, max: 255 };
    const r = lumaRange(lumaBins);
    return { min: r.start, max: r.end };
  }, [adaptiveBands, lumaBins]);

  // Multi-zone fit: 3 separate per-band curves. Computed only when the multi-zone toggle
  // is on (otherwise null).
  const fittedMulti = useMemo<MultiZoneFit | null>(() => {
    if (!multiZone || !srcSnap || !tgt.snap) return null;
    return fitMultiZoneByMode(matchMode, srcSnap.data, tgt.snap.data, multiZonePeaks, multiZoneExtents);
  }, [multiZone, srcSnap, tgt.snap, multiZonePeaks, multiZoneExtents, matchMode]);

  // Matched preview is rendered by <MatchedPreview/>; we drive it imperatively via a handle.
  const matchedHandleRef = useRef<MatchedPreviewHandle | null>(null);
  const rafPendingRef = useRef(false);
  const [renderedCurves, setRenderedCurves] = useState<ChannelCurves | null>(null);
  // Result pixels captured at the end of each redraw — feeds the diagnostic histogram overlay.
  // Throttled (only commits to state every ~150ms) so we don't thrash React during slider drags.
  const [resultPixels, setResultPixels] = useState<Uint8Array | null>(null);
  const resultTimeoutRef = useRef<any>(null);
  const resultPendingRef = useRef<Uint8Array | null>(null);
  const curvesPendingRef = useRef<ChannelCurves | null>(null);
  const curvesTimeoutRef = useRef<any>(null);

  const redrawMatched = () => {
    if (!tgt.snap || !fittedRaw) return;
    // Handle ref may not be bound yet on first render — retry shortly.
    if (!matchedHandleRef.current) {
      setTimeout(() => redrawMatched(), 100);
      return;
    }
    // Section-enable: when a section is disabled, its params revert to defaults so the
    // user can see what the match would look like without that section's contribution.
    const stretchRange = enColor && anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined;
    const curveOpts = enColor ? {
      amount: amountRef.current / 100,
      smoothRadius: smoothRef.current,
      maxStretch: stretchRef.current,
      stretchRange,
    } : { amount: 1, smoothRadius: 0, maxStretch: 999 };
    const dimOpts = enTone ? dimsRef.current : DEFAULT_DIMENSIONS;

    let out: Uint8Array;
    let curvesForGraph: ChannelCurves;

    if (multiZone && fittedMulti) {
      // Multi-zone path: process each band's curves through Color + Tone, simulate the
      // 3-curve composite via triangular blend (matches what PS will produce on apply).
      // Skip Zones + Envelope — they're zone-modulators that would double-apply over the bands.
      const procFit = processMultiZoneFit(fittedMulti, curveOpts, dimOpts);
      out = applyMultiZoneToRgba(tgt.snap.data, procFit, multiZonePeaks, multiZoneExtents);
      // Curves graph shows the mid-band curve as representative (graph doesn't render 3 sets).
      curvesForGraph = procFit.mid;
    } else {
      // Single-curve path (default).
      const processed = processChannelCurves(fittedRaw, curveOpts);
      const dim = applyDimensions(processed, dimOpts);
      curvesForGraph = applyZoneAndEnvelopeToChannels(
        dim,
        enZones ? zonesRef.current : DEFAULT_ZONES,
        enEnvelope ? envelopeRef.current : DEFAULT_ENVELOPE,
      );
      out = applyChannelCurvesToRgba(tgt.snap.data, curvesForGraph);
    }

    curvesPendingRef.current = curvesForGraph;
    if (!curvesTimeoutRef.current) {
      curvesTimeoutRef.current = setTimeout(() => {
        curvesTimeoutRef.current = null;
        if (curvesPendingRef.current) setRenderedCurves(curvesPendingRef.current);
      }, 100);
    }
    if (enColor && chromaOnly) out = applyChromaOnly(tgt.snap.data, out);
    // Apply staged preset on top of everything else. Preset takes precedence: if it's
    // "color" it's a no-op; otherwise we transform the curves (avg for bw/contrast),
    // remap the target, then post-process (grayscale clamp, luma swap, etc.) so the
    // matched preview reflects exactly what Apply Curves will bake into PS.
    if (activePreset !== "color" && curvesForGraph) {
      const cP = transformCurvesForPreset(curvesForGraph, activePreset);
      const mapped = applyChannelCurvesToRgba(tgt.snap.data, cP);
      out = applyPresetPostprocess(tgt.snap.data, mapped, activePreset);
    }
    matchedHandleRef.current.setPixels(out, tgt.snap.width, tgt.snap.height);
    // Also push the unmodified target pixels so the preview's Before/After badge
    // can swap to the original on click/hold without a round-trip to the parent.
    matchedHandleRef.current.setBefore(tgt.snap.data, tgt.snap.width, tgt.snap.height);
    // Throttle result-pixel state updates so the diagnostic histogram doesn't re-render
    // on every slider tick — every ~150ms is plenty fast visually, and avoids React thrash.
    resultPendingRef.current = out;
    if (!resultTimeoutRef.current) {
      resultTimeoutRef.current = setTimeout(() => {
        resultTimeoutRef.current = null;
        if (resultPendingRef.current) setResultPixels(resultPendingRef.current);
      }, 150);
    }
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
  }, [fittedRaw, fittedMulti, multiZone, multiZonePeaks, multiZoneExtents, tgt.snap, chromaOnly, anchorStretchToHist, enColor, enTone, enZones, enEnvelope, activePreset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Export the staged preset as a 33-grid 3D LUT in .CUBE format. Sidesteps the
  // unreliable PS Color Lookup API entirely — user picks a save location, we write
  // the file, they load it manually wherever they want (PS Color Lookup layer,
  // Premiere, Resolve, another tool). The LUT bakes the full preset behavior
  // including Color/Luminosity blend emulation that a Curves layer alone can't
  // express, so the file is a complete, portable representation of the look.
  const onExportLut = async () => {
    const curves = renderedCurves;
    if (!curves) { setStatus("Compute a match first."); return; }
    setStatus("Exporting LUT...");
    try {
      const uxp = require("uxp");
      const presetLabel = activePreset === "color" ? "full" : activePreset === "hue" ? "color" : "contrast";
      const file = await uxp.storage.localFileSystem.getFileForSaving(`color-smash-${presetLabel}.cube`, { types: ["cube"] });
      if (!file) { setStatus("Export cancelled."); return; }
      const cube = generateLutCube(curves, activePreset, 33, "Color Smash");
      await file.write(cube, { format: uxp.storage.formats.utf8 });
      setStatus(`Exported ${file.name} (33³ LUT, ${presetLabel}).`);
    } catch (e: any) { setStatus(`LUT export error: ${e?.message ?? e}`); }
  };

  const onApply = async () => {
    if (targetId == null) { setStatus("Pick target layer."); return; }
    if (srcMode === "layer" && sourceId == null) { setStatus("Pick source layer."); return; }
    if (srcMode === "selection" && !srcOverride) { setStatus("Snap a selection first."); return; }
    setStatus("Applying match...");
    try {
      if (srcDocId == null || tgtDocId == null) { setStatus("Pick source + target docs."); return; }
      setStatus(await applyMatch({
        srcDocId, tgtDocId,
        sourceLayerId: sourceId ?? -1,
        targetLayerId: targetId,
        matchMode,
        multiZone,
        multiZoneLimit,
        multiZonePeaks,
        multiZoneExtents,
        // Section-enable mirror — disabled sections apply with default params.
        amount: enColor ? amountRef.current / 100 : 1,
        smoothRadius: enColor ? smoothRef.current : 0,
        maxStretch: enColor ? stretchRef.current : 999,
        stretchRange: enColor && anchorStretchToHist && lumaBins ? lumaRange(lumaBins) : undefined,
        chromaOnly: enColor && chromaOnly,
        dimensions: enTone ? dimsRef.current : DEFAULT_DIMENSIONS,
        zones: enZones ? zonesRef.current : DEFAULT_ZONES,
        envelope: enEnvelope ? envelopeRef.current : DEFAULT_ENVELOPE,
        sourcePixelsOverride: srcOverride?.data,
        sourceLabel: srcOverride?.name,
        colorSpace,
        deselectFirst: deselectOnApply,
        overwritePrior: overwriteOnApply,
        preset: activePreset,
      }));
    } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
  };

  const sel = matchStyles.sel;
  const tinyBtn = matchStyles.tinyBtn;

  // Full reset: every persisted setting back to its default + delete the saved file.
  // Triggered by the red ✕ in the bottom bar.
  const onResetAll = () => {
    amountRef.current = 100; setAmountLabel(100);
    smoothRef.current = 0;   setSmoothLabel(0);
    stretchRef.current = 8;  setStretchLabel(8);
    setAnchorStretchToHist(false);
    setChromaOnly(false);
    setMatchMode("full");
    setMultiZone(false);
    setMultiZoneLimit("mask");
    setAdaptiveBands(true);
    setColorSpace(() => "rgb");
    setDeselectOnApply(true);
    setOverwriteOnApply(true);
    setOpenSection(null);
    zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES });
    setLockZoneTotal(false);
    dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS });
    envelopeRef.current = [...DEFAULT_ENVELOPE]; setEnvelopeLabel([...DEFAULT_ENVELOPE]);
    setRemember(false);
    void clearSettings();
    scheduleRedraw();
    setStatus("Settings reset to defaults.");
  };

  const onRefreshAll = async () => {
    setStale(false);
    refreshSrcLayers();
    refreshTgtLayers();
    src.refresh();
    tgt.refresh();
    if (srcMode === "selection" && srcOverride) {
      try { setSrcOverride(await snapshotSelectionInner()); } catch (e: any) { setStatus(`Error: ${e?.message ?? e}`); }
    }
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Documents section — collapsible header matching the other section headers */}
      <div onClick={() => setShowDocs(s => !s)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: "#dddddd", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name={showDocs ? "chevronDown" : "chevronRight"} size={11} /> Source
        </span>
      </div>
      {/* Source picker — full width, doc dropdown + dense layer list + thumbnail right.
          Target lives below (above the preview) and reuses the preview itself for its
          visual feedback, so the target column no longer needs its own thumbnail. */}
      {showDocs && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <SourceSelector
            docs={docs} activeDocId={srcDocId} srcMode={srcMode} browsedFile={browsedFile}
            onSwitchDoc={onSwitchSrcDoc} onSwitchSrcMode={switchSrcMode}
            setBrowsedFile={setBrowsedFile} onBrowseImage={onBrowseImage}
            layers={srcLayers} sourceId={sourceId} setSourceId={setSourceId}
            autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate}
            sampleMerged={sampleMerged} setSampleMerged={setSampleMerged}
            sampleLock={sampleLock} setSampleLock={setSampleLock}
            selStyle={sel}
            onRefreshLayers={refreshSrcAll}
            // PresetStrip replaces the source thumbnail: 1x4 row of source-facet
            // swatches (Color / Hue / B&W / Contrast). Click to STAGE that preset —
            // the matched preview pane below updates live; nothing is written to PS
            // until Apply Curves. The strip is non-destructive on its own.
            thumbnail={
              <PresetStrip
                srcRgba={srcSnap?.data ?? null}
                srcWidth={srcSnap?.width ?? 0}
                srcHeight={srcSnap?.height ?? 0}
                active={activePreset}
                onSelect={setActivePreset}
              />
            }
          />
        </div>
      )}

      {/* Target selector — single horizontal row directly above the matched preview:
          [doc dropdown] [layer dropdown] [refresh]. Kept compact (no list, no thumbnail)
          because the preview pane itself shows the target via the Before/After badge. */}
      <div style={{ marginTop: 6, display: "flex", gap: 4, alignItems: "center" }}>
        <select style={{ ...sel, flex: 1, minWidth: 0 }} value={tgtDocId ?? ""} onChange={e => onSwitchTgtDoc(Number(e.target.value))}
          title="Target document — where the new Curves layer will land. Independent of the source doc.">
          {docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select style={{ ...sel, flex: 1, minWidth: 0 }} value={targetId ?? ""} onChange={e => setTargetId(Number(e.target.value))}
          title="Target layer — the layer the Curves adjustment will be clipped to.">
          {tgtLayers.length === 0 && <option value="">— none —</option>}
          {tgtLayers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          <option value={MERGED_LAYER_ID}>Merged</option>
        </select>
        <div onClick={refreshTgtAll} title="Refresh target document + layer list"
          style={{ width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid #888", borderRadius: 2, color: "#ddd", fontSize: 16, userSelect: "none", boxSizing: "border-box", flexShrink: 0 }}>
          <span style={{ marginTop: -3, marginLeft: 1, lineHeight: 1 }}>⟳</span>
        </div>
      </div>

      {/* Matched preview (full-width, large) with zoom controls + Before/After badge */}
      <MatchedPreview ref={matchedHandleRef} />

      {/* Diagnostic histogram strip — overlays target / source / result luma distributions */}
      <HistogramOverlay
        targetData={tgt.snap?.data ?? null}
        sourceData={srcSnap?.data ?? null}
        resultData={resultPixels}
      />

      {/* Accordion controls */}
      <div style={{ borderTop: "1px solid #444", margin: "6px 0 0" }} />
      <div onClick={() => toggleSection("basic")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enColor ? "#dddddd" : "#888", fontStyle: enColor ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnColor(!enColor); }}
            title={enColor ? "Color section ENABLED — click to disable (revert all Color params to defaults)" : "Color section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enColor ? "#5fd16a" : "#555",
                     border: enColor ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
          <Icon name={openSection === "basic" ? "chevronDown" : "chevronRight"} size={11} /> Color
        </span>
        <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Color — what each control does", [
          { heading: "Section purpose",
            body: "Shapes the per-channel R/G/B match curves before they're combined and output. These controls operate on the raw fitted curves: blending strength, smoothing, slope cap, and the Hue-only blend mode for the final layer." },
          { heading: "Amount",
            body: "Strength of the histogram match, 0–100%. Blends the matched curve with identity. 100% = full match. 50% = half-strength match. 0% = no match (identity curves)." },
          { heading: "Smooth",
            body: "Box-filter smoothing radius applied to the curves after blending, 0–32. Higher values average over a wider window — useful when the source histogram is sparse or noisy. 0 = no smoothing. Mild values (4–8) typically clean things up without losing tonal detail." },
          { heading: "Stretch",
            body: "Local slope cap. Limits how steep adjacent curve points can rise or fall. 1 = hard cap (slope ≤ 1 per step) — heavily flattens any aggressive contrast. 15 = essentially uncapped. Most visible changes happen in the 1–8 range." },
          { heading: "Anchor stretch to histogram range",
            body: "Toggle. When on, the slope cap walks from where the target image's data actually starts/ends (≥0.5% of peak count) instead of always 0–255. Makes Stretch behave consistently across bright vs dark sources." },
          { heading: "Hue only",
            body: "Toggle. Sets the output Curves layer to Photoshop's Hue blend mode (instead of Normal). Result: only the hue shifts toward the source; target's saturation and luminance are preserved. Sidesteps the saturation inflation that per-channel curves naturally produce." },
        ]); }}
          title="What this section does — full explanation"
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
      </div>
      {openSection === "basic" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            <span style={{ opacity: 0.75, flexShrink: 0 }}>Mode</span>
            <select value={matchMode} onChange={e => { setMatchMode(e.target.value as MatchMode); scheduleRedraw(); }}
              title="Match algorithm. Full = match the whole histogram (default, most aggressive). Mean/Median = just shift color cast (subtle). Percentile = anchor a few percentile points (middle ground)."
              style={{ ...sel, flex: 1, height: 22 }}>
              <option value="full">Full distribution</option>
              <option value="percentile">Percentile anchors</option>
              <option value="median">Median shift</option>
              <option value="mean">Mean shift</option>
            </select>
          </div>
          <BasicSlider label="Amount"  refObj={amountRef}  value={amountLabel}  setValue={setAmountLabel}  min={0} max={100} suffix="%" defaultVal={100} scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Smooth"  refObj={smoothRef}  value={smoothLabel}  setValue={setSmoothLabel}  min={0} max={32}  defaultVal={0}   scheduleRedraw={scheduleRedraw} />
          <BasicSlider label="Stretch" refObj={stretchRef} value={stretchLabel} setValue={setStretchLabel} min={1} max={15}  defaultVal={8}   scheduleRedraw={scheduleRedraw} step={0.1} />
          <label title="Anchor the slope cap at the target's actual histogram bounds instead of 0/255 — makes Stretch behave consistently regardless of whether the source is bright or dark"
            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, opacity: 0.85, cursor: "pointer", marginLeft: 4 }}>
            <input type="checkbox" checked={anchorStretchToHist} onChange={e => { setAnchorStretchToHist(e.target.checked); scheduleRedraw(); }} style={{ cursor: "pointer", margin: 0 }} />
            Anchor stretch to histogram range
          </label>
          {/* @ts-ignore Spectrum web component */}
          <sp-checkbox checked={chromaOnly || undefined} onInput={(e: any) => setChromaOnly(e.target.checked)} style={{ marginTop: 4, fontSize: 11 }}
            title="Apply only the hue shift; preserve target's saturation and luminance. Uses PS Hue blend mode — sidesteps the saturation inflation that per-channel curves cause.">
            Hue only (preserve target saturation + luminance)
          {/* @ts-ignore */}
          </sp-checkbox>
        </div>
      )}

      <div style={{ borderTop: "1px solid #444" }} />
      <div onClick={() => toggleSection("dims")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enTone ? "#dddddd" : "#888", fontStyle: enTone ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnTone(!enTone); }}
            title={enTone ? "Tone section ENABLED — click to disable" : "Tone section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enTone ? "#5fd16a" : "#555",
                     border: enTone ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
          <Icon name={openSection === "dims" ? "chevronDown" : "chevronRight"} size={11} /> Tone
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "dims" && <span onClick={(e: any) => { e.stopPropagation(); dimsRef.current = { ...DEFAULT_DIMENSIONS }; setDimsLabel({ ...DEFAULT_DIMENSIONS }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Tone — what each control does", [
            { heading: "Section purpose",
              body: "Reshapes the matched curves along perceptual axes after they're fit. Lets you scale luminance, push or pull saturation, rotate hue, adjust contrast, neutralize color casts, and separate the per-channel response — all without re-fitting." },
            { heading: "Value",
              body: "Scales overall luminance contribution of the match, 0–200%. 100% = pass-through. <100% reduces tonal change. >100% amplifies it." },
            { heading: "Chroma",
              body: "Scales chroma (saturation) contribution, 0–200%. 100% = pass-through. 0% removes saturation changes. 200% doubles the saturation pull toward source." },
            { heading: "Hue",
              body: "Rotates hue of the match output, -180 to +180 degrees. 0 = no rotation. Useful for shifting matched color toward a complementary palette without re-fitting." },
            { heading: "Contrast",
              body: "Scales contrast, 0–200%. 100% = pass-through. <100% flattens. >100% pushes harder." },
            { heading: "Neutralize",
              body: "Pulls the match toward neutral gray, 0–100%. 0% = no neutralization. 100% = fully gray. Useful for taming an over-aggressive color cast while keeping the tonal shaping." },
            { heading: "Separation",
              body: "How independently R/G/B channels respond, 0–200%. 100% = pass-through. <100% blends channels (more neutral). >100% exaggerates differences between channels." },
            { heading: "Reset (header)",
              body: "Restores all six Tone sliders to defaults. Section enable/disable state stays as-is." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
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
      <div onClick={() => toggleSection("zones")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enZones ? "#dddddd" : "#888", fontStyle: enZones ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnZones(!enZones); }}
            title={enZones ? "Zones section ENABLED — click to disable" : "Zones section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enZones ? "#5fd16a" : "#555",
                     border: enZones ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
          <Icon name={openSection === "zones" ? "chevronDown" : "chevronRight"} size={11} /> Zones
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "zones" && (
            <>
              <label onClick={(e: any) => e.stopPropagation()} title="Lock total: when one amount changes, the other two rebalance proportionally to preserve the sum"
                style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 400, opacity: 0.85, cursor: "pointer" }}>
                <input type="checkbox" checked={lockZoneTotal} onChange={e => setLockZoneTotal(e.target.checked)}
                  style={{ cursor: "pointer", margin: 0 }} />
                Lock total
              </label>
              <span onClick={(e: any) => { e.stopPropagation(); zonesRef.current = { ...DEFAULT_ZONES }; setZonesLabel({ ...DEFAULT_ZONES }); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>
            </>
          )}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Zones — what each control does", [
            { heading: "What zones do",
              body: "Modulate how strongly the histogram match applies across input tones. Each zone (shadows / midtones / highlights) is a Gaussian bump centered on its anchor. With all amounts at 100% and biases at 0, the match runs full-strength and zones have no effect." },
            { heading: "Track (the gradient slider)",
              body: "Visualizes the zone's footprint over the 0–255 input range. The colored band is where the zone is active. Center thumb = anchor; edge thumbs = falloff." },
            { heading: "Anchor",
              body: "Where the zone is centered along the input axis (0 = pure black, 255 = pure white). Drag the center thumb." },
            { heading: "Falloff",
              body: "How wide the zone extends from its anchor. Drag either edge thumb in/out for a narrower/broader zone. Symmetric around the anchor." },
            { heading: "Amount",
              body: "Strength of the zone's contribution, 0–200%. 100% = standard. 0% = fully suppress the match in that range. 200% = doubles local pull. The wide slider to the right of the track." },
            { heading: "Bias",
              body: "Competitive pressure against neighboring zones at overlap regions. Positive bias makes this zone dominate the partition where it overlaps another — like 'grow this range' in Color Range. 0 = neutral, default 0 is identical to no bias." },
            { heading: "Lock total (header)",
              body: "When on, dragging one zone's amount slider proportionally rebalances the other two to preserve their sum. Shifts weight between shadows/mids/highlights without changing total match strength." },
            { heading: "Sampled swatch colors",
              body: "The colored band on each track is sampled from the target image's actual pixels in that zone's input range. Updates in real time as you move anchors and falloff." },
            { heading: "Reset (header)",
              body: "Restores all zone settings (amounts, anchors, falloffs, biases) to defaults. Lock total stays as-is." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
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
      <div onClick={() => toggleSection("envelope")} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 12, fontWeight: 700, color: enEnvelope ? "#dddddd" : "#888", fontStyle: enEnvelope ? "normal" : "italic" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span onClick={(e: any) => { e.stopPropagation(); setEnEnvelope(!enEnvelope); }}
            title={enEnvelope ? "Envelope section ENABLED — click to disable" : "Envelope section DISABLED — click to enable"}
            style={{ width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                     background: enEnvelope ? "#5fd16a" : "#555",
                     border: enEnvelope ? "1px solid #2d8a36" : "1px solid #333",
                     cursor: "pointer" }} />
          <Icon name={openSection === "envelope" ? "chevronDown" : "chevronRight"} size={11} /> Envelope{envelopeLabel.length > 0 && <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>· {envelopeLabel.length} pt{envelopeLabel.length === 1 ? "" : "s"}</span>}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {openSection === "envelope" && (
            <span onClick={(e: any) => { e.stopPropagation(); const def = [...DEFAULT_ENVELOPE]; envelopeRef.current = def; setEnvelopeLabel(def); scheduleRedraw(); }} style={{ ...tinyBtn, padding: "1px 6px" }}>Reset</span>
          )}
          <span onClick={(e: any) => { e.stopPropagation(); void uxpInfo("Envelope — what each control does", [
            { heading: "What the envelope does",
              body: "Arbitrary-N piecewise weight curve over input range 0–255. Modulates how strongly the match applies at each tonal value. Composes multiplicatively with Zones — fine-grained per-tone weight on top of the broader zone shaping. Default = three identity-weight points (no-op until moved)." },
            { heading: "Track + reference line",
              body: "X = input tone (0 left, 255 right). Y = weight 0 (bottom, suppress match) to 2 (top, double match). Gray bars = target luma histogram. Colored polyline = source histogram (gap the match is closing). Mid-line at weight=1 = identity." },
            { heading: "Adding a point",
              body: "Click any empty area of the track. A new smooth point appears and immediately enters drag mode — drop it where you want." },
            { heading: "Moving a point",
              body: "Drag any handle. Shift = lock horizontal (vertical-only). Ctrl/Cmd = lock vertical (horizontal-only)." },
            { heading: "Smooth vs corner points",
              body: "Alt-click a handle to toggle. Smooth = filled circle (●), uses monotone cubic Hermite (no overshoot). Corner = square (■), uses linear interpolation. Mix freely: sharp shadow rolloff + smooth midtones + hard highlight cap." },
            { heading: "Removing a point",
              body: "Double-click, right-click, OR click-to-select then press Delete/Backspace. Selected handles render cyan with white border. Escape clears selection." },
            { heading: "Reset (header)",
              body: "Restores the three default identity-weight points (positions 0, 127, 255 all at weight 1.0)." },
          ]); }}
            title="What this section does — full explanation"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #888", color: "#aaa", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>i</span>
        </span>
      </div>
      {openSection === "envelope" && (
        <div style={{ padding: "2px 0" }}>
          <EnvelopeEditor
            points={envelopeLabel}
            lumaBins={lumaBins}
            sourceLumaBins={sourceLumaBins}
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
        remember={remember} setRemember={setRemember}
        colorSpace={colorSpace} setColorSpace={setColorSpace}
        onRefreshAll={onRefreshAll}
        onResetAll={onResetAll}
        stale={stale}
      />

      {/* Single row: [☐ Multi] [☐ Mask] [☐ Blend If] [☐ Adaptive]. Same pattern as the
          bottom action bar — checkboxes flex-shrink:0 (always visible + clickable),
          text spans flex-shrink:1 with overflow:hidden + no ellipsis (silently clip
          under adjacent toggles when the panel narrows). Sub-toggles grayed when Multi
          is off. */}
      {(() => {
        const subDisabled = !multiZone;
        // Cell bases match BottomActionBar so checkboxes align with the buttons below:
        // Multi↔Deselect, Blend If↔Replace, Adaptive↔Save, ?-info↔✕ (the reset button).
        const cell = (basis: number): React.CSSProperties => ({
          display: "inline-flex", alignItems: "center", gap: 3,
          flex: `0 1 ${basis}px`, minWidth: 0, overflow: "hidden",
          // Belt-and-suspenders: keep the cell from ever growing beyond its basis (so
          // wide panels don't push later cells out of column alignment) and from
          // wrapping its label text.
          maxWidth: `${basis}px`, whiteSpace: "nowrap",
        });
        const cbStyle: React.CSSProperties = { margin: 0, flexShrink: 0, cursor: subDisabled ? "default" : "pointer" };
        const txt: React.CSSProperties = { overflow: "hidden", whiteSpace: "nowrap", minWidth: 0 };
        const subTxt: React.CSSProperties = { ...txt, opacity: subDisabled ? 0.5 : 1 };
        return (
          // flexWrap: nowrap is the default but we set it explicitly so a narrow panel
          // can never push a cell to a new row — the label text inside each cell clips
          // silently behind the next checkbox instead (the "compressed accordion" feel).
          <div style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", marginTop: 8, fontSize: 11, color: multiZone ? "#dddddd" : "#aaaaaa", height: 18, overflow: "hidden", gap: 0 }}>
            <label style={{ ...cell(70), cursor: "pointer" }}
              title="Multi: emit 3 stacked Curves layers (shadows / mids / highlights), each limited to its luminance band. Adapts spatially across mixed-lighting scenes.">
              <input type="checkbox" checked={multiZone} onChange={e => setMultiZone(e.target.checked)}
                style={{ margin: 0, flexShrink: 0, cursor: "pointer" }} />
              <span style={txt}>Multi</span>
            </label>
            <label style={{ ...cell(65), cursor: subDisabled ? "default" : "pointer" }}
              title="Blend If: limit each band layer with the underlying-luma sliders (Layer Style → Blending Options) instead of a luminosity mask. When OFF, a paintable mask is exported instead. May not work in all PS versions.">
              <input type="checkbox" disabled={subDisabled}
                checked={multiZoneLimit === "blendIf"}
                onChange={e => setMultiZoneLimit(e.target.checked ? "blendIf" : "mask")}
                style={cbStyle} />
              <span style={subTxt}>Blend If</span>
            </label>
            <label style={{ ...cell(65), cursor: subDisabled ? "default" : "pointer" }}
              title={`Adaptive: shift band peaks + extents to the target histogram's percentiles (P10/P50/P90) instead of fixed 0/128/255. ${multiZone && lumaBins ? `Current peaks: ${multiZonePeaks.shadow}/${multiZonePeaks.mid}/${multiZonePeaks.highlight}` : ""}`}>
              <input type="checkbox" disabled={subDisabled} checked={adaptiveBands}
                onChange={e => setAdaptiveBands(e.target.checked)}
                style={cbStyle} />
              <span style={subTxt}>Adaptive</span>
            </label>
            {/* Trailing slot — aligns with the ✕ reset button below. Holds the (?) info
                icon for the multi-zone feature explanation. flex-shrink:0 so it never
                disappears even when the row is heavily compressed. */}
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
              <span onClick={(e: any) => { e.stopPropagation(); e.preventDefault(); void uxpInfo("Multi-zone Curves — what each toggle does", [
                { heading: "Multi",
                  body: "Apply emits three stacked Curves layers (Shadows, Mids, Highlights) instead of one. Each curve is fitted from ONLY the pixels whose luma falls in its band. The three layers land in the [Color Smash] group, clipped to the target, and stay independently editable in Photoshop afterwards. Useful for mixed-lighting scenes where a single global curve over- or under-corrects." },
                { heading: "Band limiting (default = Mask)",
                  body: "By default each band layer gets a paintable luminosity layer mask — visible thumbnail in the Layers panel, fully editable (paint to localize, blur to feather). This is the cleanest separation and what you want most of the time." },
                { heading: "Blend If toggle",
                  body: "Turn ON to use the underlying-luma sliders (Layer Style → Blending Options) instead of a mask. Lighter than a mask (no mask data) and editable from the Blending Options dialog. Mutually exclusive with the mask — turning Blend If on disables mask export. May not work reliably in all Photoshop versions." },
                { heading: "Adaptive",
                  body: "When ON, the band peaks shift to the target histogram's P10 / P50 / P90 luma percentiles, and the outer extents follow the histogram's actual min/max — so each band gets a meaningful pixel sample even on low-key or high-key images. When OFF, peaks are fixed at 0 / 128 / 255. Default ON; turn off only when you want a strict 0/128/255 partition for a specific look." },
                { heading: "Replace",
                  body: "When Replace is on, re-applying overwrites the prior multi-zone trio rather than stacking another set on top." },
                { heading: "Export LUT (next to Apply)",
                  body: "Bakes the currently STAGED preset (Full / Color / Contrast — the swatch you clicked above the preview) into a 33³ Adobe .CUBE 3D LUT and writes it to a path you pick. The LUT captures the full preset including non-separable Color and Luminosity blend math that a plain Curves layer cannot represent. Loadable in Photoshop's Color Lookup layer, Premiere, Resolve, or any LUT-aware host. Use this when you want a portable look you can apply outside this plugin or share between docs/projects. Note: Export LUT bakes the staged single-curve preset; multi-zone output is Apply Curves only." },
              ]); }}
                title="What does Multi do? Click for details."
                style={{ marginLeft: 6, cursor: "help", fontSize: 10, opacity: 0.7, flexShrink: 0,
                         border: "1px solid #888", borderRadius: 8, width: 12, height: 12,
                         display: "inline-flex", alignItems: "center", justifyContent: "center",
                         lineHeight: 1, userSelect: "none" }}>?</span>
            </span>
          </div>
        );
      })()}
      {/* Apply (writes Curves layer to PS) and Export LUT (writes .CUBE to disk).
          50/50 split. flexWrap:nowrap + overflow:hidden + minWidth:0 on each cell
          guarantees the row stays single-line at any panel width — labels clip
          silently inside their own button instead of wrapping the buttons to two
          rows. Sp-button's internal text gets nowrap + overflow:hidden too. */}
      <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginTop: 6, width: "100%" }}>
        {/* @ts-ignore Spectrum web component */}
        <sp-button variant="secondary" onClick={onApply}
          style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}
          title={multiZone
            ? "Multi: creates 3 stacked Curves layers (shadow/mid/highlight) with band limiting via mask and/or Blend If. Each editable independently in PS."
            : "Create a new Curves adjustment layer in the target document, clipped to the target layer. Honors Replace and Deselect toggles below."}>{multiZone ? "Apply Multi Curves" : "Apply Curves"}</sp-button>
        {/* @ts-ignore Spectrum web component */}
        <sp-button variant="secondary" onClick={onExportLut}
          style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}
          title="Export the staged preset as a portable 33³ .CUBE 3D LUT. Loadable in Photoshop (Color Lookup layer), Premiere, Resolve, etc. The LUT bakes the full preset including Color/Luminosity blend behavior that a plain Curves layer can't express.">Export LUT</sp-button>
      </div>

      {/* Curves graph below Apply */}
      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>Fitted curves (R G B)</div>
      <CurvesGraph curves={renderedCurves} />

      <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7, whiteSpace: "pre-wrap" }}>{status}</div>
    </div>
  );
}
