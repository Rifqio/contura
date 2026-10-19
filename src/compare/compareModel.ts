// Schema Compare (step 10): the tab's words, the tick closure, the Differences tree and the
// script text, kept pure so they test without the tab.
import { DIALECT_LABEL } from "../api/client";
import type {
  CompareSummary,
  DataLoss,
  DialectKind,
  DiffItem,
  DiffKind,
  ItemId,
  NotCompared,
  NotComparedKind,
  SyncGroup,
  SyncItem,
  SyncMode,
  SyncStatement,
} from "../api/types";

export const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

export const SAME_SIDE = "Source and target are the same. Pick another target.";
export const MODEL_ONLY_SOURCE = "A Schema Model can only be the source";
export const READ_ONLY_TARGET = "Read-only: cannot be a target";
export const NOTHING_TO_APPLY = "Nothing to apply.";
export const RENAMES = "Renames show as removed plus added.";
export const SYNC_FOOT_HINT = "Unticking a change also unticks what needs it. Data-loss items start unticked.";

/** The refusal of a cross-Dialect compare, under the pickers. */
export function dialectRefusal(source: string, sourceDialect: DialectKind, target: string, targetDialect: DialectKind): string {
  return `${source} is ${DIALECT_LABEL[sourceDialect]} and ${target} is ${DIALECT_LABEL[targetDialect]}. Schema Compare needs the same Dialect; use Data Transfer to copy across Dialects.`;
}

/** Shown first when the Schema Builder's DBML has an error. */
export function dbmlErrorNotice(line: number): string {
  return `The DBML has an error on line ${line}. Compare uses the last valid version.`;
}

export function readOnlyApply(target: string): string {
  return `${target} is Read-only. The Sync Script can be copied, not applied.`;
}

/** "freight-staging to freight-prod", "orders.dbml to freight-prod". */
export function compareTitle(source: string, target: string | null): string {
  return target ? `${source} to ${target}` : "Schema Compare";
}

/** "Compared 12s ago", in compact units. */
export function comparedAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 60) return `Compared ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Compared ${m}m ago`;
  return `Compared ${Math.floor(m / 60)}h ago`;
}

const NOT_COMPARED_WORDS: Record<NotComparedKind, [string, string]> = {
  view: ["view", "views"],
  routine: ["routine", "routines"],
  trigger: ["trigger", "triggers"],
  check: ["check constraint", "check constraints"],
  generatedColumn: ["generated column", "generated columns"],
  expressionIndex: ["expression index", "expression indexes"],
  partialIndex: ["partial index", "partial indexes"],
  comment: ["comment", "comments"],
  otherSchema: ["table in another schema", "tables in another schema"],
};

/** Each kind once, with the larger of the two sides' counts, in the order the source lists them first. */
function notComparedCounts(nc: NotCompared): [NotComparedKind, number][] {
  const out = new Map<NotComparedKind, number>();
  for (const { kind, count } of [...nc.source, ...nc.target]) {
    if (count > 0) out.set(kind, Math.max(out.get(kind) ?? 0, count));
  }
  return [...out];
}

/** "2 views, 1 trigger, 1 check constraint"; null when nothing was left out. */
export function notComparedWords(nc: NotCompared): string | null {
  const parts = notComparedCounts(nc).map(([k, n]) => plural(n, ...NOT_COMPARED_WORDS[k]));
  return parts.length > 0 ? parts.join(", ") : null;
}

export function notComparedTotal(nc: NotCompared): number {
  return notComparedCounts(nc).reduce((s, [, n]) => s + n, 0);
}

/** The not-compared sentence: the Core's own line when it sends one, else the counts worded here. */
export function notComparedSentence(nc: NotCompared, coreLine: string | null): string | null {
  if (coreLine) return coreLine;
  const words = notComparedWords(nc);
  return words ? `Not compared yet: ${words}.` : null;
}

/** The line under the Differences tree. */
export function treeFootText(nc: NotCompared, coreLine: string | null = null): string {
  const line = notComparedSentence(nc, coreLine);
  return line ? `${line} ${RENAMES}` : RENAMES;
}

