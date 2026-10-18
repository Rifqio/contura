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

export type ThemeChoice = "system" | "light" | "dark";

export type RowHeight = 24 | 28;

export interface EditorPrefs {
  family: string;
  size: number;
  lineHeight: number;
  ligatures: boolean;
}

export interface UiPrefs {
  theme: ThemeChoice;
  rowHeight: RowHeight;
  editor: EditorPrefs;
  brighterComments: boolean;
  inlineSuggestions: boolean;
  /** `null` keeps history forever. */
  historyKeepDays: number | null;
}

/** Mirrors the Core defaults; used before the Core answers. */
export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: "dark",
  rowHeight: 28,
  editor: { family: "JetBrains Mono", size: 13, lineHeight: 20, ligatures: true },
  brighterComments: false,
  inlineSuggestions: false,
  historyKeepDays: null,
};

/** Shortcut overrides by command id; an empty list unbinds the command. */
export type KeymapOverrides = Record<string, string[]>;

export type RecentTarget =
  | { kind: "query"; savedId: string; name: string }
  | { kind: "table"; path: ObjectPath; object: ObjectKind }
  | { kind: "schemaModel"; file: string };

export interface RecentItem {
  target: RecentTarget;
  connectionId: string | null;
  openedAtMs: number;
}

export type GroupColor = "teal" | "indigo" | "green" | "gold" | "lime" | "sky" | "violet" | "pink";

export const GROUP_COLORS: readonly GroupColor[] = [
  "teal",
  "indigo",
  "green",
  "gold",
  "lime",
  "sky",
  "violet",
  "pink",
];

