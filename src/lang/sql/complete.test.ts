import { expect, test } from "vitest";
import { completeSql } from "./complete";
import { at, KFC_SCHEMA } from "./fixtures";
import { insertColumnsTemplate, SQL_TEMPLATES } from "./templates";

const pg = (marked: string, explicit = false) => {
  const { text, pos } = at(marked);
  return completeSql(text, pos, "postgres", KFC_SCHEMA, explicit);
};
const labels = (r: { items: { label: string }[] }) => r.items.map((i) => i.label);

test("tables_first_after_from", () => {
  const r = pg("SELECT * FROM |");
  const firstKw = r.items.findIndex((i) => i.kind === "keyword");
  const lastTable = r.items.map((i) => i.kind).lastIndexOf("table");
  expect(lastTable).toBeGreaterThanOrEqual(0);
  expect(firstKw === -1 || lastTable < firstKw).toBe(true);
  const orders = r.items.find((i) => i.label === "orders");
  expect(orders?.detail).toContain("sales");
  expect(orders?.detail).toContain("table");
  expect(r.items.find((i) => i.label === "v_store_daily_sales")?.kind).toBe("view");
  // Off the search path, a table needs its schema.
  expect(labels(r)).not.toContain("orders_2019");
  expect(labels(pg("SELECT * FROM archive.|"))).toEqual(["orders_2019"]);
});

test("alias_dot_gives_only_its_columns", () => {
  const r = pg("SELECT o.| FROM orders o JOIN stores s ON s.id = o.store_id");
  expect(labels(r)).toEqual(["id", "store_id", "customer_id", "channel", "status", "total", "placed_at"]);
  expect(r.items.find((i) => i.label === "total")?.detail).toBe("numeric(12,2) · orders");
  const pre = pg("SELECT o.st| FROM orders o");
  expect(labels(pre).slice(0, 2)).toEqual(["store_id", "status"]);
  expect(pre.from).toBe("SELECT o.".length);
});

test("cte_columns_complete", () => {
  const r = pg("WITH d AS (SELECT store_id, count(*) AS n FROM sales.orders GROUP BY store_id) SELECT d.| FROM d");
  expect(labels(r)).toEqual(["store_id", "n"]);
  expect(r.items.every((i) => i.kind === "column")).toBe(true);
  const t = pg("WITH d AS (SELECT 1 AS n) SELECT * FROM |");
  expect(t.items[0]).toMatchObject({ label: "d", kind: "cte" });
});

test("join_suggests_foreign_keys", () => {
  const r = pg("SELECT * FROM stores s JOIN |");
  const j = r.items.find((i) => i.kind === "join");
  expect(j?.label).toBe("orders o ON o.store_id = s.id");
  expect(r.items[0].kind).toBe("join");
  const on = pg("SELECT * FROM stores s JOIN orders o ON |");
  expect(on.items[0]).toMatchObject({ kind: "join", label: "o.store_id = s.id" });
});

test("picking_a_table_adds_an_alias", () => {
  const { text, pos } = at("SELECT * FROM |");
  const on = completeSql(text, pos, "postgres", KFC_SCHEMA, false);
  expect(on.items.find((i) => i.label === "orders")?.apply).toBe("orders o");
  expect(on.items.find((i) => i.label === "menu_items")?.apply).toBe("menu_items mi");
  const off = completeSql(text, pos, "postgres", KFC_SCHEMA, false, { aliasTables: false });
  expect(off.items.find((i) => i.label === "orders")?.apply).toBe("orders");
  // A used alias gets a number.
  const used = pg("SELECT * FROM orders o, |");
  expect(used.items.find((i) => i.label === "order_items")?.apply).toBe("order_items oi");
  expect(pg("SELECT * FROM order_items oi JOIN |").items.find((i) => i.label === "orders")?.apply).toBe("orders o");
});

