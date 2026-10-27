import { expect, test } from "vitest";
import type { DialectKind, SchemaModel, SmColumn, SmRef, SmTable } from "../../../api/types";
import { parseFlow } from "../../../lang/flow/parse";
import { sqlFreeName } from "../../../lang/flow/model";
import { bareName, databaseTitle, modelToErFrame, type ErFromModel } from "./fromDatabase";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const col = (name: string, typeName: string, f: Partial<SmColumn> = {}): SmColumn => ({
  name, typeName, pk: false, increment: false, notNull: false, unique: false, default: null, note: null, ...f,
});
const table = (name: string, columns: SmColumn[], indexes: SmTable["indexes"] = [], schema: string | null = "public"): SmTable => ({
  schema, name, alias: null, note: null, columns, indexes,
});
type End = [string, string[], (string | null)?];
const ref = (from: End, to: End): SmRef => ({
  name: null,
  from: { schema: from[2] === undefined ? "public" : from[2], table: from[0], columns: from[1] },
  to: { schema: to[2] === undefined ? "public" : to[2], table: to[0], columns: to[1] },
  onDelete: null, onUpdate: null,
});
const model = (tables: SmTable[], refs: SmRef[] = [], dialect: DialectKind = "postgres"): SchemaModel => ({
  dialect, tables, refs, enums: [], skipped: [],
});
const ok = (m: SchemaModel, title = "shop") => modelToErFrame(m, title) as ErFromModel;

