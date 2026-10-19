// Backup and Restore's words and numbers (spec step 9 "Behaviour"): count lines, sizes, the SHA-256
// in groups of four, default names and the end lines.
import type { BackupCounts, DialectKind, RestoreCheck, RestoreSkipped } from "../api/types";
import { bytesText, timeText } from "../jobs/exportText";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** A size with one decimal from a MB up: "48.2 MB", "10.1 MB", "1.3 GB"; smaller sizes as Explorer shows them. */
export function sizeText(bytes: number): string {
  if (bytes < MB) return bytesText(bytes);
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** "Read 10.1 of 48.2 MB": both in the total's unit. */
export function ofSizeText(done: number, total: number): string {
  if (total < MB) return `${bytesText(done)} of ${bytesText(total)}`;
  const unit = total < GB ? MB : GB;
  return `${(done / unit).toFixed(1)} of ${(total / unit).toFixed(1)} ${unit === MB ? "MB" : "GB"}`;
}

/** The SHA-256 in groups of four with the middle elided: "9f3c 1a7e ... e21a". */
export function shaText(sha256: string): string {
  const h = sha256.toLowerCase();
  return `${h.slice(0, 4)} ${h.slice(4, 8)} ... ${h.slice(-4)}`;
}

/** The count line beside each tick of What goes in. `scope` is the schema (PostgreSQL) or database. */
export function countLines(c: BackupCounts, scope: string) {
  return {
    tables: `${plural(c.tables, "table", "tables")} in ${scope}`,
    indexes: `${plural(c.indexes, "index", "indexes")}, ${plural(c.foreignKeys, "Foreign Key", "Foreign Keys")}`,
    enums: `${plural(c.enums, "enum", "enums")}, ${plural(c.sequences, "sequence", "sequences")}`,
    definitions: `${plural(c.views, "view", "views")}, ${plural(c.functions, "function", "functions")}, ${plural(c.triggers, "trigger", "triggers")}, from the server's own definitions`,
    rows: plural(c.rows, "row", "rows"),
  };
}

export function notIncludedText(items: string[]): string {
  return `Not included: ${items.join(", ")}. The file header lists them so a restore can say what to add by hand.`;
}

export function partialHint(name: string): string {
  return `Written as ${name}.partial and renamed when complete.`;
}

export function snapshotLine(database: string): string {
  return `One snapshot: the whole file shows ${database} at the moment the backup starts.`;
}

/** MySQL tables outside the snapshot: "orders uses MyISAM, so its rows may not match the moment the backup starts." */
export function myisamLine(tables: string[]): string | null {
  if (tables.length === 0) return null;
  if (tables.length === 1) return `${tables[0]} uses MyISAM, so its rows may not match the moment the backup starts.`;
  const names = `${tables.slice(0, -1).join(", ")} and ${tables[tables.length - 1]}`;
  return `${names} use MyISAM, so their rows may not match the moment the backup starts.`;
}

export function estimateLine(bytes: number, rows: number, tables: number): string {
  return `About ${bytesText(bytes)}, ${plural(rows, "row", "rows")} in ${plural(tables, "table", "tables")}`;
}

export const BACKUP_PRODUCTION_BANNER = "The file is plain text and holds Production rows. Keep it somewhere safe.";
/** R8: why the MySQL "Indexes and Foreign Keys" tick is on and cannot be changed. */
export const MYSQL_INDEXES_HINT = "On MySQL these are part of each table's CREATE TABLE.";

export const BACKUP_CANCELLED = "Backup cancelled. The unfinished file was deleted.";

export function backupFooter(connection: string): string {
  return `Backup only reads ${connection}, so no confirmation is needed.`;
}

/** The end toast: "Backed up freight to freight-2026-10-17.sql, 48.2 MB". */
export function backedUpText(database: string, file: string, bytes: number): string {
  return `Backed up ${database} to ${file}, ${sizeText(bytes)}`;
}

/** "1017" for 17 October. */
export function mmdd(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Into a new database's default name: `<database>_restore_<mmdd>`. */
export function restoreName(database: string, d: Date): string {
  return `${database}_restore_${mmdd(d)}`;
}

export const DIALECT_NAME: Record<DialectKind, string> = { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite" };

/** "2026-10-16 22:00 UTC" from the header's `2026-10-16T22:00:00Z`. */
export function takenText(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/** One check line with its icon. */
export interface CheckLine {
  ok: boolean;
  text: string;
}

/** Skipped statements by kind: "2 GRANT statements are skipped. Tick Run as is to keep them." */
function skippedLines(skipped: RestoreSkipped[], runAsIs: boolean): CheckLine[] {
  const byKind = new Map<string, number>();
  for (const s of skipped) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  return [...byKind].map(([kind, count]) => {
    const what = `${n(count)} ${kind} ${count === 1 ? "statement" : "statements"}`;
    return runAsIs
      ? { ok: true, text: `${what} ${count === 1 ? "runs" : "run"} as is.` }
      : { ok: false, text: `${what} ${count === 1 ? "is" : "are"} skipped. Tick Run as is to keep them.` };
  });
}

/** The Checks list, in the spec's order. */
export function checkLines(check: RestoreCheck, runAsIs: boolean): CheckLine[] {
  const target = check.targetName;
  const lines: CheckLine[] = [];
  const from = check.header?.dialect ?? check.targetDialect;
  lines.push(
    check.dialectOk
      ? { ok: true, text: `Same Dialect as ${target}: ${DIALECT_NAME[check.targetDialect]}` }
      : { ok: false, text: `This Backup is from ${DIALECT_NAME[from]}. Restore it on a ${DIALECT_NAME[from]} Connection, or use Data Transfer.` },
  );
  if (check.versionNote) lines.push({ ok: false, text: check.versionNote });
  else if (check.header && check.dialectOk) {
    lines.push({ ok: true, text: `The backup is from ${DIALECT_NAME[from]} ${check.header.serverVersion} and ${target} runs ${check.targetVersion}.` });
  }
  if (check.refused.length === 0) lines.push({ ok: true, text: `${plural(check.statements, "statement", "statements")} read, none refused` });
  else for (const r of check.refused) lines.push({ ok: false, text: `Line ${n(r.line)}: ${r.kind} is not run by Restore.` });
  lines.push(...skippedLines(check.skipped, runAsIs));
  if (check.existingTables.length > 0) {
    const db = check.header?.database ?? target;
    lines.push({ ok: false, text: `${db} already has ${plural(check.existingTables.length, "table", "tables")} with these names` });
  }
  for (const ext of check.missingExtensions) {
    lines.push({ ok: false, text: `${ext} is not installed on ${target}. Functions that use it will fail.` });
  }
  if (check.header) lines.push(check.trailerOk ? { ok: true, text: "The trailer is present." } : { ok: false, text: "The trailer is missing." });
  return lines;
}

/** The file can be restored: same Dialect, nothing refused, a trailer when it is a Contura Backup. */
export function restorable(check: RestoreCheck): boolean {
  return check.dialectOk && check.refused.length === 0 && (check.header === null || check.trailerOk);
}

/** "6 tables, 742,818 rows" from the header. */
export function contentsText(rows: { table: string; rows: number }[]): string {
  const total = rows.reduce((s, r) => s + r.rows, 0);
  return `${plural(rows.length, "table", "tables")}, ${plural(total, "row", "rows")}`;
}

/**
 * The confirm count line: "Creates freight_restore_1017, then 6 tables, 14 indexes and 5 Foreign Keys,
 * then runs 1,472 INSERT statements (742,818 rows). All of it writes."
 */
export function restoreCountLine(
  newDatabase: string | null,
  creates: { tables: number; indexes: number; foreignKeys: number },
  inserts: number,
  rows: number,
): string {
  const objects = [
    plural(creates.tables, "table", "tables"),
    plural(creates.indexes, "index", "indexes"),
    plural(creates.foreignKeys, "Foreign Key", "Foreign Keys"),
  ];
  const what = `${objects.slice(0, -1).join(", ")} and ${objects[objects.length - 1]}`;
  const head = newDatabase ? `Creates ${newDatabase}, then ${what}` : `Creates ${what}`;
  const tail = inserts > 0 ? `, then runs ${plural(inserts, "INSERT statement", "INSERT statements")} (${plural(rows, "row", "rows")})` : "";
  return `${head}${tail}. All of it writes.`;
}

export function fingerprintBanner(bytes: number, sha256: string): string {
  return `Checked file: ${sizeText(bytes)}, SHA-256 ${shaText(sha256)}. If the file changes before the run, Contura asks again.`;
}

export function replaceBanner(tables: number, database: string, rows: number | null): string {
  const withRows = rows === null ? "" : ` with ${plural(rows, "row", "rows")}`;
  return `Replace drops ${plural(tables, "table", "tables")} in ${database}${withRows}. Tables in ${database} that the file does not hold are left alone.`;
}

export const MYSQL_REPLACE_LINE = "MySQL cannot undo DROP TABLE. If the restore fails, the dropped tables are gone.";

/** The end line: "Restored freight into freight_restore_1017: 6 tables, 742,818 rows in 3m 34s. Row counts match the file." */
export function restoredText(from: string | null, into: string, tables: number, rows: number, ms: number, countsMatch: boolean): string {
  const line = `Restored ${from ? `${from} ` : ""}into ${into}: ${plural(tables, "table", "tables")}, ${plural(rows, "row", "rows")} in ${timeText(ms)}.`;
  return countsMatch ? `${line} Row counts match the file.` : line;
}

export function readOnlyReason(connection: string): string {
  return `${connection} is Read-only. Restore is not allowed here.`;
}

/**
 * A cancelled Restore. PostgreSQL and SQLite roll back: "Nothing was restored."; MySQL committed each
 * DDL statement as it ran, so it says how far it got. Into a new database adds that it was removed.
 */
/** The statements a Restore runs (R32 M-3): every statement read, less the skipped ones unless Run as is. Its "n of m" counts in this set. */
export function runStatements(check: RestoreCheck, runAsIs: boolean): number {
  return runAsIs ? check.statements : Math.max(0, check.statements - check.skipped.length - (check.skippedMore ?? 0));
}

/** `yyyy-mm-dd` on the user's clock (R25). */
export function localDate(d: Date): string {
  const two = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function restoreStoppedText(dialect: DialectKind, newDatabase: string | null, ran: number, total: number | null): string {
  const what =
    dialect === "mysql"
      ? total !== null
        ? `${n(ran)} of ${plural(total, "statement", "statements")} ran.`
        : `${plural(ran, "statement", "statements")} ran.`
      : "Nothing was restored.";
  return `Restore cancelled. ${what}${newDatabase ? ` ${newDatabase} was removed.` : ""}`;
}
