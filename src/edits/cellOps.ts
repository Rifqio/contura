// UX step 3 (G3, G4): what Delete, Set NULL and Set DEFAULT do to the selected cells, as one batch of Pending Edits
// (`applyMany`), with the note that says what was left and why. Pure, so the grid and the perf test share it.
import type { ColumnInfo, NewValue } from "../api/types";
import type { DisplayRow } from "./gridRows";
import type { CellOp } from "./pending";

export const NO_KEY = "This table has no primary key, so its rows can't be edited";

/** Types an empty string suits (ruling 2): Delete clears these to '' and every other type to NULL. */
const TEXT_TYPE = /^(n?varchar|n?char|character|bpchar|text|tinytext|mediumtext|longtext|citext|clob|string|name)\b/i;

/**
 * A column default Set DEFAULT can write into a saved row: a quoted string, a number, a boolean or NULL. Anything
 * else (`now()`, `nextval(...)`) is worked out by the server, which only a new row can take.
 */
export function constantDefault(sql: string | null): { value: NewValue } | { expression: string } | null {
  if (sql === null) return null;
  const whole = sql.trim();
  // SQL Server writes ((0)) and (N'x'): drop parentheses that wrap the whole default.
  let t = whole;
  while (t.startsWith("(") && t.endsWith(")") && wraps(t)) t = t.slice(1, -1).trim();
  const cast = String.raw`(::[\w\s"().[\]]+)?`;
  if (new RegExp(`^null${cast}$`, "i").test(t)) return { value: { t: "null" } };
  const quoted = new RegExp(`^N?'((?:[^']|'')*)'${cast}$`, "i").exec(t);
  if (quoted) return { value: { t: "text", value: quoted[1].replace(/''/g, "'") } };
  const number = new RegExp(`^\\(?([-+]?\\d+(?:\\.\\d+)?)\\)?${cast}$`).exec(t);
  if (number) return { value: { t: "text", value: number[1] } };
  if (/^(true|false)$/i.test(t)) return { value: { t: "text", value: t.toLowerCase() } };
  return { expression: whole };
}

/** The first parenthesis closes at the end: `(a)` wraps, `(a) + (b)` does not. Quotes are skipped. */
function wraps(t: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0 && i < t.length - 1) return false;
  }
  return depth === 0;
}

/** "id", "id and name", "a, b and c". */
export function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/** A column's nullability and default, from the table's design. */
export type ColumnFacts = { nullable: boolean; defaultSql: string | null };

export function planCells(a: {
  kind: "clear" | "null" | "default";
  view: DisplayRow[];
  columns: ColumnInfo[];
  /** `view` and `columns` indexes, each once. */
  cells: { row: number; column: number }[];
  design: Map<string, ColumnFacts> | null;
}): { ops: CellOp[]; note: string } {
  const { kind, view, columns, design } = a;
  const keyCols = new Set<string>();
  const notNull = new Set<string>();
  const computed = new Map<string, string>();
  const noDefault = new Set<string>();
  let deletedRows = false;
  let keyless = false;
  let binary = false;
  /** NULL written without knowing whether the column takes it (M6). */
  let guessed = false;
  const ops: CellOp[] = [];
  const put = (d: DisplayRow, column: string, value: NewValue | "unset") => {
    if (d.kind === "new") ops.push(value === "unset" ? { t: "unsetNew", localId: d.id, column } : { t: "setNew", localId: d.id, column, value });
    else if (value !== "unset") ops.push({ t: "set", rowKey: d.key!, row: d.source, column, value });
  };
  for (const at of a.cells) {
    const d = view[at.row];
    const col = columns[at.column];
    if (!d || !col) continue;
    if (d.kind === "loaded") {
      if (d.deleted) {
        deletedRows = true;
        continue;
      }
      if (!d.key) {
        keyless = true;
        continue;
      }
      if (col.isPrimaryKey) {
        keyCols.add(col.name);
        continue;
      }
    }
    const info = design?.get(col.name);
    const nullable = info ? info.nullable : true;
    if (kind === "default") {
      if (d.kind === "new") {
        put(d, col.name, "unset");
        continue;
      }
      const def = constantDefault(info?.defaultSql ?? null);
      if (def && "value" in def) put(d, col.name, def.value);
      else if (def) computed.set(col.name, def.expression);
      else if (nullable) {
        if (!design) guessed = true;
        put(d, col.name, { t: "null" });
      }
      else noDefault.add(col.name);
      continue;
    }
    if (kind === "clear" && TEXT_TYPE.test(col.typeName) && d.cells[at.column].t !== "bytes") {
      put(d, col.name, { t: "text", value: "" });
      continue;
    }
    if (!nullable) {
      notNull.add(col.name);
      continue;
    }
    if (kind === "clear" && d.cells[at.column].t === "bytes") binary = true;
    if (!design) guessed = true;
    put(d, col.name, { t: "null" });
  }
  const n = ops.length;
  const said: string[] = [];
  if (n) said.push(kind === "clear" ? `Cleared ${plural(n, "cell")}.` : `Set ${plural(n, "cell")} to ${kind === "null" ? "NULL" : "DEFAULT"}.`);
  if (guessed) said.push("Column details could not be read, so Save may refuse NULL in a NOT NULL column.");
  if (keyCols.size) said.push(keyCols.size === 1 ? `Key column ${names([...keyCols])} left as it is.` : `Key columns ${names([...keyCols])} left as they are.`);
  if (notNull.size) {
    const what = kind === "clear" ? "can't be empty or NULL" : "can't be NULL";
    said.push(`${names([...notNull])} ${what}, so ${notNull.size === 1 ? "it was left as it is" : "they were left as they are"}.`);
  }
  for (const [name, expression] of computed) said.push(`${name}'s default ${expression} is worked out by the server, so only a new row takes it.`);
  if (noDefault.size) said.push(`${names([...noDefault])} ${noDefault.size === 1 ? "has" : "have"} no default and can't be NULL, so ${noDefault.size === 1 ? "it was" : "they were"} left as ${noDefault.size === 1 ? "it is" : "they are"}.`);
  if (binary) said.push("Binary values were set to NULL.");
  if (deletedRows) said.push("Rows marked for deletion are skipped.");
  if (keyless) said.push(NO_KEY + ".");
  return { ops, note: said.length ? said.join(" ") : "Nothing to change there." };
}
