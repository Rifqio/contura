import { DIALECT_LABEL } from "../api/client";
import type { SqlSchema, SqlTable } from "../api/types";
import type { AskContext, SendItem } from "./context";

export { actionsFor } from "./context";
export type { AskContext, SendItem } from "./context";

export const PAYLOAD_CAP_BYTES = 200 * 1024;
export const CUT_LINE = "… cut at 200 KB";
const ONLY_QUESTION = "Only your question";

const LEVEL = { never: 0, schema: 1, schemaQuery: 2, schemaQueryRows: 3 } as const;

function tableLine(t: SqlTable, schema: SqlSchema): string {
  const cols = t.columns.map((c) => {
    let s = `${c.name} ${c.typeName}`;
    if (c.pk) s += " pk";
    const fk = schema.fks.find(
      (f) => f.from.schema === t.schema && f.from.table === t.name && f.from.columns.includes(c.name),
    );
    if (fk) {
      const i = fk.from.columns.indexOf(c.name);
      s += ` -> ${fk.to.table}.${fk.to.columns[i] ?? fk.to.columns[0]}`;
    }
    return s;
  });
  return `${t.name}(${cols.join(", ")})`;
}

function schemaText(ctx: AskContext, schema: SqlSchema): string {
  const c = ctx.connection;
  const head = c
    ? `Dialect: ${DIALECT_LABEL[c.dialect]}${c.database ? `, database ${c.database}` : ""}`
    : "Dialect: unknown";
  const covered = schema.tables.filter((t) =>
    ctx.tables.some((w) => w.name === t.name && (w.schema === null || w.schema === t.schema)),
  );
  return [head, ...covered.map((t) => tableLine(t, schema))].join("\n");
}

function tablesLabel(ctx: AskContext): string {
  return ctx.tables.length === 1 ? ctx.tables[0].name : `${ctx.tables.length} tables`;
}

export function buildSends(ctx: AskContext, schema: SqlSchema | null, rowsOff: boolean): SendItem[] {
  const conn = ctx.connection;
  const rank = conn ? LEVEL[conn.access] : null;
  const name = conn?.name ?? "This Connection";

  const lockFor = (need: 1 | 2 | 3): string | null => {
    if (rank === null) return "No Connection is chosen";
    if (rank === 0) return `${name} shares nothing with AI`;
    if (rank >= need) return null;
    return need === 3 && rank === 2 ? `Sample rows are off for ${name}` : `${name} shares schema only`;
  };
  const item = (key: SendItem["key"], label: string, text: string, locked: string | null, on = true): SendItem => ({
    key,
    label,
    text: locked ? "" : text,
    locked,
    on: locked ? false : on,
  });

  if (ctx.kind === "none") {
    const text = conn
      ? `Connection: ${conn.name} (${DIALECT_LABEL[conn.dialect]}${conn.database ? `, ${conn.database}` : ""})`
      : "";
    return [item("names", "Connection names", text, conn ? lockFor(1) : null)];
  }

  const items: SendItem[] = [];

  if ((ctx.kind === "sql" || ctx.kind === "error") && ctx.sql !== undefined) {
    const from = ctx.lines?.[0] ?? 1;
    const to = ctx.lines?.[1] ?? ctx.sql.split("\n").length;
    items.push(item("query", "Query text", `Query (lines ${from} to ${to}):\n${ctx.sql}`, lockFor(2)));
  }
  if (ctx.kind === "filter" && ctx.sql !== undefined) {
    const table = ctx.tables[0]?.name ?? ctx.label;
    items.push(item("query", "Filter text", `Filter (${table}): ${ctx.sql}`, lockFor(2)));
  }
  if (ctx.kind === "error" && ctx.error !== undefined) {
    items.push(item("error", "Error", `Error: ${ctx.error}`, lockFor(2)));
  }
  if (ctx.kind === "card") {
    const n = ctx.tables.length;
    const label = n > 0 ? `DBML · ${n === 1 ? "1 table" : `${n} tables`}` : "DBML";
    items.push(item("dbml", label, `DBML (${ctx.label}):\n${ctx.dbml ?? ""}`, conn ? lockFor(1) : null));
  } else if (ctx.tables.length > 0) {
    const locked = lockFor(1) ?? (schema ? null : "The schema is not loaded yet");
    items.push(item("schema", `Schema · ${tablesLabel(ctx)}`, schema ? schemaText(ctx, schema) : "", locked));
  }

  // No rows are fetched yet, so the item carries no text: nothing about rows goes into the payload.
  const rowsText = "";
  if (ctx.kind === "card") {
    items.push(item("rows", "Sample rows", rowsText, rank === 0 ? lockFor(1) : "A Schema Model has no rows"));
  } else {
    items.push(item("rows", "Sample rows", rowsText, lockFor(3), !rowsOff));
  }
  return items;
}

export function payloadIsCut(text: string): boolean {
  return text.endsWith(CUT_LINE);
}

export function payloadText(items: SendItem[]): string {
  const parts = items.filter((i) => i.on && !i.locked && i.text !== "").map((i) => i.text);
  if (parts.length === 0) return ONLY_QUESTION;
  const full = parts.join("\n\n");
  const bytes = new TextEncoder().encode(full);
  if (bytes.length <= PAYLOAD_CAP_BYTES) return full;
  const head = new TextDecoder().decode(bytes.slice(0, PAYLOAD_CAP_BYTES)).replace(/�+$/, "");
  return `${head}\n${CUT_LINE}`;
}
