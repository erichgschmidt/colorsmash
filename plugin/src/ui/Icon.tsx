// Pragmatic icon fallback: Unicode glyphs (UXP renders these reliably).
// Spectrum sp-icon / svg / img approaches all failed to render in this UXP build.
// If you want proper Adobe icons later, pursue them via spectrum-web-components
// after verifying UXP version / required polyfills.

const GLYPHS: Record<string, string> = {
  refresh:      "↻",
  revert:       "↺",
  chevronDown:  "▾",
  chevronRight: "▸",
  layers:       "L",
  selection:    "◫",
  sampler:      "◉",
};

export type IconName = keyof typeof GLYPHS;

export function Icon(props: { name: IconName; size?: number; style?: React.CSSProperties }) {
  return (
    <span style={{ fontSize: props.size ?? 11, lineHeight: 1, flexShrink: 0, ...props.style }}>
      {GLYPHS[props.name]}
    </span>
  );
}
