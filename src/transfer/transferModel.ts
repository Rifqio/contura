// The Data Transfer tab's state and texts (step 8), kept pure so the steps only render them.
import { DIALECT_LABEL } from "../api/client";
import type {
  ConnectionConfig,
  DialectKind,
  SmRef,
  TransferCopyKind,
  TransferIfExists,
  TransferRequest,
  TransferSetting,
  TransferSide,
} from "../api/types";
import { bytesText } from "../jobs/importModel";

/** One row of the Tables step, in load order. */
export interface TableRow {
  name: string;
  /** Views are listed, never copied. */
  view: boolean;
  /** The server's estimates; null when it gives none. */
  rows: number | null;
  bytes: number | null;
  /** The tables its Foreign Keys point at. */
  needs: string[];
  ticked: boolean;
  ifExists: TransferIfExists;
}

/** Everything the user has set up; the request is built from it on every call. */
export interface TransferState {
  source: TransferSide;
  target: TransferSide | null;
  tables: TableRow[];
  copy: TransferCopyKind;
  batchRows: number;
  compareCounts: boolean;
  overrides: TransferSetting[];
  choices: TransferSetting[];
  names: TransferSetting[];
}

export const DEFAULT_BATCH = 1000;
export const MIN_BATCH = 100;
export const MAX_BATCH = 5000;

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

export function emptyTransfer(source: TransferSide): TransferState {
  return {
    source,
    target: null,
    tables: [],
    copy: "both",
    batchRows: DEFAULT_BATCH,
    compareCounts: true,
    overrides: [],
    choices: [],
    names: [],
  };
}

/** "pos_live to analytics": source database to target database. */
export function tabTitle(source: string, target: string | null): string {
  return target ? `${source} to ${target}` : "Data Transfer";
}

export function sameSide(a: TransferSide, b: TransferSide): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && (a.schema ?? null) === (b.schema ?? null);
}

export const SAME_SIDE = "Source and target are the same. Pick another target.";

/** The second line of a target picker row. */
export function targetOptionHint(c: Pick<ConnectionConfig, "readOnly" | "production">): string | undefined {
  if (c.readOnly) return "Read-only: cannot be a target";
  if (c.production) return "Asks you to confirm the exact SQL before it runs";
  return undefined;
}

function server(dialect: DialectKind, version: string | null): string {
  return version ? `${DIALECT_LABEL[dialect]} ${version}` : DIALECT_LABEL[dialect];
}

/** "MySQL 8.0.30 · 9 tables, 1 view · 1.9 GB · reading only". */
export function sourceHint(s: { dialect: DialectKind; version: string | null; tables: number; views: number; bytes: number | null }): string {
  const objects = plural(s.tables, "table", "tables") + (s.views > 0 ? `, ${plural(s.views, "view", "views")}` : "");
  return [server(s.dialect, s.version), objects, ...(s.bytes ? [bytesText(s.bytes)] : []), "reading only"].join(" · ");
}

/** How the run treats the target, by its Dialect. */
export function runsLine(dialect: DialectKind): string {
  return dialect === "mysql" ? "tables are created one by one, rows per table" : "structure and rows run in one transaction";
}

/**
 * "PostgreSQL 17.0 · schema pos is empty · structure and rows run in one transaction". `tables` is
 * null when the schema or database does not exist yet.
 */
export function targetHint(t: { dialect: DialectKind; version: string | null; scope: string; tables: number | null }): string {
  const state =
    t.tables === null
      ? `${t.scope} does not exist yet and is created first`
      : t.tables === 0
        ? `${t.scope} is empty`
        : `${t.scope} has ${plural(t.tables, "table", "tables")}`;
  return [server(t.dialect, t.version), state, runsLine(t.dialect)].join(" · ");
}

/** Parents first, so Foreign Keys hold; tables in a cycle keep their given order. */
export function orderParentsFirst(names: string[], refs: SmRef[]): string[] {
  const has = new Set(names);
  const parents = new Map(names.map((t) => [t, new Set<string>()]));
  for (const r of refs) {
    if (r.from.table !== r.to.table && has.has(r.from.table) && has.has(r.to.table)) parents.get(r.from.table)!.add(r.to.table);
  }
  const out: string[] = [];
  const placed = new Set<string>();
  let left = [...names];
  while (left.length > 0) {
    const ready = left.filter((t) => [...parents.get(t)!].every((p) => placed.has(p)));
    // A cycle: the first table left goes next, as the model has it.
    const next = ready.length > 0 ? ready : [left[0]!];
    for (const t of next) {
      out.push(t);
      placed.add(t);
    }
    left = left.filter((t) => !placed.has(t));
  }
  return out;
}

