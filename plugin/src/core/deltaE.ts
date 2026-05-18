// CIEDE2000 color-difference (ΔE00).
//
// The CIE 2000 formula refines ΔE76 with lightness, chroma and hue weighting
// functions plus a hue-rotation term that corrects the blue region. This is the
// perceptual distance used by the color-transfer step; kept as a standalone
// pure function so it can be unit-tested against the Sharma reference data.
//
// Reference: G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 color-difference
// formula: implementation notes, supplementary test data, and mathematical
// observations", Color Res. Appl. 30(1), 2005.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Polar angle in [0, 360); atan2 of (b, a) with negatives wrapped up.
function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  let h = Math.atan2(b, a) * RAD;
  if (h < 0) h += 360;
  return h;
}

// CIEDE2000 ΔE between two CIE Lab colors, with kL = kC = kH = 1.
export function deltaE2000(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
): number {
  // ── Step 1: C', h' (chroma & hue in the G-compensated a' space). ──
  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (c1 + c2) / 2;

  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 6103515625))); // 25^7 = 6103515625

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.sqrt(a1p * a1p + b1 * b1);
  const c2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = hueAngle(a1p, b1);
  const h2p = hueAngle(a2p, b2);

  // ── Step 2: ΔL', ΔC', ΔH'. ──
  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  let dhp: number;
  if (c1p * c2p === 0) {
    dhp = 0;
  } else {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * DEG);

  // ── Step 3: weighting functions. ──
  const lBarp = (l1 + l2) / 2;
  const cBarp = (c1p + c2p) / 2;

  let hBarp: number;
  if (c1p * c2p === 0) {
    hBarp = h1p + h2p;
  } else {
    const diff = Math.abs(h1p - h2p);
    if (diff <= 180) hBarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBarp = (h1p + h2p + 360) / 2;
    else hBarp = (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarp - 30) * DEG) +
    0.24 * Math.cos(2 * hBarp * DEG) +
    0.32 * Math.cos((3 * hBarp + 6) * DEG) -
    0.20 * Math.cos((4 * hBarp - 63) * DEG);

  const dTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
  const cBarp7 = Math.pow(cBarp, 7);
  const rC = 2 * Math.sqrt(cBarp7 / (cBarp7 + 6103515625));
  const rT = -Math.sin(2 * dTheta * DEG) * rC;

  const lBarp50 = (lBarp - 50) ** 2;
  const sL = 1 + (0.015 * lBarp50) / Math.sqrt(20 + lBarp50);
  const sC = 1 + 0.045 * cBarp;
  const sH = 1 + 0.015 * cBarp * t;

  // ── Step 4: combine (kL = kC = kH = 1). ──
  const tL = dLp / sL;
  const tC = dCp / sC;
  const tH = dHp / sH;

  return Math.sqrt(tL * tL + tC * tC + tH * tH + rT * tC * tH);
}
