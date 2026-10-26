// Relationships between columns: `invoices.customer_id > customers.id` joins two columns; a table-to-table line
// (`customers < invoices`) still reads and draws. Renaming a table or a column rewrites the lines that name it, and
// deleting a column deletes its relationships, each as one edit list.
import { describe, expect, test } from "vitest";
import { copyLines, pasteLines } from "./clip";
import { applyFlowEdit, type FlowEditOp, findLink, linkRefOf } from "./edits";
import { insertFlow } from "./insert";
import { sqlFreeName } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";
import { applyEdits, applyFlowBatch } from "./service";
import { writeFlow } from "../../flow/flowModel";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const BILLING = lines(
  'diagram er "Billing"',
  "customers {",
  "  id int pk",
  "  name text",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int not null",
  "}",
  "",
  "invoices.customer_id > customers.id",
);

const run = (text: string, op: FlowEditOp) => applyEdits(text, applyFlowEdit(text, parseFlow(text), op).edits);
const errors = (text: string) => parseFlow(text).problems.filter((p) => p.severity === "error");
const refOf = (text: string, i: number) => linkRefOf(parseFlow(text).doc!.links, i)!;

/** One relationship fanned to two tables: `orders.customer_id > customers.id, clients.id`. */
const FAN = lines(
  'diagram er "Fan"',
  "orders {",
  "  id int pk",
  "  customer_id int",
  "}",
  "customers {",
  "  id int pk",
  "}",
  "clients {",
  "  id int pk",
  "}",
  "orders.customer_id > customers.id, clients.id",
);

describe("reading column relationships", () => {
  test("an old file's table-to-table line reads as before, with no columns", () => {
    const text = lines('diagram er "Billing"', "customers {", "  id int pk", "}", "invoices", "", "customers < invoices: bills");
    const r = parseFlow(text);
    expect(errors(text)).toEqual([]);
    expect(r.doc!.links).toEqual([{ from: "customers", to: "invoices", arrow: "<", label: "bills" }]);
  });

  test("fix 1: an old file reads with no problem, and a table added to it changes only its own line, after the last table's columns", () => {
    const text = lines('diagram er "Billing"', "", "customers {", "  id int pk", "}", "invoices {", "  id int pk", "}", "", "customers < invoices: bills");
    expect(parseFlow(text).problems).toEqual([]);
    const r = applyFlowEdit(text, parseFlow(text), { op: "addNode", name: "table", kind: null, unique: true });
    expect(r.name).toBe("table_1");
    expect(applyEdits(text, r.edits)).toBe(text.replace("  id int pk\n}\n\n", "  id int pk\n}\ntable_1\n\n"));
  });

  test("a_new_table_goes_after_the_last_block", () => {
    const text = lines('diagram er "x"', "orders {", "  id int pk", "}", "// the end of the tables", "orders > orders");
    const r = applyFlowEdit(text, parseFlow(text), { op: "addNode", name: "table", kind: "weak", unique: true });
    const out = applyEdits(text, r.edits);
    expect(out).toBe(lines('diagram er "x"', "orders {", "  id int pk", "}", "table_1 [weak]", "// the end of the tables", "orders > orders"));
    expect(errors(out)).toEqual([]);
    // Numbered from 1, past every number taken in any case.
    const next = applyFlowEdit(out, parseFlow(out), { op: "addNode", name: "table", kind: null, unique: true });
    expect(next.name).toBe("table_2");
  });

  test("table.column at both ends joins the two columns; the line's ends are the tables", () => {
    const r = parseFlow(BILLING);
    expect(errors(BILLING)).toEqual([]);
    expect(r.doc!.links).toEqual([{ from: "invoices", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" }]);
  });

  test("a line may come before the columns it names, and one end may be a whole table", () => {
    const text = lines('diagram er "x"', "a.b_id - b: refers", "a {", "  b_id int", "}", "b {", "  id int pk", "}");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links).toEqual([{ from: "a", fromColumn: "b_id", to: "b", arrow: "-", label: "refers" }]);
  });

  test("a self relationship joins two columns of one table", () => {
    const text = lines('diagram er "x"', "staff {", "  id int pk", "  manager_id int", "}", "staff.manager_id > staff.id");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links[0]).toEqual({ from: "staff", fromColumn: "manager_id", to: "staff", toColumn: "id", arrow: ">" });
  });

  test("a column the table does not have is a problem that names it", () => {
    const text = lines('diagram er "x"', "a {", "  id int", "}", "b {", "  id int", "}", "a.nope - b.id");
    const p = errors(text);
    expect(p.map((x) => x.message)).toEqual([MESSAGES.noColumn("a", "nope")]);
    expect(text.slice(p[0].from, p[0].to)).toBe("a.nope");
  });

  test("a dotted name that is a node of its own stays that node", () => {
    const text = lines('diagram er "x"', "sales.orders [entity]", "sales {", "  id int", "}", "sales.orders - sales");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links[0]).toEqual({ from: "sales.orders", to: "sales", arrow: "-" });
  });

  test("a name before the dot that is no table is still not defined", () => {
    const text = lines('diagram er "x"', "a {", "  id int", "}", "ghost.id - a.id");
    expect(errors(text).map((x) => x.message)).toEqual([MESSAGES.notDefined("ghost.id")]);
  });
});

