// UX step 8 (G8): following a Foreign Key. The keys come from the language schema the grid already loads (SqlFk,
// column lists, so a key may have several columns). A way out of a row opens another table filtered by the key: one
// row along a key the row holds (DataGrip F4), or the rows of another table that hold this row's key (Alt+F7).
import type { Cell, DialectKind, ObjectPath, SmEndpoint, SortSpec, SqlFk, SqlSchema } from "../api/types";
import type { RowFilter } from "./rowFilters";

/** One column of a key and the value it must have: a chip `id = 214`. */
export interface KeyFilter {
  column: string;
  value: string;
  /** The value came from a number cell: it is written as a number, so a SQLite column with no type still matches. */
  number?: boolean;
}

/** A way out of a row along one key. */
export interface KeyWay {
  /** `out`: to the row this row's key names; `in`: to the rows whose key names this row. */
  dir: "out" | "in";
  fk: SqlFk;
  /** The table it opens. */
  path: ObjectPath;
  /** One filter per key column of the opened table. */
  filters: KeyFilter[];
  /** Why it can't be followed ("currency is NULL"), or null when it can. */
  blocked: string | null;
}

/** A row count of a table that points here: capped at 1,000 (one page), skipped on a closed or slow Connection. */
export type RowCount =
  | { state: "counting" }
  | { state: "done"; rows: number; more: boolean }
  | { state: "timeout" }
  | { state: "skipped" };

/** The endpoint is this table: the same name, and the same schema where both have one (MySQL and SQLite have none). */
function isTable(e: SmEndpoint, t: ObjectPath): boolean {
  return e.table === t.name && (t.schema === null || e.schema === null || e.schema === t.schema);
}

/** The keys this table holds. */
function keysFrom(schema: SqlSchema, t: ObjectPath): SqlFk[] {
  return schema.fks.filter((k) => isTable(k.from, t));
}

/** The keys of other tables (or of this one) that point to this table. */
function keysTo(schema: SqlSchema, t: ObjectPath): SqlFk[] {
  return schema.fks.filter((k) => isTable(k.to, t));
}

/**
 * The table an endpoint names, as the app's tabs name it. MySQL's Core puts the database name in an endpoint's schema
 * and SQLite's puts `main`, but their tabs have no schema (as QueryTab opens tables): a tab with none keeps none, so an
 * open tab of the table is found and reused.
 */
const pathOf = (e: SmEndpoint, near: ObjectPath): ObjectPath => ({
  database: near.database,
  schema: near.schema === null ? null : (e.schema ?? near.schema),
  name: e.table,
});

export function isKeyColumn(schema: SqlSchema, t: ObjectPath, column: string): boolean {
  return keysFrom(schema, t).some((k) => k.from.columns.includes(column));
}

/** True when some key points to this table. */
export function hasWaysIn(schema: SqlSchema, t: ObjectPath): boolean {
  return keysTo(schema, t).length > 0;
}

/** A cell as a key value, or why it can't be one. */
function keyValue(cell: Cell | undefined): { value: string; number: boolean } | { why: string } {
  if (!cell || cell.t === "null") return { why: "NULL" };
  if (cell.t === "bytes") return { why: "binary" };
  if (cell.t === "text" && cell.truncated) return { why: "too long to follow" };
  return { value: cell.value, number: cell.t === "number" };
}

/**
 * Filters on `to` columns from `from` columns' values; `blocked` names the first part that can't be expressed. A key
 * is followed whole or not at all: a part left out would show the wrong rows.
 */
function filtersFor(fk: SqlFk, to: string[], from: string[], value: (column: string) => Cell | undefined) {
  const filters: KeyFilter[] = [];
  let blocked: string | null = null;
  const unnamed = fk.to.columns.includes("") ? fk.to.table : fk.from.columns.includes("") ? fk.from.table : null;
  if (unnamed !== null || to.length === 0 || to.length !== from.length) return { filters, blocked: `the key's column in ${unnamed ?? fk.to.table} is unknown` };
  to.forEach((column, i) => {
    const v = keyValue(value(from[i]));
    if ("why" in v) blocked ??= `${from[i]} is ${v.why}`;
    else filters.push({ column, value: v.value, ...(v.number && { number: true }) });
  });
  return { filters, blocked };
}