export interface Group {
  id: GroupId;
  name: string;
  color: GroupColor;
  hasImage: boolean;
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
  rows: number | null;
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
  version: string | null;
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
  | { kind: "editFailed"; message: { statement: number; message: string } }
  /**
   * A design's statement (by index in the plan) failed. `ran` statements before it stay
   * applied: MySQL commits each one, elsewhere it is always 0.
   */
  | { kind: "designFailed"; message: { statement: number; ran: number; total: number; message: string } }
  /** An SQLite rebuild found rows in `table` that break a Foreign Key; nothing was changed. */
  | { kind: "designForeignKeys"; message: { table: string } }
  /**
   * A design's closing statement `sql`, which restores the connection, failed. `applied`:
   * the change itself was applied, so the table differs from the one loaded.
   */
  | { kind: "designRestoreFailed"; message: { applied: boolean; sql: string; message: string } }
  /** An import or export stopped at `at`; `message` names the place and the fix. */
  | { kind: "jobFailed"; message: { at: JobPosition; message: string } }
  /** The file of a confirmed Production import changed before the run. */
  | { kind: "fileChanged"; message: { file: string; confirmed: boolean } }
  /** A second writing job on one Connection (by name). */
  | { kind: "jobBusy"; message: { connection: string } }
  /** The export target exists; the message is its path. */
  | { kind: "fileExists"; message: string }
  /** An export read ended without finishing; the file was not kept. */
  | { kind: "readStopped"; message?: undefined }
  /** A writer's COMMIT succeeded, then a closing statement `sql` failed; the rows are in. */
  | { kind: "afterCommit"; message: { sql: string; message: string } };

/** One table as the server holds it, for the Table Designer. */
export interface TableDesign {
  path: ObjectPath;
  columns: TableColumn[];
  /** The primary key first, then the rest by name (SQLite: by creation). */
  indexes: TableIndex[];
  foreignKeys: TableForeignKey[];
  /** Foreign Keys of other tables (or this one) that reference this table. */
  referencedBy: IncomingRef[];
  comment: string | null;
  /** What the designer cannot edit, such as `check <name>` or `trigger <name>`. */
  unsupported: string[];
  sqlite: SqliteExtras | null;
}

export type Increment = { kind: "none" } | { kind: "autoIncrement" } | { kind: "identity" } | { kind: "serial" };

export interface TableColumn {
  name: string;
  /** The type as the server writes it, such as `varchar(16)`. */
  typeSql: string;
  nullable: boolean;
  /** The default as SQL text, such as `'new'` or `CURRENT_TIMESTAMP`. */
  defaultSql: string | null;
  increment: Increment;
  comment: string | null;
  generated: boolean;
  mysql: MySqlColumn | null;
  sqliteAutoincrement: boolean;
  collation: string | null;
  /** MySQL: the column may only be renamed or dropped. */
  advanced: boolean;
  /** PostgreSQL `GENERATED ALWAYS AS IDENTITY`; false elsewhere. */
  identityAlways: boolean;
}

export interface MySqlColumn {
  charset: string | null;
  collation: string | null;
  onUpdate: string | null;
}

export interface TableIndex {
  name: string;
  /** Column names; an expression key part holds its text. */
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** PostgreSQL: the index backs a PRIMARY KEY or UNIQUE constraint. */
  constraint: boolean;
  /** SQLite: the saved `CREATE INDEX` text. */
  sql: string | null;
  /** PostgreSQL access method, MySQL index type, lower case; SQLite null. */
  method: string | null;
  /** A partial index's WHERE text. */
  predicate: string | null;
  /** Some key part is an expression. */
  expression: boolean;
  advanced: boolean;
}

export interface TableForeignKey {
  name: string;
  columns: string[];
  target: ObjectPath;
  targetColumns: string[];
  /** Upper case, such as `CASCADE`; null for the Dialect's default. */
  onDelete: string | null;
  onUpdate: string | null;
  advanced: boolean;
}

export interface IncomingRef {
  name: string;
  table: ObjectPath;
  /** SQLite: the key's ON DELETE action, upper case, such as `CASCADE`; null for NO ACTION and on MySQL and PostgreSQL. */
  onDelete: string | null;
}

export interface SavedObject {
  name: string;
  sql: string;
}

/** What an SQLite rebuild must carry over. */
export interface SqliteExtras {
  createSql: string;
  triggers: SavedObject[];
  views: SavedObject[];
  foreignKeysOn: boolean;
  viewTriggers: SavedObject[];
  /** Other tables with a Foreign Key to this one, with their saved CREATE TABLE. */
  children: SavedObject[];
}

export interface ColumnDraft {
  name: string;
  typeSql: string;
  nullable: boolean;
  defaultSql: string | null;
  increment: boolean;
  comment: string | null;
}

export interface IndexDraft {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyDraft {
  name: string;
  columns: string[];
  target: ObjectPath;
  targetColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export type Position = { kind: "last" } | { kind: "first" } | { kind: "after"; column: string };

/** One change, keyed by the name as loaded. */
export type DesignEdit =
  | { op: "addColumn"; column: ColumnDraft; position: Position }
  | { op: "dropColumn"; name: string }
  /** A rename when `column.name !== name`. */
  | { op: "changeColumn"; name: string; column: ColumnDraft }
  | { op: "moveColumn"; name: string; position: Position }
  | { op: "addIndex"; index: IndexDraft }
  | { op: "dropIndex"; name: string }
  | { op: "renameIndex"; name: string; to: string }
  | { op: "addForeignKey"; key: ForeignKeyDraft }
  | { op: "dropForeignKey"; name: string }
  | { op: "tableComment"; comment: string | null };

/** Alter and Drop carry the design as loaded. */
export type DesignTarget =
  | { kind: "alter"; base: TableDesign }
  | { kind: "create"; path: ObjectPath }
  | { kind: "drop"; base: TableDesign };

export interface DesignRequest {
  target: DesignTarget;
  edits: DesignEdit[];
}

export type DesignMode =
  | { kind: "atomic" }
  | { kind: "sequential" }
  | { kind: "transaction" }
  /** Shown for copying only; Apply refuses it. */
  | { kind: "copyOnly"; reason: string };

export type Rule = "notNull" | "unique" | "primaryKey" | "foreignKey";

/** A Drop's bounded row count: `over` stopped at `n`, the table holds more. */
export type RowCount = { kind: "exact"; n: number } | { kind: "over"; n: number };

export type DesignWarning =
  | { kind: "dropColumn"; column: string }
  | { kind: "narrowType"; column: string; from: string; to: string; note: string | null }
  | { kind: "existingRows"; rule: Rule; name: string }
  | { kind: "dropRule"; rule: Rule; name: string }
  | { kind: "rewriteLock"; table: string }
  | { kind: "rebuildCopy"; table: string }
  | { kind: "renameColumn"; from: string; to: string }
  | { kind: "dropTable"; table: string; rows: RowCount | null; referencedBy: string[] }
  /** SQLite with Foreign Keys on: the drop deletes every row first, which runs the ON DELETE action of a key in `child`. */
  | { kind: "childRows"; table: string; child: string; action: ChildAction };

/** What a SQLite drop does to a child table's rows. */
export type ChildAction = "delete" | "clear" | "setDefault" | "fail";

/** The exact DDL a design runs. */
export interface DesignPlan {
  statements: string[];
  warnings: DesignWarning[];
  mode: DesignMode;
  /** Leading statements that run before the transaction (SQLite rebuild). */
  before: number;
  /** Trailing statements that run after it, also after a failure (SQLite rebuild). */
  after: number;
  /** Positions of the statements that are checks. */
  checks: number[];
  /** SQLite rebuild: the `PRAGMA foreign_keys` value the plan was made with. */
  foreignKeys: boolean | null;
}

export interface DesignVerdict {
  plan: DesignPlan;
  verdict: RunVerdict;
}

/** What Apply did. A failure comes back as an error (`designFailed`, `designForeignKeys`), never as an outcome. */
export type DesignOutcome = { kind: "done"; ran: number };

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
  /** The constraint's name; SQLite has one only when the table's text gives it. */
  name?: string | null;
  /** The constraint's comment, where the server keeps one (PostgreSQL). */
  comment?: string | null;
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

export interface PlanNode {
  label: string;
  object: string | null;
  rows: number | null;
  cost: number | null;
  fullScan: boolean;
  children: PlanNode[];
}

export interface Plan {
  nodes: PlanNode[];
  raw: string;
  totalCost: number | null;
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
  /** The Connection the query opens on; null when none or it was deleted. */
  connectionId: ConnectionId | null;
  /** Missing from an older Core: `listSavedQueries` reads it as "sql". */
  kind?: SavedQueryKind;
  /** A Visual Query's model as saved; its `sql` is the last generated SQL. */
  visualJson?: string | null;
}

/** What a Saved Query holds; both kinds share one name space. */
export type SavedQueryKind = "sql" | "visual";

export interface SavedQueryInput {
  id: string | null;
  name: string;
  sql: string;
  connectionId?: ConnectionId | null;
  kind?: SavedQueryKind;
  visualJson?: string | null;
}

export interface SavedQueryRun {
  savedId: string;
  ranAtMs: number;
  rows: number | null;
  elapsedMs: number;
}

export interface DataFolderInfo {
  path: string | null;
  connections: number;
  groups: number;
  savedQueries: number;
  historyBytes: number;
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
  newConnectionAccess: AiAccess;
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

// Visual Query (step 6). Mirrors crates/contura-core/src/visual_query.

/** One table card. `schema` is the PostgreSQL schema, or the MySQL database or SQLite scope when it differs from the tab's database. */
export interface VqTable {
  id: string;
  schema: string | null;
  name: string;
  alias: string;
  x: number;
  y: number;
}

export type JoinKind = "inner" | "left" | "right" | "full";

export interface ColumnPair {
  leftColumn: string;
  rightColumn: string;
}

/** One Foreign Key a pending Join can use. */
export interface FkChoice {
  name: string;
  on: ColumnPair[];
  comment?: string | null;
}

export interface VqJoin {
  id: string;
  left: string;
  right: string;
  kind: JoinKind;
  on: ColumnPair[];
  /** Set while the user has not picked which Foreign Key the Join uses. */
  pending?: FkChoice[] | null;
}

export type Aggregate = "count" | "countDistinct" | "sum" | "avg" | "min" | "max";

export interface VqColumn {
  table: string;
  column: string;
  alias: string | null;
  aggregate: Aggregate | null;
}

export type FilterOp =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "like"
  | "notLike"
  | "in"
  | "notIn"
  | "between"
  | "isNull"
  | "isNotNull";

/** One filter row; an empty `column` means none is picked yet. */
export interface VqFilter {
  joiner: "and" | "or";
  table: string;
  column: string;
  op: FilterOp;
  values: string[];
}

export interface ColumnRef {
  table: string;
  column: string;
}

export type GroupBy = { kind: "auto" } | { kind: "manual"; columns: ColumnRef[] };

export type SortTarget = { kind: "output"; index: number } | { kind: "column"; table: string; column: string };

export interface VqSort {
  target: SortTarget;
  dir: "asc" | "desc";
}

export interface VisualQuery {
  version: number;
  database: string | null;
  dialect?: DialectKind | null;
  tables: VqTable[];
  joins: VqJoin[];
  columns: VqColumn[];
  filters: VqFilter[];
  groupBy: GroupBy;
  orderBy: VqSort[];
  limit: number | null;
  distinct: boolean;
}

/** Table id to column name to type text, from the schema the UI already holds. */
export type ColumnTypes = Record<string, Record<string, string>>;

export type PartKind =
  | { kind: "select" }
  | { kind: "from"; table: string }
  | { kind: "join"; join: string }
  | { kind: "where"; filter: number }
  | { kind: "groupBy" }
  | { kind: "orderBy" }
  | { kind: "limit" };

/** The lines one piece of the model wrote, 1-based and inclusive. */
export interface SqlPart {
  part: PartKind;
  fromLine: number;
  toLine: number;
}

/** `table` is a table id. `rows` is always null from the Core; the UI fills it. */
export type VqWarning =
  | { kind: "crossJoin"; table: string; rows: number | null }
  | { kind: "pendingPick"; table: string }
  | { kind: "leftOut"; table: string; columns: string[] };

export interface GeneratedQuery {
  sql: string;
  parts: SqlPart[];
  /** Each output column's final name, in SELECT order. */
  outputs: string[];
  warnings: VqWarning[];
}

export type ProblemTarget =
  | { kind: "query" }
  | { kind: "columns" }
  | { kind: "table"; id: string }
  | { kind: "join"; id: string }
  | { kind: "filter"; index: number }
  | { kind: "sort"; index: number };

export interface VqProblem {
  target: ProblemTarget;
  message: string;
}

/** The query when nothing stops it, else every problem with the field it belongs to. */
export interface VqPreview {
  query: GeneratedQuery | null;
  problems: VqProblem[];
}

/** A Visual Query run: the text that ran and the editor's result for it. */
export interface VqRun {
  sql: string;
  execution: Execution;
}

// Import and export jobs (step 7). Paths are strings, u64 values are numbers, and
// SHA-256 values travel as lowercase hex strings.

export type JobId = string;
export type JobKind = "export" | "import" | "scriptImport" | "check";
export type Format = "csv" | "json" | "xlsx" | "sql";
export type Delimiter = "comma" | "semicolon" | "tab";
export type NullText = "emptyCell" | "nullWord";
export type BinaryText = "hex" | "base64";
export type JsonLayout = "lines" | "array";
export type SqlTableName = "asSource" | "unqualified";
export type EmptyAs = "null" | "emptyText";
export type OnError = "stop" | "skip";
export type CommitMode = { kind: "once" } | { kind: "every"; rows: number };

export interface ExportOptions {
  delimiter: Delimiter;
  nullAs: NullText;
  header: boolean;
  bom: boolean;
  binary: BinaryText;
  jsonLayout: JsonLayout;
  freezeHeader: boolean;
  rowsPerStatement: number;
  tableName: SqlTableName;
}

/** The Core's defaults: a field left out of a request reads as these. */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  delimiter: "comma",
  nullAs: "emptyCell",
  header: true,
  bom: false,
  binary: "hex",
  jsonLayout: "lines",
  freezeHeader: true,
  rowsPerStatement: 500,
  tableName: "asSource",
};

/** An empty `columns` list means all columns, in table order. */
export type ExportSource =
  | {
      kind: "table";
      path: ObjectPath;
      columns: string[];
      filter: string | null;
      sort: SortSpec | null;
      /** Selected rows by key; empty means every row. */
      keys: KeyPart[][];
    }
  /** `columns`: the output columns to keep, in order (the result panel's shown ones); empty keeps them all. */
  | { kind: "query"; database: string | null; sql: string; columns: string[] }
  /** The rows a result already shows (D16). */
  | { kind: "rows"; columns: ResultColumn[]; rows: Cell[][] };

export interface ExportRequest {
  connectionId: ConnectionId;
  source: ExportSource;
  format: Format;
  options: ExportOptions;
  path: string;
  rowsHint: number | null;
}

export interface ExportPreview {
  lines: string[];
  sheet: string[][] | null;
  encoding: string;
  bytesPerRow: number;
  sampleRows: number;
  notes: string[];
  /** False when the statement does not only read (D16): offer "Rows shown" alone. */
  queryRead: boolean;
}

export interface ImportOptions {
  /** null sniffs it from the file. */
  delimiter: Delimiter | null;
  header: boolean;
  emptyAs: EmptyAs;
  onError: OnError;
  commit: CommitMode;
  sheet: string | null;
  /** "Read the text NULL as NULL" (Q31), CSV and Excel only; off by default. */
  nullWord?: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  delimiter: null,
  header: true,
  emptyAs: "null",
  onError: "stop",
  commit: { kind: "once" },
  sheet: null,
  nullWord: false,
};

/** One file column and the table column it goes into; `into: null` leaves it out. */
export interface ColumnMap {
  fileColumn: number;
  into: string | null;
  byHand: boolean;
}

export interface ImportRequest {
  connectionId: ConnectionId;
  table: ObjectPath;
  file: string;
  format: Format;
  options: ImportOptions;
  /** Empty means match by name. */
  mapping: ColumnMap[];
}

/** Rust `jobs::types::RowCount`; renamed here, where `RowCount` is a Drop's bounded count. */
export interface FileRowCount {
  rows: number;
  exact: boolean;
}

export interface FileSummary {
  format: Format;
  delimiter: Delimiter | null;
  /** "UTF-8" or "UTF-8 with BOM". */
  encoding: string;
  bytes: number;
  header: string[];
  /** The first 20 rows as text; null is an empty unquoted cell. */
  rows: (string | null)[][];
  rowsEstimate: FileRowCount;
  sheets: string[];
  conturaBackup: boolean;
}

export interface PlannedColumn {
  into: string;
  typeSql: string;
  fileColumn: number | null;
  note: string | null;
  blocks: string | null;
  /** Filled by the database: never offered as an Into column. */
  generated: boolean;
}

export interface PreviewCell {
  text: string | null;
  problem: string | null;
}

export interface InsertShape {
  head: string;
  /** The first 4 rows of the first statement. */
  firstRows: string[];
  rowsPerStatement: number;
  statements: number;
  rows: number;
}

export type JobVerdict =
  | { kind: "ok" }
  | { kind: "readOnly"; connection: string }
  | {
      kind: "needsConfirmation";
      connection: string;
      database: string | null;
      fingerprint: string;
      fileBytes: number;
      fileSha256: string;
    }
  | { kind: "blocked"; reasons: string[] };

export interface ImportPlan {
  columns: PlannedColumn[];
  preview: PreviewCell[][];
  sampleInsert: string;
  extra: string[];
  shape: InsertShape;
  warnings: string[];
  verdict: JobVerdict;
  /** Q28: the whole import runs in one transaction (false for MyISAM and Commit every N). Absent: read from the options and warnings. */
  oneTransaction?: boolean;
}

export type ScriptAction = { kind: "run" } | { kind: "skip"; reason: string } | { kind: "refuse"; reason: string };
export type StatementKind = "create" | "insert" | "other";

export interface ScriptStatement {
  index: number;
  line: number;
  text: string;
  class: StatementClass;
  kind: StatementKind;
  action: ScriptAction;
  /** Q12: it would be skipped and runs because Run as is is ticked. */
  runAsIs?: boolean;
}

export interface ScriptRequest {
  connectionId: ConnectionId;
  database: string | null;
  path: string;
  runAsIs: boolean;
}

export type ConfirmItem =
  | { kind: "exact"; line: number; text: string }
  | { kind: "shape"; line: number; shape: InsertShape };

export interface ScriptPlan {
  statements: number;
  creates: number;
  inserts: number;
  skipped: ScriptStatement[];
  refused: ScriptStatement[];
  ownTransactions: boolean;
  hasDdl: boolean;
  conturaBackup: boolean;
  /** The first 50 statements. */
  first: ScriptStatement[];
  /** The first 200 items of the Production confirmation. */
  confirm: ConfirmItem[];
  confirmMore: number;
  bytes: number;
  sha256: string;
  verdict: JobVerdict;
  /** Q28: the script runs in one transaction (false for its own transactions and MySQL DDL). Absent: read from the plan. */
  oneTransaction?: boolean;
  /** Skipped statements past the 1,000 that `skipped` holds. */
  skippedMore?: number;
  /** Refused statements past the 1,000 that `refused` holds. */
  refusedMore?: number;
}

export type JobPhase = "checking" | "reading" | "writing" | "committing" | "rollingBack";

export interface CellProblem {
  fileRow: number;
  column: string;
  message: string;
}

export interface CheckReport {
  rows: number;
  failing: number;
  /** The first 20 problems. */
  first: CellProblem[];
  sha256: string;
}

export interface JobReport {
  kind: JobKind;
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  skipped: number;
  warnings: string[];
  elapsedMs: number;
  file: string | null;
  bytes: number;
  committed: number;
  check: CheckReport | null;
}

export type JobEvent =
  | {
      kind: "progress";
      phase: JobPhase;
      table: string | null;
      rowsDone: number;
      rowsTotal: number | null;
      bytesDone: number;
      bytesTotal: number | null;
      statementsDone: number;
      fileRow: number | null;
    }
  | { kind: "warning"; message: string }
  | { kind: "rowSkipped"; fileRow: number; column: string | null; message: string }
  | { kind: "finished"; report: JobReport }
  /** Q27: `rowsCommitted` rows stay in the database after the stop; absent means 0. */
  | { kind: "failed"; error: CommandError; rowsCommitted?: number };

export interface JobSummary {
  id: JobId;
  kind: JobKind;
  connectionId: ConnectionId;
  /** Such as "Exporting orders". */
  label: string;
  percent: number | null;
  startedAtMs: number;
}

/** Where a job stopped: a file row or line, a table, a statement number. */
export interface JobPosition {
  fileRow: number | null;
  line: number | null;
  table: string | null;
  statement: number | null;
}
