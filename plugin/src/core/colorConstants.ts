// D65 illuminant, sRGB->XYZ per IEC 61966-2-1. See docs/considerations.md §6.
// Reference white (D65, 2°): Xn=0.95047, Yn=1.0, Zn=1.08883

export const D65 = { Xn: 0.95047, Yn: 1.0, Zn: 1.08883 };

// sRGB -> XYZ (D65) matrix. Rows are X,Y,Z; columns are R,G,B (linear).
export const M_RGB_TO_XYZ: readonly [number, number, number][] = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];

export const M_XYZ_TO_RGB: readonly [number, number, number][] = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
];
