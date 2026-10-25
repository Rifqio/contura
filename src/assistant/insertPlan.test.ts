import { expect, test } from "vitest";
import { splitStatements } from "../query/statements";
import { planApply, planInsert } from "./insertPlan";

// Lines: 1 comment, 2-4 the first statement, 5 blank, 6 the second, 7 blank.
const DOC = "-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT 2;\n";
const stmts = splitStatements(DOC, "postgres");
const at = (s: string, plus = 0) => DOC.indexOf(s) + plus;
const cursor = (pos: number) => ({ from: pos, to: pos });
const apply = (pos: { from: number; to: number }) => planApply(DOC, pos, stmts, "Query 2", "SELECT 9;\n");
const insert = (pos: { from: number; to: number }) => planInsert(DOC, pos, stmts, "Query 2", "SELECT 9;\n");
const result = (p: { from: number; to: number; text: string }) => DOC.slice(0, p.from) + p.text + DOC.slice(p.to);

test("apply_replaces_the_statement_the_cursor_is_in_with_its_semicolon", () => {
  const p = apply(cursor(at("FROM", 2)))!;
  expect(p.over).toBe("statement");
  expect(p.where).toBe("Replaces lines 2 to 4 of Query 2");
  expect(p.lines).toEqual([2, 4]);
  expect(result(p)).toBe("-- report\nSELECT 9;\n\nSELECT 2;\n");
  expect(p.mark).toEqual({ from: p.from, to: p.to });
});

test("apply_replaces_only_the_selection_when_there_is_one", () => {
  const p = apply({ from: at("FROM"), to: at("LIMIT 5;", 8) })!;
  expect(p.over).toBe("selection");
  expect(p.where).toBe("Replaces lines 3 to 4 of Query 2");
  expect(result(p)).toBe("-- report\nSELECT id\nSELECT 9;\n\nSELECT 2;\n");
});

test("apply_is_off_on_a_blank_line_with_no_selection", () => {
  expect(apply(cursor(at("\n\nSELECT 2", 1)))).toBeNull();
});

test("insert_adds_below_the_current_statement_and_never_splits_it", () => {
  // The cursor in the middle of the first statement's second line.
  const p = insert(cursor(at("FROM", 2)));
  expect(p.below).toBe(true);
  expect(p.where).toBe("Adds line 6 of Query 2, below the current statement");
  expect(p.lines).toEqual([6, 6]);
  expect(result(p)).toBe("-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT 9;\n\nSELECT 2;\n");
  expect(p.mark).toEqual({ after: at("LIMIT 5;", 8) });
  expect(p.from).toBe(p.to);
});

test("insert_on_a_blank_line_adds_at_the_cursor", () => {
  const p = insert(cursor(at("\n\nSELECT 2", 1)));
  expect(p.below).toBe(false);
  expect(p.where).toBe("Adds line 5 of Query 2 where you are typing");
  expect(result(p)).toBe("-- report\nSELECT id\nFROM orders\nLIMIT 5;\nSELECT 9;\n\nSELECT 2;\n");
});

test("insert_into_an_empty_editor_adds_line_1", () => {
  const p = planInsert("", cursor(0), [], "Query 1", "SELECT 9;\n");
  expect(p.where).toBe("Adds line 1 of Query 1 where you are typing");
  expect(p.text).toBe("SELECT 9;\n");
});

test("a_commented_write_goes_below_whole", () => {
  const p = planInsert(DOC, cursor(at("SELECT 2")), stmts, "Query 2", "-- UPDATE t\n-- SET a = 1\n");
  expect(result(p)).toBe(`${DOC.slice(0, -1)}\n\n-- UPDATE t\n-- SET a = 1\n`);
  expect(p.where).toBe("Adds lines 8 to 9 of Query 2, below the current statement");
});

test("line_numbers_have_grouping_commas", () => {
  const big = `${"SELECT 1;\n".repeat(1200)}SELECT 2;`;
  const p = planApply(big, cursor(big.length - 2), splitStatements(big, "postgres"), "Query 2", "SELECT 3;\n")!;
  expect(p.where).toBe("Replaces line 1,201 of Query 2");
});

test("i1_an_inserted_block_keeps_a_blank_line_before_the_next_statement", () => {
  const doc = "SELECT * FROM orders;\nUPDATE accounts SET flag = 1 WHERE id = 7;";
  const p = planInsert(doc, cursor(3), splitStatements(doc, "postgres"), "Query 2", "-- DELETE FROM orders WHERE id = 3;\n");
  expect(doc.slice(0, p.from) + p.text + doc.slice(p.to)).toBe(
    "SELECT * FROM orders;\n\n-- DELETE FROM orders WHERE id = 3;\n\nUPDATE accounts SET flag = 1 WHERE id = 7;",
  );
});

test("i4_insert_never_splits_a_statement_that_starts_after_the_semicolon", () => {
  const doc = "SELECT 1; SELECT\n  2;";
  const p = planInsert(doc, cursor(3), splitStatements(doc, "postgres"), "Query 2", "SELECT 3;\n");
  const out = doc.slice(0, p.from) + p.text + doc.slice(p.to);
  expect(out).toBe("SELECT 1;\n\nSELECT 3;\n\nSELECT\n  2;");
  expect(splitStatements(out, "postgres").map((s) => s.text)).toEqual(["SELECT 1", "SELECT 3", "SELECT\n  2"]);
});

test("m1_insert_names_only_the_lines_that_hold_sql", () => {
  const doc = "SELECT 1;";
  const p = planInsert(doc, cursor(3), splitStatements(doc, "postgres"), "Query 2", "SELECT 3;\n");
  expect(p.where).toBe("Adds line 3 of Query 2, below the current statement");
  expect(p.lines).toEqual([3, 3]);
});
