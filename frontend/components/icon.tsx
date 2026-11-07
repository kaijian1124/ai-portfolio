import type { CSSProperties } from "react";
const paths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  external: "M7 17 17 7M7 7h10v10",
  terminal: "m5 7 4 5-4 5m7 0h7",
  grid: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18",
  document: "M14 3H5v18h14V8zm0 0v5h5M8 12h8m-8 4h6",
  layers: "m12 3 10 5-10 5L2 8zm-9 10 9 5 9-5m-18 5 9 5 9-5",
  message: "M21 4H3v13h5l4 4 4-4h5zM7 9h10m-10 4h6",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a8 8 0 0 1 16 0v3",
  briefcase: "M3 7h18v14H3zm5 0V3h8v4M3 12h18m-11 0v3h4v-3",
  chart: "M4 3v18h17M8 16v-5m5 5V6m5 10v-8",
  history: "M3 4v5h5M3 9a9 9 0 1 1 0 7m9-10v6l4 2",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  check: "m5 12 4 4L19 6",
  book: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zm9 2v16",
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
