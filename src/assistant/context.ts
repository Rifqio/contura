import type { AiAccess, AskRequest, DialectKind, ItemKind, ModelPicks, SqlSchema, Switches } from "../api/types";
import type { InsertTarget } from "./InsertDiff";

export interface AskContext {
  kind: "sql" | "error" | "filter" | "card" | "none";
  connection: { id: string; name: string; dialect: DialectKind; database: string | null; access: AiAccess } | null;
  sql?: string;
  lines?: [number, number];
  error?: string;
  tables: { schema: string | null; name: string }[];
  dbml?: string;
  label: string;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `r${Date.now()}${Math.random().toString(36).slice(2)}`;

/** The Ask the Core previews and sends for a context: the Core builds the text, never the UI. */
export function toAskRequest(
  ctx: AskContext,
  question: string,
  off: ItemKind[],
  switches: Switches,
  at: { groupId: string | null; action?: string; threadId?: string | null; model?: string | null; picks?: ModelPicks | null },
): AskRequest {
  const has = (k: AskContext["kind"][]) => k.includes(ctx.kind);
  return {
    requestId: newId(),
    place: at.groupId ? `group:${at.groupId}` : "ungrouped",
    groupId: at.groupId,
    connectionId: ctx.connection?.id ?? null,
    database: ctx.connection?.database ?? null,
    schema: null,
    action: at.action ?? "ask",
    question,
    threadId: at.threadId ?? null,
    focus: {
      sql: has(["sql", "error"]) ? (ctx.sql ?? null) : null,
      selection: null,
      error: ctx.kind === "error" ? (ctx.error ?? null) : null,
      filter: ctx.kind === "filter" ? (ctx.sql ?? null) : null,
      dbml: ctx.kind === "card" ? (ctx.dbml ?? null) : null,
      tables: ctx.tables.map((t) => ({ schema: t.schema, name: t.name })),
      untiedModel: ctx.kind === "card" && ctx.connection === null,
    },
    switches,
    off,
    model: at.model ?? null,
    picks: at.picks ?? null,
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
