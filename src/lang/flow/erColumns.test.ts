// ER column flags (`id int pk not null unique`) and the column edits the canvas writes in table blocks. Each gesture
// is one exact line edit; every other byte of the text stays as it was.
import { describe, expect, test } from "vitest";
import { applyFlowEdit, type FlowEditOp } from "./edits";
import { parseFlow } from "./parse";
import { FIX_TITLES, MESSAGES } from "./problems";
import { applyFlowBatch } from "./service";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const errors = (t: string) => parseFlow(t).problems.filter((p) => p.severity === "error");

/** The column ops name the column they expect; a test that leaves it out means the one the text has there. */
type LooseOp = FlowEditOp | ({ op: "setColumn" | "setColumnFlag" | "duplicateColumn" | "deleteColumn"; table: string; index: number } & Record<string, unknown>) | ({ op: "addColumn"; table: string; at: number } & Record<string, unknown>);
function expect_(text: string, raw: LooseOp): FlowEditOp {
  const op = { ...raw } as Record<string, unknown>;
  const rows = parseFlow(text).doc?.nodes.find((n) => n.name === op.table)?.rows ?? [];
  const nameAt = (i: number) => (rows[i] ?? "").split(/\s/)[0];
  if (op.op === "addColumn" && !("before" in op)) op.before = (op.at as number) < rows.length ? nameAt(op.at as number) : null;
  else if (op.op !== "addColumn" && "index" in op && !("column" in op)) op.column = nameAt(op.index as number);
  return op as FlowEditOp;
}

const apply = (text: string, raw: LooseOp) => {
  const op = expect_(text, raw);
  const r = applyFlowEdit(text, parseFlow(text), op);
  let out = text;
  for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, edits: r.edits, note: r.note };
};

const BILLING = lines(
  'diagram er "Billing schema"',
  "customers {",
  "  id int pk",
  "  name text not null",
  "  email text not null unique // login",
  "}",
  "invoices {",
  "  id int pk",
  "}",
  "",
  "customers < invoices: bills",
);

describe("column flags", () => {
  test("a column line reads its flags; the row keeps its name and type", () => {
    const r = parseFlow(BILLING);
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    const customers = r.doc!.nodes.find((n) => n.name === "customers")!;
    expect(customers.rows).toEqual(["id int", "name text", "email text"]);
    expect(customers.rowFlags).toEqual([["pk"], ["not null"], ["not null", "unique"]]);
    // A table with no flags anywhere carries none.
    const plain = parseFlow(lines('diagram er "x"', "a {", "  id int", "}")).doc!.nodes[0];
    expect(plain.rowFlags).toBeUndefined();
    // Flags on a later row fill the rows before it with none.
    const late = parseFlow(lines('diagram er "x"', "a {", "  id int", "  code text unique", "}")).doc!.nodes[0];
    expect(late.rowFlags).toEqual([[], ["unique"]]);
  });

  test("flags are read in any case and spacing; an unknown flag says so with a fix", () => {
    const r = parseFlow(lines('diagram er "x"', "a {", "  id int PK  Not   Null", "}"));
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.doc!.nodes[0].rowFlags).toEqual([["pk", "not null"]]);
    const bad = parseFlow(lines('diagram er "x"', "a {", "  id int pk pkk", "}"));
    expect(bad.problems[0].message).toBe(MESSAGES.unknownFlag("pkk", "pk"));
    expect(bad.problems[0].fixes[0].title).toBe("Use pk");
    const open = parseFlow(lines('diagram er "x"', "a {", "  total decimal(10 pk", "}"));
    expect(open.problems[0].message).toBe(MESSAGES.openParen);
  });

  test("an entity line with brackets is still an entity, not a column", () => {
    const r = parseFlow(lines('diagram er "x"', "lines [weak]", "sales.orders [entity]"));
    expect(r.doc!.nodes.map((n) => [n.name, n.kind])).toEqual([
      ["lines", "weak"],
      ["sales.orders", "entity"],
    ]);
  });
});

