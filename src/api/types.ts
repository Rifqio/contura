// Mirrors the serde shapes of crates/contura-core (model.rs, connections.rs,
// suggest.rs, error.rs). Field names are camelCase on the wire.

export type ConnectionId = string;
export type GroupId = string;

export type DialectKind = "mysql" | "postgres" | "sqlite";

export type SslMode =
  | { mode: "disable" }
  | { mode: "require" }
  | { mode: "verifyCa"; caPath: string }
  | { mode: "verifyFull"; caPath: string | null };

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
  /** When its AI Context is checked against the schema. The Core always sends it; absent reads Automatic. */
  aiSync?: AiSyncMode;
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

/** How the diagram assistant's accepted changes land: after a review, or at once. */
export type FlowAssistMode = "review" | "auto";

/** The diagram tab's side panel: hidden to its rail or not, and the tab it shows. */
export interface FlowSidePanelPref {
  hidden: boolean;
  tab: "editor" | "assistant";
}

export interface UiPrefs {
  theme: ThemeChoice;
  rowHeight: RowHeight;
  editor: EditorPrefs;
  brighterComments: boolean;
  inlineSuggestions: boolean;
  /** `null` keeps history forever. */
  historyKeepDays: number | null;
  flowSidePanel: FlowSidePanelPref;
  /** How the diagram assistant's changes land: "Review first" (the start) or "Auto-apply". */
  flowAssistMode: FlowAssistMode;
  /** Item 36: the Visual Query's bottom panel height in px; null is the default. */
  vqPanelHeight: number | null;
  /** What Ungrouped is called; `null` is "Ungrouped". */
  ungroupedLabel: string | null;
  /** Text and controls in every window, as a percent. */
  interfaceSize: InterfaceSize;
  /** Every data grid shades alternate rows. */
  stripeRows: boolean;
  /** How the data grids draw SQL NULL; copy and export always keep real NULL. */
  nullAs: NullDisplay;
}

export type InterfaceSize = 90 | 100 | 110 | 125;
export const INTERFACE_SIZES: readonly InterfaceSize[] = [90, 100, 110, 125];

/** The word NULL, the empty-set sign, or nothing visible (a screen reader still hears NULL). */
export type NullDisplay = "null" | "symbol" | "blank";

/** Mirrors the Core defaults; used before the Core answers. */
export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: "dark",
  rowHeight: 28,
  editor: { family: "JetBrains Mono", size: 13, lineHeight: 20, ligatures: true },
  brighterComments: false,
  inlineSuggestions: false,
  historyKeepDays: null,
  flowSidePanel: { hidden: false, tab: "editor" },
  flowAssistMode: "review",
  vqPanelHeight: null,
  ungroupedLabel: null,
  interfaceSize: 100,
  stripeRows: false,
  nullAs: "null",
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
  /** The server's size estimate in bytes; tables only. Older Cores send none. */
  bytes?: number | null;
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

/** UX step 8: how many rows of a table match a filter, the same filter a page takes. */
export interface CountRequest {
  table: ObjectPath;
  filter: string | null;
}

/** M3: where the row with `key` is under a page's sort and filter (Back after a followed key). */
export interface LocateRequest {
  table: ObjectPath;
  sort: SortSpec | null;
  filter: string | null;
  key: KeyPart[];
}

/** The row's 0-based place in the page order (its page is `index / 1000`), no such row, or the time limit ran out. */
export type RowPlace = { kind: "found"; index: number } | { kind: "missing" } | { kind: "timedOut" } | { kind: "unsupported" };

/** The Core's count: at most 1,001 rows, or the server's time limit ran out first. */
export type CountResult = { kind: "counted"; rows: number } | { kind: "timedOut" };

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
  /** Left out, the stored mode is kept (a new Connection gets Automatic). */
  aiSync?: AiSyncMode;
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
  | { kind: "afterCommit"; message: { sql: string; message: string } }
  /** Diagram `name` is saved already and the save did not say to replace it. */
  | { kind: "diagramExists"; message: { name: string } }
  /** Restore will not run this file; `reason` is the sentence to show (step 9). */
  | { kind: "backupRefused"; message: { reason: string } }
  /** The Sync Script rebuilt at Apply differs from the one shown: `connection` (the target) changed since the compare. */
  | { kind: "planChanged"; message: { connection: string } }
  /** Apply of a Sync Script was cancelled; `applied` of its `total` statements stayed applied (MySQL; PostgreSQL's committed enum values). */
  | { kind: "syncCancelled"; message: { applied: number; total: number } }
  /** One-click updates: the sentence to show. */
  | { kind: "update"; message: string };

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

/** The statements a script handed to the user starts and ends with (`ddl::script_frame`); empty except on MySQL. */
export interface ScriptFrame {
  header: string[];
  footer: string[];
}

export interface DesignVerdict {
  plan: DesignPlan;
  verdict: RunVerdict;
  /** What Copy SQL puts around the statements. */
  frame?: ScriptFrame;
}

/** What Apply did. A failure comes back as an error (`designFailed`, `designForeignKeys`), never as an outcome. */
export type DesignOutcome = { kind: "done"; ran: number };

/** A value typed into a cell; numbers and dates are sent as text too. */
/** `default` is the column's default: `SET col = DEFAULT` on a saved row (Postgres and MySQL), left out of an INSERT. */
export type NewValue = { t: "text"; value: string } | { t: "null" } | { t: "default" };

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

// Diagrams: mirrors crates/contura-core/src/diagrams.rs.

export type DiagramKind = "dfd" | "flow" | "cloud" | "er" | "sequence" | "state" | "class" | "mindmap" | "timeline" | "unknown";

/** One diagram in Contura's diagrams folder, from its file's first line. */
export interface DiagramEntry {
  /** The name as typed: the file name without `.flow`. */
  name: string;
  kind: DiagramKind;
  /** The quoted title on the first line, or the name when there is none. */
  title: string;
  /** When the `.flow` file last changed, in milliseconds since 1970. */
  modifiedMs: number;
}

/** A diagram's `.flow` text and, when it exists, its layout file. */
export interface DiagramFiles {
  text: string;
  layout: string | null;
}

// Icons: mirrors crates/contura-core/src/icons.rs.

/** One name in the packed icon sets; aliases such as `aws-s3` are entries of their own. */
export interface IconEntry {
  name: string;
  /** The set's id: aws, azure, gcp, k8s, lucide or simple. */
  set: string;
  title: string;
  /** A brand logo's own licence and where it is from, when it has one. */
  licence: string | null;
}

/** A packed icon set as Icon credits lists it. */
export interface IconSet {
  id: string;
  title: string;
  licence: string;
  source: string;
  note: string;
  /** The licence text that travels with the copies, where the set has one. */
  notice: string;
}

// Lineage: mirrors crates/contura-core/src/lineage.rs.

export type LineageDirection = "both" | "uses" | "usedBy";

/** Steps each way: 1, 2 or 3 from the strip, 0 for All. The Core takes 0..=255. */
export type LineageDepth = number;

/** A depth the Core accepts: a whole number from 0 to 255. */
export function clampDepth(depth: LineageDepth): number {
  return Number.isFinite(depth) ? Math.min(255, Math.max(0, Math.trunc(depth))) : 0;
}

export interface LineageColumn {
  name: string;
  /** The type as the server writes it. */
  ty: string;
  pk: boolean;
  fk: boolean;
  nullable: boolean;
}

export interface LineageTable {
  path: ObjectPath;
  /** The key columns, Foreign Key columns and columns a link points to, in table order. */
  columns: LineageColumn[];
  /** Every column of the table. */
  columnCount: number;
  /** Steps from the center: negative for tables it uses, positive for tables using it. */
  distance: number;
  /** Why the table's details could not be read; the card then holds only the columns its known keys name. */
  unreadable: string | null;
}

