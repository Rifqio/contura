import { expect, test } from "vitest";

const TSX = Object.entries(import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>).filter(
  ([path]) => !/\.test\.tsx$/.test(path),
);

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

test("the_scan_reads_the_shipped_sources", () => {
  expect(TSX.length).toBeGreaterThan(20);
});

test("no_bare_kbd_elements", () => {
  const bare = (s: string) => /<kbd\b/.test(s) || /className="kbd"/.test(s) || /createElement\(\s*"kbd"/.test(s) || /\.className = "kbd"/.test(s);
  const bad = TSX.filter(([p, s]) => base(p) !== "Kbd.tsx" && bare(s)).map(([p]) => base(p));
  expect(bad).toEqual([]);
});

test("no_native_select_anywhere", () => {
  // Every list is the themed Select (Task 23 removed the last native ones).
  const bad = TSX.filter(([, s]) => /<select\b/.test(s)).map(([p]) => base(p));
  expect(bad).toEqual([]);
});
