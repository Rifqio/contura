// Lucide-style outlined icons (stroke 1.5 at 16 px, 1.75 at 14 px) drawn inline, so nothing is fetched at runtime.
// Paths for the frame icons below are copied from the design frames, which draw them with Lucide (ISC); send, zoom-in and zoom-out are Lucide too.
// Folder, image, search, link, flow, file query, sun, moon, monitor, triangle-alert, check and plug follow Lucide (ISC).
const f = (n: number) => String(Math.round(n * 100) / 100);
/** A rounded rectangle as path data, so every icon is a single `d`. */
const rect = (x: number, y: number, w: number, h: number, r = 0) =>
  r === 0
    ? `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`
    : `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}z`;
const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`;

const PATHS = {
  home: "M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z",
  database:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  chevronLeft: "m15 6-6 6 6 6",
  schema: "M12 4 3 8.5l9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 10v9",
  view: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  routine:
    "M9 4H7.5A2.5 2.5 0 0 0 5 6.5v3L3.5 12 5 14.5v3A2.5 2.5 0 0 0 7.5 20H9M15 4h1.5A2.5 2.5 0 0 1 19 6.5v3l1.5 2.5-1.5 2.5v3a2.5 2.5 0 0 1-2.5 2.5H15",
  trigger: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  key: "M14.5 4a5.5 5.5 0 1 1-5 7.8L4 17.3V20h3v-2h2v-2h2l1.2-1.2A5.5 5.5 0 0 1 14.5 4zM16 8.5h.01",
  // Lucide ellipsis: three r=1 rings that the stroke fills into clear 2 px dots (H4, Q3).
  more: `${circle(12, 5, 1)}${circle(12, 12, 1)}${circle(12, 19, 1)}`,
  moreHorizontal: `${circle(5, 12, 1)}${circle(12, 12, 1)}${circle(19, 12, 1)}`,
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  close: "M6 6l12 12M18 6 6 18",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  play: "M8 5.5v13l10-6.5z",
  playAll: "M4 5.5v13l7.5-6.5zM12.5 5.5v13l7.5-6.5z",
  stop: "M7 7h10v10H7z",
  pin: "M9 3.5h6l-.8 6 3.8 3.5H6l3.8-3.5zM12 13v7.5",
  history: "M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 3.8v3.8h3.8M12 7.5V12l3 2",
  save: "M5 4h11l3 3v13H5zM8.5 4v4.5h7V4M8 20v-6h8v6",
  format: "M4 6h16M4 12h10M4 18h13",
  warning:
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
  error: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 8v5M12 16v.01",
  check:
    "M20 6 9 17l-5-5",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M4.2 7.5l1.7 1M18.1 15.5l1.7 1M4.2 16.5l1.7-1M18.1 8.5l1.7-1",
  lock: `${rect(3, 11, 18, 11, 2)}M7 11V7a5 5 0 0 1 10 0v4`,
  plug:
    "M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  folder:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  image:
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  search:
    "m21 21-4.34-4.34M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  link:
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  flow:
    "M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 11v4a2 2 0 0 0 2 2h4M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
  fileQuery:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M11.5 17.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM13.3 16.3 15 18",
  sun:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  moon:
    "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401",
  monitor:
    "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 21h8M12 17v4",
  msg:
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  windowMinimize:
    "M5 12h14",
  windowMaximize:
    "M6 6h12v12H6z",
  windowRestore:
    "M8.5 8.5h9.5v9.5H8.5zM6 15.5V6h9.5",
  contura: `M3 18c2.6-.6 4.3-4.8 9-4.8s6.4 4.2 9 4.8M3 13.5c2.6-.8 4.3-7.5 9-7.5s6.4 6.7 9 7.5${circle(12, 9.6, 1.2)}`,
  grid: `${rect(3, 3, 7, 7, 1)}${rect(14, 3, 7, 7, 1)}${rect(14, 14, 7, 7, 1)}${rect(3, 14, 7, 7, 1)}`,
  gear: `M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z${circle(12, 12, 3)}`,
  paint:
    "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  keyboard: `M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10M8 12h.01${rect(2, 4, 20, 16, 2)}`,
  info: `${circle(12, 12, 10)}M12 16v-4M12 8h.01`,
  unplug:
    "m19 5 3-3M2 22l3-3M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4ZM7.5 13.5 10 11M10.5 16.5 13 14M12 6l6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z",
  duplicate: `M15 12v6M12 15h6${rect(8, 8, 14, 14, 2)}M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2`,
  folderPlus:
    "M12 10v6M9 13h6M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  trash: "M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",
  bookmark: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z",
  alert: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
  layers:
    "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83ZM22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
  send: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.5.5 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11zM21.854 2.147 10.914 13.086",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
  columns: `${rect(3, 3, 18, 18, 2)}M9 3v18`,
  export: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  // Lucide import and folder-open (ISC): Import... and Open folder.
  import: "M12 3v12M8 11l4 4 4-4M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4",
  folderOpen:
    "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
  select:
    "M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.12a.5.5 0 0 1-.95.06z",
  arrange: `${rect(3, 3, 7, 7, 1)}${rect(14, 3, 7, 7, 1)}${rect(14, 14, 7, 7, 1)}${rect(3, 14, 7, 7, 1)}`,
  zoomIn: `${circle(11, 11, 8)}m21 21-4.3-4.3M11 8v6M8 11h6`,
  zoomOut: `${circle(11, 11, 8)}m21 21-4.3-4.3M8 11h6`,
  list: "M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13",
  explain: "M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3",
  // file-code and external-link from the frames (Lucide, ISC): Preview SQL and Open in a query tab.
  fileCode: "M10 12.5 8 15l2 2.5M14 12.5l2 2.5-2 2.5M14 2v4a2 2 0 0 0 2 2h4M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  fit: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  // Visual Query: three table blocks with the lines that join them.
  visualQuery: `${rect(2, 3, 8, 6, 1)}${rect(14, 3, 8, 6, 1)}${rect(14, 15, 8, 6, 1)}M10 6h4M18 9v6`,
  // Lucide arrow-left-right and grip-vertical (ISC): Swap sides, and a row's drag handle.
  swap: "M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  grip: `${circle(9, 5, 1)}${circle(9, 12, 1)}${circle(9, 19, 1)}${circle(15, 5, 1)}${circle(15, 12, 1)}${circle(15, 19, 1)}`,
  // Diagram nodes (frame 6+.2): an outside party and the cube for an unknown icon. User and box are Lucide.
  user: `M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2${circle(12, 7, 4)}`,
  cube: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12",
  // Lineage (frame 6+.1): ban marks a key that stops a delete; arrow-left is Lucide's (ISC).
  ban: `${circle(12, 12, 10)}M4.9 4.9l14.2 14.2`,
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
  // The flow tool bar (frames 6+.2, 6+.4, 6+.5).
  square: "M5 5h14v14H5z",
  diamond: "M12 3l9 9-9 9-9-9z",
  io: "M7 5h13l-3 14H4z",
  pill: "M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z",
  boxPlus: "M16 6.5 10 3 4 6.5v7l6 3.5 6-3.5zM4 6.5l6 3.5 6-3.5M10 10v7M19 15v6M16 18h6",
  cards: "M4 6h16v12H4zM4 10h16",
  classic: "M20 6H4v12h16M8 6v12",
  tidy: "M4 6h6v5H4zM14 13h6v5h-6zM10 8.5h2a2 2 0 0 1 2 2v5",
  // A light bulb for thinking and a bolt for prompt caching, as drawn on board 11.1.
  think: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
} as const;

export type IconName = keyof typeof PATHS;

export type IconSize = 14 | 16 | 20;

/** An icon's path data on its 24 px grid, for exports that draw it as a plain SVG path. */
export const iconPath = (name: IconName): string => PATHS[name];

const strokeFor = (size: IconSize) => (size === 14 ? 1.75 : 1.5);

/** The same icon as a DOM element, for widgets drawn outside React such as editor gutters. */
export function iconElement(name: IconName, size: IconSize = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeFor(size)));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

export default function Icon({ name, className, size = 16 }: { name: IconName; className?: string; size?: IconSize }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      data-icon={name}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
