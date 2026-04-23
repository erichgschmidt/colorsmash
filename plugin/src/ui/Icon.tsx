// Spectrum SMOCK icons. SVGs imported as data URLs (webpack asset/inline rule),
// rendered via <img>. UXP's React renderer doesn't render inline <svg> JSX reliably,
// so we go through img which it handles consistently.

// @ts-ignore svg url import
import refreshUrl from "../../assets/icons/Smock_Refresh_18_N.svg";
// @ts-ignore
import revertUrl from "../../assets/icons/Smock_Revert_18_N.svg";
// @ts-ignore
import chevronDownUrl from "../../assets/icons/Smock_ChevronDown_18_N.svg";
// @ts-ignore
import chevronRightUrl from "../../assets/icons/Smock_ChevronRight_18_N.svg";
// @ts-ignore
import layersUrl from "../../assets/icons/Smock_Layers_18_N.svg";
// @ts-ignore
import selectionUrl from "../../assets/icons/Smock_Selection_18_N.svg";
// @ts-ignore
import samplerUrl from "../../assets/icons/Smock_Sampler_18_N.svg";

const SRC: Record<string, string> = {
  refresh: refreshUrl,
  revert: revertUrl,
  chevronDown: chevronDownUrl,
  chevronRight: chevronRightUrl,
  layers: layersUrl,
  selection: selectionUrl,
  sampler: samplerUrl,
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
