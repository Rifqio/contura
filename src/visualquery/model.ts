// The Visual Query model's pure operations. Every function returns a new
// model and never changes its input; the Core writes the SQL from the result.
import type {
  Aggregate,
  ColumnPair,
  ColumnRef,
  ColumnTypes,
  DialectKind,
  FkChoice,
  GroupBy,
  JoinKind,
  SmEndpoint,
  SqlFk,
  SqlSchema,
  SqlTable,
  VisualQuery,
  VqFilter,
  VqJoin,
  VqSort,
  VqTable,
} from "../api/types";
import { isReservedAnywhere } from "./reserved";

/** The tables and Foreign Keys a Visual Query tab can use, in the model's addressing (D6). */
export interface VqSchema {
  tables: SqlTable[];
  fks: SqlFk[];
  /** True while the tab's database schema has not arrived; every card not found reads as loading then. */
  loading: boolean;
  /**
   * Other databases (MySQL) or attached scopes (SQLite) still loading, by the
   * name a card carries in `VqTable.schema`. A card in one of them reads
   * "Loading schema", never missing.
   */
  loadingDatabases: string[];
}

/** Makes a fresh table or Join id; tests pass a counter. */
export type NewId = () => string;

const uuid: NewId = () => crypto.randomUUID();

// Schema ---------------------------------------------------------------------

/**
 * One schema for the tab. MySQL and SQLite: tables of the tab's database get
 * `schema: null`, every other database or attached scope is named by its key,
 * and Foreign Key endpoints are rewritten the same way so keys still match.
 * PostgreSQL: schemas stay as they are, and only the tab's database is read
 * (a query cannot cross PostgreSQL databases; with no tab database, the first).
 * `loadingDatabases` names the other databases the caller has asked for and
 * not received yet; those already in `byDatabase` are dropped from it.
 */
export function mergeSchemas(
  dialect: DialectKind,
  tabDatabase: string | null,
  byDatabase: Map<string, SqlSchema>,
  loadingDatabases: string[] = [],
): VqSchema {
  const loading = tabDatabase !== null && !byDatabase.has(tabDatabase);
  const keys = [...byDatabase.keys()];
  const ordered = tabDatabase !== null && byDatabase.has(tabDatabase) ? [tabDatabase, ...keys.filter((k) => k !== tabDatabase)] : keys;
  const tables: SqlTable[] = [];
  const fks: SqlFk[] = [];
  const stillLoading =
    dialect === "postgres" ? [] : [...new Set(loadingDatabases)].filter((d) => d !== tabDatabase && !byDatabase.has(d));
  if (dialect === "postgres") {
    for (const key of tabDatabase === null ? ordered.slice(0, 1) : ordered.filter((k) => k === tabDatabase)) {
      const s = byDatabase.get(key)!;
      tables.push(...s.tables);
      fks.push(...s.fks);
    }
    return { tables, fks, loading, loadingDatabases: stillLoading };
  }
  for (const key of ordered) {
    const s = byDatabase.get(key)!;
    const scope = key === tabDatabase ? null : key;
    const end = (e: SmEndpoint): SmEndpoint => ({ ...e, schema: scope });
    for (const t of s.tables) tables.push({ ...t, schema: scope });
    for (const f of s.fks) fks.push({ ...f, from: end(f.from), to: end(f.to) });
  }
  return { tables, fks, loading, loadingDatabases: stillLoading };
}

/** A card the schema has not arrived for: not found while the tab's database or the card's own database is loading. */
function isLoading(schema: VqSchema, t: VqTable): boolean {
  if (findTable(schema, t)) return false;
  return schema.loading || (t.schema !== null && schema.loadingDatabases.includes(t.schema));
}

/** Ids of the cards whose schema is still loading ("Loading schema"); they are never reported missing. */
export function loadingTables(q: VisualQuery, schema: VqSchema): string[] {
  return q.tables.filter((t) => isLoading(schema, t)).map((t) => t.id);
}

function findTable(schema: VqSchema, t: { schema: string | null; name: string }): SqlTable | undefined {
  return schema.tables.find((s) => (s.schema ?? null) === (t.schema ?? null) && s.name === t.name);
}

function endpointIs(e: SmEndpoint, t: VqTable): boolean {
  return (e.schema ?? null) === (t.schema ?? null) && e.table === t.name;
}

