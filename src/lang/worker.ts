// The language worker: parses DBML off the UI thread, about 120 ms after the last edit.
import type { SchemaModel } from "../api/types";
import { inspectDbml } from "./dbml/inspect";
import { parseDbml } from "./dbml/parse";
import type { FromWorker, ToWorker } from "./protocol";

/** Handles messages from the client; `debounceMs` 0 runs synchronously (tests). */
export function createHandler(post: (m: FromWorker) => void, debounceMs = 120): (m: ToWorker) => void {
  const lastValid = new Map<string, SchemaModel>();
  const pending = new Map<string, { ids: number[]; timer: ReturnType<typeof setTimeout> | null }>();

  function run(m: ToWorker, ids: number[]) {
    pending.delete(m.docId);
    try {
      const out = parseDbml(m.text, m.dialect);
      if (out.model) lastValid.set(m.docId, out.model);
      const known = lastValid.get(m.docId) ?? null;
      const diagnostics = out.model ? out.diagnostics : inspectDbml(m.text, out.diagnostics, known);
      post({ type: "result", ids, docId: m.docId, result: { ...out, diagnostics, lastValid: known } });
    } catch (e) {
      post({ type: "failed", ids, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (m) => {
    const entry = pending.get(m.docId) ?? { ids: [], timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    entry.ids.push(m.id);
    if (debounceMs === 0) {
      run(m, entry.ids);
      return;
    }
    entry.timer = setTimeout(() => run(m, entry.ids), debounceMs);
    pending.set(m.docId, entry);
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
