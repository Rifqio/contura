import { expect, test } from "vitest";
import type { DialectKind } from "../../api/types";
import { analyzeSql } from "./analyze";
import { KFC_SCHEMA } from "./fixtures";
import { type QueryShape, queryShape, resultHeader, type ShapeProblem } from "./queryShape";
import type { SqlSchema } from "./types";

function shape(text: string, dialect: DialectKind = "postgres", schema: SqlSchema | null = KFC_SCHEMA, pos = 0): QueryShape {
  const s = queryShape(analyzeSql(text, dialect, schema), pos);
  if ("kind" in s) throw new Error(`expected a shape, got ${JSON.stringify(s)}`);
  return s;
}
const problem = (text: string, pos = 0): ShapeProblem => queryShape(analyzeSql(text, "postgres", KFC_SCHEMA), pos) as ShapeProblem;

/** A card's alias (or name) by its key, for readable assertions. */
const aliasOf = (s: QueryShape, key: string) => {
  const t = s.tables.find((x) => x.key === key);
  return t ? (t.alias ?? t.name) : `?${key}`;
};
const lines = (s: QueryShape) =>
  s.joins.map((j) => ({
    kind: j.kind,
    from: aliasOf(s, j.from),
    to: aliasOf(s, j.to),
    label: j.label,
    on: (j.ports ?? []).map((p) => [`${aliasOf(s, p.from.node)}.${p.from.port}`, `${aliasOf(s, p.to.node)}.${p.to.port}`]),
  }));

const LATE = `SELECT s.name,
       s.city,
       count(o.id) AS late_orders,
       sum(o.total) AS late_total
FROM sales.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN public.customers AS c ON c.id = o.customer_id
WHERE o.status = 'late'
  AND o.placed_at >= '2026-10-01'
  AND o.channel IN ('app', 'kiosk')
GROUP BY s.name, s.city
ORDER BY late_orders DESC, s.name
LIMIT 50`;

test("join_kinds_and_on_pairs", () => {
  const s = shape(
    "SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id LEFT JOIN customers c ON o.customer_id = c.id RIGHT OUTER JOIN sales.order_items i ON i.order_id = o.id FULL JOIN menu_items m ON m.id = i.menu_item_id CROSS JOIN archive.orders_2019 a",
  );
  expect(lines(s)).toEqual([
    { kind: "inner", from: "s", to: "o", label: "Inner join", on: [["s.id", "o.store_id"]] },
    { kind: "left", from: "c", to: "o", label: "Left join", on: [["c.id", "o.customer_id"]] },
    { kind: "right", from: "i", to: "o", label: "Right join", on: [["i.order_id", "o.id"]] },
    { kind: "full", from: "m", to: "i", label: "Full join", on: [["m.id", "i.menu_item_id"]] },
    { kind: "cross", from: "a", to: "m", label: "Cross join", on: [] },
  ]);
  expect(s.joins[4].ports).toBeUndefined();
});

test("a_non_equal_on_part_is_a_labelled_condition_line", () => {
  const s = shape("SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id AND o.total > 100");
  expect(lines(s)).toEqual([
    { kind: "inner", from: "s", to: "o", label: "Inner join", on: [["s.id", "o.store_id"]] },
    { kind: "condition", from: "s", to: "o", label: "o.total > 100", on: [] },
  ]);
  const long = shape("SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id AND o.status IN ('late', 'cancelled', 'refunded', 'lost')");
  expect(long.joins[1].label.length).toBeLessThanOrEqual(40);
});

test("comma_join_with_a_where_equality_is_cross_plus_a_where_line", () => {
  const text = "SELECT o.id FROM sales.orders o, stores s WHERE s.id = o.store_id AND o.total > 5";
  const s = shape(text);
  expect(lines(s)).toEqual([
    { kind: "cross", from: "s", to: "o", label: "Cross join", on: [] },
    { kind: "where", from: "s", to: "o", label: "in WHERE", on: [["s.id", "o.store_id"]] },
  ]);
  expect(text.slice(s.joins[1].range.from, s.joins[1].range.to)).toBe("s.id = o.store_id");
});