// Model basics -----------------------------------------------------------------

export function emptyQuery(database: string | null, dialect: DialectKind): VisualQuery {
  return {
    version: 1,
    database,
    dialect,
    tables: [],
    joins: [],
    columns: [],
    filters: [],
    groupBy: { kind: "auto" },
    orderBy: [],
    limit: null,
    distinct: false,
  };
}

/**
 * The initials of the name's words (split at `_`, spaces and lower-to-upper
 * case changes), lower case, then `2`, `3`... while the alias is taken or is a
 * reserved word in any Dialect. `taken` is compared without regard to case.
 * Words that do not start with an ASCII letter give no initial, so the alias
 * stays bare in every Dialect; with none left the alias is `t`.
 */
export function aliasFor(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1 $2")
    .split(/[_\s]+/)
    .filter((w) => /^[A-Za-z]/.test(w));
  const base = words.map((w) => w[0].toLowerCase()).join("") || "t";
  const used = new Set([...taken].map((a) => a.toLowerCase()));
  const free = (a: string) => !used.has(a) && !isReservedAnywhere(a);
  if (free(base)) return base;
  for (let n = 2; ; n++) if (free(`${base}${n}`)) return `${base}${n}`;
}

function aliases(q: VisualQuery): Set<string> {
  return new Set(q.tables.map((t) => t.alias));
}

function pairsFor(key: SqlFk, left: VqTable, right: VqTable): ColumnPair[] {
  // Orient the key's columns to the Join: leftColumn belongs to `left`.
  const fromIsLeft = endpointIs(key.from, left) && endpointIs(key.to, right);
  const [l, r] = fromIsLeft ? [key.from.columns, key.to.columns] : [key.to.columns, key.from.columns];
  return l.map((leftColumn, i) => ({ leftColumn, rightColumn: r[i] }));
}

function keysBetween(schema: VqSchema, a: VqTable, b: VqTable): SqlFk[] {
  return schema.fks.filter(
    (k) => (endpointIs(k.from, a) && endpointIs(k.to, b)) || (endpointIs(k.from, b) && endpointIs(k.to, a)),
  );
}

/**
 * Adds a card. A table on the canvas that it has exactly one Foreign Key with
 * (either direction) gets an Inner Join on that key's pairs; two or more keys
 * give one Join waiting for a pick (`pending`, `on: []`); none gives no Join.
 * `joinedTo` names the tables joined (for the toast); `pick` is the first
 * pending Join's id.
 */
export function addTable(
  q: VisualQuery,
  t: { schema: string | null; name: string },
  schema: VqSchema,
  at: { x: number; y: number },
  ids: NewId = uuid,
): { query: VisualQuery; joinedTo: string[]; pick: string | null } {
  const card: VqTable = { id: ids(), schema: t.schema, name: t.name, alias: aliasFor(t.name, aliases(q)), x: at.x, y: at.y };
  const joins: VqJoin[] = [];
  const joinedTo: string[] = [];
  let pick: string | null = null;
  for (const other of q.tables) {
    const keys = keysBetween(schema, other, card);
    if (keys.length === 0) continue;
    if (keys.length === 1) {
      joins.push({ id: ids(), left: other.id, right: card.id, kind: "inner", on: pairsFor(keys[0], other, card) });
      if (!joinedTo.includes(other.name)) joinedTo.push(other.name);
    } else {
      const pending: FkChoice[] = keys.map((k) => ({
        // Named by the referencing columns: "store_id", "pickup_store_id".
        name: k.from.columns.join(", "),
        on: pairsFor(k, other, card),
        comment: k.comment ?? null,
      }));
      const id = ids();
      joins.push({ id, left: other.id, right: card.id, kind: "inner", on: [], pending });
      pick ??= id;
    }
  }
  return { query: { ...q, tables: [...q.tables, card], joins: [...q.joins, ...joins] }, joinedTo, pick };
}

function settled(j: VqJoin, on: ColumnPair[]): VqJoin {
  const { pending: _pending, ...rest } = j;
  return { ...rest, on };
}

