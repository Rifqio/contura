import { expect, test } from "vitest";
import type { SmRef } from "../api/types";
import {
  buildRequest,
  failureHint,
  setColumnType,
  confirmTitle,
  structureLine,
  copyLine,
  emptiedLine,
  reviewSql,
  emptyTransfer,
  moveTable,
  needsNote,
  orderParentsFirst,
  sameSide,
  sourceHint,
  summaryLine,
  tabTitle,
  type TableRow,
  targetHint,
  targetOptionHint,
  tickedLine,
} from "./transferModel";

const ref = (from: string, to: string): SmRef => ({
  name: null,
  from: { schema: null, table: from, columns: [`${to}_id`] },
  to: { schema: null, table: to, columns: ["id"] },
  onDelete: null,
  onUpdate: null,
});

const row = (name: string, extra: Partial<TableRow> = {}): TableRow => ({
  name,
  view: false,
  rows: 10,
  bytes: 1024,
  needs: [],
  ticked: true,
  ifExists: "stop",
  ...extra,
});

test("the tab title names both databases", () => {
  expect(tabTitle("pos_live", "analytics")).toBe("pos_live to analytics");
  expect(tabTitle("pos_live", null)).toBe("Data Transfer");
});

test("the same database and schema on both sides is refused", () => {
  const a = { connectionId: "c1", database: "pos", schema: null };
  expect(sameSide(a, { ...a })).toBe(true);
  expect(sameSide(a, { ...a, database: "other" })).toBe(false);
  expect(sameSide(a, { ...a, connectionId: "c2" })).toBe(false);
  expect(sameSide({ ...a, schema: "public" }, { ...a, schema: "pos" })).toBe(false);
});

test("target picker lines", () => {
  expect(targetOptionHint({ readOnly: true, production: false })).toBe("Read-only: cannot be a target");
  expect(targetOptionHint({ readOnly: false, production: true })).toBe("Asks you to confirm the exact SQL before it runs");
  expect(targetOptionHint({ readOnly: false, production: false })).toBeUndefined();
});

test("source and target hints", () => {
  expect(sourceHint({ dialect: "mysql", version: "8.0.30", tables: 9, views: 1, bytes: 1.9 * 1024 ** 3 })).toBe(
    "MySQL 8.0.30 · 9 tables, 1 view · 1.9 GB · reading only",
  );
  expect(sourceHint({ dialect: "sqlite", version: null, tables: 1, views: 0, bytes: null })).toBe("SQLite · 1 table · reading only");
  expect(targetHint({ dialect: "postgres", version: "17.0", scope: "schema pos", tables: 0 })).toBe(
    "PostgreSQL 17.0 · schema pos is empty · structure and rows run in one transaction",
  );
  expect(targetHint({ dialect: "mysql", version: "8.0.30", scope: "analytics", tables: 3 })).toBe(
    "MySQL 8.0.30 · analytics has 3 tables · tables are created one by one, rows per table",
  );
  expect(targetHint({ dialect: "postgres", version: "17.0", scope: "schema pos", tables: null })).toBe(
    "PostgreSQL 17.0 · schema pos does not exist yet and is created first · structure and rows run in one transaction",
  );
});

test("tables load parents first; a cycle keeps model order", () => {
  expect(orderParentsFirst(["sales", "stores", "customers"], [ref("sales", "stores"), ref("sales", "customers")])).toEqual([
    "stores",
    "customers",
    "sales",
  ]);
  expect(orderParentsFirst(["a", "b"], [ref("a", "b"), ref("b", "a")])).toEqual(["a", "b"]);
  expect(orderParentsFirst(["t"], [ref("t", "t")])).toEqual(["t"]);
});

test("moving a table up and down stays inside the list", () => {
  const list = [row("a"), row("b"), row("c")];
  expect(moveTable(list, 1, -1).map((r) => r.name)).toEqual(["b", "a", "c"]);
  expect(moveTable(list, 2, 1).map((r) => r.name)).toEqual(["a", "b", "c"]);
  expect(moveTable(list, 0, 2).map((r) => r.name)).toEqual(["b", "c", "a"]);
});

test("header and summary lines", () => {
  const list = [row("a"), row("b", { ticked: false }), row("v", { view: true, ticked: false })];
  expect(tickedLine(list)).toBe("1 of 2 ticked");
  const big = [
    row("stores", { rows: 412, bytes: 96 * 1024 }),
    row("sales", { rows: 6_507_855, bytes: 1.6 * 1024 ** 3 }),
    row("audit", { ticked: false, rows: 9, bytes: 9 }),
  ];
  expect(summaryLine(big, "kestrel-pos")).toBe("This transfer: 2 tables, 6,508,267 rows. About 1.6 GB read from kestrel-pos.");
  expect(summaryLine([row("x", { rows: null, bytes: null })], "k")).toBe("This transfer: 1 table.");
});

test("a ticked table without a ticked parent gets a note", () => {
  const list = [row("stores", { ticked: false }), row("sales", { needs: ["stores", "customers"] }), row("customers")];
  expect(needsNote(list, list[1]!)).toBe("Needs stores, which is not ticked");
  expect(needsNote(list, list[2]!)).toBeNull();
});

