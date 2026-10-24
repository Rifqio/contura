// ER build C, fix round 1: the board's rules for the names and ends a drop writes.
import { expect, test } from "vitest";
import { hitRow, pickTargets, planReference, planRelationship, singular } from "./erRelate";
import { parseFlow } from "../lang/flow/parse";
import { erRowY } from "./kindLayout";

test("fix 2, I4 and M7: a table's name made singular by the Rails inflector's rules and irregulars", () => {
  const cases: [string, string][] = [
    ["branches", "branch"],
    ["boxes", "box"],
    ["movies", "movie"],
    ["series", "series"],
    ["categories", "category"],
    ["addresses", "address"],
    ["statuses", "status"],
    ["status", "status"],
    ["people", "person"],
    ["person", "person"],
    ["children", "child"],
    ["news", "news"],
    ["data", "datum"],
    ["analyses", "analysis"],
    ["indices", "index"],
    ["buses", "bus"],
    ["quizzes", "quiz"],
    ["wolves", "wolf"],
    ["shoes", "shoe"],
    ["invoice_lines", "invoice_line"],
    ["sales_people", "sales_person"],
    ["Orders", "Order"],
    ["CATEGORIES", "CATEGORY"],
  ];
  expect(cases.map(([w]) => [w, singular(w)])).toEqual(cases);
});

test("a row scrolled out of a card puts its line's end on the card's top or bottom edge", () => {
  // Card at 100, 300 px tall: rows show from 36 to 296.
  expect(erRowY(100, 300, 0)).toBe(147);
  expect(erRowY(100, 300, 1, 10)).toBe(159);
  expect(erRowY(100, 300, 0, 22)).toBe(100);
  expect(erRowY(100, 300, 30)).toBe(400);
  expect(erRowY(100, 300, -1, 50)).toBe(117);
});

test("a drop over a scrolled card finds the row under the pointer", () => {
  const t = { name: "t", kind: "entity" as const, attrs: {}, rows: ["a int", "b int", "c int"] };
  expect(hitRow(t, 0, 50)).toEqual({ table: "t", column: "a" });
  expect(hitRow(t, 0, 50, 22)).toEqual({ table: "t", column: "b" });
  expect(hitRow(t, 0, 10, 22)).toEqual({ table: "t", column: null });
});

const doc = (...l: string[]) => parseFlow(`${['diagram er "x"', ...l].join("\n")}\n`).doc!;

test("fix 2, I2: a reference whose singular-plus-key column is already there links that column and adds nothing", () => {
  const d = doc("customers", "customers.id int [pk]", "invoices", "invoices.Customer_ID int");
  expect(planReference(d, "invoices", "customers")).toEqual({
    ops: [{ op: "addLink", from: "invoices.Customer_ID", to: "customers.id", arrow: "*--1" }],
    message: "Linked invoices.Customer_ID *--1 customers.id. Right-click the line to change it.",
  });
});

test("fix 2: a new reference column is named and worded as the board does, upper case kept (M7)", () => {
  const d = doc("CUSTOMERS", "CUSTOMERS.id int [pk]", "ORDERS", "ORDERS.ID int [pk]");
  const r = planReference(d, "ORDERS", "CUSTOMERS");
  expect("ops" in r && r.ops[0]).toEqual({ op: "addColumn", table: "ORDERS", at: 1, before: null, name: "CUSTOMER_ID", type: "int", flags: ["not null"] });
  expect("message" in r && r.message).toBe("Added ORDERS.CUSTOMER_ID and linked it to CUSTOMERS.id, in one undo step.");
});

test("fix 2, M6: integer widths, text kinds and decimal kinds join within their family only", () => {
  const d = doc("a", "a.i int", "a.t varchar(20)", "a.n numeric(12,2)", "b", "b.big bigserial", "b.c char(2)", "b.d decimal", "b.s smallint");
  const ok = (x: string, y: string) => "ops" in planRelationship(d, { table: "a", column: x }, { table: "b", column: y });
  expect([ok("i", "big"), ok("i", "s"), ok("t", "c"), ok("n", "d")]).toEqual([true, true, true, true]);
  expect([ok("i", "c"), ok("t", "d"), ok("n", "s")]).toEqual([false, false, false]);
});

test("fix 2, M1 and M5: a column on its own table's header, or a column that is also a node's name, is refused with why", () => {
  const d = doc("staff", "staff.id int [pk]", "staff.manager_id int");
  expect(planRelationship(d, { table: "staff", column: "manager_id" }, { table: "staff", column: null })).toEqual({ refuse: "No line made: that is this column's own table. Drop on one of its columns for a loop." });
  // A loop made on purpose stays.
  expect("ops" in planRelationship(d, { table: "staff", column: "manager_id" }, { table: "staff", column: "id" })).toBe(true);
  const both = doc("sales.orders [entity]", "sales", "sales.orders int", "b", "b.y int");
  expect(planRelationship(both, { table: "b", column: "y" }, { table: "sales", column: "orders" })).toEqual({
    refuse: "No line made: sales.orders is also the name of a table, so the line would join that table.",
  });
});

test("fix 4, N6: a pick offers only the places that make a line, other tables first, then its own table's columns", () => {
  const d = doc(
    "customers",
    "customers.id int [pk]",
    "customers.email text",
    "logs",
    "logs.msg text",
    "invoices",
    "invoices.id int [pk]",
    "invoices.customer_id int",
    "invoices.parent_id int",
    "invoices.note text",
    "invoices.customer_id *--1 customers.id",
  );
  const names = pickTargets(d, { table: "invoices", column: "parent_id" }).map((t) => `${t.table}.${t.column ?? "(key)"}`);
  // logs has no key and only text; email and note are text; nothing is offered twice or refused later.
  expect(names).toEqual(["customers.(key)", "customers.id", "invoices.id", "invoices.customer_id"]);
  // A column already joined to customers.id is not offered it again.
  expect(pickTargets(d, { table: "invoices", column: "customer_id" }).map((t) => `${t.table}.${t.column ?? "(key)"}`)).toEqual(["invoices.id", "invoices.parent_id"]);
});

test("fix 4, N4: a PascalCase table's key column is snake case, as Rails' foreign_key writes it", () => {
  const d = doc("Customers", "Customers.id int [pk]", "OrderItems", "OrderItems.id int [pk]", "orders", "orders.id int [pk]");
  const name = (to: string) => {
    const r = planReference(d, "orders", to);
    return "ops" in r && r.ops[0].op === "addColumn" ? r.ops[0].name : null;
  };
  expect([name("Customers"), name("OrderItems")]).toEqual(["customer_id", "order_item_id"]);
});
