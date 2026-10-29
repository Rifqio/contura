import type { DialectKind } from "../api/types";

/** A server message split into its SQLSTATE (when known) and the words to show. */
export interface ServerError {
  code: string | null;
  text: string;
  /** Where the error points in the SQL that ran, from 1: PostgreSQL's "(position N)" or MySQL's "at line N". */
  position?: { line: number; column?: number };
}

/** The Core adds PostgreSQL's error offset (characters, from 1) as a " (position N)" suffix. */
const PG_POSITION = / \(position (\d+)\)$/;
const MYSQL_LINE = /\bat line (\d+)\b/;

/** The line and column of a 1-based character offset in `sql`, or undefined past its end. */
function lineColumn(sql: string, offset: number): { line: number; column: number } | undefined {
  if (offset < 1 || offset > sql.length) return undefined;
  const before = sql.slice(0, offset - 1);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") - 1 };
}

/** MySQL's server errors arrive as "Server error: `ERROR 1146 (42S02): Table 'x' doesn't exist'". */
const MYSQL_WRAPPED = /^Server error: `ERROR \d+ \(([0-9A-Z]{5})\): ([\s\S]*)'$/;
const MYSQL_BARE = /^ERROR \d+ \(([0-9A-Z]{5})\): ([\s\S]*)$/;

/**
 * The SQLSTATE and the message without its transport wrapping, for the "MySQL said 42S02" box.
 * R40: the chip shows only a code written in the server's own message (MySQL's "ERROR 1146 (42S02)").
 * The Core sends PostgreSQL and SQLite errors as the message alone, so those show no chip; nothing is guessed.
 * With the SQL that ran, `position` says where the error points; a place past the end of it is dropped.
 */
export function serverError(message: string, dialect: DialectKind, sql?: string): ServerError {
  // The suffix is the Core's own way of passing an offset, so it is read whatever the Dialect.
  if (dialect === "mysql" && !PG_POSITION.test(message)) {
    const m = MYSQL_WRAPPED.exec(message) ?? MYSQL_BARE.exec(message);
    const text = m ? m[2] : message;
    const at = MYSQL_LINE.exec(text);
    const line = at ? Number(at[1]) : 0;
    const position = line >= 1 && (sql === undefined || line <= sql.split("\n").length) ? { line } : undefined;
    return { code: m ? m[1] : null, text, ...(position && { position }) };
  }
  const at = PG_POSITION.exec(message);
  if (!at) return { code: null, text: message };
  const position = sql === undefined ? undefined : lineColumn(sql, Number(at[1]));
  return { code: null, text: message.replace(PG_POSITION, ""), ...(position && { position }) };
}

/** What the missing name is: a table ("relation", "table") or a column. */
export function missingKind(message: string): "table" | "column" | null {
  if (/^column |unknown column|no such column/i.test(message)) return "column";
  if (/relation |^table |no such table|missing FROM-clause/i.test(message)) return "table";
  return null;
}