/** One Foreign Key: `from` holds the key, `to` is the table it points to. */
export interface LineageLink {
  from: ObjectPath;
  fromColumns: string[];
  to: ObjectPath;
  toColumns: string[];
  /** Upper case, such as `CASCADE`; null for the Dialect's default. */
  onDelete: string | null;
  onUpdate: string | null;
  /** A key column can be empty. */
  nullable: boolean;
}

export interface Lineage {
  center: ObjectPath;
  /** The center first, then the rest in the order they were reached. */
  tables: LineageTable[];
  /** Every Foreign Key between two of `tables`, once each. */
  links: LineageLink[];
  /** More than 300 tables were in reach, or reading stopped after 10s. */
  truncated: boolean;
}

export type FlowTableAccess = "reads" | "writes" | "both";

/** A diagram node with a `table:`, and how the diagram's flow lines meet it. */
export interface FlowTableLink {
  /** The diagram name: the file name without `.flow`. */
  file: string;
  node: string;
  /** The node's kind as written; `step` for an unkinded flowchart node, `node` elsewhere. */
  kind: string;
  /** The `table:` value as written, such as `shop.orders`. */
  table: string;
  access: FlowTableAccess;
  /** The process or step nodes on the other end of its lines, each once, at most 20. */
  processes: FlowProcess[];
}

/** A process or step that meets a `table:` node: a line into the node writes, one out of it reads. */
export interface FlowProcess {
  node: string;
  access: FlowTableAccess;
}