function mapJoin(q: VisualQuery, joinId: string, f: (j: VqJoin) => VqJoin | null): VisualQuery {
  if (!q.joins.some((j) => j.id === joinId)) return q;
  const joins: VqJoin[] = [];
  let changed = false;
  for (const j of q.joins) {
    const next = j.id === joinId ? f(j) : j;
    if (next !== j) changed = true;
    if (next) joins.push(next);
  }
  return changed ? { ...q, joins } : q;
}

/**
 * Settles a pending Join on one of its keys. "both" takes the first key and
 * adds the Join's right table again (new alias, below the first card) with
 * its own Inner Join on the second key. A Join with `pending: []` has
 * nothing to pick and is returned unchanged: it is settled by
 * `connectColumns` (a drop clears `pending`) or taken out with `removeJoin`.
 * `swapSides` leaves pending Joins alone, so the right side is always the
 * card that was added last.
 */
export function pickForeignKey(
  q: VisualQuery,
  joinId: string,
  choice: number | "both",
  _schema: VqSchema,
  ids: NewId = uuid,
): VisualQuery {
  const join = q.joins.find((j) => j.id === joinId);
  const choices = join?.pending;
  if (!join || !choices || choices.length === 0) return q;
  if (choice !== "both") {
    const c = choices[choice];
    return c ? mapJoin(q, joinId, (j) => settled(j, c.on)) : q;
  }
  const first = mapJoin(q, joinId, (j) => settled(j, choices[0].on));
  const second = choices[1];
  const right = q.tables.find((t) => t.id === join.right);
  if (!second || !right) return first;
  const copy: VqTable = { ...right, id: ids(), alias: aliasFor(right.name, aliases(q)), y: right.y + 200 };
  const extra: VqJoin = { id: ids(), left: join.left, right: copy.id, kind: "inner", on: second.on };
  return { ...first, tables: [...first.tables, copy], joins: [...first.joins, extra] };
}

/**
 * A column dropped on another card's column (decision 3). An existing Join
 * between the two cards gets its condition replaced, or with Shift the pair
 * appended; otherwise a new Inner Join is made. Never reads the database.
 */
export function connectColumns(q: VisualQuery, from: ColumnRef, to: ColumnRef, shift: boolean, ids: NewId = uuid): VisualQuery {
  if (from.table === to.table) return q;
  const join = q.joins.find((j) => (j.left === from.table && j.right === to.table) || (j.left === to.table && j.right === from.table));
  if (!join) {
    const created: VqJoin = { id: ids(), left: from.table, right: to.table, kind: "inner", on: [{ leftColumn: from.column, rightColumn: to.column }] };
    return { ...q, joins: [...q.joins, created] };
  }
  const pair: ColumnPair =
    join.left === from.table ? { leftColumn: from.column, rightColumn: to.column } : { leftColumn: to.column, rightColumn: from.column };
  return mapJoin(q, join.id, (j) => {
    if (!shift) return settled(j, [pair]);
    const exists = j.on.some((p) => p.leftColumn === pair.leftColumn && p.rightColumn === pair.rightColumn);
    return settled(j, exists ? j.on : [...j.on, pair]);
  });
}

export function setJoinKind(q: VisualQuery, joinId: string, kind: JoinKind): VisualQuery {
  return mapJoin(q, joinId, (j) => ({ ...j, kind }));
}

/** Removes one condition; removing the last one removes the Join, which leaves a CROSS JOIN card. */
export function removeCondition(q: VisualQuery, joinId: string, index: number): VisualQuery {
  return mapJoin(q, joinId, (j) => {
    if (index < 0 || index >= j.on.length) return j;
    const on = j.on.filter((_, i) => i !== index);
    return on.length === 0 ? null : { ...j, on };
  });
}

const flip = (p: ColumnPair): ColumnPair => ({ leftColumn: p.rightColumn, rightColumn: p.leftColumn });
const FLIPPED: Record<JoinKind, JoinKind> = { inner: "inner", left: "right", right: "left", full: "full" };

/**
 * Swaps the Join's sides; Left becomes Right and back, so the meaning holds.
 * A pending Join is left as it is until a key is picked, so "Both" still
 * copies the card that was added (`pickForeignKey`).
 */
export function swapSides(q: VisualQuery, joinId: string): VisualQuery {
  return mapJoin(q, joinId, (j) =>
    j.pending != null ? j : { ...j, left: j.right, right: j.left, kind: FLIPPED[j.kind], on: j.on.map(flip) },
  );
}

