// Inline Spectrum SMOCK icons. SVGs are bundled as raw strings (asset/source webpack rule).
// We strip the <title> + transparent canvas rect + width/height attrs, then encode the SVG
// as a data URL and render via <img>. UXP's dangerouslySetInnerHTML doesn't parse SVG markup
// reliably (the <title> bled through as text), so the img+dataURL path is what renders.

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

function svgToDataUrl(svg: string, fillColor: string): string {
  const cleaned = svg
    .replace(/<title>[^<]*<\/title>/g, "")
    .replace(/\s(width|height)="\d+"/g, "")
    .replace(/<rect\s+id="Canvas"[^/]*\/>/g, "")
    .replace(/currentColor/g, fillColor);
  return `data:image/svg+xml;base64,${btoa(cleaned)}`;
}

const RAW: Record<string, string> = {
  refresh, revert, chevronDown, chevronRight, layers, selection, sampler,
};

export type IconName = keyof typeof RAW;

export function Icon(props: { name: IconName; size?: number; color?: string; style?: React.CSSProperties }) {
  const size = props.size ?? 14;
  const color = props.color ?? "#bbb"; // default mid-gray, works on light + dark themes
  const url = svgToDataUrl(RAW[props.name], color);
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden
      style={{ display: "inline-block", verticalAlign: "middle", ...props.style }}
    />
  );
}
