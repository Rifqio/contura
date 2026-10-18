import type { DialectKind } from "../api/types";

// D26: suggestions only; the Type cell takes any SQL type the server accepts.
const MYSQL = [
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "tinyint(1)",
  "decimal(10,2)",
  "float",
  "double",
  "varchar(255)",
  "char(1)",
  "text",
  "mediumtext",
  "longtext",
  "date",
  "datetime",
  "timestamp",
  "time",
  "year",
  "json",
  "blob",
  "varbinary(255)",
];

const POSTGRES = [
  "integer",
  "bigint",
  "smallint",
  "numeric(10,2)",
  "real",
  "double precision",
  "varchar(255)",
  "char(1)",
  "text",
  "boolean",
  "date",
  "timestamp",
  "timestamptz",
  "time",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "inet",
];

const SQLITE = ["integer", "text", "real", "numeric", "blob", "boolean", "date", "datetime", "varchar(255)"];

/** Common column types for the Dialect, offered in the Type cell. */
export function typeSuggestions(dialect: DialectKind): string[] {
  return dialect === "mysql" ? MYSQL : dialect === "postgres" ? POSTGRES : SQLITE;
}