test("natural_and_using_pair_the_shared_names", () => {
  const u = shape("SELECT o.id FROM sales.orders o JOIN sales.order_items i USING (id)");
  expect(lines(u)[0]).toMatchObject({ kind: "inner", on: [["i.id", "o.id"]] });
  const n = shape("SELECT * FROM archive.orders_2019 a NATURAL LEFT JOIN sales.orders o");
  expect(lines(n)[0]).toMatchObject({ kind: "left", on: [["o.id", "a.id"], ["o.total", "a.total"]] });
});

test("the_spec_example_reads_outputs_sources_types_and_clauses", () => {
  const s = shape(LATE);
  expect(s.tables.map((t) => [t.alias, t.kind, t.schema, t.name])).toEqual([
    ["o", "table", "sales", "orders"],
    ["s", "table", "public", "stores"],
    ["c", "table", "public", "customers"],
  ]);
  expect(s.result.columns.map((c) => [c.name, c.source, c.type])).toEqual([
    ["name", "s.name", "varchar(120)"],
    ["city", "s.city", "varchar(60)"],
    ["late_orders", "count(o.id)", "bigint"],
    ["late_total", "sum(o.total)", "numeric"],
  ]);
  expect(s.result.columns[2].from).toEqual([{ node: s.tables[0].key, port: "id" }]);
  expect(s.result.clauses.map((c) => `${c.keyword} ${c.text}`)).toEqual([
    "WHERE 3 conditions on o",
    "GROUP BY s.name, s.city",
    "ORDER BY late_orders DESC, s.name",
    "LIMIT 50",
  ]);
  expect(s.result.limit).toBe("50");
  expect(resultHeader(s)).toBe("4 columns, up to 50 rows");
  expect(s.result.sorts.map((x) => [x.output, x.desc])).toEqual([
    [2, true],
    [0, false],
  ]);
  expect(LATE.slice(s.result.selectRange.from, s.result.selectRange.to)).toMatch(/^SELECT s\.name,[\s\S]*AS late_total$/);
  // Card rows: the columns the statement uses, primary key first.
  expect(s.tables[0].columns.map((c) => c.name)).toEqual(["id", "store_id", "customer_id", "channel", "status", "total", "placed_at"]);
  expect(s.tables[1].columns.map((c) => [c.name, c.pk])).toEqual([
    ["id", true],
    ["name", false],
    ["city", false],
  ]);
  expect(s.tables[1].more).toBe(3);
  expect(s.tables[2].columns.map((c) => c.name)).toEqual(["id"]);
  expect(s.note).toBeNull();
});

test.each([
  ["postgres", "bigint", "numeric"],
  ["mysql", "bigint", "decimal"],
  ["sqlite", "integer", null],
] as const)("aggregate_types_on_%s", (dialect, count, sum) => {
  const s = shape("SELECT count(o.id) AS n, sum(o.total) AS t, avg(o.total), max(o.placed_at) AS last, o.total + 1 AS bumped FROM sales.orders o", dialect);
  expect(s.result.columns.map((c) => [c.name, c.type])).toEqual([
    ["n", count],
    ["t", sum],
    ["avg(o.total)", sum],
    ["last", "timestamptz"],
    ["bumped", null],
  ]);
});

test("star_expands_with_a_schema_and_not_without", () => {
  const s = shape("SELECT * FROM stores");
  expect(s.result.columns.map((c) => c.name)).toEqual(["id", "code", "name", "city", "opened_on", "is_active"]);
  expect(s.tables[0].columns).toHaveLength(6);
  const q = shape("SELECT o.*, s.name FROM sales.orders o JOIN stores s ON s.id = o.store_id");
  expect(q.result.columns.map((c) => c.name)).toEqual(["id", "store_id", "customer_id", "channel", "status", "total", "placed_at", "name"]);
  const none = shape("SELECT * FROM stores", "postgres", null);
  expect(none.result.columns.map((c) => [c.name, c.type])).toEqual([["*", null]]);
  expect(none.tables[0]).toMatchObject({ kind: "table", name: "stores", schemaState: "none", columns: [] });
});

test("over_thirty_output_rows_count_the_rest_as_more", () => {
  const wide: SqlSchema = {
    searchPath: ["public"],
    tables: [{ schema: "public", name: "wide", kind: "table", columns: Array.from({ length: 34 }, (_, i) => ({ name: `c${i}`, typeName: "int4", pk: i === 0 })) }],
    fks: [],
  };
  const s = shape("SELECT * FROM wide", "postgres", wide);
  expect(s.result.columns).toHaveLength(30);
  expect(s.result.more).toBe(4);
  expect(resultHeader(s)).toBe("34 columns, all rows");
  expect(s.tables[0].columns).toHaveLength(30);
  expect(s.tables[0].more).toBe(4);
});