export function removeJoin(q: VisualQuery, joinId: string): VisualQuery {
  return mapJoin(q, joinId, () => null);
}

// Tables -------------------------------------------------------------------------

/**
 * Removes a card with its Joins, output columns, filters and sorts, and its
 * entries in a GROUP BY by hand. The next table becomes the root when the
 * root goes; tables cut off become CROSS JOIN cards.
 */
export function removeTable(q: VisualQuery, tableId: string): VisualQuery {
  if (!q.tables.some((t) => t.id === tableId)) return q;
  const dropped = q.columns.flatMap((c, i) => (c.table === tableId ? [i] : []));
  const next = dropOutputs(q, dropped);
  return {
    ...next,
    tables: next.tables.filter((t) => t.id !== tableId),
    joins: next.joins.filter((j) => j.left !== tableId && j.right !== tableId),
    filters: next.filters.filter((f) => f.table !== tableId),
    orderBy: next.orderBy.filter((s) => s.target.kind !== "column" || s.target.table !== tableId),
    groupBy: withoutGroupColumns(next.groupBy, (c) => c.table === tableId),
  };
}

/** "Start FROM here": the table becomes `tables[0]`, the root of FROM. */
export function setRoot(q: VisualQuery, tableId: string): VisualQuery {
  const t = q.tables.find((x) => x.id === tableId);
  if (!t || q.tables[0] === t) return q;
  return { ...q, tables: [t, ...q.tables.filter((x) => x !== t)] };
}

/** Renames a card's alias; an empty alias or one another card has (any case) changes nothing. */
export function setAlias(q: VisualQuery, tableId: string, alias: string): VisualQuery {
  const a = alias.trim();
  // A NUL cannot be written in any Dialect; the Core would refuse it.
  if (!a || a.includes("\0") || q.tables.some((t) => t.id !== tableId && t.alias.toLowerCase() === a.toLowerCase())) return q;
  if (!q.tables.some((t) => t.id === tableId)) return q;
  return { ...q, tables: q.tables.map((t) => (t.id === tableId ? { ...t, alias: a } : t)) };
}

export function moveTable(q: VisualQuery, tableId: string, at: { x: number; y: number }): VisualQuery {
  if (!q.tables.some((t) => t.id === tableId)) return q;
  return { ...q, tables: q.tables.map((t) => (t.id === tableId ? { ...t, x: at.x, y: at.y } : t)) };
}

// Output columns -------------------------------------------------------------------

function withoutGroupColumns(g: GroupBy, drop: (c: ColumnRef) => boolean): GroupBy {
  return g.kind === "manual" ? { kind: "manual", columns: g.columns.filter((c) => !drop(c)) } : g;
}

/** Removes the outputs at `indexes`, dropping their output sorts and renumbering the others. */
function dropOutputs(q: VisualQuery, indexes: number[]): VisualQuery {
  if (indexes.length === 0) return q;
  const gone = new Set(indexes);
  const orderBy: VqSort[] = [];
  for (const s of q.orderBy) {
    if (s.target.kind !== "output") {
      orderBy.push(s);
      continue;
    }
    const index = s.target.index;
    if (gone.has(index)) continue;
    const shift = indexes.filter((i) => i < index).length;
    orderBy.push({ ...s, target: { kind: "output", index: index - shift } });
  }
  return { ...q, columns: q.columns.filter((_, i) => !gone.has(i)), orderBy };
}

/**
 * Ticks a column (appended to the output) or unticks it: every output of that
 * column goes, with its sorts (output and column); the remaining output sorts
 * are renumbered. A GROUP BY by hand is the user's own list and keeps the
 * column: grouping by a column that is not shown is valid, and dropping it
 * would change the rows.
 */
export function toggleColumn(q: VisualQuery, tableId: string, column: string): VisualQuery {
  const at = q.columns.flatMap((c, i) => (c.table === tableId && c.column === column ? [i] : []));
  if (at.length === 0) {
    return { ...q, columns: [...q.columns, { table: tableId, column, alias: null, aggregate: null }] };
  }
  const next = dropOutputs(q, at);
  return {
    ...next,
    orderBy: next.orderBy.filter((s) => s.target.kind !== "column" || s.target.table !== tableId || s.target.column !== column),
  };
}