describe("column edits", () => {
  test("addColumn inserts one line where asked, with the table's indent; nothing else changes", () => {
    // After the last column.
    expect(apply(BILLING, { op: "addColumn", table: "customers", at: 3, name: "phone", type: "text" }).text).toBe(
      BILLING.replace("  email text not null unique // login\n", "  email text not null unique // login\n  phone text\n"),
    );
    // Before a column, with flags and no type.
    expect(apply(BILLING, { op: "addColumn", table: "customers", at: 1, name: "code", type: "", flags: ["unique"] }).text).toBe(
      BILLING.replace("  name text", "  code unique\n  name text"),
    );
    // A type with spaces is quoted; flags are written in their order.
    expect(apply(BILLING, { op: "addColumn", table: "invoices", at: 1, name: "at", type: "timestamp with time zone", flags: ["unique", "not null"] }).text).toBe(
      BILLING.replace("  id int pk\n}\n\n", '  id int pk\n  at "timestamp with time zone" not null unique\n}\n\n'),
    );
    // A table with no columns, written on one line: its braces open around the column.
    expect(apply(lines('diagram er "x"', "a {}", "b"), { op: "addColumn", table: "a", at: 0, name: "id", type: "int" }).text).toBe(lines('diagram er "x"', "a {", "  id int", "}", "b"));
    // Indented tables keep their indent.
    const nested = lines('diagram er "x"', "group G {", "  a {", "    id int", "  }", "}");
    expect(apply(nested, { op: "addColumn", table: "a", at: 1, name: "v", type: "text" }).text).toBe(lines('diagram er "x"', "group G {", "  a {", "    id int", "    v text", "  }", "}"));
    const empty = lines('diagram er "x"', "group G {", "  a {", "  }", "}");
    expect(apply(empty, { op: "addColumn", table: "a", at: 0, name: "v", type: "text" }).text).toBe(lines('diagram er "x"', "group G {", "  a {", "    v text", "  }", "}"));
  });

  test("add_column_to_a_bare_table_makes_a_block", () => {
    const text = lines('diagram er "x"', "audit_log", "orders {", "  id int pk", "}");
    const out = apply(text, { op: "addColumn", table: "audit_log", at: 0, name: "at", type: "timestamptz" }).text;
    expect(out).toBe(lines('diagram er "x"', "audit_log {", "  at timestamptz", "}", "orders {", "  id int pk", "}"));
    expect(errors(out)).toEqual([]);
    // In a group, with its brackets: the block takes the table's indent.
    const grouped = lines('diagram er "x"', "group G {", "  audit_log [weak]", "}");
    expect(apply(grouped, { op: "addColumn", table: "audit_log", at: 0, name: "at", type: "", flags: ["pk"] }).text).toBe(
      lines('diagram er "x"', "group G {", "  audit_log [weak] {", "    at pk", "  }", "}"),
    );
  });

  test("addColumn is refused for a taken name (any case), a bad name or type, or an unknown table", () => {
    for (const [op, note] of [
      [{ op: "addColumn", table: "customers", at: 3, name: "Email", type: "text" }, "customers already has a column Email."],
      [{ op: "addColumn", table: "customers", at: 3, name: "two words", type: "text" }, "A column name is letters, digits and _, not starting with a digit."],
      [{ op: "addColumn", table: "customers", at: 3, name: "x", type: "decimal(10" }, "decimal(10 does not read back as one type. Check its parentheses and quotes."],
      [{ op: "addColumn", table: "customers", at: 3, name: "x", type: "two\nlines" }, "A column type is written on one line."],
      [{ op: "addColumn", table: "nobody", at: 0, name: "x", type: "int" }, "nobody is not in the text."],
    ] as [LooseOp, string][]) {
      const r = apply(BILLING, op);
      expect([r.edits, r.note]).toEqual([[], note]);
    }
    const unclosed = lines('diagram er "x"', "a {", "  id int");
    const r = apply(unclosed, { op: "addColumn", table: "a", at: 1, before: null, name: "v", type: "int" });
    expect([r.edits, r.note]).toEqual([[], "a has no closing }."]);
  });

  test("every other refused column op says why", () => {
    const note = (text: string, op: LooseOp) => {
      const r = apply(text, op);
      expect(r.edits).toEqual([]);
      return r.note;
    };
    expect(note(BILLING, { op: "setColumn", table: "customers", index: 2, name: "ID" })).toBe("customers already has a column ID.");
    expect(note(BILLING, { op: "setColumn", table: "customers", index: 2, name: "9lives" })).toBe("A column name is letters, digits and _, not starting with a digit.");
    expect(note(BILLING, { op: "deleteColumn", table: "customers", index: 9, column: "email" })).toBe("That column is no longer in the text, so nothing was changed.");
    const wrong = lines('diagram er "x"', "a {", "  id int pkk", "}");
    expect(note(wrong, { op: "setColumnFlag", table: "a", index: 0, column: "id", flag: "unique", on: true })).toBe("Fix the flag words on id first: pk, not null or unique.");
    expect(note(wrong, { op: "duplicateColumn", table: "a", index: 0, column: "id" })).toBe("Fix the flag words on id first: pk, not null or unique.");
    expect(note(BILLING, { op: "setColumnFlag", table: "customers", index: 0, column: "id", flag: "primary", on: true })).toBe("primary is not a column flag: pk, not null or unique.");
    // A table defined twice: which one is meant is unclear.
    const twice = lines('diagram er "x"', "a {", "  id int", "}", "a {", "  id int", "}");
    expect(note(twice, { op: "renameNode", old: "a", next: "b" } as LooseOp)).toBe("a is defined twice. Fix that first.");
  });

  test("setColumn renames or retypes one column in place, keeping its flags and comment", () => {
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "mail" }).text).toBe(
      BILLING.replace("  email text not null unique // login", "  mail text not null unique // login"),
    );
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, type: "varchar(255)" }).text).toBe(
      BILLING.replace("  email text not null unique // login", "  email varchar(255) not null unique // login"),
    );
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, type: "character varying" }).text).toBe(
      BILLING.replace("  email text not null unique // login", '  email "character varying" not null unique // login'),
    );
    // No type leaves the name and its flags.
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 1, type: "" }).text).toBe(BILLING.replace("  name text not null", "  name not null"));
    // A taken name is refused; the same name is no change.
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "ID" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "email" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, type: "decimal(10" }).edits).toEqual([]);
  });

  test("setColumnFlag toggles one flag and writes the words pk not null unique", () => {
    const on = (index: number, flag: "pk" | "not null" | "unique", value: boolean) =>
      apply(BILLING, { op: "setColumnFlag", table: "customers", index, flag, on: value }).text;
    // Each toggle changes its own flag only; every other flag stays.
    expect(on(1, "pk", true)).toBe(BILLING.replace("  name text not null", "  name text pk not null"));
    expect(on(0, "pk", false)).toBe(BILLING.replace("  id int pk\n  name", "  id int\n  name"));
    expect(on(2, "pk", true)).toBe(BILLING.replace("not null unique // login", "pk not null unique // login"));
    expect(on(1, "not null", false)).toBe(BILLING.replace("  name text not null", "  name text"));
    expect(on(2, "unique", false)).toBe(BILLING.replace("not null unique // login", "not null // login"));
    const bare = lines('diagram er "x"', "a {", "  id int", "}");
    expect(apply(bare, { op: "setColumnFlag", table: "a", index: 0, flag: "not null", on: true }).text).toBe(lines('diagram er "x"', "a {", "  id int not null", "}"));
    // Flags written in another case and order come back in the writer's words.
    const odd = lines('diagram er "x"', "a {", "  id int Unique  Not Null", "}");
    expect(apply(odd, { op: "setColumnFlag", table: "a", index: 0, flag: "pk", on: true }).text).toBe(lines('diagram er "x"', "a {", "  id int pk not null unique", "}"));
    // A column with no type: its flags follow its name.
    const untyped = lines('diagram er "x"', "a {", "  id pk", "}");
    expect(apply(untyped, { op: "setColumnFlag", table: "a", index: 0, flag: "pk", on: false }).text).toBe(lines('diagram er "x"', "a {", "  id", "}"));
    // Already so: no edit.
    expect(apply(BILLING, { op: "setColumnFlag", table: "customers", index: 0, flag: "pk", on: true }).edits).toEqual([]);
    // A flag written wrong is the text's problem: the toggle leaves it to the text.
    const wrong = lines('diagram er "x"', "a {", "  id int pkk", "}");
    expect(apply(wrong, { op: "setColumnFlag", table: "a", index: 0, column: "id", flag: "unique", on: true }).edits).toEqual([]);
  });

  test("every flag toggled twice, from every combination, gives the list back (round trip)", () => {
    const all = ["pk", "not null", "unique"] as const;
    for (let mask = 0; mask < 8; mask++) {
      const flags = all.filter((_, i) => mask & (1 << i));
      const start = lines('diagram er "x"', "a {", `  e text${flags.length ? ` ${flags.join(" ")}` : ""} // note`, "}");
      for (const flag of all) {
        const once = apply(start, { op: "setColumnFlag", table: "a", index: 0, flag, on: !flags.includes(flag) }).text;
        expect(once).not.toBe(start);
        expect(errors(once)).toEqual([]);
        const twice = apply(once, { op: "setColumnFlag", table: "a", index: 0, flag, on: flags.includes(flag) }).text;
        expect(twice).toBe(start);
      }
    }
  });

  test("a column op on a text that no longer has the expected column there is refused (a stale drawing)", () => {
    expect(apply(BILLING, { op: "setColumnFlag", table: "customers", index: 1, column: "email", flag: "pk", on: true }).edits).toEqual([]);
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, column: "name", name: "x" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "duplicateColumn", table: "customers", index: 0, column: "email" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "deleteColumn", table: "customers", index: 9, column: "email" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "addColumn", table: "customers", at: 1, before: "email", name: "x", type: "" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "addColumn", table: "customers", at: 2, before: null, name: "x", type: "" }).edits).toEqual([]);
  });

  test("a column op on an old frame is refused until it is rewritten as table blocks", () => {
    const old = lines('diagram er "x"', "customers", "customers.id int [pk]", "invoices {", "  id int pk", "}");
    expect(parseFlow(old).problems.some((p) => p.fixes.some((f) => f.title === FIX_TITLES.rewriteBlocks))).toBe(true);
    for (const op of [
      { op: "addColumn", table: "customers", at: 0, before: null, name: "x", type: "int" },
      { op: "addColumn", table: "invoices", at: 1, before: null, name: "x", type: "int" },
      { op: "setColumn", table: "invoices", index: 0, column: "id", name: "key" },
      { op: "setColumnFlag", table: "invoices", index: 0, column: "id", flag: "unique", on: true },
      { op: "duplicateColumn", table: "invoices", index: 0, column: "id" },
      { op: "deleteColumn", table: "invoices", index: 0, column: "id" },
      { op: "renameNode", old: "customers", next: "clients" },
    ] as LooseOp[]) {
      const r = apply(old, op);
      expect(r.edits).toEqual([]);
      expect(r.note).toBe("Rewrite this diagram as table blocks first: its first problem has the fix.");
    }
  });

  test("the parse says whether an ER frame is in the old form, a header-only frame too", () => {
    expect(parseFlow(lines('diagram er "x"')).oldEr).toBe(false);
    expect(parseFlow('diagram er "x"').oldEr).toBe(false);
    expect(parseFlow(BILLING).oldEr).toBe(false);
    expect(parseFlow(lines('diagram er "x"', "a", "a.id int")).oldEr).toBe(true);
    expect(parseFlow(lines('diagram er "x"', "a", "b", "a 1--* b")).oldEr).toBe(true);
    expect(parseFlow(lines('diagram flow "x"', "a", "a.id int")).oldEr).toBe(false);
  });

  test("an old frame refuses every edit that would write into it", () => {
    const old = lines('diagram er "x"', "customers", "customers.id int [pk]", "invoices", "customers 1--* invoices");
    for (const op of [
      { op: "addNode", name: "table", kind: null, unique: true },
      { op: "addLink", from: "customers", to: "invoices", arrow: ">" },
      { op: "setAttr", name: "customers", key: "color", value: "info" },
      { op: "deleteLink", index: 0 },
    ] as LooseOp[]) {
      const r = apply(old, op);
      expect([r.edits, r.note]).toEqual([[], "Rewrite this diagram as table blocks first: its first problem has the fix."]);
    }
  });

  test("duplicateColumn copies a column below as name_copy, without its key", () => {
    expect(apply(BILLING, { op: "duplicateColumn", table: "customers", index: 0 }).text).toBe(BILLING.replace("  id int pk\n  name", "  id int pk\n  id_copy int not null\n  name"));
    const twice = apply(apply(BILLING, { op: "duplicateColumn", table: "customers", index: 1 }).text, { op: "duplicateColumn", table: "customers", index: 1 }).text;
    expect(twice).toContain("  name text not null\n  name_copy2 text not null\n  name_copy text not null\n");
    // A quoted type is copied as written; the last column's copy goes before the }.
    const typed = lines('diagram er "x"', "a {", '  at "timestamp with time zone" unique', "}");
    expect(apply(typed, { op: "duplicateColumn", table: "a", index: 0 }).text).toBe(lines('diagram er "x"', "a {", '  at "timestamp with time zone" unique', '  at_copy "timestamp with time zone" unique', "}"));
  });

  test("deleteColumn removes the one line; its comment line neighbours stay", () => {
    expect(apply(BILLING, { op: "deleteColumn", table: "customers", index: 1 }).text).toBe(BILLING.replace("  name text not null\n", ""));
  });

  test("deleteColumn takes the column's own comment with its line (M4)", () => {
    expect(apply(BILLING, { op: "deleteColumn", table: "customers", index: 2 }).text).toBe(BILLING.replace("  email text not null unique // login\n", ""));
  });

  test("setColumn replaces only the name or only the type, keeping the spacing as written (M5)", () => {
    const t = lines('diagram er "x"', "a {", "  id   int   pk", "  v", "}");
    expect(apply(t, { op: "setColumn", table: "a", index: 0, name: "key" }).text).toBe(t.replace("  id   int", "  key   int"));
    expect(apply(t, { op: "setColumn", table: "a", index: 0, type: "bigint" }).text).toBe(t.replace("  id   int", "  id   bigint"));
    expect(apply(t, { op: "setColumn", table: "a", index: 0, type: "" }).text).toBe(t.replace("  id   int   pk", "  id   pk"));
    expect(apply(t, { op: "setColumn", table: "a", index: 1, type: "text" }).text).toBe(t.replace("  v\n", "  v text\n"));
  });

  test("renaming a table renames its relationship ends in one edit list", () => {
    const r = apply(BILLING, { op: "renameNode", old: "customers", next: "clients" });
    expect(r.text).toBe(BILLING.replace(/customers/g, "clients"));
    // One batch is one change.
    const b = applyFlowBatch(BILLING, parseFlow(BILLING), [{ op: "renameNode", old: "customers", next: "clients" }]);
    expect(b.edits).toHaveLength(1);
  });

  test("deleting a table takes its whole block and its relationships", () => {
    const out = apply(BILLING, { op: "deleteNode", name: "customers" }).text;
    expect(out).toBe(lines('diagram er "Billing schema"', "invoices {", "  id int pk", "}", ""));
    expect(errors(out)).toEqual([]);
  });

  test("moving a table into a group moves its whole block", () => {
    const text = lines('diagram er "x"', "group G {", "}", "orders {", "  id int pk // key", "}");
    const out = apply(text, { op: "moveToGroup", name: "orders", group: "G" }).text;
    expect(out).toBe(lines('diagram er "x"', "group G {", "  orders {", "    id int pk // key", "  }", "}"));
    expect(parseFlow(out).parentOf("orders")).toBe("G");
    expect(apply(out, { op: "moveToGroup", name: "orders", group: null }).text).toBe(lines('diagram er "x"', "group G {", "}", "orders {", "  id int pk // key", "}"));
  });
});
