import type {
  CheckReport,
  ColumnMap,
  ConnectionConfig,
  DialectKind,
  FileSummary,
  ImportOptions,
  InsertShape,
  ObjectPath,
  PlannedColumn,
  ScriptPlan,
  ScriptStatement,
} from "../api/types";

/** What an Import tab writes into: one table, or a database for a SQL file (it names its own tables). */
export type ImportTarget = { kind: "table"; path: ObjectPath } | { kind: "database"; database: string };

const n = (v: number) => v.toLocaleString("en-US");
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/** The table as the header and the footer name it: `public.menu_items`, `shop.menu_items`. */
export function qualifiedName(path: ObjectPath): string {
  return `${path.schema ?? path.database}.${path.name}`;
}

/** Case, `_`, `-` and spaces do not count when names are compared. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

/**
 * Match by name: one entry per file column. Each target takes one column, the first file
 * column wins, and generated columns never match. `src/jobs/match_cases.json` pins the rule.
 */
export function matchByName(file: string[], targets: PlannedColumn[]): ColumnMap[] {
  const taken = new Set<string>();
  return file.map((header, i) => {
    const key = nameKey(header);
    const hit = targets.find((t) => !t.generated && !taken.has(t.into) && nameKey(t.into) === key);
    if (hit) taken.add(hit.into);
    return { fileColumn: i, into: hit?.into ?? null, byHand: false };
  });
}

/** 212 KB, 1.5 MB, 3 GB. */
export function bytesText(bytes: number): string {
  const one = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (bytes >= 1024 ** 3) return `${one(bytes / 1024 ** 3)} GB`;
  if (bytes >= 1024 ** 2) return `${one(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${n(Math.round(bytes / 1024))} KB`;
  return plural(bytes, "byte", "bytes");
}

/** "1,204 rows", or an estimate: "about 4.2 million rows". */
function rowsText(rows: number, exact: boolean): string {
  if (exact) return plural(rows, "row", "rows");
  if (rows >= 1_000_000) return `about ${(rows / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} million rows`;
  return `about ${n(rows >= 1000 ? Math.round(rows / 100) * 100 : rows)} rows`;
}

/** The hint under the file path: "1,204 rows, 6 columns, 212 KB". */
export function fileHint(s: FileSummary): string {
  return `${rowsText(s.rowsEstimate.rows, s.rowsEstimate.exact)}, ${plural(s.header.length, "column", "columns")}, ${bytesText(s.bytes)}`;
}

/** The import footer line, per the Commit option, the table's engine and the Core's one-transaction flag. */
export function footerText(
  plan: { table: string; warnings: string[]; oneTransaction?: boolean },
  opts: ImportOptions,
  rows: number,
  _dialect: DialectKind,
  exact = true,
): string {
  const writes = `Writes ${rowsText(rows, exact)} into ${plan.table}`;
  const keeps = nonTransactional(plan.warnings);
  if (keeps) return `${writes}. ${keeps.replace(/\.$/, "")}.`;
  if (opts.commit.kind === "every") {
    return `${writes}, committing every ${n(opts.commit.rows)} rows. If the import stops, the rows committed before it stay.`;
  }
  if (!oneTransactionOf(plan, opts)) return `${writes}. If the import stops, the rows written before it stay.`;
  return `${writes} in one transaction. Cancel rolls everything back.`;
}

/** The run button: "Import 1,204 rows", or "Import on PROD..." that opens the confirmation. */
export function runLabel(conn: Pick<ConnectionConfig, "production">, rows: number, exact = true): string {
  return conn.production ? "Import on PROD..." : `Import ${rowsText(rows, exact)}`;
}

/**
 * The Core's warning for a MyISAM (or other non-transactional) target, which keeps what was written
 * before a failure. Matched by its wording ("{table} uses MyISAM: rows written before a failure
 * stay"): a change there must change this pattern too.
 */
function nonTransactional(warnings: string[]): string | undefined {
  return warnings.find((w) => /rows written before a failure stay\.?$/.test(w));
}

/**
 * The import runs in one transaction. The current Commit option comes first, so a plan made
 * before Commit changed never claims a rollback; then the plan's flag, else no
 * non-transactional warning.
 */
export function oneTransactionOf(plan: { warnings: string[]; oneTransaction?: boolean }, opts: ImportOptions): boolean {
  return opts.commit.kind === "once" && (plan.oneTransaction ?? nonTransactional(plan.warnings) === undefined);
}

/** For a SQL file: the plan's flag, else neither its own transactions nor MySQL DDL. */
export function scriptOneTransaction(plan: ScriptPlan, dialect: DialectKind): boolean {
  return plan.oneTransaction ?? (!plan.ownTransactions && !(dialect === "mysql" && plan.hasDdl));
}

/** After a stop that kept rows, "500 rows were written before the stop and stay in menu_items." */
export function writtenText(rows: number, into: string): string {
  return rows === 1
    ? `1 row was written before the stop and stays in ${into}.`
    : `${n(rows)} rows were written before the stop and stay in ${into}.`;
}

