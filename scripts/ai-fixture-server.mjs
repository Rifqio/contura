// A loopback fixture AI provider: an OpenAI-compatible server that plays scripted answers
// and errors, so every AI screen can be produced with no key. The model id in the request
// picks the scenario. It binds 127.0.0.1 (or ::1) only and refuses to start anywhere else.
//
//   node scripts/ai-fixture-server.mjs --port 8765
//
// Point a Custom provider at http://127.0.0.1:8765/v1 with no key.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const SQL_ANSWER = "SELECT carrier, count(*) AS parcels FROM shipments GROUP BY carrier;";
const MAX_BODY = 8 * 1024 * 1024;
const WINDOW = 131072;
const COMPACT_WINDOW = 8192;

// The tool arguments follow the request (crates/contura-core/tests/ai_diagram.rs, proposal_input,
// is the shape): the Core rejects a base_hash that is not the hash of the text it sent.
const DIAGRAM_FALLBACK = { file: "orders", base_hash: "fixture", firstNode: "Pack order" };

const contentText = (m) =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join("") : "";

/** The file, hash and first node of the diagram a request carries; absent parts keep the fallback. */
export function readDiagramRequest(body) {
  const out = { ...DIAGRAM_FALLBACK };
  const user = [...(body?.messages ?? [])].reverse().find((m) => m?.role === "user");
  const text = contentText(user);
  const head = /File: (.+?)\.flow\. base_hash: ([0-9a-fA-F]+)\./.exec(text);
  if (head) {
    out.file = head[1];
    out.base_hash = head[2];
  }
  out.firstNode = null;
  for (const line of text.split("\n")) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item?.source !== "diagram" || typeof item.text !== "string") continue;
    const lines = item.text.split("\n");
    const at = lines.findIndex((l) => /^\s*diagram\b/.test(l));
    for (const l of lines.slice(at + 1)) {
      const t = l.trim();
      if (t && !t.includes(">") && !t.startsWith("//") && !t.startsWith("#")) {
        out.firstNode = t.replace(/\s*\{$/, "");
        break;
      }
    }
    break;
  }
  return out;
}

/** The framed items of a request's last user message, in order. */
function framedItems(body) {
  const user = [...(body?.messages ?? [])].reverse().find((m) => m?.role === "user");
  const out = [];
  for (const line of contentText(user).split("\n")) {
    try {
      const item = JSON.parse(line);
      if (typeof item?.source === "string" && typeof item.text === "string") out.push(item);
    } catch {
      // Not an item line.
    }
  }
  return out;
}

/**
 * The frames of a board request: each title from the header item ("Board: ..." then one `"<title>" (...) [fit]` line
 * per frame), with the shapes of its own item when one was sent (frames left out send none).
 */
export function readBoardRequest(body) {
  const items = framedItems(body).filter((i) => i.source === "diagram");
  const at = items.findIndex((i) => i.text.startsWith("Board: "));
  if (at < 0) return [];
  const frames = [];
  for (const line of items[at].text.split("\n").slice(1)) {
    const m = /^"(.*)" \(.*\) \[(.+)\]$/.exec(line);
    if (m) frames.push({ title: m[1], sent: !m[2].startsWith("left out"), shapes: [] });
  }
  const bodies = items.slice(at + 1);
  for (const f of frames.filter((x) => x.sent)) {
    const text = bodies.shift()?.text ?? "";
    f.shapes = text.startsWith("shapes: ")
      ? text.slice(8).split(", ")
      : text
          .split("\n")
          .slice(1)
          .map((l) => l.trim().replace(/\s*\{$/, ""))
          .filter((t) => t && !t.includes(">") && !t.startsWith("//") && !t.startsWith("#"));
  }
  return frames;
}

/** One tool call with `args`, after a line of answer text. */
function toolChunks(lead, args) {
  const input = JSON.stringify(args);
  return [
    chunk({ content: lead }),
    chunk({ tool_calls: [{ index: 0, id: "call_fx1", type: "function", function: { name: "propose_diagram_changes", arguments: "" } }] }),
    ...input.match(/.{1,40}/g).map((part) => chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] })),
    chunk({}, "tool_calls"),
    chunk({}, null, { choices: [], usage: usage(2100, 120, 0) }),
  ];
}

function diagramChunks(body) {
  const d = readDiagramRequest(body);
  const ops = [{ add_node: { name: "Customs check", kind: "process" } }];
  if (d.firstNode) ops.push({ add_flow: { from: d.firstNode, to: "Customs check" } });
  return toolChunks("I'll add a customs check.", { file: d.file, base_hash: d.base_hash, ops });
}

