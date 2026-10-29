import { expect, test } from "vitest";
import { missingKind, serverError } from "./serverError";

/** R40: no SQLSTATE is guessed from PostgreSQL's words; the Core sends no code, so there is no chip. */
test("postgres_messages_get_no_guessed_sqlstate", () => {
  for (const m of ['relation "shipment" does not exist', 'invalid input syntax for type timestamp: "x"', "division by zero"])
    expect(serverError(m, "postgres")).toEqual({ code: null, text: m });
});

test("mysql_server_errors_lose_their_wrapping_and_keep_the_sqlstate", () => {
  expect(serverError("Server error: `ERROR 1146 (42S02): Table 'shop.shipment' doesn't exist'", "mysql")).toEqual({
    code: "42S02",
    text: "Table 'shop.shipment' doesn't exist",
  });
  expect(serverError("ERROR 1054 (42S22): Unknown column 'x' in 'field list'", "mysql")).toEqual({
    code: "42S22",
    text: "Unknown column 'x' in 'field list'",
  });
  expect(serverError("Table 'shop.shipment' doesn't exist", "mysql")).toEqual({ code: null, text: "Table 'shop.shipment' doesn't exist" });
});

test("sqlite_has_no_sqlstate", () => {
  expect(serverError("no such table: shipment", "sqlite")).toEqual({ code: null, text: "no such table: shipment" });
});

test("missing_kind_tells_tables_from_columns", () => {
  expect(missingKind('relation "shipment" does not exist')).toBe("table");
  expect(missingKind("Table 'shop.shipment' doesn't exist")).toBe("table");
  expect(missingKind("no such table: shipment")).toBe("table");
  expect(missingKind('column "x" does not exist')).toBe("column");
  expect(missingKind("Unknown column 'x' in 'field list'")).toBe("column");
  expect(missingKind("division by zero")).toBeNull();
});

/** Where the error points, as a line (and column when known) of the SQL that ran. */
test("a_postgres_position_becomes_a_line_and_column_of_the_sql", () => {
  const sql = "SELECT o.id\nFROM orders AS o\nINNER JOIN stores AS s ON s.idd = o.store_id";
  const at = sql.indexOf("s.idd") + 1;
  expect(serverError(`column s.idd does not exist (position ${at})`, "postgres", sql)).toEqual({
    code: null,
    text: "column s.idd does not exist",
    position: { line: 3, column: sql.split("\n")[2].indexOf("s.idd") + 1 },
  });
  // Position 1 is the first character.
  expect(serverError("syntax error at or near \"SELEC\" (position 1)", "postgres", "SELEC 1").position).toEqual({ line: 1, column: 1 });
  // Without the text, only the message is known.
  expect(serverError("division by zero (position 3)", "postgres").position).toBeUndefined();
  // Past the end of the text: no line is made up.
  expect(serverError("boom (position 99)", "postgres", "SELECT 1").position).toBeUndefined();
});

test("a_mysql_at_line_becomes_a_line", () => {
  const m =
    "Server error: `ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'ON' at line 3'";
  expect(serverError(m, "mysql", "SELECT 1\nFROM a\nJOIN b ON")).toEqual({
    code: "42000",
    text: "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'ON' at line 3",
    position: { line: 3 },
  });
  expect(serverError("ERROR 1054 (42S22): Unknown column 'x' in 'field list'", "mysql").position).toBeUndefined();
});

test("messages_without_a_place_have_no_position", () => {
  expect(serverError("no such table: shipment", "sqlite", "SELECT 1").position).toBeUndefined();
  expect(serverError('relation "x" does not exist', "postgres", "SELECT 1").position).toBeUndefined();
});
