// Per-layer XMP fingerprint: serialize panel state into a Match LUT layer's
// XMP metadata so it can be restored later. Click a Match LUT layer in PS's
// Layers panel, click "Restore" in Color Smash, and every relevant slider /
// toggle / palette weight pops back to exactly what produced that LUT.
//
// Storage location: layer XMP (not document XMP). The layer carries its own
// state — copy/duplicate/drag the layer to another doc and the metadata
// travels with it. Phase 2c will add a source-image fingerprint so the layer
// is FULLY self-contained (re-bake without the original source doc open).
//
// Custom namespace: `xmlns:cs="http://colorsmash.dev/v1/"`. State serialized
// as a single JSON-in-property value rather than expanding every field
// individually — keeps the XMP tiny and the parser trivial.

import { action } from "../services/photoshop";

const XMP_NAMESPACE_URI = "http://colorsmash.dev/v1/";
const XMP_NAMESPACE_PREFIX = "cs";
const XMP_STATE_PROP = "panelStateJSON";
const XMP_VERSION = 1;

/** Shape of the state we round-trip. Optional fields keep older versions
 *  forward-compatible: if we add a field later, restoring an old layer just
 *  leaves that new field at its default. */
export interface LutLayerState {
  xmpVersion: number;
  // Preset + match-mode core knobs
  preset: string;
  matchMode?: string;
  colorSpace?: string;
  /** v1.15.0+ — unified output-mode selector ("rgb" | "lab" | "lut").
   *  Restored layers default to "lut" if missing (since they came from a
   *  Color Lookup layer). For pre-v1.15.0 layers, fallback to colorSpace. */
  outputMode?: string;
  // Source/target weights & softness (palette region modulation)
  paletteCount: number;
  sourcePaletteWeights?: number[];
  targetPaletteWeights?: number[];
  sourceSoftness?: number;
  targetSoftness?: number;
  paletteAdaptive?: boolean;
  // Apply-time toggles. multiZone was retired in v1.20.70; field
  // dropped from the schema. Old XMP that carries multiZone:true
  // still parses (extra fields are ignored on read).
  // LUT-output knobs (v1.17.0). Only meaningful when outputMode is "lut".
  // Restored RGB/Lab layers carry these too (harmlessly), so a user who
  // first authored as LUT and later switched to Curves doesn't lose their
  // LUT preferences when toggling back.
  lutStrength?: number;     // 0..100 — bake-time identity-lerp
  lutGrid?: 17 | 33 | 65;   // 3D LUT grid points per axis
  lutDither?: boolean;      // PS colorLookup.dither field
  // Marquee → layer mask selector (v1.18.0).
  selectionMode?: "off" | "focus" | "exclude";
  // Detailed parameter sections (kept opaque — full restore round-trips
  // the literal objects without us having to know their internals).
  dimensions?: Record<string, any>;
  zones?: Record<string, any>;
  envelope?: any[];
  // Identity hints for the editor — best-effort; null if unavailable.
  sourceDocId?: number | null;
  sourceLayerId?: number | null;
  // v1.20.43 — also stash target doc + layer so RESTORE can put the panel
  // back to the EXACT source/target pairing that produced the bake, not
  // just the algorithm settings.
  targetDocId?: number | null;
  targetLayerId?: number | null;
  // Palette swatches — the actual cluster centroids from k-means at bake
  // time. Storing these means the layer is self-contained: even if the
  // source doc is closed/deleted, RESTORE can show the user the palette
  // they were working with and re-apply weight tweaks against the saved
  // swatches. Phase 2c (this version).
  sourcePaletteSwatches?: SerializedSwatch[];
  targetPaletteSwatches?: SerializedSwatch[];
  // Audit
  timestamp?: number;
  toolVersion?: string;
}

/** Minimal swatch record for XMP — drops anything derived (e.g. effective
 *  weight after softness blending). r/g/b are 0..255; lab values are the
 *  cluster centroid in CIE Lab. weight is the natural-prevalence fraction. */
export interface SerializedSwatch {
  r: number; g: number; b: number;
  weight: number;
  labL: number; labA: number; labB: number;
}

/** Wrap our JSON in a minimal XMP packet. PS reads the entire packet as a
 *  single string and stores it on the layer; we just need it to be valid XML
 *  with our property inside an rdf:Description. */
function buildXmpPacket(state: LutLayerState): string {
  const json = JSON.stringify(state);
  // Escape characters that would break XML attribute/element parsing.
  const esc = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `  <rdf:Description rdf:about=""\n` +
    `   xmlns:${XMP_NAMESPACE_PREFIX}="${XMP_NAMESPACE_URI}">\n` +
    `   <${XMP_NAMESPACE_PREFIX}:${XMP_STATE_PROP}>${esc}</${XMP_NAMESPACE_PREFIX}:${XMP_STATE_PROP}>\n` +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`
  );
}

/** Pull our JSON back out of an XMP packet. Returns null if the namespace
 *  property isn't present (e.g. a layer without our metadata). */
function parseXmpPacket(xmpString: string): LutLayerState | null {
  if (!xmpString) return null;
  // Match the property's element body. The XML is well-formed but namespace
  // prefixes may vary across writers, so we tolerate any prefix bound to our
  // namespace URI. Simple regex is fine — we control the writer.
  const propRe = new RegExp(
    `<(?:[\\w]+:)?${XMP_STATE_PROP}[^>]*>([\\s\\S]*?)</(?:[\\w]+:)?${XMP_STATE_PROP}>`,
  );
  const m = xmpString.match(propRe);
  if (!m) return null;
  const decoded = m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  try {
    return JSON.parse(decoded) as LutLayerState;
  } catch {
    return null;
  }
}

/** Write state to a layer's XMP via batchPlay. */
export async function writeLutLayerState(layerId: number, state: LutLayerState): Promise<void> {
  const xmp = buildXmpPacket(state);
  await action.batchPlay([{
    _obj: "set",
    _target: [
      { _ref: "property", _property: "metadata" },
      { _ref: "layer", _id: layerId },
    ],
    to: { _obj: "metadata", XMPMetadataAsUTF8: xmp },
  }], {});
}

/** Read state from a layer's XMP. Returns null if the layer has no XMP or
 *  if our namespace property isn't found. Never throws for normal misses —
 *  callers can use the null to drive "this layer wasn't authored by us" UX. */
export async function readLutLayerState(layerId: number): Promise<LutLayerState | null> {
  try {
    const result = await action.batchPlay([{
      _obj: "get",
      _target: [
        { _property: "metadata" },
        { _ref: "layer", _id: layerId },
      ],
    }], {});
    const md = result?.[0]?.metadata;
    // Different PS versions may key this as XMPMetadataAsUTF8 or just xmp.
    const xmp: string =
      md?.XMPMetadataAsUTF8
      ?? md?.xmp
      ?? md?.XMPMetadata
      ?? "";
    if (typeof xmp !== "string" || xmp.length === 0) return null;
    return parseXmpPacket(xmp);
  } catch {
    return null;
  }
}

/** Convenience: timestamp + version stamp helper for callers that build state. */
export function stampState<T extends Omit<LutLayerState, "xmpVersion" | "timestamp" | "toolVersion">>(
  state: T, toolVersion?: string,
): LutLayerState {
  return {
    ...state,
    xmpVersion: XMP_VERSION,
    timestamp: Date.now(),
    toolVersion,
  };
}

export { XMP_VERSION };
