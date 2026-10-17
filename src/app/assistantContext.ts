import type { ConnectionConfig, SqlSchema } from "../api/types";
import type { AskContext } from "../assistant/context";
import type { QueryTabDoc } from "../query/QueryTab";
import type { Stmt } from "../query/statements";
import type { WorkTab } from "../shell/tabs";

export interface AssistantTarget {
  connection: ConnectionConfig;
  database: string | null;
  doc: QueryTabDoc;
}

/** The active query tab's Connection when it is in this place; SQLite's database is always "main". */
export function assistantTargetFor(current: WorkTab | undefined, inPlace: ConnectionConfig[]): AssistantTarget | null {
  if (current?.kind !== "query") return null;
  const connection = inPlace.find((c) => c.id === current.doc.connectionId) ?? null;
  if (!connection) return null;
  return { connection, database: connection.dialect === "sqlite" ? "main" : current.doc.database, doc: current.doc };
}

export function assistantContextFor(target: AssistantTarget, schema: SqlSchema | null, stmt: Stmt | null): AskContext {
  const { connection, database, doc } = target;
  const sql = (stmt?.text ?? doc.text).trim();
  const before = stmt ? doc.text.slice(0, stmt.from).split("\n").length : 1;
  const words = new Set(sql.toLowerCase().match(/[a-z_][\w$]*/g) ?? []);
  return {
    kind: sql ? "sql" : "none",
    connection: {
      id: connection.id,
      name: connection.name,
      dialect: connection.dialect,
      database,
      access: connection.aiAccess,
    },
    sql: sql || undefined,
    lines: [before, before + sql.split("\n").length - 1],
    tables: (schema?.tables ?? [])
      .filter((t) => words.has(t.name.toLowerCase()))
      .map((t) => ({ schema: t.schema, name: t.name })),
    label: doc.name,
  };
}
