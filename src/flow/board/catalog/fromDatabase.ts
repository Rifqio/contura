import type { DialectKind, SchemaModel, SmColumn, SmRef, SmTable } from "../../../api/types";
import {
  attrValue, columnFlagsText, columnTypeText, MAX_FLOW_NODES, overTextLimit, quote, type ColumnFlag,
} from "../../../lang/flow/model";

export interface ErFromModel {
  title: string;
  text: string;
  tables: number;
  links: number;
  leftOut: number;
}

/** Words an ER frame reads as syntax at the start of a line, so a table cannot take them as its name. */
const ER_WORDS = new Set(["group", "note"]);

/** A name made of letters, digits and `_`: anything else becomes `_`, a leading digit gets a `_` prefix, empty a fallback. */
export function bareName(name: string, fallback: "table" | "column"): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (s === "") return fallback;
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** The database name; for PostgreSQL the schema name unless it is `public`. */
export function databaseTitle(dialect: DialectKind, database: string, schema: string | null): string {
  return dialect === "postgres" && schema && schema !== "public" ? schema : database;
}

/**
 * Gives each real name its bare name: the ones that need no change keep it, the rest take a numbered free name, in
 * order, so a renamed name never takes a real one. `reserved` names are never kept (ER words).
 */
function bareNames(names: string[], fallback: "table" | "column", reserved?: Set<string>): string[] {
  const out: (string | null)[] = new Array(names.length).fill(null);
  // One set of taken names, lower-cased (SQL folds unquoted names), and the next number to try per base name.
  const lower = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    const b = bareName(names[i], fallback);
    const key = b.toLowerCase();
    if (b === names[i] && !reserved?.has(key) && !lower.has(key)) {
      out[i] = b;
      lower.add(key);
    }
  }
  const next = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    if (out[i] !== null) continue;
    const bare = bareName(names[i], fallback);
    let b = bare;
    if (reserved?.has(bare.toLowerCase()) || lower.has(bare.toLowerCase())) {
      const base = bare.toLowerCase();
      let n = next.get(base) ?? 1;
      while (lower.has(`${base}_${n}`)) n++;
      next.set(base, n + 1);
      b = `${bare}_${n}`;
    }
    out[i] = b;
    lower.add(b.toLowerCase());
  }
  return out as string[];
}

const endKey = (schema: string | null, name: string) => `${schema ?? ""}\u0000${name}`;
const noBreaks = (s: string) => s.replace(/[\r\n]+/g, " ");

interface Written {
  name: string;
  columns: Map<string, string>;
  unique: Set<string>;
}

function flagsOf(c: SmColumn, pkColumns: Set<string>): string {
  const flags: ColumnFlag[] = [];
  const pk = c.pk || pkColumns.has(c.name);
  if (pk) flags.push("pk");
  if (c.notNull && !pk) flags.push("not null");
  if (c.unique) flags.push("unique");
  return columnFlagsText(flags);
}

function tableBlock(t: SmTable, name: string, columns: string[]): string {
  const pkColumns = new Set<string>();
  for (const ix of t.indexes) if (ix.pk) for (const c of ix.columns) pkColumns.add(c);
  const head = name === t.name ? name : `${name} [label: ${attrValue("label", t.name)}]`;
  if (t.columns.length === 0) return head;
  const out = [`${head} {`];
  for (let i = 0; i < t.columns.length; i++) {
    const c = t.columns[i];
    const type = c.typeName === "" ? "" : ` ${columnTypeText(c.typeName)}`;
    const note = columns[i] === c.name ? "" : ` // ${noBreaks(c.name)}`.trimEnd();
    out.push(`  ${columns[i]}${type}${flagsOf(c, pkColumns)}${note}`);
  }
  out.push("}");
  return out.join("\n");
}

function relationship(r: SmRef, byEnd: Map<string, Written>): string | null {
  const from = byEnd.get(endKey(r.from.schema, r.from.table));
  const to = byEnd.get(endKey(r.to.schema, r.to.table));
  if (!from || !to) return null;
  const fc = r.from.columns;
  const tc = r.to.columns;
  if (fc.length === 1 && tc.length === 1) {
    const a = from.columns.get(fc[0]);
    const b = to.columns.get(tc[0]);
    if (a === undefined || b === undefined) return null;
    return `${from.name}.${a} ${from.unique.has(fc[0]) ? "-" : ">"} ${to.name}.${b}`;
  }
  if (fc.length === 0 || fc.length !== tc.length) return null;
  if (!fc.every((c) => from.columns.has(c)) || !tc.every((c) => to.columns.has(c))) return null;
  return `${from.name} > ${to.name} // (${fc.map(noBreaks).join(", ")}) to (${tc.map(noBreaks).join(", ")})`;
}

/** One schema as ER table blocks: tables in model order, a blank line, then relationships in model order. */
export function modelToErFrame(model: SchemaModel, title: string): ErFromModel | { refused: string } {
  const n = model.tables.length;
  const what = model.dialect === "postgres" ? "schema" : "database";
  if (n === 0) return { refused: `This ${what} has no tables.` };
  if (n > MAX_FLOW_NODES) return { refused: `This ${what} has ${n.toLocaleString("en-US")} tables. A diagram holds at most ${MAX_FLOW_NODES.toLocaleString("en-US")}.` };

  const names = bareNames(model.tables.map((t) => t.name), "table", ER_WORDS);
  const byEnd = new Map<string, Written>();
  const blocks: string[] = [`diagram er ${quote(title)}`];
  for (let i = 0; i < n; i++) {
    const t = model.tables[i];
    const cols = bareNames(t.columns.map((c) => c.name), "column");
    const columns = new Map<string, string>();
    const unique = new Set<string>();
    for (let k = 0; k < cols.length; k++) {
      const c = t.columns[k];
      if (!columns.has(c.name)) columns.set(c.name, cols[k]);
      if (c.pk || c.unique) unique.add(c.name);
    }
    for (const ix of t.indexes) if ((ix.pk || ix.unique) && ix.columns.length === 1) unique.add(ix.columns[0]);
    const key = endKey(t.schema, t.name);
    if (!byEnd.has(key)) byEnd.set(key, { name: names[i], columns, unique });
    blocks.push(tableBlock(t, names[i], cols));
  }

  const rels: string[] = [];
  let leftOut = 0;
  for (const r of model.refs) {
    const line = relationship(r, byEnd);
    if (line === null) leftOut++;
    else rels.push(line);
  }
  if (rels.length) blocks.push("", ...rels);
  const text = `${blocks.join("\n")}\n`;
  if (overTextLimit(text)) return { refused: "This schema is larger than 1 MB as a diagram." };
  return { title, text, tables: n, links: rels.length, leftOut };
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The toast after a schema is added as a frame: its tables, and the relationships that could not be drawn. Those point
 * at a table outside the schema or at a column it does not have, so the copy names no cause.
 */
export function addedDatabaseText(out: Pick<ErFromModel, "title" | "tables" | "leftOut">): string {
  const base = `Added ${out.title}: ${count(out.tables, "table", "tables")}.`;
  if (out.leftOut <= 0) return base;
  return `${base} ${count(out.leftOut, "relationship", "relationships")} could not be drawn and ${out.leftOut === 1 ? "was" : "were"} left out.`;
}
