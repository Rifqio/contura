// ER build C, fix round 1: the board's rules for the names and ends a drop writes.
import { expect, test } from "vitest";
import { hitRow, joinRefusal, pickTargets, planReference, planRelationship, singular } from "./erRelate";
import { ER_NOTES } from "../lang/flow/edits";
import { parseFlow } from "../lang/flow/parse";
import { erCardH, erFits, ER_HEAD_MID, ER_ROW_MID, erRowY, KIND_ROW } from "./kindLayout";

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

// Block form: a table is `name {`, its columns, `}`; a line is `a.col > b.col`.
const doc = (...l: string[]) => {
  const r = parseFlow(`${['diagram er "x"', ...l].join("\n")}\n`);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  return r.doc!;
};

test("fix 2, I2: a reference whose singular-plus-key column is already there links that column and adds nothing", () => {
  const d = doc("customers {", "  id int pk", "}", "invoices {", "  Customer_ID int", "}");
  expect(planReference(d, "invoices", "customers")).toEqual({
    ops: [{ op: "addLink", from: "invoices", fromColumn: "Customer_ID", to: "customers", toColumn: "id", arrow: ">" }],
    message: "Linked invoices.Customer_ID > customers.id. Right-click the line to change it.",
  });
});

test("fix 2: a new reference column is named and worded as the board does, upper case kept (M7)", () => {
  const d = doc("CUSTOMERS {", "  id int pk", "}", "ORDERS {", "  ID int pk", "}");
  const r = planReference(d, "ORDERS", "CUSTOMERS");
  expect("ops" in r && r.ops[0]).toEqual({ op: "addColumn", table: "ORDERS", at: 1, before: null, name: "CUSTOMER_ID", type: "int", flags: ["not null"] });
  expect("message" in r && r.message).toBe("Added ORDERS.CUSTOMER_ID and linked it to CUSTOMERS.id, in one undo step.");
});

test("fix 2, M6: integer widths, text kinds and decimal kinds join within their family only", () => {
  const d = doc("a {", "  i int", "  t varchar(20)", "  n numeric(12,2)", "}", "b {", "  big bigserial", "  c char(2)", "  d decimal", "  s smallint", "}");
  const ok = (x: string, y: string) => "ops" in planRelationship(d, { table: "a", column: x }, { table: "b", column: y });
  expect([ok("i", "big"), ok("i", "s"), ok("t", "c"), ok("n", "d")]).toEqual([true, true, true, true]);
  expect([ok("i", "c"), ok("t", "d"), ok("n", "s")]).toEqual([false, false, false]);
});

test("fix 2, M1 and M5: a column on its own table's header, or a column that is also a node's name, is refused with why", () => {
  const d = doc("staff {", "  id int pk", "  manager_id int", "}");
  expect(planRelationship(d, { table: "staff", column: "manager_id" }, { table: "staff", column: null })).toEqual({ refuse: "No line made: that is this column's own table. Drop on one of its columns for a loop." });
  // A loop made on purpose stays.
  expect("ops" in planRelationship(d, { table: "staff", column: "manager_id" }, { table: "staff", column: "id" })).toBe(true);
  const both = doc("sales.orders", "sales {", "  orders int", "}", "b {", "  y int", "}");
  expect(planRelationship(both, { table: "b", column: "y" }, { table: "sales", column: "orders" })).toEqual({
    refuse: "No line made: sales.orders is also the name of a table, so the line would join that table.",
  });
});

test("fix 4, N6: a pick offers only the places that make a line, other tables first, then its own table's columns", () => {
  const d = doc(
    "customers {", "  id int pk", "  email text", "}",
    "logs {", "  msg text", "}",
    "invoices {", "  id int pk", "  customer_id int", "  parent_id int", "  note text", "}",
    "invoices.customer_id > customers.id",
  );
  const names = pickTargets(d, { table: "invoices", column: "parent_id" }).map((t) => `${t.table}.${t.column ?? "(key)"}`);
  // logs has no key and only text; email and note are text; nothing is offered twice or refused later.
  expect(names).toEqual(["customers.(key)", "customers.id", "invoices.id", "invoices.customer_id"]);
  // A column already joined to customers.id is not offered it again.
  expect(pickTargets(d, { table: "invoices", column: "customer_id" }).map((t) => `${t.table}.${t.column ?? "(key)"}`)).toEqual(["invoices.id", "invoices.parent_id"]);
});

test("fix 4, N4: a PascalCase table's key column is snake case, as Rails' foreign_key writes it", () => {
  const d = doc("Customers {", "  id int pk", "}", "OrderItems {", "  id int pk", "}", "orders {", "  id int pk", "}");
  const name = (to: string) => {
    const r = planReference(d, "orders", to);
    return "ops" in r && r.ops[0].op === "addColumn" ? r.ops[0].name : null;
  };
  expect([name("Customers"), name("OrderItems")]).toEqual(["customer_id", "order_item_id"]);
});

const SHOP = doc("orders {", "  id int pk", "  customer_id int", "}", "customers {", "  id int pk", "}", "profiles {", "  customer_id int unique", "}");

