import { afterEach, expect, test, vi } from "vitest";
import { CARD_WIDTH, cardHeight } from "../diagram/metrics";
import type { LayoutRequest } from "../diagram/layout";
import { LangClient, type WorkerLike } from "./client";
import type { FlowDoc } from "./flow/model";
import { docsById, fromWire } from "./flow/wire";
import type { FromWorker, ToWorker } from "./protocol";
import { KFC_SCHEMA } from "./sql/fixtures";
import { applyEdits } from "./flow/service";
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

/** The posts as the client reads them: each result merged with the docs held from the one before. */
const flowResults = (posts: FromWorker[]) => {
  const held = new Map<string, Map<number, FlowDoc>>();
  return posts.map((p) => {
    if (p.type !== "flowResult") throw new Error(`expected a flow result, got ${p.type}`);
    const result = fromWire(p.result, held.get(p.docId) ?? new Map());
    held.set(p.docId, docsById(result));
    return { ...p, result };
  });
};

test("flow_parse_is_answered_after_the_debounce_and_keeps_the_last_good_doc", async () => {
  vi.useFakeTimers();
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 120);
  handle({ type: "flowParse", id: 1, docId: "f", text: 'diagram flow "F"\nA\nB\nA > B\n' });
  await vi.advanceTimersByTimeAsync(130);
  handle({ type: "flowParse", id: 2, docId: "f", text: 'diagram flow "F"\nA\nB\nA > C\n' });
  handle({ type: "flowParse", id: 3, docId: "f", text: 'diagram flow "F"\nA\nB\nA > Cc\n' });
  await vi.advanceTimersByTimeAsync(100);
  expect(posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30);
  const [good, bad] = flowResults(posts);
  expect(good.ids).toEqual([1]);
  expect(good.result.doc?.links).toEqual([{ from: "A", to: "B", arrow: ">" }]);
  expect(bad.ids).toEqual([2, 3]);
  expect(bad.result.doc).toBeNull();
  expect(bad.result.problems.map((p) => p.message)).toEqual(["Cc is not defined."]);
  expect(bad.result.lastValid).toEqual(good.result.doc);
  expect(bad.result.version).toBeGreaterThan(good.result.version);
});

test("flow_result_sends_only_the_doc_problems_and_last_good_doc", () => {
  const posts: FromWorker[] = [];
  createHandler((m) => posts.push(m), 0)({ type: "flowParse", id: 1, docId: "f", text: 'diagram flow "F"\nA\n' });
  const [r] = flowResults(posts);
  const wire = posts[0].type === "flowResult" ? posts[0].result : null;
  expect(Object.keys(wire ?? {}).sort()).toEqual(["frames", "problems", "version"]);
  expect(Object.keys(wire?.frames[0] ?? {}).sort()).toEqual(["doc", "docId", "from", "index", "kind", "lastValid", "lastValidId", "line", "title", "to"]);
  expect(r.result.doc).not.toBeNull();
});

test("flow_spans_come_from_the_worker_for_the_current_version_only", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  const text = 'diagram flow "F"\nKitchen {\n  Cook\n}\nCook > Kitchen: plate\n';
  handle({ type: "flowParse", id: 1, docId: "f", text });
  const v1 = flowResults(posts)[0].result.version;
  handle({ type: "flowSpans", id: 2, docId: "f", version: v1, keys: ["node:Cook", "link:0", "node:Nobody"], names: ["Cook", "Kitchen"] });
  const answer = posts[1];
  if (answer.type !== "flowSpans") throw new Error("expected spans");
  if (answer.result.stale) throw new Error("expected current spans");
  const node = answer.result.spans["node:Cook"];
  expect(node && text.slice(node.from, node.to)).toBe("Cook");
  const label = answer.result.spans["link:0"]?.label;
  expect(label && text.slice(label.from, label.to)).toBe("plate");
  expect(answer.result.spans["node:Nobody"]).toBeNull();
  expect(answer.result.lineOf).toEqual({ Cook: 3, Kitchen: 2 });
  // A newer text makes the old version stale, so an edit planned on it is refused.
  handle({ type: "flowParse", id: 3, docId: "f", text: `${text}// more\n` });
  handle({ type: "flowSpans", id: 4, docId: "f", version: v1, keys: ["node:Cook"], names: [] });
  const stale = posts[3];
  expect(stale.type === "flowSpans" && stale.result).toEqual({ stale: true });
  handle({ type: "flowSpans", id: 5, docId: "unknown", version: 1, keys: [], names: [] });
  const none = posts[4];
  expect(none.type === "flowSpans" && none.result).toEqual({ stale: true });
});

