// Mirrors the serde shapes of crates/contura-core (model.rs, connections.rs,
// suggest.rs, error.rs). Field names are camelCase on the wire.

export type ConnectionId = string;
export type GroupId = string;

export type DialectKind = "mysql" | "postgres" | "sqlite";

export type SslMode = { mode: "disable" } | { mode: "require" } | { mode: "verifyCa"; caPath: string };

export interface ConnectionConfig {
  id: ConnectionId;
  name: string;
  dialect: DialectKind;
  host: string;
  port: number;
  user: string;
  database: string | null;
  ssl: SslMode;
  /** The database file, for SQLite only. */
  file: string | null;
  groupId: GroupId | null;
  /** Typed queries past this many seconds are cancelled on the server; null means no limit. */
  queryTimeoutSecs: number | null;
  /** What the AI assistant may see of this Connection. */
  aiAccess: AiAccess;
  /** Writes ask for confirmation first. */
  production: boolean;
  /** Writes are blocked by the Core and refused by the server. */
  readOnly: boolean;
}

export type GroupColor = "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "rose" | "slate";

export const GROUP_COLORS: readonly GroupColor[] = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "rose",
  "slate",
];

export interface Group {
  id: GroupId;
  name: string;
  color: GroupColor;
}

export interface ObjectPath {
  database: string;
  schema: string | null;
  name: string;
}

export interface SchemaInfo {
  name: string;
  isSystem: boolean;
}

export type ObjectKind = "table" | "view" | "procedure" | "function" | "trigger";

export interface DbObject {
  kind: ObjectKind;
  name: string;
}

export interface ColumnInfo {
  name: string;
  typeName: string;
  isPrimaryKey: boolean;
}

/** Numbers travel as strings so 64-bit and DECIMAL values keep every digit. */
export type Cell =
  | { t: "null" }
  | { t: "number"; value: string }
  | { t: "text"; value: string; truncated: boolean; totalBytes: number }
  | { t: "bytes"; previewHex: string; truncated: boolean; totalBytes: number };

export interface SortSpec {
  column: string;
  descending: boolean;
}

export interface PageRequest {
  table: ObjectPath;
  page: number;
  sort: SortSpec | null;
  /** A SQL expression over the table's columns; the Core wraps it as `WHERE (...)`. */
  filter?: string | null;
}

export interface Page {
  columns: ColumnInfo[];
  rows: Cell[][];
  hasMore: boolean;
}

export interface KeyPart {
  column: string;
  value: Cell;
}

export interface FullValueRequest {
  table: ObjectPath;
  column: string;
  key: KeyPart[];
}

export type FullValue = { t: "text"; value: string } | { t: "bytes"; base64: string };

export type PasswordChange = { t: "keep" } | { t: "set"; value: string } | { t: "clear" };

export interface ConnectionInput {
  id: ConnectionId | null;
  name: string;
  dialect: DialectKind;
  host: string;
  port: number;
  user: string;
  database: string | null;
  ssl: SslMode;
  /** The database file, for SQLite only. */
  file: string | null;
  password: PasswordChange;
  groupId: GroupId | null;
  queryTimeoutSecs: number | null;
  /** What the AI assistant may see of this Connection. */
  aiAccess: AiAccess;
  production: boolean;
  readOnly: boolean;
}

export interface GroupInput {
  id: GroupId | null;
  name: string;
  color: GroupColor;
}

export interface SuggestedConnection {
  name: string;
  dialect: DialectKind;
  host: string;
  port: number;
  user: string;
}

/** `message` is absent for unit variants and a byte count for `valueTooLarge`. */
export type CommandError =
  | { kind: "connect"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "query"; message: string }
  | { kind: "notFound"; message: string }
  | { kind: "noPrimaryKey"; message?: undefined }
  | { kind: "valueTooLarge"; message: number }
  | { kind: "invalidInput"; message: string }
  | { kind: "store"; message: string }
  | { kind: "secret"; message: string }
  | { kind: "file"; message: string }
  | { kind: "cancelled"; message?: undefined }
  /** The Connection's timeout, in seconds. */
  | { kind: "timedOut"; message: number }
  | { kind: "ai"; message: AiError }
  /** The index of the first statement that writes. */
  | { kind: "readOnly"; message: number }
  | { kind: "needsConfirmation"; message?: undefined }
  | { kind: "readOnlyRefused"; message?: undefined }
  /** A save's UPDATE or DELETE (`statement` is its index in the plan) found its row changed or gone. */
  | { kind: "rowChanged"; message: { statement: number; key: KeyPart[] } }
  /** The server refused a save's statement (by index in the plan). */
  | { kind: "editFailed"; message: { statement: number; message: string } };

/** A value typed into a cell; numbers and dates are sent as text too. */
export type NewValue = { t: "text"; value: string } | { t: "null" };

export interface CellChange {
  column: string;
  /** The value as loaded, to check the row did not change meanwhile. */
  old: Cell;
  new: NewValue;
}

export interface RowUpdate {
  key: KeyPart[];
  changes: CellChange[];
}

export interface RowInsert {
  /** Column name and value; columns left out take their default. */
  values: [string, NewValue][];
}

export interface RowDelete {
  key: KeyPart[];
}

/** Pending edits to one table, saved together. */
export interface EditSet {
  table: ObjectPath;
  updates: RowUpdate[];
  inserts: RowInsert[];
  deletes: RowDelete[];
}

