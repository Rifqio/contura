// ER build C (erd-ux-research 5.4, A6): relationships between columns. `invoices.customer_id *--1 customers.id`
// joins two columns; a table-to-table line (`customers 1--* invoices`) still reads and draws as before. Renaming a
// table or a column rewrites the lines that name it, and deleting a column deletes its relationships, each as one
// edit list.
import { describe, expect, test } from "vitest";
import { copyLines, pasteLines } from "./clip";
import { applyFlowEdit, type FlowEditOp, findLink, linkRefOf } from "./edits";
import { sqlFreeName } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";
import { applyEdits, applyFlowBatch } from "./service";
import { writeFlow } from "../../flow/flowModel";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const BILLING = lines(
  'diagram er "Billing"',
  "customers",
  "customers.id int [pk]",
  "customers.name text",
  "invoices",
  "invoices.id int [pk]",
  "invoices.customer_id int [not null]",
  "",
  "invoices.customer_id *--1 customers.id",
);

const run = (text: string, op: FlowEditOp) => applyEdits(text, applyFlowEdit(text, parseFlow(text), op).edits);
const errors = (text: string) => parseFlow(text).problems.filter((p) => p.severity === "error");

describe("reading column relationships", () => {
  test("an old file's table-to-table line reads as before, with no columns", () => {
    const old = lines('diagram er "Billing"', "customers", "customers.id int [pk]", "invoices", "", "customers 1--* invoices : bills");
    const r = parseFlow(old);
    expect(errors(old)).toEqual([]);
    expect(r.doc!.links).toEqual([{ from: "customers", to: "invoices", arrow: "1--*", label: "bills" }]);
  });

  test("fix 1: an old file reads with no problem, and a table added to it changes only its own line, after the last table's columns", () => {
    const old = lines('diagram er "Billing"', "", "customers", "customers.id int [pk]", "invoices", "invoices.id int [pk]", "", "customers 1--* invoices: bills");
    expect(parseFlow(old).problems).toEqual([]);
    expect(run(old, { op: "addNode", name: "table_1", kind: "entity" })).toBe(old.replace("invoices.id int [pk]\n", "invoices.id int [pk]\ntable_1\n"));
  });

  test("table.column at both ends joins the two columns; the line's ends are the tables", () => {
    const r = parseFlow(BILLING);
    expect(errors(BILLING)).toEqual([]);
    expect(r.doc!.links).toEqual([{ from: "invoices", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: "*--1" }]);
  });

  test("a line may come before the columns it names, and one end may be a whole table", () => {
    const text = lines('diagram er "x"', "a", "b", "a.b_id -- b : refers", "a.b_id int", "b.id int [pk]");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links).toEqual([{ from: "a", fromColumn: "b_id", to: "b", arrow: "--", label: "refers" }]);
  });

  test("a self relationship joins two columns of one table", () => {
    const text = lines('diagram er "x"', "staff", "staff.id int [pk]", "staff.manager_id int", "staff.manager_id *--1 staff.id");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links[0]).toEqual({ from: "staff", fromColumn: "manager_id", to: "staff", toColumn: "id", arrow: "*--1" });
  });

  test("a column the table does not have is a problem that names it", () => {
    const text = lines('diagram er "x"', "a", "a.id int", "b", "b.id int", "a.nope -- b.id");
    const p = errors(text);
    expect(p.map((x) => x.message)).toEqual([MESSAGES.noColumn("a", "nope")]);
    expect(text.slice(p[0].from, p[0].to)).toBe("a.nope");
  });

  test("a dotted name that is a node of its own stays that node", () => {
    const text = lines('diagram er "x"', "sales.orders [entity]", "sales", "sales.id int", "sales.orders -- sales");
    expect(errors(text)).toEqual([]);
    expect(parseFlow(text).doc!.links[0]).toEqual({ from: "sales.orders", to: "sales", arrow: "--" });
  });

  test("a name before the dot that is no table is still not defined", () => {
    const text = lines('diagram er "x"', "a", "a.id int", "ghost.id -- a.id");
    expect(errors(text).map((x) => x.message)).toEqual([MESSAGES.notDefined("ghost.id")]);
  });
});

