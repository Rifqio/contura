// UX step 8 (security): the one place the UI writes a SQL string literal. It mirrors the Core's `common.rs::sql_string`
// byte for byte (a shared fixture tests both), so a value reads as itself whatever the session's settings:
// - Postgres: a value holding a backslash is an `E'..'` string with backslashes doubled, so `\'` never ends it when
//   `standard_conforming_strings` is off; quotes are doubled either way.
// - MySQL: a value holding a backslash goes as `_utf8mb4 X'<hex>'`, which has no escapes, with NO_BACKSLASH_ESCAPES on
//   or off; otherwise quotes are doubled.
// - SQLite: quotes are doubled; it has no backslash escapes.
import type { DialectKind } from "../api/types";

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

export function sqlString(dialect: DialectKind, s: string): string {
  if (dialect === "mysql" && s.includes("\\")) return `_utf8mb4 X'${hex(s)}'`;
  const quoted = s.replace(/'/g, "''");
  if (dialect === "postgres" && s.includes("\\")) return `E'${quoted.replace(/\\/g, "\\\\")}'`;
  return `'${quoted}'`;
}