/** Ticks every column of a card not ticked yet, in the card's order, after the outputs there are. */
export function tickAll(q: VisualQuery, tableId: string, columns: readonly string[]): VisualQuery {
  const on = new Set(q.columns.filter((c) => c.table === tableId).map((c) => c.column));
  const add = columns.filter((c) => !on.has(c)).map((column) => ({ table: tableId, column, alias: null, aggregate: null }));
  return add.length === 0 ? q : { ...q, columns: [...q.columns, ...add] };
}

/** Unticks every column of a card: its outputs go with their sorts, as `toggleColumn` drops one. */
export function untickAll(q: VisualQuery, tableId: string): VisualQuery {
  const at = q.columns.flatMap((c, i) => (c.table === tableId ? [i] : []));
  if (at.length === 0) return q;
  const next = dropOutputs(q, at);
  return { ...next, orderBy: next.orderBy.filter((s) => s.target.kind !== "column" || s.target.table !== tableId) };
}

/** Moves an output from one position to another; output sorts follow their column. */
export function moveOutput(q: VisualQuery, from: number, to: number): VisualQuery {
  const n = q.columns.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return q;
  const order = q.columns.map((_, i) => i);
  order.splice(to, 0, ...order.splice(from, 1));
  // order[newIndex] = oldIndex
  const newIndex = new Map(order.map((old, i) => [old, i]));
  return {
    ...q,
    columns: order.map((i) => q.columns[i]),
    orderBy: q.orderBy.map((s) => (s.target.kind === "output" ? { ...s, target: { kind: "output", index: newIndex.get(s.target.index) ?? s.target.index } } : s)),
  };
}

function mapColumn(q: VisualQuery, index: number, patch: Partial<VisualQuery["columns"][number]>): VisualQuery {
  if (index < 0 || index >= q.columns.length) return q;
  return { ...q, columns: q.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) };
}

export function setAggregate(q: VisualQuery, index: number, a: Aggregate | null): VisualQuery {
  return mapColumn(q, index, { aggregate: a });
}

/** Sets the output name; null or blank goes back to the Core's default name. */
export function setOutputName(q: VisualQuery, index: number, name: string | null): VisualQuery {
  const alias = name === null || name.trim() === "" ? null : name.trim();
  return mapColumn(q, index, { alias });
}

export function setGroupBy(q: VisualQuery, g: GroupBy): VisualQuery {
  return { ...q, groupBy: g.kind === "manual" ? { kind: "manual", columns: [...g.columns] } : { kind: "auto" } };
}

// Filters, sorts, limit, distinct ---------------------------------------------------

/**
 * Appends a filter row. With no argument: an AND row on the root card with
 * no column picked, which the Core reports as "Pick a column for filter n."
 */
export function addFilter(q: VisualQuery, filter: Partial<VqFilter> = {}): VisualQuery {
  const row: VqFilter = { joiner: "and", table: q.tables[0]?.id ?? "", column: "", op: "eq", values: [], ...filter };
  return { ...q, filters: [...q.filters, row] };
}

export function editFilter(q: VisualQuery, index: number, patch: Partial<VqFilter>): VisualQuery {
  if (index < 0 || index >= q.filters.length) return q;
  return { ...q, filters: q.filters.map((f, i) => (i === index ? { ...f, ...patch } : f)) };
}

export function removeFilter(q: VisualQuery, index: number): VisualQuery {
  if (index < 0 || index >= q.filters.length) return q;
  return { ...q, filters: q.filters.filter((_, i) => i !== index) };
}

function sameTarget(a: VqSort["target"], b: VqSort["target"]): boolean {
  if (a.kind === "output" && b.kind === "output") return a.index === b.index;
  if (a.kind === "column" && b.kind === "column") return a.table === b.table && a.column === b.column;
  return false;
}

/** Appends a sort; a target already sorted keeps its place and takes the new direction. */
export function addSort(q: VisualQuery, sort: VqSort): VisualQuery {
  const at = q.orderBy.findIndex((s) => sameTarget(s.target, sort.target));
  if (at >= 0) return editSort(q, at, { dir: sort.dir });
  return { ...q, orderBy: [...q.orderBy, sort] };
}

