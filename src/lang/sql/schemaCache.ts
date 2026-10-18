// One schema index per Connection and database, loaded once from the Core and
// sent to the language worker. A reload keeps the last schema in the worker,
// so completion keeps working while checks against the schema wait.
import { sqlSchema } from "../../api/client";
import type { ConnectionId } from "../../api/types";
import type { LangClient } from "../client";
import type { SqlSchema, SqlTable } from "./types";

export type SchemaLoad = "loading" | "loaded" | "failed";

export const schemaKey = (connectionId: ConnectionId, database: string) => `${connectionId}\u0000${database}`;

export class SchemaCache {
  private states = new Map<string, SchemaLoad>();
  private loads = new Map<string, Promise<void>>();
  /** Bumped when a key is reloaded or dropped, so a late answer is ignored. */
  private versions = new Map<string, number>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: LangClient,
    private readonly load: (id: ConnectionId, database: string) => Promise<SqlSchema> = sqlSchema,
  ) {}

  state(connectionId: ConnectionId, database: string): SchemaLoad | null {
    return this.states.get(schemaKey(connectionId, database)) ?? null;
  }

  /** The tables of the last schema loaded for this database (views left out); null before one is. */
  tables(connectionId: ConnectionId, database: string): SqlTable[] | null {
    const schema = this.client.sqlSchemaFor(schemaKey(connectionId, database));
    return schema ? schema.tables.filter((t) => t.kind === "table") : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Loads the schema unless it is loaded or loading. A failed load tries again. */
  ensure(connectionId: ConnectionId, database: string): Promise<void> {
    const key = schemaKey(connectionId, database);
    const s = this.states.get(key);
    if (s === "loaded") return Promise.resolve();
    if (s === "loading") return this.loads.get(key) ?? Promise.resolve();
    return this.fetch(connectionId, database);
  }

  /** Loads again, after DDL or a tree Refresh; without `database`, every database of the Connection. */
  invalidate(connectionId: ConnectionId, database?: string): void {
    for (const key of [...this.states.keys()]) {
      const [c, db] = key.split("\u0000");
      if (c === connectionId && (database === undefined || db === database)) void this.fetch(c, db);
    }
  }

  /** Forgets every schema of a Connection that closed. */
  dropConnection(connectionId: ConnectionId): void {
    let changed = false;
    for (const key of [...this.states.keys()]) {
      if (key.split("\u0000")[0] !== connectionId) continue;
      this.states.delete(key);
      this.loads.delete(key);
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
      this.client.setSqlSchema(key, null);
      changed = true;
    }
    if (changed) this.notify();
  }

  private fetch(connectionId: ConnectionId, database: string): Promise<void> {
    const key = schemaKey(connectionId, database);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.states.set(key, "loading");
    this.notify();
    const p = this.load(connectionId, database).then(
      (schema) => {
        if (this.versions.get(key) !== version) return;
        this.client.setSqlSchema(key, schema);
        this.states.set(key, "loaded");
        this.notify();
      },
      () => {
        if (this.versions.get(key) !== version) return;
        this.states.set(key, "failed");
        this.notify();
      },
    );
    this.loads.set(key, p);
    return p;
  }

  private notify() {
    for (const l of this.listeners) l();
  }
}
