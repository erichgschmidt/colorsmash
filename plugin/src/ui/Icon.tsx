// Spectrum SMOCK icons as proper React SVG components (via @svgr/webpack).
// Each import yields a component that renders the SVG natively. Color
// is set via the SVG's .fill class (currentColor) — wrap in any element
// that sets `color` to retint.

// @ts-ignore svgr import
import RefreshIcon from "../../assets/icons/Smock_Refresh_18_N.svg";
// @ts-ignore
import RevertIcon from "../../assets/icons/Smock_Revert_18_N.svg";
// @ts-ignore
import ChevronDownIcon from "../../assets/icons/Smock_ChevronDown_18_N.svg";
// @ts-ignore
import ChevronRightIcon from "../../assets/icons/Smock_ChevronRight_18_N.svg";
// @ts-ignore
import LayersIcon from "../../assets/icons/Smock_Layers_18_N.svg";
// @ts-ignore
import SelectionIcon from "../../assets/icons/Smock_Selection_18_N.svg";
// @ts-ignore
import SamplerIcon from "../../assets/icons/Smock_Sampler_18_N.svg";

const ICONS: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  refresh: RefreshIcon,
  revert: RevertIcon,
  chevronDown: ChevronDownIcon,
  chevronRight: ChevronRightIcon,
  layers: LayersIcon,
  selection: SelectionIcon,
  sampler: SamplerIcon,
};

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; color?: string; style?: React.CSSProperties }) {
  const size = props.size ?? 14;
  const Cmp = ICONS[props.name];
  return (
    <span style={{ display: "inline-flex", color: props.color ?? "#bbb", lineHeight: 0, ...props.style }}>
      <Cmp width={size} height={size} />
    </span>
  );
}