describe("writing column relationships", () => {
  test("a new relationship between columns is one line after the last line", () => {
    const text = BILLING.replace("invoices.customer_id > customers.id\n", "");
    expect(run(text, { op: "addLink", from: "invoices", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" })).toBe(`${text}invoices.customer_id > customers.id\n`);
    // A column the table lacks, an arrow ER does not draw, or an end that would read as another table's: refused.
    expect(run(text, { op: "addLink", from: "invoices", fromColumn: "nope", to: "customers", toColumn: "id", arrow: ">" })).toBe(text);
    expect(run(text, { op: "addLink", from: "invoices", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: "--" })).toBe(text);
  });

  test("renaming a table rewrites only the table's part of each column end", () => {
    const out = run(BILLING, { op: "renameNode", old: "customers", next: "clients" });
    expect(out).toBe(BILLING.replace(/^customers/gm, "clients").replace("> customers.id", "> clients.id"));
    expect(out.endsWith("invoices.customer_id > clients.id\n")).toBe(true);
    expect(errors(out)).toEqual([]);
  });

  test("renaming a schema-qualified table keeps its column ends on it", () => {
    const text = lines(
      'diagram er "x"',
      "sales {",
      "  id int pk",
      "}",
      "sales.orders {",
      "  id int pk",
      "  customer_id int",
      "}",
      "sales.customers {",
      "  id int pk",
      "}",
      "sales.orders.customer_id > sales.customers.id",
      "sales.orders.id - sales.id",
    );
    expect(errors(text)).toEqual([]);
    const out = run(text, { op: "renameNode", old: "sales.customers", next: "crm.customers" });
    expect(out).toBe(text.replace("sales.customers {", "crm.customers {").replace("> sales.customers.id", "> crm.customers.id"));
    expect(errors(out)).toEqual([]);
    expect(parseFlow(out).doc!.links[0]).toEqual({ from: "sales.orders", fromColumn: "customer_id", to: "crm.customers", toColumn: "id", arrow: ">" });
    const moved = run(text, { op: "renameNode", old: "sales.orders", next: "shop.orders" });
    expect(moved).toBe(text.replace("sales.orders {", "shop.orders {").replace("sales.orders.customer_id >", "shop.orders.customer_id >").replace("sales.orders.id -", "shop.orders.id -"));
    expect(parseFlow(moved).doc!.links).toEqual([
      { from: "shop.orders", fromColumn: "customer_id", to: "sales.customers", toColumn: "id", arrow: ">" },
      { from: "shop.orders", fromColumn: "id", to: "sales", toColumn: "id", arrow: "-" },
    ]);
    // A name whose ends would not read back as this table's columns is refused: one that needs quotes, or one a
    // longer table name would take over.
    const quoted = applyFlowEdit(text, parseFlow(text), { op: "renameNode", old: "sales.customers", next: "crm: customers" });
    expect([quoted.edits, quoted.note]).toEqual([[], "crm: customers needs quotes, and a table with column relationships cannot have them. Use letters, digits, _ and dots."]);
    const taken = applyFlowEdit(text, parseFlow(text), { op: "renameNode", old: "sales", next: "sales.orders.id" });
    expect([taken.edits, taken.note]).toEqual([[], "Renamed sales.orders.id, sales.orders.id would point at another table, so nothing was renamed."]);
  });

  test("A6 renaming a column rewrites the relationships that use it, in the same edit list", () => {
    const r = applyFlowEdit(BILLING, parseFlow(BILLING), { op: "setColumn", table: "invoices", index: 1, column: "customer_id", name: "client_id" });
    const out = applyEdits(BILLING, r.edits);
    expect(out).toBe(BILLING.replace("  customer_id int", "  client_id int").replace("invoices.customer_id >", "invoices.client_id >"));
    // Renaming the column at the other end, and a column no line uses, touch only what names them.
    expect(run(BILLING, { op: "setColumn", table: "customers", index: 0, column: "id", name: "key" })).toBe(
      BILLING.replace("customers {\n  id int", "customers {\n  key int").replace("customers.id\n", "customers.key\n"),
    );
    expect(run(BILLING, { op: "setColumn", table: "customers", index: 1, column: "name", name: "title" })).toBe(BILLING.replace("  name text", "  title text"));
  });

  test("fix 2, I3: renaming a column that ends one link of a chain and starts the next writes its name once", () => {
    const chain = lines('diagram er "x"', "a {", "  x int", "}", "b {", "  y int", "}", "c {", "  w int", "}", "a.x > b.y > c.w");
    const out = run(chain, { op: "setColumn", table: "b", index: 0, column: "y", name: "yy" });
    expect(out).toBe(chain.replace("  y int", "  yy int").replace("> b.y >", "> b.yy >"));
    expect(errors(out)).toEqual([]);
  });

  test("a retype keeps the relationships as they are", () => {
    expect(run(BILLING, { op: "setColumn", table: "invoices", index: 1, column: "customer_id", type: "bigint" })).toBe(BILLING.replace("customer_id int", "customer_id bigint"));
  });

  test("deleting a column deletes the relationships that use it, in the same edit list", () => {
    const out = run(BILLING, { op: "deleteColumn", table: "invoices", index: 1, column: "customer_id" });
    expect(out).toBe(lines('diagram er "Billing"', "customers {", "  id int pk", "  name text", "}", "invoices {", "  id int pk", "}", ""));
    // A table-to-table line between the same tables stays.
    const both = `${BILLING}customers < invoices\n`;
    expect(run(both, { op: "deleteColumn", table: "customers", index: 0, column: "id" })).toBe(both.replace("customers {\n  id int pk\n", "customers {\n").replace("invoices.customer_id > customers.id\n", ""));
  });

  test("the header drop: a new key column and its relationship, as one batch", () => {
    const text = lines('diagram er "x"', "customers {", "  id int pk", "}", "orders {", "  id int pk", "}");
    const r = applyFlowBatch(text, parseFlow(text), [
      { op: "addColumn", table: "orders", at: 1, before: null, name: "customer_id", type: "int", flags: ["not null"] },
      { op: "addLink", from: "orders", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" },
    ]);
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(text, r.edits)).toBe(`${text.replace("orders {\n  id int pk\n", "orders {\n  id int pk\n  customer_id int not null\n")}\norders.customer_id > customers.id\n`);
  });

  test("cardinality, swap and label find a column relationship by its columns", () => {
    const two = `${BILLING}invoices.id - customers.id\n`;
    const ref = refOf(two, 1);
    expect(ref).toEqual({ from: "invoices", to: "customers", label: null, nth: 0, fromColumn: "id", toColumn: "id" });
    expect(findLink(parseFlow(two), ref)).toBe(1);
    expect(run(two, { op: "setLinkArrow", link: refOf(two, 0), arrow: "-" })).toBe(two.replace("customer_id > customers", "customer_id - customers"));
    expect(run(BILLING, { op: "reverseLink", link: refOf(BILLING, 0) })).toBe(BILLING.replace("invoices.customer_id > customers.id", "customers.id < invoices.customer_id"));
    expect(run(BILLING, { op: "setLinkLabel", index: -1, link: refOf(BILLING, 0), label: "billed to" })).toBe(BILLING.replace("customers.id\n", "customers.id: billed to\n"));
  });

  test("reverse_swaps_the_cardinality", () => {
    const text = lines(
      'diagram er "x"',
      "orders {",
      "  id int pk",
      "  customer_id int",
      "}",
      "customers {",
      "  id int pk",
      "}",
      "orders.customer_id > customers.id",
      "orders.id < customers.id",
      "orders.id - customers.id",
      "orders.id <> customers.id",
    );
    const out = (i: number) => run(text, { op: "reverseLink", link: refOf(text, i) });
    expect(out(0)).toBe(text.replace("orders.customer_id > customers.id", "customers.id < orders.customer_id"));
    expect(out(1)).toBe(text.replace("orders.id < customers.id", "customers.id > orders.id"));
    expect(out(2)).toBe(text.replace("orders.id - customers.id", "customers.id - orders.id"));
    expect(out(3)).toBe(text.replace("orders.id <> customers.id", "customers.id <> orders.id"));
    // What each table's end says stays: many orders to one customer either way round.
    const before = parseFlow(text).doc!.links[0];
    const after = parseFlow(out(0)).doc!.links[0];
    expect([after.from, after.arrow, after.to]).toEqual([before.to, "<", before.from]);
  });

  test("fix 1: a relationship's end moved onto a column, or onto a whole table, writes just that end", () => {
    const ref = refOf(BILLING, 0);
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "to", node: "invoices", column: "id" })).toBe(BILLING.replace("> customers.id", "> invoices.id"));
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "to", node: "customers" })).toBe(BILLING.replace("> customers.id", "> customers"));
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "from", node: "customers", column: "name" })).toBe(BILLING.replace("invoices.customer_id >", "customers.name >"));
    // The same end does nothing; a column the table lacks is refused with the reason.
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "to", node: "customers", column: "id" })).toBe(BILLING);
    const r = applyFlowEdit(BILLING, parseFlow(BILLING), { op: "setLinkEnd", link: ref, end: "to", node: "customers", column: "nope" });
    expect([r.edits, r.note]).toEqual([[], "customers.nope is not in the text."]);
  });

  test("a label edit by a line that is gone says so and writes nothing", () => {
    const r = applyFlowEdit(BILLING, parseFlow(BILLING), { op: "setLinkLabel", index: -1, link: { from: "invoices", to: "customers", label: null, nth: 0, fromColumn: "id", toColumn: "id" }, label: "x" });
    expect(r.edits).toEqual([]);
    expect(r.note).toBe("That line is no longer in the text, so nothing was changed.");
  });

  test("copy and paste keep a relationship's columns, under the pasted tables' new names", () => {
    const doc = parseFlow(BILLING).doc!;
    const clip = copyLines(doc, ["customers", "invoices"]);
    expect(clip).toContain("invoices.customer_id > customers.id\n");
    const r = pasteLines(BILLING, parseFlow(BILLING), clip);
    const out = applyEdits(BILLING, r.edits);
    expect(out).toContain("invoices_2.customer_id > customers_2.id\n");
    expect(errors(out)).toEqual([]);
  });

  test("an inserted ER diagram takes free SQL names and keeps its column ends on them", () => {
    const r = insertFlow(BILLING, parseFlow(BILLING), BILLING);
    expect(r.names).toEqual({ customers: "customers_2", invoices: "invoices_2" });
    const out = applyEdits(BILLING, r.edits);
    expect(out).toContain("invoices_2 {\n  id int pk\n  customer_id int not null\n}\n");
    expect(out).toContain("invoices_2.customer_id > customers_2.id\n");
    expect(errors(out)).toEqual([]);
  });

  test("the whole-file writer keeps a relationship's columns", () => {
    expect(writeFlow(parseFlow(BILLING).doc!)).toContain("invoices.customer_id > customers.id\n");
  });

  test("a numbered free name starts at _1 and skips taken ones in any case", () => {
    expect(sqlFreeName("table", [], 1)).toBe("table_1");
    expect(sqlFreeName("table", ["TABLE_1", "table"], 1)).toBe("table_2");
    expect(sqlFreeName("table", ["table_1", "table_2"], 1)).toBe("table_3");
  });

  test("an_er_group_is_written_with_its_word", () => {
    const text = lines('diagram er "x"', "orders {", "  id int pk", "}");
    const r = applyFlowEdit(text, parseFlow(text), { op: "addGroup", name: "Billing", unique: true });
    expect(r.name).toBe("Billing");
    const out = applyEdits(text, r.edits);
    expect(out).toBe(`${text}group Billing {\n}\n`);
    expect(parseFlow(out).span("group:Billing")).not.toBeNull();
    const inner = applyEdits(out, applyFlowEdit(out, parseFlow(out), { op: "addGroup", name: "billing", group: "Billing", unique: true }).edits);
    expect(inner).toBe(`${text}group Billing {\n  group billing_2 {\n  }\n}\n`);
    expect(errors(inner)).toEqual([]);
    expect(parseFlow(inner).parentOf("billing_2")).toBe("Billing");
  });
});

