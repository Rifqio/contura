// Live templates: type the abbreviation and pick it to expand. `${n:text}` is
// field n with its placeholder, `$0` is where typing ends up after the last field.
import type { SqlTable } from "./types";

export interface SqlTemplate {
  abbr: string;
  desc: string;
  body: string;
  /** Fields where completion stays closed, such as a value. */
  noComplete: Record<number, true>;
  /** What happens on leaving a field. */
  onLeave?: Record<number, "insertColumns">;
  /** A hint per field, such as the column it fills. */
  meta?: Record<number, string>;
}

export const SQL_TEMPLATES: SqlTemplate[] = [
  { abbr: "sel", desc: "SELECT * FROM", body: "SELECT ${2:*} FROM ${1:table}$0", noComplete: {} },
  { abbr: "selw", desc: "SELECT * FROM … WHERE", body: "SELECT ${3:*} FROM ${1:table} WHERE ${2:condition}$0", noComplete: {} },
  { abbr: "cnt", desc: "SELECT count(*) FROM", body: "SELECT count(*) FROM ${1:table}$0", noComplete: {} },
  { abbr: "ins", desc: "INSERT INTO with every column", body: "INSERT INTO ${1:table}$0", noComplete: {}, onLeave: { 1: "insertColumns" } },
  { abbr: "upd", desc: "UPDATE … SET … WHERE", body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}$0", noComplete: { 3: true } },
];

/** The template text with its placeholders, on one line. */
export const templatePreview = (t: SqlTemplate) =>
  t.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$0/g, "").replace(/\n/g, " ");

/** A starting value for a column of this type. */
export function defVal(type: string): string {
  const t = type.toLowerCase();
  if (/int|serial/.test(t)) return "0";
  if (/numeric|decimal|real|double|float|money/.test(t)) return "0.00";
  if (/^bool/.test(t)) return "true";
  if (/^timestamp/.test(t) || t === "datetime") return "now()";
  if (t === "date") return "current_date";
  return "''";
}

/** What `ins` adds once its table is known: every column, each value a field. */
export function insertColumnsTemplate(t: SqlTable): SqlTemplate {
  const cols = t.columns;
  return {
    abbr: "ins",
    desc: `INSERT INTO ${t.name}`,
    body: ` (${cols.map((c) => c.name).join(", ")})\nVALUES (${cols.map((c, i) => `\${${i + 1}:${defVal(c.typeName)}}`).join(", ")});$0`,
    noComplete: Object.fromEntries(cols.map((_, i) => [i + 1, true])),
    meta: Object.fromEntries(cols.map((c, i) => [i + 1, `${c.name} ${c.typeName}`])),
  };
}
