// Spectrum sp-icon web component (UXP runtime built-in).
// Names follow Adobe Spectrum's workflow icon set.

const NAMES: Record<string, string> = {
  refresh: "ui:Refresh",
  revert: "ui:Revert",
  chevronDown: "ui:ChevronDown",
  chevronRight: "ui:ChevronRight",
  layers: "workflow:Layers",
  selection: "workflow:Selection",
  sampler: "workflow:Sampler",
};

export type IconName = keyof typeof NAMES;

// Map numeric (legacy) sizes to Spectrum t-shirt sizes.
function spSize(n?: number): "xs" | "s" | "m" | "l" {
  if (n == null) return "s";
  if (n <= 11) return "xs";
  if (n <= 14) return "s";
  if (n <= 18) return "m";
  return "l";
}

export function Icon(props: { name: IconName; size?: number; style?: React.CSSProperties }) {
  return (
    // @ts-ignore Spectrum web component
    <sp-icon name={NAMES[props.name]} size={spSize(props.size)} style={{ flexShrink: 0, ...props.style }}></sp-icon>
  );
}
