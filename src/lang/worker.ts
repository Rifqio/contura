// The language worker: parses DBML about 120 ms after the last edit, checks
// SQL and draws its query shape about 150 ms after, and answers SQL completion and refactors at once,
// all off the UI thread. It also lays out diagrams, loading dagre on first use, converts Mermaid to .flow,
// and parses .flow text on the same debounce as DBML.
import type { SchemaModel } from "../api/types";
import { layoutMissing } from "../diagram/layout";
import { mermaidToFlow } from "../flow/mermaid";
import { inspectDbml } from "./dbml/inspect";
import { parseDbml } from "./dbml/parse";
import { createFlowService } from "./flow/service";
import { toWire } from "./flow/wire";
import type { FromWorker, ToWorker } from "./protocol";
import { createSqlService } from "./sql/service";

type Debounced = Extract<ToWorker, { type: "update" } | { type: "sqlAnalyze" } | { type: "sqlShape" } | { type: "flowParse" }>;

/** Handles messages from the client; `debounceMs` 0 runs everything synchronously (tests). */
export function createHandler(post: (m: FromWorker) => void, debounceMs = 120, sqlDebounceMs = debounceMs === 0 ? 0 : 150): (m: ToWorker) => void {
  const lastValid = new Map<string, SchemaModel>();
  const flow = createFlowService();
  /** The doc ids of the last result posted, per document: the next post leaves those docs out. */
  const sentFlow = new Map<string, Set<number>>();
  /** The newest flowParse waiting out its debounce, per document. */
  const waitingFlow = new Map<string, Extract<ToWorker, { type: "flowParse" }>>();
  const pending = new Map<string, { ids: number[]; timer: ReturnType<typeof setTimeout> | null }>();
  const sql = createSqlService();

  const fail = (ids: number[], e: unknown) => post({ type: "failed", ids, message: e instanceof Error ? e.message : String(e) });

  /** Parses `text` and posts the docs the editor side does not hold (all of them when `sent` is empty). */
  function postFlow(docId: string, text: string, ids: number[], keepVersion = false) {
    let sent = sentFlow.get(docId);
    if (!sent) sentFlow.set(docId, (sent = new Set()));
    post({ type: "flowResult", ids, docId, result: toWire(flow.parse(docId, text, keepVersion), sent) });
  }

  function run(m: Debounced, ids: number[]) {
    try {
      if (m.type === "flowParse") {
        pending.delete(`flow:${m.docId}`);
        waitingFlow.delete(m.docId);
        postFlow(m.docId, m.text, ids);
        return;
      }
      if (m.type === "sqlShape") {
        pending.delete(`shape:${m.docId}`);
        post({ type: "sqlShape", ids, result: sql.shape(m.docId, m.text, m.dialect, m.schemaKey, m.schemaState, m.pos) });
        return;
      }
      if (m.type === "sqlAnalyze") {
        pending.delete(`sql:${m.docId}`);
        const diagnostics = sql.analyze(m.docId, m.text, m.dialect, m.schemaKey, m.schemaState);
        post({ type: "sqlDiagnostics", ids, docId: m.docId, diagnostics });
        return;
      }
      pending.delete(m.docId);
      const out = parseDbml(m.text, m.dialect);
      if (out.model) lastValid.set(m.docId, out.model);
      const known = lastValid.get(m.docId) ?? null;
      const diagnostics = out.model ? out.diagnostics : inspectDbml(m.text, out.diagnostics, known);
      post({ type: "result", ids, docId: m.docId, result: { ...out, diagnostics, lastValid: known } });
    } catch (e) {
      fail(ids, e);
    }
  }

  function debounce(m: Debounced, key: string, ms: number) {
    const entry = pending.get(key) ?? { ids: [], timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    entry.ids.push(m.id);
    if (ms === 0) {
      run(m, entry.ids);
      return;
    }
    entry.timer = setTimeout(() => run(m, entry.ids), ms);
    pending.set(key, entry);
    if (m.type === "flowParse") waitingFlow.set(m.docId, m);
  }

  /** Runs the parse still waiting for `docId` at once; true when there was one. */
  function flushFlow(docId: string): boolean {
    const entry = pending.get(`flow:${docId}`);
    const m = waitingFlow.get(docId);
    if (!entry || !m) return false;
    if (entry.timer) clearTimeout(entry.timer);
    run(m, entry.ids);
    return true;
  }

  return (m) => {
    switch (m.type) {
      case "update":
        return debounce(m, m.docId, debounceMs);
      case "sqlAnalyze":
        return debounce(m, `sql:${m.docId}`, sqlDebounceMs);
      case "sqlShape":
        return debounce(m, `shape:${m.docId}`, sqlDebounceMs);
      case "flowParse":
        if (flow.isClosed(m.docId)) return fail([m.id], new Error("This diagram is closed."));
        return debounce(m, `flow:${m.docId}`, debounceMs);
      case "flowOpen":
        sentFlow.delete(m.docId);
        return flow.open(m.docId);
      case "flowResend": {
        // The editor side lost docs this worker thought it held: parse the cached text again, post everything.
        sentFlow.delete(m.docId);
        const text = flow.cachedText(m.docId);
        if (text === undefined) return fail(m.ids, new Error("This diagram is closed."));
        try {
          postFlow(m.docId, text, m.ids, true);
        } catch (e) {
          fail(m.ids, e);
        }
        return;
      }
      case "flowSpans":
        // A newer text still waiting out its debounce makes any version stale (ruling P8). Parsing it now means
        // the caller's next try is current.
        if (flushFlow(m.docId)) return post({ type: "flowSpans", ids: [m.id], result: { stale: true } });
        try {
          post({ type: "flowSpans", ids: [m.id], result: flow.spans(m.docId, m.version, m.keys, m.names, m.frameIndex) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "flowEdit":
        if (flushFlow(m.docId)) return post({ type: "flowEdit", ids: [m.id], result: { stale: true } });
        try {
          post({ type: "flowEdit", ids: [m.id], result: flow.edit(m.docId, m.version, m.edit, m.frameIndex) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "flowOutline":
        if (flushFlow(m.docId)) return post({ type: "flowOutline", ids: [m.id], result: { stale: true } });
        try {
          post({ type: "flowOutline", ids: [m.id], result: flow.outline(m.docId, m.version, m.frameIndex) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "flowComplete":
        if (flushFlow(m.docId)) return post({ type: "flowCompletion", ids: [m.id], result: { from: m.pos, items: [], stale: true } });
        try {
          post({ type: "flowCompletion", ids: [m.id], result: flow.complete(m.docId, m.text, m.pos) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "flowIcons":
        return flow.setIcons(m.names);
      case "dbmlClose": {
        // A parse still waiting is dropped with the document (its editor is gone), and so is its last valid model.
        const entry = pending.get(m.docId);
        if (entry?.timer) clearTimeout(entry.timer);
        if (entry) fail(entry.ids, new Error("This document is closed."));
        pending.delete(m.docId);
        lastValid.delete(m.docId);
        return;
      }
      case "flowClose":
        // A parse still waiting is answered now, so its caller never hangs; then the doc is forgotten.
        flushFlow(m.docId);
        flow.close(m.docId);
        sentFlow.delete(m.docId);
        return;
      case "sqlSchema":
        return sql.setSchema(m.key, m.schema);
      case "sqlComplete":
        try {
          post({ type: "sqlCompletion", ids: [m.id], result: sql.complete(m) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "sqlRefactor":
        try {
          post({ type: "sqlRefactor", ids: [m.id], result: sql.refactor(m) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "mermaid":
        try {
          post({ type: "mermaid", ids: [m.id], result: mermaidToFlow(m.text, m.title, { keepUnread: m.keepUnread }) });
        } catch (e) {
          fail([m.id], e);
        }
        return;
      case "layout":
        layoutMissing(m.request).then(
          (positions) => post({ type: "layout", ids: [m.id], positions }),
          (e: unknown) => fail([m.id], e),
        );
        return;
    }
  };
}

// Inside a real Worker, wire the handler to the message port.
declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== "undefined") {
  const scope = self as unknown as {
    postMessage(m: FromWorker): void;
    onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  };
  const handle = createHandler((m) => scope.postMessage(m));
  scope.onmessage = (e) => handle(e.data);
}
