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

function sentence(message: string): string {
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
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
      return e.message === "connection not open"
        ? "This Connection is not open. Open it again to continue."
        : `Not found: ${e.message}. Refresh and try again.`;
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
    default: {
      // A kind this UI does not know yet: still show what the Core said.
      const { kind, message } = e as { kind: string; message?: unknown };
      return message === undefined || message === null ? `Error: ${kind}.` : `Error (${kind}): ${String(message)}`;
    }
  }
}

export { formatBytes };