describe("refusals say why", () => {
  test("a bare T.x line beside a table T is refused: it would read as that table's column", () => {
    const text = lines('diagram er "x"', "sales {", "  id int", "}", "orders", "crm.orders", "sales > orders");
    const note = (t: string, op: FlowEditOp) => {
      const r = applyFlowEdit(t, parseFlow(t), op);
      return [r.edits, r.note];
    };
    expect(note(text, { op: "renameNode", old: "orders", next: "sales.orders" })).toEqual([[], "sales.orders reads as a column of table sales. Pick another name."]);
    expect(note(text, { op: "addNode", name: "sales.items", kind: null })).toEqual([[], "sales.items reads as a column of table sales. Pick another name."]);
    expect(note(text, { op: "renameNode", old: "sales", next: "crm" })).toEqual([[], "crm.orders reads as a column of table crm. Pick another name."]);
    expect(note(text, { op: "addNode", name: "crm", kind: null })).toEqual([[], "crm.orders reads as a column of table crm. Pick another name."]);
    // With a kind or brackets, or as a block, the line is a table of its own.
    const weak = run(text, { op: "addNode", name: "sales.items", kind: "weak" });
    expect(weak).toContain("sales.items [weak]\n");
    expect(errors(weak)).toEqual([]);
    // A paste of a bare dotted table says so too.
    const pasted = pasteLines(text, parseFlow(text), lines("sales.lines"));
    expect([pasted.edits, pasted.note]).toEqual([[], "sales.lines reads as a column of table sales. Pick another name."]);
  });

  test("a table name taken in another case is refused", () => {
    const text = lines('diagram er "x"', "customers {", "  id int", "}", "orders");
    const r = applyFlowEdit(text, parseFlow(text), { op: "renameNode", old: "orders", next: "Customers" });
    expect([r.edits, r.note]).toEqual([[], "customers already has that name, in another case."]);
    // A table's own name in another case is a rename.
    expect(run(text, { op: "renameNode", old: "orders", next: "Orders" })).toBe(text.replace("orders\n", "Orders\n"));
  });

  test("a column rename or a line end that would point at another node is refused with the reason", () => {
    const text = lines('diagram er "x"', "a {", "  b int", "  c int", "}", "a.c [weak]", "x {", "  id int", "}", "x.id > a.b");
    expect(errors(text)).toEqual([]);
    const col = applyFlowEdit(text, parseFlow(text), { op: "setColumn", table: "a", index: 0, column: "b", name: "d" });
    expect(col.note).toBeUndefined();
    const clash = lines('diagram er "x"', "a {", "  b int", "}", "a.c [weak]", "x {", "  id int", "}", "x.id > a.b");
    const r = applyFlowEdit(clash, parseFlow(clash), { op: "setColumn", table: "a", index: 0, column: "b", name: "c" });
    expect([r.edits, r.note]).toEqual([[], "a.c would point at another table, so the column keeps its name."]);
    const end = applyFlowEdit(text, parseFlow(text), { op: "setLinkEnd", link: refOf(text, 0), end: "to", node: "a", column: "c" });
    expect([end.edits, end.note]).toEqual([[], "a.c would point at another table, so the line was not changed."]);
  });

  test("a column end the reader cannot find (a table past four dots) is refused, as the reader reads it", () => {
    const text = lines('diagram er "x"', "a.b.c.d.e {", "  id int", "}", "x {", "  y int", "}");
    expect(errors(text)).toEqual([]);
    const r = applyFlowEdit(text, parseFlow(text), { op: "addLink", from: "x", fromColumn: "y", to: "a.b.c.d.e", toColumn: "id", arrow: ">" });
    expect([r.edits, r.note]).toEqual([[], "a.b.c.d.e.id would point at another table, so the line was not changed."]);
    // Four dots in the end still read.
    const four = text.replace("a.b.c.d.e {", "a.b.c.d {");
    expect(errors(run(four, { op: "addLink", from: "x", fromColumn: "y", to: "a.b.c.d", toColumn: "id", arrow: ">" }))).toEqual([]);
  });

  test("a new relationship with a column the table lacks, or an arrow ER does not draw, says so", () => {
    const text = BILLING.replace("invoices.customer_id > customers.id\n", "");
    const unknown = applyFlowEdit(text, parseFlow(text), { op: "addLink", from: "invoices", fromColumn: "nope", to: "customers", toColumn: "id", arrow: ">" });
    expect([unknown.edits, unknown.note]).toEqual([[], "invoices.nope is not in the text."]);
    const arrow = applyFlowEdit(text, parseFlow(text), { op: "addLink", from: "invoices", to: "customers", arrow: "--" });
    expect([arrow.edits, arrow.note]).toEqual([[], "-- is not a line this kind of diagram draws."]);
  });
});

