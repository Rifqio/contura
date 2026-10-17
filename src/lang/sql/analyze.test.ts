import { expect, test } from "vitest";
import { analyzeSql, refAt, symbolAt } from "./analyze";
import { at, KFC_SCHEMA } from "./fixtures";

const pg = (text: string) => analyzeSql(text, "postgres", KFC_SCHEMA);

test("aliases_resolve_to_their_tables", () => {
  const { text, pos } = at("SELECT o.|total FROM orders o JOIN stores s ON s.id = o.store_id");
  const a = pg(text);
  const r = refAt(a, pos, "o");
  expect(r?.kind).toBe("table");
  expect(r?.table?.schema).toBe("sales");
  expect(r?.table?.name).toBe("orders");
  const sym = symbolAt(a, text.indexOf("total"));
  expect(sym).toMatchObject({ kind: "column", column: { name: "total" } });
});

test("ctes_and_subqueries_expose_their_columns", () => {
  const { text, pos } = at(
    "WITH d AS (SELECT store_id, count(*) AS n FROM sales.orders GROUP BY store_id) SELECT d.| FROM d",
  );
  const r = refAt(pg(text), pos, "d");
  expect(r?.kind).toBe("cte");
  expect(r?.columns?.map((c) => c.name)).toEqual(["store_id", "n"]);

  const sub = at("SELECT x.| FROM (SELECT id, total AS amount FROM orders) x");
  const rs = refAt(pg(sub.text), sub.pos, "x");
  expect(rs?.kind).toBe("subquery");
  expect(rs?.columns?.map((c) => c.name)).toEqual(["id", "amount"]);
});

test("search_path_resolves_unqualified_names", () => {
  const a = pg("SELECT * FROM orders");
  expect(a.statements[0].blocks[0].refs[0].table?.schema).toBe("sales");
  const off = analyzeSql("SELECT * FROM orders_2019", "postgres", KFC_SCHEMA);
  expect(off.statements[0].blocks[0].refs[0].kind).toBe("unknown");
  const q = analyzeSql("SELECT * FROM archive.orders_2019", "postgres", KFC_SCHEMA);
  expect(q.statements[0].blocks[0].refs[0].table?.name).toBe("orders_2019");
});

test("quoted_and_cased_names_resolve", () => {
  const a = pg('SELECT i."Note" FROM "Order Items" i');
  expect(a.statements[0].blocks[0].refs[0].table?.name).toBe("Order Items");
  expect(a.problems.filter((p) => p.kind === "schema")).toEqual([]);
  const up = pg("SELECT ID FROM STORES");
  expect(up.statements[0].blocks[0].refs[0].table?.name).toBe("stores");
  const my = analyzeSql("SELECT `code` FROM `stores`", "mysql", KFC_SCHEMA);
  expect(my.statements[0].blocks[0].refs[0].table?.name).toBe("stores");
});

test("statements_are_separate_scopes", () => {
  const text = "SELECT * FROM orders o; SELECT o.id FROM stores s";
  const a = pg(text);
  expect(a.statements).toHaveLength(2);
  expect(refAt(a, text.lastIndexOf("o.id"), "o")).toBeNull();
});

test("insert_update_delete_targets_are_refs", () => {
  const ins = pg("INSERT INTO stores (code, name) VALUES ('a', 'b')");
  expect(ins.statements[0].blocks[0].refs[0]).toMatchObject({ kind: "table", target: true, name: "stores" });
  const upd = pg("UPDATE sales.orders SET status = 'x' WHERE id = 1");
  expect(upd.statements[0].blocks[0].refs[0]).toMatchObject({ kind: "table", target: true, name: "orders" });
  const del = pg("DELETE FROM menu_items WHERE id = 1");
  expect(del.statements[0].blocks[0].refs[0]).toMatchObject({ kind: "table", name: "menu_items" });
});

/** NF5: PostgreSQL's typed literals are a keyword and a string, never an unknown column. */
test.each([
  "SELECT id FROM sales.orders WHERE placed_at >= TIMESTAMP '2026-10-01'",
  "SELECT id FROM sales.orders WHERE placed_at >= timestamp '2026-10-01 08:00'",
  "SELECT id FROM sales.orders WHERE placed_at::date = DATE '2026-10-01'",
  "SELECT id FROM sales.orders WHERE placed_at::time > TIME '08:00'",
  "SELECT id FROM sales.orders WHERE placed_at > now() - INTERVAL '7 days'",
  "SELECT id FROM sales.orders WHERE placed_at >= TIMESTAMPTZ '2026-10-01'",
  "SELECT id FROM sales.orders WHERE placed_at >= TIMESTAMP WITH TIME ZONE '2026-10-01 08:00+02'",
  "SELECT id FROM sales.orders WHERE placed_at >= TIMESTAMP WITHOUT TIME ZONE '2026-10-01'",
])("typed_literal_is_not_an_error: %s", (sql) => {
  expect(pg(sql).problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("a_column_named_like_a_type_still_resolves_without_a_string", () => {
  // `date` without a string after it is a name, so an unknown one is still reported.
  const a = pg("SELECT date FROM sales.orders");
  expect(a.problems.map((p) => p.message)).toContain("Unknown column date.");
  expect(pg("SELECT day FROM sales.v_store_daily_sales WHERE day = DATE '2026-10-01'").problems.filter((p) => p.severity === "error")).toEqual([]);
});
