import { connectionForgotten } from "../api/changes";
import { columnOrders, saveColumnOrder } from "../api/client";
import type { ConnectionId, ObjectPath } from "../api/types";

/**
 * The column orders of the table grids, remembered per table per Connection in the Core's settings, so they come
 * back when a tab is closed and opened again and after a restart. Read once per Connection, then kept here; a
 * failed read is asked again next time. Query results are never remembered.
 */
const cache = new Map<ConnectionId, Promise<Map<string, string[]>>>();
// A deleted Connection takes its orders with it in the Core; read again rather than keep a stale copy.
connectionForgotten.on((id) => (id === null ? cache.clear() : cache.delete(id)));

/** The table's key in the stored map: database, schema and name, so two schemas never share an order. */
export function tableOrderKey(path: ObjectPath): string {
  return JSON.stringify([path.database, path.schema, path.name]);
}

function ordersOf(connectionId: ConnectionId): Promise<Map<string, string[]>> {
  let p = cache.get(connectionId);
  if (!p) {
    p = columnOrders(connectionId).then((o) => {
      const m = new Map<string, string[]>();
      for (const [k, v] of Object.entries(o ?? {})) if (Array.isArray(v)) m.set(k, v.filter((n) => typeof n === "string"));
      return m;
    });
    cache.set(connectionId, p);
    p.catch(() => {
      if (cache.get(connectionId) === p) cache.delete(connectionId);
    });
  }
  return p;
}

/** The remembered order of a table, as column names; null when it shows in its own order or the read failed. */
export function loadColumnOrder(connectionId: ConnectionId, path: ObjectPath): Promise<string[] | null> {
  return ordersOf(connectionId).then(
    (m) => m.get(tableOrderKey(path)) ?? null,
    () => null,
  );
}

/** How long a run of key moves (Shift+Alt+Right held down) waits before the last one is written. */
export const SAVE_DELAY_MS = 400;
const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => Promise<void> }>();

/**
 * Remembers a table's order (null: its own order again), writing only that table's entry. The cache changes at once.
 * The Core write is at once too, unless `later` (a held move key): then it waits for the run to pause and writes only
 * the last order. Best effort: a failed write keeps the order on screen.
 */
export function rememberColumnOrder(connectionId: ConnectionId, path: ObjectPath, names: string[] | null, later = false): void {
  const key = tableOrderKey(path);
  const kept = cache.get(connectionId);
  if (kept) {
    void kept
      .then((m) => {
        if (names) m.set(key, names);
        else m.delete(key);
      })
      .catch(() => {});
  }
  const id = `${connectionId}\u0000${key}`;
  const before = waiting.get(id);
  if (before) clearTimeout(before.timer);
  const write = () => {
    waiting.delete(id);
    return saveColumnOrder(connectionId, key, names).catch(() => {});
  };
  if (!later) {
    // Replaces a key run's write still waiting for this table.
    if (before) waiting.delete(id);
    void write();
    return;
  }
  waiting.set(id, { timer: setTimeout(() => void write(), SAVE_DELAY_MS), write });
}

/**
 * Writes the orders still waiting at once; resolves when the Core has them. The window's close request and an update's
 * restart wait for it, so no move is lost to a quit.
 */
export function flushColumnOrders(): Promise<void> {
  const writes = [...waiting.values()].map((w) => {
    clearTimeout(w.timer);
    return w.write();
  });
  return Promise.all(writes).then(() => {});
}
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flushColumnOrders());

/** Forgets what was read, so a test starts from the Core's answer. */
export function forgetColumnOrdersForTests(): void {
  cache.clear();
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
}
