import type { DialectKind } from "../api/types";

/** A server message split into its SQLSTATE (when known) and the words to show. */
export interface ServerError {
  code: string | null;
  text: string;
}

/** MySQL's server errors arrive as "Server error: `ERROR 1146 (42S02): Table 'x' doesn't exist'". */
const MYSQL_WRAPPED = /^Server error: `ERROR \d+ \(([0-9A-Z]{5})\): ([\s\S]*)'$/;
const MYSQL_BARE = /^ERROR \d+ \(([0-9A-Z]{5})\): ([\s\S]*)$/;

/**
 * The SQLSTATE and the message without its transport wrapping, for the "MySQL said 42S02" box.
 * R40: the chip shows only a code written in the server's own message (MySQL's "ERROR 1146 (42S02)").
 * The Core sends PostgreSQL and SQLite errors as the message alone, so those show no chip; nothing is guessed.
 */
export function serverError(message: string, dialect: DialectKind): ServerError {
  if (dialect === "mysql") {
    const m = MYSQL_WRAPPED.exec(message) ?? MYSQL_BARE.exec(message);
    if (m) return { code: m[1], text: m[2] };
    return { code: null, text: message };
  }
  return { code: null, text: message };
}

/** What the missing name is: a table ("relation", "table") or a column. */
export function missingKind(message: string): "table" | "column" | null {
  if (/^column |unknown column|no such column/i.test(message)) return "column";
  if (/relation |^table |no such table|missing FROM-clause/i.test(message)) return "table";
  return null;
}
