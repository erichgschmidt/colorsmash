// EXTREME DEBUG: bright red 24x24 box with text. Cannot be missed if Icon renders.

export type IconName = string;

export function Icon(props: { name: IconName; size?: number; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 24, height: 24,
        background: "red",
        color: "white",
        border: "2px solid yellow",
        fontSize: 14,
        textAlign: "center",
        lineHeight: "20px",
        ...props.style,
      }}
    >X</span>
  );
}
