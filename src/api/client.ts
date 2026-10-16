import { invoke } from "@tauri-apps/api/core";
import type {
  CommandError,
  ConnectionConfig,
  ConnectionId,
  ConnectionInput,
  DbObject,
  DialectKind,
  FullValue,
  FullValueRequest,
  Group,
  GroupId,
  GroupInput,
  ObjectKind,
  ObjectPath,
  Page,
  PageRequest,
  SchemaInfo,
  SuggestedConnection,
  ModelFiles,
  SchemaModel,
  Execution,
  HistoryEntry,
  HistoryFilter,
  MoreRows,
  QuerySessionId,
  SavedQuery,
  SavedQueryInput,
} from "./types";

export const DIALECT_LABEL: Record<DialectKind, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

export const DIALECT_DEFAULTS: Record<"mysql" | "postgres", { port: number; user: string }> = {
  mysql: { port: 3306, user: "root" },
  postgres: { port: 5432, user: "postgres" },
};

/** Where a Connection points: the file path for SQLite, `host:port` for a server. */
export function connectionTarget(c: { dialect: DialectKind; host: string; port: number; file: string | null }): string {
  return c.dialect === "sqlite" ? (c.file ?? "") : `${c.host}:${c.port}`;
}

/**
 * Shortens a long file path in the middle, keeping its start and always the
 * whole file name: `C:\Users\rifqi\…\shop.db`. A path within `max` is unchanged.
 */
export function shortenPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut < 0) return path;
  const tail = path.slice(cut);
  const budget = max - tail.length - 1;
  if (budget <= 0) return `…${tail}`;
  let head = path.slice(0, budget);
  const lastSep = Math.max(head.lastIndexOf("\\"), head.lastIndexOf("/"));
  if (lastSep > 0) head = head.slice(0, lastSep + 1);
  return `${head}…${tail}`;
}

export const listConnections = (): Promise<ConnectionConfig[]> => invoke("list_connections");

export const saveConnection = (input: ConnectionInput): Promise<ConnectionConfig> =>
  invoke("save_connection", { input });

export const deleteConnection = (id: ConnectionId): Promise<void> => invoke("delete_connection", { id });

/** Resolves to the server version. */
export const testConnection = (input: ConnectionInput): Promise<string> => invoke("test_connection", { input });

export const suggestedConnections = (): Promise<SuggestedConnection[]> => invoke("suggested_connections");

export const openConnection = (id: ConnectionId): Promise<void> => invoke("open_connection", { id });

export const closeConnection = (id: ConnectionId): Promise<void> => invoke("close_connection", { id });

export const listDatabases = (id: ConnectionId): Promise<string[]> => invoke("list_databases", { id });

export const listSchemas = (id: ConnectionId, database: string): Promise<SchemaInfo[]> =>
  invoke("list_schemas", { id, database });

/** Creates an empty SQLite database file. The Core refuses a path where a file already exists. */
export const createSqliteDatabase = (path: string): Promise<void> => invoke("create_sqlite_database", { path });

export const listObjects = (id: ConnectionId, database: string, schema: string | null): Promise<DbObject[]> =>
  invoke("list_objects", { id, database, schema });

export const objectDefinition = (id: ConnectionId, kind: ObjectKind, path: ObjectPath): Promise<string> =>
  invoke("object_definition", { id, kind, path });

export const fetchPage = (id: ConnectionId, request: PageRequest): Promise<Page> =>
  invoke("fetch_page", { id, request });

export const schemaSnapshot = (id: ConnectionId, database: string, schema: string | null): Promise<SchemaModel> =>
  invoke("schema_snapshot", { id, database, schema });

/** Reads a database (or Postgres schema) and returns it as DBML text. Read only. */
export const reverseEngineer = (id: ConnectionId, database: string, schema: string | null): Promise<string> =>
  invoke("reverse_engineer", { id, database, schema });

/** A CREATE script for the model in its own Dialect. It is only text; nothing runs. */
export const exportSql = (model: SchemaModel): Promise<string> => invoke("export_sql", { model });

export const readModelFiles = (path: string): Promise<ModelFiles> => invoke("read_model_files", { path });

/** Saves `<path>` and `<path>.layout.json`; refused inside DB View's data folder. */
export const writeModelFiles = (path: string, dbml: string, layout: string): Promise<void> =>
  invoke("write_model_files", { path, dbml, layout });

export const writeTextFile = (path: string, text: string): Promise<void> => invoke("write_text_file", { path, text });

export const writeBinaryFile = (path: string, base64: string): Promise<void> =>
  invoke("write_binary_file", { path, base64 });

export const fetchFullValue = (id: ConnectionId, request: FullValueRequest): Promise<FullValue> =>
  invoke("fetch_full_value", { id, request });

