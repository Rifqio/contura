/** The board's glyphs on a 24 px grid, drawn like `Icon`. */
const GLYPHS = {
  lock: ["M5 12.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z", "M8 10.5V8a4 4 0 0 1 8 0v2.5"],
  shield: ["M12 3.5 5 6v5.5c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6z", "M9 12l2.2 2.2L15.5 10"],
  spark: ["M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9z", "M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"],
  down: ["M12 4v11M7.5 10.5 12 15l4.5-4.5", "M5 19.5h14"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  arrow: ["M5 12h14M13 6l6 6-6 6"],
  back: ["M19 12H5M11 6l-6 6 6 6"],
  moon: ["M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"],
  sun: ["M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"],
  db: [
    "M4.5 5.5a7.5 2.5 0 1 0 15 0a7.5 2.5 0 1 0-15 0",
    "M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13",
    "M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5",
  ],
  file: [
    "M14 3.5H6.5v17h11V7z",
    "M14 3.5V7h3.5",
    "M8.5 12a3.5 1.2 0 1 0 7 0a3.5 1.2 0 1 0-7 0",
    "M8.5 12v4c0 .7 1.6 1.2 3.5 1.2s3.5-.5 3.5-1.2v-4",
  ],
  alert: ["M12 4 2.8 19.5h18.4z", "M12 10v4.5M12 17.2v.1"],
  guide: ["M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0", "M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.5v.5M12 16.6v.1"],
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size, className }: { name: GlyphName; size: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
