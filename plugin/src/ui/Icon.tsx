// Spectrum SMOCK icons via plain <img> tags pointing at bundled SVG files.
// UXP renders img+SVG natively (inline SVG JSX renders blank in current UXP).
// SVG fill is baked to a mid-gray (#b8b8b8) since img can't inherit currentColor.

const SRC: Record<string, string> = {
  refresh:      "./assets/icons/Smock_Refresh_18_N.svg",
  revert:       "./assets/icons/Smock_Revert_18_N.svg",
  chevronDown:  "./assets/icons/Smock_ChevronDown_18_N.svg",
  chevronRight: "./assets/icons/Smock_ChevronRight_18_N.svg",
  layers:       "./assets/icons/Smock_Layers_18_N.svg",
  selection:    "./assets/icons/Smock_Selection_18_N.svg",
  sampler:      "./assets/icons/Smock_Sampler_18_N.svg",
};

export type IconName = keyof typeof SRC;

export function Icon(props: { name: IconName; size?: number; style?: React.CSSProperties }) {
  const size = props.size ?? 14;
  return (
    <img
      src={SRC[props.name]}
      width={size}
      height={size}
      alt=""
      aria-hidden
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...props.style }}
    />
  );
}
