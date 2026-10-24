import type { AiAccess, AskRequest, AskTab, ConnectionConfig, DialectKind, ItemKind, ModelPicks, SqlSchema, StepIn, Switches } from "../api/types";
import type { InsertTarget } from "./InsertDiff";
import type { AnyTab } from "../shell/tabs";
import type { TabAskFields } from "./tabAsk";

export interface AskContext {
  kind: "sql" | "error" | "filter" | "card" | "none";
  connection: { id: string; name: string; dialect: DialectKind; database: string | null; access: AiAccess } | null;
  sql?: string;
  lines?: [number, number];
  error?: string;
  tables: { schema: string | null; name: string }[];
  dbml?: string;
  label: string;
  /** What the active tab shows (spec 4); absent on the inline Ask and the diagram, which send no This tab item. */
  tab?: AskTab | null;
  /** The other Connections the tab spans (a Compare source, a Transfer side); the Core gates at the lowest access. */
  also?: string[];
  /** The Ask's schema when the tab names one (a table's, New table's); else the focus tables' shared one. */
  schema?: string | null;
  /** The active tab's kind, even before its screen publishes anything: every kind but a query tab has no editor. */
  tabKind?: AnyTab["kind"];
}

/**
 * `focus.also`: each other Connection once, never the Ask's own. Never cut: a Connection left out would escape the
 * lowest-access gate, so past the Core's limit (4, `ASKED_IN_ALSO`) the whole Ask is refused there instead.
 */
export function alsoOf(own: string | null, ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => id !== own);
}

/** What a Connection that is gone is called in the panel. */
export const REMOVED_CONNECTION = "A removed Connection";

/**
 * The Ask's Connection as the panel shows it. A Connection that is gone fails closed: it keeps its id, so the
 * Core counts it at Nothing and sends the question only.
 */
export function askConnection(
  id: string | null,
  database: string | null,
  connections: readonly ConnectionConfig[],
  dialect: DialectKind = "postgres",
): AskContext["connection"] {
  if (id === null) return null;
  const c = connections.find((x) => x.id === id);
  if (!c) return { id, name: REMOVED_CONNECTION, dialect, database, access: "never" };
  return { id: c.id, name: c.name, dialect: c.dialect, database: c.dialect === "sqlite" ? "main" : database, access: c.aiAccess };
}

/**
 * The context a published tab gives: its typed tab, and the focus fields spec 4 sends from it (the grid's filter,
 * the Visual Query's SQL pane, the sync script, the model's DBML). Without fields the base stays as App built it.
 */
export function withTabFields(base: AskContext, f: TabAskFields | null, connections: readonly ConnectionConfig[]): AskContext {
  if (!f) return base;
  const connection = f.where
    ? askConnection(f.where.connectionId, f.where.database, connections, base.connection?.dialect)
    : base.connection;
  const schema = f.where ? f.where.schema : base.schema;
  const kind: AskContext["kind"] = f.dbml !== undefined ? "card" : f.filter ? "filter" : f.sql ? "sql" : "none";
  return {
    ...base,
    kind,
    connection,
    schema,
    tab: f.tab,
    also: f.also ?? base.also,
    sql: f.filter || f.sql || undefined,
    lines: undefined,
    dbml: f.dbml,
    tables: f.tables ?? base.tables,
  };
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `r${Date.now()}${Math.random().toString(36).slice(2)}`;

/** The schema every focus table names, when they all name the same one; else null and the Core decides. */
export function sharedSchema(tables: AskContext["tables"]): string | null {
  const first = tables[0]?.schema ?? null;
  return first !== null && tables.every((t) => t.schema === first) ? first : null;
}

/** The Ask the Core previews and sends for a context: the Core builds the text, never the UI. */
export function toAskRequest(
  ctx: AskContext,
  question: string,
  off: ItemKind[],
  switches: Switches,
  at: { groupId: string | null; action?: string; threadId?: string | null; model?: string | null; picks?: ModelPicks | null; steps?: StepIn[] },
): AskRequest {
  const has = (k: AskContext["kind"][]) => k.includes(ctx.kind);
  const own = ctx.connection?.id ?? null;
  const also = alsoOf(own, ctx.also ?? []);
  const tables = ctx.tables.map((t) => ({ schema: t.schema, name: t.name }));
  return {
    requestId: newId(),
    place: at.groupId ? `group:${at.groupId}` : "ungrouped",
    groupId: at.groupId,
    connectionId: ctx.connection?.id ?? null,
    database: ctx.connection?.database ?? null,
    schema: ctx.schema ?? sharedSchema(ctx.tables),
    action: at.action ?? "ask",
    question,
    threadId: at.threadId ?? null,
    focus: {
      sql: has(["sql", "error"]) ? (ctx.sql ?? null) : null,
      selection: null,
      error: ctx.kind === "error" ? (ctx.error ?? null) : null,
      filter: ctx.kind === "filter" ? (ctx.sql ?? null) : null,
      dbml: ctx.kind === "card" ? (ctx.dbml ?? null) : null,
      tables,
      untiedModel: ctx.kind === "card" && ctx.connection === null,
      ...(also.length > 0 ? { also } : {}),
    },
    switches,
    off,
    model: at.model ?? null,
    picks: at.picks ?? null,
    ...(ctx.tab ? { tab: ctx.tab } : {}),
    ...(at.steps && at.steps.length > 0 ? { steps: at.steps } : {}),
  };
}

export function actionsFor(kind: AskContext["kind"]): { key: string; label: string }[] {
  const sql = [
    { key: "explain", label: "Explain" },
    { key: "optimize", label: "Optimize" },
    { key: "indexes", label: "Suggest indexes" },
  ];
  switch (kind) {
    case "error":
      return [{ key: "fix", label: "Fix this error" }, ...sql];
    case "sql":
      return sql;
    case "filter":
      return [
        { key: "where", label: "Write a WHERE for this filter" },
        { key: "explain", label: "Explain" },
      ];
    case "card":
      return [
        { key: "indexes", label: "Suggest indexes" },
        { key: "generate", label: "Generate DBML for…" },
        { key: "explain", label: "Explain" },
      ];
    case "none":
      return [
        { key: "find", label: "Find a table" },
        { key: "explain", label: "Explain a Connection" },
      ];
  }
}

/** What the inline Ask needs from the app, per Group: the settings and where its buttons lead. */
export interface AskKit {
  groupId: string | null;
  inlineAsk: boolean;
  errorAsk: boolean;
  /** Absent where there is no assistant panel to open. */
  onOpenInChat?(seed: { question: string; context: AskContext }): void;
  onOpenSettings(): void;
  /** Opens an answer's SQL in a new query tab on the Ask's Connection; absent where tabs cannot open. */
  onOpenInNewTab?(sql: string, connection: AskContext["connection"]): void;
}

/** The Connection and schema one place asks about, with the kit. */
export interface AskSetup extends AskKit {
  connection: AskContext["connection"];
  schema: SqlSchema | null;
  /** The query tab an answer's SQL is inserted into, through the Insert diff. */
  insertTarget?: InsertTarget | null;
}

/** The tables of the schema that a piece of SQL names. */
export function tablesIn(sql: string, schema: SqlSchema | null): AskContext["tables"] {
  const words = new Set(sql.toLowerCase().match(/[a-z_][\w$]*/g) ?? []);
  return (schema?.tables ?? []).filter((t) => words.has(t.name.toLowerCase())).map((t) => ({ schema: t.schema, name: t.name }));
}