test("keywords_and_functions_follow_the_dialect", () => {
  const q = "SELECT * FROM stores s WHERE s.name |";
  const p = at(q);
  const pgKw = labels(completeSql(p.text, p.pos, "postgres", KFC_SCHEMA, true));
  const myKw = labels(completeSql(p.text, p.pos, "mysql", KFC_SCHEMA, true));
  expect(pgKw).toContain("ILIKE");
  expect(myKw).not.toContain("ILIKE");
  expect(myKw).toContain("REGEXP");
  const c = at("SELECT | FROM stores");
  const pgFn = labels(completeSql(c.text, c.pos, "postgres", KFC_SCHEMA, true));
  const myFn = labels(completeSql(c.text, c.pos, "mysql", KFC_SCHEMA, true));
  const liteFn = labels(completeSql(c.text, c.pos, "sqlite", KFC_SCHEMA, true));
  expect(pgFn).toContain("date_trunc");
  expect(myFn).not.toContain("date_trunc");
  expect(myFn).toContain("ifnull");
  expect(liteFn).toContain("ifnull");
  expect(pgFn).not.toContain("ifnull");
  const fn = completeSql(c.text, c.pos, "postgres", KFC_SCHEMA, true).items.find((i) => i.label === "date_trunc");
  expect(fn).toMatchObject({ kind: "function", apply: "date_trunc()" });
});

test("without_a_schema_completes_keywords_and_own_aliases", () => {
  const { text, pos } = at("SELECT | FROM orders o");
  const r = completeSql(text, pos, "postgres", null, true);
  expect(r.items.some((i) => i.kind === "table" || i.kind === "column")).toBe(false);
  expect(r.items.find((i) => i.kind === "alias")?.label).toBe("o");
  expect(labels(r)).toContain("DISTINCT");
  const f = at("SELECT * FROM |");
  expect(completeSql(f.text, f.pos, "postgres", null, true).items.some((i) => i.kind === "table")).toBe(false);
});

test("templates_are_offered_by_name", () => {
  const r = pg("se|");
  expect(r.items[0]).toMatchObject({ label: "sel", kind: "template" });
  expect(labels(pg("|"))).toEqual(expect.arrayContaining(["sel", "selw", "cnt", "ins", "upd", "SELECT"]));
  const ins = SQL_TEMPLATES.find((t) => t.abbr === "ins");
  expect(ins?.onLeave).toEqual({ 1: "insertColumns" });
  const stores = KFC_SCHEMA.tables.find((t) => t.name === "stores")!;
  expect(insertColumnsTemplate(stores).body).toBe(
    " (id, code, name, city, opened_on, is_active)\nVALUES (${1:0}, ${2:''}, ${3:''}, ${4:''}, ${5:current_date}, ${6:true});$0",
  );
  // Statement starts after a `;` too.
  expect(labels(pg("SELECT 1; up|"))).toContain("upd");
});

test("names_that_need_quotes_complete_with_them", () => {
  const off = { aliasTables: false };
  const t = at("SELECT * FROM Ord|");
  const pgItems = completeSql(t.text, t.pos, "postgres", KFC_SCHEMA, true, off).items;
  expect(pgItems.find((i) => i.label === "Order Items")?.apply).toBe('"Order Items"');
  expect(pgItems.find((i) => i.label === "orders")?.apply).toBe("orders");
  const my = completeSql(t.text, t.pos, "mysql", KFC_SCHEMA, true, off).items;
  expect(my.find((i) => i.label === "Order Items")?.apply).toBe("`Order Items`");
  const c = at('SELECT i.| FROM "Order Items" i');
  expect(completeSql(c.text, c.pos, "postgres", KFC_SCHEMA, true).items.find((i) => i.label === "Note")?.apply).toBe('"Note"');
  // An alias is made from the name's letters, never a quoted one.
  const a = completeSql(t.text, t.pos, "postgres", KFC_SCHEMA, true).items.find((i) => i.label === "Order Items");
  expect(a?.apply).toBe('"Order Items" oi');
});

test("completion_survives_half_typed_sql", () => {
  const cases = [
    "SELECT o.| FROM orders o",
    "SELECT o.id, | FROM orders o",
    "SELECT * FROM (SELECT id FROM orders| ",
    "SELECT * FROM orders o WHERE o.total > (|",
    "SELECT ,,, | FROM",
    "SELECT 'unclosed |",
    "UPDATE |",
    ")))|",
    "SELECT * FROM orders o JOIN | ON",
  ];
  for (const c of cases) expect(() => pg(c, true)).not.toThrow();
  expect(labels(pg("SELECT o.| FROM orders o"))).toContain("total");
  expect(labels(pg("SELECT * FROM orders o WHERE o.total > (|", true))).toContain("SELECT");
  // Inside a string or a comment, nothing.
  expect(pg("SELECT 'abc|'").items).toEqual([]);
  expect(pg("SELECT 1 -- note |").items).toEqual([]);
});