describe("a table whose name needs quotes", () => {
  const QUOTED = lines('diagram er "x"', '"crm:people" {', "  id int", "}", "orders {", "  t_id int", "}");
  const NOTE = "crm:people needs quotes, so a line cannot end on one of its columns. Rename it with letters, digits, _ and dots first.";

  test("a column end on it is refused with the reason, never written as an unreadable \"name\".column", () => {
    expect(errors(QUOTED)).toEqual([]);
    const add = applyFlowEdit(QUOTED, parseFlow(QUOTED), { op: "addLink", from: "orders", fromColumn: "t_id", to: "crm:people", toColumn: "id", arrow: ">" });
    expect([add.edits, add.note]).toEqual([[], NOTE]);
    // A table-to-table line to it is fine.
    expect(errors(run(QUOTED, { op: "addLink", from: "orders", to: "crm:people", arrow: ">" }))).toEqual([]);
    const linked = `${QUOTED}orders > "crm:people"\n`;
    const end = applyFlowEdit(linked, parseFlow(linked), { op: "setLinkEnd", link: refOf(linked, 0), end: "to", node: "crm:people", column: "id" });
    expect([end.edits, end.note]).toEqual([[], NOTE]);
  });

  test("a rename to a name that needs quotes is refused; a quoted name that needs none renames its column ends", () => {
    const r = applyFlowEdit(BILLING, parseFlow(BILLING), { op: "renameNode", old: "customers", next: "our:customers" });
    expect([r.edits, r.note]).toEqual([[], "our:customers needs quotes, and a table with column relationships cannot have them. Use letters, digits, _ and dots."]);
    const written = BILLING.replace("customers {", '"customers" {');
    expect(errors(written)).toEqual([]);
    expect(run(written, { op: "renameNode", old: "customers", next: "clients" })).toBe(written.replace('"customers" {', "clients {").replace("> customers.id", "> clients.id"));
  });
});