test("closing_a_flow_answers_the_parse_still_waiting_and_drops_later_ones", async () => {
  vi.useFakeTimers();
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 120);
  handle({ type: "flowParse", id: 9, docId: "g", text: 'diagram flow "G"\nA\n' });
  handle({ type: "flowClose", docId: "g" });
  expect(posts.map((p) => [p.type, p.ids])).toEqual([["flowResult", [9]]]);
  // A keystroke still in flight after the close does not bring the doc back.
  handle({ type: "flowParse", id: 10, docId: "g", text: 'diagram flow "G"\nA\n' });
  await vi.advanceTimersByTimeAsync(200);
  expect(posts.map((p) => [p.type, p.ids])).toEqual([
    ["flowResult", [9]],
    ["failed", [10]],
  ]);
  handle({ type: "flowSpans", id: 11, docId: "g", version: 1, keys: [], names: [] });
  expect(posts[2].type === "flowSpans" && posts[2].result).toEqual({ stale: true });
  // Opening it again starts afresh.
  handle({ type: "flowOpen", docId: "g" });
  handle({ type: "flowParse", id: 12, docId: "g", text: "nope" });
  await vi.advanceTimersByTimeAsync(130);
  const after = flowResults(posts.slice(3))[0];
  expect(after.result.lastValid).toBeNull();
});

test("a_ten_thousand_deep_file_keeps_the_last_good_drawing", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  handle({ type: "flowParse", id: 1, docId: "deep", text: 'diagram flow "D"\nA\n' });
  const opens = Array.from({ length: 10_000 }, (_, i) => `G${i} {`).join("\n");
  const deep = `diagram flow "D"\n${opens}\nA\n${"}\n".repeat(10_000)}`;
  handle({ type: "flowParse", id: 2, docId: "deep", text: deep });
  const [good, bad] = flowResults(posts);
  expect(bad.result.doc).toBeNull();
  expect(bad.result.problems[0].message).toBe("Groups nest at most 20 deep.");
  expect(bad.result.lastValid).toEqual(good.result.doc);
});

test("lang_client_flow_resolves_with_the_parse_and_its_spans", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => handler(m), terminate: () => {} };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const text = 'diagram cloud "C"\nA [icon: aws-s3]\n';
  const r = await client.flow("d", text);
  expect(r.kind).toBe("cloud");
  expect(r.doc?.nodes).toEqual([{ name: "A", kind: "service", attrs: { icon: "aws-s3" } }]);
  // The doc is the last good one while it is there, so it is sent once.
  expect(r.lastValid).toBeNull();
  const spans = await client.flowSpans("d", r.version, ["node:A"], ["A"]);
  if (spans.stale) throw new Error("expected spans");
  expect(spans.lineOf).toEqual({ A: 2 });
  expect(spans.spans["node:A"]?.values?.icon).toEqual({ from: text.indexOf("aws-s3"), to: text.indexOf("aws-s3") + 6 });
  const outline = await client.flowOutline("d", r.version);
  if (outline.stale) throw new Error("expected an outline");
  expect(outline.outline.nodes).toEqual([{ name: "A", id: null, kind: "service", group: null, line: 2, table: false }]);
  // Once the text changes, the old version is stale.
  const next = await client.flow("d", `${text}B [icon: aws-s3]\n`);
  expect(await client.flowOutline("d", r.version)).toEqual({ stale: true });
  const again = await client.flowOutline("d", next.version);
  expect(again.stale === false && again.outline.nodes.map((n) => n.name)).toEqual(["A", "B"]);
  client.closeFlow("d");
  client.openFlow("d");
  client.dispose();
});


