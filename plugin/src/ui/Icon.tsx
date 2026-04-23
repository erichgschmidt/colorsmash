// Inline Spectrum SMOCK icons. SVGs are bundled as raw strings (asset/source webpack rule),
// then dropped into a span via dangerouslySetInnerHTML so the inner CSS .fill: currentColor
// inherits from the surrounding text color.

// @ts-ignore raw svg import
import refresh from "../../assets/icons/Smock_Refresh_18_N.svg";
// @ts-ignore
import revert from "../../assets/icons/Smock_Revert_18_N.svg";
// @ts-ignore
import chevronDown from "../../assets/icons/Smock_ChevronDown_18_N.svg";
// @ts-ignore
import chevronRight from "../../assets/icons/Smock_ChevronRight_18_N.svg";
// @ts-ignore
import layers from "../../assets/icons/Smock_Layers_18_N.svg";
// @ts-ignore
import selection from "../../assets/icons/Smock_Selection_18_N.svg";
// @ts-ignore
import sampler from "../../assets/icons/Smock_Sampler_18_N.svg";

// Strip the SVG's hardcoded width/height attrs so the span's box-size dictates render size.
function normalize(svg: string): string {
  return svg.replace(/\s(width|height)="\d+"/g, "");
}

const ICONS: Record<string, string> = {
  refresh: normalize(refresh),
  revert: normalize(revert),
  chevronDown: normalize(chevronDown),
  chevronRight: normalize(chevronRight),
  layers: normalize(layers),
  selection: normalize(selection),
  sampler: normalize(sampler),
};

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; color?: string; style?: React.CSSProperties }) {
  const size = props.size ?? 14;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex", width: size, height: size,
        color: props.color ?? "currentColor", lineHeight: 0, ...props.style,
      }}
      dangerouslySetInnerHTML={{ __html: ICONS[props.name] }}
    />
  );
}
