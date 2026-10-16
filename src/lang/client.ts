// The editor side of the language engine. It talks to one worker and restarts it if it crashes.
import type { DialectKind } from "../api/types";
import type { FromWorker, ParseResult, ToWorker } from "./protocol";

export interface WorkerLike {
  postMessage(m: ToWorker): void;
  terminate(): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

type Pending = { resolve: (r: ParseResult) => void; reject: (e: Error) => void };

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
  }

  private receive(m: FromWorker) {
    for (const id of m.ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (m.type === "result") p.resolve(m.result);
      else p.reject(new Error(m.message));
    }
  }

  /** Parses the document; earlier calls for the same document resolve with the newest result. */
  update(docId: string, text: string, dialect: DialectKind): Promise<ParseResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "update", id, docId, text, dialect });
    });
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