/** The exact SQL a save runs, and what running it needs. */
export interface EditPlan {
  statements: string[];
  verdict: RunVerdict;
}

export interface EditOutcome {
  updated: number;
  inserted: number;
  deleted: number;
}

/** A Schema Model on disk: the DBML and, when it exists, its layout sidecar. */
export interface ModelFiles {
  dbml: string;
  layout: string | null;
}

// Schema Model: mirrors crates/contura-core/src/schema_model.rs.

export type SmDefault =
  | { t: "string"; value: string }
  | { t: "number"; value: string }
  | { t: "bool"; value: boolean }
  | { t: "null" }
  | { t: "expression"; value: string };

export interface SmColumn {
  name: string;
  typeName: string;
  pk: boolean;
  increment: boolean;
  notNull: boolean;
  unique: boolean;
  default: SmDefault | null;
  note: string | null;
}

/** A composite primary key is an index with `pk: true`. */
export interface SmIndex {
  name: string | null;
  columns: string[];
  unique: boolean;
  pk: boolean;
}

export interface SmTable {
  schema: string | null;
  name: string;
  alias: string | null;
  note: string | null;
  columns: SmColumn[];
  indexes: SmIndex[];
}

export interface SmEndpoint {
  schema: string | null;
  table: string;
  columns: string[];
}

/** `from` is the many side, `to` the one side. Actions are upper case. */
export interface SmRef {
  name: string | null;
  from: SmEndpoint;
  to: SmEndpoint;
  onDelete: string | null;
  onUpdate: string | null;
}

export interface SmEnum {
  schema: string | null;
  name: string;
  values: string[];
}

export interface SqlColumn {
  name: string;
  typeName: string;
  pk: boolean;
}

export interface SqlTable {
  schema: string | null;
  name: string;
  kind: "table" | "view";
  columns: SqlColumn[];
}

export interface SqlFk {
  from: SmEndpoint;
  to: SmEndpoint;
}

/** Names, kinds, column types and Foreign Keys of one database; never row data. */
export interface SqlSchema {
  searchPath: string[];
  tables: SqlTable[];
  fks: SqlFk[];
}

export interface SchemaModel {
  dialect: DialectKind;
  tables: SmTable[];
  refs: SmRef[];
  enums: SmEnum[];
  skipped: string[];
}

/** A query tab's own session on a Connection. */
export type QuerySessionId = string;

/** A single-use confirmation for the writes of one run on a Production Connection. */
export type PassId = string;

export type StatementClass = "read" | "write";

export interface PlannedStatement {
  text: string;
  class: StatementClass;
}

export type RunVerdict =
  | { kind: "ok" }
  /** `statement` is the index of the first statement that writes. */
  | { kind: "readOnly"; statement: number }
  | {
      kind: "needsConfirmation";
      connection: string;
      database: string | null;
      statements: PlannedStatement[];
      writes: number;
    };

export interface ResultColumn {
  name: string;
  typeName: string;
  numeric: boolean;
}

export type ExecOutcome =
  | { t: "rows"; columns: ResultColumn[]; rows: Cell[][]; hasMore: boolean }
  | { t: "affected"; rows: number };

export interface Execution {
  outcome: ExecOutcome;
  elapsedMs: number;
}

export interface MoreRows {
  rows: Cell[][];
  hasMore: boolean;
}

export type Outcome = "ok" | "error" | "cancelled" | "timedOut";

export interface HistoryEntry {
  id: number;
  connectionId: ConnectionId;
  sql: string;
  ranAtMs: number;
  elapsedMs: number;
  outcome: Outcome;
  /** Rows returned (first page) or changed; null when the statement did not finish. */
  rows: number | null;
  changed: boolean;
  error: string | null;
}

export interface HistoryFilter {
  search: string | null;
  only: "failed" | "changes" | null;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  updatedAtMs: number;
}

export interface SavedQueryInput {
  id: string | null;
  name: string;
  sql: string;
}
export type AiAccess = "never" | "schema" | "schemaQuery" | "schemaQueryRows";

export type AiProviderKind = "openai" | "anthropic" | "groq" | "deepseek" | "custom";

export interface AiSettings {
  provider: AiProviderKind | null;
  preset: string | null;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  inlineAsk: boolean;
  errorAsk: boolean;
}

/** The saved key never comes back: only whether one is saved and its last 4 characters. */
export interface AiSettingsView {
  settings: AiSettings;
  groupOverride: boolean;
  keySaved: boolean;
  keyLast4: string | null;
}

export type KeyChange = { t: "keep" } | { t: "set"; value: string } | { t: "clear" };

export type AiError =
  | { kind: "notConfigured" }
  | { kind: "notAvailable"; provider: AiProviderKind }
  | { kind: "badKey" }
  | { kind: "rateLimited"; retryAfterSecs: number | null }
  | { kind: "network"; host: string };

export interface AiRequest {
  question: string;
  payload: string;
}

export interface AiAnswer {
  text: string;
}

export type AiRole = "user" | "assistant" | "notice";

export interface AiMessage {
  role: AiRole;
  text: string;
  context: string[];
  at: number;
}

export interface AiThread {
  id: string;
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  title: string;
  messages: AiMessage[];
  updatedAt: number;
}

export interface AiTestOk {
  model: string;
  millis: number;
}
