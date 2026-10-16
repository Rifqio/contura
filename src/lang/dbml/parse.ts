// DBML text to a Schema Model, diagnostics and source ranges. Every use of
// @dbml/parse stays inside src/lang/dbml/, so nothing else depends on its internals.
import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from "@dbml/parse";
import type { Database } from "@dbml/parse";
import type { DialectKind, SchemaModel, SmColumn, SmDefault, SmRef } from "../../api/types";
import { type Diagnostic, type Ranges, tableKey } from "../protocol";

export type ParseOutput = { model: SchemaModel | null; diagnostics: Diagnostic[]; ranges: Ranges };

type Pos = { offset: number };
type Tok = { start: Pos; end: Pos } | undefined;

/** 1-based line and column of an offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** End of an identifier segment starting at `i`: a quoted "…" name or a bare run. */
function segmentEnd(text: string, i: number, stop: RegExp): number {
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, text.length);
  }
  let j = i;
  while (j < text.length && !stop.test(text[j])) j += 1;
  return j;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

/** End of a `[...]` block starting at `i`, skipping quoted strings and backtick expressions. */
function bracketEnd(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === "`" || c === '"') {
      const close = c;
      j += 1;
      while (j < text.length && text[j] !== close) j += text[j] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "[") depth += 1;
    if (c === "]") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s;
}

/** Name, type and settings ranges of a column line that starts at `start`. */
function columnParts(text: string, start: number) {
  const nameEnd = segmentEnd(text, start, /[\s[]/);
  const typeStart = skipSpace(text, nameEnd);
  const typeEnd = segmentEnd(text, typeStart, /[\s[]/);
  const afterType = skipSpace(text, typeEnd);
  const settings =
    text[afterType] === "["
      ? { from: afterType, to: bracketEnd(text, afterType) }
      : { from: typeEnd, to: typeEnd };
  return { name: { from: start, to: nameEnd }, type: { from: typeStart, to: typeEnd }, settings };
}

/** Range of the table's own name (the last segment of `Table schema.name`). */
function tableNameRange(text: string, start: number) {
  let i = skipSpace(text, start + "Table".length);
  let seg = { from: i, to: segmentEnd(text, i, /[\s.{[]/) };
  while (text[seg.to] === ".") {
    i = seg.to + 1;
    seg = { from: i, to: segmentEnd(text, i, /[\s.{[]/) };
  }
  return seg;
}

function defaultOf(d: { value: unknown; type: string } | undefined): SmDefault | null {
  if (!d) return null;
  if (d.value === null) return { t: "null" };
  switch (d.type) {
    case "string":
      return { t: "string", value: String(d.value) };
    case "number":
      return { t: "number", value: String(d.value) };
    case "boolean":
      return { t: "bool", value: d.value === true || d.value === "true" };
    default:
      return { t: "expression", value: String(d.value) };
  }
}

const range = (t: Tok) => (t ? { from: t.start.offset, to: t.end.offset } : null);

function toModel(db: Database, text: string, dialect: DialectKind): { model: SchemaModel; ranges: Ranges } {
  // DBML's default schema is `public`; Postgres models name it, others have none.
  const schemaOf = (s: string | null | undefined) => s ?? (dialect === "postgres" ? "public" : null);
  const ranges: Ranges = {};
  const tables = db.tables.map((t) => {
    const schema = schemaOf(t.schemaName);
    const key = tableKey({ schema, name: t.name });
    const tr = range(t.token as Tok);
    if (tr) {
      ranges[`table:${key}`] = tr;
      ranges[`table:${key}/name`] = tableNameRange(text, tr.from);
    }
    const columns: SmColumn[] = t.fields.map((f) => {
      const fr = range(f.token as Tok);
      let typeName = f.type.type_name;
      if (fr) {
        const parts = columnParts(text, fr.from);
        ranges[`column:${key}/${f.name}`] = fr;
        ranges[`column:${key}/${f.name}/name`] = parts.name;
        ranges[`column:${key}/${f.name}/type`] = parts.type;
        ranges[`column:${key}/${f.name}/settings`] = parts.settings;
        typeName = unquote(text.slice(parts.type.from, parts.type.to));
      }
      return {
        name: f.name,
        typeName,
        pk: !!f.pk,
        increment: !!f.increment,
        notNull: !!f.not_null,
        unique: !!f.unique,
        default: defaultOf(f.dbdefault as { value: unknown; type: string } | undefined),
        note: f.note?.value ?? null,
      };
    });
    const indexes = (t.indexes ?? []).map((i, n) => ({
      name: i.name ?? null,
      columns: i.columns.map((c, j) => {
        const cr = range(c.token as Tok);
        if (cr) ranges[`index:${key}/${n}/${j}`] = cr;
        return String(c.value);
      }),
      unique: !!i.pk || !!i.unique,
      pk: !!i.pk,
    }));
    return { schema, name: t.name, alias: t.alias ?? null, note: t.note?.value ?? null, columns, indexes };
  });
  const refs: SmRef[] = db.refs.map((r, idx) => {
    const many = r.endpoints.findIndex((e) => e.relation === "*");
    const fromIdx = many === -1 ? 0 : many;
    const from = r.endpoints[fromIdx];
    const to = r.endpoints[1 - fromIdx];
    const rr = range(r.token as Tok);
    if (rr) ranges[`ref:${idx}`] = rr;
    const fromTok = range(from.token as Tok);
    const toTok = range(to.token as Tok);
    if (fromTok) ranges[`ref:${idx}/from`] = fromTok;
    if (toTok) ranges[`ref:${idx}/to`] = toTok;
    const end = (e: typeof from) => ({ schema: schemaOf(e.schemaName), table: e.tableName, columns: [...e.fieldNames] });
    return {
      name: r.name ?? null,
      from: end(from),
      to: end(to),
      onDelete: r.onDelete ? r.onDelete.toUpperCase() : null,
      onUpdate: r.onUpdate ? r.onUpdate.toUpperCase() : null,
    };
  });
  const enums = db.enums.map((e) => ({
    schema: schemaOf(e.schemaName),
    name: e.name,
    values: e.values.map((v) => v.name),
  }));
  return { model: { dialect, tables, refs, enums, skipped: [] }, ranges };
}

export function parseDbml(text: string, dialect: DialectKind): ParseOutput {
  const layout = new MemoryProjectLayout();
  layout.setSource(DEFAULT_ENTRY, text);
  const report = new Compiler(layout).interpretFile(DEFAULT_ENTRY);
  const errors = report.getErrors();
  if (errors.length > 0) {
    const diagnostics = errors.map((e) => {
      const from = Math.min(e.start, text.length);
      return {
        from,
        to: Math.max(from, Math.min(e.end, text.length)),
        ...lineColumn(text, from),
        severity: "error" as const,
        message: e.diagnostic,
        fixes: [],
      };
    });
    return { model: null, diagnostics, ranges: {} };
  }
  const db = report.getValue();
  if (!db) return { model: null, diagnostics: [], ranges: {} };
  const { model, ranges } = toModel(db as Database, text, dialect);
  return { model, diagnostics: [], ranges };
}