describe("paste and insert into an ER frame", () => {
  const OLD = lines('diagram er "x"', "customers", "customers.id int [pk]");
  const OLD_NOTE = "Rewrite this diagram as table blocks first: its first problem has the fix.";

  test("an old frame refuses a paste and an insert with the old-frame note", () => {
    const pasted = pasteLines(OLD, parseFlow(OLD), lines("orders"));
    expect([pasted.edits, pasted.note]).toEqual([[], OLD_NOTE]);
    const inserted = insertFlow(OLD, parseFlow(OLD), lines('diagram er "y"', "orders {", "  id int", "}"));
    expect([inserted.edits, inserted.note]).toEqual([[], OLD_NOTE]);
  });

  test("an old-form ER text is not inserted into a new frame", () => {
    const text = lines('diagram er "x"', "crm {", "  id int", "}");
    const r = insertFlow(text, parseFlow(text), lines('diagram er "y"', "customers", "customers.id int [pk]"));
    expect([r.edits, r.note]).toEqual([[], "The diagram coming in is written in the old form. Rewrite it as table blocks first, so nothing was inserted."]);
  });

  test("an insert whose free name cannot be written says why", () => {
    const text = lines('diagram er "x"', "crm {", "  id int", "}");
    const r = insertFlow(text, parseFlow(text), lines('diagram er "y"', "crm {", "  id int", "}", "crm_2.orders"));
    expect([r.edits, r.note]).toEqual([[], "crm_2.orders reads as a column of table crm_2. Pick another name."]);
  });
});

