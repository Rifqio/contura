// Which picker a grid column gets: a calendar and time fields for dates and times, a list for enums.
import type { DialectKind } from "../../api/types";
import { type TemporalSpec, temporalSpec } from "./temporal";

export type CellPicker = { kind: "temporal"; spec: TemporalSpec } | { kind: "enum"; values: string[] };

const ESCAPES: Record<string, string> = { "0": "\0", n: "\n", r: "\r", t: "\t", Z: "\x1a" };

/**
 * The values of a MySQL `enum(...)` column type as `COLUMN_TYPE` writes it: each value quoted, a quote doubled or
 * backslashed, a backslash doubled. Null for any other type, `set(...)` included.
 */
export function parseMysqlEnum(typeName: string): string[] | null {
  const m = /^\s*enum\s*\(([\s\S]*)\)\s*$/i.exec(typeName);
  if (!m) return null;
  const body = m[1];
  const values: string[] = [];
  let i = 0;
  for (;;) {
    while (body[i] === " ") i++;
    if (body[i] !== "'") return null;
    i++;
    let value = "";
    for (;;) {
      if (i >= body.length) return null;
      const ch = body[i];
      if (ch === "\\" && i + 1 < body.length) {
        const next = body[i + 1];
        value += ESCAPES[next] ?? next;
        i += 2;
      } else if (ch === "'" && body[i + 1] === "'") {
        value += "'";
        i += 2;
      } else if (ch === "'") {
        i++;
        break;
      } else {
        value += ch;
        i++;
      }
    }
    values.push(value);
    while (body[i] === " ") i++;
    if (i === body.length) return values;
    if (body[i] !== ",") return null;
    i++;
  }
}

/**
 * The picker for a column, or null when it keeps the plain text box. `enumValues` are PostgreSQL's labels from the
 * schema index; MySQL's come from the column's full type. SQLite has no enum type.
 */
export function pickerFor(typeName: string, dialect: DialectKind, enumValues?: string[]): CellPicker | null {
  const spec = temporalSpec(typeName, dialect);
  if (spec) return { kind: "temporal", spec };
  const values = dialect === "mysql" ? parseMysqlEnum(typeName) : dialect === "postgres" && enumValues?.length ? enumValues : null;
  return values ? { kind: "enum", values } : null;
}
