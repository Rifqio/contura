// Item 2: filters built without writing SQL. Each filter is a column, a condition worded for the column's kind of
// value, and a value; together they become the WHERE the table view fetches with (every filter must hold). The SQL
// quotes names and values for the Dialect, so nothing typed into a value can change the statement.
import type { Cell, DialectKind } from "../api/types";
import { sqlString } from "./sqlString";

export type ValueKind = "number" | "date" | "boolean" | "text";

export type FilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "empty"
  | "notEmpty"
  | "gte"
  | "lte"
  | "gt"
  | "lt"
  | "between"
  | "on"
  | "onOrAfter"
  | "onOrBefore"
  | "before"
  | "after"
  | "isTrue"
  | "isFalse"
  | "null"
  | "notNull";

export interface RowFilter {
  id: string;
  column: string;
  op: FilterOp;
  /** The value; empty for conditions that take none. */
  value: string;
  /** The second value of "is between". */
  value2?: string;
  /**
   * UX step 8: a Foreign Key's column and value. It is an exact equality the server types by the column (a timestamp,
   * a uuid or a decimal key as it was read), never checked or reworded as the filter bar's typed values are.
   */
  key?: boolean | "number";
}

const NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial|decimal|numeric|real|float|float4|float8|double|money)\b/i;
// Times of day (time, timetz) are filtered as text: they have no calendar day.
const DATE = /^(date|datetime|timestamp|timestamptz)\b/i;
const BOOL = /^(bool|boolean|bit\(1\)|tinyint\(1\))/i;

/** How a column's type is filtered. */
export function valueKind(typeName: string): ValueKind {
  const t = typeName.trim().toLowerCase();
  if (BOOL.test(t)) return "boolean";
  if (NUMERIC.test(t)) return "number";
  if (DATE.test(t) || t.startsWith("timestamp")) return "date";
  return "text";
}

/** The conditions each kind offers, in menu order, with their words. */
export const OPS: Record<ValueKind, { op: FilterOp; label: string }[]> = {
  text: [
    { op: "eq", label: "is" },
    { op: "ne", label: "is not" },
    { op: "contains", label: "contains" },
    { op: "notContains", label: "does not contain" },
    { op: "startsWith", label: "starts with" },
    { op: "endsWith", label: "ends with" },
    { op: "empty", label: "is empty" },
    { op: "notEmpty", label: "is not empty" },
    { op: "null", label: "is NULL" },
    { op: "notNull", label: "is not NULL" },
  ],
  number: [
    { op: "eq", label: "is" },
    { op: "ne", label: "is not" },
    { op: "gte", label: "is at least" },
    { op: "lte", label: "is at most" },
    { op: "gt", label: "is more than" },
    { op: "lt", label: "is less than" },
    { op: "between", label: "is between" },
    { op: "null", label: "is NULL" },
    { op: "notNull", label: "is not NULL" },
  ],
  date: [
    { op: "on", label: "is on" },
    { op: "eq", label: "is" },
    { op: "onOrAfter", label: "is on or after" },
    { op: "onOrBefore", label: "is on or before" },
    { op: "after", label: "is after" },
    { op: "before", label: "is before" },
    { op: "between", label: "is between" },
    { op: "null", label: "is NULL" },
    { op: "notNull", label: "is not NULL" },
  ],
  boolean: [
    { op: "isTrue", label: "is true" },
    { op: "isFalse", label: "is false" },
    { op: "null", label: "is NULL" },
    { op: "notNull", label: "is not NULL" },
  ],
};

const NO_VALUE: ReadonlySet<FilterOp> = new Set(["empty", "notEmpty", "isTrue", "isFalse", "null", "notNull"]);

/** The condition takes no value ("is NULL", "is true"). */
export const takesValue = (op: FilterOp) => !NO_VALUE.has(op);