test("a_drop_writes_the_board_arrows", () => {
  const d = SHOP;
  expect(planRelationship(d, { table: "orders", column: "customer_id" }, { table: "customers", column: "id" })).toMatchObject({
    ops: [{ op: "addLink", from: "orders", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" }],
    message: "Linked orders.customer_id > customers.id. Right-click the line to change it.",
  });
  // A drag from the key turns, so the referring column is first.
  expect(planRelationship(d, { table: "customers", column: "id" }, { table: "orders", column: "customer_id" })).toMatchObject({ ops: [{ from: "orders", arrow: ">" }] });
  // Two key ends write a one-to-one line.
  expect(planRelationship(d, { table: "profiles", column: "customer_id" }, { table: "customers", column: "id" })).toMatchObject({ ops: [{ arrow: "-" }] });
  // A given arrow skips the key rule and the turn: the line runs from the pick's start to its end.
  expect(planRelationship(d, { table: "customers", column: "id" }, { table: "orders", column: "customer_id" }, "<>")).toMatchObject({ ops: [{ from: "customers", arrow: "<>" }] });
});

test("a_reference_is_one_batch_of_column_and_line", () => {
  const d = doc("orders_2 {", "  id int pk", "}", "customers {", "  id int pk", "}");
  expect(planReference(d, "orders_2", "customers")).toMatchObject({
    ops: [
      { op: "addColumn", table: "orders_2", name: "customer_id", type: "int", flags: ["not null"] },
      { op: "addLink", from: "orders_2", fromColumn: "customer_id", to: "customers", toColumn: "id", arrow: ">" },
    ],
  });
  // A given arrow is written as given.
  expect(planReference(d, "orders_2", "customers", "-")).toMatchObject({ ops: [{ op: "addColumn" }, { op: "addLink", arrow: "-" }] });
});

test("a_quoted_table_is_refused_with_its_note", () => {
  const d = doc('"order:lines" {', "  id int pk", "}", "orders {", "  id int pk", "  line_id int", "}");
  const note = { refuse: ER_NOTES.quotedEnd("order:lines") };
  expect(planRelationship(d, { table: "orders", column: "line_id" }, { table: "order:lines", column: "id" })).toEqual(note);
  expect(planRelationship(d, { table: "orders", column: "line_id" }, { table: "order:lines", column: null })).toEqual(note);
  expect(planRelationship(d, { table: "order:lines", column: "id" }, { table: "orders", column: "line_id" })).toEqual(note);
  expect(planReference(d, "orders", "order:lines")).toEqual(note);
  expect(planReference(d, "order:lines", "orders")).toEqual(note);
  expect(pickTargets(d, { table: "orders", column: "line_id" }).map((t) => t.table)).toEqual(["orders"]);
});

test("a_line_end_joined_to_a_quoted_tables_column_is_refused_with_its_note", () => {
  // Task 6 carry: the rule a line end dragged onto a column keeps (joinRefusal) refuses a quoted table as a drop does.
  const d = doc('"order:lines" {', "  id int pk", "}", "orders {", "  id int pk", "  line_id int", "}");
  expect(joinRefusal(d, { table: "order:lines", column: "id" }, { table: "orders", column: "line_id" })).toBe(ER_NOTES.quotedEnd("order:lines"));
  expect(joinRefusal(d, { table: "orders", column: "line_id" }, { table: "order:lines", column: "id" })).toBe(ER_NOTES.quotedEnd("order:lines"));
  expect(joinRefusal(d, { table: "orders", column: "line_id" }, { table: "orders", column: "id" })).toBeNull();
});

// B4 fix round 1: an ER card's height, header, row pitch and row middle scale together with the frame's text size, so
// every row and every line end sits inside the card at Small, Medium and Large.
test("er_rows_and_line_ends_stay_inside_the_card_at_every_text_size", () => {
  const cols = Array.from({ length: 20 }, (_, i) => `c${i} int`);
  for (const k of [0.88, 1, 1.15]) {
    for (const n of [1, 3, 5, 20]) {
      const h = erCardH(n, k);
      const t = { name: "t", kind: "entity" as const, attrs: {}, rows: cols.slice(0, n) };
      // The whole card shows without a scroll bar.
      expect(erFits(h, k), `k ${k}, ${n} rows`).toBe(n);
      for (let r = 0; r < n; r++) {
        const y = erRowY(0, h, r, 0, k);
        expect(y, `k ${k}, row ${r} of ${n}`).toBeCloseTo((ER_ROW_MID + r * KIND_ROW) * k, 9);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(h);
        // A drop on the row's middle finds the row.
        expect(hitRow(t, 0, y, 0, k)).toEqual({ table: "t", column: `c${r}` });
      }
      expect(erRowY(0, h, -1, 0, k)).toBeCloseTo(ER_HEAD_MID * k, 9);
      expect(hitRow(t, 0, ER_HEAD_MID * k, 0, k)).toEqual({ table: "t", column: null });
    }
  }
});