test("lang_client_asks_for_one_frame_of_a_board", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => handler(m), terminate: () => {} };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const text = 'diagram flow "A"\nX\nY\n\ndiagram flow "B"\nP\nQ\nP > Q\n';
  const r = await client.flow("b", text);
  expect(r.frames.map((f) => f.title)).toEqual(["A", "B"]);
  const spans = await client.flowSpans("b", r.version, ["node:P"], ["P"], 1);
  if (spans.stale) throw new Error("expected spans");
  expect(spans.lineOf).toEqual({ P: 6 });
  expect(spans.spans["node:P"]?.from).toBe(text.indexOf("P\n"));
  const edit = await client.flowEdit("b", r.version, { op: "addNode", name: "Z", kind: null }, 1);
  if (edit.stale) throw new Error("expected edits");
  expect(applyEdits(text, edit.edits)).toBe(text.replace("Q\nP > Q", "Q\nZ\nP > Q"));
  const outline = await client.flowOutline("b", r.version, 1);
  expect(outline.stale === false && outline.outline.nodes.map((n) => [n.name, n.line])).toEqual([
    ["P", 6],
    ["Q", 7],
  ]);
  // No frame index is frame 0, as before boards.
  const first = await client.flowOutline("b", r.version);
  expect(first.stale === false && first.outline.nodes.map((n) => n.name)).toEqual(["X", "Y"]);
  client.dispose();
});

test("flow_edits_run_in_the_worker_on_the_version_they_were_planned_on", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  // The text has an error (Missing is not defined), and edits still work on it.
  const text = 'diagram dfd "E"\nCustomer [entity]\nCustomer > Missing\n';
  handle({ type: "flowParse", id: 1, docId: "e", text });
  const v1 = flowResults(posts)[0].result.version;
  handle({ type: "flowEdit", id: 2, docId: "e", version: v1, edit: { op: "addNode", name: "Customer", kind: "process", unique: true } });
  const answer = posts[1];
  if (answer.type !== "flowEdit" || answer.result.stale) throw new Error("expected edits");
  expect(answer.result.name).toBe("Customer 2");
  expect(answer.result.edits).toEqual([{ from: text.indexOf("Customer >"), to: text.indexOf("Customer >"), insert: "Customer 2 [process]\n" }]);
  handle({ type: "flowParse", id: 3, docId: "e", text: `${text}// more\n` });
  handle({ type: "flowEdit", id: 4, docId: "e", version: v1, edit: { op: "deleteNode", name: "Customer" } });
  const stale = posts[3];
  expect(stale.type === "flowEdit" && stale.result).toEqual({ stale: true });
  handle({ type: "flowEdit", id: 5, docId: "nobody", version: 1, edit: { op: "deleteNode", name: "Customer" } });
  expect(posts[4].type === "flowEdit" && posts[4].result).toEqual({ stale: true });
});

test("flow_spans_answer_names_like_proto_as_plain_names", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  handle({ type: "flowParse", id: 1, docId: "p", text: 'diagram flow "P"\n__proto__\nconstructor\n' });
  const v = flowResults(posts)[0].result.version;
  handle({ type: "flowSpans", id: 2, docId: "p", version: v, keys: [], names: ["__proto__", "constructor", "toString"] });
  const answer = posts[1];
  if (answer.type !== "flowSpans" || answer.result.stale) throw new Error("expected spans");
  expect(answer.result.lineOf.__proto__).toBe(2);
  expect(answer.result.lineOf.constructor).toBe(3);
  expect(answer.result.lineOf.toString).toBeNull();
});

test("flow_completion_uses_the_worker_names_and_icons", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => handler(m), terminate: () => {} };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  client.setFlowIcons(["users", "aws-s3"]);
  const text = 'diagram cloud "C"\nStore [icon: aws-s3]\nWeb [icon: ';
  await client.flow("c", text);
  const icons = await client.completeFlow("c", text, text.length);
  expect(icons.items.map((i) => i.label)).toEqual(["aws-s3", "users"]);
  // A text the worker has not parsed yet is read as it is.
  const typed = `${text}users]\nWeb > `;
  const names = await client.completeFlow("c", typed, typed.length);
  expect(names.items.map((i) => i.label)).toEqual(["Store", "Web"]);
  const r = await client.flow("c", `${typed}Store\n`);
  const edit = await client.flowEdit("c", r.version, { op: "renameNode", old: "Web", next: "Site" });
  if (edit.stale) throw new Error("expected edits");
  expect(edit.edits.map((e) => e.insert)).toEqual(["Site", "Site"]);
  client.dispose();
});

test("flow_result_sends_last_valid_only_while_the_doc_is_null", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  handle({ type: "flowParse", id: 1, docId: "lv", text: 'diagram flow "F"\nA\n' });
  handle({ type: "flowParse", id: 2, docId: "lv", text: 'diagram flow "F"\nA > Nope\n' });
  const [good, bad] = flowResults(posts);
  expect(good.result.doc).not.toBeNull();
  expect(good.result.lastValid).toBeNull();
  expect(bad.result.doc).toBeNull();
  expect(bad.result.lastValid).toEqual(good.result.doc);
});

