// The editor side of the language engine. It talks to one worker and restarts it if it crashes.
import type { DialectKind } from "../api/types";
import type { LayoutRequest, Positions } from "../diagram/layout";
import type { MermaidResult } from "../flow/mermaid";
import type {
  Diagnostic,
  FlowCompleteAnswer,
  FlowEditAnswer,
  FlowOutlineAnswer,
  FlowRequestOp,
  FlowResult,
  FlowSpansResult,
  FromWorker,
  ParseResult,
  SqlAt,
  SqlRefactorAction,
  SqlRefactorResult,
  ToWorker,
} from "./protocol";
import type { SqlCompletionResult } from "./sql/complete";
import type { SchemaState } from "./sql/inspect";
import type { QueryShape, ShapeProblem } from "./sql/queryShape";
import type { SqlSchema } from "./sql/types";

export interface WorkerLike {
  postMessage(m: ToWorker): void;
  terminate(): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

type Pending = { resolve: (r: never) => void; reject: (e: Error) => void };

/** A real Worker in the app; where none exists (jsdom tests), the same handler runs in-process. */
function defaultWorker(): WorkerLike {
  if (typeof Worker !== "undefined") {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  }
  let handle: ((m: ToWorker) => void) | null = null;
  const queued: ToWorker[] = [];
  const inline: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => (handle ? handle(m) : queued.push(m)),
    terminate: () => {},
  };
  void import("./worker").then(({ createHandler }) => {
    handle = createHandler((m) => inline.onmessage?.({ data: m }));
    for (const m of queued.splice(0)) handle(m);
  });
  return inline;
}

