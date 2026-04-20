// Empirical Color Balance calibration: render a known gray ramp through PS with single-slider
// configs, read the observed RGB shifts, and print a table we can use to model CB exactly.
//
// For each (zone, axis, slider value), we measure dR/dG/dB at L = 0, 25, 50, 75, 100 (% gray).
// The resulting table feeds a corrected applyColorBalance() in stackSimulator.

import {
  executeAsModal, getActiveDoc, findExistingGroup, GROUP_NAME,
  makeColorBalanceLayer, writeLayerPixels, readLayerPixels,
} from "../services/photoshop";

const RAMP_LEVELS = [0, 64, 128, 192, 255]; // 5 gray steps
const COL_W = 64;
const COL_H = 64;
const TOTAL_W = COL_W * RAMP_LEVELS.length;

type Zone = "shadows" | "midtones" | "highlights";
type Axis = "cyanRed" | "magentaGreen" | "yellowBlue";
const ZONES: Zone[] = ["shadows", "midtones", "highlights"];
const AXES: Axis[] = ["cyanRed", "magentaGreen", "yellowBlue"];

function makeRampBuffer() {
  const data = new Uint8Array(TOTAL_W * COL_H * 4);
  for (let y = 0; y < COL_H; y++) {
    for (let i = 0; i < RAMP_LEVELS.length; i++) {
      for (let x = 0; x < COL_W; x++) {
        const o = ((y * TOTAL_W) + i * COL_W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = RAMP_LEVELS[i];
        data[o + 3] = 255;
      }
    }
  }
  return { width: TOTAL_W, height: COL_H, data, bounds: { left: 0, top: 0, right: TOTAL_W, bottom: COL_H } };
}

function readColumnAvgRGB(buf: { width: number; data: Uint8Array }, colIndex: number) {
  const x0 = colIndex * COL_W;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < COL_H; y++) {
    for (let x = x0; x < x0 + COL_W; x++) {
      const o = (y * buf.width + x) * 4;
      r += buf.data[o]; g += buf.data[o + 1]; b += buf.data[o + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

async function applyAndStamp(zone: Zone, axis: Axis, value: number, ramp: ReturnType<typeof makeRampBuffer>) {
  const doc = getActiveDoc();

  // Clean prior group + probe layers.
  const prior = findExistingGroup();
  if (prior) {
    for (const c of [...(prior.layers ?? [])]) { try { await c.delete(); } catch { /* ignore */ } }
    try { await prior.delete(); } catch { /* ignore */ }
  }

  // Create the gray ramp layer at top.
  const rampLayer = await doc.createLayer({ name: "[CS Ramp]" });
  await writeLayerPixels(rampLayer, ramp);

  // Apply CB above with only this slider non-zero.
  const cb = {
    shadows:    { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    midtones:   { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
  };
  cb[zone][axis] = value;
  const cbLayer = await makeColorBalanceLayer(`CB ${zone}.${axis}=${value}`, cb);

  // Stamp visible to capture composite.
  const probe = await doc.createLayer({ name: "[CS Probe]" });
  const ps = require("photoshop");
  await ps.action.batchPlay([
    { _obj: "select", _target: [{ _ref: "layer", _id: probe.id }], makeVisible: true },
    { _obj: "mergeVisible", duplicate: true },
  ], {});
  const merged = doc.activeLayers?.[0];
  if (!merged) throw new Error("merge failed");
  const result = await readLayerPixels(merged);

  // Cleanup.
  try { await merged.delete(); } catch { /* ignore */ }
  try { await probe.delete(); } catch { /* ignore */ }
  try { await cbLayer.delete(); } catch { /* ignore */ }
  try { await rampLayer.delete(); } catch { /* ignore */ }

  return result;
}

export async function calibrateCB(): Promise<string> {
  const ramp = makeRampBuffer();
  const lines: string[] = [];
  lines.push("Empirical Color Balance shifts (slider=±50)");
  lines.push("zone.axis @ L: dR dG dB (observed)");
  lines.push("-".repeat(60));

  // Test slider value (positive direction, single axis at a time).
  const VAL = 50;

  for (const zone of ZONES) {
    for (const axis of AXES) {
      const result = await executeAsModal(`Calibrate ${zone}.${axis}`, async () => {
        return await applyAndStamp(zone, axis, VAL, ramp);
      });
      const cells: string[] = [];
      for (let i = 0; i < RAMP_LEVELS.length; i++) {
        const Lin = RAMP_LEVELS[i];
        const out = readColumnAvgRGB(result, i);
        const dR = out.r - Lin, dG = out.g - Lin, dB = out.b - Lin;
        cells.push(`L${Lin}:${dR>=0?'+':''}${dR.toFixed(0)}/${dG>=0?'+':''}${dG.toFixed(0)}/${dB>=0?'+':''}${dB.toFixed(0)}`);
      }
      lines.push(`${zone}.${axis}: ${cells.join(" ")}`);
    }
  }

  // Final cleanup of [Color Smash] group if any leftover.
  await executeAsModal("Calibrate cleanup", async () => {
    const prior = findExistingGroup();
    if (prior) { try { await prior.delete(); } catch { /* ignore */ } }
    void GROUP_NAME;
  });

  return lines.join("\n");
}
