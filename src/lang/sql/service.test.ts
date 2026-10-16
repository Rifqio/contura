import { afterEach, expect, test, vi } from "vitest";
import { LangClient, type WorkerLike } from "../client";
import type { FromWorker, ToWorker } from "../protocol";
import { createHandler } from "../worker";
import { KFC_SCHEMA } from "./fixtures";
import { createSqlService } from "./service";

afterEach(() => vi.useRealTimers());

function fakeWorker(debounce = 0) {
  const sent: ToWorker[] = [];
  let handler: (m: ToWorker) => void = () => {};
  const fake: WorkerLike & { sent: ToWorker[] } = {
    sent,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      sent.push(m);
      handler(m);
    },
    terminate() {},
  };
  handler = createHandler((m: FromWorker) => fake.onmessage?.({ data: m }), debounce);
  return fake;
}

test("schema_messages_feed_completion", async () => {
  const client = new LangClient(() => fakeWorker());
  const before = await client.completeSql({ text: "SELECT * FROM ", pos: 14, dialect: "postgres", schemaKey: "c1/kfc", explicit: false });
  expect(before.items.some((i) => i.kind === "table")).toBe(false);
  client.setSqlSchema("c1/kfc", KFC_SCHEMA);
  const after = await client.completeSql({ text: "SELECT * FROM ", pos: 14, dialect: "postgres", schemaKey: "c1/kfc", explicit: false });
  expect(after.items.find((i) => i.label === "orders")?.apply).toBe("orders o");
  const star = await client.refactorSql({ text: "SELECT * FROM stores", pos: 7, dialect: "postgres", schemaKey: "c1/kfc", action: "expandStar" });
  expect(star.edits?.[0].insert).toBe("id, code, name, city, opened_on, is_active");
  const def = await client.refactorSql({ text: "SELECT * FROM stores", pos: 15, dialect: "postgres", schemaKey: "c1/kfc", action: "definition" });
  expect(def.definition).toEqual({ kind: "table", schema: "public", name: "stores" });
});

test("analyze_is_debounced_and_completion_is_not", async () => {
  vi.useFakeTimers();
  const client = new LangClient(() => fakeWorker(120));
  client.setSqlSchema("k", KFC_SCHEMA);
  const base = { docId: "q1", dialect: "postgres" as const, schemaKey: "k", schemaState: "loaded" as const };
  const first = client.analyzeSql({ ...base, text: "SELECT * FROM orde" });
  const second = client.analyzeSql({ ...base, text: "SELECT * FROM order" });
  let done = false;
  void second.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(false);
  // Completion answers at once, while analysis waits.
  const c = await client.completeSql({ text: "SELECT * FROM ", pos: 14, dialect: "postgres", schemaKey: "k", explicit: false });
  expect(c.items.length).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(60);
  const [a, b] = await Promise.all([first, second]);
  // Both calls get the newest text's result.
  expect(a).toEqual(b);
  expect(b.find((d) => d.message.startsWith("Unknown table order."))).toBeTruthy();
});

test("dropping_a_schema_turns_unknown_inspections_off", async () => {
  const client = new LangClient(() => fakeWorker());
  client.setSqlSchema("k", KFC_SCHEMA);
  const q = { docId: "q1", text: "SELECT * FROM order", dialect: "postgres" as const, schemaKey: "k" };
  expect((await client.analyzeSql({ ...q, schemaState: "loaded" })).some((d) => d.message.startsWith("Unknown"))).toBe(true);
  client.setSqlSchema("k", null);
  expect((await client.analyzeSql({ ...q, schemaState: "none" })).some((d) => d.message.startsWith("Unknown"))).toBe(false);
  // Statement checks still run.
  const del = await client.analyzeSql({ ...q, text: "DELETE FROM orders", schemaState: "none" });
  expect(del.some((d) => d.severity === "warning")).toBe(true);
});

test("dispose_rejects_what_is_pending_and_what_comes_later", async () => {
  vi.useFakeTimers();
  const client = new LangClient(() => fakeWorker(120));
  const pending = client.analyzeSql({ docId: "q", text: "SELECT 1", dialect: "postgres", schemaKey: null, schemaState: "none" });
  client.dispose();
  await expect(pending).rejects.toThrow("engine stopped");
  await expect(client.completeSql({ text: "", pos: 0, dialect: "postgres", schemaKey: null, explicit: true })).rejects.toThrow("engine stopped");
});

test("a_restart_is_announced", async () => {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const client = new LangClient(() => {
    const w = fakeWorker();
    workers.push(w);
    return w;
  });
  const heard = vi.fn();
  const off = client.onRestart(heard);
  workers[0].onerror?.();
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  workers[1].onerror?.();
  expect(heard).toHaveBeenCalledTimes(1);
});

test("the_analysis_cache_is_bounded_and_forgets_dropped_schemas", async () => {
  const service = createSqlService();
  service.setSchema("k", KFC_SCHEMA);
  for (let i = 0; i < 20; i++) service.analyze(`doc${i}`, "SELECT * FROM orders", "postgres", "k", "loaded");
  expect(service.cachedDocs()).toBeLessThanOrEqual(8);
  service.setSchema("k", null);
  expect(service.cachedDocs()).toBe(0);
  service.analyze("a", "SELECT 1", "postgres", null, "none");
  service.setSchema("k", KFC_SCHEMA);
  expect(service.cachedDocs()).toBe(1);
});

test("a_crash_restarts_and_resends_schemas", async () => {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const client = new LangClient(() => {
    const w = fakeWorker();
    workers.push(w);
    return w;
  });
  client.setSqlSchema("a", KFC_SCHEMA);
  client.setSqlSchema("b", KFC_SCHEMA);
  client.setSqlSchema("b", null);
  workers[0].onerror?.();
  expect(workers).toHaveLength(2);
  expect(workers[1].sent).toEqual([{ type: "sqlSchema", key: "a", schema: KFC_SCHEMA }]);
  const c = await client.completeSql({ text: "SELECT * FROM ", pos: 14, dialect: "postgres", schemaKey: "a", explicit: false });
  expect(c.items.some((i) => i.label === "orders")).toBe(true);
});
