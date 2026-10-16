import type { AiAccess, DialectKind, SqlSchema } from "../api/types";

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

export interface SendItem {
  key: "names" | "schema" | "query" | "error" | "dbml" | "rows";
  label: string;
  on: boolean;
  locked: string | null;
  text: string;
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
}

/** The Connection and schema one place asks about, with the kit. */
export interface AskSetup extends AskKit {
  connection: AskContext["connection"];
  schema: SqlSchema | null;
}

/** The tables of the schema that a piece of SQL names. */
export function tablesIn(sql: string, schema: SqlSchema | null): AskContext["tables"] {
  const words = new Set(sql.toLowerCase().match(/[a-z_][\w$]*/g) ?? []);
  return (schema?.tables ?? []).filter((t) => words.has(t.name.toLowerCase())).map((t) => ({ schema: t.schema, name: t.name }));
}