/** "6 tables, 1 enum, 14 indexes, 5 Foreign Keys"; kinds with none are left out, tables never. */
export function summaryText(s: CompareSummary): string {
  return [
    plural(s.tables, "table"),
    ...(s.enums > 0 ? [plural(s.enums, "enum")] : []),
    ...(s.indexes > 0 ? [plural(s.indexes, "index", "indexes")] : []),
    ...(s.foreignKeys > 0 ? [plural(s.foreignKeys, "Foreign Key")] : []),
  ].join(", ");
}

/** "billing in freight-staging and freight-prod match: 6 tables, 1 enum, 14 indexes, 5 Foreign Keys." */
export function matchText(scope: string, source: string, target: string, summary: CompareSummary): string {
  return `${scope} in ${source} and ${target} match: ${summaryText(summary)}.`;
}

/** "18,402 rows", "about 18,402 rows", "1 row". */
export function rowsText(loss: DataLoss | null): string | null {
  if (!loss) return null;
  return `${loss.exact ? "" : "about "}${plural(loss.rows, "row")}`;
}

type LossSubject = { kind: DiffKind; object: SyncItem["object"]; name: string };

/** The Sync list's second line in the danger text: "Drops values in 18,402 rows", "Drops 2,310 rows". */
export function lossLine(item: LossSubject, loss: DataLoss | null): string {
  const rows = rowsText(loss);
  if (item.object === "table") return rows ? `Drops ${rows}` : "Drops the table's rows";
  if (item.kind === "changed") return rows ? `Can change values in ${rows}` : "Can change values";
  return rows ? `Drops values in ${rows}` : "Drops its values";
}

/** The banner under the DDL panes. */
export function lossBanner(item: LossSubject, loss: DataLoss | null, target: string): string {
  const rows = rowsText(loss);
  const tail = "It starts unticked in the Sync Script.";
  if (item.object === "table") return `Dropping ${item.name} removes ${rows ? `its ${rows}` : "its rows"} on ${target}. ${tail}`;
  if (item.kind === "changed") return `Changing ${item.name} can change its values${rows ? ` in ${rows}` : ""} on ${target}. ${tail}`;
  return `Dropping ${item.name} removes its values${rows ? ` in ${rows}` : ""} on ${target}. ${tail}`;
}

/** The Production dialog's danger sentence for one ticked item: "DROP COLUMN fax removes its values in 18,402 rows." */
export function confirmLossSentence(item: LossSubject, loss: DataLoss | null): string {
  const rows = rowsText(loss);
  if (item.object === "table") return `DROP TABLE ${item.name} removes ${rows ? `its ${rows}` : "its rows"}.`;
  if (item.kind === "changed") return `Changing ${item.name} can change its values${rows ? ` in ${rows}` : ""}.`;
  return `DROP COLUMN ${item.name} removes its values${rows ? ` in ${rows}` : ""}.`;
}

/** "1 statement drops data.", "2 statements drop data." */
export function dropsDataCount(n: number): string {
  return n === 1 ? "1 statement drops data." : `${num(n)} statements drop data.`;
}

/** The count line's second sentence in the Production dialog. */
export function confirmModeNote(mode: SyncMode, enumValuesFirst = false): string | undefined {
  if (mode.kind === "transaction" && enumValuesFirst)
    return "The enum values are added first and stay. The rest run in one transaction: if one fails, none of the rest is applied.";
  if (mode.kind === "transaction") return "They run in one transaction: if one fails, nothing changes.";
  if (mode.kind === "sequential") return "They run one by one: if one fails, the ones before it stay.";
  return undefined;
}

/** "9 of 10 changes ticked. Writes on freight-prod (Production)." */
export function footerLine(ticked: number, total: number, target: string, production: boolean): string {
  const head = `${num(ticked)} of ${plural(total, "change")} ticked.`;
  return production ? `${head} Writes on ${target} (Production).` : head;
}

/** "Sync Script, 9 statements, PostgreSQL". */
export function scriptTitle(statements: number, dialect: DialectKind): string {
  return `Sync Script, ${plural(statements, "statement")}, ${DIALECT_LABEL[dialect]}`;
}

/** The Differences pane's chip: removals and narrowing changes both lose data. */
export function lossChip(n: number): string {
  return n === 1 ? "1 change loses data" : `${num(n)} changes lose data`;
}

