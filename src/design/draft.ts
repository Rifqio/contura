// The Table Designer's draft: the table as it is being edited, keyed by the names it was loaded
// with, so a rename is one change and never a drop plus an add (Review Focus 3). Every function
// returns a new draft.
import type {
  ColumnDraft,
  DesignEdit,
  DialectKind,
  ForeignKeyDraft,
  IndexDraft,
  ObjectPath,
  Position,
  TableDesign,
} from "../api/types";

export interface DraftColumn extends ColumnDraft {
  id: string;
  /** The name as loaded; null for a column the draft adds. */
  origin: string | null;
}

/**
 * A column named by an index or key: one of the draft's columns by id, so it follows renames
 * (even through an empty name), or text that names no draft column (an expression key part,
 * another table's column).
 */
export type ColumnRef = { id: string } | { text: string };

export interface DraftIndex extends Omit<IndexDraft, "columns"> {
  id: string;
  origin: string | null;
  columns: ColumnRef[];
  /** Read-only, as loaded (D17); null for a new index. */
  method: string | null;
  /** A partial index's WHERE text, read-only (D17). */
  predicate: string | null;
  expression: boolean;
  /** Loaded with parts the designer cannot state again (the Core's `advanced`). */
  advanced: boolean;
  /** A new index's name follows its columns until a name is typed. */
  autoName: boolean;
}

export interface DraftForeignKey extends Omit<ForeignKeyDraft, "columns" | "targetColumns"> {
  id: string;
  origin: string | null;
  columns: ColumnRef[];
  /** By id when the key references this table, else text. */
  targetColumns: ColumnRef[];
  advanced: boolean;
  autoName: boolean;
}

/**
 * An index or key that removed loaded columns took out of the draft, whole or in part (S12):
 * kept as it was before the first such removal, so restoring the columns in any order rebuilds it.
 */
interface Held<T> {
  full: T;
  /** Its place in the list then. */
  at: number;
}

export interface Draft {
  /** The design as loaded; null for a new table. */
  base: TableDesign | null;
  path: ObjectPath;
  /** In the edited order; removed loaded columns stay, marked by `removed`. */
  columns: DraftColumn[];
  /** Ids of the loaded columns that are removed. */
  removed: string[];
  /** Ids of the columns moved by hand, so a reorder moves those and leaves the others in place. */
  moved: string[];
  indexes: DraftIndex[];
  foreignKeys: DraftForeignKey[];
  comment: string | null;
  /** The indexes and keys that removed loaded columns took, by id. */
  held: { indexes: Held<DraftIndex>[]; foreignKeys: Held<DraftForeignKey>[] };
}

export type ColumnField = keyof ColumnDraft;
export type ColumnMark = "cell-edited" | "row-added" | "row-deleted";

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

/** Empty text is no value, so clearing a default or a comment drops it. */
const orNull = (s: string | null) => (s === null || s === "" ? null : s);

function columnDraft(c: ColumnDraft): ColumnDraft {
  return {
    name: c.name,
    typeSql: c.typeSql,
    nullable: c.nullable,
    defaultSql: orNull(c.defaultSql),
    increment: c.increment,
    comment: orNull(c.comment),
  };
}

/** `target` names `table` (an empty database or no schema means the table's own), as the Core decides. */
export function sameTable(table: ObjectPath, target: ObjectPath): boolean {
  return (
    target.name === table.name &&
    (target.database === "" || target.database === table.database) &&
    (target.schema === null || target.schema === table.schema)
  );
}

export function fromDesign(d: TableDesign): Draft {
  const columns: DraftColumn[] = d.columns.map((c) => ({
    id: nextId("col"),
    origin: c.name,
    name: c.name,
    typeSql: c.typeSql,
    nullable: c.nullable,
    defaultSql: c.defaultSql,
    increment: c.increment.kind !== "none",
    comment: c.comment,
  }));
  const refs = (names: string[]): ColumnRef[] =>
    names.map((n) => {
      const c = columns.find((x) => x.name === n);
      return c ? { id: c.id } : { text: n };
    });
  return {
    base: d,
    path: d.path,
    columns,
    removed: [],
    moved: [],
    indexes: d.indexes.map((i) => ({
      id: nextId("ix"),
      origin: i.name,
      name: i.name,
      columns: refs(i.columns),
      unique: i.unique,
      primary: i.primary,
      method: i.method,
      predicate: i.predicate,
      expression: i.expression,
      advanced: i.advanced,
      autoName: false,
    })),
    foreignKeys: d.foreignKeys.map((k) => ({
      id: nextId("fk"),
      origin: k.name,
      name: k.name,
      columns: refs(k.columns),
      target: k.target,
      targetColumns: sameTable(d.path, k.target) ? refs(k.targetColumns) : k.targetColumns.map((text) => ({ text })),
      onDelete: k.onDelete,
      onUpdate: k.onUpdate,
      advanced: k.advanced,
      autoName: false,
    })),
    comment: d.comment,
    held: { indexes: [], foreignKeys: [] },
  };
}

