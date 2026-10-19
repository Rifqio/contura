// Contura's large feature icons (item 16, the approved v1 set from the menu revamp frames): 32 px drawings in the
// interface's line colour, each with one area or stroke in its family's hue, so a feature is found by shape and
// colour. Drawn inline from these parts; nothing is fetched. Families: query (write and ask), obj (database
// objects), data (moving rows), safe (backups), vis (diagrams and models).
import { createElement } from "react";

type Part = readonly ["path" | "rect" | "circle" | "ellipse", "h" | "k" | "hs" | null, Readonly<Record<string, string | number>>];

const PARTS = {
  query: [
    ["path", null, { d: "M17 27.5H9V4.5h10l5.5 5.5V17.5" }],
    ["path", null, { d: "M19 4.5V10h5.5" }],
    ["path", null, { d: "M12.5 14.5h8M12.5 18.5h4.5" }],
    ["circle", "h", { cx: 23.5, cy: 24, r: 5.75 }],
    ["path", "k", { d: "M23.5 21.25v5.5M20.75 24h5.5" }],
  ],
  vquery: [
    ["rect", "h", { x: 3.5, y: 5.5, width: 12, height: 4, rx: 1.5 }],
    ["rect", null, { x: 3.5, y: 5.5, width: 12, height: 10, rx: 2 }],
    ["rect", "h", { x: 16.5, y: 16.5, width: 12, height: 4, rx: 1.5 }],
    ["rect", null, { x: 16.5, y: 16.5, width: 12, height: 10, rx: 2 }],
    ["path", null, { d: "M15.5 12.5H18a2.5 2.5 0 0 1 2.5 2.5v1.5" }],
  ],
  table: [
    ["path", "h", { d: "M4.5 11V9A2.5 2.5 0 0 1 7 6.5h18A2.5 2.5 0 0 1 27.5 9v2z" }],
    ["rect", null, { x: 4.5, y: 6.5, width: 23, height: 19, rx: 2.5 }],
    ["path", null, { d: "M4.5 11h23M4.5 18.25h23M12 11v14.5M20 11v14.5" }],
  ],
  view: [
    ["rect", null, { x: 4.5, y: 6.5, width: 23, height: 19, rx: 2.5 }],
    ["path", null, { d: "M4.5 11h23" }],
    ["path", null, { d: "M9 18.5s2.8-4.5 7-4.5 7 4.5 7 4.5-2.8 4.5-7 4.5-7-4.5-7-4.5z" }],
    ["circle", "h", { cx: 16, cy: 18.5, r: 2.4 }],
  ],
  "function": [
    ["rect", "h", { x: 5, y: 5, width: 22, height: 22, rx: 5 }],
    ["path", "k", { d: "M19 9.5h-1.25A2.25 2.25 0 0 0 15.5 11.75v8.5A2.25 2.25 0 0 1 13.25 22.5H12M12.5 15h6.5" }],
  ],
  designer: [
    ["path", "h", { d: "M4.5 11V9A2.5 2.5 0 0 1 7 6.5h14A2.5 2.5 0 0 1 23.5 9v2z" }],
    ["path", null, { d: "M15 22.5H7A2.5 2.5 0 0 1 4.5 20V9A2.5 2.5 0 0 1 7 6.5h14A2.5 2.5 0 0 1 23.5 9v5" }],
    ["path", null, { d: "M4.5 11h19M11 11v11.5" }],
    ["path", "hs", { d: "M26.6 17.4a1.9 1.9 0 0 0-2.7 0l-6.4 6.4-.9 3.6 3.6-.9 6.4-6.4a1.9 1.9 0 0 0 0-2.7z" }],
  ],
  model: [
    ["path", "h", { d: "M16 4.5 28 10.5 16 16.5 4 10.5z" }],
    ["path", null, { d: "M16 4.5 28 10.5 16 16.5 4 10.5z" }],
    ["path", null, { d: "M4 16l12 6 12-6M4 21.5l12 6 12-6" }],
  ],
  diagram: [
    ["rect", "h", { x: 4, y: 4.5, width: 10, height: 9, rx: 2 }],
    ["rect", null, { x: 4, y: 4.5, width: 10, height: 9, rx: 2 }],
    ["rect", null, { x: 18, y: 18.5, width: 10, height: 9, rx: 2 }],
    ["path", null, { d: "M14 9h3.5A2.5 2.5 0 0 1 20 11.5v4.5M17.5 14l2.5 2.5 2.5-2.5" }],
  ],
  compare: [
    ["rect", "h", { x: 17.5, y: 12.5, width: 10.5, height: 4 }],
    ["rect", null, { x: 4, y: 5.5, width: 10.5, height: 21, rx: 2 }],
    ["rect", null, { x: 17.5, y: 5.5, width: 10.5, height: 21, rx: 2 }],
    ["path", null, { d: "M7 10.5h4.5M7 14.5h4.5M7 18.5h4.5M20.5 9.25h4.5M20.5 20.5h4.5" }],
  ],
  import: [
    ["path", null, { d: "M5 19.5v5a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-5" }],
    ["path", "hs", { d: "M16 4.5v14M10.5 13l5.5 5.5 5.5-5.5" }],
  ],
  export: [
    ["path", null, { d: "M5 19.5v5a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-5" }],
    ["path", "hs", { d: "M16 18.5v-14M10.5 10l5.5-5.5 5.5 5.5" }],
  ],
  transfer: [
    ["ellipse", null, { cx: 7.75, cy: 9, rx: 3.75, ry: 1.75 }],
    ["path", null, { d: "M4 9v14c0 1 1.7 1.75 3.75 1.75S11.5 24 11.5 23V9" }],
    ["ellipse", null, { cx: 24.25, cy: 9, rx: 3.75, ry: 1.75 }],
    ["path", null, { d: "M20.5 9v14c0 1 1.7 1.75 3.75 1.75S28 24 28 23V9" }],
    ["path", "hs", { d: "M14 16h4.5M16.25 13l3 3-3 3" }],
  ],
  backup: [
    ["ellipse", null, { cx: 14, cy: 8, rx: 8.5, ry: 3 }],
    ["path", null, { d: "M5.5 8v14c0 1.66 3.8 3 8.5 3M22.5 8v7M5.5 15c0 1.66 3.8 3 8.5 3" }],
    ["circle", "h", { cx: 23.5, cy: 23.5, r: 5.75 }],
    ["path", "k", { d: "M23.5 20.5v5.5M21.25 23.75l2.25 2.25 2.25-2.25" }],
  ],
  restore: [
    ["ellipse", null, { cx: 14, cy: 8, rx: 8.5, ry: 3 }],
    ["path", null, { d: "M5.5 8v14c0 1.66 3.8 3 8.5 3M22.5 8v7M5.5 15c0 1.66 3.8 3 8.5 3" }],
    ["circle", "h", { cx: 23.5, cy: 23.5, r: 5.75 }],
    ["path", "k", { d: "M21 23.5a2.5 2.5 0 1 0 .9-1.9M21.5 20.5v1.6h1.6" }],
  ],
  ask: [
    ["path", null, { d: "M6 5.5h20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H14l-5 4v-4H6a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2z" }],
    ["path", "h", { d: "M12 10.5c0-1 1.8-1.75 4-1.75s4 .75 4 1.75v6.5c0 1-1.8 1.75-4 1.75s-4-.75-4-1.75z" }],
    ["path", "k", { d: "M12 10.5c0 1 1.8 1.75 4 1.75s4-.75 4-1.75M12 13.75c0 1 1.8 1.75 4 1.75s4-.75 4-1.75" }],
  ],
  history: [
    ["path", null, { d: "M5.5 16A10.5 10.5 0 1 0 8.6 8.6" }],
    ["path", null, { d: "M5 5.5v4.75h4.75" }],
    ["path", "hs", { d: "M16 10v6l4 2.5" }],
  ],
  home: [
    ["path", null, { d: "M4.5 14.5 16 5l11.5 9.5" }],
    ["path", null, { d: "M8 12v13.5h16V12" }],
    ["rect", "h", { x: 13.5, y: 18, width: 5, height: 7.5, rx: 1 }],
  ],
  connection: [
    ["path", "h", { d: "M10 10.5h12v4.5a6 6 0 0 1-12 0z" }],
    ["path", null, { d: "M13 4.5v6M19 4.5v6M16 21v6.5" }],
  ],
} satisfies Record<string, readonly Part[]>;