test("requests_planned_on_a_version_are_stale_while_a_newer_parse_waits_and_flush_it", async () => {
  vi.useFakeTimers();
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(structuredClone(m)), 120);
  const t1 = 'diagram dfd "D"\nA [entity]\nB [process]\n';
  handle({ type: "flowParse", id: 1, docId: "d", text: t1 });
  await vi.advanceTimersByTimeAsync(130);
  const v1 = flowResults(posts)[0].result.version;
  // Typing at the top: the editor holds t2 and its parse waits out the debounce.
  const t2 = 'diagram dfd "D"\n// typed\nA [entity]\nB [process]\n';
  handle({ type: "flowParse", id: 2, docId: "d", text: t2 });
  handle({ type: "flowEdit", id: 3, docId: "d", version: v1, edit: { op: "deleteNode", name: "B" } });
  // The waiting parse ran at once (so the next try is current), then the edit was refused.
  expect(posts.slice(1).map((p) => [p.type, p.ids])).toEqual([
    ["flowResult", [2]],
    ["flowEdit", [3]],
  ]);
  const refused = posts[2];
  expect(refused.type === "flowEdit" && refused.result).toEqual({ stale: true });
  const v2 = flowResults(posts.filter((p) => p.type === "flowResult"))[1].result.version;
  handle({ type: "flowEdit", id: 4, docId: "d", version: v2, edit: { op: "deleteNode", name: "B" } });
  const ok = posts[3];
  if (ok.type !== "flowEdit" || ok.result.stale) throw new Error("expected edits");
  const e = ok.result.edits[0];
  expect(t2.slice(0, e.from) + e.insert + t2.slice(e.to)).toBe('diagram dfd "D"\n// typed\nA [entity]\n');

  // Spans and completion behave the same.
  const t3 = `${t2}C [store]\n`;
  handle({ type: "flowParse", id: 5, docId: "d", text: t3 });
  handle({ type: "flowSpans", id: 6, docId: "d", version: v2, keys: ["node:B"], names: ["B"] });
  expect(posts.slice(4).map((p) => p.type)).toEqual(["flowResult", "flowSpans"]);
  expect(posts[5].type === "flowSpans" && posts[5].result).toEqual({ stale: true });
  const t4 = `${t3}A > `;
  handle({ type: "flowParse", id: 7, docId: "d", text: t4 });
  handle({ type: "flowComplete", id: 8, docId: "d", text: t4, pos: t4.length });
  expect(posts.slice(6).map((p) => p.type)).toEqual(["flowResult", "flowCompletion"]);
  expect(posts[7].type === "flowCompletion" && posts[7].result.stale).toBe(true);
  handle({ type: "flowComplete", id: 9, docId: "d", text: t4, pos: t4.length });
  const names = posts[8];
  if (names.type !== "flowCompletion") throw new Error("expected completion");
  expect(names.result.stale).toBeUndefined();
  expect(names.result.items.map((i) => i.label)).toEqual(["A", "B", "C"]);
  // Nothing was left waiting.
  await vi.advanceTimersByTimeAsync(200);
  expect(posts).toHaveLength(9);
});

test("a_batch_of_flow_edits_is_one_edit_list_all_or_nothing", () => {
  const posts: FromWorker[] = [];
  const handle = createHandler((m) => posts.push(m), 0);
  const text = 'diagram dfd "B"\r\nA [entity]\r\nB [process]\r\nC [store]\r\nD [store]\r\nA > B\r\nB > C\r\nC > D\r\n';
  handle({ type: "flowParse", id: 1, docId: "b", text });
  const v = flowResults(posts)[0].result.version;
  const del = (name: string) => ({ op: "deleteNode" as const, name });
  handle({ type: "flowEdit", id: 2, docId: "b", version: v, edit: { op: "batch", ops: [del("A"), del("C"), del("D")] } });
  const answer = posts[posts.length - 1];
  if (answer.type !== "flowEdit" || answer.result.stale) throw new Error("expected edits");
  // One edit, against the version it was planned on.
  expect(answer.result.edits).toHaveLength(1);
  const e = answer.result.edits[0];
  expect(text.slice(0, e.from) + e.insert + text.slice(e.to)).toBe('diagram dfd "B"\r\nB [process]\r\n');
  // One op that does not apply refuses the whole batch.
  handle({ type: "flowEdit", id: 3, docId: "b", version: v, edit: { op: "batch", ops: [del("A"), del("Nobody")] } });
  const refused = posts[posts.length - 1];
  expect(refused.type === "flowEdit" && refused.result).toEqual({ stale: false, edits: [] });
});