/** The current names of an index's or key's columns; a ref to no column names nothing. */
export function refNames(dr: Draft, refs: ColumnRef[]): string[] {
  return refs.flatMap((r) => {
    if ("text" in r) return [r.text];
    const c = dr.columns.find((x) => x.id === r.id);
    return c ? [c.name] : [];
  });
}

/**
 * Refs for picked names: a ref already there is kept, a draft column is named by id, anything
 * else by text. With `self` false every name is text (another table's columns).
 */
export function namesToRefs(dr: Draft, names: string[], prev: ColumnRef[], self = true): ColumnRef[] {
  const kept = dr.columns.filter((c) => !dr.removed.includes(c.id));
  return names.map((n) => {
    const had = prev.find((r) => refNames(dr, [r])[0] === n);
    if (had && (self || "text" in had)) return had;
    const c = self ? kept.find((x) => x.name === n) : undefined;
    return c ? { id: c.id } : { text: n };
  });
}

/** Default names: `orders_email_idx`, `orders_email_key` (unique), `orders_email_fkey`. */
export function defaultName(table: string, columns: string[], suffix: "idx" | "key" | "fkey"): string {
  return [table, ...columns, suffix].filter((p) => p !== "").join("_");
}

/** The table name auto names are built from: as it will be sent, trimmed. */
const tableOf = (dr: Draft) => dr.path.name.trim();

/** An auto-named index's name now: the PostgreSQL primary key's `<table>_pkey`, else from its columns. */
function autoIndexName(dr: Draft, i: DraftIndex): string {
  if (i.primary) return `${tableOf(dr)}_pkey`;
  return defaultName(tableOf(dr), refNames(dr, i.columns), i.unique ? "key" : "idx");
}

const autoKeyName = (dr: Draft, k: DraftForeignKey) => defaultName(tableOf(dr), refNames(dr, k.columns), "fkey");

/**
 * Names a new table: every index and key still named by Contura follows the new name, so one made
 * before the name was typed never keeps a stale or empty prefix (S13 I3).
 */
export function renameTable(dr: Draft, name: string): Draft {
  const next: Draft = { ...dr, path: { ...dr.path, name } };
  if (dr.base) return next;
  return {
    ...next,
    indexes: dr.indexes.map((i) => (i.autoName ? { ...i, name: autoIndexName(next, i) } : i)),
    foreignKeys: dr.foreignKeys.map((k) => (k.autoName ? { ...k, name: autoKeyName(next, k) } : k)),
  };
}

const blankColumn = (): DraftColumn => ({
  id: nextId("new"),
  origin: null,
  name: "",
  typeSql: "",
  nullable: true,
  defaultSql: null,
  increment: false,
  comment: null,
});

/** A new table: one empty column to start from. */
export function emptyDraft(path: ObjectPath): Draft {
  return {
    base: null,
    path,
    columns: [blankColumn()],
    removed: [],
    moved: [],
    indexes: [],
    foreignKeys: [],
    comment: null,
    held: { indexes: [], foreignKeys: [] },
  };
}

