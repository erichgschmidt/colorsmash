// Debug: read the target layer pixels and write them back unchanged into a duplicate.
// If the result is identical to the target, read+write are correct and any wrongness
// in runSpike is in the math. If the result is wrong (white/striped/etc), the bug is
// in the pixel I/O service.

import { readLayerPixels, writeLayerPixels, executeAsModal, getActiveDoc } from "../services/photoshop";

export async function runRoundTrip(): Promise<string> {
  return executeAsModal("Color Smash round-trip", async () => {
    const doc = getActiveDoc();
    const layers = doc.layers;
    if (layers.length < 1) throw new Error("Need at least 1 layer.");
    const target = layers[0];

    const buf = await readLayerPixels(target);
    const dup = await target.duplicate();
    dup.name = "[Color Smash] RoundTrip";
    await writeLayerPixels(dup, buf);

    // Quick checksum on the buffer so we can confirm we read non-zero pixels.
    let sumR = 0, sumG = 0, sumB = 0, n = 0;
    for (let i = 0; i < buf.data.length; i += 4) {
      sumR += buf.data[i]; sumG += buf.data[i + 1]; sumB += buf.data[i + 2]; n++;
    }
    const avg = `R${(sumR / n).toFixed(0)} G${(sumG / n).toFixed(0)} B${(sumB / n).toFixed(0)}`;
    return `RoundTrip ${buf.width}×${buf.height} avg ${avg}`;
  });
}
