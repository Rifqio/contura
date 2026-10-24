// ER build C (erd-ux-research 5.4, decision 4): a relationship drawn from a column. Dropped on a column it joins the
// two columns at once, with the cardinality the keys give (a key target is the "one" end, as draw.io infers it and
// MySQL Workbench draws a foreign key); dropped on a table's header it adds the foreign key column to the source
// table and joins it to the target's key (Workbench's `%table%_%column%` name). Pure planning: FlowTab runs the ops.
import { type ColumnFlag, columnsWritable, type FlowArrow, type FlowDoc, type FlowNode, sqlFreeName } from "../lang/flow/model";
import type { FlowEditOp } from "../lang/flow/edits";
import { ER_MESSAGES, splitRow } from "./erCanvas";
import { KIND_ROW } from "./kindLayout";

/** A column's port handle id names it `col:<column>:<side>`; the port string the canvas reports is `col:<column>`. */
export const COLUMN_PORT = "col:";

/** The column a port names, or null for a table's own ports (r, l, t, b). */
export function portColumn(port: string): string | null {
  return port.startsWith(COLUMN_PORT) ? port.slice(COLUMN_PORT.length) : null;
}

export const RELATE_MESSAGES = {
  made: (from: string, arrow: FlowArrow, to: string) => `Linked ${from} ${arrow} ${to}. Right-click the line to change it.`,
  added: (column: string, to: string) => `Added ${column} and linked it to ${to}, in one undo step.`,
  itself: "A column cannot refer to itself. Drop on another column.",
  linked: "These columns are already linked.",
  types: (a: string, ta: string, b: string, tb: string) => `No line made: ${a} is ${ta} and ${b} is ${tb}. A relationship joins columns of one type.`,
  noKey: (table: string) => `${table} has no primary key. Drop on one of its columns instead.`,
  noKeyRef: (table: string) => `${table} has no primary key to refer to.`,
  ownHeader: "Pick another table.",
  wholeTable: (table: string, why: "key" | "body") =>
    why === "key" ? `Dropped on ${table}. It has no key, so the line joins the table.` : `Dropped on ${table}, not on a column, so the line joins the table.`,
  nowhere: "No line made: drop on a column of another table.",
  pick: "Pick the column it refers to: click, or arrows and Enter.",
  ownTable: "No line made: that is this column's own table. Drop on one of its columns for a loop.",
  alsoNode: (name: string) => `No line made: ${name} is also the name of a table, so the line would join that table.`,
  gone: (name: string) => `${name} is no longer in the text.`,
};

/** Where a drop landed on an ER card: its header, one of its rows, or elsewhere on it. */
export type CardHit = { table: string; column: string | null } | null;

/**
 * The part of an ER card at `y` (flow px) in a card whose top is `top`, its rows scrolled by `scroll`: its header
 * (column null), a row's column, or null below its rows.
 */
export function hitRow(t: FlowNode, top: number, y: number, scroll = 0): CardHit {
  const dy = y - top;
  if (dy < 0) return null;
  // The 1 px border and the 32 px header.
  if (dy < 33) return { table: t.name, column: null };
  const row = Math.floor((dy - 36 + scroll) / KIND_ROW);
  const rows = t.rows ?? [];
  if (row < 0) return { table: t.name, column: rows.length ? splitRow(rows[0]).name : null };
  return row < rows.length ? { table: t.name, column: splitRow(rows[row]).name } : null;
}