export type FeatureIconName = keyof typeof PARTS;
export type FeatureFamily = "query" | "obj" | "data" | "safe" | "vis" | "none";

/** Each icon's family, which sets its hue. */
export const FEATURE_FAMILY: Record<FeatureIconName, FeatureFamily> = {
  query: "query",
  vquery: "query",
  ask: "query",
  history: "query",
  table: "obj",
  view: "obj",
  function: "obj",
  designer: "obj",
  connection: "obj",
  import: "data",
  export: "data",
  transfer: "data",
  backup: "safe",
  restore: "safe",
  compare: "vis",
  model: "vis",
  diagram: "vis",
  home: "none",
};

const CLASS = { h: "fi-h", k: "fi-k", hs: "fi-hs" } as const;

/** A feature icon at `size` px (28 in the feature bar and menu tiles, 18 beside Home, 16 in tabs). */
export default function FeatureIcon({ name, size = 28, className }: { name: FeatureIconName; size?: number; className?: string }) {
  return (
    <svg
      className={`feature-icon fi-${FEATURE_FAMILY[name]}${className ? ` ${className}` : ""}`}
      data-feature={name}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {(PARTS[name] as readonly Part[]).map(([tag, cls, attrs], i) => createElement(tag, { key: i, className: cls ? CLASS[cls] : undefined, ...attrs }))}
    </svg>
  );
}