export const listGroups = (): Promise<Group[]> => invoke("list_groups");

export const saveGroup = (input: GroupInput): Promise<Group> => invoke("save_group", { input });

export const deleteGroup = (id: GroupId): Promise<void> => invoke("delete_group", { id });

export const moveConnection = (id: ConnectionId, groupId: GroupId | null): Promise<ConnectionConfig> =>
  invoke("move_connection", { id, groupId });

export const lastGroup = (): Promise<GroupId | null> => invoke("last_group");

export const setLastGroup = (id: GroupId | null): Promise<void> => invoke("set_last_group", { id });

export const openQuerySession = (id: ConnectionId, database: string | null): Promise<QuerySessionId> =>
  invoke("open_query_session", { id, database });

export const executeSql = (session: QuerySessionId, sql: string): Promise<Execution> =>
  invoke("execute_sql", { session, sql });

export const fetchMoreRows = (session: QuerySessionId): Promise<MoreRows> => invoke("fetch_more_rows", { session });

export const cancelQuery = (session: QuerySessionId): Promise<void> => invoke("cancel_query", { session });

export const closeQueryResult = (session: QuerySessionId): Promise<void> => invoke("close_query_result", { session });

export const closeQuerySession = (session: QuerySessionId): Promise<void> =>
  invoke("close_query_session", { session });

export const queryHistory = (id: ConnectionId, filter: HistoryFilter): Promise<HistoryEntry[]> =>
  invoke("query_history", { id, filter });

export const clearQueryHistory = (id: ConnectionId): Promise<void> => invoke("clear_query_history", { id });

export const listSavedQueries = (): Promise<SavedQuery[]> => invoke("list_saved_queries");

export const saveSavedQuery = (input: SavedQueryInput): Promise<SavedQuery> => invoke("save_saved_query", { input });

export const deleteSavedQuery = (id: string): Promise<void> => invoke("delete_saved_query", { id });

export const loadQueryTabs = (place: string): Promise<string | null> => invoke("load_query_tabs", { place });

export const saveQueryTabs = (place: string, json: string): Promise<void> => invoke("save_query_tabs", { place, json });

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string";
}

export function isNotOpen(e: unknown): boolean {
  return isCommandError(e) && e.kind === "notFound" && e.message === "connection not open";
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`;
  if (n >= 1024) return `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KiB`;
  return `${n.toLocaleString("en-US")} bytes`;
}

/** Capitalised, with a full stop unless the Core's message already ends with one. */
function sentence(message: string): string {
  const s = `${message.charAt(0).toUpperCase()}${message.slice(1)}`;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function sqliteConnectText(message: string): string {
  if (message.includes("not a SQLite database")) return sentence(message);
  if (message.includes("does not exist")) return `${sentence(message)} Check the path, or choose the file again.`;
  return `${sentence(message)} Check that DB View can read the file.`;
}

/**
 * Turns a command error into UI text that says what went wrong and what to do.
 * `dialect` picks hints that fit the Connection, such as file hints for SQLite.
 */
export function errorText(e: unknown, dialect?: DialectKind): string {
  if (!isCommandError(e)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case "connect":
      if (dialect === "sqlite") return sqliteConnectText(e.message);
      return `Could not connect: ${e.message}. Check the host and port, and that the database server is running.`;
    case "auth":
      if (dialect === "postgres") {
        return `Sign-in failed: ${e.message}. Check the user name and password, or the server's access rules for this database.`;
      }
      return `Sign-in failed: ${e.message}. Check the user name and password.`;
    case "query":
      return `The query failed: ${e.message}`;
    case "notFound":
      if (e.message === "connection not open") return "This Connection is not open. Open it again to continue.";
      if (e.message === "That query session is closed.") return "This tab lost its session. Run the query again.";
      return `Not found: ${e.message}. Refresh and try again.`;
    case "noPrimaryKey":
      return "This table has no primary key, so DB View cannot pick out one row to open the full value.";
    case "valueTooLarge":
      return `This value is ${formatBytes(e.message)}, more than the 16 MiB DB View opens at once.`;
    case "invalidInput":
      return sentence(e.message);
    case "store":
      return `Could not read or write saved settings: ${e.message}`;
    case "secret":
      return `Could not use Windows Credential Manager: ${e.message}`;
    case "file":
      return `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}. Check the folder exists and DB View can write to it.`;
    case "cancelled":
      return "The query was cancelled.";
    case "timedOut":
      return `Stopped after ${e.message} s, the Connection's timeout.`;
    default: {
      // A kind this UI does not know yet: still show what the Core said.
      const { kind, message } = e as { kind: string; message?: unknown };
      return message === undefined || message === null ? `Error: ${kind}.` : `Error (${kind}): ${String(message)}`;
    }
  }
}

export { formatBytes };
