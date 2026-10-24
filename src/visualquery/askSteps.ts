import type { ConnectionId, VisualQuery } from "../api/types";
import type { RecentStepInput } from "../assistant/recentSteps";

/** Where the Visual Query is: its title and its Connection and database. */
export interface VqWhere {
  title: string | null;
  connectionId: ConnectionId | null;
  database: string | null;
}

const NOWHERE: VqWhere = { title: null, connectionId: null, database: null };

/**
 * The Recent steps a model change makes (spec 7.1): tables added or removed, columns ticked or unticked, joins
 * added, filters added or moved to another column, the order by changed. Only names go: never a filter's value,
 * and a card moved, a width dragged or the query renamed is no step.
 */
export function vqSteps(prev: VisualQuery, next: VisualQuery, where: VqWhere = NOWHERE): RecentStepInput[] {
  // A card moved or resized changes only the tables' places: nothing to read, nothing allocated, on every frame.
  if (
    prev.columns === next.columns &&
    prev.joins === next.joins &&
    prev.filters === next.filters &&
    prev.orderBy === next.orderBy &&
    prev.tables.length === next.tables.length &&
    prev.tables.every((t, i) => t.id === next.tables[i].id)
  ) {
    return [];
  }
  const tableName = (id: string) => next.tables.find((t) => t.id === id)?.name ?? prev.tables.find((t) => t.id === id)?.name ?? null;
  const col = (table: string, column: string) => {
    const t = tableName(table);
    return t ? `${t}.${column}` : column;
  };
  const step = (verb: RecentStepInput["verb"], names: string[], extra: Partial<RecentStepInput> = {}): RecentStepInput => ({
    verb,
    tab: "visual",
    title: where.title,
    connectionId: where.connectionId,
    database: where.database,
    schema: null,
    count: null,
    ...(names.length > 0 && { names }),
    ...extra,
  });
  const out: RecentStepInput[] = [];

  const prevTables = new Set(prev.tables.map((t) => t.id));
  const nextTables = new Set(next.tables.map((t) => t.id));
  const added = next.tables.filter((t) => !prevTables.has(t.id)).map((t) => t.name);
  const removed = prev.tables.filter((t) => !nextTables.has(t.id)).map((t) => t.name);
  if (added.length > 0) out.push(step("vqTable", added));
  if (removed.length > 0) out.push(step("vqTableOff", removed));

  const key = (c: { table: string; column: string }) => `${c.table}\u0000${c.column}`;
  const prevCols = new Set(prev.columns.map(key));
  const nextCols = new Set(next.columns.map(key));
  const ticked = next.columns.filter((c) => !prevCols.has(key(c))).map((c) => col(c.table, c.column));
  // A removed table's columns go with it: the table step says so.
  const unticked = prev.columns.filter((c) => !nextCols.has(key(c)) && nextTables.has(c.table)).map((c) => col(c.table, c.column));
  if (ticked.length > 0) out.push(step("vqTick", ticked));
  if (unticked.length > 0) out.push(step("vqUntick", unticked));

  const prevJoins = new Set(prev.joins.map((j) => j.id));
  for (const j of next.joins) {
    if (prevJoins.has(j.id)) continue;
    out.push(step("vqJoin", [tableName(j.left), tableName(j.right)].filter((n): n is string => n !== null)));
  }

  // A filter row added, or its column changed, matched by its table and column (never its place in the list, so
  // removing a row is no step); its operator and values are never read.
  const had = new Map<string, number>();
  for (const f of prev.filters) had.set(key(f), (had.get(key(f)) ?? 0) + 1);
  const filtered: string[] = [];
  let unmatched = 0;
  for (const f of next.filters) {
    const n = had.get(key(f)) ?? 0;
    if (n > 0) {
      had.set(key(f), n - 1);
      continue;
    }
    unmatched += 1;
    if (f.column !== "") filtered.push(col(f.table, f.column));
  }
  const newRow = unmatched > filtered.length && next.filters.length > prev.filters.length;
  if (filtered.length > 0 || newRow) out.push(step("vqFilter", filtered));

  const sortKey = (m: VisualQuery) => JSON.stringify(m.orderBy.map((s) => [s.target, s.dir]));
  // Taking every sort away says nothing the Core has a verb for: no step.
  const first = next.orderBy[0];
  if (first && sortKey(prev) !== sortKey(next)) {
    const by =
      first.target.kind === "column"
        ? col(first.target.table, first.target.column)
        : (() => {
            const c = next.columns[first.target.index];
            return c ? col(c.table, c.column) : null;
          })();
    out.push(step("vqSort", by ? [by] : [], first.dir === "desc" ? { descending: true } : {}));
  }
  return out;
}