export function editSort(q: VisualQuery, index: number, patch: Partial<VqSort>): VisualQuery {
  if (index < 0 || index >= q.orderBy.length) return q;
  return { ...q, orderBy: q.orderBy.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}

export function removeSort(q: VisualQuery, index: number): VisualQuery {
  if (index < 0 || index >= q.orderBy.length) return q;
  return { ...q, orderBy: q.orderBy.filter((_, i) => i !== index) };
}

/** A whole number from 0 up (a fraction is cut), or null for all rows; anything else is null. */
export function setLimit(q: VisualQuery, limit: number | null): VisualQuery {
  const value = limit === null || !Number.isFinite(limit) || limit < 0 ? null : Math.floor(limit);
  return { ...q, limit: value };
}

export function setDistinct(q: VisualQuery, distinct: boolean): VisualQuery {
  return { ...q, distinct };
}

// Reading the model -------------------------------------------------------------------

/** A Join the Core writes: settled, with ON pairs (plan.rs `active`). */
const isActive = (j: VqJoin) => j.pending == null && j.on.length > 0;
/** A Join that waits for a key pick; `pending: []` counts, as in the Core. */
const isPending = (j: VqJoin) => j.pending != null;
/** What links tables into one group (plan.rs): active or pending Joins. A settled Join with no pairs links nothing. */
const links = (j: VqJoin) => isActive(j) || isPending(j);

/** Table id to its first index; a repeated id keeps the first, as the Core does. */
function tableIndex(q: VisualQuery): Map<string, number> {
  const index = new Map<string, number>();
  q.tables.forEach((t, i) => {
    if (!index.has(t.id)) index.set(t.id, i);
  });
  return index;
}

/** Table indexes reachable from `start` through the Joins `use` accepts. */
function reach(q: VisualQuery, start: number, use: (j: VqJoin) => boolean): Set<number> {
  const index = tableIndex(q);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const t = queue.shift()!;
    for (const j of q.joins) {
      if (!use(j)) continue;
      const l = index.get(j.left);
      const r = index.get(j.right);
      if (l === undefined || r === undefined) continue;
      for (const [a, b] of [
        [l, r],
        [r, l],
      ]) {
        if (a === t && !seen.has(b)) {
          seen.add(b);
          queue.push(b);
        }
      }
    }
  }
  return seen;
}

/**
 * The groups of the Core's plan: tables linked by active or pending Joins,
 * each led by its first table, the root's group first. `kept` is what the
 * Core writes (reachable through active Joins); the rest waits for a pick.
 */
function groups(q: VisualQuery): { all: Set<number>; kept: Set<number> }[] {
  const out: { all: Set<number>; kept: Set<number> }[] = [];
  const grouped = new Set<number>();
  const index = tableIndex(q);
  for (let start = 0; start < q.tables.length; start++) {
    if (grouped.has(start) || index.get(q.tables[start].id) !== start) continue;
    const all = reach(q, start, links);
    for (const i of all) grouped.add(i);
    out.push({ all, kept: reach(q, start, isActive) });
  }
  return out;
}

const idsAt = (q: VisualQuery, at: Set<number>) => q.tables.filter((_, i) => at.has(i)).map((t) => t.id);

/**
 * Tables the Core adds with CROSS JOIN: not linked to the root by an active
 * or pending Join, and not left out behind a pending one. In table order.
 */
export function crossTables(q: VisualQuery): string[] {
  const out = new Set<number>();
  groups(q)
    .slice(1)
    .forEach((g) => g.kept.forEach((i) => out.add(i)));
  return idsAt(q, out);
}

/**
 * The CROSS JOIN groups, each in table order, its first id the table the
 * Core writes `CROSS JOIN` for (and warns about). A one-table group is a
 * lone card ("No Join. Runs as a CROSS JOIN."); a larger group has Joins.
 */
export function crossGroups(q: VisualQuery): string[][] {
  return groups(q)
    .slice(1)
    .map((g) => idsAt(q, g.kept));
}

/** Tables the Core leaves out until a Foreign Key is picked: behind a pending Join, or reachable only through one. */
export function pendingTables(q: VisualQuery): string[] {
  const out = new Set<number>();
  for (const g of groups(q)) for (const i of g.all) if (!g.kept.has(i)) out.add(i);
  return idsAt(q, out);
}

