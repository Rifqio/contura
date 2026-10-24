import type { AskTab, ConnectionConfig, ConnectionId, SqlSchema } from "../api/types";
import { type AskContext, askConnection } from "../assistant/context";
import type { QueryTabDoc } from "../query/QueryTab";
import type { Stmt } from "../query/statements";
import type { AnyTab } from "../shell/tabs";

/**
 * Where an Ask on the active tab goes (spec 4's table): the Connection, database and schema, and the other
 * Connections the tab spans. `connectionId` stays set while its config is gone, so the Core fails closed.
 * `tab` is what App knows of the tab; a screen that publishes more replaces it (`tabAsk.ts`).
 */
export interface AssistantTarget {
  connection: ConnectionConfig | null;
  connectionId: ConnectionId | null;
  database: string | null;
  schema: string | null;
  tabKind: AnyTab["kind"];
  tab: AskTab | null;
  doc?: QueryTabDoc;
  also: ConnectionId[];
}

/** The words a tab kind goes by in the panel's labels. */
const KIND_WORDS: Record<AnyTab["kind"], string> = {
  query: "Query tab",
  object: "Table data",
  visual: "Visual Query",
  design: "Table Designer",
  savedQueries: "Saved Queries",
  import: "Import",
  lineage: "Lineage",
  home: "Home",
  settings: "Settings",
  schema: "Schema Builder",
  flow: "Diagram",
  transfer: "Data Transfer",
  compare: "Schema Compare",
};

/**
 * The Ask's target for the active tab; null on a diagram, which has its own assistant (ADR 0023). Place tabs find
 * their Connection in this place, window tabs in all Connections, since Compare and Transfer may span Groups.
 * SQLite's database is always "main".
 */
export function assistantTargetFor(
  current: AnyTab | undefined,
  inPlace: ConnectionConfig[],
  all: ConnectionConfig[],
): AssistantTarget | null {
  if (!current || current.kind === "flow") return null;
  const at = (
    id: ConnectionId | null,
    list: ConnectionConfig[],
    database: string | null,
    schema: string | null,
    tab: AskTab | null,
    also: ConnectionId[] = [],
  ): AssistantTarget => {
    const connection = id === null ? null : (list.find((c) => c.id === id) ?? null);
    return {
      connection,
      connectionId: id,
      database: connection?.dialect === "sqlite" ? "main" : database,
      schema,
      tabKind: current.kind,
      tab,
      also: [...new Set(also)].filter((x) => x !== id),
    };
  };
  switch (current.kind) {
    case "query": {
      // As before: a query tab on no Connection of this place asks with none.
      const id = inPlace.some((c) => c.id === current.doc.connectionId) ? current.doc.connectionId : null;
      return { ...at(id, inPlace, current.doc.database, null, { kind: "query", title: current.doc.name }), doc: current.doc };
    }
    case "object": {
      const { connectionId, path, kind } = current.selection;
      // Table and view tabs publish their grid state over this; routines and triggers have none.
      const tab: AskTab = { kind: "object", title: path.name, path, object: kind, sort: null, filterColumns: [], hidden: [], pendingEdits: 0 };
      return at(connectionId, inPlace, path.database, path.schema, tab);
    }
    case "visual":
      return at(current.doc.connectionId, inPlace, current.doc.database, null, null);
    case "design": {
      const t = current.target;
      return t.kind === "alter"
        ? at(current.connectionId, inPlace, t.path.database, t.path.schema, null)
        : at(current.connectionId, inPlace, t.scope.database, t.scope.schema, null);
    }
    case "import": {
      const t = current.target;
      return t.kind === "table"
        ? at(current.connectionId, inPlace, t.path.database, t.path.schema, null)
        : at(current.connectionId, inPlace, t.database, null, null);
    }
    case "lineage":
      return at(current.connectionId, inPlace, current.path.database, current.path.schema, {
        kind: "lineage",
        path: current.path,
        neighbours: [],
      });
    case "savedQueries":
      return at(null, inPlace, null, null, { kind: "savedQueries" });
    case "home":
      return at(null, all, null, null, { kind: "home" });
    case "settings":
      return at(null, all, null, null, { kind: "settings", section: current.section });
    case "schema":
      // An untied model has no Connection; a tied one asks on its source, gone or not.
      return at(current.doc.connectionId, all, null, null, null);
    case "compare": {
      const target = current.connectionId ?? current.seed.target?.connectionId ?? null;
      const source = current.seed.source;
      const side = current.seed.target?.connectionId === target ? current.seed.target : null;
      return at(target, all, side?.database ?? null, side?.schema ?? null, null, source.kind === "database" ? [source.connectionId] : []);
    }
    case "transfer":
      // Until the target is chosen the Ask is on the source; the tab publishes both sides once it is.
      return at(current.seed.connectionId, all, current.seed.database, current.seed.schema, null);
  }
}

/** The Ask context of a target: the query tab's statement, or the tab as App knows it. */
export function assistantContextFor(target: AssistantTarget, schema: SqlSchema | null, stmt: Stmt | null): AskContext {
  const { connection, database, doc } = target;
  const conn = connection
    ? { id: connection.id, name: connection.name, dialect: connection.dialect, database, access: connection.aiAccess }
    : askConnection(target.connectionId, database, []);
  const base = { connection: conn, tab: target.tab, also: target.also, schema: target.schema, tabKind: target.tabKind };
  if (!doc) {
    const object = target.tab?.kind === "object" ? target.tab : null;
    return {
      ...base,
      kind: "none",
      tables: object ? [{ schema: object.path.schema, name: object.path.name }] : [],
      label: object ? object.title : KIND_WORDS[target.tabKind],
    };
  }
  const sql = (stmt?.text ?? doc.text).trim();
  const before = stmt ? doc.text.slice(0, stmt.from).split("\n").length : 1;
  const words = new Set(sql.toLowerCase().match(/[a-z_][\w$]*/g) ?? []);
  return {
    ...base,
    kind: sql ? "sql" : "none",
    sql: sql || undefined,
    lines: [before, before + sql.split("\n").length - 1],
    tables: (schema?.tables ?? [])
      .filter((t) => words.has(t.name.toLowerCase()))
      .map((t) => ({ schema: t.schema, name: t.name })),
    label: doc.name,
  };
}
