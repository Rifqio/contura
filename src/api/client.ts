import { Channel, invoke } from "@tauri-apps/api/core";
import { PROVIDERS } from "../settings/ai/providers";
import type {
  AiAccess,
  AiSyncMode,
  ContextInfo,
  ContextStatusRow,
  AiError,
  AiEvent,
  AiSettings,
  AiSettingsView,
  AiThread,
  AiTestOk,
  AnswerAction,
  AnswerActionKind,
  AskRequest,
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
  ModelList,
  ModelPicks,
  Preview,
  ObjectKind,
  ObjectPath,
  Page,
  PageRequest,
  SchemaInfo,
  SuggestedConnection,
  UiPrefs,
  ModelFiles,
  DiagramEntry,
  DiagramFiles,
  FlowTableLink,
  IconEntry,
  IconSet,
  Lineage,
  LineageDepth,
  LineageDirection,
  ViewDependencies,
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
  ColumnTypes,
  VisualQuery,
  VqPreview,
  VqRun,
} from "./types";
import { clampDepth } from "./types";

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

/** The last part of a Windows or POSIX path. */
export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
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

/** Every diagram in Contura's diagrams folder, newest first. */
export const listDiagrams = (): Promise<DiagramEntry[]> => invoke<DiagramEntry[]>("list_diagrams");

export const readDiagram = (name: string): Promise<DiagramFiles> => invoke<DiagramFiles>("read_diagram", { name });

/** Every diagram node with a `table:`, and whether the diagram reads or writes it. */
export const listFlowTableLinks = (): Promise<FlowTableLink[]> => invoke<FlowTableLink[]>("list_flow_table_links");

/** Every packed icon name with its set and title. */
export const iconIndex = (): Promise<IconEntry[]> => invoke<IconEntry[]>("icon_index");

/** The packed icon sets with their licences and source links, for Icon credits. */
export const iconSets = (): Promise<IconSet[]> => invoke<IconSet[]>("icon_sets");

/** Opens an https link in the system browser; the Core checks it again (https only, no user name or password). */
export const openUrl = (url: string): Promise<void> => invoke<void>("open_url", { url });

/** Icon `name`'s SVG text, unchanged. Show it only as an image (`src/flow/icons.ts`), never as markup. */
export const icon = (name: string): Promise<string> => invoke<string>("icon", { name });

/** Saves diagram `name`; without `overwrite`, a taken name rejects with `diagramExists`. */
export const writeDiagram = (name: string, text: string, layout: string, overwrite: boolean): Promise<void> =>
  invoke("write_diagram", { name, text, layout, overwrite });

/**
 * Saves only diagram `name`'s layout file (moves, Classic, the direction): the `.flow` is left as it is, so an
 * edit made outside Contura survives. Rejects with `notFound` when the `.flow` is gone; nothing is recreated.
 */
export const writeDiagramLayout = (name: string, layout: string): Promise<void> => invoke("write_diagram_layout", { name, layout });

/** Moves both files of diagram `name` to the Recycle Bin. */
export const deleteDiagram = (name: string): Promise<void> => invoke("delete_diagram", { name });

export const renameDiagram = (from: string, to: string): Promise<void> => invoke("rename_diagram", { from, to });

/** "Save a copy as...": `path` and `<path>.layout.json`, outside Contura's data folder. */
export const saveDiagramCopy = (text: string, layout: string, path: string): Promise<void> =>
  invoke("save_diagram_copy", { text, layout, path });

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

/** The SQL a Visual Query writes on this Connection, or the problems that stop it. Needs no open session. */
export const visualQuerySql = (id: ConnectionId, query: VisualQuery, types: ColumnTypes): Promise<VqPreview> =>
  invoke("visual_query_sql", { id, query, types });