/** fx-board: a node in each of the first two frames the header names. */
function boardChunks(body) {
  const d = readDiagramRequest(body);
  const ops = readBoardRequest(body)
    .slice(0, 2)
    .map((f) => ({ add_node: { name: "Customs check", frame: f.title } }));
  return toolChunks("I'll add a customs check to two diagrams.", { file: d.file, base_hash: d.base_hash, ops });
}

/** fx-board-remove: four shapes removed, two from each of the first two frames sent with their shapes. */
function boardRemoveChunks(body) {
  const d = readDiagramRequest(body);
  const ops = readBoardRequest(body)
    .filter((f) => f.shapes.length > 0)
    .slice(0, 2)
    .flatMap((f) => f.shapes.slice(0, 2).map((target) => ({ remove_node: { target, frame: f.title } })));
  return toolChunks("I'll remove four shapes.", { file: d.file, base_hash: d.base_hash, ops });
}

/** fx-followup: only a follow-up question, with the file and hash it was sent. */
function followUpChunks(body) {
  const d = readDiagramRequest(body);
  return toolChunks("One question first.", {
    file: d.file,
    base_hash: d.base_hash,
    follow_up: { question: "Which diagram should the customs check go in?" },
  });
}

const usage = (prompt, completion = 48, cached = 0) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached },
});