export class LangClient {
  private worker: WorkerLike;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Every schema sent, so a restarted worker gets them again. */
  private schemas = new Map<string, SqlSchema>();
  /** The icon names sent, so a restarted worker gets them again. */
  private flowIcons: string[] | null = null;
  private restartListeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly factory: () => WorkerLike = defaultWorker) {
    this.worker = this.start();
  }

  private start(): WorkerLike {
    const w = this.factory();
    w.onmessage = (e) => this.receive(e.data);
    w.onerror = () => this.restart();
    return w;
  }

  private restart() {
    this.worker.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error("engine restarted"));
    this.worker = this.start();
    for (const [key, schema] of this.schemas) this.worker.postMessage({ type: "sqlSchema", key, schema });
    if (this.flowIcons) this.worker.postMessage({ type: "flowIcons", names: this.flowIcons });
    for (const l of this.restartListeners) l();
  }

  /** Called after the worker crashed and a new one took over; returns the unsubscribe. */
  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  private receive(m: FromWorker) {
    for (const id of m.ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      const resolve = p.resolve as (r: unknown) => void;
      if (m.type === "failed") p.reject(new Error(m.message));
      else if (m.type === "sqlDiagnostics") resolve(m.diagnostics);
      else if (m.type === "layout") resolve(m.positions);
      else resolve(m.result);
    }
  }

  /** Parses the document; earlier calls for the same document resolve with the newest result. */
  update(docId: string, text: string, dialect: DialectKind): Promise<ParseResult> {
    return this.ask((id) => ({ type: "update", id, docId, text, dialect }));
  }

  /** Sends the schema for a Connection and database; null drops it. */
  setSqlSchema(key: string, schema: SqlSchema | null) {
    if (schema) this.schemas.set(key, schema);
    else this.schemas.delete(key);
    if (!this.disposed) this.worker.postMessage({ type: "sqlSchema", key, schema });
  }

  /** The schema last sent for `key`, for lookups that cannot wait for the worker. */
  sqlSchemaFor(key: string | null): SqlSchema | null {
    return key ? (this.schemas.get(key) ?? null) : null;
  }

  /** Checks the SQL; earlier calls for the same document resolve with the newest result. */
  analyzeSql(q: { docId: string; text: string; dialect: DialectKind; schemaKey: string | null; schemaState: SchemaState }): Promise<Diagnostic[]> {
    return this.ask((id) => ({ type: "sqlAnalyze", id, ...q }));
  }

  /** The query diagram's shape of the statement at `pos`; earlier calls for the same document resolve with the newest result. */
  sqlShape(q: { docId: string; text: string; dialect: DialectKind; schemaKey: string | null; schemaState: SchemaState; pos: number }): Promise<QueryShape | ShapeProblem> {
    return this.ask((id) => ({ type: "sqlShape", id, ...q }));
  }

  completeSql(q: SqlAt & { docId?: string; explicit: boolean; aliasTables?: boolean }): Promise<SqlCompletionResult> {
    return this.ask((id) => ({ type: "sqlComplete", id, ...q }));
  }

  refactorSql<A extends SqlRefactorAction>(q: SqlAt & { docId?: string; action: A }): Promise<Extract<SqlRefactorResult, { action: A }>> {
    return this.ask((id) => ({ type: "sqlRefactor", id, ...q }));
  }

  /** Places the diagram nodes the request has no position for, in the worker (ruling D14). */
  layout(request: LayoutRequest): Promise<Positions> {
    return this.ask((id) => ({ type: "layout", id, request }));
  }

  /** Converts a Mermaid flowchart to .flow; `title` is used when the front matter has none. */
  mermaid(text: string, title: string): Promise<MermaidResult> {
    return this.ask((id) => ({ type: "mermaid", id, text, title }));
  }

  /** Parses .flow text; earlier calls for the same document resolve with the newest result. */
  flow(docId: string, text: string): Promise<FlowResult> {
    return this.ask((id) => ({ type: "flowParse", id, docId, text }));
  }

  /** Source ranges and lines from the parse with `version`; `{ stale: true }` once the text has changed. */
  flowSpans(docId: string, version: number, keys: string[], names: string[]): Promise<FlowSpansResult> {
    return this.ask((id) => ({ type: "flowSpans", id, docId, version, keys, names }));
  }

  /** A canvas action as text edits on the text of `version`; `{ stale: true }` once the text has changed. */
  flowEdit(docId: string, version: number, edit: FlowRequestOp): Promise<FlowEditAnswer> {
    return this.ask((id) => ({ type: "flowEdit", id, docId, version, edit }));
  }

  /** The outline of the parse with `version`, for the diagram assistant; `{ stale: true }` once the text has changed. */
  flowOutline(docId: string, version: number): Promise<FlowOutlineAnswer> {
    return this.ask((id) => ({ type: "flowOutline", id, docId, version }));
  }

  /** Completion at `pos` in a .flow text, worked out in the worker; `stale` asks the caller to ask once more. */
  completeFlow(docId: string, text: string, pos: number): Promise<FlowCompleteAnswer> {
    return this.ask((id) => ({ type: "flowComplete", id, docId, text, pos }));
  }

  /** Every icon name, for completion after `icon:`; kept and sent again if the worker restarts. */
  setFlowIcons(names: string[]) {
    this.flowIcons = names;
    if (!this.disposed) this.worker.postMessage({ type: "flowIcons", names });
  }

  /** A DBML editor closed: the worker forgets its last valid model. */
  closeDbml(docId: string) {
    if (!this.disposed) this.worker.postMessage({ type: "dbmlClose", docId });
  }

  /** A flow tab opened under an id that was closed before. */
  openFlow(docId: string) {
    if (!this.disposed) this.worker.postMessage({ type: "flowOpen", docId });
  }

  /** The flow tab closed: the worker forgets its text and last good drawing, and drops later parses for it. */
  closeFlow(docId: string) {
    if (!this.disposed) this.worker.postMessage({ type: "flowClose", docId });
  }

  private ask<R>(message: (id: number) => ToWorker): Promise<R> {
    if (this.disposed) return Promise.reject(new Error("engine stopped"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: never) => void, reject });
      this.worker.postMessage(message(id));
    });
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error("engine stopped"));
  }
}
