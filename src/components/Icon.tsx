// Outlined, regular-weight icons drawn inline, so nothing is fetched at runtime.
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
  more: "M12 6h.01M12 12h.01M12 18h.01",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