/** Writes a Visual Query and runs it on the session through the same check, History and result as the editor. */
export const runVisualQuery = (
  session: QuerySessionId,
  query: VisualQuery,
  types: ColumnTypes,
  pass: PassId | null,
): Promise<VqRun> => invoke("run_visual_query", { session, query, types, pass });

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

/** The tables around `path` from catalog details; a `depth` of 0 is All (up to 300 tables, at most 10s). */
export const lineage = (
  id: ConnectionId,
  path: ObjectPath,
  depth: LineageDepth,
  direction: LineageDirection,
): Promise<Lineage> => invoke("lineage", { id, path, depth: clampDepth(depth), direction });

/** The views the catalog records as reading `path`, at most 200; `catalog` is false on SQLite and older MySQL. */
export const viewDependencies = (id: ConnectionId, path: ObjectPath): Promise<ViewDependencies> =>
  invoke("view_dependencies", { id, path });

/** The saved moved-card layout of `path`'s lineage, or null when there is none. */
export const readLineageLayout = (id: ConnectionId, path: ObjectPath): Promise<string | null> =>
  invoke("read_lineage_layout", { id, path });

/** Saves the moved-card layout of `path`'s lineage in Contura's diagrams folder. */
export const writeLineageLayout = (id: ConnectionId, path: ObjectPath, layout: string): Promise<void> =>
  invoke("write_lineage_layout", { id, path, layout });

/** Removes the saved layout of `path`'s lineage. */
export const deleteLineageLayout = (id: ConnectionId, path: ObjectPath): Promise<void> => invoke("delete_lineage_layout", { id, path });

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

/** A row from an older Core has no `kind`: it is SQL. */
const savedRow = (q: SavedQuery): SavedQuery => ({ ...q, kind: q.kind ?? "sql", visualJson: q.visualJson ?? null });

export const listSavedQueries = (): Promise<SavedQuery[]> =>
  invoke<SavedQuery[]>("list_saved_queries").then((list) => (Array.isArray(list) ? list.map(savedRow) : list));

export const saveSavedQuery = (input: SavedQueryInput): Promise<SavedQuery> =>
  invoke<SavedQuery>("save_saved_query", { input }).then((q) => (q ? savedRow(q) : q));

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

/** The provider's models, fetched with the saved key, with what each accepts. */
export const aiModels = (groupId: GroupId | null): Promise<ModelList> => invoke("ai_models", { groupId });

/** The models known without the network: the built-in records and the last fetched listing. */
export const aiKnownModels = (groupId: GroupId | null): Promise<ModelList> => invoke("ai_known_models", { groupId });

/** Remembers the thinking and caching picks for `model` and makes it the current model. */
export const setAiModelPrefs = (groupId: GroupId | null, model: string, picks: ModelPicks): Promise<void> =>
  invoke("set_ai_model_prefs", { groupId, model, picks });

/**
 * Binds the saved key to `host`, the host the keyHostChanged card named. Rejects with keyHostChanged for the
 * current host when the base URL changed again since.
 */
export const aiConfirmKeyHost = (groupId: GroupId | null, host: string): Promise<void> =>
  invoke("ai_confirm_key_host", { groupId, host });

/** What `request` would send, built by the Core: the Sends list and "Show exactly". */
export const aiPreview = (request: AskRequest): Promise<Preview> => invoke("ai_preview", { request });

/**
 * Starts an Ask; its events arrive on `onEvent` in order and end with `done` or `error`. Resolves as soon
 * as the Core has started it, and rejects when it could not start (no provider, or another Ask is running).
 */
export async function aiAskStream(request: AskRequest, onEvent: (e: AiEvent) => void): Promise<void> {
  const events = new Channel<AiEvent>();
  events.onmessage = onEvent;
  await invoke("ai_ask_stream", { request, events });
}

/** Stops a running Ask; false when it had already ended. */
export const aiCancel = (requestId: string): Promise<boolean> => invoke("ai_cancel", { requestId });

export const listAiThreads = (place: string): Promise<AiThread[]> => invoke("list_ai_threads", { place });

