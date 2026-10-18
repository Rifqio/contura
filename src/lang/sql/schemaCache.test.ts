import { expect, test, vi } from "vitest";
import { LangClient } from "../client";
import { fakeWorker } from "../../test/langWorker";
import { KFC_SCHEMA } from "./fixtures";
import { SchemaCache, schemaKey } from "./schemaCache";

function make() {
  const client = new LangClient(() => fakeWorker());
  const load = vi.fn(async () => KFC_SCHEMA);
  return { client, load, cache: new SchemaCache(client, load) };
}

test("a_tab_loads_its_schema_once_per_connection_and_database", async () => {
  const { client, load, cache } = make();
  await Promise.all([cache.ensure("c1", "kfc"), cache.ensure("c1", "kfc")]);
  await cache.ensure("c1", "kfc");
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.state("c1", "kfc")).toBe("loaded");
  expect(client.sqlSchemaFor(schemaKey("c1", "kfc"))).toBe(KFC_SCHEMA);
  // The designer's Foreign Key target list: tables only.
  expect(cache.tables("c1", "kfc")).toEqual(KFC_SCHEMA.tables.filter((t) => t.kind === "table"));
  expect(cache.tables("c1", "nope")).toBeNull();
  await cache.ensure("c1", "other");
  expect(load).toHaveBeenCalledTimes(2);
});

test("ddl_success_reloads_the_schema", async () => {
  const { load, cache } = make();
  await cache.ensure("c1", "kfc");
  await cache.ensure("c1", "b");
  await cache.ensure("c2", "kfc");
  const seen: (string | null)[] = [];
  cache.subscribe(() => seen.push(cache.state("c1", "kfc")));
  cache.invalidate("c1");
  expect(cache.state("c1", "kfc")).toBe("loading");
  await vi.waitFor(() => expect(cache.state("c1", "kfc")).toBe("loaded"));
  expect(load).toHaveBeenCalledTimes(5);
  expect(seen).toContain("loading");
});

test("closing_a_connection_drops_its_schema", async () => {
  const { client, cache } = make();
  await cache.ensure("c1", "kfc");
  cache.dropConnection("c1");
  expect(cache.state("c1", "kfc")).toBeNull();
  expect(client.sqlSchemaFor(schemaKey("c1", "kfc"))).toBeNull();
});

test("a_failed_load_reports_and_tries_again", async () => {
  const client = new LangClient(() => fakeWorker());
  const load = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue(KFC_SCHEMA);
  const cache = new SchemaCache(client, load);
  await cache.ensure("c1", "kfc");
  expect(cache.state("c1", "kfc")).toBe("failed");
  await cache.ensure("c1", "kfc");
  expect(cache.state("c1", "kfc")).toBe("loaded");
});