test("a_schema_becomes_table_blocks_and_relationships", () => {
  const m = model(
    [table("orders", [col("id", "integer", { pk: true }), col("customer_id", "integer", { notNull: true })]), table("customers", [col("id", "integer", { pk: true })])],
    [ref(["orders", ["customer_id"]], ["customers", ["id"]])],
  );
  const out = ok(m);
  expect(out.text).toBe(lines('diagram er "shop"', "orders {", "  id integer pk", "  customer_id integer not null", "}", "customers {", "  id integer pk", "}", "", "orders.customer_id > customers.id"));
  expect(out).toMatchObject({ title: "shop", tables: 2, links: 1, leftOut: 0 });
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("names_a_bare_name_cannot_hold", () => {
  const m = model(
    [
      table("order_items", [col("id", "int")]),
      table("order:items", [col("Order ID", "integer"), col("a--b", "int"), col("1st", "int"), col("größe", "int"), col("", "int")]),
      table("group", [col("id", "int")]),
      table("note", [col("id", "int")]),
    ],
    [ref(["order:items", ["Order ID"]], ["order_items", ["id"]])],
  );
  const out = ok(m);
  expect(out.text).toContain("  Order_ID integer // Order ID\n");
  expect(out.text).toContain('order_items_1 [label: "order:items"] {\n');
  expect(out.text).toContain("  a__b int // a--b\n");
  expect(out.text).toContain("  _1st int // 1st\n");
  expect(out.text).toContain("  gr__e int // größe\n");
  expect(out.text).toContain("  column int //\n");
  expect(out.text).toContain("group_1 [label: group] {\n");
  expect(out.text).toContain("note_1 [label: note] {\n");
  expect(out.text).toContain("order_items_1.Order_ID > order_items.id");
  expect(parseFlow(out.text).problems).toEqual([]);
  expect(bareName("", "table")).toBe("table");
  expect(bareName("", "column")).toBe("column");
});

test("sql_free_name_numbers_from_one", () => {
  expect(sqlFreeName("group", [], 1)).toBe("group_1");
});

test("flags_and_composite_keys", () => {
  const m = model([table("t", [col("a", "int"), col("b", "int", { notNull: true }), col("c", "int", { pk: true, notNull: true, unique: true }), col("d", "int", { notNull: true, unique: true })], [{ name: null, columns: ["a", "b"], unique: true, pk: true }])]);
  const out = ok(m);
  expect(out.text).toBe(lines('diagram er "shop"', "t {", "  a int pk", "  b int pk", "  c int pk unique", "  d int not null unique", "}"));
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("an_untyped_column_writes_no_type", () => {
  const out = ok(model([table("t", [col("a", ""), col("b", "", { pk: true })])]));
  expect(out.text).toBe(lines('diagram er "shop"', "t {", "  a", "  b pk", "}"));
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("a_unique_foreign_key_is_one_to_one", () => {
  const m = model(
    [table("profiles", [col("id", "int", { pk: true }), col("user_id", "int", { unique: true }), col("alt", "int")], [{ name: null, columns: ["alt"], unique: true, pk: false }]), table("users", [col("id", "int", { pk: true })])],
    [ref(["profiles", ["user_id"]], ["users", ["id"]]), ref(["profiles", ["id"]], ["users", ["id"]]), ref(["profiles", ["alt"]], ["users", ["id"]])],
  );
  const out = ok(m);
  expect(out.text).toContain("\nprofiles.user_id - users.id\nprofiles.id - users.id\nprofiles.alt - users.id\n");
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("a_composite_reference_links_whole_tables_with_a_note", () => {
  const m = model(
    [table("lines", [col("a", "int"), col("b", "int")]), table("heads", [col("c", "int"), col("d", "int")])],
    [ref(["lines", ["a", "b"]], ["heads", ["c", "d"]])],
  );
  const out = ok(m);
  expect(out.text.endsWith("\nlines > heads // (a, b) to (c, d)\n")).toBe(true);
  expect(out.links).toBe(1);
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("a_reference_outside_the_schema_is_left_out_and_counted", () => {
  const m = model(
    [table("orders", [col("id", "int", { pk: true }), col("b_id", "int")])],
    [ref(["orders", ["b_id"]], ["orders", ["id"], "billing"])],
  );
  const out = ok(m);
  expect(out).toMatchObject({ links: 0, leftOut: 1 });
  expect(out.text).toBe(lines('diagram er "shop"', "orders {", "  id int pk", "  b_id int", "}"));
});

test("types_with_spaces_are_quoted", () => {
  const out = ok(model([table("t", [col("a", "character varying(255)"), col("b", "timestamp with time zone")])]));
  expect(out.text).toContain('  a "character varying(255)"\n');
  expect(out.text).toContain('  b "timestamp with time zone"\n');
  const r = parseFlow(out.text);
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes[0].rows).toEqual(["a character varying(255)", "b timestamp with time zone"]);
});

test("refusals_and_their_copy", () => {
  expect(modelToErFrame(model([], [], "mysql"), "x")).toEqual({ refused: "This database has no tables." });
  expect(modelToErFrame(model([]), "x")).toEqual({ refused: "This schema has no tables." });
  const many = (n: number) => Array.from({ length: n }, (_, i) => table(`t${i}`, []));
  expect(modelToErFrame(model(many(2001), [], "mysql"), "x")).toEqual({ refused: "This database has 2,001 tables. A diagram holds at most 2,000." });
  expect(modelToErFrame(model(many(2001)), "x")).toEqual({ refused: "This schema has 2,001 tables. A diagram holds at most 2,000." });
  expect("text" in modelToErFrame(model(many(2000)), "x")).toBe(true);
});

test("over_1_mb_is_refused", () => {
  const cols = Array.from({ length: 40 }, (_, k) => col(`column_with_a_long_name_${k}`, "character varying(255)"));
  const tables = Array.from({ length: 1500 }, (_, i) => table(`t${i}`, cols));
  expect(modelToErFrame(model(tables), "x")).toEqual({ refused: "This schema is larger than 1 MB as a diagram." });
});

test("the_title_rule", () => {
  expect(databaseTitle("mysql", "shop", null)).toBe("shop");
  expect(databaseTitle("sqlite", "main", "x")).toBe("main");
  expect(databaseTitle("postgres", "shop", "public")).toBe("shop");
  expect(databaseTitle("postgres", "shop", "billing")).toBe("billing");
  expect(databaseTitle("postgres", "shop", null)).toBe("shop");
  expect(databaseTitle("postgres", "shop", "")).toBe("shop");
});

test("a_reference_to_a_missing_column_is_left_out_and_counted", () => {
  const m = model(
    [table("a", [col("id", "int", { pk: true }), col("b_id", "int")]), table("b", [col("id", "int", { pk: true })])],
    [ref(["a", ["gone"]], ["b", ["id"]]), ref(["a", ["b_id"]], ["b", ["nope"]]), ref(["a", ["b_id", "gone"]], ["b", ["id", "id"]]), ref(["a", ["b_id", "id"]], ["b", ["id", "gone"]])],
  );
  const out = ok(m);
  expect(out).toMatchObject({ links: 0, leftOut: 4 });
  expect(out.text).not.toContain("\n\n");
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("names_that_differ_only_in_case_are_renamed", () => {
  const m = model(
    [table("ORDER", [col("ID", "int"), col("id", "int")]), table("order", [col("x", "int")])],
    [ref(["order", ["x"]], ["ORDER", ["id"]])],
  );
  const out = ok(m);
  expect(out.text).toContain("ORDER {\n  ID int\n  id_1 int // id\n}\n");
  expect(out.text).toContain('order_1 [label: order] {\n');
  expect(out.text).toContain("order_1.x > ORDER.id_1");
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("a_self_reference_links_a_table_to_itself", () => {
  const m = model(
    [table("emp", [col("id", "int", { pk: true }), col("boss", "int"), col("a", "int"), col("b", "int")])],
    [ref(["emp", ["boss"]], ["emp", ["id"]]), ref(["emp", ["a", "b"]], ["emp", ["a", "b"]])],
  );
  const out = ok(m);
  expect(out.text).toContain("\nemp.boss > emp.id\nemp > emp // (a, b) to (a, b)\n");
  expect(out.links).toBe(2);
  expect(parseFlow(out.text).problems).toEqual([]);
});

test("a_composite_key_flagged_on_one_column_is_not_one_to_one_when_members_are_pk_flagged", () => {
  // Backends keep composite members off SmColumn.pk (the index holds them); a primary-key index of two columns never makes one end unique.
  const m = model(
    [table("l", [col("a", "int"), col("b", "int")], [{ name: null, columns: ["a", "b"], unique: true, pk: true }]), table("p", [col("id", "int", { pk: true })])],
    [ref(["l", ["a"]], ["p", ["id"]])],
  );
  expect(ok(m).text).toContain("l.a > p.id");
});