/** Saves a thread; `requestId` is the Ask whose answer this save adds, so the Core writes the AI Context it used. */
export const saveAiThread = (thread: AiThread, requestId: string | null = null): Promise<void> =>
  invoke("save_ai_thread", { thread, requestId });

/** Keeps what the user did with the SQL of the answer at `messageAt`; null for an answer kept before records were. */
export const aiRecordAction = (threadId: string, messageAt: number, kind: AnswerActionKind): Promise<AnswerAction | null> =>
  invoke("ai_record_action", { threadId, messageAt, kind });

export const deleteAiThread = (id: string): Promise<void> => invoke("delete_ai_thread", { id });

export const clearAiThreads = (place: string): Promise<void> => invoke("clear_ai_threads", { place });

/** Changes only when a Connection's AI Context is checked; like AI access, it keeps the sessions open. */
export const setAiSyncMode = (connectionId: ConnectionId, mode: AiSyncMode): Promise<ConnectionConfig> =>
  invoke("set_ai_sync_mode", { connectionId, mode });

/** Marks the Connection's AI Context out of date after the schema may have changed (Refresh, a Restore). */
export const aiContextChanged = (connectionId: ConnectionId): Promise<void> => invoke("ai_context_changed", { connectionId });

/** Removes a Connection's AI Context; null removes every AI Context. */
export const aiClearContext = (connectionId: ConnectionId | null): Promise<void> => invoke("ai_clear_context", { connectionId });

/** Removes every AI thread of every place and every AI Context. */
export const aiClearAll = (): Promise<void> => invoke("ai_clear_all", {});

/** The stored AI Contexts of a Connection, or of every Connection with null. */
export const aiContextStatus = (connectionId: ConnectionId | null): Promise<ContextStatusRow[]> =>
  invoke("ai_context_status", { connectionId });

/** Builds the AI Context again now. A failed build resolves with `check.kind` "failed" or "missing". */
export const aiResync = (connectionId: ConnectionId, database: string | null, schema: string | null): Promise<ContextInfo> =>
  invoke("ai_resync", { connectionId, database, schema });

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

/** A token count the compact way, as the context meter shows it: `950`, `18.4K`, `200K`, `1.3M`. */
function tokensText(n: number): string {
  const short = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  // 999,960 rounds to 1,000K, so it reads 1M.
  if (n >= 999_950) return `${short(n / 1_000_000)}M`;
  if (n >= 1000) return `${short(n / 1000)}K`;
  return n.toLocaleString("en-US");
}