/** A type's family, so `int` matches `integer` and `serial`, and `varchar(255)` matches `text`, as a foreign key allows. */
function typeFamily(type: string): string {
  const base = type.toLowerCase().replace(/\(.*$/, "").replace(/\s+/g, " ").trim();
  // Fix round 2, M6: every integer width joins any other (PostgreSQL, MySQL and SQLite accept that foreign key), as
  // do the text kinds and the decimal kinds; different families are still refused.
  if (["int", "integer", "int2", "int4", "int8", "smallint", "mediumint", "tinyint", "bigint", "serial", "serial2", "serial4", "serial8", "smallserial", "bigserial"].includes(base)) return "int";
  if (["text", "varchar", "character varying", "char", "character", "nvarchar", "nchar", "string", "citext"].includes(base)) return "text";
  if (["numeric", "decimal"].includes(base)) return "numeric";
  if (["bool", "boolean"].includes(base)) return "boolean";
  return base;
}

/** The type a new foreign key column takes from the key it refers to: a serial key is referred to by its integer. */
function referringType(type: string): string {
  const base = type.toLowerCase().trim();
  if (base === "serial" || base === "serial4") return "int";
  if (base === "bigserial" || base === "serial8") return "bigint";
  if (base === "smallserial" || base === "serial2") return "smallint";
  return type;
}

type Col = { name: string; type: string; flags: readonly ColumnFlag[] };

function columnOf(t: FlowNode, name: string): Col | null {
  const rows = t.rows ?? [];
  for (let i = 0; i < rows.length; i++) {
    const r = splitRow(rows[i]);
    if (r.name === name) return { ...r, flags: t.rowFlags?.[i] ?? [] };
  }
  return null;
}

const isKey = (c: Col) => c.flags.includes("pk") || c.flags.includes("unique");

/** What a drop does: the ops to run (one batch, one undo step) and what the strip says, or why nothing was made. */
export type RelatePlan = { ops: FlowEditOp[]; message: string; select?: { table: string; column: string } } | { refuse: string };

const tableOf = (doc: FlowDoc, name: string) => doc.nodes.find((n) => n.name === name && (n.kind === "entity" || n.kind === "weak"));

/** A table's key: its primary key column, else a column named id (the board's rule), else null. */
export function keyOf(t: FlowNode): Col | null {
  const rows = (t.rows ?? []).map((r, i) => ({ ...splitRow(r), flags: t.rowFlags?.[i] ?? [] }));
  return rows.find((c) => c.flags.includes("pk")) ?? rows.find((c) => c.name.toLowerCase() === "id") ?? null;
}

/**
 * Why two columns cannot be joined (the same column, types of different families, already joined either way), or
 * null. One rule for a new drop and for a line end dragged onto a column (fix round 1).
 */
export function joinRefusal(doc: FlowDoc, a: { table: string; column: string }, b: { table: string; column: string }, except = -1): string | null {
  const src = tableOf(doc, a.table);
  const dst = tableOf(doc, b.table);
  const ca = src && columnOf(src, a.column);
  const cb = dst && columnOf(dst, b.column);
  if (!ca) return RELATE_MESSAGES.gone(`${a.table}.${a.column}`);
  if (!cb) return RELATE_MESSAGES.gone(`${b.table}.${b.column}`);
  if (a.table === b.table && a.column === b.column) return RELATE_MESSAGES.itself;
  // A column end that is also a node's name would read back as that node (fix round 2, M5).
  for (const e of [a, b]) if (doc.nodes.some((n) => n.name === `${e.table}.${e.column}`)) return RELATE_MESSAGES.alsoNode(`${e.table}.${e.column}`);
  if (ca.type && cb.type && typeFamily(ca.type) !== typeFamily(cb.type)) return RELATE_MESSAGES.types(`${a.table}.${a.column}`, ca.type, `${b.table}.${b.column}`, cb.type);
  const joined = (x: typeof a, y: typeof b) => (l: FlowDoc["links"][number]) => l.from === x.table && l.fromColumn === x.column && l.to === y.table && l.toColumn === y.column;
  if (doc.links.some((l, i) => i !== except && (joined(a, b)(l) || joined(b, a)(l)))) return RELATE_MESSAGES.linked;
  return null;
}

/**
 * A drag from `from`'s column let go on `to`: a column joins the two; a header (`column` null) joins the column to
 * that table's key (board ER interactions, coordinator ruling 1).
 */
export function planRelationship(doc: FlowDoc, from: { table: string; column: string }, to: { table: string; column: string | null }): RelatePlan {
  const src = tableOf(doc, from.table);
  const dst = tableOf(doc, to.table);
  if (!src) return { refuse: RELATE_MESSAGES.gone(from.table) };
  if (!dst) return { refuse: RELATE_MESSAGES.gone(to.table) };
  if (!columnsWritable(src.name) || !columnsWritable(dst.name)) return { refuse: ER_MESSAGES.notWritable };
  const a = columnOf(src, from.column);
  if (!a) return { refuse: RELATE_MESSAGES.gone(`${from.table}.${from.column}`) };
  let column = to.column;
  // A loop is made on purpose, column to column; a drop on its own table's header is refused (fix round 2, M1).
  if (column === null && dst.name === src.name) return { refuse: RELATE_MESSAGES.ownTable };
  if (column === null) {
    const key = keyOf(dst);
    if (!key) return { refuse: RELATE_MESSAGES.noKey(dst.name) };
    column = key.name;
  }
  const why = joinRefusal(doc, from, { table: dst.name, column });
  if (why) return { refuse: why };
  const b = columnOf(dst, column)!;
  const an = `${src.name}.${a.name}`;
  const bn = `${dst.name}.${b.name}`;
  // The keys give the ends: a key is the "one" end, and with no key at either end the target is (the board's
  // `*--1`). The column that refers is written first, as the board writes `invoices.customer_id *--1
  // customers.id`, so a drag from a key the other way round turns.
  const ak = isKey(a);
  const bk = isKey(b);
  let left = an;
  let right = bn;
  let arrow: FlowArrow = "*--1";
  if (ak && bk) arrow = "1--1";
  else if (ak) {
    left = bn;
    right = an;
  }
  return { ops: [{ op: "addLink", from: left, to: right, arrow }], message: RELATE_MESSAGES.made(left, arrow, right) };
}

/**
 * The Rails inflector's singular rules (ActiveSupport `inflections.rb`), latest first, as Rails applies them; the
 * irregulars and uncountables come before them. Ported as the convention (fix round 2, I4), never extended here.
 */
const SINGULAR_RULES: [RegExp, string][] = [
  [/(database)s$/i, "$1"],
  [/(quiz)zes$/i, "$1"],
  [/(matr)ices$/i, "$1ix"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/^(ox)en/i, "$1"],
  [/(alias|status)(es)?$/i, "$1"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/(shoe)s$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(bus)(es)?$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/(m)ovies$/i, "$1ovie"],
  [/(s)eries$/i, "$1eries"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/([lr])ves$/i, "$1f"],
  [/(tive)s$/i, "$1"],
  [/(hive)s$/i, "$1"],
  [/([^f])ves$/i, "$1fe"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/([ti])a$/i, "$1um"],
  [/(n)ews$/i, "$1ews"],
  [/(ss)$/i, "$1"],
  [/s$/i, ""],
];
/** Rails' irregulars, singular and plural. */
const IRREGULAR: [string, string][] = [
  ["person", "people"],
  ["man", "men"],
  ["child", "children"],
  ["sex", "sexes"],
  ["move", "moves"],
  ["zombie", "zombies"],
];
const UNCOUNTABLE = ["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"];

/**
 * An English plural made singular as Rails names a foreign key (`categories` is `category`, `people` is `person`,
 * `status` stays): its irregulars, uncountables and rules. A name in all capitals stays in capitals (M7).
 */
export function singular(word: string): string {
  const upper = /[A-Z]/.test(word) && word === word.toUpperCase();
  const out = rails(word);
  return upper ? out.toUpperCase() : out;
}

/** Rails' `underscore`: `OrderItem` is `order_item`, `HTTPRequest` is `http_request`; a snake_case name stays. */
export function underscore(word: string): string {
  return word
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function rails(word: string): string {
  if (UNCOUNTABLE.some((u) => new RegExp(`\\b${u}$`, "i").test(word))) return word;
  for (const [one, many] of IRREGULAR) {
    const m = new RegExp(`(${many[0]})${many.slice(1)}$`, "i").exec(word);
    if (m) return word.slice(0, m.index) + m[1] + one.slice(1);
    if (new RegExp(`(${one[0]})${one.slice(1)}$`, "i").test(word)) return word;
  }
  for (const [rule, to] of SINGULAR_RULES) if (rule.test(word)) return word.replace(rule, to);
  return word;
}

/** A place a pick can land: a column, or a header (index -1, column null) standing for its table's key. */
export type PickTarget = { table: string; index: number; column: string | null };

/**
 * Where a pick from `from` can land, in the order the keys go (fix round 4, N6): each other table's header and
 * columns in the text's order, then the other columns of its own table (a loop). Only places that make a line are
 * offered: a header needs a key, and a column must be of the source's type family, not the same column, not joined
 * to it already and not also a node's name. Built once per pick: one pass over the tables and one over the lines.
 */
export function pickTargets(doc: FlowDoc, from: { table: string; column: string }): PickTarget[] {
  const src = tableOf(doc, from.table);
  const a = src && columnOf(src, from.column);
  if (!src || !a) return [];
  const joined = new Set<string>();
  for (const l of doc.links) {
    if (l.from === from.table && l.fromColumn === from.column && l.toColumn !== undefined) joined.add(`${l.to}\u0000${l.toColumn}`);
    if (l.to === from.table && l.toColumn === from.column && l.fromColumn !== undefined) joined.add(`${l.from}\u0000${l.fromColumn}`);
  }
  const nodeNames = new Set(doc.nodes.map((n) => n.name));
  const fam = a.type ? typeFamily(a.type) : null;
  const fits = (table: string, c: { name: string; type: string }) =>
    !(table === from.table && c.name === from.column) &&
    !(fam !== null && c.type && typeFamily(c.type) !== fam) &&
    !joined.has(`${table}\u0000${c.name}`) &&
    !nodeNames.has(`${table}.${c.name}`);
  const tables = doc.nodes.filter((n) => (n.kind === "entity" || n.kind === "weak") && columnsWritable(n.name));
  const out: PickTarget[] = [];
  const add = (t: FlowNode, header: boolean) => {
    if (header) {
      const key = keyOf(t);
      if (key && fits(t.name, key)) out.push({ table: t.name, index: -1, column: null });
    }
    (t.rows ?? []).forEach((r, index) => {
      const c = splitRow(r);
      if (fits(t.name, c)) out.push({ table: t.name, index, column: c.name });
    });
  };
  for (const t of tables) if (t.name !== from.table) add(t, true);
  for (const t of tables) if (t.name === from.table) add(t, false);
  return out;
}

/**
 * A drag from a table's own port let go on another table (no source column): a new column in the source table that
 * refers to the target's key, named as the board names it, the table made singular plus the key (`customer_id`),
 * of the key's type and not null, joined `*--1`, as one batch.
 */
export function planReference(doc: FlowDoc, from: string, to: string): RelatePlan {
  const src = tableOf(doc, from);
  const dst = tableOf(doc, to);
  if (!src) return { refuse: RELATE_MESSAGES.gone(from) };
  if (!dst) return { refuse: RELATE_MESSAGES.gone(to) };
  if (src.name === dst.name) return { refuse: RELATE_MESSAGES.ownHeader };
  if (!columnsWritable(src.name) || !columnsWritable(dst.name)) return { refuse: ER_MESSAGES.notWritable };
  const key = keyOf(dst);
  if (!key) return { refuse: RELATE_MESSAGES.noKeyRef(dst.name) };
  // The board names it the singular table plus the key; a table in capitals gets the key in capitals (M7).
  const upper = /[A-Z]/.test(dst.name) && dst.name === dst.name.toUpperCase();
  // A PascalCase or camelCase name is written in snake case, as Rails' foreign_key underscores it (fix round 4, N4).
  const base = upper ? singular(dst.name) : underscore(singular(dst.name));
  const wanted = `${base}_${upper ? key.name.toUpperCase() : key.name}`;
  // That column is already there (in any case): the board links it and adds nothing (fix round 2, I2).
  const existing = (src.rows ?? []).map((r) => splitRow(r).name).find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (existing !== undefined) return planRelationship(doc, { table: src.name, column: existing }, { table: dst.name, column: key.name });
  const taken = (src.rows ?? []).map((r) => splitRow(r).name);
  const name = sqlFreeName(wanted, taken);
  const count = (src.rows ?? []).length;
  const column = `${src.name}.${name}`;
  const target = `${dst.name}.${key.name}`;
  if (doc.nodes.some((n) => n.name === column)) return { refuse: RELATE_MESSAGES.alsoNode(column) };
  const arrow: FlowArrow = "*--1";
  return {
    ops: [
      { op: "addColumn", table: src.name, at: count, before: null, name, type: referringType(key.type), flags: ["not null"] },
      { op: "addLink", from: column, to: target, arrow },
    ],
    message: RELATE_MESSAGES.added(column, target),
    select: { table: src.name, column: name },
  };
}