const flowClient = () => {
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
    handler = createHandler((m) => fake.onmessage?.({ data: structuredClone(m) }), 0);
    return fake;
  });
  return { client, sent };
};

test("the_client_keeps_one_result_per_doc", async () => {
  const { client } = flowClient();
  const text = (n: number) => `diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n// ${n}\n`;
  for (let i = 0; i < 100; i++) await client.flow("f", text(i));
  expect(client.heldFlow.size).toBe(1);
  expect(client.heldFlow.get("f")!.size).toBeLessThanOrEqual(2);
  client.closeFlow("f");
  expect(client.heldFlow.has("f")).toBe(false);
  client.dispose();
});

test("a_miss_asks_for_a_full_post", async () => {
  const { client, sent } = flowClient();
  const t = 'diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n';
  await client.flow("f", t);
  client.heldFlow.delete("f");
  const r = await client.flow("f", `${t}// more\n`);
  const resend = sent.filter((m) => m.type === "flowResend");
  expect(resend).toEqual([{ type: "flowResend", docId: "f", ids: [2] }]);
  expect(r.frames.map((f) => f.doc !== null)).toEqual([true, true]);
  expect(r.frames.every((f) => f.doc !== null && f.docId !== null)).toBe(true);
  expect(client.heldFlow.get("f")?.size).toBe(2);
  client.dispose();
});

test("a_late_resend_does_not_take_a_newer_version", async () => {
  // Worker posts are queued and delivered by hand, so call 3's post can beat the resend for call 2.
  const queue: FromWorker[] = [];
  let handler: (m: ToWorker) => void = () => {};
  let deliver: (m: FromWorker) => void = () => {};
  const client = new LangClient(() => {
    const fake: WorkerLike = { onmessage: null, onerror: null, postMessage: (m) => handler(m), terminate: () => {} };
    handler = createHandler((m) => queue.push(structuredClone(m)), 0);
    deliver = (m) => fake.onmessage?.({ data: m });
    return fake;
  });
  const t = (n: number) => `diagram flow "A"\nA\nB\nA > B\n\ndiagram flow "B"\nC\nD\nC > D\n// ${n}\n`;
  const first = client.flow("f", t(1));
  deliver(queue.shift()!);
  await first;
  client.heldFlow.delete("f");
  const two = client.flow("f", t(2));
  const three = client.flow("f", t(3));
  const [p2, p3] = [queue.shift()!, queue.shift()!];
  deliver(p2); // misses; the client asks for a full post, which the worker answers from text 3
  const resend = queue.shift()!;
  deliver(p3); // also misses, asks again
  deliver(resend);
  deliver(queue.shift()!);
  const [r2, r3] = await Promise.all([two, three]);
  expect(p3.type === "flowResult" && p3.result.version).toBe(r3.version);
  expect(r2.version).toBe(r3.version);
  client.dispose();
});

test("the_board_outline_is_one_worker_request", async () => {
  let handler: (m: ToWorker) => void = () => {};
  const sent: string[] = [];
  const client = new LangClient(() => {
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => {
        sent.push(m.type);
        handler(m);
      },
      terminate: () => {},
    };
    handler = createHandler((m) => fake.onmessage?.({ data: m }), 0);
    return fake;
  });
  const text = 'diagram flow "A"\nX\nY\n\ndiagram flow "B"\nP\nQ\nP > Q\n';
  const r = await client.flow("b", text);
  sent.length = 0;
  const o = await client.boardOutline("b", r.version);
  expect(sent).toEqual(["boardOutline"]);
  if (o.stale) throw new Error("expected the board's outline");
  expect(o.frames.map((f) => [f.title, f.outline.nodes.map((n) => [n.name, n.line])])).toEqual([
    ["A", [["X", 2], ["Y", 3]]],
    ["B", [["P", 6], ["Q", 7]]],
  ]);
  await client.flow("b", `${text}R\n`);
  expect(await client.boardOutline("b", r.version)).toEqual({ stale: true });
  client.dispose();
});
