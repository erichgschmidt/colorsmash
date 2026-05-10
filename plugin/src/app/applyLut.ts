// Auto-apply 3D LUT as a Color Lookup adjustment layer in PS.
//
// Flow:
//   1. Generate the .cube text from the staged curves + preset (same generator
//      Export LUT uses, so output is bit-identical between the two paths).
//   2. Write to UXP plugin temp folder with a unique name.
//   3. Run a batchPlay 'make adjustmentLayer → colorLookup' descriptor that
//      points the layer at the temp file via a session token.
//   4. Move the new layer into the [Color Smash] group, name it, optionally clip.
//
// This is the auto-apply path — the existing Export LUT (file save dialog)
// remains as a portable fallback. If batchPlay descriptor fails on a given
// PS version, the caller should fall back to writing a copy and surfacing
// the path to the user.

import { ChannelCurves, generateLutCube, Preset } from "../core/histogramMatch";
import { GROUP_NAME, action, app } from "../services/photoshop";
import { executeAsModal } from "../services/photoshop";

const LUT_LAYER_PREFIX = "Match LUT";

export interface ApplyLutParams {
  curves: ChannelCurves;
  preset: Preset;
  size?: number;        // default 33
  targetLayerId?: number | null; // if provided, clip the LUT layer to it
  overwritePrior?: boolean;      // delete prior 'Match LUT*' layers in [Color Smash] group
}

/** Recursively collect every descendant whose name matches the prefix. */
function collectMatches(parent: any, prefix: string, out: any[]) {
  for (const child of parent.layers ?? []) {
    const name = child.name;
    if (typeof name === "string" && (name === prefix || name.startsWith(prefix))) {
      if (child.layers) collectMatches(child, prefix, out);
      out.push(child);
    }
  }
}

/** Find or create the [Color Smash] group at the doc root. */
async function getOrCreateColorSmashGroup(doc: any): Promise<any> {
  const findCS = (layers: any[]): any | null => {
    for (const l of layers) {
      if (l && l.name === GROUP_NAME && (l.kind === "group" || Array.isArray(l.layers))) return l;
      if (Array.isArray(l.layers)) { const found = findCS(l.layers); if (found) return found; }
    }
    return null;
  };
  const existing = findCS(doc.layers ?? []);
  if (existing) return existing;
  return await doc.createLayerGroup({ name: GROUP_NAME });
}

/**
 * Bake LUT to plugin temp + create a Color Lookup adjustment layer.
 * Returns the layer name on success, throws with diagnostic on failure.
 */
export async function applyLutAsAdjustmentLayer(params: ApplyLutParams): Promise<string> {
  const uxp = require("uxp");
  const size = params.size ?? 33;

  // 1. Generate cube text (same generator the Export LUT button uses).
  const cubeText = generateLutCube(params.curves, params.preset, size, "Color Smash");

  // 2. Write to UXP plugin temp folder. Unique filename per call so PS doesn't
  //    keep a stale handle on a re-applied LUT (PS may copy the LUT data into
  //    the doc on layer creation, but if it doesn't, we want a fresh file).
  const tempFolder = await uxp.storage.localFileSystem.getTemporaryFolder();
  const stamp = Date.now();
  const presetTag = params.preset === "color" ? "full"
                  : params.preset === "hue" ? "color"
                  : params.preset === "hueOnly" ? "hue"
                  : params.preset === "saturationOnly" ? "saturation"
                  : "contrast";
  const fileName = `colorsmash_${presetTag}_${stamp}.cube`;
  const file = await tempFolder.createFile(fileName, { overwrite: true });
  await file.write(cubeText, { format: uxp.storage.formats.utf8 });

  // 3. Create Color Lookup adjustment layer + load 3DLUT in modal scope.
  return await executeAsModal("Color Smash apply LUT", async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No active document.");

    // Reuse / create [Color Smash] group; clean up prior Match LUT layers if requested.
    const group = await getOrCreateColorSmashGroup(doc);
    if (params.overwritePrior !== false) {
      const prior: any[] = [];
      collectMatches(group, LUT_LAYER_PREFIX, prior);
      for (const p of prior) {
        try { await p.delete(); } catch { /* ignore */ }
      }
    }

    // If we have a target layer, select it so the new adjustment lands above it.
    if (params.targetLayerId != null) {
      try {
        await action.batchPlay([{
          _obj: "select",
          _target: [{ _ref: "layer", _id: params.targetLayerId }],
          makeVisible: false,
        }], {});
      } catch { /* ignore — fall back to current selection */ }
    }

    // ─── Two-step pattern: make → set ──────────────────────────────────────
    // PS's `make adjustmentLayer` with `using.type.colorLookup` creates a
    // DEFAULT (identity) Color Lookup layer — the profile/file fields inside
    // `using.type` are typically ignored. The actual LUT load is a separate
    // `set` descriptor on the just-created layer, mirroring the menu action
    // "Layer → New Adjustment Layer → Color Lookup… → Load 3D LUT".
    const layerName = `${LUT_LAYER_PREFIX} [${presetTag}]`;
    const sessionToken = await uxp.storage.localFileSystem.createSessionToken(file);

    // Step 1: make the empty (identity) Color Lookup layer.
    const makeResult = await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        type: { _obj: "colorLookup" },
      },
    }], {});
    if (!makeResult || !makeResult[0] || makeResult[0].error) {
      throw new Error(`make adjustmentLayer (colorLookup) failed: ${makeResult?.[0]?.error ?? "unknown"}`);
    }

    // Step 2: load the 3D LUT into the active (newly-created) layer. Try
    // multiple profile-field shapes since PS versions vary on which it accepts
    // for `_path` token / native string / file token.
    const setDescriptor = (profileValue: any) => ({
      _obj: "set",
      _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: {
        _obj: "colorLookup",
        lookupType: { _enum: "colorLookupType", _value: "lookup3DLUT" },
        lookup3DLUTName: file.name,
        profile: profileValue,
      },
    });
    const attempts = [
      setDescriptor({ _path: sessionToken, _kind: "local" }),
      setDescriptor({ _path: file.nativePath, _kind: "local" }),
      setDescriptor(sessionToken),
      setDescriptor(file.nativePath),
    ];
    let loaded = false;
    let lastErr: any = null;
    for (const desc of attempts) {
      try {
        const result = await action.batchPlay([desc as any], {});
        if (result && result[0] && !result[0].error) { loaded = true; break; }
        lastErr = result?.[0]?.error;
      } catch (e) { lastErr = e; }
    }
    if (!loaded) {
      // Don't leave an identity layer behind — clean it up so the user isn't
      // confused by an apparently-empty Color Lookup layer.
      try {
        const stray = doc.activeLayers?.[0];
        if (stray && typeof stray.delete === "function") await stray.delete();
      } catch { /* ignore */ }
      throw new Error(`Could not load 3D LUT into Color Lookup layer: ${lastErr?.message ?? lastErr ?? "unknown"}`);
    }

    // The new layer is the active layer. Rename + move into the group.
    // NOTE: PS adjustment layers inside a Pass-Through group affect everything
    // below the GROUP in the stack. The [Color Smash] group is created/found
    // at the doc root (top by default for new groups), so the LUT inside it
    // affects layers below — which should include the target. If the user has
    // moved the group elsewhere, the LUT only affects what's below the group.
    const newLayer = doc.activeLayers?.[0] ?? doc.layers?.[0];
    if (newLayer) {
      try { newLayer.name = layerName; } catch { /* ignore */ }
      try { await newLayer.move(group, "placeInside"); } catch { /* ignore */ }
    }

    return layerName;
  });
}