/** The tables each table's Foreign Keys point at, without itself. */
export function needsOf(name: string, refs: SmRef[]): string[] {
  return [...new Set(refs.filter((r) => r.from.table === name && r.to.table !== name).map((r) => r.to.table))];
}

/** Moves the row at `index` by `delta`, kept inside the list. */
export function moveTable<T>(list: T[], index: number, delta: number): T[] {
  const to = Math.max(0, Math.min(list.length - 1, index + delta));
  if (to === index) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

/** "6 of 8 ticked": views are not counted. */
export function tickedLine(rows: TableRow[]): string {
  const tables = rows.filter((r) => !r.view);
  return `${n(tables.filter((r) => r.ticked).length)} of ${n(tables.length)} ticked`;
}

/** "This transfer: 6 tables, 6,508,267 rows. About 1.6 GB read from kestrel-pos." */
export function summaryLine(rows: TableRow[], sourceName: string): string {
  const ticked = rows.filter((r) => r.ticked && !r.view);
  const counted = ticked.every((r) => r.rows !== null);
  const total = ticked.reduce((s, r) => s + (r.rows ?? 0), 0);
  const bytes = ticked.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const tables = plural(ticked.length, "table", "tables");
  const head = counted && ticked.length > 0 ? `${tables}, ${plural(total, "row", "rows")}` : tables;
  return `This transfer: ${head}.` + (bytes > 0 ? ` About ${bytesText(bytes)} read from ${sourceName}.` : "");
}

/** "Needs stores, which is not ticked", for the first parent left out. */
export function needsNote(rows: TableRow[], row: TableRow): string | null {
  if (!row.ticked) return null;
  const missing = row.needs.find((p) => rows.some((r) => r.name === p && !r.ticked));
  return missing ? `Needs ${missing}, which is not ticked` : null;
}

/** The request every Core call takes; `createScope` when the target schema or database is new. */
export function buildRequest(s: TransferState, createScope: boolean): TransferRequest {
  const tables = s.tables.filter((t) => !t.view);
  return {
    source: s.source,
    target: s.target ?? { connectionId: "", database: "", schema: null },
    tables: tables.map((t) => ({ name: t.name, ticked: t.ticked, ifExists: t.ifExists })),
    order: tables.filter((t) => t.ticked).map((t) => t.name),
    copy: s.copy,
    batchRows: s.batchRows,
    overrides: s.overrides,
    choices: s.choices,
    names: s.names,
    compareCounts: s.compareCounts,
    createTargetScope: createScope,
  };
}

/** The heading comment a structure or after-rows statement is grouped under. */
function groupOf(sql: string, after: boolean): string {
  const s = sql.trimStart().toUpperCase();
  if (s.startsWith("PRAGMA")) return after ? "-- Check the Foreign Keys" : "-- Foreign Keys are checked after the rows";
  if (s.startsWith("CREATE SCHEMA") || s.startsWith("CREATE DATABASE")) return "-- The target scope";
  if (s.startsWith("CREATE TYPE")) return "-- Types";
  if (s.startsWith("CREATE TABLE")) return "-- Tables";
  if (s.startsWith("DELETE")) return "-- Empty it first";
  if (s.startsWith("CREATE") && s.includes("INDEX")) return "-- Indexes, after the rows";
  if (s.startsWith("ALTER TABLE")) return after ? "-- Foreign Keys, after the rows" : "-- Foreign Keys";
  if (s.startsWith("SELECT SETVAL")) return "-- Identity counters";
  return after ? "-- After the rows" : "-- Structure";
}

/** The structure and after-rows SQL exactly, each group under a heading comment. */
export function reviewSql(structure: string[], afterRows: string[]): string {
  const out: string[] = [];
  let last = "";
  const add = (sql: string, after: boolean) => {
    const head = groupOf(sql, after);
    if (head !== last) {
      if (out.length > 0) out.push("");
      out.push(head);
      last = head;
    }
    out.push(sql);
  };
  structure.forEach((s) => add(s, false));
  if (afterRows.length > 0) {
    out.push("", "-- The rows are copied here");
    last = "";
  }
  afterRows.forEach((s) => add(s, true));
  return out.join("\n");
}

/** "Empty it first deletes 2,316 rows in products and 412 rows in stores on pinecone-analytics." */
export function emptiedLine(emptied: { table: string; rows: number | null }[], target: string): string | null {
  if (emptied.length === 0) return null;
  const parts = emptied.map((e) => (e.rows === null ? `every row in ${e.table}` : `${plural(e.rows, "row", "rows")} in ${e.table}`));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Empty it first deletes ${list} on ${target}.`;
}

/** "sales: INSERT INTO pos.sales (id, store_id, ...) VALUES ... 1,284,339 rows in batches of 1,000". */
export function copyLine(copy: { source: string; insertHead: string; rowsHint: number | null }, batch: number): string {
  const rows = copy.rowsHint === null ? "" : ` ${plural(copy.rowsHint, "row", "rows")}`;
  return `${copy.source}: ${copy.insertHead} VALUES ...${rows} in batches of ${n(batch)}`;
}

const count = (list: string[], test: (s: string) => boolean) => list.filter((s) => test(s.trimStart().toUpperCase())).length;
const isIndex = (s: string) => s.startsWith("CREATE") && s.includes(" INDEX ");

/** "6 tables, 1 type, 9 indexes created.": the Run step's structure line. */
export function structureLine(structure: string[], afterRows: string[]): string {
  const tables = count(structure, (s) => s.startsWith("CREATE TABLE"));
  // Rows only: the tables exist, nothing is created.
  if (tables === 0) return "";
  const types = count(structure, (s) => s.startsWith("CREATE TYPE"));
  const indexes = count(afterRows, isIndex) + count(structure, isIndex);
  const parts = [plural(tables, "table", "tables"), ...(types > 0 ? [plural(types, "type", "types")] : []), ...(indexes > 0 ? [plural(indexes, "index", "indexes")] : [])];
  return `${parts.join(", ")} created.`;
}

/**
 * The Production dialog's first line: "Creates 6 tables, 1 type and 9 indexes, then copies
 * 6,508,267 rows from kestrel-pos (counted when the run starts)."
 */
export function confirmTitle(structure: string[], afterRows: string[], rows: number | null, copies: number, source: string): string {
  const tables = count(structure, (s) => s.startsWith("CREATE TABLE"));
  const types = count(structure, (s) => s.startsWith("CREATE TYPE"));
  const indexes = count(afterRows, isIndex) + count(structure, isIndex);
  const parts = [
    ...(tables > 0 ? [plural(tables, "table", "tables")] : []),
    ...(types > 0 ? [plural(types, "type", "types")] : []),
    ...(indexes > 0 ? [plural(indexes, "index", "indexes")] : []),
  ];
  const made = parts.length === 0 ? "" : `Creates ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
  if (copies === 0) return `${made || "Changes nothing"}.`;
  const what = rows === null ? `the rows of ${plural(copies, "table", "tables")}` : plural(rows, "row", "rows");
  return `${made ? `${made}, then copies` : "Copies"} ${what} from ${source} (counted when the run starts).`;
}

/** The Core's refusal when the plan at start is not the one reviewed (connections/transfer.rs). */
export const TARGET_CHANGED = "The target changed since you reviewed. Check the SQL again.";

/**
 * "Fix the value in kestrel-pos, or set unit_price to text on Type mapping, then run again.", for
 * a value the target type refused; null for other failures.
 */
export function failureHint(message: string, source: string): string | null {
  const m = /is not valid for .+? in ([^\s.]+)\./.exec(message);
  return m ? `Fix the value in ${source}, or set ${m[1]} to text on Type mapping, then run again.` : null;
}

/** Sets a column's target type: one of its offered choices, or a type typed by hand. */
export function setColumnType(s: TransferState, table: string, column: string, value: string, choice: boolean): TransferState {
  const other = (x: TransferSetting) => !(x.table === table && x.column === column);
  const entry = { table, column, value };
  return choice
    ? { ...s, choices: [...s.choices.filter(other), entry], overrides: s.overrides.filter(other) }
    : { ...s, overrides: [...s.overrides.filter(other), entry], choices: s.choices.filter(other) };
}
