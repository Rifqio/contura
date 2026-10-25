import { expect, test } from "vitest";
import { EMPTY_RUNNER, runnerReducer } from "./runner";
import { formatSql } from "./format";
import { splitStatements, statementAt } from "./statements";
import { tokenize } from "../lang/sql/tokens";
import splitCases from "./fixtures/splitCases.json";

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

test("round_5_end_case_closes_and_the_routine_ends_where_the_core_ends_it", () => {
  const proc =
    "CREATE PROCEDURE p()\nBEGIN\n  CASE WHEN a THEN SELECT 2; END CASE;\n  IF x THEN SELECT 1; END IF;\n  BEGIN SELECT 3; END;\nEND";
  expect(splitStatements(`${proc};\nSELECT 9;`, "mysql").map((s) => s.text)).toEqual([proc, "SELECT 9"]);
});

// ---- Round 6 (N4): only a real routine's CREATE opens a body, as in the Core ----

const DIALECTS = ["mysql", "postgres", "sqlite"] as const;
const texts = (sql: string, d: (typeof DIALECTS)[number]) => splitStatements(sql, d).map((s) => s.text);

test("n4_a_plain_create_with_routine_words_never_swallows_the_next_statement", () => {
  for (const d of DIALECTS) {
    expect(texts("CREATE TABLE shifts (begin time, event text); DELETE FROM t", d)).toEqual(["CREATE TABLE shifts (begin time, event text)", "DELETE FROM t"]);
    expect(texts("CREATE TABLE t (begin int, function int); UPDATE u SET a=1", d)).toEqual(["CREATE TABLE t (begin int, function int)", "UPDATE u SET a=1"]);
  }
});

test("n4_statements_never_merge_outside_a_routine", () => {
  const NAMES = ["begin", "case", "end", "event", "function", "trigger", "procedure", "atomic"];
  for (const d of DIALECTS)
    for (const a of NAMES)
      for (const b of NAMES) {
        const inputs = [
          `CREATE TABLE ${a} (${b} int, x int); DELETE FROM t`,
          `CREATE TABLE t (${a} int, ${b} text); DELETE FROM t`,
          `CREATE TABLE IF NOT EXISTS t (${a} int, ${b} int); DELETE FROM t`,
          `CREATE INDEX ${a} ON t (${b}); DELETE FROM t`,
          `CREATE VIEW v AS SELECT ${a}, ${b} FROM t; DELETE FROM t`,
          `ALTER TABLE ${a} ADD ${b} int; DELETE FROM t`,
          `SELECT ${a}, ${b} FROM t; DELETE FROM t`,
          `CREATE TABLE t (x int CHECK (CASE WHEN x > 0 THEN true END), ${a} int); DELETE FROM t`,
        ];
        for (const sql of inputs) {
          // Naive: every `;` outside strings, comments and quoted names ends a statement.
          const naive = tokenize(sql, d).filter((t) => t.t === "punct" && t.v === ";").length + 1;
          expect({ d, sql, n: texts(sql, d).length }).toEqual({ d, sql, n: naive });
          expect(texts(sql, d).slice(-1)[0]).toBe("DELETE FROM t");
        }
      }
});

test("n4_real_routines_with_modifiers_still_stay_whole", () => {
  const body = "BEGIN UPDATE a SET x = 1; DELETE FROM u; END";
  for (const head of [
    "CREATE OR REPLACE PROCEDURE p()",
    "CREATE DEFINER = `root`@`%` TRIGGER x BEFORE INSERT ON t FOR EACH ROW",
    "CREATE DEFINER=CURRENT_USER EVENT e ON SCHEDULE EVERY 1 DAY DO",
    "CREATE AGGREGATE FUNCTION f() RETURNS INT",
    "CREATE TRIGGER IF NOT EXISTS x AFTER INSERT ON t FOR EACH ROW",
  ])
    expect(texts(`${head} ${body}; SELECT 1`, "mysql")).toEqual([`${head} ${body}`, "SELECT 1"]);
  for (const head of ["CREATE TEMP TRIGGER x AFTER INSERT ON t", "CREATE TEMPORARY TRIGGER IF NOT EXISTS x AFTER INSERT ON t"])
    expect(texts(`${head} ${body}; SELECT 1`, "sqlite")).toEqual([`${head} ${body}`, "SELECT 1"]);
  const pg = "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END";
  expect(texts(`${pg}; SELECT 3`, "postgres")).toEqual([pg, "SELECT 3"]);
  // A BEGIN inside parentheses is not the body's.
  expect(texts("CREATE PROCEDURE p(begin int) BEGIN SELECT 1; END; DELETE FROM t", "mysql")).toEqual(["CREATE PROCEDURE p(begin int) BEGIN SELECT 1; END", "DELETE FROM t"]);
});

// ---- Round 7 (C1, I1, I2): the editor's splitter gives the same statements as the Core on the shared cases ----


test("r7_the_editor_and_the_core_split_the_shared_cases_alike", () => {
  expect(splitCases.length).toBeGreaterThan(20);
  for (const c of splitCases) {
    const got = splitStatements(c.sql, c.dialect as "mysql" | "postgres" | "sqlite");
    expect({ note: c.note, pieces: got.map((s) => s.text) }).toEqual({ note: c.note, pieces: c.pieces });
    // Each range is the text it names, as the Core's ranges are.
    for (const s of got) expect(c.sql.slice(s.from, s.to)).toBe(s.text);
  }
});
