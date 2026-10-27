// @vitest-environment node
// Task 14 (Decision 25): Syntax Help's rows are the language's own syntax. Each example is read by the real parser in
// its kind, the rows together use every kind word and arrow the kind has, and the copy keeps the app's rules.
import { expect, test } from "vitest";
import { ARROWS, DIAGRAM_KINDS, KINDS } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import { readPackIndex } from "../../../scripts/pack-icons.mjs";
import { SYNTAX_HELP } from "./syntaxRows";

const frameOf = (kind: string, r: { context?: string; example: string }) => `diagram ${kind} "Help"\n${r.context ?? ""}${r.example}\n`;

// The app's tsconfig has no Node types: the one Node call this test makes is typed here.
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: "node:fs"): { readFileSync(file: string): Uint8Array } } }).process.getBuiltinModule("node:fs");
/** The icon names the app ships (the packed catalogue the Core serves), so an example's icon is checked against it. */
const icons: ReadonlySet<string> = new Set((readPackIndex(fs.readFileSync("src-tauri/icons-pack/icons.bin")).icons as unknown[][]).map((row) => row[0] as string));

test("every_example_parses_clean_in_its_kind", () => {
  expect(icons.size).toBeGreaterThan(1000);
  const broken: string[] = [];
  for (const kind of DIAGRAM_KINDS)
    for (const r of SYNTAX_HELP[kind]) {
      // Clean means no problem at all: no error, no warning, no unknown icon.
      for (const p of parseFlow(frameOf(kind, r), { icons }).problems) broken.push(`${kind}: ${r.example}: ${p.severity} ${p.message}`);
    }
  expect(broken).toEqual([]);
});

test("example_icons_are_in_the_pack", () => {
  const named = DIAGRAM_KINDS.flatMap((k) => SYNTAX_HELP[k].flatMap((r) => [...r.example.matchAll(/icon:\s*([\w-]+)/g)].map((m) => m[1])));
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((n) => !icons.has(n))).toEqual([]);
});

test("each_kind_covers_its_words_and_arrows", () => {
  for (const kind of DIAGRAM_KINDS) {
    const rows = SYNTAX_HELP[kind];
    // A kind word is written in a shape's brackets: `[decision]` or `[store, id: D1]`.
    for (const word of KINDS[kind]) {
      const written = rows.some((r) => new RegExp(`\\[(?:[^\\]]*,\\s*)?${word}\\s*[,\\]]`).test(r.example));
      expect(written, `${kind} has no row with [${word}]`).toBe(true);
    }
    // An arrow counts once the parser reads it as a line in an example (a `-` in a name is not one).
    const drawn = new Set<string>();
    for (const r of rows) {
      // A context only writes shapes (and a mind map's indents, which draw tree branches), so every written line is the example's.
      expect(r.context ? (parseFlow(`diagram ${kind} "Help"\n${r.context}`).doc?.links ?? []).filter((l) => !l.tree) : [], `${kind}: ${r.example}`).toEqual([]);
      for (const l of parseFlow(frameOf(kind, r)).doc?.links ?? []) if (!l.tree) drawn.add(l.arrow);
    }
    for (const arrow of ARROWS[kind]) expect(drawn.has(arrow), `${kind} has no row drawing ${arrow}`).toBe(true);
  }
});

test("eight_to_twelve_rows_and_no_dashes", () => {
  for (const kind of DIAGRAM_KINDS) {
    const rows = SYNTAX_HELP[kind];
    expect(rows.length, kind).toBeGreaterThanOrEqual(8);
    expect(rows.length, kind).toBeLessThanOrEqual(12);
    for (const r of rows) {
      const copy = `${r.what}\n${r.example}`;
      expect(copy, kind).not.toMatch(/[–—]/);
      expect(copy.toLowerCase(), kind).not.toMatch(/\bcursor\b|\bcaret\b/);
      // Direction is a layout setting, not syntax (contradiction 2).
      expect(r.example, kind).not.toMatch(/^\s*direction\b/m);
      expect(r.what.trim(), kind).not.toBe("");
    }
    // Each row says something of its own.
    expect(new Set(rows.map((r) => r.what)).size, kind).toBe(rows.length);
  }
  // The sequence's message is `->` (contradiction 1).
  expect(SYNTAX_HELP.sequence.some((r) => /^\S.* -> /m.test(r.example))).toBe(true);
  expect(SYNTAX_HELP.sequence.some((r) => /^\s*\S+ > /m.test(r.example))).toBe(false);
  // An ER table reads one column per line (contradiction 4): no `{ }` on one line.
  expect(SYNTAX_HELP.er.some((r) => /\{[^\n]*\}/.test(r.example))).toBe(false);
  expect(SYNTAX_HELP.er.some((r) => /^orders$/.test(r.example))).toBe(true);
});
