import { expect, test, vi } from "vitest";
import { deleteConnection } from "../api/client";
import { routeInvoke } from "../test/invoke";
import type { DbObject } from "../api/types";
import { NAME_INDEX_CAP, NameIndex, objectNames } from "./nameIndex";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const tables = (prefix: string, n: number): DbObject[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "table", name: `${prefix}${i}` }) as DbObject);

test("keeps_names_per_connection_and_scope", () => {
  const idx = new NameIndex();
  idx.keep("c1", "shop", "public", [{ kind: "table", name: "orders" } as DbObject, { kind: "view", name: "order_totals" } as DbObject]);
  idx.keep("c1", "shop", "billing", [{ kind: "table", name: "invoices" } as DbObject]);
  expect(idx.names("c1")).toEqual([
    { kind: "table", database: "shop", schema: "public", name: "orders" },
    { kind: "view", database: "shop", schema: "public", name: "order_totals" },
    { kind: "table", database: "shop", schema: "billing", name: "invoices" },
  ]);
  expect(idx.names("c2")).toEqual([]);
  expect(idx.size).toBe(3);
});

test("a_reload_of_a_scope_replaces_its_names", () => {
  const idx = new NameIndex();
  idx.keep("c1", "main", null, tables("a", 3));
  idx.keep("c1", "main", null, tables("b", 2));
  expect(idx.names("c1").map((n) => n.name)).toEqual(["b0", "b1"]);
  expect(idx.size).toBe(2);
});

test("keeps_names_only_never_row_data_or_estimates", () => {
  const idx = new NameIndex();
  idx.keep("c1", "main", null, [{ kind: "table", name: "orders", rows: 1200, comment: "x" } as unknown as DbObject]);
  expect(Object.keys(idx.names("c1")[0]).sort()).toEqual(["database", "kind", "name", "schema"]);
});

test("the_cap_drops_the_oldest_connection_first", () => {
  const idx = new NameIndex(10);
  idx.keep("old", "db", null, tables("o", 4));
  idx.keep("mid", "db", null, tables("m", 4));
  // Loading "old" again makes it the newest.
  idx.keep("old", "db", null, tables("o", 4));
  idx.keep("new", "db", null, tables("n", 4));
  expect(idx.size).toBeLessThanOrEqual(10);
  expect(idx.names("mid")).toEqual([]);
  expect(idx.names("old")).toHaveLength(4);
  expect(idx.names("new")).toHaveLength(4);
});

test("one_connection_over_the_cap_keeps_only_the_cap", () => {
  const idx = new NameIndex(5);
  idx.keep("big", "db", null, tables("t", 50));
  expect(idx.size).toBe(5);
  expect(idx.names("big")).toHaveLength(5);
});

test("the_default_cap_is_twenty_thousand_names", () => {
  expect(NAME_INDEX_CAP).toBe(20_000);
  const idx = new NameIndex();
  idx.keep("a", "db", null, tables("a", 15_000));
  idx.keep("b", "db", null, tables("b", 15_000));
  expect(idx.size).toBe(15_000);
  expect(idx.names("a")).toEqual([]);
});

test("forget_drops_a_connection", () => {
  const idx = new NameIndex();
  idx.keep("c1", "main", null, tables("a", 3));
  idx.forget("c1");
  expect(idx.size).toBe(0);
  expect(idx.names("c1")).toEqual([]);
});

test("a_deleted_connections_names_leave_the_index_at_once", async () => {
  routeInvoke({ delete_connection: () => null });
  objectNames.keep("gone", "db", null, tables("g", 15));
  objectNames.keep("kept", "db", null, tables("k", 5));
  const before = objectNames.size;
  await deleteConnection("gone");
  expect(objectNames.names("gone")).toEqual([]);
  // No longer counted against the cap either.
  expect(objectNames.size).toBe(before - 15);
  expect(objectNames.names("kept")).toHaveLength(5);
  objectNames.forget("kept");
});