const chunk = (delta, finish = null, extra = {}) => ({
  id: "fx-1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

const words = (text) => text.match(/\S+\s*|\s+/g) ?? [];

// A fenced answer: reasoning deltas, then text in word pieces.
function answerChunks(sql, { finish = "stop", promptTokens = 1840, cached = 1536, lead = "Group the shipments by carrier and count the rows." } = {}) {
  const out = [];
  for (const piece of ["Looking at the shipments table. ", "Each row has one carrier."]) out.push(chunk({ reasoning_content: piece }));
  const text = `${lead}\n\n\`\`\`sql\n${sql}\n\`\`\``;
  for (const piece of words(text)) out.push(chunk({ content: piece }));
  if (finish) out.push(chunk({}, finish));
  out.push(chunk({}, null, { choices: [], usage: usage(promptTokens, 48, cached) }));
  return out;
}

const sse = (list, { done = true } = {}) => list.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

const stream = (list, opts) => ({ kind: "stream", body: sse(list, opts) });
const failure = (status, body, headers = {}) => ({ kind: "error", status, body, headers });

/** model id -> scenario. A scenario is `{ kind, ... }`; `play` turns it into a response. */
export const SCENARIOS = {
  "fx-answer": stream(answerChunks(SQL_ANSWER)),
  "fx-write": stream(answerChunks("UPDATE shipments SET carrier = 'DHL' WHERE id = 7;", { lead: "Set the carrier on that one parcel." })),
  "fx-risky": stream(answerChunks("SELECT pg_sleep(1);", { lead: "This waits one second." })),
  "fx-length": stream(answerChunks(SQL_ANSWER, { finish: "length" }).slice(0, 8).concat(chunk({}, "length"))),
  // Closes with no finish_reason and no [DONE].
  "fx-cut": stream(answerChunks(SQL_ANSWER, { finish: null }).slice(0, 8), { done: false }),
  "fx-refusal": stream([chunk({ content: "I can't help with that." }), chunk({}, "content_filter")]),
  "fx-429": failure(429, { error: { message: "Rate limit reached", type: "rate_limit_exceeded" } }, { "Retry-After": "20" }),
  "fx-401": failure(401, { error: { message: "Invalid API key", type: "invalid_request_error" } }),
  "fx-404": failure(404, { error: { code: "model_not_found", message: "The model does not exist" } }),
  "fx-500": failure(500, { error: { message: "Internal error", type: "server_error" } }),
  "fx-stall": { kind: "stall", ms: 120_000 },
  // 64 KB of text in 50 ms chunks, about 30s.
  "fx-long": { kind: "long", bytes: 64 * 1024, every: 50, pieces: 640 },
  "fx-compact": stream(answerChunks(SQL_ANSWER, { promptTokens: Math.floor(COMPACT_WINDOW * 0.9), cached: 0 })),
  // A one-frame board (or a lone diagram): a node, and a line from its first shape.
  "fx-diagram": { kind: "diagram", chunks: diagramChunks },
  // A board of two or more frames: one call adding a node in each of the first two frames.
  "fx-board": { kind: "diagram", chunks: boardChunks },
  // A board: one call removing 4 shapes across two frames (more than 3, so it asks first).
  "fx-board-remove": { kind: "diagram", chunks: boardRemoveChunks },
  // A board: one call asking a follow-up question and proposing nothing.
  "fx-followup": { kind: "diagram", chunks: followUpChunks },
  // Answers like fx-answer; its chat title requests fail with 500.
  "fx-title-fail": stream(answerChunks(SQL_ANSWER)),
};

/** The chat title Contura asks for after a first answer. */
export const TITLE = "Unpaid clients to date";
/** A title request asks for at most this many tokens, and carries no tools. */
const TITLE_TOKENS = 32;

/** A chat title request: `max_tokens` or `max_completion_tokens` at most 32, and no tools (the Custom provider may send either field). */
export function isTitleRequest(body) {
  const limit = body?.max_tokens ?? body?.max_completion_tokens;
  const tools = Array.isArray(body?.tools) && body.tools.length > 0;
  return typeof limit === "number" && limit <= TITLE_TOKENS && !tools;
}

const titleReply = stream([...words(TITLE).map((piece) => chunk({ content: piece })), chunk({}, "stop"), chunk({}, null, { choices: [], usage: usage(310, 6, 0) })]);
const titleFailure = failure(500, { error: { message: "Internal error", type: "server_error" } });

/** The scenario a request plays: a title request answers the title, or fails for `fx-title-fail`; else the model's own. */
function scenarioFor(model, body) {
  if (!Object.hasOwn(SCENARIOS, model)) return null;
  if (isTitleRequest(body)) return model === "fx-title-fail" ? titleFailure : titleReply;
  return SCENARIOS[model];
}

function models() {
  return {
    object: "list",
    data: Object.keys(SCENARIOS).map((id) => ({
      id,
      object: "model",
      owned_by: "fixture",
      context_length: id === "fx-compact" ? COMPACT_WINDOW : WINDOW,
    })),
  };
}

function play(scenario, res, timers, body) {
  if (scenario.kind === "error") {
    res.writeHead(scenario.status, { "content-type": "application/json", ...scenario.headers });
    res.end(JSON.stringify(scenario.body));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (scenario.kind === "stream") {
    res.end(scenario.body);
  } else if (scenario.kind === "diagram") {
    res.end(sse(scenario.chunks(body)));
  } else if (scenario.kind === "stall") {
    res.flushHeaders();
    const t = setTimeout(() => {
      timers.delete(t);
      res.end();
    }, scenario.ms);
    timers.add(t);
  } else if (scenario.kind === "long") {
    const piece = "The shipments table holds one row per parcel. ".repeat(Math.ceil(scenario.bytes / scenario.pieces / 46)).slice(0, Math.ceil(scenario.bytes / scenario.pieces));
    let n = 0;
    const tick = setInterval(() => {
      if (n >= scenario.pieces || res.destroyed) {
        clearInterval(tick);
        timers.delete(tick);
        if (!res.destroyed) res.end(sse([chunk({}, "stop"), chunk({}, null, { choices: [], usage: usage(1840, 16000, 0) })]));
        return;
      }
      n++;
      res.write(`data: ${JSON.stringify(chunk({ content: piece }))}\n\n`);
    }, scenario.every);
    timers.add(tick);
    res.on("close", () => clearInterval(tick));
  }
}

export function startServer({ host = "127.0.0.1", port = 0 } = {}) {
  if (host !== "127.0.0.1" && host !== "::1") return Promise.reject(new Error("loopback only"));
  const timers = new Set();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(models()));
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      let raw = "";
      let tooBig = false;
      req.on("data", (d) => {
        if (tooBig) return;
        raw += d;
        if (raw.length > MAX_BODY) {
          tooBig = true;
          raw = "";
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: { message: "request body too large" } }));
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        let model = "";
        let body = null;
        try {
          body = JSON.parse(raw);
          model = body.model;
        } catch {
          // An unreadable body names no model.
        }
        const scenario = scenarioFor(model, body);
        if (!scenario) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "model_not_found", message: `no scenario ${String(model)}` } }));
        } else play(scenario, res, timers, body);
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const a = server.address();
      ok({
        port: a.port,
        address: a.address,
        close: () =>
          new Promise((done) => {
            for (const t of timers) {
              clearTimeout(t);
              clearInterval(t);
            }
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--port");
  const want = i > 0 ? process.argv[i + 1] : "8765";
  if (!/^\d+$/.test(want ?? "") || Number(want) > 65535) {
    console.error(`--port needs a number from 0 to 65535, not "${want ?? ""}"`);
    process.exit(2);
  }
  const { port } = await startServer({ port: Number(want) });
  console.log(`ai fixture provider on http://127.0.0.1:${port}/v1`);
}
