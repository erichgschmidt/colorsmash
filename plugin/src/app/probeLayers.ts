// Per-layer simulator probe: test each adjustment layer in isolation against PS-actual output.
// For each layer (Curves, Color Balance, Hue/Sat), build a stack with only that layer using a
// known param set, render it, and compare PS-actual to simulator's prediction for the same input.

import {
  readLayerPixels, executeAsModal, getActiveDoc,
  findExistingGroup, GROUP_NAME,
  makeCurvesLayer, makeColorBalanceLayer, makeHueSatLayer,
} from "../services/photoshop";
import { simulateStack } from "../core/stackSimulator";
import { rgbToLab, deltaE76 } from "../core/lab";
import type { StackParams } from "../core/reinhardToStack";

const SAMPLES = 500;

// Three test param sets — each isolates one layer (others are identity).
const ID_CURVES = [{ input: 0, output: 0 }, { input: 128, output: 128 }, { input: 255, output: 255 }];
const ID_CB = { shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, midtones: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 }, highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 } };
const ID_HS = { saturation: 0 };

const TEST_CURVES: StackParams = {
  curvesMaster: [{ input: 0, output: 20 }, { input: 128, output: 100 }, { input: 255, output: 200 }],
  colorBalance: ID_CB, hueSat: ID_HS,
  selective: { reds: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, yellows: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, greens: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, cyans: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, blues: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, magentas: { cyan: 0, magenta: 0, yellow: 0, black: 0 }, neutrals: { cyan: 0, magenta: 0, yellow: 0, black: 0 } },
};
const TEST_CB: StackParams = {
  curvesMaster: ID_CURVES, hueSat: ID_HS,
  colorBalance: { shadows: { cyanRed: 30, magentaGreen: -20, yellowBlue: 40 }, midtones: { cyanRed: -25, magentaGreen: 10, yellowBlue: -30 }, highlights: { cyanRed: 15, magentaGreen: -10, yellowBlue: 20 } },
  selective: TEST_CURVES.selective,
};
const TEST_HS: StackParams = {
  curvesMaster: ID_CURVES, colorBalance: ID_CB,
  hueSat: { saturation: -50 },
  selective: TEST_CURVES.selective,
};

export interface ProbeParams { targetLayerId: number }

async function buildAndStamp(params: StackParams, which: "curves" | "cb" | "hs"): Promise<void> {
  const doc = getActiveDoc();
  const prior = findExistingGroup();
  if (prior) {
    for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
    try { await prior.delete(); } catch { /* ignore */ }
  }
  const group = await doc.createLayerGroup({ name: GROUP_NAME });
  if (which === "hs") { const l = await makeHueSatLayer("HS", params.hueSat); await l.move(group, "placeInside"); }
  if (which === "cb") { const l = await makeColorBalanceLayer("CB", params.colorBalance); await l.move(group, "placeInside"); }
  if (which === "curves") { const l = await makeCurvesLayer("CV", [{ channel: "composite", points: params.curvesMaster }]); await l.move(group, "placeInside"); }
}

async function captureMerged(): Promise<{ width: number; height: number; data: Uint8Array }> {
  const doc = getActiveDoc();
  const probe = await doc.createLayer({ name: "[CS Probe]" });
  const ps = require("photoshop");
  await ps.action.batchPlay([
    { _obj: "select", _target: [{ _ref: "layer", _id: probe.id }], makeVisible: true },
    { _obj: "mergeVisible", duplicate: true },
  ], {});
  const merged = doc.activeLayers?.[0];
  if (!merged) throw new Error("merge failed");
  const buf = await readLayerPixels(merged);
  try { await merged.delete(); } catch { /* ignore */ }
  try { await probe.delete(); } catch { /* ignore */ }
  return { width: buf.width, height: buf.height, data: buf.data };
}

function compare(targetData: Uint8Array, psData: Uint8Array, params: StackParams, n: number) {
  const total = Math.min(targetData.length, psData.length) / 4;
  const stride = Math.max(1, Math.floor(total / n));
  let sum = 0, max = 0, count = 0;
  for (let pi = 0; pi < total; pi += stride) {
    const i = pi * 4;
    const inRGB = { r: targetData[i] / 255, g: targetData[i + 1] / 255, b: targetData[i + 2] / 255 };
    const psRGB = { r: psData[i] / 255, g: psData[i + 1] / 255, b: psData[i + 2] / 255 };
    const sim = simulateStack(inRGB, params);
    const de = deltaE76(rgbToLab(psRGB), rgbToLab(sim));
    sum += de;
    if (de > max) max = de;
    count++;
  }
  return { mean: sum / count, max, count };
}

export async function probeLayers(p: ProbeParams): Promise<string> {
  // Read original target pixels once.
  const targetBuf = await executeAsModal("Probe: read target", async () => {
    const doc = getActiveDoc();
    const target = doc.layers.find((l: any) => l.id === p.targetLayerId);
    if (!target) throw new Error("target gone");
    return await readLayerPixels(target);
  });

  const cases: { name: string; params: StackParams; key: "curves" | "cb" | "hs" }[] = [
    { name: "Curves", params: TEST_CURVES, key: "curves" },
    { name: "CB",     params: TEST_CB,     key: "cb" },
    { name: "HueSat", params: TEST_HS,     key: "hs" },
  ];
  const results: string[] = [];
  for (const c of cases) {
    const merged = await executeAsModal(`Probe: ${c.name}`, async () => {
      await buildAndStamp(c.params, c.key);
      return await captureMerged();
    });
    const r = compare(targetBuf.data, merged.data, c.params, SAMPLES);
    results.push(`${c.name}: mean ${r.mean.toFixed(2)} | max ${r.max.toFixed(2)}`);
  }

  // Cleanup — delete the [Color Smash] group so we leave the doc tidy.
  await executeAsModal("Probe cleanup", async () => {
    const prior = findExistingGroup();
    if (prior) {
      for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
      try { await prior.delete(); } catch { /* ignore */ }
    }
  });

  return results.join("\n");
}
