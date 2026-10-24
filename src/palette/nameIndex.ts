import { connectionForgotten } from "../api/changes";
import type { ConnectionId, DbObject, ObjectKind } from "../api/types";

/** At most this many object names are kept in all; the Connection loaded longest ago goes first. */
export const NAME_INDEX_CAP = 20_000;

/** One object Quick Open can find: its name and where it is, never its rows. */
export interface KeptName {
  kind: ObjectKind;
  database: string;
  schema: string | null;
  name: string;
}

interface Scope {
  database: string;
  schema: string | null;
  items: { kind: ObjectKind; name: string }[];
}

/**
 * The object names seen at each schema load, per Connection, so Quick Open still finds a table after its
 * Connection closes. Names only and capped: when the total passes the cap, the Connection loaded longest ago is
 * dropped first.
 */
export class NameIndex {
  /** Insertion order is load order: the first Connection is the oldest. */
  private byConnection = new Map<ConnectionId, Map<string, Scope>>();
  private total = 0;

  constructor(private readonly cap = NAME_INDEX_CAP) {}

  get size(): number {
    return this.total;
  }

  /** Keeps the names of one scope (a database, or a schema in it), replacing what that scope had. */
  keep(connectionId: ConnectionId, database: string, schema: string | null, objects: readonly DbObject[]): void {
    const scopes = this.byConnection.get(connectionId) ?? new Map<string, Scope>();
    this.byConnection.delete(connectionId);
    const key = `${database}\u0000${schema ?? ""}`;
    const before = scopes.get(key);
    if (before) this.total -= before.items.length;
    const items = objects.slice(0, this.cap).map((o) => ({ kind: o.kind, name: o.name }));
    scopes.set(key, { database, schema, items });
    this.total += items.length;
    this.byConnection.set(connectionId, scopes);
    this.trim(connectionId, key);
  }

  /** Every kept name of a Connection, scope by scope in load order. */
  names(connectionId: ConnectionId): KeptName[] {
    const scopes = this.byConnection.get(connectionId);
    if (!scopes) return [];
    const out: KeptName[] = [];
    for (const s of scopes.values()) {
      for (const o of s.items) out.push({ kind: o.kind, database: s.database, schema: s.schema, name: o.name });
    }
    return out;
  }

  forget(connectionId: ConnectionId): void {
    const scopes = this.byConnection.get(connectionId);
    if (!scopes) return;
    for (const s of scopes.values()) this.total -= s.items.length;
    this.byConnection.delete(connectionId);
  }

  /** Drops the oldest Connections, then the newest one's other scopes, until the names fit the cap. */
  private trim(newest: ConnectionId, keptKey: string): void {
    for (const id of this.byConnection.keys()) {
      if (this.total <= this.cap) return;
      if (id !== newest) this.forget(id);
    }
    const scopes = this.byConnection.get(newest);
    if (!scopes) return;
    for (const [key, s] of scopes) {
      if (this.total <= this.cap) return;
      if (key === keptKey) continue;
      this.total -= s.items.length;
      scopes.delete(key);
    }
  }
}

/** The app's one index, fed by the tree's object loads. */
export const objectNames = new NameIndex();

// A deleted Connection (or one whose history was cleared) leaves at once, as Ask's Recent steps do: its names
// neither show nor count against the cap.
connectionForgotten.on((id) => {
  if (id !== null) objectNames.forget(id);
});
