import { expect, test } from "vitest";
import { tokenize } from "../lang/sql/tokens";
import { selectionStatement, splitStatements, statementAt, statementOnLine } from "./statements";

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

// ---- MySQL DELIMITER: the statement where you are typing uses the delimiter in force there ----

const TRIGGER = "CREATE TRIGGER t BEFORE INSERT ON orders FOR EACH ROW\nBEGIN\n  SET NEW.total = 0;\nEND";
const DELIMITED = `DELIMITER $$\n${TRIGGER}$$\nDELIMITER ;\nINSERT INTO orders VALUES (1);`;

test("delimiter_the_statement_on_a_line_uses_the_delimiter_in_force", () => {
  expect(on(DELIMITED, DELIMITED.indexOf("SET NEW") + 2, "mysql")).toBe(TRIGGER);
  expect(on(DELIMITED, DELIMITED.indexOf("END$$") + 5, "mysql")).toBe(TRIGGER);
  expect(on(DELIMITED, DELIMITED.indexOf("INSERT INTO") + 2, "mysql")).toBe("INSERT INTO orders VALUES (1)");
  // A DELIMITER line is not a statement: nothing runs there.
  expect(on(DELIMITED, 3, "mysql")).toBeNull();
  expect(on(DELIMITED, DELIMITED.indexOf("DELIMITER ;") + 3, "mysql")).toBeNull();
});

test("delimiter_statements_keep_their_place_in_the_text", () => {
  for (const s of splitStatements(DELIMITED, "mysql")) expect(DELIMITED.slice(s.from, s.to)).toBe(s.text);
  const [trigger, insert] = splitStatements(DELIMITED, "mysql");
  expect(trigger.from).toBe(DELIMITED.indexOf("CREATE"));
  expect(insert.from).toBe(DELIMITED.indexOf("INSERT INTO"));
});

test("delimiter_a_selection_uses_the_delimiter_in_force_where_it_starts", () => {
  const from = DELIMITED.indexOf("CREATE");
  const to = DELIMITED.indexOf("$$\nDELIMITER ;") + 2;
  // The selection holds the trigger and its `$$`: what runs is the trigger without it.
  expect(selectionStatement(DELIMITED, from, to, "mysql")).toEqual({ from, to: from + TRIGGER.length, text: TRIGGER, delimiter: "$$" });
  // Two statements under it: the Core splits them with the delimiter the selection carries.
  const two = `DELIMITER //\nSELECT 1; SELECT 2//\nSELECT 3//`;
  expect(selectionStatement(two, 13, two.length, "mysql")).toEqual({ from: 13, to: two.length - 2, text: "SELECT 1; SELECT 2//\nSELECT 3", delimiter: "//" });
  // A selection that holds the DELIMITER lines is left to the Core's split, whole.
  expect(selectionStatement(DELIMITED, 0, DELIMITED.length, "mysql")?.text).toBe(DELIMITED.slice(0, -1));
  // Without DELIMITER the selection is as before: trimmed, without its last `;`.
  const doc = "SELECT 1;\n  DELETE FROM t WHERE id = 1; ";
  expect(selectionStatement(doc, 10, doc.length, "mysql")).toEqual({ from: 12, to: 38, text: "DELETE FROM t WHERE id = 1" });
  expect(selectionStatement(doc, 9, 12, "mysql")).toBeNull();
  // Elsewhere a DELIMITER line is text.
  const pg = "DELIMITER $$\nSELECT 1$$";
  expect(selectionStatement(pg, 13, pg.length, "postgres")?.text).toBe("SELECT 1$$");
});

test("delimiter_a_chunk_is_one_statement_wherever_the_insertion_point_is_in_it", () => {
  const trigger = "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW IF NEW.a > 0 THEN\n  SET NEW.b = 1;\n  DELETE FROM log WHERE id < 5;\nEND IF";
  const doc = `DELIMITER $$\n${trigger}$$\nDELIMITER ;\nSELECT 2;`;
  for (const at of [doc.indexOf("CREATE") + 2, doc.indexOf("SET NEW") + 2, doc.indexOf("DELETE") + 2, doc.indexOf("END IF") + 2])
    expect(on(doc, at, "mysql")).toBe(trigger);
  expect(splitStatements(doc, "mysql")).toEqual([
    { from: 13, to: 13 + trigger.length, text: trigger, delimiter: "$$" },
    { from: doc.indexOf("SELECT 2"), to: doc.length - 1, text: "SELECT 2" },
  ]);
});
