import { expect, test } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { sourceConnectionFor } from "./sourceConnection";

const conn = { id: "c1", name: "Shop", dialect: "mysql", aiAccess: "schema" } as ConnectionConfig;

test("no_connection_id_has_no_source", () => {
  expect(sourceConnectionFor(null, "mysql", [conn])).toBeNull();
});

test("source_connection_carries_live_access", () => {
  expect(sourceConnectionFor("c1", "mysql", [conn])).toMatchObject({ id: "c1", name: "Shop", access: "schema" });
  expect(sourceConnectionFor("c1", "mysql", [{ ...conn, aiAccess: "never" }])?.access).toBe("never");
});

test("deleted_source_connection_fails_closed", () => {
  expect(sourceConnectionFor("gone", "postgres", [conn])).toEqual({
    id: "gone",
    name: "The source Connection",
    dialect: "postgres",
    database: null,
    access: "never",
  });
});