export function opLabel(kind: ValueKind, op: FilterOp): string {
  return OPS[kind].find((o) => o.op === op)?.label ?? op;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as YYYY-MM-DD, or null. */
function day(v: string): Date | null {
  const m = DAY.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}
/** A real day, alone or followed by its time as the grid shows it: `2026-10-01 09:14:07.5+07`. */
const moment = (v: string) => day(v.trim().slice(0, 10)) !== null && /^(?:$|[ T]\d)/.test(v.trim().slice(10));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (d: Date) => iso(new Date(d.getTime() + 86_400_000));

/** What is wrong with the value(s), in words, or null when the filter can be used. */
export function filterProblem(kind: ValueKind, f: Pick<RowFilter, "op" | "value" | "value2">): string | null {
  if (!takesValue(f.op)) return null;
  const values = f.op === "between" ? [f.value, f.value2 ?? ""] : [f.value];
  for (const v of values) {
    if (kind === "number" && !NUMBER.test(v.trim())) return "Enter a number, such as 500 or 12.5.";
    if (kind === "date" && f.op === "eq" && !moment(v)) return "Enter a date and time as the grid shows them, such as 2026-10-01 09:14:07.";
    if (kind === "date" && f.op !== "eq" && !day(v)) return "Enter a date as YYYY-MM-DD, such as 2026-10-01.";
    if (kind === "text" && f.op !== "eq" && f.op !== "ne" && v === "") return "Enter the text to look for.";
  }
  return null;
}

export function quoteName(dialect: DialectKind, name: string): string {
  return dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** A string literal, written as the Core writes one (`sqlString`): safe whatever the session's escape settings. */
export function quoteText(dialect: DialectKind, v: string): string {
  return sqlString(dialect, v);
}

/** One filter as a SQL condition; null when its value is not usable. */
export function filterCondition(dialect: DialectKind, kind: ValueKind, f: RowFilter): string | null {
  // A quoted literal compared with the column takes the column's type on all three servers.
  // A key from a number cell goes as a number (an untyped SQLite column holding 214 is not '214'), only when it is one.
  if (f.key) return `${quoteName(dialect, f.column)} = ${f.key === "number" && NUMBER.test(f.value) ? f.value : quoteText(dialect, f.value)}`;
  if (filterProblem(kind, f) !== null) return null;
  const c = quoteName(dialect, f.column);
  const text = dialect === "postgres" ? `${c}::text` : c;
  const lit = (v: string) => (kind === "number" ? v.trim() : quoteText(dialect, kind === "date" ? v.trim() : v));
  const n = [...f.value].length;
  switch (f.op) {
    case "null":
      return `${c} IS NULL`;
    case "notNull":
      return `${c} IS NOT NULL`;
    case "isTrue":
      return dialect === "postgres" ? `${c} = TRUE` : `${c} = 1`;
    case "isFalse":
      return dialect === "postgres" ? `${c} = FALSE` : `${c} = 0`;
    case "empty":
      return `${text} = ''`;
    case "notEmpty":
      return `${text} <> ''`;
    case "contains":
    case "notContains": {
      const found =
        dialect === "postgres" ? `strpos(${text}, ${lit(f.value)}) > 0` : dialect === "mysql" ? `LOCATE(${lit(f.value)}, ${c}) > 0` : `instr(${c}, ${lit(f.value)}) > 0`;
      return f.op === "contains" ? found : `NOT (${found})`;
    }
    case "startsWith":
      return dialect === "sqlite" ? `substr(${c}, 1, ${n}) = ${lit(f.value)}` : `${dialect === "mysql" ? "LEFT" : "left"}(${text}, ${n}) = ${lit(f.value)}`;
    case "endsWith":
      return dialect === "sqlite" ? `substr(${c}, -${n}) = ${lit(f.value)}` : `${dialect === "mysql" ? "RIGHT" : "right"}(${text}, ${n}) = ${lit(f.value)}`;
    case "eq":
      return `${c} = ${lit(f.value)}`;
    case "ne":
      return `${c} <> ${lit(f.value)}`;
    case "gte":
      return `${c} >= ${lit(f.value)}`;
    case "lte":
      return `${c} <= ${lit(f.value)}`;
    case "gt":
      return `${c} > ${lit(f.value)}`;
    case "lt":
      return `${c} < ${lit(f.value)}`;
    case "between":
      if (kind === "date") return `${c} >= ${lit(f.value)} AND ${c} < ${lit(nextDay(day(f.value2 ?? "")!))}`;
      return `${c} BETWEEN ${lit(f.value)} AND ${lit(f.value2 ?? "")}`;
    // A day takes all of its times: from its start to the next day's start.
    case "on":
      return `${c} >= ${lit(f.value)} AND ${c} < ${lit(nextDay(day(f.value)!))}`;
    case "onOrAfter":
      return `${c} >= ${lit(f.value)}`;
    case "onOrBefore":
      return `${c} < ${lit(nextDay(day(f.value)!))}`;
    case "after":
      return `${c} >= ${lit(nextDay(day(f.value)!))}`;
    case "before":
      return `${c} < ${lit(f.value)}`;
  }
}

/** Every usable filter joined with AND, or null for none: the WHERE the table view fetches with. */
export function filtersSql(dialect: DialectKind, filters: RowFilter[], kindOf: (column: string) => ValueKind): string | null {
  const parts = filters.flatMap((f) => {
    const c = filterCondition(dialect, kindOf(f.column), f);
    return c === null ? [] : [filters.length > 1 ? `(${c})` : c];
  });
  return parts.length === 0 ? null : parts.join(" AND ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-10-01 as "Oct 1, 2026". */
export function prettyDay(v: string): string {
  const d = day(v);
  return d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : v;
}

/** The filter's words on its chip: column, condition and value(s). */
export function filterWords(kind: ValueKind, f: RowFilter): { column: string; condition: string; value: string } {
  const show = (v: string) => (kind === "date" ? prettyDay(v) : v);
  if (f.key) return { column: f.column, condition: "is", value: f.value };
  const value = !takesValue(f.op) ? "" : f.op === "between" ? `${show(f.value)} and ${show(f.value2 ?? "")}` : show(f.value);
  return { column: f.column, condition: opLabel(kind, f.op), value };
}

/** The sentence under the Add filter form: "Shows rows where total is at least 500." */
export function filterSentence(kind: ValueKind, f: RowFilter): string {
  const w = filterWords(kind, f);
  return `Shows rows where ${[w.column, w.condition, w.value].filter(Boolean).join(" ")}.`;
}

/** The sort's words for its kind: oldest or newest first for dates, A to Z for text, smallest first for numbers. */
export function sortWords(kind: ValueKind, descending: boolean): string {
  if (kind === "date") return descending ? "newest first" : "oldest first";
  if (kind === "number") return descending ? "largest first" : "smallest first";
  if (kind === "boolean") return descending ? "true first" : "false first";
  return descending ? "Z to A" : "A to Z";
}

/** Quick days for a date filter, worked out from `today`. */
export function quickDays(today: Date): { label: string; value: string }[] {
  const t = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  return [
    { label: "Today", value: iso(t) },
    { label: "Start of this month", value: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))) },
    { label: "30d ago", value: iso(new Date(t.getTime() - 30 * 86_400_000)) },
  ];
}

/**
 * G13: the filter a cell's value makes (Ctrl+F, Filter by this value): "is" the value (a date or timestamp too),
 * "is true" or "is false", "is NULL" for NULL, "starts with" the loaded part of a cut-short text. Binary values make
 * none.
 */
export function filterForValue(column: string, kind: ValueKind, cell: Cell): Omit<RowFilter, "id"> | null {
  if (cell.t === "null") return { column, op: "null", value: "" };
  if (cell.t === "bytes") return null;
  if (kind === "boolean") return { column, op: /^(t|true|1|y|yes)$/i.test(cell.value) ? "isTrue" : "isFalse", value: "" };
  // M11: the exact value shown, as DataGrip and DBeaver filter (`= value`); a shown offset keeps it one instant.
  if (kind === "date") return { column, op: "eq", value: cell.value };
  if (cell.t === "text" && cell.truncated) return { column, op: "startsWith", value: cell.value };
  return { column, op: "eq", value: cell.value };
}
