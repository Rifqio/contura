// UX step 8: how many rows of a table point to a row, from the Core's count: `SELECT COUNT(*)` over at most 1,001
// matching rows, with the page's filter, on a read of its own (never the browse session), read-only, which the server
// stops after a few seconds. Counts run one at a time per Connection, as they are unasked-for reads; a count whose
// list has closed is dropped before it runs. A Connection the server stopped a count on is not counted for a minute,
// and a closed one never.
import { countRows as coreCount } from "../api/client";
import type { ConnectionId, ObjectPath } from "../api/types";
import type { RowCount } from "./foreignKeys";

export const countSettings = { slowForMs: 60_000 };
const CAP = 1000;

/** Connections whose last count the server stopped, until when they are skipped. */
const slowUntil = new Map<ConnectionId, number>();
/** The last count asked on each Connection; the next one waits for it. */
const queue = new Map<ConnectionId, Promise<unknown>>();

export function forgetSlowForTests() {
  slowUntil.clear();
  queue.clear();
}

/** Set `cancelled` when the list that asked closes: a count still waiting its turn never runs. */
export interface CountStop {
  cancelled: boolean;
}

const skipped = (connectionId: ConnectionId, open: boolean) => !open || (slowUntil.get(connectionId) ?? 0) > Date.now();

/** Counts the rows of `table` matching `where` (the filter bar's SQL), capped at "1,000+". */
export function countRows(connectionId: ConnectionId, req: { table: ObjectPath; where: string | null }, open: boolean, stop?: CountStop): Promise<RowCount> {
  if (skipped(connectionId, open)) return Promise.resolve({ state: "skipped" });
  const run = async (): Promise<RowCount> => {
    if (stop?.cancelled || skipped(connectionId, open)) return { state: "skipped" };
    try {
      const c = await coreCount(connectionId, { table: req.table, filter: req.where });
      if (c.kind === "timedOut") {
        slowUntil.set(connectionId, Date.now() + countSettings.slowForMs);
        return { state: "timeout" };
      }
      if (stop?.cancelled) return { state: "skipped" };
      return { state: "done", rows: Math.min(c.rows, CAP), more: c.rows > CAP };
    } catch {
      return { state: "skipped" };
    }
  };
  const next = (queue.get(connectionId) ?? Promise.resolve()).then(run, run);
  queue.set(connectionId, next);
  // The queue holds only its last count, so it never grows.
  void next.finally(() => {
    if (queue.get(connectionId) === next) queue.delete(connectionId);
  });
  return next;
}
