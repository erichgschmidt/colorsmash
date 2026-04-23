// DEBUG VERSION: render a colored span so we can see if Icon is mounting at all.
// If you see colored boxes where icons should be, the component mounts but img/svg
// rendering is the issue. If you see NOTHING, the Icon component itself isn't being
// rendered (parent layout, conditional, or import problem).

const COLORS: Record<string, string> = {
  refresh: "#5fa", revert: "#fa5", chevronDown: "#a5f",
  chevronRight: "#a5f", layers: "#5af", selection: "#fa5", sampler: "#5fa",
};

export type IconName = keyof typeof COLORS;

export function Icon(props: { name: IconName; size?: number; style?: React.CSSProperties }) {
  const size = props.size ?? 14;
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        background: COLORS[props.name] ?? "#f0f",
        border: "1px solid white",
        verticalAlign: "middle",
        flexShrink: 0,
        ...props.style,
      }}
      title={props.name}
    />
  );
}
