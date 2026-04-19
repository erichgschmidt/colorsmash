// Adobe/Resolve .cube 3D LUT format (IRIDAS spec).
// Spec: one RGB triplet per line, R fastest-varying, in [0,1].

import type { LUT3D } from "./lutGenerator";

export function writeCubeLUT(lut: LUT3D, title = "Color Smash"): string {
  const lines: string[] = [];
  lines.push(`TITLE "${title.replace(/"/g, "'")}"`);
  lines.push(`LUT_3D_SIZE ${lut.size}`);
  lines.push("DOMAIN_MIN 0.0 0.0 0.0");
  lines.push("DOMAIN_MAX 1.0 1.0 1.0");
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(`${fmt(lut.data[i])} ${fmt(lut.data[i + 1])} ${fmt(lut.data[i + 2])}`);
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(v: number): string {
  // 6 decimals is plenty; trim trailing zeros for compact output.
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
}
