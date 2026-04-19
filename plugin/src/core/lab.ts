// sRGB <-> Lab. Per considerations §7, analysis is performed on gamma-encoded sRGB
// for Reinhard, but the Lab conversion itself requires linearization. We linearize,
// convert to XYZ, then to Lab. Reinhard mean/sigma is then applied in Lab.

import { D65, M_RGB_TO_XYZ, M_XYZ_TO_RGB } from "./colorConstants";

export interface Lab { L: number; a: number; b: number; }
export interface RGB { r: number; g: number; b: number; } // 0..1

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function fLab(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function fLabInv(t: number): number {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

export function rgbToLab(rgb: RGB): Lab {
  const rl = srgbToLinear(rgb.r);
  const gl = srgbToLinear(rgb.g);
  const bl = srgbToLinear(rgb.b);
  const X = M_RGB_TO_XYZ[0][0] * rl + M_RGB_TO_XYZ[0][1] * gl + M_RGB_TO_XYZ[0][2] * bl;
  const Y = M_RGB_TO_XYZ[1][0] * rl + M_RGB_TO_XYZ[1][1] * gl + M_RGB_TO_XYZ[1][2] * bl;
  const Z = M_RGB_TO_XYZ[2][0] * rl + M_RGB_TO_XYZ[2][1] * gl + M_RGB_TO_XYZ[2][2] * bl;
  const fx = fLab(X / D65.Xn);
  const fy = fLab(Y / D65.Yn);
  const fz = fLab(Z / D65.Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(lab: Lab): RGB {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const X = D65.Xn * fLabInv(fx);
  const Y = D65.Yn * fLabInv(fy);
  const Z = D65.Zn * fLabInv(fz);
  const rl = M_XYZ_TO_RGB[0][0] * X + M_XYZ_TO_RGB[0][1] * Y + M_XYZ_TO_RGB[0][2] * Z;
  const gl = M_XYZ_TO_RGB[1][0] * X + M_XYZ_TO_RGB[1][1] * Y + M_XYZ_TO_RGB[1][2] * Z;
  const bl = M_XYZ_TO_RGB[2][0] * X + M_XYZ_TO_RGB[2][1] * Y + M_XYZ_TO_RGB[2][2] * Z;
  return { r: linearToSrgb(rl), g: linearToSrgb(gl), b: linearToSrgb(bl) };
}

// CIE76 ΔE. Sufficient for golden-image regression at Phase 0 tolerance (<5).
export function deltaE76(a: Lab, b: Lab): number {
  const dL = a.L - b.L, da = a.a - b.a, db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}