test("a_cte_and_a_subquery_are_derived_cards", () => {
  const s = shape(
    "WITH d AS (SELECT store_id, count(*) AS n FROM sales.orders GROUP BY store_id) SELECT s.name, d.n, x.amount FROM d JOIN stores s ON s.id = d.store_id JOIN (SELECT id, total AS amount FROM sales.orders) x ON x.id = d.store_id",
  );
  expect(s.tables.map((t) => [t.kind, t.name, t.alias])).toEqual([
    ["derived", "d", null],
    ["table", "stores", "s"],
    ["derived", "x", "x"],
  ]);
  expect(s.tables[0].columns.map((c) => c.name)).toEqual(["store_id", "n"]);
  expect(s.tables[2].columns.map((c) => c.name)).toEqual(["id", "amount"]);
  expect(lines(s)[0]).toMatchObject({ kind: "inner", on: [["s.id", "d.store_id"]] });
});

test("an_unknown_table_is_its_own_kind_with_the_columns_named", () => {
  const s = shape("SELECT o.id, z.amount FROM sales.orders o JOIN zebras z ON z.order_id = o.id");
  expect(s.tables[1]).toMatchObject({ kind: "unknown", name: "zebras", alias: "z", schemaState: "loaded" });
  expect(s.tables[1].columns.map((c) => [c.name, c.type])).toEqual([
    ["amount", null],
    ["order_id", null],
  ]);
  expect(lines(s)[0].on).toEqual([["z.order_id", "o.id"]]);
});

test("schema_state_tells_none_from_loading_from_loaded", () => {
  const text = "SELECT s.name FROM stores s";
  const at = (schema: SqlSchema | null, state?: "none" | "loading" | "loaded") => {
    const r = queryShape(analyzeSql(text, "postgres", schema), 0, state) as QueryShape;
    return r.tables[0].schemaState;
  };
  expect(at(null)).toBe("none");
  expect(at(null, "loading")).toBe("loading");
  expect(at(null, "loaded")).toBe("none");
  expect(at(KFC_SCHEMA, "loaded")).toBe("loaded");
  const d = queryShape(analyzeSql("SELECT x.a FROM (SELECT 1 AS a) x", "postgres", null), 0, "loading") as QueryShape;
  expect(d.tables[0].schemaState).toBe("loaded");
});

test("a_misspelled_verb_is_a_syntax_problem_not_a_write", () => {
  expect(problem("SELEC * FROM stores")).toEqual({ kind: "syntax", line: 1, message: "Unknown statement SELEC. Did you mean SELECT?" });
  expect(problem("WITH d AS (SELECT 1)")).toEqual({ kind: "syntax", line: 1, message: "Expected SELECT after the WITH list." });
  expect(problem("CREATE TABLE t (id int)")).toEqual({ kind: "notRead", verb: "CREATE" });
});

test("limit_all_and_fetch_first", () => {
  expect(shape("SELECT id FROM stores LIMIT ALL").result.limit).toBeNull();
  const f = shape("SELECT id FROM stores ORDER BY id FETCH FIRST 10 ROWS ONLY");
  expect(f.result.limit).toBe("10");
  expect(f.result.clauses.map((c) => `${c.keyword} ${c.text}`)).toEqual(["ORDER BY id", "FETCH FIRST 10 ROWS ONLY"]);
});

test("an_on_pair_between_two_earlier_tables_is_a_condition_line", () => {
  const s = shape("SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id JOIN customers c ON c.id = o.customer_id AND s.id = o.store_id");
  expect(lines(s).slice(1)).toEqual([
    { kind: "inner", from: "c", to: "o", label: "Inner join", on: [["c.id", "o.customer_id"]] },
    { kind: "condition", from: "c", to: "s", label: "s.id = o.store_id", on: [] },
  ]);
});

test("a_parenthesised_first_part_still_gets_the_note", () => {
  const s = shape("(SELECT id FROM stores) UNION (SELECT id FROM customers)");
  expect(s.note).toBe("Shows the first of 2 parts of a UNION.");
  expect(s.tables.map((t) => t.name)).toEqual(["stores"]);
});