/** "Drops data in billing.invoices.fax on freight-prod (Production)". */
export function prodNote(object: string, target: string): string {
  return `Drops data in ${object} on ${target} (Production)`;
}

/** "Statement 3 of 9" while Apply runs. */
export function progressText(done: number, total: number): string {
  return `Statement ${num(Math.min(done + 1, total))} of ${num(total)}`;
}

export const GROUP_TITLE: Record<SyncGroup, string> = { drop: "1. Drop", change: "2. Change", create: "3. Create" };

/** One line of the script pane: a comment heading or a line of a statement (by index). */
export interface ScriptLine {
  text: string;
  statement: number | null;
  /** The statement's last line, where its Production note goes. */
  last: boolean;
}

/** The script as Apply runs it, with a comment heading wherever the group changes (MySQL drops come last). */
export function scriptLines(statements: SyncStatement[]): ScriptLine[] {
  const out: ScriptLine[] = [];
  let group: SyncGroup | null = null;
  statements.forEach((s, i) => {
    if (s.group !== group) {
      if (out.length > 0) out.push({ text: "", statement: null, last: false });
      out.push({ text: `-- ${GROUP_TITLE[s.group]}`, statement: null, last: false });
      group = s.group;
    }
    // Core statements carry no separator. The shown, copied and saved script ends each one
    // with `;` so it runs as typed SQL; the hash and the Sync pass cover the Core text only.
    const lines = s.sql.replace(/\r\n/g, "\n").trimEnd().split("\n");
    lines.forEach((text, j) => {
      const last = j === lines.length - 1;
      out.push({ text: last ? `${text};` : text, statement: i, last });
    });
  });
  return out;
}

export function scriptText(statements: SyncStatement[]): string {
  return scriptLines(statements)
    .map((l) => l.text)
    .join("\n");
}

/**
 * Ticks or unticks `id` and closes over `needs`: unticking unticks every item that needs it,
 * ticking ticks every item it needs. Items Contura cannot script never get ticked.
 */
export function toggleTick(items: Pick<SyncItem, "id" | "needs" | "notScriptable">[], ticked: ReadonlySet<ItemId>, id: ItemId, on: boolean): Set<ItemId> {
  const next = new Set(ticked);
  const byId = new Map(items.map((i) => [i.id, i]));
  const start = byId.get(id);
  if (!start || (on && start.notScriptable !== null)) return next;
  const todo = [id];
  while (todo.length > 0) {
    const cur = todo.pop()!;
    if (on) {
      if (next.has(cur)) continue;
      const item = byId.get(cur);
      if (!item || item.notScriptable !== null) continue;
      next.add(cur);
      todo.push(...item.needs);
    } else {
      if (!next.has(cur) && cur !== id) continue;
      next.delete(cur);
      for (const other of items) if (other.needs.includes(cur) && next.has(other.id)) todo.push(other.id);
    }
  }
  return next;
}

/**
 * Ticking `id` would also tick what it needs: when one of those is an item Contura cannot script,
 * the tick is refused, naming the need and its reason. Null when the tick can go ahead.
 */
export function tickRefusal(items: Pick<SyncItem, "id" | "line" | "needs" | "notScriptable">[], id: ItemId): string | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const start = byId.get(id);
  if (!start) return null;
  const seen = new Set<ItemId>();
  const todo = [...start.needs];
  while (todo.length > 0) {
    const cur = todo.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const need = byId.get(cur);
    if (!need) continue;
    if (need.notScriptable !== null) return `${start.line} needs ${need.line}: ${need.notScriptable}`;
    todo.push(...need.needs);
  }
  return null;
}

// ---- the Differences tree ----

export type DiffFilter = "all" | DiffKind;

export interface TreeNode {
  id: string;
  level: number;
  kind: "scope" | "folder" | "table" | "item" | "note";
  name: string;
  detail: string;
  mark: DiffKind | null;
  /** The diff item behind the row; null for scope, folder, note and a table that only holds changes. */
  item: DiffItem | null;
  /** The table or enum whose DDL the panes show when the row is selected. */
  table: string | null;
  parent: string | null;
  hasChildren: boolean;
  /** Folders and the Not compared row. */
  count: number | null;
}

