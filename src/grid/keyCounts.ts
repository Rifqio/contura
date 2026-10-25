// UX step 8: how many rows of a table point to a row, from the Core's count: `SELECT COUNT(*)` over at most 1,001
// matching rows, with the page's filter, on a read of its own (never the browse session), read-only, which the server
// stops after a few seconds. Counts run one at a time per Connection, as they are unasked-for reads; a count whose
// list has closed is dropped before it runs. A Connection the server stopped a count on is not counted for a minute,
// and a closed one never. The minute is kept per lane: a table tab's count of its own table and the counts of rows
// that point here never hold each other back.
import { countRows as coreCount } from "../api/client";
import type { ConnectionId, ObjectPath } from "../api/types";
import type { RowCount } from "./foreignKeys";

export const countSettings = { slowForMs: 60_000 };
const CAP = 1000;

/** Which counts a slow one holds back: a table tab's own count, or the counts of rows that point here. */
export type CountLane = "table" | "keys";

/** Connection and lane pairs whose last count the server stopped, until when they are skipped. */
const slowUntil = new Map<string, number>();
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

/** Why a count is not run now, or null when it may run. */
function skipped(connectionId: ConnectionId, lane: CountLane, open: boolean): RowCount | null {
  if (!open) return { state: "skipped", why: "closed" };
  if ((slowUntil.get(`${lane}\u0000${connectionId}`) ?? 0) > Date.now()) return { state: "skipped", why: "slow" };
  return null;
}

/** Counts the rows of `table` matching `where` (the filter bar's SQL), capped at "1,000+". */
export function countRows(
  connectionId: ConnectionId,
  req: { table: ObjectPath; where: string | null },
  open: boolean,
  stop?: CountStop,
  lane: CountLane = "keys",
): Promise<RowCount> {
  const now = skipped(connectionId, lane, open);
  if (now) return Promise.resolve(now);
  const run = async (): Promise<RowCount> => {
    if (stop?.cancelled) return { state: "skipped", why: "cancelled" };
    const later = skipped(connectionId, lane, open);
    if (later) return later;
    try {
      const c = await coreCount(connectionId, { table: req.table, filter: req.where });
      if (c.kind === "timedOut") {
        slowUntil.set(`${lane}\u0000${connectionId}`, Date.now() + countSettings.slowForMs);
        return { state: "timeout" };
      }
      if (stop?.cancelled) return { state: "skipped", why: "cancelled" };
      return { state: "done", rows: Math.min(c.rows, CAP), more: c.rows > CAP };
    } catch {
      return { state: "skipped", why: "error" };
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