/** "212 KB, SHA-256 4be0 91c2 ... 7d1f". */
export function fingerprintText(bytes: number, sha256: string): string {
  const h = sha256.toLowerCase();
  return `${bytesText(bytes)}, SHA-256 ${h.slice(0, 4)} ${h.slice(4, 8)} ... ${h.slice(-4)}`;
}

/** The check pass banner: "All 1,204 rows fit", or "2 rows will fail" and the first problems. */
export function checkBanner(report: CheckReport): string {
  if (report.failing === 0) return `All ${plural(report.rows, "row", "rows")} fit`;
  const problems = report.first
    .slice(0, 3)
    .map((p, i) => `${i === 0 ? `Row ${n(p.fileRow)} of the file` : `Row ${n(p.fileRow)}`}: ${p.message.replace(/\.$/, "")}.`);
  const head = `${plural(report.failing, "row", "rows")} will fail.`;
  return [head, ...problems, "Fix the file, or choose Skip the row."].join(" ");
}

/** The keyword that names a statement the summary groups: GRANT, SET GLOBAL, DROP DATABASE. */
function keyword(s: ScriptStatement): string {
  const words = s.text.trim().split(/\s+/).map((w) => w.toUpperCase());
  return ["CREATE", "ALTER", "DROP", "SET"].includes(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
}

/** "2 GRANT are skipped.", with "and 500 more" for the statements past the list the Core sends. */
function grouped(list: ScriptStatement[], more: number, verb: string): string | null {
  if (list.length === 0 && more === 0) return null;
  const counts = new Map<string, number>();
  for (const s of list) counts.set(keyword(s), (counts.get(keyword(s)) ?? 0) + 1);
  const parts = [...counts].map(([k, c]) => `${n(c)} ${k}`);
  if (more > 0) parts.push(`${n(more)} more`);
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${joined} ${list.length + more === 1 ? "is" : "are"} ${verb}.`;
}

/** "1,503 statements: 31 create, 1,472 insert. 2 GRANT are skipped." */
export function scriptSummary(plan: ScriptPlan): string {
  const skippedMore = plan.skippedMore ?? 0;
  const refusedMore = plan.refusedMore ?? 0;
  const other = plan.statements - plan.creates - plan.inserts - plan.skipped.length - skippedMore - plan.refused.length - refusedMore;
  const kinds = [`${n(plan.creates)} create`, `${n(plan.inserts)} insert`, ...(other > 0 ? [`${n(other)} other`] : [])];
  return [`${plural(plan.statements, "statement", "statements")}: ${kinds.join(", ")}.`, grouped(plan.skipped, skippedMore, "skipped"), grouped(plan.refused, refusedMore, "refused")]
    .filter(Boolean)
    .join(" ");
}

const OWN_TRANSACTIONS =
  "This file manages its own transactions, so Contura runs it as written. If a statement fails, the ones before it stay.";
const MYSQL_DDL = "MySQL commits each CREATE, ALTER and DROP as it runs. If a later statement fails, those stay.";

/**
 * The SQL file footer's notes beyond its run line: own transactions, MySQL DDL, or statements the
 * Core runs apart (its one-transaction flag). The Production confirmation shows these.
 */
export function scriptNotes(plan: ScriptPlan, dialect: DialectKind): string[] {
  if (plan.ownTransactions) return [OWN_TRANSACTIONS];
  if (dialect === "mysql" && plan.hasDdl) return [MYSQL_DDL];
  if (!scriptOneTransaction(plan, dialect)) return ["Runs each statement on its own. If a statement fails, the ones before it stay."];
  return [];
}

/** The footer lines of a SQL file import. */
export function scriptFooter(plan: ScriptPlan, dialect: DialectKind, database: string): string[] {
  if (plan.ownTransactions) return [OWN_TRANSACTIONS];
  const runs = `Runs ${plural(plan.statements, "statement", "statements")} in ${database}`;
  // The flag first: only a one-transaction run promises a rollback.
  if (scriptOneTransaction(plan, dialect)) return [`${runs} in one transaction. Cancel rolls everything back.`];
  if (dialect === "mysql" && plan.hasDdl) return [`${runs}. If the import stops, what ran before it stays.`, MYSQL_DDL];
  return [`${runs}, each on its own. If a statement fails, the ones before it stay.`];
}

/** The first line of the Production confirmation of an import. */
export function confirmSummary(table: string, shape: InsertShape, opts: ImportOptions, oneTransaction = true): string {
  const how =
    opts.commit.kind === "every" ? `, committing every ${n(opts.commit.rows)} rows` : oneTransaction ? ", in one transaction" : "";
  return `Inserts ${plural(shape.rows, "row", "rows")} into ${table} in ${plural(shape.statements, "statement", "statements")}${how}.`;
}

/** "Imported 1,204 rows into menu_items in 2s": whole seconds under ten, then the compact form. */
export function secondsText(ms: number): string {
  if (ms < 9950) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const rest = secs % 60;
  return rest === 0 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 60)}m ${rest}s`;
}

/** The row as a counted phrase, for the run view and the end line. */
export function rowsPhrase(rows: number): string {
  return plural(rows, "row", "rows");
}
