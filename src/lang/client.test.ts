import { afterEach, expect, test, vi } from "vitest";
import { CARD_WIDTH, cardHeight } from "../diagram/metrics";
import type { LayoutRequest } from "../diagram/layout";
import { LangClient, type WorkerLike } from "./client";
import type { FromWorker, ToWorker } from "./protocol";
import { KFC_SCHEMA } from "./sql/fixtures";
import { createHandler } from "./worker";

afterEach(() => vi.useRealTimers());

const request: LayoutRequest = {
  nodes: [
    { id: "a", w: CARD_WIDTH, h: cardHeight(2) },
    { id: "b", w: CARD_WIDTH, h: cardHeight(3) },
  ],
  edges: [{ from: "a", to: "b" }],
  existing: { a: { x: 10, y: 20 } },
  rankdir: "LR",
};

test("worker_answers_layout_with_positions_for_missing_ids", async () => {
  const out = await new Promise<FromWorker>((resolve) => createHandler(resolve, 0)({ type: "layout", id: 7, request }));
  expect(out.type).toBe("layout");
  if (out.type !== "layout") return;
  expect(out.ids).toEqual([7]);
  expect(out.positions.a).toEqual({ x: 10, y: 20 });
  expect(Number.isFinite(out.positions.b.x)).toBe(true);
});

test("lang_client_layout_resolves_with_the_positions", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => handler(m),
      terminate: () => {},
    };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const positions = await client.layout(request);
  expect(positions.a).toEqual({ x: 10, y: 20 });
  expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
  client.dispose();
});

test("sql_shape_is_answered_after_the_debounce_and_quick_messages_share_one_parse", async () => {
  vi.useFakeTimers();
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 120);
  handle({ type: "sqlSchema", key: "k", schema: KFC_SCHEMA });
  const base = { type: "sqlShape" as const, docId: "q1", dialect: "postgres" as const, schemaKey: "k", schemaState: "loaded" as const, pos: 0 };
  handle({ ...base, id: 1, text: "SELECT o.id FROM sales.orders o" });
  handle({ ...base, id: 2, text: "SELECT o.id FROM sales.orders o JOIN stores s ON s.id = o.store_id" });
  await vi.advanceTimersByTimeAsync(140);
  expect(posts).toEqual([]);
  await vi.advanceTimersByTimeAsync(20);
  expect(posts).toHaveLength(1);
  const out = posts[0];
  expect(out.type).toBe("sqlShape");
  if (out.type !== "sqlShape" || "kind" in out.result) throw new Error("expected a shape");
  expect(out.ids).toEqual([1, 2]);
  expect(out.result.tables.map((t) => t.alias)).toEqual(["o", "s"]);
});

test("lang_client_sql_shape_resolves_with_the_shape_or_the_problem", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => handler(m), terminate: () => {} };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const q = { docId: "d", dialect: "postgres" as const, schemaKey: null, schemaState: "none" as const, pos: 0 };
  const s = await client.sqlShape({ ...q, text: "SELECT id FROM stores" });
  expect("kind" in s ? s : s.tables.map((t) => t.name)).toEqual(["stores"]);
  expect(await client.sqlShape({ ...q, text: "DELETE FROM stores WHERE id = 1" })).toEqual({ kind: "notRead", verb: "DELETE" });
  client.dispose();
});

test("lang_client_mermaid_posts_the_message_and_resolves_with_the_result", async () => {
  const sent: ToWorker[] = [];
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => {
        sent.push(m);
        handler(m);
      },
      terminate: () => {},
    };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const result = await client.mermaid("flowchart LR\n  A --> B", "Two steps");
  expect(sent).toEqual([{ type: "mermaid", id: 1, text: "flowchart LR\n  A --> B", title: "Two steps" }]);
  expect(result.direction).toBe("LR");
  expect(result.nodes).toBe(2);
  expect(result.flow.startsWith('diagram flow "Two steps"\n')).toBe(true);
  client.dispose();
});
