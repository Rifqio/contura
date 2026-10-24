// ER build A: the column flags `[pk, not null, unique]` and the column edits the canvas writes. Each gesture
// is one exact line edit; every other byte of the text stays as it was.
import { describe, expect, test } from "vitest";
import { applyFlowEdit, type FlowEditOp } from "./edits";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";
import { applyFlowBatch } from "./service";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

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
  return { text: out, edits: r.edits };
};

const BILLING = lines(
  'diagram er "Billing schema"',
  "customers",
  "customers.id int [pk]",
  "customers.name text [not null]",
  "customers.email text [not null, unique] // login",
  "invoices",
  "invoices.id int [pk]",
  "",
  "customers 1--* invoices : bills",
);

describe("column flags", () => {
  test("a column line reads its flags; the row keeps its name and type", () => {
    const r = parseFlow(BILLING);
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    const customers = r.doc!.nodes.find((n) => n.name === "customers")!;
    expect(customers.rows).toEqual(["id int", "name text", "email text"]);
    expect(customers.rowFlags).toEqual([["pk"], ["not null"], ["not null", "unique"]]);
    // A table with no flags anywhere carries none.
    const plain = parseFlow(lines('diagram er "x"', "a", "a.id int")).doc!.nodes[0];
    expect(plain.rowFlags).toBeUndefined();
    // Flags on a later row fill the rows before it with none.
    const late = parseFlow(lines('diagram er "x"', "a", "a.id int", "a.code text [unique]")).doc!.nodes[0];
    expect(late.rowFlags).toEqual([[], ["unique"]]);
  });

  test("flags are read in any case and spacing; an unknown flag says so with a fix", () => {
    const r = parseFlow(lines('diagram er "x"', "a", "a.id int [PK,  Not   Null]"));
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.doc!.nodes[0].rowFlags).toEqual([["pk", "not null"]]);
    const bad = parseFlow(lines('diagram er "x"', "a", "a.id int [pkk]"));
    expect(bad.problems[0].message).toBe(MESSAGES.unknownFlag("pkk", "pk"));
    expect(bad.problems[0].fixes[0].title).toBe("Use pk");
    const open = parseFlow(lines('diagram er "x"', "a", "a.id int [pk"));
    expect(open.problems[0].message).toBe(MESSAGES.openList);
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
      BILLING.replace("customers.email text [not null, unique] // login\n", "customers.email text [not null, unique] // login\ncustomers.phone text\n"),
    );
    // Before a column, with flags and no type.
    expect(apply(BILLING, { op: "addColumn", table: "customers", at: 1, name: "code", type: "", flags: ["unique"] }).text).toBe(
      BILLING.replace("customers.name text", "customers.code [unique]\ncustomers.name text"),
    );
    // A table with no columns: after its own line.
    expect(apply(lines('diagram er "x"', "a", "b"), { op: "addColumn", table: "a", at: 0, name: "id", type: "int" }).text).toBe(lines('diagram er "x"', "a", "a.id int", "b"));
    // Indented tables keep their indent.
    expect(apply(lines('diagram er "x"', "  a", "  a.id int"), { op: "addColumn", table: "a", at: 1, name: "v", type: "text" }).text).toBe(
      lines('diagram er "x"', "  a", "  a.id int", "  a.v text"),
    );
  });

  test("addColumn is refused for a taken name (any case), a bad name or type, or an unknown table", () => {
    for (const op of [
      { op: "addColumn", table: "customers", at: 3, name: "Email", type: "text" },
      { op: "addColumn", table: "customers", at: 3, name: "two words", type: "text" },
      { op: "addColumn", table: "customers", at: 3, name: "x", type: "map<int>" },
      { op: "addColumn", table: "nobody", at: 0, name: "x", type: "int" },
    ] as LooseOp[]) {
      expect(apply(BILLING, op).edits).toEqual([]);
    }
  });

  test("setColumn renames or retypes one column in place, keeping its flags and comment", () => {
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "mail" }).text).toBe(
      BILLING.replace("customers.email text [not null, unique] // login", "customers.mail text [not null, unique] // login"),
    );
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, type: "varchar(255)" }).text).toBe(
      BILLING.replace("customers.email text [not null, unique] // login", "customers.email varchar(255) [not null, unique] // login"),
    );
    // No type leaves only the name.
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 1, type: "" }).text).toBe(BILLING.replace("customers.name text", "customers.name"));
    // A taken name is refused; the same name is no change.
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "ID" }).edits).toEqual([]);
    expect(apply(BILLING, { op: "setColumn", table: "customers", index: 2, name: "email" }).edits).toEqual([]);
  });

  test("setColumnFlag toggles one flag and writes the list as [pk, not null, unique]", () => {
    const on = (index: number, flag: "pk" | "not null" | "unique", value: boolean) =>
      apply(BILLING, { op: "setColumnFlag", table: "customers", index, flag, on: value }).text;
    // Each toggle changes its own flag only; every other flag stays (fix round 1, I7).
    expect(on(1, "pk", true)).toBe(BILLING.replace("customers.name text [not null]", "customers.name text [pk, not null]"));
    expect(on(0, "pk", false)).toBe(BILLING.replace("customers.id int [pk]", "customers.id int"));
    expect(on(2, "pk", true)).toBe(BILLING.replace("[not null, unique] // login", "[pk, not null, unique] // login"));
    expect(on(1, "not null", false)).toBe(BILLING.replace("customers.name text [not null]", "customers.name text"));
    expect(on(2, "unique", false)).toBe(BILLING.replace("[not null, unique] // login", "[not null] // login"));
    const bare = lines('diagram er "x"', "a", "a.id int");
    expect(apply(bare, { op: "setColumnFlag", table: "a", index: 0, flag: "not null", on: true }).text).toBe(lines('diagram er "x"', "a", "a.id int [not null]"));
    // Already so: no edit.
    expect(apply(BILLING, { op: "setColumnFlag", table: "customers", index: 0, flag: "pk", on: true }).edits).toEqual([]);
  });

  test("every flag toggled twice, from every combination, gives the list back (round trip)", () => {
    const all = ["pk", "not null", "unique"] as const;
    for (let mask = 0; mask < 8; mask++) {
      const flags = all.filter((_, i) => mask & (1 << i));
      const start = lines('diagram er "x"', "a", `a.e text${flags.length ? ` [${flags.join(", ")}]` : ""} // note`);
      for (const flag of all) {
        const once = apply(start, { op: "setColumnFlag", table: "a", index: 0, flag, on: !flags.includes(flag) }).text;
        expect(once).not.toBe(start);
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

  test("duplicateColumn copies a column below as name_copy, without its key", () => {
    expect(apply(BILLING, { op: "duplicateColumn", table: "customers", index: 0 }).text).toBe(
      BILLING.replace("customers.id int [pk]\n", "customers.id int [pk]\ncustomers.id_copy int [not null]\n"),
    );
    const twice = apply(apply(BILLING, { op: "duplicateColumn", table: "customers", index: 1 }).text, { op: "duplicateColumn", table: "customers", index: 1 }).text;
    expect(twice).toContain("customers.name text [not null]\ncustomers.name_copy2 text [not null]\ncustomers.name_copy text [not null]\n");
  });

  test("deleteColumn removes the one line; its comment line neighbours stay", () => {
    expect(apply(BILLING, { op: "deleteColumn", table: "customers", index: 1 }).text).toBe(BILLING.replace("customers.name text [not null]\n", ""));
  });

  test("deleteColumn takes the column's own comment with its line (M4)", () => {
    expect(apply(BILLING, { op: "deleteColumn", table: "customers", index: 2 }).text).toBe(BILLING.replace("customers.email text [not null, unique] // login\n", ""));
  });

  test("setColumn replaces only the name or only the type, keeping the spacing as written (M5)", () => {
    const t = lines('diagram er "x"', "a", "a.id   int   [pk]", "a.v");
    expect(apply(t, { op: "setColumn", table: "a", index: 0, name: "key" }).text).toBe(t.replace("a.id   int", "a.key   int"));
    expect(apply(t, { op: "setColumn", table: "a", index: 0, type: "bigint" }).text).toBe(t.replace("a.id   int", "a.id   bigint"));
    expect(apply(t, { op: "setColumn", table: "a", index: 0, type: "" }).text).toBe(t.replace("a.id   int   [pk]", "a.id   [pk]"));
    expect(apply(t, { op: "setColumn", table: "a", index: 1, type: "text" }).text).toBe(t.replace("a.v\n", "a.v text\n"));
  });

  test("renaming a table renames its column lines and its relationships in one edit list", () => {
    const r = apply(BILLING, { op: "renameNode", old: "customers", next: "clients" });
    expect(r.text).toBe(BILLING.replace(/customers/g, "clients"));
    // One batch is one change.
    const b = applyFlowBatch(BILLING, parseFlow(BILLING), [{ op: "renameNode", old: "customers", next: "clients" }]);
    expect(b.edits).toHaveLength(1);
  });
});
