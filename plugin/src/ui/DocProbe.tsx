// Diagnostic-only probe for document rename / Save As staleness investigation.
// READ-ONLY. Never writes srcDocId, tgtDocId, srcMode, targetId, layer state, or
// anything else outside its own internal ring buffer. Logs every name-shaped value
// across every API surface so we can see which (if any) source updates after Save As
// before the panel is reopened.
//
// Triggers a probe on:
//   • PS notifications: save, rename, set, selectDocument, open, close
//   • Manual "Probe now" button
//
// Renders the last N probes as a scrolling text block. User copies the trace and
// shares it back so we can see what PS actually returns vs. what should be there.

import { useEffect, useRef, useState } from "react";
import { app, action as psAction } from "../services/photoshop";

const RING_SIZE = 12;

interface DocReading {
  // Index in the enumerated list at probe time.
  ord: number;
  // app.documents[i] DOM-wrapper read (likely cached).
  domId: number | string | null;
  domName: string | null;
  domTitle: string | null;
  // batchPlay enumeration by ordinal _index (1-based).
  bpIndexId: number | string | null;
  bpIndexTitle: string | null;
  bpIndexName: string | null;
  bpIndexFileRef: string | null;
  // batchPlay get by _id (uses the DOM-side id).
  bpIdTitle: string | null;
  bpIdName: string | null;
  bpIdFileRef: string | null;
}

interface ProbeRecord {
  ts: string;        // local timestamp HH:MM:SS.mmm
  trigger: string;   // event name or "manual" / "mount"
  activeId: number | string | null;
  count: number;     // numberOfDocuments via batchPlay
  domCount: number;  // app.documents.length
  readings: DocReading[];
}

const fmtTs = () => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const basename = (p: any): string | null => {
  const s = typeof p === "string" ? p : (p?._path ?? null);
  if (typeof s !== "string") return null;
  const seg = s.replace(/\\/g, "/").split("/").pop();
  return seg || null;
};

async function runProbe(trigger: string): Promise<ProbeRecord> {
  const ts = fmtTs();
  const activeId = (() => { try { return app.activeDocument?.id ?? null; } catch { return null; } })();

  // 1. DOM enumeration
  const dom: any[] = (() => { try { return Array.from(app.documents ?? []); } catch { return []; } })();
  const domCount = dom.length;

  // 2. batchPlay numberOfDocuments + enumeration by _index
  let bpCount = 0;
  let byIndex: any[] = [];
  try {
    const cnt = await psAction.batchPlay(
      [{ _obj: "get", _target: [{ _property: "numberOfDocuments" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }] }],
      { synchronousExecution: false } as any
    );
    bpCount = cnt[0]?.numberOfDocuments ?? 0;
    if (bpCount > 0) {
      const queries = Array.from({ length: bpCount }, (_, i) => ({
        _obj: "get",
        _target: [{ _ref: "document", _index: i + 1 }],
      }));
      byIndex = await psAction.batchPlay(queries, { synchronousExecution: false } as any);
    }
  } catch { /* */ }

  // 3. batchPlay get by _id for each DOM-known doc id
  const byIdMap = new Map<number, any>();
  try {
    const ids = dom.map(d => d.id).filter((x: any) => typeof x === "number");
    if (ids.length > 0) {
      const queries = ids.map(id => ({
        _obj: "get",
        _target: [{ _ref: "document", _id: id }],
      }));
      const results: any[] = await psAction.batchPlay(queries, { synchronousExecution: false } as any);
      ids.forEach((id, i) => byIdMap.set(id, results[i]));
    }
  } catch { /* */ }

  const total = Math.max(domCount, byIndex.length);
  const readings: DocReading[] = [];
  for (let i = 0; i < total; i++) {
    const d = dom[i];
    const idx = byIndex[i];
    const idResult = d ? byIdMap.get(d.id) : null;
    readings.push({
      ord: i + 1,
      domId: d?.id ?? null,
      domName: (() => { try { return d?.name ?? null; } catch { return null; } })(),
      domTitle: (() => { try { return d?.title ?? null; } catch { return null; } })(),
      bpIndexId: idx?.documentID ?? idx?.ID ?? null,
      bpIndexTitle: idx?.title ?? null,
      bpIndexName: idx?.name ?? null,
      bpIndexFileRef: basename(idx?.fileReference),
      bpIdTitle: idResult?.title ?? null,
      bpIdName: idResult?.name ?? null,
      bpIdFileRef: basename(idResult?.fileReference),
    });
  }

  return { ts, trigger, activeId, count: bpCount, domCount, readings };
}