test("shape_is_linear_in_the_number_of_joins", () => {
  const n = 2000;
  const parts = ["SELECT t0.id FROM t0"];
  for (let i = 1; i <= n; i++) parts.push(`JOIN t${i} ON t${i}.id = t${i - 1}.next_id AND t${i}.kind > 1`);
  const a = analyzeSql(parts.join("\n"), "postgres", null);
  const t0 = performance.now();
  const s = queryShape(a, 0) as QueryShape;
  const ms = performance.now() - t0;
  expect(s.tables).toHaveLength(n + 1);
  expect(s.joins).toHaveLength(2 * n);
  expect(ms).toBeLessThan(400);
});

test("a_view_is_a_view_card", () => {
  expect(shape("SELECT v.day FROM sales.v_store_daily_sales v").tables[0].kind).toBe("view");
});

test("update_is_not_read", () => {
  expect(problem("UPDATE sales.orders SET status = 'x' WHERE id = 1")).toEqual({ kind: "notRead", verb: "UPDATE" });
  expect(problem("WITH d AS (SELECT 1) DELETE FROM stores WHERE id IN (SELECT * FROM d)")).toEqual({ kind: "notRead", verb: "DELETE" });
});

test("no_statement_where_the_editor_is", () => {
  const text = "SELECT 1;\n\n;SELECT 2";
  expect(problem(text, text.indexOf("\n\n") + 1)).toEqual({ kind: "noStatement" });
  expect(problem("")).toEqual({ kind: "noStatement" });
});

test("a_union_draws_the_first_part_with_a_note", () => {
  const s = shape("SELECT s.name FROM stores s WHERE s.is_active UNION SELECT c.full_name FROM customers c ORDER BY 1");
  expect(s.note).toBe("Shows the first of 2 parts of a UNION.");
  expect(s.tables.map((t) => t.alias)).toEqual(["s"]);
  expect(s.result.columns.map((c) => c.name)).toEqual(["name"]);
  expect(s.result.clauses.map((c) => c.keyword)).toEqual(["WHERE"]);
  expect(shape("SELECT id FROM stores EXCEPT SELECT id FROM customers INTERSECT SELECT id FROM menu_items").note).toBe("Shows the first of 3 parts of an EXCEPT.");
});

test("a_syntax_error_names_its_line", () => {
  const text = [
    "SELECT s.name,",
    "       s.city,",
    "       count(o.id) AS late_orders",
    "FROM sales.orders AS o",
    "JOIN public.stores AS s ON s.id = o.store_id",
    "LEFT JOIN public.customers AS c ON c.id = o.customer_id",
    "WHERE o.status = 'late'",
    "  AND o.channel = 'app'",
    "  AND o.total > 3",
    "  AND o.placed_at >=",
    "GROUP BY s.name, s.city",
  ].join("\n");
  expect(problem(text, 5)).toEqual({ kind: "syntax", line: 10, message: "A value is missing after >=." });
});

test("self_join_draws_two_cards", () => {
  const s = shape("SELECT o.id, o2.id AS other FROM sales.orders o JOIN sales.orders o2 ON o2.customer_id = o.customer_id");
  expect(s.tables).toHaveLength(2);
  expect(new Set(s.tables.map((t) => t.key)).size).toBe(2);
  expect(lines(s)[0].on).toEqual([["o2.customer_id", "o.customer_id"]]);
  const twice = shape("SELECT 1 FROM stores JOIN stores ON true");
  expect(new Set(twice.tables.map((t) => t.key)).size).toBe(2);
});

test("an_alias_without_as_is_read", () => {
  const s = shape("SELECT o.id FROM sales.orders o");
  expect(s.tables[0]).toMatchObject({ alias: "o", schema: "sales", name: "orders" });
});

test("distinct_and_having_lines", () => {
  const s = shape("SELECT DISTINCT s.city FROM stores s GROUP BY s.city HAVING count(*) > 1");
  expect(s.result.clauses.map((c) => `${c.keyword}${c.text ? " " + c.text : ""}`)).toEqual(["DISTINCT", "GROUP BY s.city", "HAVING 1 condition"]);
});

