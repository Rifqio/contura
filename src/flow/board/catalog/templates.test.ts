import { describe, expect, it } from "vitest";
import { DIAGRAM_KINDS, type DiagramKind } from "../../../lang/flow/model";
import { parseBoard } from "../../../lang/flow/board";
import { parseFlow } from "../../../lang/flow/parse";
import fixtureRaw from "../../../../crates/contura-core/tests/fixtures/flow/catalog_icons.json?raw";
import kindsSrc from "./kinds.ts?raw";
import { KIND_HEAD } from "../chips";
import { KIND_WORDS, SHELF_KINDS } from "./kinds";
import { BOARD_TEMPLATES, type BoardTemplate, SINGLE_TEMPLATES, templateById, templateIconNames } from "./templates";

const header = (frame: string) => /^diagram (\w+) "([^"]*)"/.exec(frame)!;
const body = (frame: string) => frame.split("\n").slice(1).join("\n");
/** The `table.column` names a frame's body writes: only a known table's name, so "e.g." or "v1.2" is never a ref. */
const refs = (text: string, tables: Set<string>) =>
  [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].filter((m) => tables.has(m[1])).map((m) => `${m[1]}.${m[2]}`);
/** An ER frame's relation lines: `a.x > b.y`, with `<`, `-` and `<>` too. */
const relations = (frame: string) => [...body(frame).matchAll(/^(\w+\.\w+) (?:>|<|-|<>) (\w+\.\w+)(?:: .*)?$/gm)].map((m) => [m[1], m[2]]);
/** The columns of an ER frame's table blocks, as `table.column`. */
function erColumns(frame: string): Set<string> {
  const out = new Set<string>();
  let table: string | null = null;
  for (const line of body(frame).split("\n")) {
    const open = /^(\w+)(?: \[[^\]]*\])? \{$/.exec(line);
    if (open) table = open[1];
    else if (line === "}") table = null;
    else if (table && /^ {2}(\w+)/.test(line)) out.add(`${table}.${/^ {2}(\w+)/.exec(line)![1]}`);
  }
  return out;
}

