// Mirrors the serde shapes of crates/dbview-core (model.rs, connections.rs,
// suggest.rs, error.rs). Field names are camelCase on the wire.

export type ConnectionId = string;
export type GroupId = string;

export type DialectKind = "mysql";

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
  groupId: GroupId | null;
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
  password: PasswordChange;
  groupId: GroupId | null;
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
  | { kind: "secret"; message: string };