test("card_ranges_cover_the_reference_and_its_join", () => {
  const text = "SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id";
  const s = shape(text);
  const texts = s.tables[1].ranges.map((r) => text.slice(r.from, r.to));
  expect(texts).toContain("stores s");
  expect(texts).toContain("JOIN stores s ON s.id = o.store_id");
});

// Each Core golden statement, read back, gives the hand-written shape.
const golden = import.meta.glob("../../../crates/contura-core/src/visual_query/golden/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const goldenFile = (name: string) => Object.entries(golden).find(([p]) => p.endsWith(`/${name}`))?.[1];
const shapeFiles = Object.keys(golden).filter((p) => p.endsWith(".shape.json"));

type GoldenShape = {
  dialect: DialectKind;
  tables: { alias: string; schema: string | null; name: string }[];
  joins: { table: string; kind: string; on: [string, string][] }[];
  outputs: string[];
};

test("golden_files_are_found", () => {
  expect(shapeFiles.length).toBeGreaterThan(0);
});

test.each(shapeFiles.map((p) => [p.slice(p.lastIndexOf("/") + 1, -".shape.json".length)]))("golden_sql_matches_its_model: %s", (name) => {
  const want = JSON.parse(goldenFile(`${name}.shape.json`)!) as GoldenShape;
  const sql = goldenFile(`${name}.${want.dialect}.sql`)!.replace(/\r\n?/g, "\n");
  const s = shape(sql, want.dialect, null);
  expect(s.tables.map((t) => ({ alias: t.alias, schema: t.schema, name: t.name }))).toEqual(want.tables);
  expect(
    lines(s)
      .filter((j) => j.kind !== "where" && j.kind !== "condition")
      .map((j) => ({ table: j.from, kind: j.kind, on: j.on })),
  ).toEqual(want.joins);
  expect(s.result.columns.map((c) => c.name)).toEqual(want.outputs);
});

test.each(["(SELECT id FROM stores) UNION (SELECT id FROM customers)", "((SELECT id FROM stores))", "((SELECT id FROM stores)) UNION ((SELECT id FROM customers))"])(
  "a_statement_in_brackets_is_a_read: %s",
  (text) => {
    const s = shape(text);
    expect(s.tables.map((t) => t.name)).toEqual(["stores"]);
    expect(s.result.columns.map((c) => c.name)).toEqual(["id"]);
    expect(s.note).toBe(text.includes("UNION") ? "Shows the first of 2 parts of a UNION." : null);
  },
);

test("with_values_and_with_table_are_reads", () => {
  const v = shape("WITH x AS (SELECT 1) VALUES (1, 'a', now())");
  expect(v.result.columns.map((c) => c.name)).toEqual(["column1", "column2", "column3"]);
  expect(shape("VALUES (1, 2)", "mysql").result.columns.map((c) => c.name)).toEqual(["column_0", "column_1"]);
  const t = shape("WITH x AS (SELECT 1) TABLE stores");
  expect(t.tables.map((x) => [x.kind, x.schema, x.name])).toEqual([["table", "public", "stores"]]);
  expect(t.result.columns).toHaveLength(6);
  expect(shape("TABLE nope").tables[0].kind).toBe("unknown");
  // A CTE body of VALUES is not the main verb.
  expect(shape("WITH x (a) AS (VALUES (1)) SELECT a FROM x").tables[0].kind).toBe("derived");
});

test.each([
  ["WITH d AS (SELECT 1) INSERT INTO stores (id) SELECT * FROM d", "INSERT"],
  ["WITH d AS (SELECT 1) UPDATE stores SET name = 'x' WHERE id = 1", "UPDATE"],
  ["WITH d AS (SELECT 1) DELETE FROM stores WHERE id = 1", "DELETE"],
])("a_with_list_before_a_write_is_not_read: %s", (text, verb) => {
  expect(problem(text)).toEqual({ kind: "notRead", verb });
});

test.each(
  "HELP PURGE SIGNAL RESIGNAL XA GET STOP CACHE CHANGE BINLOG SHUTDOWN RESTART CLONE REASSIGN DELIMITER PRAGMA ATTACH VACUUM REINDEX CHECKPOINT SECURITY IMPORT".split(" "),
)("known_verb_is_not_read: %s", (verb) => {
  expect(problem(`${verb} something`)).toEqual({ kind: "notRead", verb });
});
