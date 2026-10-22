// @vitest-environment node
import { afterEach, expect, test } from "vitest";
import { SCENARIOS, startServer } from "./ai-fixture-server.mjs";

let running = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function up() {
  running = await startServer();
  return `http://127.0.0.1:${running.port}`;
}

const ask = (base, model) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

const events = (text) => text.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));

test("binds_loopback_only", async () => {
  running = await startServer();
  expect(running.address).toBe("127.0.0.1");
});

test("refuses_a_non_loopback_host", async () => {
  await expect(startServer({ host: "0.0.0.0" })).rejects.toThrow("loopback only");
  await expect(startServer({ host: "192.168.1.5" })).rejects.toThrow("loopback only");
});

test("models_lists_every_scenario", async () => {
  const base = await up();
  const body = await (await fetch(`${base}/v1/models`)).json();
  const ids = body.data.map((m) => m.id);
  expect(ids.sort()).toEqual(Object.keys(SCENARIOS).sort());
  expect(body.data.find((m) => m.id === "fx-answer").context_length).toBe(131072);
  expect(body.data.find((m) => m.id === "fx-compact").context_length).toBe(8192);
});

test("answer_is_valid_sse", async () => {
  const base = await up();
  const res = await ask(base, "fx-answer");
  expect(res.status).toBe(200);
  const lines = events(await res.text());
  expect(lines.at(-1)).toBe("[DONE]");
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  expect(text).toContain("```sql\nSELECT carrier, count(*) AS parcels FROM shipments GROUP BY carrier;\n```");
  expect(chunks.some((c) => c.choices?.[0]?.delta?.reasoning_content)).toBe(true);
  expect(chunks.some((c) => c.choices?.[0]?.finish_reason === "stop")).toBe(true);
  expect(chunks.find((c) => c.usage)?.usage.prompt_tokens_details.cached_tokens).toBeTypeOf("number");
});

test("rate_limit_has_retry_after", async () => {
  const base = await up();
  const res = await ask(base, "fx-429");
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("20");
});

test("unknown_model_is_404", async () => {
  const base = await up();
  const res = await ask(base, "nope");
  expect(res.status).toBe(404);
});

test("diagram_tool_call_names_propose_diagram_changes", async () => {
  const base = await up();
  const text = await (await ask(base, "fx-diagram")).text();
  const chunks = events(text).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
  expect(calls[0].function.name).toBe("propose_diagram_changes");
  const args = JSON.parse(calls.map((c) => c.function.arguments ?? "").join(""));
  expect(Object.keys(args).sort()).toEqual(["base_hash", "file", "ops"]);
  expect(args.ops[0]).toEqual({ add_node: { name: "Customs check", kind: "process" } });
  expect(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
});

test("other_scenarios_have_their_shape", async () => {
  const base = await up();
  expect((await ask(base, "fx-401")).status).toBe(401);
  expect((await ask(base, "fx-500")).status).toBe(500);
  const nf = await ask(base, "fx-404");
  expect(nf.status).toBe(404);
  expect((await nf.json()).error.code).toBe("model_not_found");
  const length = events(await (await ask(base, "fx-length")).text()).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
  expect(length.some((c) => c.choices?.[0]?.finish_reason === "length")).toBe(true);
  const cut = events(await (await ask(base, "fx-cut")).text());
  expect(cut).not.toContain("[DONE]");
  expect(cut.join("")).not.toContain("finish_reason\":\"");
  const filter = events(await (await ask(base, "fx-refusal")).text());
  expect(filter.join("")).toContain("content_filter");
  const compact = events(await (await ask(base, "fx-compact")).text()).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
  expect(compact.find((c) => c.usage).usage.prompt_tokens).toBe(Math.floor(8192 * 0.9));
});

const diagramBody = (text, tail = "File: orders.flow. base_hash: 3f9a0c.\n\nQuestion: add a step") => ({
  model: "fx-diagram",
  stream: true,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: `<<contura:context id=x>>\n${JSON.stringify({ source: "diagram", text })}\n<</contura:context id=x>>\n\n${tail}` },
  ],
});

async function diagramArgs(base, body) {
  const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify(body) });
  const chunks = events(await res.text()).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
  return JSON.parse(chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []).map((c) => c.function.arguments ?? "").join(""));
}

test("diagram_echoes_the_hash_and_file_it_was_sent", async () => {
  const base = await up();
  const args = await diagramArgs(base, diagramBody("diagram\nPack order\nShip"));
  expect(args.base_hash).toBe("3f9a0c");
  expect(args.file).toBe("orders");
});

test("diagram_picks_the_first_node_for_the_line", async () => {
  const base = await up();
  const args = await diagramArgs(base, diagramBody("diagram\nPack order -> Ship\nPack order\nShip"));
  expect(args.ops[1]).toEqual({ add_flow: { from: "Pack order", to: "Customs check" } });
  const none = await diagramArgs(base, diagramBody("diagram\nA -> B"));
  expect(none.ops).toHaveLength(1);
});

test("close_resolves_promptly_during_stall_and_long", async () => {
  for (const model of ["fx-stall", "fx-long"]) {
    const base = await up();
    const res = await ask(base, model);
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    reader.read().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    await running.close();
    running = null;
    expect(Date.now() - t0).toBeLessThan(2000);
  }
});

test("oversize_body_is_413", async () => {
  const base = await up();
  const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "x".repeat(8 * 1024 * 1024 + 10) });
  expect(res.status).toBe(413);
});
