import { expect, test } from "vitest";
import { tokenize } from "../lang/sql/tokens";
import { splitStatements, statementAt, statementOnLine } from "./statements";

const on = (doc: string, pos: number, dialect: "mysql" | "postgres" | "sqlite" = "postgres") =>
  statementOnLine(doc, pos, splitStatements(doc, dialect), dialect)?.stmt.text ?? null;

// ---- Round 2, N1: two statements on one line: the one the insertion point is in, as main picked it ----

test("n1_the_statement_the_insertion_point_is_in_never_the_first_on_the_line", () => {
  const doc = "DELETE FROM t WHERE id=1; SELECT 1";
  expect(on(doc, doc.length)).toBe("SELECT 1");
  expect(on(doc, doc.indexOf("SELECT") + 2)).toBe("SELECT 1");
  expect(on(doc, 3)).toBe("DELETE FROM t WHERE id=1");
  // On the `;` and in the space after it: what main's statementAt gave.
  const stmts = splitStatements(doc, "postgres");
  for (const pos of [doc.indexOf(";"), doc.indexOf(";") + 1, doc.indexOf(";") + 2])
    expect(on(doc, pos)).toBe(statementAt(stmts, pos)!.text);
});

// ---- N2, N3: the code start comes from the tokenizer of the dialect ----

test("n2_a_mysql_hash_comment_line_is_outside_any_statement", () => {
  const doc = "# DELETE FROM orders;\nUPDATE a SET f=1 WHERE id=7;";
  expect(on(doc, 3, "mysql")).toBeNull();
  expect(on(doc, doc.indexOf("UPDATE") + 2, "mysql")).toContain("UPDATE a");
});

test("n2_a_nested_postgres_block_comment_line_is_outside_any_statement", () => {
  const doc = "/* a /* b */ c */\nUPDATE a SET f=1 WHERE id=7;";
  expect(on(doc, 2)).toBeNull();
  expect(tokenize(doc, "postgres")[0]).toMatchObject({ t: "comment", v: "/* a /* b */ c */" });
  // MySQL does not nest: the first `*/` ends it, as the server reads it.
  expect(tokenize("/* a /* b */ c", "mysql")[0].v).toBe("/* a /* b */");
});

test("n3_a_mysql_executable_comment_is_code", () => {
  const doc = "/*!40101 SET NAMES utf8 */;\nSELECT 1;";
  expect(on(doc, 3, "mysql")).toBe("/*!40101 SET NAMES utf8 */");
  // Elsewhere it is an ordinary comment.
  expect(on(doc, 3, "postgres")).toBeNull();
});

test("dash_and_block_comment_lines_are_outside_in_every_dialect", () => {
  for (const d of ["mysql", "postgres", "sqlite"] as const) {
    const doc = "SELECT 1;\n-- x\n/* y */\nSELECT 2;";
    expect(on(doc, doc.indexOf("-- x") + 1, d)).toBeNull();
    expect(on(doc, doc.indexOf("/* y") + 1, d)).toBeNull();
    expect(on(doc, doc.indexOf("SELECT 2") + 1, d)).toMatch(/SELECT 2$/);
  }
});
