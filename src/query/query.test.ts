import { expect, test } from "vitest";
import { EMPTY_RUNNER, runnerReducer } from "./runner";
import { formatSql } from "./format";
import { writeWithoutWhere } from "./noWhere";
import { splitStatements, statementAt } from "./statements";

test("split_ignores_semicolons_in_strings_comments_and_dollar_quotes", () => {
  const pg = "SELECT 'a;b'; -- c;d\nSELECT \"x;y\" FROM t; /* e;f */ SELECT $f$ g; $f$; SELECT $$h;$$";
  expect(splitStatements(pg, "postgres").map((s) => s.text)).toEqual([
    "SELECT 'a;b'",
    '-- c;d\nSELECT "x;y" FROM t',
    "/* e;f */ SELECT $f$ g; $f$",
    "SELECT $$h;$$",
  ]);
  expect(splitStatements("SELECT `a;b`; # c;d\nSELECT 'it''s; \\'ok'", "mysql").map((s) => s.text)).toEqual([
    "SELECT `a;b`",
    "# c;d\nSELECT 'it''s; \\'ok'",
  ]);
});

test("split_reports_offsets_and_drops_comment_only_pieces", () => {
  const text = "  SELECT 1;\n-- only a note\n;\n\nSELECT 2";
  const s = splitStatements(text, "sqlite");
  expect(s.map((x) => x.text)).toEqual(["SELECT 1", "SELECT 2"]);
  expect(text.slice(s[0].from, s[0].to)).toBe("SELECT 1");
  expect(text.slice(s[1].from, s[1].to)).toBe("SELECT 2");
});

test("statement_at_picks_the_one_being_typed", () => {
  const text = "SELECT 1;\n\nSELECT 2;\n";
  const s = splitStatements(text, "postgres");
  expect(statementAt(s, 3)?.text).toBe("SELECT 1");
  expect(statementAt(s, 10)?.text).toBe("SELECT 1");
  expect(statementAt(s, text.indexOf("2"))?.text).toBe("SELECT 2");
  expect(statementAt([], 0)).toBeNull();
});

test("format_uppercases_keywords_and_breaks_clauses_only", () => {
  expect(
    formatSql(
      "select s.code, count(*) as late from stores s left join sales.orders o on o.store_id = s.id where o.note = 'from where' group by s.code -- order by x",
      "postgres",
    ),
  ).toBe(
    "SELECT s.code, count(*) AS late\nFROM stores s\nLEFT JOIN sales.orders o ON o.store_id = s.id\nWHERE o.note = 'from where'\nGROUP BY s.code -- order by x",
  );
});

test("missing_where_found_only_at_the_top_level", () => {
  expect(writeWithoutWhere("UPDATE sales.orders SET status = 'cancelled'")).toEqual({
    verb: "UPDATE",
    table: "sales.orders",
  });
  expect(writeWithoutWhere("delete from t")).toEqual({ verb: "DELETE", table: "t" });
  expect(writeWithoutWhere("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)")).toEqual({ verb: "UPDATE", table: "t" });
  expect(writeWithoutWhere("UPDATE t SET a = 1 WHERE id = 2")).toBeNull();
  expect(writeWithoutWhere("-- WHERE\nDELETE FROM t")).toEqual({ verb: "DELETE", table: "t" });
  expect(writeWithoutWhere("SELECT 1")).toBeNull();
});

test("split_keeps_trigger_and_routine_bodies_whole", () => {
  const sqlite = "CREATE TRIGGER t1 AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END;\nSELECT 1;";
  expect(splitStatements(sqlite, "sqlite").map((s) => s.text)).toEqual([
    "CREATE TRIGGER t1 AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END",
    "SELECT 1",
  ]);
  const mysql =
    "CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END;\nBEGIN;\nSELECT 2;";
  expect(splitStatements(mysql, "mysql").map((s) => s.text)).toEqual([
    "CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END",
    "BEGIN",
    "SELECT 2",
  ]);
});

test("explain_adds_a_plan_item_without_asking", () => {
  const stmt = { from: 0, to: 8, text: "SELECT 1" };
  let s = runnerReducer(EMPTY_RUNNER, { type: "explain", stmt, now: 5 });
  expect(s.ask).toBeNull();
  expect(s.queue).toEqual([]);
  expect(s.items).toHaveLength(1);
  expect(s.items[0]).toMatchObject({ sql: "SELECT 1", state: { s: "running" } });
  const plan = { nodes: [], raw: "x", totalCost: null };
  s = runnerReducer(s, { type: "planned", id: s.items[0].id, plan, ms: 7 });
  expect(s.items[0].state).toEqual({ s: "plan", plan, ms: 7 });
  expect(s.active).toBe(0);
});

test("explain_keeps_earlier_results_and_numbers_statements_per_run", () => {
  let s = runnerReducer(EMPTY_RUNNER, { type: "start", stmts: [{ from: 0, to: 1, text: "a" }, { from: 2, to: 3, text: "b" }] });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "done", id: s.items[0].id, outcome: { t: "affected", rows: 1 }, ms: 1 });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[1].id, error: { kind: "connect", message: "gone" } });
  expect(s.items[1].state).toMatchObject({ s: "error", index: 2, lost: true, notRun: [] });
  s = runnerReducer(s, { type: "explain", stmt: { from: 0, to: 1, text: "a" }, now: 0 });
  expect(s.items).toHaveLength(3);
});