/** Edits a column. Indexes and keys name it by id, so a rename carries into them, as on the server. */
export function editColumn(dr: Draft, id: string, patch: Partial<ColumnDraft>): Draft {
  if (!dr.columns.some((c) => c.id === id)) return dr;
  return { ...dr, columns: dr.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Adds an empty column at the end (parity T3: new rows go at the bottom). */
export function addColumn(dr: Draft): Draft {
  return { ...dr, columns: [...dr.columns, blankColumn()] };
}

const isRef = (r: ColumnRef | undefined, id: string) => !!r && "id" in r && r.id === id;
const hasRef = (refs: ColumnRef[], id: string) => refs.some((r) => isRef(r, id));

/** An index the designer can only rename or drop: partial, on an expression, or advanced (D17). */
export function fixedIndex(i: DraftIndex): boolean {
  return i.advanced || i.expression || i.predicate !== null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether SQL text names `name` as a whole word (an expression key part, a partial index's WHERE). */
function mentions(text: string, name: string): boolean {
  return name !== "" && new RegExp(`(^|[^\\w$])${escapeRe(name)}([^\\w$]|$)`, "i").test(text);
}

/** SQL text with each string literal emptied, so a word inside quotes names no column. */
export function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The removed loaded columns that an index uses: by ref, or (for a fixed index) named in its SQL
 * text. The text is the server's, so only the loaded name is looked for, outside string literals.
 */
function goneFrom(dr: Draft, i: DraftIndex, removed: string[]): string[] {
  const text = blankLiterals([i.predicate ?? "", ...i.columns.flatMap((r) => ("text" in r ? [r.text] : []))].join(" "));
  return removed.filter((id) => {
    if (hasRef(i.columns, id)) return true;
    const c = dr.columns.find((x) => x.id === id);
    return fixedIndex(i) && !!c?.origin && mentions(text, c.origin);
  });
}

/**
 * An index as the removed columns leave it (S12): a loaded or fixed index on one of them goes
 * whole; an added one loses those columns, and goes when none is left. Unchanged: the same object.
 */
function leftIndex(dr: Draft, i: DraftIndex, removed: string[]): DraftIndex | null {
  const gone = goneFrom(dr, i, removed);
  if (gone.length === 0) return i;
  if (i.origin !== null || fixedIndex(i)) return null;
  const columns = i.columns.filter((r) => !gone.some((id) => isRef(r, id)));
  return columns.length === 0 ? null : { ...i, columns };
}

/** A key as the removed columns leave it: a loaded or advanced one goes whole; an added one loses the pairs they are in. */
function leftKey(k: DraftForeignKey, removed: string[]): DraftForeignKey | null {
  const out = (r: ColumnRef | undefined) => removed.some((id) => isRef(r, id));
  const size = Math.max(k.columns.length, k.targetColumns.length);
  const keep = Array.from({ length: size }, (_, p) => !out(k.columns[p]) && !out(k.targetColumns[p]));
  if (keep.every(Boolean)) return k;
  if (k.origin !== null || k.advanced) return null;
  const columns = k.columns.filter((_, p) => keep[p]);
  return columns.length === 0 ? null : { ...k, columns, targetColumns: k.targetColumns.filter((_, p) => keep[p]) };
}

const sameEntry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a new set of removed columns to one list. An entry the removed columns touch is held
 * as it was before (unless the user changed it since it was held: then it is held anew), and the
 * draft shows what is left of it. An entry fully back is let go.
 */
function rehold<T extends { id: string }>(
  list: T[],
  held: Held<T>[],
  left: (e: T, removed: string[]) => T | null,
  before: string[],
  after: string[],
  /** Whether an entry can come back into the list as it is now (one primary key per table). */
  fits: (e: T, list: T[]) => boolean = () => true,
): { list: T[]; held: Held<T>[] } {
  let out = [...list];
  const keep: Held<T>[] = [];
  /** Ids the holds have dealt with; a hold let go leaves its entry to the plain pass below. */
  const done = new Set<string>();
  for (const h of held) {
    const now = out.find((x) => x.id === h.full.id);
    const was = left(h.full, before);
    // Changed or removed by hand since it was held: the hold is let go.
    if (now ? !was || !sameEntry(now, was) : was !== null) continue;
    const next = left(h.full, after);
    // Its place was taken by hand (a new primary key from the Key toggles): the hold is let go.
    if (next && !now && !fits(next, out)) continue;
    done.add(h.full.id);
    if (next && now) out = out.map((x) => (x.id === h.full.id ? next : x));
    else if (next) out.splice(Math.min(h.at, out.length), 0, next);
    else out = out.filter((x) => x.id !== h.full.id);
    if (next !== h.full) keep.push(h);
  }
  list.forEach((e, at) => {
    if (done.has(e.id)) return;
    const next = left(e, after);
    if (next === e) return;
    if (next) out = out.map((x) => (x.id === e.id ? next : x));
    else out = out.filter((x) => x.id !== e.id);
    keep.push({ full: e, at });
  });
  return { list: out, held: keep };
}

/** Moves the draft to a new set of removed loaded columns, holding and giving back indexes and keys (S12). */
function withRemoved(dr: Draft, removed: string[]): Draft {
  const ix = rehold(
    dr.indexes,
    dr.held.indexes,
    (i, r) => leftIndex(dr, i, r),
    dr.removed,
    removed,
    (i, list) => !i.primary || !list.some((x) => x.primary),
  );
  const fk = rehold(dr.foreignKeys, dr.held.foreignKeys, leftKey, dr.removed, removed);
  return { ...dr, removed, indexes: ix.list, foreignKeys: fk.list, held: { indexes: ix.held, foreignKeys: fk.held } };
}

/** Strips an added column for good: it can never come back, so no entry keeps a ref to it. */
function strip(dr: Draft, id: string): Draft {
  // Shortened as an added entry is, even when loaded: a loaded entry edited to hold the added
  // column is already a drop and an add, so it keeps its origin and loses the column.
  function shorten<T extends { origin: string | null }>(e: T, left: (x: T) => T | null): T | null {
    const now = left({ ...e, origin: null });
    return now === null ? null : { ...now, origin: e.origin };
  }
  const index = (i: DraftIndex) => (hasRef(i.columns, id) ? shorten(i, (x) => leftIndex(dr, x, [id])) : i);
  const key = (k: DraftForeignKey) =>
    hasRef(k.columns, id) || hasRef(k.targetColumns, id) ? shorten(k, (x) => leftKey(x, [id])) : k;
  const each = <T>(list: T[], f: (e: T) => T | null) => list.flatMap((e) => f(e) ?? []);
  const heldBy =
    <T>(f: (e: T) => T | null) =>
    (h: Held<T>) => {
      const full = f(h.full);
      return full ? { ...h, full } : null;
    };
  return {
    ...dr,
    indexes: each(dr.indexes, index),
    foreignKeys: each(dr.foreignKeys, key),
    held: { indexes: each(dr.held.indexes, heldBy(index)), foreignKeys: each(dr.held.foreignKeys, heldBy(key)) },
  };
}

/**
 * An added column leaves the list and every index and key. A loaded one stays, marked removed;
 * every loaded index, primary key and Foreign Key on it goes whole, never narrowed (S12), and an
 * added index or key loses it.
 */
export function removeColumn(dr: Draft, id: string): Draft {
  const c = dr.columns.find((x) => x.id === id);
  if (!c || dr.removed.includes(id)) return dr;
  if (c.origin === null) {
    const stripped = strip(dr, id);
    return { ...stripped, columns: stripped.columns.filter((x) => x.id !== id) };
  }
  return withRemoved(dr, [...dr.removed, id]);
}

/**
 * Brings back a removed loaded column. What its removal took comes back once none of its
 * columns is still removed, in whatever order the columns come back.
 */
export function restoreColumn(dr: Draft, id: string): Draft {
  if (!dr.removed.includes(id)) return dr;
  return withRemoved(
    dr,
    dr.removed.filter((x) => x !== id),
  );
}

/**
 * The note for each plain loaded index that removed columns took (S12): "Removing email also
 * drops index orders_email_status_idx." UNIQUE, primary key and Foreign Key drops get the Core's warnings.
 */
export function droppedIndexNotes(dr: Draft): string[] {
  return dr.held.indexes.flatMap(({ full }) => {
    if (full.origin === null || full.primary || full.unique || dr.indexes.some((i) => i.id === full.id)) return [];
    const names = goneFrom(dr, full, dr.removed).map((id) => dr.columns.find((c) => c.id === id)?.origin ?? "");
    return names.length ? [`Removing ${names.join(", ")} also drops index ${full.name}.`] : [];
  });
}

/** Moves a column past its nearest kept neighbour above (-1) or below (1); removed rows are stepped over. */
export function moveColumn(dr: Draft, id: string, by: -1 | 1): Draft {
  const at = dr.columns.findIndex((c) => c.id === id);
  if (at < 0) return dr;
  let to = at + by;
  while (to >= 0 && to < dr.columns.length && dr.removed.includes(dr.columns[to].id)) to += by;
  if (to < 0 || to >= dr.columns.length) return dr;
  const columns = [...dr.columns];
  const [column] = columns.splice(at, 1);
  columns.splice(to, 0, column);
  return { ...dr, columns, moved: dr.moved.includes(id) ? dr.moved : [...dr.moved, id] };
}

/** Adds the column to the primary key in column order, or takes it out (the Key cell's toggle). */
export function togglePrimary(dr: Draft, id: string, dialect: DialectKind): Draft {
  const c = dr.columns.find((x) => x.id === id);
  if (!c || c.name === "") return dr;
  const pk = dr.indexes.find((i) => i.primary);
  if (!pk) {
    const name = dialect === "mysql" ? "PRIMARY" : dialect === "sqlite" ? "primary" : `${tableOf(dr)}_pkey`;
    const index: DraftIndex = {
      id: nextId("ix"),
      origin: null,
      name,
      columns: [{ id }],
      unique: true,
      primary: true,
      method: null,
      predicate: null,
      expression: false,
      advanced: false,
      // PostgreSQL's name carries the table's, so it follows a new table's name (S13 I3).
      autoName: dialect === "postgres",
    };
    return { ...dr, indexes: [index, ...dr.indexes] };
  }
  if (fixedIndex(pk)) return dr;
  const place = (r: ColumnRef) => ("id" in r ? dr.columns.findIndex((x) => x.id === r.id) : -1);
  const at = dr.columns.indexOf(c);
  const next = pk.columns.findIndex((r) => place(r) > at);
  const columns = hasRef(pk.columns, id)
    ? pk.columns.filter((r) => !isRef(r, id))
    : next < 0
      ? [...pk.columns, { id }]
      : [...pk.columns.slice(0, next), { id }, ...pk.columns.slice(next)];
  if (columns.length === 0 && pk.origin === null) return { ...dr, indexes: dr.indexes.filter((i) => i.id !== pk.id) };
  return { ...dr, indexes: dr.indexes.map((i) => (i.id === pk.id ? { ...i, columns } : i)) };
}

/** The primary key is one the designer cannot rebuild, so its Key toggles are fixed. */
export function primaryFixed(dr: Draft): boolean {
  const pk = dr.indexes.find((i) => i.primary);
  return !!pk && fixedIndex(pk);
}

export type IndexPatch = Partial<Pick<DraftIndex, "name" | "columns" | "unique">>;

/** Adds an empty index at the end; its name follows the columns picked. */
export function addIndex(dr: Draft): Draft {
  const index: DraftIndex = {
    id: nextId("ix"),
    origin: null,
    name: defaultName(tableOf(dr), [], "idx"),
    columns: [],
    unique: false,
    primary: false,
    method: null,
    predicate: null,
    expression: false,
    advanced: false,
    autoName: true,
  };
  return { ...dr, indexes: [...dr.indexes, index] };
}

/**
 * Edits an index. The primary key changes only through the Key toggles; a fixed index only takes
 * a new name (D17). A typed name stops the name following the columns.
 */
export function editIndex(dr: Draft, id: string, patch: IndexPatch): Draft {
  const i = dr.indexes.find((x) => x.id === id);
  if (!i || i.primary) return dr;
  if (fixedIndex(i) && (patch.columns !== undefined || patch.unique !== undefined)) return dr;
  const next: DraftIndex = { ...i, ...patch };
  if (patch.name !== undefined) next.autoName = false;
  else if (i.autoName) next.name = autoIndexName(dr, next);
  return { ...dr, indexes: dr.indexes.map((x) => (x.id === id ? next : x)) };
}

/** Removes an index; the primary key goes only through the Key toggles. */
export function removeIndex(dr: Draft, id: string): Draft {
  const i = dr.indexes.find((x) => x.id === id);
  if (!i || i.primary) return dr;
  return { ...dr, indexes: dr.indexes.filter((x) => x.id !== id) };
}

export type ForeignKeyPatch = Partial<
  Pick<DraftForeignKey, "name" | "columns" | "target" | "targetColumns" | "onDelete" | "onUpdate">
>;

/** Adds an empty Foreign Key at the end, to a table not picked yet. */
export function addForeignKey(dr: Draft): Draft {
  const key: DraftForeignKey = {
    id: nextId("fk"),
    origin: null,
    name: defaultName(tableOf(dr), [], "fkey"),
    columns: [],
    target: { database: dr.path.database, schema: dr.path.schema, name: "" },
    targetColumns: [],
    onDelete: null,
    onUpdate: null,
    advanced: false,
    autoName: true,
  };
  return { ...dr, foreignKeys: [...dr.foreignKeys, key] };
}

/** Edits a Foreign Key; an advanced one can only be removed. A new table clears the columns picked on the old one. */
export function editForeignKey(dr: Draft, id: string, patch: ForeignKeyPatch): Draft {
  const k = dr.foreignKeys.find((x) => x.id === id);
  if (!k || k.advanced) return dr;
  const next: DraftForeignKey = { ...k, ...patch };
  if (patch.target !== undefined && !samePath(patch.target, k.target) && patch.targetColumns === undefined) next.targetColumns = [];
  if (patch.name !== undefined) next.autoName = false;
  else if (k.autoName) next.name = autoKeyName(dr, next);
  return { ...dr, foreignKeys: dr.foreignKeys.map((x) => (x.id === id ? next : x)) };
}

export function removeForeignKey(dr: Draft, id: string): Draft {
  return dr.foreignKeys.some((x) => x.id === id) ? { ...dr, foreignKeys: dr.foreignKeys.filter((x) => x.id !== id) } : dr;
}

const samePath = (a: ObjectPath, b: ObjectPath) => a.database === b.database && a.schema === b.schema && a.name === b.name;

/** NO ACTION is every Dialect's default, which the server reports as null. */
export const action = (a: string | null) => a ?? "NO ACTION";

/** Loaded column names as the draft now calls them: renames carried, removed columns gone. */
function loadedNames(dr: Draft, names: string[]): string[] {
  return names.flatMap((n) => {
    const c = dr.columns.find((x) => x.origin === n);
    if (!c) return [n];
    return dr.removed.includes(c.id) ? [] : [c.name];
  });
}

/** Which cells of a loaded index differ from how it was loaded, for the `cell-edited` mark. */
export function indexEdited(dr: Draft, i: DraftIndex): { name: boolean; columns: boolean; unique: boolean } {
  const was = i.origin === null ? null : dr.base?.indexes.find((x) => x.name === i.origin);
  if (!was) return { name: false, columns: false, unique: false };
  return {
    name: i.name !== was.name,
    columns: !sameList(refNames(dr, i.columns), loadedNames(dr, was.columns)),
    unique: i.unique !== was.unique,
  };
}

/** Which cells of a loaded Foreign Key differ from how it was loaded. */
export function foreignKeyEdited(
  dr: Draft,
  k: DraftForeignKey,
): { name: boolean; columns: boolean; references: boolean; onDelete: boolean; onUpdate: boolean } {
  const was = k.origin === null ? null : dr.base?.foreignKeys.find((x) => x.name === k.origin);
  if (!was) return { name: false, columns: false, references: false, onDelete: false, onUpdate: false };
  const targets = sameTable(dr.path, was.target) ? loadedNames(dr, was.targetColumns) : was.targetColumns;
  return {
    name: k.name !== was.name,
    columns: !sameList(refNames(dr, k.columns), loadedNames(dr, was.columns)),
    references: !samePath(k.target, was.target) || !sameList(refNames(dr, k.targetColumns), targets),
    onDelete: action(k.onDelete) !== action(was.onDelete),
    onUpdate: action(k.onUpdate) !== action(was.onUpdate),
  };
}

/**
 * Why the indexes and keys cannot be applied yet, naming the one at fault. A loaded primary key
 * toggled down to no columns is a drop, not a problem.
 */
export function keysProblem(dr: Draft): string | null {
  const twice = (names: string[], name: string) => names.filter((n) => n === name).length > 1;
  const indexNames = dr.indexes.map((i) => i.name);
  for (const i of dr.indexes) {
    if (i.primary) continue;
    if (i.name.trim() === "") return "An index has no name. Name it, or remove it.";
    if (i.columns.length === 0) return `Index ${i.name} has no columns. Pick one, or remove it.`;
    if (twice(indexNames, i.name)) return `Two indexes are named ${i.name}. Rename one.`;
  }
  const keyNames = dr.foreignKeys.map((k) => k.name);
  for (const k of dr.foreignKeys) {
    if (k.name.trim() === "") return "A Foreign Key has no name. Name it, or remove it.";
    if (k.columns.length === 0) return `Foreign Key ${k.name} has no columns. Pick one, or remove it.`;
    if (k.target.name === "") return `Foreign Key ${k.name} references no table. Pick one.`;
    if (k.targetColumns.length !== k.columns.length)
      return `Foreign Key ${k.name} needs as many referenced columns as columns.`;
    if (twice(keyNames, k.name)) return `Two Foreign Keys are named ${k.name}. Rename one.`;
  }
  return null;
}

const refIds = (refs: ColumnRef[]) => refs.flatMap((r) => ("id" in r ? [r.id] : []));

/** Ids of the draft's primary key columns. */
export function primaryColumns(dr: Draft): Set<string> {
  return new Set(refIds(dr.indexes.find((i) => i.primary)?.columns ?? []));
}

/** Ids of the columns in one of the draft's Foreign Keys. */
export function foreignKeyColumns(dr: Draft): Set<string> {
  return new Set(dr.foreignKeys.flatMap((k) => refIds(k.columns)));
}

const FIELDS: ColumnField[] = ["name", "typeSql", "nullable", "defaultSql", "increment", "comment"];

function loadedColumn(dr: Draft, origin: string): ColumnDraft | null {
  const c = dr.base?.columns.find((x) => x.name === origin);
  return c ? columnDraft({ ...c, increment: c.increment.kind !== "none" }) : null;
}

/** The fields of a loaded column that differ from how it was loaded. */
export function editedFields(dr: Draft, id: string): ColumnField[] {
  const c = dr.columns.find((x) => x.id === id);
  if (!c || c.origin === null) return [];
  const was = loadedColumn(dr, c.origin);
  if (!was) return [];
  const now = columnDraft(c);
  return FIELDS.filter((f) => now[f] !== was[f]);
}

export function columnMark(dr: Draft, id: string): ColumnMark | null {
  const c = dr.columns.find((x) => x.id === id);
  if (!c) return null;
  if (c.origin === null) return "row-added";
  if (dr.removed.includes(id)) return "row-deleted";
  return editedFields(dr, id).length > 0 ? "cell-edited" : null;
}

/**
 * The loaded columns that keep their place: the longest run in loaded order, preferring columns
 * not moved by hand (as the Core does). `kept` holds each column's loaded index and whether it moved.
 */
function stationary(kept: { at: number; moved: boolean }[]): boolean[] {
  const n = kept.length;
  const weight = (moved: boolean) => (moved ? 1 : n + 1);
  const best = kept.map((k) => weight(k.moved));
  const parent: (number | null)[] = kept.map(() => null);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (kept[j].at < kept[i].at && best[j] + weight(kept[i].moved) > best[i]) {
        best[i] = best[j] + weight(kept[i].moved);
        parent[i] = j;
      }
    }
  }
  const stays = kept.map(() => false);
  let at: number | null = n === 0 ? null : best.reduce((m, b, i) => (b >= best[m] ? i : m), 0);
  while (at !== null) {
    stays[at] = true;
    at = parent[at];
  }
  return stays;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

interface Diff {
  edits: DesignEdit[];
  /** Column ids, index ids (or loaded names) and key ids (or loaded names) that changed. */
  changed: Set<string>;
}

function diff(dr: Draft): Diff {
  const changed = new Set<string>();
  const kept = dr.columns.filter((c) => !dr.removed.includes(c.id));
  const baseNames = dr.base?.columns.map((c) => c.name) ?? [];
  /** Loaded name to current name, for the kept columns. */
  const renamed = new Map(kept.flatMap((c) => (c.origin === null ? [] : [[c.origin, c.name] as const])));
  const current = (names: string[]) => names.map((n) => renamed.get(n) ?? n);
  const self = (k: { target: ObjectPath }) => sameTable(dr.path, k.target);
  // A new table's auto names come from the name it is created with, not the one typed when they were made (S13 I3).
  const sentIndexName = (i: DraftIndex) => (!dr.base && i.autoName ? autoIndexName(dr, i) : i.name);
  const sentKeyName = (k: DraftForeignKey) => (!dr.base && k.autoName ? autoKeyName(dr, k) : k.name);

  const dropKeys: DesignEdit[] = [];
  const addKeys: DesignEdit[] = [];
  for (const k of dr.base?.foreignKeys ?? []) {
    const now = dr.foreignKeys.find((x) => x.origin === k.name);
    const same =
      now &&
      now.name === k.name &&
      sameList(refNames(dr, now.columns), current(k.columns)) &&
      samePath(now.target, k.target) &&
      sameList(refNames(dr, now.targetColumns), self(k) ? current(k.targetColumns) : k.targetColumns) &&
      action(now.onDelete) === action(k.onDelete) &&
      action(now.onUpdate) === action(k.onUpdate);
    if (same) continue;
    dropKeys.push({ op: "dropForeignKey", name: k.name });
    changed.add(now?.id ?? `fk:${k.name}`);
  }
  for (const k of dr.foreignKeys) {
    const was = k.origin === null ? null : dr.base?.foreignKeys.find((x) => x.name === k.origin);
    if (was && !changed.has(k.id)) continue;
    changed.add(k.id);
    const columns = refNames(dr, k.columns);
    const targetColumns = refNames(dr, k.targetColumns);
    // Not whole yet (Apply waits on `keysProblem`): the Core is never handed a blank name.
    if (columns.length === 0 || k.target.name === "" || [...columns, ...targetColumns].includes("")) continue;
    const key: ForeignKeyDraft = { name: sentKeyName(k), columns, target: k.target, targetColumns, onDelete: k.onDelete, onUpdate: k.onUpdate };
    addKeys.push({ op: "addForeignKey", key });
  }

  const dropIndexes: DesignEdit[] = [];
  const renameIndexes: DesignEdit[] = [];
  const addPrimary: DesignEdit[] = [];
  const addIndexes: DesignEdit[] = [];
  for (const i of dr.base?.indexes ?? []) {
    const now = dr.indexes.find((x) => x.origin === i.name);
    if (now && sameList(refNames(dr, now.columns), current(i.columns)) && now.unique === i.unique && now.primary === i.primary) {
      if (now.name !== i.name) {
        renameIndexes.push({ op: "renameIndex", name: i.name, to: now.name });
        changed.add(now.id);
      }
      continue;
    }
    dropIndexes.push({ op: "dropIndex", name: i.name });
    changed.add(now?.id ?? `ix:${i.name}`);
  }
  for (const i of dr.indexes) {
    if (i.origin !== null && !changed.has(i.id)) continue;
    if (i.origin !== null && renameIndexes.some((e) => e.op === "renameIndex" && e.name === i.origin)) continue;
    // A loaded primary key toggled down to no columns is only dropped; any other empty index waits on `keysProblem`.
    if (i.origin === null || i.columns.length > 0) changed.add(i.id);
    const columns = refNames(dr, i.columns);
    if (columns.length === 0 || columns.includes("")) continue;
    const index: IndexDraft = { name: sentIndexName(i), columns, unique: i.unique, primary: i.primary };
    (i.primary ? addPrimary : addIndexes).push({ op: "addIndex", index });
  }

  const dropColumns: DesignEdit[] = dr.columns
    .filter((c) => c.origin !== null && dr.removed.includes(c.id))
    .map((c) => {
      changed.add(c.id);
      return { op: "dropColumn", name: c.origin! };
    });
  const changes: DesignEdit[] = [];
  for (const c of kept) {
    if (c.origin === null || editedFields(dr, c.id).length === 0) continue;
    changes.push({ op: "changeColumn", name: c.origin, column: columnDraft(c) });
    changed.add(c.id);
  }

  // Loaded columns out of their loaded order move after the loaded column before them.
  const loaded = kept.filter((c) => c.origin !== null);
  const stays = stationary(loaded.map((c) => ({ at: baseNames.indexOf(c.origin!), moved: dr.moved.includes(c.id) })));
  const moves: DesignEdit[] = [];
  loaded.forEach((c, i) => {
    if (stays[i]) return;
    const position: Position = i === 0 ? { kind: "first" } : { kind: "after", column: loaded[i - 1].name };
    moves.push({ op: "moveColumn", name: c.name, position });
    changed.add(c.id);
  });

  // Added columns go after the column before them, or last when only added columns follow.
  const adds: DesignEdit[] = [];
  kept.forEach((c, i) => {
    if (c.origin !== null) return;
    const loadedAfter = kept.slice(i + 1).some((x) => x.origin !== null);
    const position: Position = !loadedAfter ? { kind: "last" } : i === 0 ? { kind: "first" } : { kind: "after", column: kept[i - 1].name };
    adds.push({ op: "addColumn", column: columnDraft(c), position });
    // A new table's untouched starting row is no change yet.
    if (dr.base || c.name !== "" || c.typeSql !== "") changed.add(c.id);
  });

  const comment: DesignEdit[] = [];
  if (dr.base && orNull(dr.comment) !== orNull(dr.base.comment)) {
    comment.push({ op: "tableComment", comment: orNull(dr.comment) });
    changed.add("comment");
  }
  if (!dr.base && orNull(dr.comment) !== null) {
    comment.push({ op: "tableComment", comment: orNull(dr.comment) });
    changed.add("comment");
  }

  // The Core's statement order (Task 3): key drops, index drops, column drops, changes, moves,
  // adds, index renames, the primary key, index adds, key adds, the comment.
  return {
    edits: [
      ...dropKeys,
      ...dropIndexes,
      ...dropColumns,
      ...changes,
      ...moves,
      ...adds,
      ...renameIndexes,
      ...addPrimary,
      ...addIndexes,
      ...addKeys,
      ...comment,
    ],
    changed,
  };
}

/** The draft as `DesignEdit`s, matched by loaded name, never by name. */
export function toEdits(dr: Draft): DesignEdit[] {
  return diff(dr).edits;
}

/** Columns, indexes and keys changed, plus the table comment. */
export function changeCount(dr: Draft): number {
  return diff(dr).changed.size;
}

/**
 * M1: a default typed with a backslash, on MySQL. Apply, Compare and the copied scripts all read it with backslash
 * escapes (the runner turns NO_BACKSLASH_ESCAPES off, the scripts set Backup's sql_mode), as the designer shows a
 * loaded default (`'a\\b'`), so the note says so rather than reading it the server's way.
 */
export function backslashNote(dr: Draft, dialect: DialectKind): string | null {
  if (dialect !== "mysql") return null;
  const typed = dr.columns.filter((c) => {
    if (dr.removed.includes(c.id) || !c.defaultSql?.includes("\\")) return false;
    const loaded = c.origin === null ? null : dr.base?.columns.find((x) => x.name === c.origin);
    return loaded?.defaultSql !== c.defaultSql;
  });
  if (typed.length === 0) return null;
  const which = typed.map((c) => c.name).join(", ");
  return `MySQL default${typed.length === 1 ? "" : "s"} ${which}: Contura reads a backslash in quotes as an escape, whatever the server's sql_mode, so \\\\ is one backslash and \\t a tab.`;
}