/** The views that read a table, as the catalog records them. */
export interface ViewDependencies {
  /** The server keeps such a record (PostgreSQL, MySQL 8.0.13+); when false, match names instead. */
  catalog: boolean;
  /** At most 200. */
  views: ObjectPath[];
  /** More than 200 views read the table. */
  capped: boolean;
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
  /** In the AI SQL register: a Production confirmation tags it "Written by the assistant" (R6.5). */
  byAssistant?: boolean;
  /** Why a read from an answer counts as a write here (R6.4), to follow "Written by the assistant and": "calls pg_sleep()". */
  reason?: string;
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

/**
 * Where secrets go for this run (Core `SecretStoreKind`): the OS keyring, or memory until Contura
 * closes because no keyring service was found (`missing`) or it did not answer in time (`noAnswer`).
 */
export type SecretStoreKind = "keyring" | "missing" | "noAnswer";

export interface DataFolderInfo {
  path: string | null;
  connections: number;
  groups: number;
  savedQueries: number;
  historyBytes: number;
}
export type AiAccess = "never" | "schema" | "schemaQuery" | "schemaQueryRows";

/** Automatic checks the schema on an Ask (at most once a minute); Manual waits for Re-sync. */
export type AiSyncMode = "automatic" | "manual";

// The AI Context. Mirrors crates/contura-core/src/ai/context (store.rs, sync.rs).

/** One AI Context: a Connection's database and schema; schema is "" when the Dialect has none. */
export interface ContextKey {
  connectionId: ConnectionId;
  database: string;
  schema: string;
}

/** One stored AI Context, for the AI access table and the Connection form. Times are ms since the epoch. */
export interface ContextStatusRow extends ContextKey {
  builtAt: number;
  checkedAt: number;
  stale: boolean;
  tableCount: number;
  bytes: number;
}

export type RebuildReason = "first" | "changed" | "stale" | "asked";

/** What the schema check found: "failed" keeps the last Context, "missing" means none is stored. */
export type SchemaCheck =
  | { kind: "match" }
  | { kind: "recent" }
  | { kind: "rebuilt"; reason: RebuildReason }
  | { kind: "stale" }
  | { kind: "unchecked" }
  | { kind: "failed" }
  | { kind: "missing" };

/** The AI Context after a check or Re-sync; `builtAt` is null when there is none. */
export interface ContextInfo extends ContextKey {
  sync: AiSyncMode;
  builtAt: number | null;
  tableCount: number;
  stale: boolean;
  check: SchemaCheck;
}

export type AiProviderKind = "openai" | "anthropic" | "groq" | "deepseek" | "custom";

export interface AiSettings {
  provider: AiProviderKind | null;
  preset: string | null;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  /** The model's context window in tokens; unset means 8,000 (Anthropic is always 200,000). */
  contextWindow?: number | null;
  inlineAsk: boolean;
  errorAsk: boolean;
  newConnectionAccess: AiAccess;
  /** The host the saved key was entered for; set by the Core, never by the UI. */
  keyHost?: string | null;
  /** The thinking level a model with no tier starts at. */
  defaultThinking: ThinkingLevel;
  /** Whether a model with cache marks starts with them on. */
  promptCaching: boolean;
  shareThinking: boolean;
  /** "Keep the exact text sent with each answer" (R7.2). */
  keepExactText: boolean;
  /** "Let the assistant pick tables in large databases": sends an outline of table names (step 11d). */
  pickTables: boolean;
  /** "Compact long chats automatically": privacy switch, always the global value. */
  autoCompact?: boolean;
  /** "Let the assistant propose diagram changes" (step 11h): privacy switch, always the global value; absent reads as on. */
  diagramTool?: boolean;
  /** The picks remembered per model id, already clamped by the Core. */
  modelPrefs: Record<string, ModelPicks>;
}

// Model capability records. Mirrors crates/contura-core/src/ai/models.rs.

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** How the model thinks before it answers, if it does. */
export type ThinkingKind = "none" | "anthropicEffort" | "anthropicBudget" | "reasoningEffort";

/** How thinking Off is sent; `notAllowed` means the model always thinks. */
export type ThinkingOff = "omit" | "notAllowed" | "disabled" | "betweenTools" | "effortNone";

/** `breakpoints`: cache marks the user can switch off; `automatic`: the provider caches on its own. */
export type CachingKind = "none" | "breakpoints" | "automatic";

export type ModelTier = "largest" | "mid" | "fastest";

/** The thinking level and caching switch picked for one model. */
export interface ModelPicks {
  thinking: ThinkingLevel;
  caching: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number | null;
  thinking: ThinkingKind;
  thinkingOff: ThinkingOff;
  sharesThinking: boolean;
  caching: CachingKind;
  /** Whether the model takes a temperature. */
  temperature: boolean;
  maxTokensField: "maxTokens" | "maxCompletionTokens";
  tier: ModelTier | null;
  /** False when neither the built-in table nor the listing says anything about it. */
  known: boolean;
  /** The picks for this model, already clamped. */
  picks: ModelPicks;
}

export interface ModelList {
  models: ModelInfo[];
  current: string;
  /** When the listing was fetched, epoch milliseconds; null before the first fetch. */
  fetchedAt: number | null;
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
  | { kind: "badKey" }
  | { kind: "rateLimited"; retryAfterSecs: number | null }
  /** `connect`: the request never reached the host (a refused or reset connection before it was written). */
  | { kind: "network"; host: string; connect?: boolean }
  | { kind: "keyHostChanged"; host: string }
  | { kind: "insecureUrl"; host: string }
  | { kind: "timeout"; phase: string }
  | { kind: "cancelled" }
  | { kind: "provider"; status: number; message: string }
  | { kind: "badResponse" }
  | { kind: "tooLarge" }
  /** Epoch milliseconds of the context still in use. */
  | { kind: "contextUnavailable"; builtAt: number }
  | { kind: "overloaded"; provider: AiProviderKind }
  | { kind: "urlHasCredentials"; host: string }
  | { kind: "offline" }
  | { kind: "outOfCredit"; provider: AiProviderKind }
  | { kind: "modelRetired"; model: string }
  /** `messages`: the open Topic's visible messages Compact now would fold (all but the last 2 turns). */
  | { kind: "contextFull"; used: number; window: number; model: string; messages?: number }
  | { kind: "tooBig"; needed: number; window: number; model: string }
  /** The TLS handshake failed: an untrusted certificate, or a proxy inspecting https. */
  | { kind: "tls"; host: string }
  /** Another Ask in this place is still being written. */
  | { kind: "busy" }
  /** A Continue with no cut answer in what the Ask would send; nothing was sent. */
  | { kind: "nothingToContinue" }
  /** The .flow file changed outside Contura while the model worked (or is gone). `line` is the first line that differs. */
  | { kind: "fileChanged"; file: string; line: number | null; nowReads: string | null }
  /** The model called a tool Contura does not offer; `name` is cut to 64 characters. */
  | { kind: "toolRejected"; name: string }
  /** The tool input was malformed, over 64 KB, or named another file or base hash. */
  | { kind: "badToolInput" }
  /** "Let the assistant propose diagram changes" is off. */
  | { kind: "toolOff" }
  /** A diagram file name holding a control character, which cannot go in a request. */
  | { kind: "badFileName" }
  | { kind: "internal" };

// One Ask and its preview. Mirrors crates/contura-core/src/ai/{request,preview,budget,log}.rs.

/** One kind of item an Ask can send. */
export type ItemKind = "question" | "names" | "cards" | "dbml" | "sql" | "error" | "savedQueries" | "values" | "rows" | "outline" | "history" | "summary" | "diagram" | "tab" | "steps";

export interface TableRef {
  schema: string | null;
  name: string;
}

/** What the place the Ask came from was showing. */
export interface Focus {
  sql: string | null;
  selection: string | null;
  error: string | null;
  filter: string | null;
  dbml: string | null;
  tables: TableRef[];
  /** A Schema Model not tied to any Connection: with no Connection, its DBML may go and nothing else (R1.4). */
  untiedModel: boolean;
  /** The other Connections the tab spans (a Compare source, a Transfer side); every item goes at the lowest access. */
  also?: ConnectionId[];
}

/** Mirrors `SettingsSection` in `src/shell/tabs.ts`. */
export type AskSettingsPage = "general" | "appearance" | "editor" | "keymap" | "ai" | "dataFolder" | "updates" | "about";

/** A Visual Query's last run: a row count, `more` when the page was full. */
export interface AskRunCount {
  rows: number;
  more: boolean;
  failed: boolean;
}

/** One Compare item, typed: no free detail text goes. */
export interface AskDiffLine {
  kind: DiffKind;
  object: DiffObject;
  table: string;
  name: string;
  fromType: string | null;
  toType: string | null;
  losesData: boolean;
  losesRows: number | null;
}

export interface AskTransferColumn {
  name: string;
  targetName: string;
  sourceType: string;
  targetType: string;
}

/** A Data Transfer mapping note without its text: the text can name values. */
export interface AskTransferNote {
  table: string;
  column: string | null;
  kind: "info" | "new" | "needsChoice" | "noMatch" | "lossy";
}

/** One ticked Data Transfer table. */
export interface AskTransferLine {
  source: string;
  target: string;
  exists: boolean;
  ifExists: TransferIfExists;
  columns: AskTransferColumn[];
  emptiedRows: number | null;
}

/**
 * What the active tab shows, as typed fields; the Core renders the This tab item from them
 * at the Ask's AI access. Mirrors `AskTab` in `crates/contura-core/src/ai/scene.rs`.
 */
export type AskTab =
  | { kind: "query"; title: string }
  | {
      kind: "object";
      title: string;
      path: ObjectPath;
      object: ObjectKind;
      sort: SortSpec | null;
      /** The row filters' column names; never their values. */
      filterColumns: string[];
      hidden: string[];
      pendingEdits: number;
    }
  | { kind: "visual"; title: string; model: VisualQuery; sqlWritten: boolean; problems: number; lastRun: AskRunCount | null }
  | {
      kind: "design";
      create: boolean;
      path: ObjectPath;
      columns: ColumnDraft[];
      primary: string[];
      indexes: IndexDraft[];
      foreignKeys: ForeignKeyDraft[];
      removed: string[];
      comment: string | null;
      types: string[];
    }
  | { kind: "schema"; file: string; tables: number; errorLine: number | null }
  | {
      kind: "compare";
      source: { kind: "database"; database: string } | { kind: "model"; file: string };
      targetDatabase: string;
      items: AskDiffLine[];
      added: number;
      removed: number;
      changed: number;
      notCompared: number;
      ticked: number;
      /** False until a result is in: the Core then renders no counts, items or ticks. Absent means true. */
      compared?: boolean;
    }
  | {
      kind: "transfer";
      sourceDatabase: string;
      /** Empty until a target is chosen. */
      targetDatabase: string;
      /** Null until a plan exists: no mode is claimed before. */
      mode?: TransferMode | null;
      tables: AskTransferLine[];
      notes: AskTransferNote[];
    }
  | {
      kind: "import";
      file: string;
      format: string;
      delimiter: string | null;
      encoding: string;
      target: { kind: "table"; path: ObjectPath } | { kind: "database"; database: string; schema: string | null };
      header: string[];
      /** File column to target column; null skips it. Never the file's rows. */
      mapping: [string, string | null][];
      rowsEstimate: number | null;
    }
  | { kind: "lineage"; path: ObjectPath; neighbours: string[] }
  | { kind: "savedQueries" }
  | { kind: "home" }
  | { kind: "settings"; section: AskSettingsPage };

export interface Switches {
  rows: boolean;
  values: boolean;
}

export interface AskRequest {
  requestId: string;
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  groupId: GroupId | null;
  connectionId: ConnectionId | null;
  database: string | null;
  schema: string | null;
  action: string;
  question: string;
  threadId: string | null;
  focus: Focus;
  switches: Switches;
  /** Kinds switched off in the Sends list; it can only remove items. */
  off: ItemKind[];
  /** The model picked for this Ask; absent or null asks the settings' model. */
  model?: string | null;
  /** The picker's thinking and caching picks; the Core clamps them to the model. */
  picks?: ModelPicks | null;
  /** What the active tab shows; absent or null sends no This tab item. */
  tab?: AskTab | null;
  /** What the user did since their last question in this place; the Core renders the Recent steps item. */
  steps?: StepIn[];
}

/**
 * What the user did, for a Recent step. Mirrors `StepVerb` in `crates/contura-core/src/ai/steps.rs`.
 */
export type StepVerb =
  | "openTab"
  | "showTab"
  | "runQuery"
  | "runVisual"
  | "vqTable"
  | "vqTableOff"
  | "vqTick"
  | "vqUntick"
  | "vqJoin"
  | "vqFilter"
  | "vqSort"
  | "gridSort"
  | "gridFilter"
  | "editsSaved"
  | "designApplied"
  | "compared"
  | "syncApplied"
  | "transferRan"
  | "importFile"
  | "importRan";

/**
 * One Recent step as typed fields, never free text; the Core renders and gates its label.
 * Mirrors `StepIn` in `crates/contura-core/src/ai/steps.rs`, whose doc says what `names`
 * and `count` hold per verb.
 */
export interface StepIn {
  at: number;
  verb: StepVerb;
  /** A tab kind id (`newTable` for a New table); unknown ids render as "a tab". */
  tab: string;
  title: string | null;
  connectionId: ConnectionId | null;
  database: string | null;
  schema: string | null;
  /** At most 6 object names are shown; the rest count into `more`. */
  names?: string[];
  more?: number;
  count: number | null;
  hasMore?: boolean;
  failed?: boolean;
  descending?: boolean;
  /** Compare and Transfer: the source's Connection when it is not the step's; the source name goes at the lower access. */
  sourceConnectionId?: ConnectionId | null;
}

/** One row of the Sends list, measured after cleaning. */
export interface PreviewItem {
  kind: ItemKind;
  label: string;
  bytes: number;
  tokens: number;
  /** Why the item cannot be switched on, when it cannot. */
  locked: string | null;
  on: boolean;
}

/** How the table cards fit the budget: demoted to names only before they are left out. Mirrors `TableFit`. */
export interface TableFit {
  full: string[];
  namesOnly: string[];
  leftOut: string[];
  /** (table, rule, evidence) for every table offered, in the order offered. */
  reasons: [string, string, string][];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  /** Milliseconds since the log started. */
  atMs: number;
  level: LogLevel;
  source: string;
  /** Key and value pairs in push order. */
  fields: [string, string][];
}

/** What one Ask would send, built by the Core. */
export interface Preview {
  items: PreviewItem[];
  tables: TableFit;
  totalBytes: number;
  /** An estimate from bytes, measured after framing. */
  tokens: number;
  /** What "Show exactly" displays, byte for byte. */
  exact: string;
  notes: string[];
  log: LogLine[];
  /** The AI Context the preview read; null with no Connection, at AI access Never, or with the schema off or locked. */
  context: ContextInfo | null;
  /** The sample rows the Ask would carry; null when none are on or none were read. */
  rows: RowsSent | null;
  /** The outline step an Ask would send first, when the Core would run one; absent or null otherwise. */
  outline?: OutlinePreview | null;
  /** What the thread's memory adds to this Ask; absent or null without a thread. */
  memory?: MemoryInfo | null;
  /** The summary or compaction call an Ask would make first; absent or null when none would be made. */
  summary?: SummaryPreview | null;
}

/** Which call a summary step is. Mirrors `CallKind` (camelCase). */
export type CallKind = "summary" | "compact";

/** The summary step of a preview: the call the Ask would make and its exact text. Mirrors `SummaryPreview`. */
export interface SummaryPreview {
  kind: CallKind;
  /** The Topic a `summary` call is about. */
  topic: number | null;
  title: string | null;
  /** The messages the call sends. */
  messages: number;
  bytes: number;
  tokens: number;
  exact: string;
  on: boolean;
}

/** The summary or compaction call of an Ask, measured from its request. Mirrors `SummarySent` in sent.rs. */
export interface SummarySent {
  kind: CallKind;
  topic: number | null;
  messages: number;
  model: string;
  bytes: number;
  tokens: number;
  hash: string;
  millis: number;
  usage: Usage | null;
  /** The call's exact text, only with "Keep the exact text sent" on. */
  exact: string | null;
}

/** Compact now: the open thread's older turns become one summary. Mirrors `CompactRequest` (camelCase). */
export interface CompactRequest {
  requestId: string;
  place: string;
  groupId: GroupId | null;
  threadId: string;
  model: string | null;
}

/** Why an Ask opened a new Topic. Mirrors `BreakReason` (camelCase). */
export type BreakReason = "first" | "place" | "idle" | "subject";

/** What the thread's memory adds to an Ask. Mirrors `MemoryInfo` in crates/contura-core/src/ai/memory. */
export interface MemoryInfo {
  topic: number;
  opened: boolean;
  reason: BreakReason | null;
  title: string;
  turns: number;
  summaries: number;
  /** Earlier messages held back because AI access is lower now. */
  blocked: number;
  /** Tokens the thread part of the request uses. */
  tokens: number;
}

/** The memory stamp of one Ask: written on both its messages. Mirrors `TurnStamp`. */
export interface TurnStamp {
  topic: number;
  opened: boolean;
  reason: BreakReason | null;
  title: string;
  connectionId: ConnectionId | null;
  database: string | null;
  action: string;
  tables: string[];
  kinds: ItemKind[];
  /** Where the question was asked; null with no tab, steps or other Connection. Stored on the question only. */
  askedIn?: AskedIn | null;
}

/**
 * Where a question was asked (spec 6). Mirrors `AskedIn` in crates/contura-core/src/ai/memory. The summary and steps
 * arrive once, on the Memory event, and go to the Core with the turn; threads from the Core carry the tab and label only.
 */
export interface AskedIn {
  /** The tab kind id: "query", "visual", "design" ... */
  tab: string;
  /** The where line as it went, or the tab's kind words. */
  label: string;
  summary: string;
  steps: string[];
  also?: ConnectionId[];
  /**
   * Mirrors `AskedIn.other_steps`: the Recent steps on other Connections kept with the question. The Core keeps them
   * and never sends them to the webview (the stamp and every thread view leave them out), so they are never here.
   */
  otherSteps?: never;
}

/** The outline step of a preview: how big the outline is and the exact text it would send. */
export interface OutlinePreview {
  tables: number;
  areas: number;
  level: number;
  exact: string;
}

/** Why an answer ended. Mirrors `StopReason` in crates/contura-core/src/ai/provider. */
export type StopReason = "end" | "length" | "refusal" | "tooLong" | "dropped";

/** Token counts the provider reported for one answer. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the Core read for the sample rows of one Ask. Mirrors `RowsSent`; never holds a value. */
export interface RowsSent {
  tables: number;
  rows: number;
  bytes: number;
}

/** What one Ask sent, measured from the request itself (R7.1). Mirrors `SentRecord` in crates/contura-core/src/ai/sent.rs. */
export interface SentRecord {
  /** Epoch milliseconds. */
  at: number;
  /** The kinds of the Sends items that went. */
  kinds: ItemKind[];
  bytes: number;
  /** About: an estimate from bytes. */
  tokens: number;
  provider: AiProviderKind;
  model: string;
  modelName: string;
  /** The host (with `:port` when not the default); never the URL. */
  host: string;
  /** FNV-1a 64 of the texts sent, 16 lower-case hex digits. */
  hash: string;
  outlineCall: boolean;
  summaryCall: boolean;
  /**
   * The outline call, once its request left this PC; absent in records saved before it existed. With `bytes` 0 only
   * the outline call went: the Ask ended before its main request was sent.
   */
  outline?: OutlineSent | null;
  /** The summary or compaction call, once its request left this PC; absent when none was made. */
  summary?: SummarySent | null;
  /** The sample rows that went: how many tables and rows, and their bytes; absent or null when none went. */
  rows?: RowsSent | null;
  /** The exact text, only with "Keep the exact text sent" on (R7.2). */
  exact: string | null;
}

/** The outline call of an Ask, measured from its request. Mirrors `OutlineSent` in sent.rs. */
export interface OutlineSent {
  bytes: number;
  tokens: number;
  hash: string;
  pickedAreas: number;
  pickedTables: number;
  dropped: number;
  usage: Usage | null;
  /** The outline call's exact text, only with "Keep the exact text sent" on. */
  exact: string | null;
  /** The request left this PC. The Core keeps an outline record only once it did, and reads an older record as true. */
  left: boolean;
}

/** One Steps row of the answer log. Mirrors `StepKind` (camelCase). */
export type StepKind = "access" | "schema" | "tables" | "cleaning" | "request" | "thinking" | "answer" | "sqlCheck" | "outline" | "compact" | "rows" | "diagram" | "toolCheck";

/** A Steps row in fixed wording, filled by the Core from what ran. Mirrors `ProcessStep`. */
export interface ProcessStep {
  step: StepKind;
  /** Milliseconds since the Ask's log started. */
  atMs: number;
  value: string;
  rule: string;
  /** The evidence table, three cells per row. */
  evidence: [string, string, string][];
  /** Text from the provider (Thinking, Answer), not from Contura. */
  byModel: boolean;
  /** Only on the Tables row: how many tables were left out. */
  leftOut?: number;
}

/** How an answer ended when it did not end normally. Mirrors `AnswerMark`. */
export type AnswerMark = "stopped" | "length" | "refusal" | "dropped" | "tooLong" | "failed";

/** What the user did with an answer's SQL. Mirrors `AnswerActionKind`. */
export type AnswerActionKind = "inserted" | "insertedCommented" | "openedInNewTab";

/** Mirrors `AnswerAction`; `at` is epoch milliseconds. */
export interface AnswerAction {
  kind: AnswerActionKind;
  at: number;
}

/** Everything kept with an assistant message besides its text. Mirrors `AnswerRecord`; every field may be absent on read. */
export interface AnswerRecord {
  sent: SentRecord | null;
  usage: Usage | null;
  millis: number | null;
  stop: StopReason | null;
  mark: AnswerMark | null;
  error: AiError | null;
  sqlBlocks: SqlBlock[];
  notes: string[];
  /** As the provider returned it, at most 64 KB. */
  thinking: string | null;
  log: LogLine[];
  steps: ProcessStep[];
  /** What the user did with the answer's SQL, oldest first: the Diagram's "You:" boxes. */
  actions: AnswerAction[];
  /** The AI Context the Ask used, written by the Core; null when no schema was asked for and in older records. */
  context: ContextInfo | null;
  /** The text of a failure that is not an AiError (a command that could not start), at most 2 KB. */
  commandError: string | null;
  /** The diagram Ask's proposal and what the user did with it; absent on other answers and in older records. */
  toolUse?: ToolUse | null;
  /** True on a copy from a thread list or view whose log, steps, thinking and exact text were left out; `aiAnswerRecord` fetches the full one. */
  trimmed?: boolean;
  /** The `max_tokens` the request carried on the wire (the `done` event's); absent in older records. */
  maxTokens?: number | null;
}

/** One event of a streamed Ask, in order. Mirrors `AiEvent` (serde tag "type"). */
export type AiEvent =
  | ({ type: "log" } & LogLine)
  /** The Sent record, once the request is built and before the first attempt. */
  | ({ type: "sent" } & SentRecord)
  /** One Steps row, as it completes. */
  | ({ type: "process" } & ProcessStep)
  /** The AI Context the Ask uses, once, right after the Schema row. */
  | { type: "context"; info: ContextInfo }
  /** The Topic this Ask belongs to, right before the Sent record. */
  | { type: "memory"; stamp: TurnStamp }
  /** The thread was compacted before this Ask went out; the meter drops to `after`. */
  | { type: "compacted"; compaction: Compaction }
  | { type: "status"; step: string }
  | { type: "thinking"; text: string }
  /** The whole thinking, redacted again over the joined chunks; replaces what the chunks built up. */
  | { type: "thinkingKept"; text: string }
  | { type: "delta"; text: string }
  | {
      type: "done";
      usage: Usage | null;
      stop: StopReason;
      sentBytes: number;
      model: string;
      provider: AiProviderKind;
      millis: number;
      /** Shown above the answer: the injection note (R5.4), the query-share note, the unreadable schema note. */
      notes: string[];
      sqlBlocks: SqlBlock[];
      /** The `max_tokens` the request carried on the wire: Max tokens or the Core's default, raised by an Anthropic thinking budget. */
      maxTokens: number;
    }
  /**
   * The checked proposal of a diagram Ask, after the answer text and before `done`. `input` is the model's tool JSON
   * (invisible characters stripped, at most 64 KB): the saved record's `toolUse.input`.
   */
  | { type: "proposal"; proposal: DiagramProposal; input: string }
  | { type: "error"; error: AiError; partial: boolean };

/** What the output rail found in one statement of an answer (R5.3). Mirrors `Flag` (serde tag "kind"). */
export type Flag =
  | { kind: "noWhere"; verb: string }
  | { kind: "riskyFunction"; name: string }
  | { kind: "unknownFunction"; name: string }
  | { kind: "writeInReadAnswer" }
  | { kind: "readOnlyConnection" };

/** One statement of an answer's SQL block, classified as Run classifies it. */
export interface StatementCheck {
  text: string;
  class: StatementClass;
  flags: Flag[];
}

/** A fenced SQL block of an answer: its index among all fences, its label and its statements (R5.2). */
export interface SqlBlock {
  fence: number;
  label: string;
  statements: StatementCheck[];
  /**
   * SHA-256 (hex) of the fence body the Core checked. The check is used only for a block whose own text has this
   * hash; absent on records saved before it, which then read as unchecked.
   */
  bodySha256?: string;
}

export type AiDone = Extract<AiEvent, { type: "done" }>;

export type AiRole = "user" | "assistant" | "notice";

export interface AiMessage {
  role: AiRole;
  text: string;
  context: string[];
  at: number;
  /** What an assistant answer sent and did, kept with the thread; absent on questions and older answers. */
  record?: AnswerRecord;
  /** The memory stamp the Core writes: the Topic of the turn, its Connection and database, the kinds it carried. Absent before 11e. */
  topic?: number;
  connectionId?: ConnectionId;
  database?: string;
  kinds?: ItemKind[];
  tables?: string[];
  action?: string;
  /** On a question only: where it was asked. The Core's copies hold the tab and label only. */
  askedIn?: AskedIn;
}

export interface AiThread {
  id: string;
  /** The drafts place key: "ungrouped" or "group:<id>". */
  place: string;
  title: string;
  messages: AiMessage[];
  updatedAt: number;
}

/** Who wrote a summary. Mirrors `SummaryBy` (serde tag "kind"). */
export type SummaryBy = { kind: "none" } | { kind: "rules" } | { kind: "model"; model: string };

/** One run of a thread's turns on one subject, in one Connection and database. */
export interface Topic {
  threadId: string;
  seq: number;
  title: string;
  summary: string;
  summaryBy: SummaryBy;
  tables: string[];
  connectionId: ConnectionId | null;
  database: string | null;
  kinds: ItemKind[];
  firstAt: number;
  lastAt: number;
  messages: number;
  closed: boolean;
}

/** A span of messages folded into a summary. */
export interface Compaction {
  id: string;
  threadId: string;
  topic: number;
  firstAt: number;
  lastAt: number;
  messages: number;
  summary: string;
  summaryBy: SummaryBy;
  connectionId: ConnectionId | null;
  database: string | null;
  kinds: ItemKind[];
  before: number;
  after: number;
  at: number;
  undone: boolean;
  record: AnswerRecord;
}

/** A thread in a place's list: no messages. */
export interface ThreadSummary {
  id: string;
  place: string;
  title: string;
  updatedAt: number;
  messages: number;
  topics: number;
}

/** An opened thread with its Topics and compactions; its records are trimmed. */
export interface ThreadView {
  thread: AiThread;
  topics: Topic[];
  compactions: Compaction[];
}

/** One Ask's turn for `ai_append_turn`: its messages go after the stored thread's, so the thread never crosses IPC. */
export interface AppendTurn {
  threadId: string;
  /** For a thread the store does not have yet. */
  place: string;
  /** For a thread the store does not have yet; a stored thread keeps its title. */
  title: string;
  updatedAt: number;
  /** The question and its answer. */
  messages: AiMessage[];
  /** A Retry: the stored messages from the one at this time on are replaced. */
  replaceFrom?: number;
}

/** What `ai_append_turn` returns: the new messages as stored (records trimmed) and where the thread now starts. */
export interface TurnView {
  threadId: string;
  place: string;
  title: string;
  updatedAt: number;
  messages: AiMessage[];
  /** The time of the oldest message kept (older ones went over the cap); null for an empty thread. */
  keptFrom: number | null;
  messageCount: number;
  topics: Topic[];
  compactions: Compaction[];
}

/** A Topic that matched a search of a place's chats. */
export interface ThreadHit {
  threadId: string;
  title: string;
  topic: number;
  topicTitle: string;
  snippet: string;
  at: number;
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
/** Step 9 adds a Backup, a Restore's check pass (`restoreCheck`) and the Restore run. */
export type JobKind = "export" | "import" | "scriptImport" | "check" | "transfer" | "backup" | "restoreCheck" | "restore" | "sync";
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
  jsonLayout: "array",
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
  /** A Restore's check pass (`inspect_restore`): what it found. Absent on other jobs. */
  restoreCheck?: RestoreCheck | null;
  /** A finished Restore run. Absent on other jobs. */
  restore?: RestoreOutcome | null;
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
      /** A Data Transfer's current table: its rows so far and its total; rowsDone and rowsTotal count the whole run. */
      tableRows?: number;
      tableTotal?: number | null;
      /** A Backup: tables written so far and in all. */
      tablesDone?: number;
      tablesTotal?: number | null;
      /** A Restore's phase in the running state's list. */
      restoreStep?: RestoreStep | null;
      /** A Restore: INSERT statements run so far, for "Rows (310 of 1,472 INSERT statements)". */
      insertsDone?: number;
      /** A Restore's current statement, such as "INSERT INTO billing.order_items, rows 154,001 to 154,500". */
      now?: string | null;
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

// Data Transfer (step 8). The plan is built again from the request on every call, so
// Review SQL, the Production pass and the run cover the same statements.

export interface TransferSide {
  connectionId: ConnectionId;
  database: string;
  schema: string | null;
}

export type TransferIfExists = "stop" | "append" | "emptyFirst";
export type TransferCopyKind = "both" | "structureOnly" | "rowsOnly";

export interface TransferTableChoice {
  name: string;
  ticked: boolean;
  ifExists: TransferIfExists;
}

/** A typed type (`column` set), a choice, or a new name, for one table or column. */
export interface TransferSetting {
  table: string;
  column: string | null;
  value: string;
}

export interface TransferRequest {
  source: TransferSide;
  target: TransferSide;
  tables: TransferTableChoice[];
  /** The user's load order; empty means parents first. */
  order: string[];
  copy: TransferCopyKind;
  batchRows: number;
  overrides: TransferSetting[];
  choices: TransferSetting[];
  names: TransferSetting[];
  compareCounts: boolean;
  createTargetScope: boolean;
}

export type TransferNoteKind =
  | { kind: "info" }
  | { kind: "new" }
  | { kind: "needsChoice"; options: string[] }
  | { kind: "noMatch" }
  | { kind: "lossy" };

export interface TransferNote {
  table: string;
  column: string | null;
  kind: TransferNoteKind;
  text: string;
}

export interface TransferColumn {
  name: string;
  targetName: string;
  sourceType: string;
  targetType: string;
}

export interface TransferTable {
  name: string;
  target: string;
  exists: boolean;
  columns: TransferColumn[];
}

export interface TransferCopyColumn {
  source: string;
  target: string;
  targetType: string;
}

export interface TransferCopy {
  table: string;
  source: string;
  target: string;
  columns: TransferCopyColumn[];
  select: string;
  sourceSql: string;
  insertHead: string;
  targetSql: string;
  overriding: boolean;
  delete: string | null;
  keyColumns: string[];
  rowsHint: number | null;
}

export interface TransferOrphanCheck {
  sourceTable: string;
  table: string;
  columns: string[];
  parent: string;
  countSql: string;
  sampleSql: string;
}

export type TransferMode = "oneTransaction" | "perTable";

export interface TransferPlan {
  sourceDialect: DialectKind;
  targetDialect: DialectKind;
  tables: TransferTable[];
  mappingNotes: TransferNote[];
  notes: { table: string; text: string }[];
  structure: string[];
  afterRows: string[];
  copies: TransferCopy[];
  notCopied: string[];
  emptied: { table: string; rows: number | null }[];
  mode: TransferMode;
  modeLine: string;
  /** Columns that still need a choice; Start stays off while any is left. */
  blocked: string[];
  fkGroups: string[][];
  orphanChecks: TransferOrphanCheck[];
  /** Sent back with Start, so a target that changed since Review is refused. */
  fingerprint: string;
  /** What Copy and Open in editor put around the structure SQL. */
  frame?: ScriptFrame;
}

// Backup and Restore (step 9). Same Dialect only; the file is Contura's own plain SQL script.

/** The five ticks of "What goes in". Tables off turns off everything that needs them. */
export interface BackupInclude {
  /** Tables, columns and keys (with checks and generated columns). */
  tables: boolean;
  /** Indexes and Foreign Keys. */
  indexes: boolean;
  /** Enums and sequences. */
  enums: boolean;
  /** Views, functions, procedures and triggers, from the server's own definitions. */
  definitions: boolean;
  rows: boolean;
}

export const DEFAULT_BACKUP_INCLUDE: BackupInclude = { tables: true, indexes: true, enums: true, definitions: true, rows: true };

/** `fileCopy` is SQLite's exact file copy (VACUUM INTO). */
export type BackupFormat = "script" | "fileCopy";

export interface BackupRequest {
  connectionId: ConnectionId;
  /** MySQL database, SQLite "main", PostgreSQL database. */
  database: string;
  /** PostgreSQL: the schema backed up; null elsewhere. */
  schema: string | null;
  include: BackupInclude;
  format: BackupFormat;
  /** 100, 500 or 1,000. */
  rowsPerStatement: number;
  /** Writes DROP TABLE IF EXISTS before each CREATE TABLE; the header says so. */
  addDropTables: boolean;
  /** The final file; the job writes `<path>.partial` and renames it. */
  path: string;
  /** The user's local date, `yyyy-mm-dd`, for the default file name (R25); UTC when absent. */
  localDate?: string | null;
}

export interface BackupCounts {
  tables: number;
  indexes: number;
  foreignKeys: number;
  enums: number;
  sequences: number;
  views: number;
  /** Functions and procedures. */
  functions: number;
  triggers: number;
  /** From the server's statistics where exact counts are dear. */
  rows: number;
}

export interface BackupPlan {
  dialect: DialectKind;
  counts: BackupCounts;
  /** Phrases for the Not included banner, in order: "the pgcrypto extension", "large objects", "grants and roles". */
  notIncluded: string[];
  /** From the server's size figures. */
  estimateBytes: number;
  /** MySQL tables outside the snapshot (MyISAM and other non-transactional engines). */
  nonSnapshotTables: string[];
  /** `<database>-<yyyy-mm-dd>.sql` (SQLite file copy: `.sqlite`). */
  defaultFileName: string;
}

/** Where a Restore goes. `database: null` on a Connection row: only Into a new database. */
export interface RestoreTarget {
  connectionId: ConnectionId;
  database: string | null;
  schema: string | null;
}

/** The file's header as read (spec "The script format"). */
export interface RestoreHeader {
  format: number;
  madeBy: string;
  dialect: DialectKind;
  serverVersion: string;
  database: string;
  schema: string | null;
  /** UTC, `2026-10-16T22:00:00Z`. */
  takenAt: string;
  /** The header's words: "tables", "indexes", "foreign-keys", ... */
  contents: string[];
  rows: { table: string; rows: number }[];
  notIncluded: string[];
  definerRemoved: boolean;
  dropTables: boolean;
}

/** A statement Restore skips unless Run as is: `kind` is "GRANT", "REVOKE", "CREATE USER", "SET GLOBAL", ... */
export interface RestoreSkipped {
  line: number;
  kind: string;
}

/** A statement that makes the file refused: `kind` is "DROP DATABASE", "COPY FROM STDIN", a psql meta-command, ... */
export interface RestoreRefused {
  line: number;
  kind: string;
}

/** What the check pass found: the report of the `restoreCheck` job. */
export interface RestoreCheck {
  path: string;
  /** null for plain SQL without a Contura header. */
  header: RestoreHeader | null;
  bytes: number;
  /** Lowercase hex. */
  sha256: string;
  /** The target Connection's name, Dialect and server version. */
  targetName: string;
  targetDialect: DialectKind;
  targetVersion: string;
  /** False refuses the file (another Dialect). */
  dialectOk: boolean;
  /** An older target: "The backup is from PostgreSQL 17.0 and freight-prod runs 16.4. Statements may fail." */
  versionNote: string | null;
  statements: number;
  refused: RestoreRefused[];
  skipped: RestoreSkipped[];
  /** Tables in the target with the file's names. */
  existingTables: string[];
  /** The target database holds no table, view or routine (Into <database> needs it). */
  targetEmpty: boolean;
  /** PostgreSQL: extensions the header names that the target lacks. */
  missingExtensions: string[];
  trailerOk: boolean;
  /** Why Replace is disabled (PostgreSQL with no known schema): "Open Restore on a schema to replace its tables." */
  replaceNote?: string | null;
  /** Skipped statements past the 1,000 that `skipped` lists. */
  skippedMore?: number;
}

export type RestoreMode =
  /** `name` is a database name, or for SQLite a new file path (never an existing file). */
  | { kind: "newDatabase"; name: string }
  | { kind: "intoEmpty" }
  /** MySQL: `backupFirst` runs a Backup of the tables to replace before any DROP. */
  | { kind: "replace"; backupFirst: boolean };

export interface RestoreRequest {
  target: RestoreTarget;
  path: string;
  mode: RestoreMode;
  runAsIs: boolean;
  /** The user's local date, `yyyy-mm-dd`, for the Back up first file name (R25); UTC when absent. */
  localDate?: string | null;
}

/**
 * The Restore plan. Run order, which the confirmation shows as it is: `setup`, then `drops`, then
 * the file's statements in file order (`structure` and the INSERTs shown as a shape), then `after`.
 * `cleanup` runs only on failure or Cancel and is shown on its own line. Every statement carries its
 * label from the 5a classifier in `class` (`setval` is labelled "write").
 */
export interface RestorePlan {
  /** Into a new database: `CREATE DATABASE ..` on the maintenance connection, shown and run first, on its own (R15). */
  createDatabase?: PlannedStatement | null;
  /** The session setup Contura adds, before everything (MySQL's includes SET FOREIGN_KEY_CHECKS = 0). */
  setup: PlannedStatement[];
  /** Replace: every DROP, after the setup and before the file's statements. */
  drops: PlannedStatement[];
  /**
   * The first 50 file statements that are not shown as a shape, in file order. Skipped statements
   * (GRANT, ...) are left out unless Run as is, when they come with `runAsIs: true`.
   */
  structure: ScriptStatement[];
  /** The same set counted whole; `restore_statements` pages the rest. */
  structureTotal: number;
  /** What the structure creates, for the count line. */
  creates: { tables: number; indexes: number; foreignKeys: number };
  /** INSERT statements shown as a shape, and their rows. */
  insertCount: number;
  insertRows: number;
  /** The first such INSERT's head and first rows; null when the file has none. */
  insertShape: InsertShape | null;
  /** Statements Contura adds after the file (SQLite foreign_key_check, settings back). */
  after: PlannedStatement[];
  /** Run on failure or Cancel: `DROP DATABASE freight_restore_1017`. Empty in other modes. */
  cleanup: string[];
  /** Replace: the target's rows in the dropped tables, when known. */
  replacedRows: number | null;
  /** MySQL Replace with backupFirst: the file the first Backup writes. */
  backupFirstPath: string | null;
  /** The running state's note: "One transaction. Cancel rolls back and removes freight_restore_1017." */
  modeLine: string;
  /** Hex; the Job pass is bound to it. */
  fingerprint: string;
  verdict: JobVerdict;
}

export type RestoreStep = "database" | "structure" | "rows" | "afterRows" | "sequences" | "counts";

/** A finished Restore (the `restore` field of its JobReport). */
export interface RestoreOutcome {
  /** The database restored into (SQLite: the file path). */
  database: string;
  tables: number;
  rows: number;
  /** Row counts matched the file header. */
  countsMatch: boolean;
  /** SQLite Into a new database: the new file, for "Add it as a Connection". */
  newFile: string | null;
}

// Schema Compare and the Sync Script (step 10). Same Dialect only; schemas, never rows. Plan,
// confirm and apply each rebuild the diff and the script from fresh snapshots, so the pass and
// the hash cover exactly the shown statements.

/** One side read from a database: MySQL database, PostgreSQL database and schema, SQLite "main". */
export interface CompareDatabase {
  connectionId: ConnectionId;
  database: string;
  /** PostgreSQL: the schema compared; null elsewhere. */
  schema: string | null;
}

/** The source: a database, or a Schema Model as the UI parsed it (by its file path; null before a first Save). */
export type CompareSource = ({ kind: "database" } & CompareDatabase) | { kind: "model"; model: SchemaModel; path: string | null };

/** The target is always a database: the Sync Script changes it to match the source. */
export interface CompareRequest {
  source: CompareSource;
  target: CompareDatabase;
}

/** Stable text from the kind and path, such as `column:billing.invoices.fax:removed`; survives a recompare. */
export type ItemId = string;

/** Added: in the source only. Removed: in the target only. Changed: on both, and they differ. */
export type DiffKind = "added" | "removed" | "changed";

export type DiffObject = "table" | "column" | "primaryKey" | "index" | "foreignKey" | "enum";

/**
 * Where an item sits. `table` is the table the object belongs to (null for a table or an enum
 * itself); `name` is what the tree shows: the table, column, index or enum name, or a key's columns.
 * `schema` is the target's schema (PostgreSQL), else null.
 */
export interface DiffPath {
  schema: string | null;
  table: string | null;
  name: string;
}

/** What differs on a changed item; `from` is the target's value, `to` the source's. */
export type Change =
  | { kind: "type"; from: string; to: string }
  | { kind: "nullable"; from: boolean; to: boolean }
  | { kind: "default"; from: string | null; to: string | null }
  | { kind: "increment"; from: boolean; to: boolean }
  | { kind: "unique"; from: boolean; to: boolean }
  | { kind: "note"; from: string | null; to: string | null }
  | { kind: "onDelete"; from: string | null; to: string | null }
  | { kind: "onUpdate"; from: string | null; to: string | null }
  /** Index or key columns. */
  | { kind: "columns"; from: string[]; to: string[] }
  | { kind: "enumValues"; added: string[]; removed: string[]; reordered: boolean };

/** Rows on the target whose values the item drops: `count(*)` or `count(col)` within 2 s, else the server's estimate. */
export interface DataLoss {
  rows: number;
  /** False for the server's estimate, shown as "about". */
  exact: boolean;
}

export interface DiffItem {
  id: ItemId;
  kind: DiffKind;
  object: DiffObject;
  path: DiffPath;
  /** The short detail after the name: "varchar(16) to varchar(24)", "integer", "index", "default", "+ written_off". */
  detail: string;
  changes: Change[];
  /** A removed table or column, or a narrowing change: it starts unticked in the Sync Script. */
  losesData: boolean;
  /** The row count behind `losesData`; null when neither the count nor an estimate came back. */
  dataLoss: DataLoss | null;
  /** Each side's definition text of the item (its DDL line or block); null on the side that lacks it. */
  source: string | null;
  target: string | null;
  /** Items this one cannot run without (an index on an added column needs that column). */
  needs: ItemId[];
  /** Null when Contura can script it; else the reason, such as "PostgreSQL cannot remove a value from an enum. Remove written_off by hand." */
  notScriptable: string | null;
}

/** What Contura leaves out of the compare, counted by kind. */
export type NotComparedKind =
  | "view"
  | "routine"
  | "trigger"
  | "check"
  | "generatedColumn"
  | "expressionIndex"
  | "partialIndex"
  | "comment"
  /** A model table named `other.table` when the target schema is another one. */
  | "otherSchema";

export interface NotComparedCount {
  kind: NotComparedKind;
  count: number;
}

export interface NotCompared {
  source: NotComparedCount[];
  target: NotComparedCount[];
}

/** What was compared, for "6 tables, 1 enum, 14 indexes, 5 Foreign Keys". */
export interface CompareSummary {
  tables: number;
  enums: number;
  indexes: number;
  foreignKeys: number;
  /** No items, and the sides' not-compared lists agree: "match" claims no more than was compared. */
  matches: boolean;
  /** The Core's line, such as "Not compared yet: 1 view in the source; 1 view, 1 trigger in the target."; null when nothing was left out. */
  notComparedLine: string | null;
}

export interface CompareResult {
  /** Both sides' Dialect; equal, or the request was refused. */
  dialect: DialectKind;
  items: DiffItem[];
  notCompared: NotCompared;
  summary: CompareSummary;
  /** When the snapshots were read, in Unix milliseconds. */
  comparedAtMs: number;
}

/** One table's (or enum's) DDL on each side, by the same writer, so the lines align; null where it is missing. */
export interface DdlPair {
  source: string | null;
  target: string | null;
}

export type SyncGroup = "drop" | "change" | "create";

/** One change of the Sync Script list. */
export interface SyncItem {
  id: ItemId;
  group: SyncGroup;
  kind: DiffKind;
  object: DiffObject;
  /** The list's line, such as "DROP COLUMN invoices.fax". */
  line: string;
  /** The table it changes (or the enum), for the Differences pane's script block. */
  table: string | null;
  /** After the closure over `needs`: in the script. */
  ticked: boolean;
  needs: ItemId[];
  losesData: boolean;
  dataLoss: DataLoss | null;
  notScriptable: string | null;
}

export interface SyncStatement {
  sql: string;
  /** The items this statement carries (a MySQL merged ALTER carries several). */
  items: ItemId[];
  group: SyncGroup;
  /** False for the SQLite pragma lines and checks. */
  writes: boolean;
  dropsData: boolean;
  /** The qualified object it changes, such as "billing.invoices.fax", for the Production note. */
  object: string | null;
}

/** Transaction: PostgreSQL, SQLite. Sequential: MySQL commits each statement. CopyOnly: Apply refuses. */
export type SyncMode = { kind: "transaction" } | { kind: "sequential" } | { kind: "copyOnly"; reason: string };

export type SyncVerdict = "ok" | "readOnly" | "needsConfirmation";

export interface SyncPlan {
  /** Every item of the diff in group order, ticked or not. */
  items: SyncItem[];
  /** The ticked items' statements, in the order Apply runs them (MySQL: DROP TABLE and DROP COLUMN last). */
  statements: SyncStatement[];
  warnings: string[];
  mode: SyncMode;
  /** The line under the script: "Apply runs exactly this, in one transaction." and the MySQL and enum lines. */
  line: string;
  verdict: SyncVerdict;
  /** Hash of the statements' text; Apply sends it back as `expectedHash`. */
  hash: string;
  /**
   * PostgreSQL: the enum values (`ADD VALUE`) commit first, in their own transaction, before the
   * rest runs, so the script is not one transaction (`line` says so too).
   */
  enumValuesFirst: boolean;
  /** What Copy script, Save as and Open in editor put around the script. */
  frame?: ScriptFrame;
}

/** What Apply did. A failure comes back as an error (`designFailed`, `designForeignKeys`, `planChanged`). */
export interface SyncOutcome {
  applied: number;
  elapsedMs: number;
  /** The target tables a statement changed or dropped, for the open tabs' "table changed" event. */
  tables: ObjectPath[];
}

// The diagram assistant (step 11h). Mirrors crates/contura-core/src/ai/{diagram_tool,diagram,sent,tool_uses}.rs.

/**
 * One change the model proposes, as it is on the wire: snake_case, externally tagged (`{ add_node: { ... } }`).
 * Optional fields may be absent or null.
 */
export type DiagramOp =
  | { add_node: { name: string; kind?: string | null; id?: string | null; group?: string | null } }
  | { remove_node: { target: string } }
  | { rename_node: { target: string; name: string } }
  | { add_flow: { from: string; to: string; label?: string | null } }
  | { remove_flow: { from: string; to: string; label?: string | null } }
  | { relabel_flow: { from: string; to: string; label: string } }
  /** A null `group` takes the shape out of every group. */
  | { move_to_group: { target: string; group?: string | null } };

/** The tool input (snake_case). */
export interface ProposeInput {
  file: string;
  base_hash: string;
  ops: DiagramOp[];
}

/** What the worker's outline holds about the open diagram (camelCase). `kinds` are the shape kinds this diagram takes. */
export interface FlowOutline {
  kind: string | null;
  kinds: string[];
  nodes: OutlineNode[];
  groups: OutlineGroup[];
  links: OutlineLink[];
}

export interface OutlineNode {
  name: string;
  id: string | null;
  kind: string | null;
  group: string | null;
  /** 1-based. */
  line: number;
  /** True when the shape has a `table` attribute. */
  table: boolean;
}

export interface OutlineGroup {
  name: string;
  group: string | null;
  line: number;
}

export interface OutlineLink {
  from: string;
  to: string;
  label: string | null;
  line: number;
}

/** What the Ask may change: all of the diagram, or the selected shapes. */
export type DiagramScope = { kind: "whole" } | { kind: "selection"; names: string[] };

export type DropReason =
  | "unknownShape"
  | "unknownGroup"
  | "unknownFlow"
  | "nameTaken"
  | "idReused"
  | "emptyLabel"
  | "badName"
  | "unknownKind"
  | "outsideSelection"
  | "dependsOnDropped"
  | "tooMany";

export type TargetField = "target" | "from" | "to" | "group";

export interface Candidate {
  name: string;
  id: string | null;
  line: number;
  /** `line <n>`, then `, <label of its first outgoing line>` when it has one. */
  detail: string;
}

export type ChangeStatus =
  | { kind: "ok" }
  | { kind: "dropped"; reason: DropReason; message: string }
  | { kind: "ambiguous"; field: TargetField; word: string; candidates: Candidate[] };

export interface ProposedChange {
  index: number;
  /** Holds the resolved names: a target matched by id or by words is replaced by the shape's real name. */
  op: DiagramOp;
  status: ChangeStatus;
  /** The indexes of earlier changes this one needs. */
  dependsOn: number[];
}

export interface DiagramProposal {
  file: string;
  baseHash: string;
  changes: ProposedChange[];
}

/** What the user did with a proposal; `at` is epoch milliseconds. */
export interface ToolOutcome {
  accepted: number;
  rejected: number;
  auto: boolean;
  at: number;
}

export interface ToolUse {
  tool: string;
  file: string;
  /** The model's JSON, at most 64 KB. */
  input: string;
  proposal: DiagramProposal;
  outcome: ToolOutcome | null;
}

/** One Recent tool uses row. */
export interface ToolUseRow {
  threadId: string;
  messageAt: number;
  at: number;
  tool: "proposeDiagramChanges" | "pickTables";
  /** `<file>.flow`; empty for Pick tables (the UI writes "Ask on <Connection name>"). */
  target: string;
  connectionId: ConnectionId | null;
  result: string;
}

/** The request of a diagram Ask and its preview. */
export interface DiagramAskRequest {
  requestId: string;
  file: string;
  /** The text as the tab holds it. */
  text: string;
  outline: FlowOutline;
  question: string;
  scope: DiagramScope;
  threadId?: string | null;
  model?: string | null;
  picks?: ModelPicks | null;
}