describe("writing column relationships", () => {
  test("a new relationship between columns is one line after the last line", () => {
    const text = BILLING.replace("invoices.customer_id *--1 customers.id\n", "");
    expect(run(text, { op: "addLink", from: "invoices.customer_id", to: "customers.id", arrow: "*--1" })).toBe(`${text}invoices.customer_id *--1 customers.id\n`);
  });

  test("renaming a table rewrites only the table's part of each column end", () => {
    const out = run(BILLING, { op: "renameNode", old: "customers", next: "clients" });
    expect(out).toBe(BILLING.replace(/^customers/gm, "clients").replace("*--1 customers.id", "*--1 clients.id"));
    expect(out.endsWith("invoices.customer_id *--1 clients.id\n")).toBe(true);
  });

  test("A6 renaming a column rewrites the relationships that use it, in the same edit list", () => {
    const r = applyFlowEdit(BILLING, parseFlow(BILLING), { op: "setColumn", table: "invoices", index: 1, column: "customer_id", name: "client_id" });
    const out = applyEdits(BILLING, r.edits);
    expect(out).toBe(BILLING.replace("invoices.customer_id int", "invoices.client_id int").replace("invoices.customer_id *--1", "invoices.client_id *--1"));
    // Renaming the column at the other end, and a column no line uses, touch only what names them.
    expect(run(BILLING, { op: "setColumn", table: "customers", index: 0, column: "id", name: "key" })).toBe(
      BILLING.replace("customers.id int", "customers.key int").replace("customers.id\n", "customers.key\n"),
    );
    expect(run(BILLING, { op: "setColumn", table: "customers", index: 1, column: "name", name: "title" })).toBe(BILLING.replace("customers.name", "customers.title"));
  });

  test("fix 2, I3: renaming a column that ends one link of a chain and starts the next writes its name once", () => {
    const chain = lines('diagram er "x"', "a", "a.x int", "b", "b.y int", "c", "c.w int", "a.x *--1 b.y *--1 c.w");
    const out = run(chain, { op: "setColumn", table: "b", index: 0, column: "y", name: "yy" });
    expect(out).toBe(chain.replace("b.y int", "b.yy int").replace("*--1 b.y *--1", "*--1 b.yy *--1"));
    expect(errors(out)).toEqual([]);
  });

  test("a retype keeps the relationships as they are", () => {
    expect(run(BILLING, { op: "setColumn", table: "invoices", index: 1, column: "customer_id", type: "bigint" })).toBe(BILLING.replace("customer_id int", "customer_id bigint"));
  });

  test("deleting a column deletes the relationships that use it, in the same edit list", () => {
    const out = run(BILLING, { op: "deleteColumn", table: "invoices", index: 1, column: "customer_id" });
    expect(out).toBe(lines('diagram er "Billing"', "customers", "customers.id int [pk]", "customers.name text", "invoices", "invoices.id int [pk]", ""));
    // A table-to-table line between the same tables stays.
    const both = `${BILLING}customers 1--* invoices\n`;
    expect(run(both, { op: "deleteColumn", table: "customers", index: 0, column: "id" })).toBe(both.replace("customers.id int [pk]\n", "").replace("invoices.customer_id *--1 customers.id\n", ""));
  });

  test("the header drop: a new key column and its relationship, as one batch", () => {
    const text = lines('diagram er "x"', "customers", "customers.id int [pk]", "orders", "orders.id int [pk]");
    const r = applyFlowBatch(text, parseFlow(text), [
      { op: "addColumn", table: "orders", at: 1, before: null, name: "customer_id", type: "int", flags: ["not null"] },
      { op: "addLink", from: "orders.customer_id", to: "customers.id", arrow: "*--1" },
    ]);
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(text, r.edits)).toBe(`${text.replace("orders.id int [pk]\n", "orders.id int [pk]\norders.customer_id int [not null]\n")}\norders.customer_id *--1 customers.id\n`);
  });

  test("cardinality, swap and label find a column relationship by its columns", () => {
    const two = `${BILLING}invoices.id 1--1 customers.id\n`;
    const doc = parseFlow(two).doc!;
    const ref = linkRefOf(doc.links, 1)!;
    expect(ref).toEqual({ from: "invoices", to: "customers", label: null, nth: 0, fromColumn: "id", toColumn: "id" });
    expect(findLink(parseFlow(two), ref)).toBe(1);
    expect(run(two, { op: "setLinkArrow", link: linkRefOf(doc.links, 0)!, arrow: "1--1" })).toBe(two.replace("customer_id *--1", "customer_id 1--1"));
    expect(run(BILLING, { op: "reverseLink", link: linkRefOf(parseFlow(BILLING).doc!.links, 0)! })).toBe(BILLING.replace("invoices.customer_id *--1 customers.id", "customers.id 1--* invoices.customer_id"));
    expect(run(BILLING, { op: "setLinkLabel", index: -1, link: linkRefOf(parseFlow(BILLING).doc!.links, 0)!, label: "billed to" })).toBe(
      BILLING.replace("customers.id\n", "customers.id: billed to\n"),
    );
  });

  test("fix 1: a relationship's end moved onto a column, or onto a whole table, writes just that end", () => {
    const ref = linkRefOf(parseFlow(BILLING).doc!.links, 0)!;
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "to", node: "invoices", column: "id" })).toBe(BILLING.replace("*--1 customers.id", "*--1 invoices.id"));
    expect(run(BILLING, { op: "setLinkEnd", link: ref, end: "to", node: "customers" })).toBe(BILLING.replace("*--1 customers.id", "*--1 customers"));
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
    expect(clip).toContain("invoices.customer_id *--1 customers.id\n");
    const r = pasteLines(BILLING, parseFlow(BILLING), clip);
    const out = applyEdits(BILLING, r.edits);
    expect(out).toContain("invoices_2.customer_id *--1 customers_2.id\n");
    expect(errors(out)).toEqual([]);
  });

  test("the whole-file writer keeps a relationship's columns", () => {
    expect(writeFlow(parseFlow(BILLING).doc!)).toContain("invoices.customer_id *--1 customers.id\n");
  });

  test("a numbered free name starts at _1 and skips taken ones in any case", () => {
    expect(sqlFreeName("table", [], 1)).toBe("table_1");
    expect(sqlFreeName("table", ["TABLE_1", "table"], 1)).toBe("table_2");
    expect(sqlFreeName("table", ["table_1", "table_2"], 1)).toBe("table_3");
  });
});