function recordToText(r: ProbeRecord): string {
  const lines: string[] = [];
  lines.push(`[${r.ts}] trigger=${r.trigger} activeId=${r.activeId} bpCount=${r.count} domCount=${r.domCount}`);
  for (const d of r.readings) {
    lines.push(`  #${d.ord}`);
    lines.push(`    DOM      id=${d.domId} name=${JSON.stringify(d.domName)} title=${JSON.stringify(d.domTitle)}`);
    lines.push(`    bpIndex  id=${d.bpIndexId} title=${JSON.stringify(d.bpIndexTitle)} name=${JSON.stringify(d.bpIndexName)} fileRef=${JSON.stringify(d.bpIndexFileRef)}`);
    lines.push(`    bpById   title=${JSON.stringify(d.bpIdTitle)} name=${JSON.stringify(d.bpIdName)} fileRef=${JSON.stringify(d.bpIdFileRef)}`);
  }
  return lines.join("\n");
}

export function DocProbe() {
  const [records, setRecords] = useState<ProbeRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const probe = async (trigger: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const rec = await runProbe(trigger);
      setRecords(prev => [rec, ...prev].slice(0, RING_SIZE));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  // Capture probe in a ref so the long-lived listener doesn't capture a stale closure.
  const probeRef = useRef(probe);
  useEffect(() => { probeRef.current = probe; });

  // Initial mount probe + listener for the events most likely tied to renames.
  useEffect(() => {
    void probeRef.current("mount");
    const events = ["save", "rename", "set", "selectDocument", "open", "close"];
    const onEvt = (ev: any) => { void probeRef.current(typeof ev === "string" ? ev : (ev?.event ?? "evt")); };
    psAction.addNotificationListener(events, onEvt);
    return () => { psAction.removeNotificationListener?.(events, onEvt); };
  }, []);

  const allText = records.map(recordToText).join("\n\n");

  // UXP's navigator.clipboard is restricted; the easiest reliable copy path is to
  // render the trace into a textarea and tell the user to use Ctrl+A, Ctrl+C in it.
  const [showCopyTextarea, setShowCopyTextarea] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const showCopy = () => {
    setShowCopyTextarea(true);
    setTimeout(() => { taRef.current?.focus(); taRef.current?.select(); }, 0);
  };

  return (
    <div style={{ marginTop: 8, padding: 6, border: "1px solid #555", borderRadius: 3, background: "#1a1a1a", fontSize: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: "#dddddd" }}>Doc-rename probe</span>
        <button onClick={() => probe("manual")} disabled={busy}
          style={{ padding: "2px 8px", fontSize: 10, background: busy ? "#333" : "#1473e6", color: "#fff", border: "none", borderRadius: 2, cursor: busy ? "default" : "pointer" }}>
          {busy ? "..." : "Probe now"}
        </button>
        <button onClick={showCopy}
          style={{ padding: "2px 8px", fontSize: 10, background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 2, cursor: "pointer" }}>
          Copy…
        </button>
        <button onClick={() => setRecords([])}
          style={{ padding: "2px 8px", fontSize: 10, background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 2, cursor: "pointer" }}>
          Clear
        </button>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>{records.length}/{RING_SIZE}</span>
      </div>
      <pre style={{
        margin: 0, padding: 4, background: "#111", color: "#cfcfcf",
        maxHeight: 220, overflow: "auto",
        fontSize: 10, fontFamily: "Consolas, Monaco, monospace",
        whiteSpace: "pre", borderRadius: 2,
      }}>
        {allText || "(no probes yet — Save As a doc, click Probe now, or wait for an event)"}
      </pre>
      {showCopyTextarea && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>
            Selected. Press Ctrl+C (or Cmd+C) to copy.
            <span onClick={() => setShowCopyTextarea(false)} style={{ marginLeft: 8, cursor: "pointer", color: "#aaa", textDecoration: "underline" }}>close</span>
          </div>
          <textarea ref={taRef} readOnly value={allText}
            style={{ width: "100%", height: 100, fontSize: 10, fontFamily: "Consolas, Monaco, monospace", background: "#222", color: "#ddd", border: "1px solid #555", borderRadius: 2, padding: 4, boxSizing: "border-box" }} />
        </div>
      )}
    </div>
  );
}
