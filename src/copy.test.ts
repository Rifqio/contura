import { expect, test } from "vitest";

/** Every shipped TSX source (tests left out). */
const TSX = Object.entries(import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>).filter(
  ([path]) => !/\.test\.tsx$/.test(path),
);

/** The text a user can read: string literals and JSX text, with comments dropped. */
function copyOf(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2]);
  // JSX text sits between a tag end or an expression end and the next tag or expression.
  for (const m of text.matchAll(/([>}][^<>{}]+)[<{]/g)) out.push(m[1]);
  return out;
}

const SPACED_UNIT = /(\d|\})\s(ms|s|min|h)\b/;

function offenders(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [path, source] of TSX) {
    for (const s of copyOf(source)) if (pattern.test(s)) found.push(`${path}: ${s.trim().slice(0, 60)}`);
  }
  return found;
}

test("no_em_dashes", () => {
  expect(offenders(/—/)).toEqual([]);
});

test("never_cursor_or_caret", () => {
  expect(offenders(/\b(cursor|caret)\b/i)).toEqual([]);
});

test("no_space_before_time_units", () => {
  expect(offenders(SPACED_UNIT)).toEqual([]);
});

test("the_scan_sees_units_after_an_expression_in_jsx_text", () => {
  const bad = copyOf("<span>Timeout {x} s</span>").filter((s) => SPACED_UNIT.test(s));
  expect(bad.length).toBe(1);
  expect(copyOf("<p>{a} and {b} min</p>").some((s) => SPACED_UNIT.test(s))).toBe(true);
  expect(copyOf("<span>Timeout {x}s</span>").some((s) => SPACED_UNIT.test(s))).toBe(false);
});

test("the_scan_reads_the_shipped_sources", () => {
  expect(TSX.length).toBeGreaterThan(20);
});

test("key_hints_use_plus", () => {
  expect(offenders(/\b(Ctrl|Alt|Shift) (Enter|Shift|Alt|Ctrl|[A-Z])\b/)).toEqual([]);
});