describe("relationships on a fan line", () => {
  test("the fan reads as two relationships from one column", () => {
    expect(errors(FAN)).toEqual([]);
    expect(parseFlow(FAN).doc!.links).toEqual([
      { from: "orders", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" },
      { from: "orders", fromColumn: "customer_id", to: "clients", toColumn: "id", arrow: ">" },
    ]);
  });

  test("setLinkEnd on one end of a fan splits only that link out", () => {
    const out = run(FAN, { op: "setLinkEnd", link: refOf(FAN, 0), end: "to", node: "customers" });
    expect(out).toBe(FAN.replace("orders.customer_id > customers.id, clients.id", "orders.customer_id > clients.id\norders.customer_id > customers"));
    expect(errors(out)).toEqual([]);
  });

  test("reverse on a fan link splits it out with the cardinality swapped", () => {
    const out = run(FAN, { op: "reverseLink", link: refOf(FAN, 1) });
    expect(out).toBe(FAN.replace("orders.customer_id > customers.id, clients.id", "orders.customer_id > customers.id\nclients.id < orders.customer_id"));
    expect(errors(out)).toEqual([]);
  });

  test("deleting one fan link takes only its end out of the list", () => {
    const i = findLink(parseFlow(FAN), refOf(FAN, 0))!;
    expect(run(FAN, { op: "deleteLink", index: i })).toBe(FAN.replace("> customers.id, clients.id", "> clients.id"));
  });

  test("deleting a column one fan end names takes only that end", () => {
    expect(run(FAN, { op: "deleteColumn", table: "clients", index: 0, column: "id" })).toBe(FAN.replace("clients {\n  id int pk\n", "clients {\n").replace(", clients.id", ""));
    // The column every link of the fan starts from takes the whole line.
    expect(run(FAN, { op: "deleteColumn", table: "orders", index: 1, column: "customer_id" })).toBe(FAN.replace("  customer_id int\n", "").replace("orders.customer_id > customers.id, clients.id\n", ""));
  });

  test("renaming a table or a column on a fan writes each name once", () => {
    const table = run(FAN, { op: "renameNode", old: "clients", next: "buyers" });
    expect(table).toBe(FAN.replace("clients {", "buyers {").replace(", clients.id", ", buyers.id"));
    expect(errors(table)).toEqual([]);
    const from = run(FAN, { op: "renameNode", old: "orders", next: "sales" });
    expect(from).toBe(FAN.replace("orders {", "sales {").replace("orders.customer_id >", "sales.customer_id >"));
    const column = run(FAN, { op: "setColumn", table: "orders", index: 1, column: "customer_id", name: "buyer_id" });
    expect(column).toBe(FAN.replace("  customer_id int", "  buyer_id int").replace("orders.customer_id >", "orders.buyer_id >"));
    expect(errors(column)).toEqual([]);
  });
});