/** The keys the row holds, each to one row; with `column`, only the keys that column is part of. */
export function waysOut(schema: SqlSchema, t: ObjectPath, value: (column: string) => Cell | undefined, column?: string): KeyWay[] {
  return keysFrom(schema, t)
    .filter((k) => column === undefined || k.from.columns.includes(column))
    .map((fk) => ({ dir: "out", fk, path: pathOf(fk.to, t), ...filtersFor(fk, fk.to.columns, fk.from.columns, value) }));
}

/** The keys that point to this table, each to the rows that hold this row's key. */
export function waysIn(schema: SqlSchema, t: ObjectPath, value: (column: string) => Cell | undefined): KeyWay[] {
  return keysTo(schema, t).map((fk) => ({ dir: "in", fk, path: pathOf(fk.from, t), ...filtersFor(fk, fk.from.columns, fk.to.columns, value) }));
}

/** `id = 214`, or `product_id = 5 AND currency = IDR`. */
export function keyText(filters: readonly KeyFilter[]): string {
  return filters.map((f) => `${f.column} = ${f.value}`).join(" AND ");
}

/** `customer_id → customers.id`, or `(product_id, currency) → product_prices(product_id, currency)`. */
export function fkText(fk: SqlFk): string {
  return fk.from.columns.length > 1
    ? `(${fk.from.columns.join(", ")}) → ${fk.to.table}(${fk.to.columns.join(", ")})`
    : `${fk.from.columns[0]} → ${fk.to.table}.${fk.to.columns[0]}`;
}

let seq = 0;
/** The key as the filter bar's chips: one "is" filter per column. */
export function rowFiltersOf(filters: readonly KeyFilter[]): RowFilter[] {
  return filters.map((f) => ({ id: `key${++seq}`, column: f.column, op: "eq", value: f.value, key: f.number ? "number" : true }));
}

/** The chips of a filter bar as key text, for "its filter X was replaced"; null for none. */
export function filtersText(filters: readonly RowFilter[]): string | null {
  if (filters.length === 0) return null;
  return filters.map((f) => `${f.column}${f.op === "eq" ? ` = ${f.value}` : ` ${f.op} ${f.value}`.trimEnd()}`).join(" AND ");
}

const rowsText = (n: number, more: boolean) => `${n.toLocaleString("en-US")}${more ? "+" : ""} ${n === 1 && !more ? "row" : "rows"}`;
const replacedText = (replaced?: string | null) => (replaced ? ` Its filter ${replaced} was replaced.` : "");

export const nullNote = (column: string, table: string) => `${column} is NULL: there is no ${table} row to go to.`;

export const danglingNote = (table: string, filters: readonly KeyFilter[]) =>
  `No ${table} row has ${keyText(filters)}: the database does not enforce this key.`;

/** What the opened tab says after F4: where it came from, and how to go back. */
export const outNote = (fromTable: string, fromRow: number, replaced?: string | null, backKey = "Alt+Left") =>
  `Opened from ${fromTable}, row ${fromRow.toLocaleString("en-US")}.${replacedText(replaced)} ${backKey} goes back.`;

/** What the opened tab says after Rows that point here: how many rows point to which row. */
export function inNote(
  count: { rows: number; more: boolean },
  table: string,
  toTable: string,
  toKey: readonly KeyFilter[],
  replaced?: string | null,
  backKey = "Alt+Left",
): string {
  const verb = count.rows === 1 && !count.more ? "points" : "point";
  return `${rowsText(count.rows, count.more)} of ${table} ${verb} to ${toTable} ${keyText(toKey)}.${replacedText(replaced)} ${backKey} goes back.`;
}

