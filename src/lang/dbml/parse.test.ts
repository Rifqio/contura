import { expect, test } from "vitest";
import { LangClient } from "../client";
import { createHandler } from "../worker";
import type { FromWorker, ToWorker } from "../protocol";
import { KFC_MODEL, KFC_TEXT } from "./fixtures";
import { parseDbml } from "./parse";

test("parses_tables_columns_settings_and_refs", () => {
  const r = parseDbml(KFC_TEXT, "postgres");
  expect(r.diagnostics).toEqual([]);
  expect(r.model).toEqual(KFC_MODEL);
});

test("ranges_point_at_names_types_and_settings", () => {
  const { ranges } = parseDbml(KFC_TEXT, "postgres");
  const slice = (key: string) => {
    const r = ranges[key];
    expect(r, key).toBeDefined();
    return KFC_TEXT.slice(r.from, r.to);
  };
  expect(slice("column:public.stores/name/name")).toBe("name");
  expect(slice("column:public.stores/name/type")).toBe("varchar(80)");
  expect(slice("column:public.stores/name/settings")).toBe("[not null, unique]");
  expect(slice("column:public.orders/total/type")).toBe('"numeric(10,2)"');
  expect(slice("table:public.orders/name")).toBe("orders");
  expect(slice("ref:0/from")).toBe("orders.store_id");
  expect(slice("ref:0/to")).toBe("stores.id");
});

test("syntax_error_has_line_and_column", () => {
  const r = parseDbml("Table a {\n  id int\n", "mysql");
  expect(r.model).toBeNull();
  expect(r.diagnostics[0]).toMatchObject({ severity: "error", line: 3, column: 1 });
});

/** Runs the worker's handler in-process, so the client can be tested without a real Worker. */
function fakeWorker() {
  let handler: (m: ToWorker) => void = () => {};
  const fake = {
    onmessage: null as ((e: { data: FromWorker }) => void) | null,
    onerror: null as (() => void) | null,
    postMessage(m: ToWorker) {
      handler(m);
    },
    terminate() {},
  };
  handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
  return fake;
}

test("invalid_text_keeps_last_valid_model", async () => {
  const client = new LangClient(() => fakeWorker());
  const first = await client.update("doc", KFC_TEXT, "postgres");
  expect(first.model).toEqual(KFC_MODEL);
  const second = await client.update("doc", KFC_TEXT.replace("Table orders {", "Table orders "), "postgres");
  expect(second.model).toBeNull();
  expect(second.diagnostics.length).toBeGreaterThan(0);
  expect(second.lastValid).toEqual(KFC_MODEL);
  client.dispose();
});

test("worker_crash_restarts_and_rejects_pending", async () => {
  let made = 0;
  let current: ReturnType<typeof fakeWorker> | null = null;
  const client = new LangClient(() => {
    made += 1;
    const w = fakeWorker();
    if (made === 1) w.postMessage = () => {}; // never answers
    current = w;
    return w;
  });
  const pending = client.update("doc", "Table a {}", "mysql");
  current!.onerror?.();
  await expect(pending).rejects.toThrow("engine restarted");
  expect(made).toBe(2);
  await expect(client.update("doc", "Table a {\n  id int\n}", "mysql")).resolves.toMatchObject({ diagnostics: [] });
  client.dispose();
});

test("parses_core_reverse_engineered_output", () => {
  // The expected output of crates/contura-core/src/dbml_writer.rs `writes_tables_settings_and_refs`.
  const core = `// Reverse-engineered from kfc / shop.public on 2026-10-16
// Dialect: PostgreSQL

Enum public.store_kind {
  drive
  mall
}

Table public.stores {
  id integer [pk, increment, note: 'store\\'s id']
  name "character varying(80)" [not null, unique]
  kind store_kind [default: 'mall']
  opened_at timestamptz [default: \`now()\`]

  Note: 'KFC stores'
}

Table public.orders {
  id bigint
  line integer
  store_id integer [not null]
  total numeric(10,2) [default: 0]

  indexes {
    (id, line) [pk]
    store_id [name: 'ix_store']
  }
}

Ref: public.orders.store_id > public.stores.id [delete: cascade]
`;
  const r = parseDbml(core, "postgres");
  expect(r.diagnostics).toEqual([]);
  expect(r.model?.tables.map((t) => t.name)).toEqual(["stores", "orders"]);
  expect(r.model?.tables[0].columns[0].note).toBe("store's id");
  expect(r.model?.tables[0].columns[1].typeName).toBe("character varying(80)");
  expect(r.model?.tables[1].columns[3].typeName).toBe("numeric(10,2)");
});
