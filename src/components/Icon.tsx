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
  play: "M8 5.5v13l10-6.5z",
  playAll: "M4 5.5v13l7.5-6.5zM12.5 5.5v13l7.5-6.5z",
  stop: "M7 7h10v10H7z",
  pin: "M9 3.5h6l-.8 6 3.8 3.5H6l3.8-3.5zM12 13v7.5",
  history: "M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 3.8v3.8h3.8M12 7.5V12l3 2",
  save: "M5 4h11l3 3v13H5zM8.5 4v4.5h7V4M8 20v-6h8v6",
  format: "M4 6h16M4 12h10M4 18h13",
  sparkle:
    "M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  warning: "M12 4 21 19.5H3zM12 10v4.5M12 17v.01",
  error: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 8v5M12 16v.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M4.2 7.5l1.7 1M18.1 15.5l1.7 1M4.2 16.5l1.7-1M18.1 8.5l1.7-1",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  plug: "M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
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
