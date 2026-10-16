// The editor side of the language engine. It talks to one worker and restarts it if it crashes.
import type { DialectKind } from "../api/types";
import type {
  Diagnostic,
  FromWorker,
  ParseResult,
  SqlAt,
  SqlRefactorAction,
  SqlRefactorResult,
  ToWorker,
} from "./protocol";
import type { SqlCompletionResult } from "./sql/complete";
import type { SchemaState } from "./sql/inspect";
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

  completeSql(q: SqlAt & { docId?: string; explicit: boolean; aliasTables?: boolean }): Promise<SqlCompletionResult> {
    return this.ask((id) => ({ type: "sqlComplete", id, ...q }));
  }

  refactorSql<A extends SqlRefactorAction>(q: SqlAt & { docId?: string; action: A }): Promise<Extract<SqlRefactorResult, { action: A }>> {
    return this.ask((id) => ({ type: "sqlRefactor", id, ...q }));
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