/** The local clock, `09:05`. */
function clockText(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The provider's own short message, capped at 200 characters. */
function providerMessage(message: string): string {
  const capped = message.length > 200 ? `${message.slice(0, 199)}…` : message;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

function aiErrorText(e: AiError): string {
  switch (e.kind) {
    case "notConfigured":
      return "No AI provider is set up. Connect one in Settings.";
    case "badKey":
      return "The provider did not accept the key. Check it in Settings.";
    case "rateLimited":
      return e.retryAfterSecs === null
        ? "The provider is limiting requests. Try again in a moment."
        : `The provider is limiting requests. Try again in ${e.retryAfterSecs}s.`;
    case "network":
      return `Could not reach ${e.host}. Check your connection and the base URL.`;
    case "keyHostChanged":
      return `The base URL now points to ${e.host}. Save the key again to send it there.`;
    case "insecureUrl":
      return e.host === ""
        ? "The base URL is not a valid address."
        : `Use https for ${e.host}. Plain http is allowed only on this PC or a private network.`;
    case "timeout":
      return "The provider did not answer in time.";
    case "cancelled":
      return "Stopped.";
    case "provider":
      return `The provider returned an error (${e.status}): ${providerMessage(e.message)}`;
    case "badResponse":
      return "The provider's answer could not be read.";
    case "tooLarge":
      return "This Ask is over the size this model accepts, even after trimming.";
    case "contextUnavailable":
      return `Could not check the schema. Using the context from ${clockText(e.builtAt)}.`;
    case "overloaded":
      return `${PROVIDERS[e.provider].name} is busy right now.`;
    case "urlHasCredentials":
      return "Remove the user name and password from the base URL. Save the key in the key field instead.";
    case "offline":
      return "No internet connection.";
    case "outOfCredit":
      return `Your ${PROVIDERS[e.provider].name} account is out of credit.`;
    case "modelRetired":
      return `${e.model} is no longer offered.`;
    case "contextFull":
      return `This thread fills ${Math.round((e.used / e.window) * 100)}% of ${e.model}'s ${tokensText(e.window)} window.`;
    case "tooBig":
      return `This question needs ${tokensText(e.needed)} tokens. ${e.model} holds ${tokensText(e.window)}.`;
    case "tls":
      return `Could not check the certificate of ${e.host}. A proxy or antivirus may be inspecting https.`;
    case "busy":
      return "An answer is still being written. Stop it first.";
    case "internal":
      return "Something went wrong before the question was sent.";
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

/** A cancelled Sync Apply says what stayed: MySQL commits one by one, PostgreSQL keeps its committed enum values. */
export function syncCancelledText(applied: number, total: number): string {
  if (applied === 0) return "Apply was cancelled. Nothing was changed.";
  const were = applied === 1 ? "was" : "were";
  return `Apply was cancelled. ${applied.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} statements ${were} applied.`;
}

/** Schema Compare: the target changed between the compare and Apply. */
export function planChangedText(connection: string): string {
  return `${connection} changed since you compared. Compare again to see the current Sync Script.`;
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
    case "file": {
      // A whole sentence (a file's content, Q45) is shown as it is; a read gets read advice.
      const text = `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}`;
      if (/[.!?]$/.test(text)) return text;
      if (e.message.startsWith("cannot read")) return `${text}. Check the file exists and Contura can read it.`;
      return `${text}. Check the folder exists and Contura can write to it.`;
    }
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
      const failed = `Statement ${(statement + 1).toLocaleString("en-US")} failed: ${message}`;
      return ran === 0 ? `Nothing was changed. ${failed}` : `${ran.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} statements were applied. ${failed}`;
    }
    case "designForeignKeys":
      return `Rows in ${e.message.table} would break a Foreign Key. Nothing was changed.`;
    case "designRestoreFailed": {
      const { applied, sql, message } = e.message;
      const what = applied ? "The change was applied, but" : "The change was not applied, and";
      return `${what} restoring the connection with ${sql} failed afterwards: ${message}. Reconnect before you go on.`;
    }
    case "jobFailed":
      return e.message.message;
    case "fileChanged":
      return e.message.confirmed === false
        ? `${e.message.file} changed while Contura read it. Nothing was imported.`
        : `${e.message.file} changed after you confirmed. Nothing was imported.`;
    case "jobBusy":
      return `Another import is writing to ${e.message.connection}. Wait for it to end.`;
    case "fileExists":
      return `${fileName(e.message)} exists.`;
    case "readStopped":
      return "The read stopped unexpectedly. Nothing more was written.";
    case "afterCommit":
      return `The rows were committed, but ${e.message.sql} failed afterwards: ${e.message.message}.`;
    case "diagramExists":
      return `${e.message.name}.flow already exists.`;
    case "backupRefused":
      return e.message.reason;
    case "planChanged":
      return planChangedText(e.message.connection);
    case "syncCancelled":
      return syncCancelledText(e.message.applied, e.message.total);
    default: {
      // A kind this UI does not know yet: still show what the Core said.
      const { kind, message } = e as { kind: string; message?: unknown };
      return message === undefined || message === null ? `Error: ${kind}.` : `Error (${kind}): ${String(message)}`;
    }
  }
}

export { formatBytes };