test("the request carries the order, ticks and options", () => {
  const t = emptyTransfer({ connectionId: "c1", database: "pos_live", schema: null });
  t.target = { connectionId: "c2", database: "analytics", schema: "pos" };
  t.tables = [row("stores"), row("sales", { ifExists: "append" }), row("v", { view: true, ticked: false })];
  t.batchRows = 500;
  const req = buildRequest(t, false);
  expect(req.tables).toEqual([
    { name: "stores", ticked: true, ifExists: "stop" },
    { name: "sales", ticked: true, ifExists: "append" },
  ]);
  expect(req.order).toEqual(["stores", "sales"]);
  expect(req.batchRows).toBe(500);
  expect(req.compareCounts).toBe(true);
  expect(req.createTargetScope).toBe(false);
  expect(buildRequest(t, true).createTargetScope).toBe(true);
});

test("review SQL groups statements under heading comments", () => {
  expect(
    reviewSql(
      ['CREATE SCHEMA "pos";', 'CREATE TYPE "pos"."sales_channel" AS ENUM (\'app\');', 'CREATE TABLE "pos"."stores" (id int);', 'CREATE TABLE "pos"."sales" (id int);'],
      ['CREATE INDEX "i" ON "pos"."sales" (id);', 'ALTER TABLE "pos"."sales" ADD FOREIGN KEY (store_id) REFERENCES "pos"."stores" (id);'],
    ),
  ).toBe(
    [
      "-- The target scope",
      'CREATE SCHEMA "pos";',
      "",
      "-- Types",
      'CREATE TYPE "pos"."sales_channel" AS ENUM (\'app\');',
      "",
      "-- Tables",
      'CREATE TABLE "pos"."stores" (id int);',
      'CREATE TABLE "pos"."sales" (id int);',
      "",
      "-- The rows are copied here",
      "",
      "-- Indexes, after the rows",
      'CREATE INDEX "i" ON "pos"."sales" (id);',
      "",
      "-- Foreign Keys, after the rows",
      'ALTER TABLE "pos"."sales" ADD FOREIGN KEY (store_id) REFERENCES "pos"."stores" (id);',
    ].join("\n"),
  );
});

test("the Empty it first line and the row copy line", () => {
  expect(
    emptiedLine(
      [
        { table: "products", rows: 2316 },
        { table: "stores", rows: 412 },
      ],
      "pinecone-analytics",
    ),
  ).toBe("Empty it first deletes 2,316 rows in products and 412 rows in stores on pinecone-analytics.");
  expect(emptiedLine([], "x")).toBeNull();
  expect(copyLine({ source: "sales", insertHead: "INSERT INTO pos.sales (id, store_id)", rowsHint: 1_284_339 }, 1000)).toBe(
    "sales: INSERT INTO pos.sales (id, store_id) VALUES ... 1,284,339 rows in batches of 1,000",
  );
});

test("the structure line and the Production dialog's first line", () => {
  const structure = ['CREATE SCHEMA "pos";', "CREATE TYPE a AS ENUM ('x');", "CREATE TABLE a (id int);", "CREATE TABLE b (id int);"];
  const after = ["CREATE INDEX i ON a (id);", "CREATE UNIQUE INDEX j ON b (id);", "ALTER TABLE b ADD FOREIGN KEY (a_id) REFERENCES a (id);"];
  expect(structureLine(structure, after)).toBe("2 tables, 1 type, 2 indexes created.");
  // Rows only: nothing is created.
  expect(structureLine([], [])).toBe("");
  expect(confirmTitle(structure, after, 6_508_267, 2, "kestrel-pos")).toBe(
    "Creates 2 tables, 1 type and 2 indexes, then copies 6,508,267 rows from kestrel-pos (counted when the run starts).",
  );
  expect(confirmTitle([], [], 12, 1, "k")).toBe("Copies 12 rows from k (counted when the run starts).");
});

test("the failure hint names the column the value did not fit", () => {
  expect(
    failureHint(
      "sales_lines, row 2,114,903: the value NaN is not valid for numeric(10,2) in unit_price. The transaction rolled back, so pinecone-analytics is as it was.",
      "kestrel-pos",
    ),
  ).toBe("Fix the value in kestrel-pos, or set unit_price to text on Type mapping, then run again.");
  expect(failureHint("orders.customer_id has 3 values with no row in customers, for example 9912.", "k")).toBeNull();
});

test("a choice and a typed type replace each other", () => {
  const s = emptyTransfer({ connectionId: "c1", database: "pos", schema: null });
  const a = setColumnType(s, "sales", "is_refund", "boolean", true);
  expect(a.choices).toEqual([{ table: "sales", column: "is_refund", value: "boolean" }]);
  const b = setColumnType(a, "sales", "is_refund", "smallint(2)", false);
  expect(b.choices).toEqual([]);
  expect(b.overrides).toEqual([{ table: "sales", column: "is_refund", value: "smallint(2)" }]);
});