export function filterCounts(items: DiffItem[]): Record<DiffFilter, number> {
  const c = { all: items.length, added: 0, removed: 0, changed: 0 };
  for (const i of items) c[i.kind] += 1;
  return c;
}

/** The table an item belongs to, or the table or enum it is. */
export function itemTable(i: Pick<DiffItem, "path">): string {
  return i.path.table ?? i.path.name;
}

/**
 * The tree: the scope, then Tables (each table with its changed columns, keys and indexes under it)
 * and Enums, then Not compared. `filter` keeps the items of one mark; folders and tables with
 * nothing left are dropped.
 */
export function buildTree(items: DiffItem[], filter: DiffFilter, scope: string, notCompared: number): TreeNode[] {
  const keep = (i: DiffItem) => filter === "all" || i.kind === filter;
  const tables = new Map<string, { own: DiffItem | null; children: DiffItem[] }>();
  const enums: DiffItem[] = [];
  for (const i of items) {
    if (i.object === "enum") {
      enums.push(i);
      continue;
    }
    const name = itemTable(i);
    const entry = tables.get(name) ?? { own: null, children: [] };
    if (i.object === "table") entry.own = i;
    else entry.children.push(i);
    tables.set(name, entry);
  }
  const rows: TreeNode[] = [];
  const scopeId = "scope";
  const tableRows: TreeNode[] = [];
  for (const name of [...tables.keys()].sort((a, b) => a.localeCompare(b))) {
    const { own, children } = tables.get(name)!;
    const kids = children.filter(keep);
    if (kids.length === 0 && !(own && keep(own))) continue;
    const id = own?.id ?? `table:${name}`;
    const mark: DiffKind = own?.kind ?? "changed";
    const detail = own && (own.kind !== "changed" || children.length === 0) ? own.detail : plural(children.length + (own ? 1 : 0), "change");
    tableRows.push({ id, level: 2, kind: "table", name, detail, mark, item: own, table: name, parent: "folder:tables", hasChildren: kids.length > 0, count: null });
    for (const k of kids) {
      tableRows.push({ id: k.id, level: 3, kind: "item", name: k.path.name, detail: k.detail, mark: k.kind, item: k, table: name, parent: id, hasChildren: false, count: null });
    }
  }
  const enumRows: TreeNode[] = enums
    .filter(keep)
    .sort((a, b) => a.path.name.localeCompare(b.path.name))
    .map((e) => ({ id: e.id, level: 2, kind: "item", name: e.path.name, detail: e.detail, mark: e.kind, item: e, table: e.path.name, parent: "folder:enums", hasChildren: false, count: null }));
  if (tableRows.length > 0 || enumRows.length > 0) {
    rows.push({ id: scopeId, level: 0, kind: "scope", name: scope, detail: "", mark: null, item: null, table: null, parent: null, hasChildren: true, count: null });
  }
  if (tableRows.length > 0) {
    const n = tableRows.filter((r) => r.level === 2).length;
    rows.push({ id: "folder:tables", level: 1, kind: "folder", name: "Tables", detail: "", mark: null, item: null, table: null, parent: scopeId, hasChildren: true, count: n });
    rows.push(...tableRows);
  }
  if (enumRows.length > 0) {
    rows.push({ id: "folder:enums", level: 1, kind: "folder", name: "Enums", detail: "", mark: null, item: null, table: null, parent: scopeId, hasChildren: true, count: enumRows.length });
    rows.push(...enumRows);
  }
  if (notCompared > 0) {
    rows.push({ id: "note:notCompared", level: 0, kind: "note", name: "Not compared", detail: "", mark: null, item: null, table: null, parent: null, hasChildren: false, count: notCompared });
  }
  return rows;
}

/** The rows on screen: none under a collapsed row. */
export function visibleRows(rows: TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow !== null && r.level > hideBelow) continue;
    hideBelow = null;
    out.push(r);
    if (r.hasChildren && collapsed.has(r.id)) hideBelow = r.level;
  }
  return out;
}

/** The first row a fresh compare selects: the first item, else the first table. */
export function firstSelectable(rows: TreeNode[]): string | null {
  return (rows.find((r) => r.kind === "item" || r.kind === "table") ?? null)?.id ?? null;
}
