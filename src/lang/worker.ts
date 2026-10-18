// The language worker: parses DBML about 120 ms after the last edit, checks
// SQL and draws its query shape about 150 ms after, and answers SQL completion and refactors at once,
// all off the UI thread. It also lays out diagrams, loading dagre on first use, and converts Mermaid to .flow.
import type { SchemaModel } from "../api/types";
import { layoutMissing } from "../diagram/layout";
import { mermaidToFlow } from "../flow/mermaid";
import { inspectDbml } from "./dbml/inspect";
import { parseDbml } from "./dbml/parse";
import type { FromWorker, ToWorker } from "./protocol";
import { createSqlService } from "./sql/service";

type Debounced = Extract<ToWorker, { type: "update" } | { type: "sqlAnalyze" } | { type: "sqlShape" }>;

/** Handles messages from the client; `debounceMs` 0 runs everything synchronously (tests). */
export function createHandler(post: (m: FromWorker) => void, debounceMs = 120, sqlDebounceMs = debounceMs === 0 ? 0 : 150): (m: ToWorker) => void {
  const lastValid = new Map<string, SchemaModel>();
  const pending = new Map<string, { ids: number[]; timer: ReturnType<typeof setTimeout> | null }>();
  const sql = createSqlService();

  const fail = (ids: number[], e: unknown) => post({ type: "failed", ids, message: e instanceof Error ? e.message : String(e) });

  function run(m: Debounced, ids: number[]) {
    try {
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
  }

  return (m) => {
    switch (m.type) {
      case "update":
        return debounce(m, m.docId, debounceMs);
      case "sqlAnalyze":
        return debounce(m, `sql:${m.docId}`, sqlDebounceMs);
      case "sqlShape":
        return debounce(m, `shape:${m.docId}`, sqlDebounceMs);
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
          post({ type: "mermaid", ids: [m.id], result: mermaidToFlow(m.text, m.title) });
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