/**
 * The Auto GROUP BY: with any aggregate, each output without one, in output
 * order, once each. Outputs of tables left out behind a pending pick are not
 * written, so they neither count as aggregates nor group.
 */
export function autoGroupBy(q: VisualQuery): ColumnRef[] {
  const leftOut = new Set(pendingTables(q));
  const written = q.columns.filter((c) => !leftOut.has(c.table));
  if (!written.some((c) => c.aggregate !== null)) return [];
  const out: ColumnRef[] = [];
  for (const c of written) {
    if (c.aggregate !== null || out.some((o) => o.table === c.table && o.column === c.column)) continue;
    out.push({ table: c.table, column: c.column });
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The toolbar's count line: "No tables", "1 table", "3 tables, 2 Joins",
 * "3 tables, 1 Join, 1 to pick". Joins are the ones the Core writes; a
 * settled Join with no pairs counts as neither.
 */
export function countLine(q: VisualQuery): string {
  if (q.tables.length === 0) return "No tables";
  const parts = [plural(q.tables.length, "table", "tables")];
  const toPick = q.joins.filter(isPending).length;
  const joins = q.joins.filter(isActive).length;
  if (joins > 0) parts.push(plural(joins, "Join", "Joins"));
  if (toPick > 0) parts.push(`${toPick} to pick`);
  return parts.join(", ");
}

/**
 * Tables and columns the model names that the schema does not have (renamed
 * or dropped since saving). Columns are only checked on tables that exist.
 * Nothing is reported while the tab's database is loading, and a card whose
 * own database is still loading (`loadingTables`) is never missing, so Run
 * stays on (Review Focus 4).
 */
export function missing(q: VisualQuery, schema: VqSchema): { tables: string[]; columns: ColumnRef[] } {
  if (schema.loading) return { tables: [], columns: [] };
  const found = new Map<string, Set<string>>();
  const tables: string[] = [];
  for (const t of q.tables) {
    const s = findTable(schema, t);
    if (s) found.set(t.id, new Set(s.columns.map((c) => c.name)));
    else if (!isLoading(schema, t)) tables.push(t.id);
  }
  const columns: ColumnRef[] = [];
  const check = (table: string, column: string) => {
    const cols = found.get(table);
    if (!cols || !column || cols.has(column)) return;
    if (!columns.some((c) => c.table === table && c.column === column)) columns.push({ table, column });
  };
  for (const c of q.columns) check(c.table, c.column);
  for (const j of q.joins) {
    for (const p of j.on) {
      check(j.left, p.leftColumn);
      check(j.right, p.rightColumn);
    }
  }
  for (const f of q.filters) check(f.table, f.column);
  for (const s of q.orderBy) if (s.target.kind === "column") check(s.target.table, s.target.column);
  if (q.groupBy.kind === "manual") for (const c of q.groupBy.columns) check(c.table, c.column);
  return { tables, columns };
}

/** Table id to column name to type text, for the tables the schema has. */
export function columnTypes(q: VisualQuery, schema: VqSchema): ColumnTypes {
  const out: ColumnTypes = {};
  for (const t of q.tables) {
    const s = findTable(schema, t);
    if (s) out[t.id] = Object.fromEntries(s.columns.map((c) => [c.name, c.typeName]));
  }
  return out;
}

/** The type without its size or other modifiers, lower case: `varchar(8)` and `VARCHAR(80)` match. */
export function baseType(type: string | undefined): string {
  return (type ?? "").toLowerCase().replace(/\(.*$/, "").trim();
}

/** Columns of the other cards a column can join to: the same type first, then in card and column order. */
export function joinCandidates(q: VisualQuery, from: ColumnRef, schema: VqSchema): ColumnRef[] {
  const types = columnTypes(q, schema);
  const want = baseType(types[from.table]?.[from.column]);
  const all: { ref: ColumnRef; same: boolean }[] = [];
  for (const t of q.tables) {
    if (t.id === from.table) continue;
    for (const [column, type] of Object.entries(types[t.id] ?? {})) {
      all.push({ ref: { table: t.id, column }, same: want !== "" && baseType(type) === want });
    }
  }
  return [...all.filter((c) => c.same), ...all.filter((c) => !c.same)].map((c) => c.ref);
}