/** "Back on orders.customer_id of row 3, filter id = 214." */
export function backNote(lead: "Back on" | "Forward to", table: string, column: string, row: number, filter: string | null): string {
  return `${lead} ${table}.${column} of row ${row.toLocaleString("en-US")}${filter ? `, filter ${filter}` : ""}.`;
}

export function countText(c: RowCount): string {
  switch (c.state) {
    case "counting":
      return "counting";
    case "done":
      return c.rows === 0 && !c.more ? "none" : rowsText(c.rows, c.more);
    case "timeout":
      return "not counted, slow";
    case "skipped":
      return "not counted";
  }
}

/** What the grid asks its owner when a key is followed: open `way.path` filtered by `way.filters`. */
export interface FollowRequest {
  way: KeyWay;
  /** The key as the opened tab's chips, and the WHERE they make with the columns' types. */
  filters: RowFilter[];
  where: string | null;
  /** The row it was followed from: its table and number, and for rows that point here the row's own key. */
  from: { table: string; row: number; key: KeyFilter[] };
}

/** A request to a table grid to show a filter and a cell: a followed key, Back or Forward. */
export interface GridJump {
  /** A new number for each request; the same request is acted on once. */
  seq: number;
  filters: RowFilter[];
  /** The WHERE `filters` make, as the grid that asked worked it out with the columns' types. */
  where: string | null;
  page: number;
  /** Back and Forward: the sort the tab had; left out, the tab keeps its own. */
  sort?: SortSpec | null;
  /**
   * The cell to select once the rows are in: the whole row for a followed key (DataGrip). `key` (Back and Forward)
   * finds the row by its primary key wherever it is now; null is a table with no key, found by its position.
   */
  select: { row: number; column: string; wholeRow: boolean; key?: string | null } | null;
  /**
   * M3, set by the grid: the server was asked where the row is. `moved`: on the page this request names; `missing`: no
   * row has the key; `unknown`: it could not say; `unsupported`: the server can't look a row up (MySQL 5.7), so the row
   * keeps its old place.
   */
  located?: "moved" | "missing" | "unknown" | "unsupported";
  say:
    | { kind: "out"; fromTable: string; fromRow: number }
    | { kind: "in"; toTable: string; toKey: KeyFilter[] }
    | { kind: "back" }
    | { kind: "forward" }
    /** Only a note, such as "Nothing to go back to."; the filters and cell stay. */
    | { kind: "none"; text: string };
}

/** The "is" filters as key filters, for the note of a key that points nowhere. */
export function keyFiltersOf(filters: readonly RowFilter[]): KeyFilter[] {
  return filters.filter((f) => f.op === "eq").map((f) => ({ column: f.column, value: f.value, ...(f.key === "number" && { number: true }) }));
}

/** ASCII letters to lower case and nothing else, as SQLite folds names: `Ärzte` stays apart from `ärzte`. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Only the keys from or to one table, so a grid works over a few keys, not the whole database's. SQLite matches a
 * table name without case (`REFERENCES Customers` is `customers`): there an end naming this table takes the tab's own
 * name, so every match after this one is exact.
 */
export function keysOfTable(schema: SqlSchema, t: ObjectPath, dialect?: DialectKind): SqlSchema {
  const loose = dialect === "sqlite";
  const here = (e: SmEndpoint) => isTable(e, t) || (loose && isTable({ ...e, table: asciiLower(e.table) }, { ...t, name: asciiLower(t.name) }));
  const named = (e: SmEndpoint) => (here(e) ? { ...e, table: t.name } : e);
  // A schema without a key list (a test's, or a partial read) has no keys.
  const fks = (schema.fks ?? []).filter((k) => here(k.from) || here(k.to));
  return { ...schema, fks: loose ? fks.map((k) => ({ ...k, from: named(k.from), to: named(k.to) })) : fks };
}
