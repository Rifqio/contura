// @vitest-environment node
// Plan D Decision 6 (A18, amended 28 Oct): the grammar card the board prompt carries is Syntax Help's own rows. Each card
// row equals a one-line SYNTAX_HELP row of its kind and parses clean there (after its context); every kind has its rows.
import { expect, test } from "vitest";
import card from "../../../crates/contura-core/src/ai/grammar_card.json";
import { DIAGRAM_KINDS } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import { readPackIndex } from "../../../scripts/pack-icons.mjs";
import { type HelpRow, SYNTAX_HELP } from "../board/syntaxRows";

type CardRow = { what: string; example: string };
const CARD = card as Record<string, CardRow[]>;

// The app's tsconfig has no Node types: the one Node call this test makes is typed here.
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: "node:fs"): { readFileSync(file: string): Uint8Array } } }).process.getBuiltinModule("node:fs");
/** The icon names the app ships, so an example's icon is checked as Syntax Help's are. */
const icons: ReadonlySet<string> = new Set((readPackIndex(fs.readFileSync("src-tauri/icons-pack/icons.bin")).icons as unknown[][]).map((row) => row[0] as string));

/** The Syntax Help row a card row copies, if any. */
const helpRow = (kind: string, r: CardRow): HelpRow | undefined => SYNTAX_HELP[kind as keyof typeof SYNTAX_HELP]?.find((h) => h.what === r.what && h.example === r.example);

/** The ER rows the controller picked (A18 amended): its lines rows, with a label on a line over many to many. */
const ER_ROWS = ["A table", "A label and a colour", "Many to one", "One to many", "One to one", "A label on a line"];

/**
 * A18 as amended (28 Oct): every one-line row of the kind, with or without context (context is only what the parse
 * test writes first), in Syntax Help's order, at most 6; ER takes `ER_ROWS`.
 */
function expectedRows(kind: keyof typeof SYNTAX_HELP): CardRow[] {
  const oneLine = SYNTAX_HELP[kind].filter((r) => !r.example.includes("\n"));
  const picked = kind === "er" ? ER_ROWS.map((w) => oneLine.find((r) => r.what === w)!) : oneLine.slice(0, 6);
  return picked.map(({ what, example }) => ({ what, example }));
}

test("every_card_example_parses_clean_in_its_kind", () => {
  const broken: string[] = [];
  for (const kind of DIAGRAM_KINDS)
    for (const r of CARD[kind] ?? []) {
      const h = helpRow(kind, r);
      const text = `diagram ${kind} "Card"\n${h?.context ?? ""}${r.example}\n`;
      for (const p of parseFlow(text, { icons }).problems) broken.push(`${kind}: ${r.example}: ${p.severity} ${p.message}`);
    }
  expect(broken).toEqual([]);
});

test("every_card_row_is_a_syntax_help_row", () => {
  for (const kind of DIAGRAM_KINDS)
    for (const r of CARD[kind] ?? []) {
      expect(Object.keys(r).sort(), `${kind}: ${r.example}`).toEqual(["example", "what"]);
      expect(helpRow(kind, r), `${kind}: ${r.what}`).toBeDefined();
      expect(r.example, kind).not.toContain("\n");
    }
});

test("the_card_covers_every_kind", () => {
  expect(Object.keys(CARD)).toEqual([...DIAGRAM_KINDS]);
  for (const kind of DIAGRAM_KINDS) {
    expect(CARD[kind].length, kind).toBeGreaterThanOrEqual(2);
    expect(CARD[kind].length, kind).toBeLessThanOrEqual(6);
    expect(CARD[kind], kind).toEqual(expectedRows(kind));
  }
});