describe("the catalog", () => {
  it("every_template_parses_clean", () => {
    for (const b of BOARD_TEMPLATES) expect(parseBoard(b.frames.join("\n")).problems, b.name).toEqual([]);
    for (const s of SINGLE_TEMPLATES) {
      const p = parseFlow(s.text);
      expect(p.problems, s.name).toEqual([]);
    }
  });

  it("board_frames_agree", () => {
    for (const b of BOARD_TEMPLATES) {
      const er = b.frames.filter((f) => header(f)[1] === "er");
      expect(er.length, b.name).toBe(1);
      const cols = erColumns(er[0]);
      expect(cols.size, b.name).toBeGreaterThan(4);
      const tables = new Set([...cols].map((c) => c.split(".")[0]));
      for (const f of b.frames) {
        if (header(f)[1] === "er") continue;
        const named = refs(body(f), tables);
        expect(named.length, `${b.name}: ${header(f)[2]}`).toBeGreaterThan(0);
        for (const r of named) expect(cols.has(r), `${b.name}: ${r}`).toBe(true);
      }
    }
  });

  it("er_relations_name_declared_columns", () => {
    const ers = [...BOARD_TEMPLATES.flatMap((b) => b.frames), ...SINGLE_TEMPLATES.map((s) => s.text)].filter((f) => header(f)[1] === "er");
    expect(ers).toHaveLength(8);
    for (const f of ers) {
      const cols = erColumns(f);
      const rel = relations(f);
      expect(rel.length, header(f)[2]).toBeGreaterThan(0);
      for (const end of rel.flat()) expect(cols.has(end), `${header(f)[2]}: ${end}`).toBe(true);
    }
    const all = SINGLE_TEMPLATES.filter((s) => s.kind === "er").map((s) => s.text).join("\n");
    expect(all).toMatch(/ <> /);
    expect(all).toMatch(/ < /);
  });

  it("the_list_is_the_plan_list", () => {
    const titles = (b: BoardTemplate) => b.frames.map((f) => header(f)[2]);
    expect(BOARD_TEMPLATES.map((b) => [b.name, b.line, titles(b)])).toEqual([
      ["Online shop", "Checkout, orders and payment", ["Orders ERD", "Checkout flow", "Pay sequence"]],
      ["SaaS sign-up", "Accounts, onboarding and sign-in", ["Teams ERD", "Onboarding flow", "Auth sequence"]],
      ["Support desk", "Tickets from inbox to closed", ["Tickets ERD", "Triage flow", "Ticket states"]],
    ]);
    const names = (k: DiagramKind) => SINGLE_TEMPLATES.filter((s) => s.kind === k).map((s) => s.name);
    expect(names("er")).toEqual(["Online store orders", "Invoices and payments", "Multi-tenant SaaS accounts", "Inventory and warehouses", "Bookings and calendars"]);
    expect(names("flow")).toEqual(["Deploy pipeline", "Password reset", "Refund request", "Feature flag rollout", "Incident triage"]);
    expect(names("cloud")).toEqual(["Web app on AWS", "Queue workers on Kubernetes", "Static site behind a CDN", "Event pipeline on Google Cloud"]);
    expect(names("sequence")).toEqual(["OAuth sign-in", "Card payment", "Webhook delivery", "File upload to object storage", "Read-through cache"]);
    expect([names("dfd"), names("state"), names("class"), names("mindmap"), names("timeline")]).toEqual([
      ["Order handling"],
      ["Invoice states"],
      ["Invoice classes"],
      ["Quarter plan"],
      ["Release plan"],
    ]);
    expect(SINGLE_TEMPLATES).toHaveLength(24);
    for (const s of SINGLE_TEMPLATES) expect(s.text.startsWith(`diagram ${s.kind} "${s.name}"\n`), s.name).toBe(true);
  });

  it("frame_titles_are_unique_in_each_board", () => {
    for (const b of BOARD_TEMPLATES) {
      const t = b.frames.map((f) => header(f)[2]);
      expect(new Set(t).size, b.name).toBe(t.length);
    }
  });

  it("ids_are_unique_and_found", () => {
    const ids = [...BOARD_TEMPLATES.map((b) => b.id), ...SINGLE_TEMPLATES.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BOARD_TEMPLATES) expect(templateById(b.id)).toBe(b);
    for (const s of SINGLE_TEMPLATES) expect(templateById(s.id)).toBe(s);
    expect(templateById("nope")).toBeNull();
  });

  it("the_icon_fixture_matches_the_templates", () => {
    const fixture = JSON.parse(fixtureRaw) as string[];
    expect(templateIconNames()).toEqual(fixture);
    expect(fixture.length).toBeGreaterThan(10);
  });

  it("shelf_kinds_are_the_spec_order_and_name_nothing", () => {
    expect([...SHELF_KINDS].sort()).toEqual([...DIAGRAM_KINDS].sort());
    const src = kindsSrc;
    for (const k of DIAGRAM_KINDS) expect(src).not.toContain(`"${KIND_HEAD[k].name}"`);
    expect(Object.keys(KIND_WORDS).sort()).toEqual([...DIAGRAM_KINDS].sort());
  });

  it("no_dash_or_banned_word_in_catalog_copy", () => {
    const copy = [
      ...BOARD_TEMPLATES.flatMap((b) => [b.name, b.line, ...b.frames]),
      ...SINGLE_TEMPLATES.flatMap((s) => [s.name, s.text]),
      ...Object.values(KIND_WORDS),
    ].join("\n");
    expect(copy).not.toMatch(/[–—]/);
    expect(copy).not.toMatch(/\b(cursor|caret)\b/i);
  });
});
