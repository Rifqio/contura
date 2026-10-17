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
