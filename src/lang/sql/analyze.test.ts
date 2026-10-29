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

/** MySQL's GROUP_CONCAT(... SEPARATOR ', ') takes SEPARATOR as a keyword before its string, never a column (owner, 29 Oct). */
test.each([
  "SELECT GROUP_CONCAT(DISTINCT status ORDER BY status SEPARATOR ', ') AS statuses FROM sales.orders",
  "SELECT group_concat(status separator ';') FROM sales.orders",
  "SELECT GROUP_CONCAT(status SEPARATOR '') FROM sales.orders GROUP BY store_id",
])("group_concat_separator_is_not_a_column: %s", (sql) => {
  expect(analyzeSql(sql, "mysql", KFC_SCHEMA).problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("a_column_named_separator_is_still_checked_outside_group_concat", () => {
  const msgs = (sql: string) => analyzeSql(sql, "mysql", KFC_SCHEMA).problems.map((p) => p.message);
  expect(msgs("SELECT separator FROM sales.orders")).toContain("Unknown column separator.");
  // Without a string after it, SEPARATOR inside GROUP_CONCAT is a name too.
  expect(msgs("SELECT GROUP_CONCAT(separator) FROM sales.orders")).toContain("Unknown column separator.");
});

const slice = (text: string, r: { from: number; to: number } | null | undefined) => (r ? text.slice(r.from, r.to) : null);

test("join_kinds_and_on_ranges_sit_on_each_reference", () => {
  const text = [
    "SELECT o.id FROM sales.orders o",
    "JOIN stores s ON s.id = o.store_id",
    "LEFT OUTER JOIN customers c ON c.id = o.customer_id AND c.points > 3",
    "RIGHT JOIN menu_items m USING (id)",
    "FULL JOIN sales.order_items i ON i.order_id = o.id",
    "CROSS JOIN archive.orders_2019 a",
    "NATURAL INNER JOIN sales.v_store_daily_sales v,",
    "  customers c2",
    "WHERE o.total > 1",
  ].join("\n");
  const refs = pg(text).statements[0].blocks[0].refs;
  expect(refs.map((r) => r.join?.kind ?? null)).toEqual([null, "inner", "left", "right", "full", "cross", "inner", "comma"]);
  expect(slice(text, refs[1].join?.on)).toBe("s.id = o.store_id");
  expect(slice(text, refs[2].join?.on)).toBe("c.id = o.customer_id AND c.points > 3");
  expect(refs[3].join).toMatchObject({ using: ["id"], on: null, natural: false });
  expect(refs[6].join).toMatchObject({ natural: true, using: null, on: null });
  expect(slice(text, refs[2].join?.range)).toBe("LEFT OUTER JOIN customers c ON c.id = o.customer_id AND c.points > 3");
  expect(refs[5].join?.on).toBeNull();
});

test("select_items_carry_sources_alias_and_function", () => {
  const text = "SELECT s.name, count(o.id) AS late_orders, o.total * 2 doubled, status FROM sales.orders o JOIN stores s ON s.id = o.store_id";
  const sel = pg(text).statements[0].blocks[0].select;
  expect(sel.map((x) => x.text)).toEqual(["s.name", "count(o.id)", "o.total * 2", "status"]);
  expect(sel.map((x) => x.alias)).toEqual([null, "late_orders", "doubled", null]);
  expect(sel.map((x) => x.column)).toEqual(["name", null, null, "status"]);
  expect(sel.map((x) => x.fn)).toEqual([null, "count", null, null]);
  expect(sel[0].sources.map((x) => `${x.ref.alias}.${x.column}`)).toEqual(["s.name"]);
  expect(sel[1].sources.map((x) => `${x.ref.alias}.${x.column}`)).toEqual(["o.id"]);
  expect(sel[3].sources.map((x) => `${x.ref.alias}.${x.column}`)).toEqual(["o.status"]);
  expect(slice(text, sel[1].range)).toBe("count(o.id) AS late_orders");
});

test("clause_ranges_and_distinct", () => {
  const text = "SELECT DISTINCT s.city FROM stores s WHERE s.is_active GROUP BY s.city HAVING count(*) > 1 ORDER BY s.city DESC LIMIT 5";
  const b = pg(text).statements[0].blocks[0];
  expect(b.distinct).toBe(true);
  expect(b.clauses.map((c) => [c.keyword, slice(text, c.range)])).toEqual([
    ["WHERE", "WHERE s.is_active"],
    ["GROUP BY", "GROUP BY s.city"],
    ["HAVING", "HAVING count(*) > 1"],
    ["ORDER BY", "ORDER BY s.city DESC"],
    ["LIMIT", "LIMIT 5"],
  ]);
  expect(pg("SELECT id FROM stores").statements[0].blocks[0].distinct).toBe(false);
});

test("order_by_a_qualified_column_reads_back_as_its_output", () => {
  const text = "SELECT s.name, count(o.id) AS late_orders FROM sales.orders o JOIN stores s ON s.id = o.store_id GROUP BY s.name ORDER BY late_orders DESC, s.name, 1, o.id";
  const b = pg(text).statements[0].blocks[0];
  expect(b.orderBy.map((x) => [x.text, x.desc, x.output])).toEqual([
    ["late_orders", true, 1],
    ["s.name", false, 0],
    ["1", false, 0],
    ["o.id", false, null],
  ]);
});

test("a_comparison_without_a_value_is_a_syntax_problem", () => {
  const a = pg("SELECT id FROM sales.orders o\nWHERE o.placed_at >=\nGROUP BY id");
  const p = a.problems.find((x) => x.kind === "syntax");
  expect(p?.message).toBe("A value is missing after >=.");
  expect(pg("SELECT id FROM sales.orders o WHERE o.total =").problems.map((x) => x.message)).toContain("A value is missing after =.");
  expect(pg("SELECT id FROM sales.orders o WHERE o.total <> 1 AND o.id >= 2").problems.filter((x) => x.kind === "syntax")).toEqual([]);
});

test("doubled_quotes_inside_a_quoted_name_read_as_one", () => {
  const a = analyzeSql('SELECT o."say ""hi""" FROM orders o', "postgres", null);
  expect(a.statements[0].blocks[0].select[0].column).toBe('say "hi"');
});

const unknownTables = (a: ReturnType<typeof analyzeSql>) => a.problems.filter((p) => p.message.startsWith("Unknown table"));
const columnAt = (a: ReturnType<typeof analyzeSql>, text: string, word: string) => symbolAt(a, text.lastIndexOf(word))?.kind;

test.each([
  ["mysql", "UPDATE sales.orders o JOIN stores s ON s.id = o.store_id SET o.status = 'x', o.channel = 'y' WHERE s.id = 1"],
  ["postgres", "INSERT INTO sales.orders (id, status) SELECT s.id, s.code FROM stores s JOIN customers c ON c.id = s.id ON CONFLICT (id) DO UPDATE SET status = 'x', channel = 'y'"],
  ["mysql", "INSERT INTO sales.orders (id, status) SELECT s.id, s.code FROM stores s JOIN customers c ON c.id = s.id ON DUPLICATE KEY UPDATE status = 'x', channel = 'y'"],
] as const)("an_on_condition_stops_before_set_and_its_commas_are_not_tables: %s %s", (dialect, text) => {
  const a = analyzeSql(text, dialect, KFC_SCHEMA);
  expect(unknownTables(a)).toEqual([]);
  expect(columnAt(a, text, "channel")).toBe("column");
  expect(a.statements[0].blocks.flatMap((b) => b.refs).some((r) => r.join?.kind === "comma")).toBe(false);
});

test("a_comparison_after_using_or_inside_operator_is_not_missing_a_value", () => {
  expect(pg("SELECT id FROM stores ORDER BY id USING >").problems.filter((p) => p.kind === "syntax")).toEqual([]);
  expect(pg("SELECT id FROM stores WHERE id OPERATOR(pg_catalog.=) 1").problems.filter((p) => p.message.startsWith("A value"))).toEqual([]);
});

test("except_and_intersect_end_a_select_list", () => {
  const a = analyzeSql("SELECT 1 AS a EXCEPT SELECT 2", "postgres", null);
  expect(a.statements[0].blocks[0].select.map((x) => x.text)).toEqual(["1"]);
  expect(pg("SELECT id FROM EXCEPT SELECT 1").problems.map((p) => p.message)).toContain("Expected a table name after FROM.");
});

// ---- Routine and compound bodies: NEW, OLD, locals, parameters and labels are not schema names ----

const TRIGGER_SCRIPT =
  "DELIMITER $$\nCREATE TRIGGER products_audit AFTER UPDATE ON products FOR EACH ROW BEGIN DECLARE n INT; SET n = NEW.id; INSERT INTO delim_log (note) VALUES (CONCAT('updated ', n)); END$$\nDELIMITER ;\n";

test("compound_bodies_have_no_schema_problems", () => {
  const my = analyzeSql(TRIGGER_SCRIPT, "mysql", KFC_SCHEMA);
  expect(my.problems.filter((p) => p.kind === "schema")).toEqual([]);
  // The same in a plain `;` script, and for a procedure's parameters and labels.
  const plain = analyzeSql(
    "CREATE PROCEDURE p(IN x INT) BEGIN lbl: LOOP SELECT x FROM nowhere WHERE OLD.a = 1; LEAVE lbl; END LOOP lbl; END;",
    "mysql",
    KFC_SCHEMA,
  );
  expect(plain.problems.filter((p) => p.kind === "schema")).toEqual([]);
});

test("compound_bodies_still_report_syntax_problems", () => {
  const text = "DELIMITER $$\nCREATE TRIGGER t AFTER UPDATE ON products FOR EACH ROW BEGIN SET @n = (1 + NEW.id; END$$\nDELIMITER ;\n";
  const a = analyzeSql(text, "mysql", KFC_SCHEMA);
  expect(a.problems.filter((p) => p.kind === "syntax").map((p) => p.message)).toContain("This ( is never closed.");
  expect(a.problems.filter((p) => p.kind === "schema")).toEqual([]);
});

test("a_statement_after_the_delimiter_block_still_gets_schema_problems", () => {
  const text = `${TRIGGER_SCRIPT}SELECT * FROM bogus_table;`;
  const a = analyzeSql(text, "mysql", KFC_SCHEMA);
  const schema = a.problems.filter((p) => p.kind === "schema");
  expect(schema.map((p) => p.message.startsWith("Unknown table"))).toEqual([true]);
  expect(text.slice(schema[0].from, schema[0].to)).toBe("bogus_table");
});
