import { invoke } from "@tauri-apps/api/core";
import { PROVIDERS } from "../settings/ai/providers";
import type {
  AiAccess,
  AiAnswer,
  AiError,
  AiRequest,
  AiSettings,
  AiSettingsView,
  AiThread,
  AiTestOk,
  CommandError,
  ConnectionConfig,
  ConnectionId,
  ConnectionInput,
  Cell,
  DbObject,
  DialectKind,
  EditOutcome,
  EditPlan,
  EditSet,
  KeyPart,
  KeymapOverrides,
  FullValue,
  FullValueRequest,
  Group,
  GroupId,
  GroupInput,
  KeyChange,
  ObjectKind,
  ObjectPath,
  Page,
  PageRequest,
  SchemaInfo,
  SuggestedConnection,
  UiPrefs,
  ModelFiles,
  SchemaModel,
  SqlSchema,
  Execution,
  HistoryEntry,
  HistoryFilter,
  MoreRows,
  PassId,
  Plan,
  QuerySessionId,
  RunVerdict,
  StatementClass,
  SavedQuery,
  SavedQueryInput,
  SavedQueryRun,
  DataFolderInfo,
  RecentItem,
  RecentTarget,
  DesignOutcome,
  DesignRequest,
  DesignVerdict,
  TableDesign,
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

/** Changes only what AI can see in a Connection. Unlike saving, it keeps the Connection's sessions open. */
export const setConnectionAiAccess = (id: ConnectionId, access: AiAccess): Promise<ConnectionConfig> =>
  invoke("set_connection_ai_access", { id, access });

export const deleteConnection = (id: ConnectionId): Promise<void> => invoke("delete_connection", { id });

/** Resolves to the server version. */
export const testConnection = (input: ConnectionInput): Promise<string> => invoke("test_connection", { input });

export const suggestedConnections = (): Promise<SuggestedConnection[]> => invoke("suggested_connections");

// Opens in flight per Connection, from any part of the app: a cancelled open asks before it closes.
const opening = new Map<ConnectionId, number>();

/** Resolves to the server version (R3); an open Connection answers again. */
export function openConnection(id: ConnectionId): Promise<string> {
  opening.set(id, (opening.get(id) ?? 0) + 1);
  const done = () => {
    const n = (opening.get(id) ?? 1) - 1;
    if (n > 0) opening.set(id, n);
    else opening.delete(id);
  };
  let p: Promise<string>;
  try {
    p = invoke<string>("open_connection", { id });
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then(done, done);
  return p;
}

/** How many opens of this Connection are still in flight. */
export const opensInFlight = (id: ConnectionId): number => opening.get(id) ?? 0;

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

/** Names, kinds, column types and Foreign Keys of one database, for the SQL language service. */
export const sqlSchema = (id: ConnectionId, database: string): Promise<SqlSchema> =>
  invoke("sql_schema", { id, database });

/** Reads a database (or Postgres schema) and returns it as DBML text. Read only. */
export const reverseEngineer = (id: ConnectionId, database: string, schema: string | null): Promise<string> =>
  invoke("reverse_engineer", { id, database, schema });

/** A CREATE script for the model in its own Dialect. It is only text; nothing runs. */
export const exportSql = (model: SchemaModel): Promise<string> => invoke("export_sql", { model });

export const readModelFiles = (path: string): Promise<ModelFiles> => invoke("read_model_files", { path });

/** Saves `<path>` and `<path>.layout.json`; refused inside Contura's data folder. */
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

export const setGroupImage = (id: GroupId, pngBase64: string): Promise<Group> =>
  invoke("set_group_image", { id, png: pngBase64 });

export const clearGroupImage = (id: GroupId): Promise<Group> => invoke("clear_group_image", { id });

export const groupImage = (id: GroupId): Promise<string | null> => invoke("group_image", { id });

export const moveConnection = (id: ConnectionId, groupId: GroupId | null): Promise<ConnectionConfig> =>
  invoke("move_connection", { id, groupId });

export const lastGroup = (): Promise<GroupId | null> => invoke("last_group");

export const setLastGroup = (id: GroupId | null): Promise<void> => invoke("set_last_group", { id });

export const uiPrefs = (): Promise<UiPrefs> => invoke("ui_prefs");

export const saveUiPrefs = (prefs: UiPrefs): Promise<void> => invoke("save_ui_prefs", { prefs });

export const keymap = (): Promise<KeymapOverrides> => invoke("keymap");

export const saveKeymap = (overrides: KeymapOverrides): Promise<void> => invoke("save_keymap", { overrides });

export const recentItems = (): Promise<RecentItem[]> => invoke("recent_items");

export const clearRecent = (): Promise<RecentItem[]> => invoke("clear_recent");

export const restoreRecent = (items: RecentItem[]): Promise<void> => invoke("restore_recent", { items });

export const connectionOpenedTimes = (): Promise<Record<ConnectionId, number>> => invoke("connection_opened_times");

export const dataFolderInfo = (): Promise<DataFolderInfo> => invoke("data_folder_info");

export const openDataFolder = (): Promise<void> => invoke("open_data_folder");

export const savedQueryRuns = (): Promise<SavedQueryRun[]> => invoke("saved_query_runs");

export const recordRecent = (target: RecentTarget, connectionId: ConnectionId | null): Promise<void> =>
  invoke("record_recent", { target, connectionId });

export const openQuerySession = (id: ConnectionId, database: string | null): Promise<QuerySessionId> =>
  invoke("open_query_session", { id, database });

export const executeSql = (
  session: QuerySessionId,
  sql: string,
  pass?: PassId | null,
): Promise<Execution> => invoke("execute_sql", { session, sql, pass: pass ?? null });

export const prepareRun = (session: QuerySessionId, statements: string[]): Promise<RunVerdict> =>
  invoke("prepare_run", { session, statements });

export const confirmRun = (session: QuerySessionId, statements: string[]): Promise<PassId> =>
  invoke("confirm_run", { session, statements });

/** The SQL a save would run and whether it may run, needs a confirmation or is blocked. */
export const planEdits = (id: ConnectionId, edits: EditSet): Promise<EditPlan> => invoke("plan_edits", { id, edits });

/** A single-use pass for saving exactly these edits on a Production Connection. */
export const confirmEdits = (id: ConnectionId, edits: EditSet): Promise<PassId> =>
  invoke("confirm_edits", { id, edits });

export const applyEdits = (id: ConnectionId, edits: EditSet, pass: PassId | null): Promise<EditOutcome> =>
  invoke("apply_edits", { id, edits, pass });

/** One table as the Table Designer loads it. */
export const tableDesign = (id: ConnectionId, path: ObjectPath): Promise<TableDesign> =>
  invoke("table_design", { id, path });

/** The table's CREATE statement for copying; on PostgreSQL built from its design. */
export const tableDdl = (id: ConnectionId, path: ObjectPath): Promise<string> => invoke("table_ddl", { id, path });

/** The DDL a design runs, its warnings, and whether it may run, needs a confirmation or is blocked. */
export const planDesign = (id: ConnectionId, request: DesignRequest): Promise<DesignVerdict> =>
  invoke("plan_design", { id, request });

/** A single-use pass for applying exactly this design on a Production Connection. */
export const confirmDesign = (id: ConnectionId, request: DesignRequest): Promise<PassId> =>
  invoke("confirm_design", { id, request });

export const applyDesign = (id: ConnectionId, request: DesignRequest, pass: PassId | null): Promise<DesignOutcome> =>
  invoke("apply_design", { id, request, pass });

/** Removes a dropped table's Recent items on that Connection. */
export const forgetRecent = (connectionId: ConnectionId, path: ObjectPath): Promise<void> =>
  invoke("forget_recent", { connectionId, path });

/** Whether one statement reads or writes, as the Core decides it for the Dialect. */
export const classifySql = (dialect: DialectKind, sql: string): Promise<StatementClass> =>
  invoke("classify_sql", { dialect, sql });

/** The plan of one statement; the Core asks the server to explain it and never runs it. */
export const explainStatement = (session: QuerySessionId, statement: string): Promise<Plan> =>
  invoke("explain_statement", { session, statement });

export const fetchMoreRows = (session: QuerySessionId): Promise<MoreRows> => invoke("fetch_more_rows", { session });

export const cancelQuery = (session: QuerySessionId): Promise<void> => invoke("cancel_query", { session });

export const closeQueryResult = (session: QuerySessionId): Promise<void> => invoke("close_query_result", { session });

export const closeQuerySession = (session: QuerySessionId): Promise<void> =>
  invoke("close_query_session", { session });

export const queryHistory = (id: ConnectionId | null, filter: HistoryFilter): Promise<HistoryEntry[]> =>
  invoke("query_history", { id, filter });

export const clearQueryHistory = (id: ConnectionId | null): Promise<void> => invoke("clear_query_history", { id });

export const listSavedQueries = (): Promise<SavedQuery[]> => invoke("list_saved_queries");

export const saveSavedQuery = (input: SavedQueryInput): Promise<SavedQuery> => invoke("save_saved_query", { input });

export const deleteSavedQuery = (id: string): Promise<void> => invoke("delete_saved_query", { id });

export const loadQueryTabs = (place: string): Promise<string | null> => invoke("load_query_tabs", { place });

export const saveQueryTabs = (place: string, json: string): Promise<void> => invoke("save_query_tabs", { place, json });

export const aiSettings = (groupId: GroupId | null): Promise<AiSettingsView> => invoke("ai_settings", { groupId });

export const saveAiSettings = (
  groupId: GroupId | null,
  settings: AiSettings,
  overrideGroup: boolean,
  key: KeyChange,
): Promise<void> => invoke("save_ai_settings", { groupId, settings, overrideGroup, key });

export const aiTest = (groupId: GroupId | null): Promise<AiTestOk> => invoke("ai_test", { groupId });

export const aiAsk = (groupId: GroupId | null, request: AiRequest): Promise<AiAnswer> =>
  invoke("ai_ask", { groupId, request });

export const listAiThreads = (place: string): Promise<AiThread[]> => invoke("list_ai_threads", { place });

export const saveAiThread = (thread: AiThread): Promise<void> => invoke("save_ai_thread", { thread });

export const deleteAiThread = (id: string): Promise<void> => invoke("delete_ai_thread", { id });

export const clearAiThreads = (place: string): Promise<void> => invoke("clear_ai_threads", { place });

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string";
}

export function isNotOpen(e: unknown): boolean {
  return isCommandError(e) && e.kind === "notFound" && e.message === "connection not open";
}

/**
 * A size in 1024 steps. `"windows"` labels them KB and MB as Windows Explorer does, for sizes
 * shown beside files (the data folder); messages keep KiB and MiB.
 */
function formatBytes(n: number, units: "iec" | "windows" = "iec"): string {
  const [kb, mb] = units === "windows" ? ["KB", "MB"] : ["KiB", "MiB"];
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${mb}`;
  if (n >= 1024) return `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${kb}`;
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
  return `${sentence(message)} Check that Contura can read the file.`;
}

function aiErrorText(e: AiError): string {
  switch (e.kind) {
    case "notConfigured":
      return "No AI provider is set up. Connect one in Settings.";
    case "notAvailable":
      return `Answers from ${PROVIDERS[e.provider].name} arrive in a later Contura version. Nothing was sent.`;
    case "badKey":
      return "The provider did not accept the key. Check it in Settings.";
    case "rateLimited":
      return e.retryAfterSecs === null
        ? "The provider is limiting requests. Try again in a moment."
        : `The provider is limiting requests. Try again in ${e.retryAfterSecs}s.`;
    case "network":
      return `Could not reach ${e.host}. Check your connection and the base URL.`;
  }
}

function cellText(c: Cell): string {
  switch (c.t) {
    case "null":
      return "NULL";
    case "number":
    case "text":
      return c.value;
    case "bytes":
      return `0x${c.previewHex}`;
  }
}

/** `id 42`, or `id 42, line 3` for a composite key. */
function keyText(key: KeyPart[]): string {
  return key.map((k) => `${k.column} ${cellText(k.value)}`).join(", ");
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
      return "This table has no primary key, so Contura cannot pick out one row to open the full value.";
    case "valueTooLarge":
      return `This value is ${formatBytes(e.message)}, more than the 16 MiB Contura opens at once.`;
    case "invalidInput":
      return sentence(e.message);
    case "store":
      return `Could not read or write saved settings: ${e.message}`;
    case "secret":
      return `Could not use Windows Credential Manager: ${e.message}`;
    case "file":
      return `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}. Check the folder exists and Contura can write to it.`;
    case "cancelled":
      return "The query was cancelled.";
    case "timedOut":
      return `Stopped after ${e.message}s, the Connection's timeout.`;
    case "ai":
      return aiErrorText(e.message);
    case "readOnly":
      return "Read-only Connection: this statement writes";
    case "needsConfirmation":
      return "Confirm this write on a Production Connection";
    case "readOnlyRefused":
      return "The server refused a write: this Connection is Read-only";
    case "rowChanged":
      return `Row ${keyText(e.message.key)} changed since you loaded it. Revert the row, then Reload to see the current values.`;
    case "editFailed":
      return `Save failed at statement ${e.message.statement + 1}: ${e.message.message}`;
    case "designFailed": {
      const { statement, ran, total, message } = e.message;
      const failed = `Statement ${statement + 1} failed: ${message}`;
      return ran === 0 ? `Nothing was changed. ${failed}` : `${ran} of ${total} statements were applied. ${failed}`;
    }
    case "designForeignKeys":
      return `Rows in ${e.message.table} would break a Foreign Key. Nothing was changed.`;
    case "designRestoreFailed": {
      const { applied, sql, message } = e.message;
      const what = applied ? "The change was applied, but" : "The change was not applied, and";
      return `${what} restoring the connection with ${sql} failed afterwards: ${message}. Reconnect before you go on.`;
    }
    default: {
      // A kind this UI does not know yet: still show what the Core said.
      const { kind, message } = e as { kind: string; message?: unknown };
      return message === undefined || message === null ? `Error: ${kind}.` : `Error (${kind}): ${String(message)}`;
    }
  }
}

export { formatBytes };
