// A copy of the Core lists in crates/contura-core/src/visual_query/reserved.rs;
// reserved.test.ts fails when the two differ.
import type { DialectKind } from "../api/types";

export const RESERVED: Record<DialectKind, readonly string[]> = {
  postgres: [
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "between",
    "binary", "both", "case", "cast", "check", "collate", "collation", "column", "concurrently", "constraint",
    "create", "cross", "current_catalog", "current_date", "current_role", "current_schema", "current_time",
    "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct", "do", "else", "end",
    "except", "exists", "false", "fetch", "for", "foreign", "freeze", "from", "full", "grant", "group",
    "having", "ilike", "in", "initially", "inner", "intersect", "into", "is", "isnull", "join", "lateral",
    "leading", "left", "like", "limit", "localtime", "localtimestamp", "natural", "not", "notnull", "null",
    "offset", "on", "only", "or", "order", "outer", "overlaps", "placing", "primary", "references", "returning",
    "right", "row", "select", "session_user", "similar", "some", "symmetric", "system_user", "table",
    "tablesample", "then", "to", "trailing", "true", "union", "unique", "user", "using", "values", "variadic",
    "verbose", "when", "where", "window", "with",
  ],
  mysql: [
    "accessible", "add", "all", "alter", "analyze", "and", "as", "asc", "asensitive", "before", "between",
    "bigint", "binary", "blob", "both", "by", "call", "cascade", "case", "change", "char", "character", "check",
    "collate", "column", "condition", "constraint", "continue", "convert", "create", "cross", "cube",
    "cume_dist", "current_date", "current_time", "current_timestamp", "current_user", "cursor", "database",
    "databases", "day_hour", "day_microsecond", "day_minute", "day_second", "dec", "decimal", "declare",
    "default", "delayed", "delete", "dense_rank", "desc", "describe", "deterministic", "distinct",
    "distinctrow", "div", "do", "double", "drop", "dual", "each", "else", "elseif", "empty", "enclosed",
    "escaped", "except", "exists", "exit", "explain", "false", "fetch", "first_value", "float", "float4",
    "float8", "for", "force", "foreign", "from", "fulltext", "function", "generated", "get", "grant", "group",
    "grouping", "groups", "having", "high_priority", "hour_microsecond", "hour_minute", "hour_second", "if",
    "ignore", "in", "index", "infile", "inner", "inout", "insensitive", "insert", "int", "int1", "int2", "int3",
    "int4", "int8", "integer", "intersect", "interval", "into", "io_after_gtids", "io_before_gtids", "is",
    "iterate", "join", "json_table", "key", "keys", "kill", "lag", "last_value", "lateral", "lead", "leading",
    "leave", "left", "like", "limit", "linear", "lines", "load", "localtime", "localtimestamp", "lock", "long",
    "longblob", "longtext", "loop", "low_priority", "manual", "master_bind", "master_ssl_verify_server_cert",
    "match", "maxvalue", "mediumblob", "mediumint", "mediumtext", "middleint", "minute_microsecond",
    "minute_second", "mod", "modifies", "natural", "no_write_to_binlog", "not", "nth_value", "ntile", "null",
    "numeric", "of", "on", "optimize", "optimizer_costs", "option", "optionally", "or", "order", "out", "outer",
    "outfile", "over", "parallel", "partition", "percent_rank", "precision", "primary", "procedure", "purge",
    "qualify", "range", "rank", "read", "read_write", "reads", "real", "recursive", "references", "regexp",
    "release", "rename", "repeat", "replace", "require", "resignal", "restrict", "return", "revoke", "right",
    "rlike", "row", "row_number", "rows", "schema", "schemas", "second_microsecond", "select", "sensitive",
    "separator", "set", "show", "signal", "smallint", "spatial", "specific", "sql", "sql_big_result",
    "sql_calc_found_rows", "sql_small_result", "sqlexception", "sqlstate", "sqlwarning", "ssl", "starting",
    "stored", "straight_join", "system", "table", "tablesample", "terminated", "then", "tinyblob", "tinyint",
    "tinytext", "to", "trailing", "trigger", "true", "undo", "union", "unique", "unlock", "unsigned", "update",
    "usage", "use", "using", "utc_date", "utc_time", "utc_timestamp", "values", "varbinary", "varchar",
    "varcharacter", "varying", "virtual", "when", "where", "while", "window", "with", "write", "xor",
    "year_month", "zerofill",
  ],
  sqlite: [
    "abort", "action", "add", "after", "all", "alter", "always", "analyze", "and", "as", "asc", "attach",
    "autoincrement", "before", "begin", "between", "by", "cascade", "case", "cast", "check", "collate",
    "column", "commit", "conflict", "constraint", "create", "cross", "current", "current_date", "current_time",
    "current_timestamp", "database", "default", "deferrable", "deferred", "delete", "desc", "detach",
    "distinct", "do", "drop", "each", "else", "end", "escape", "except", "exclude", "exclusive", "exists",
    "explain", "fail", "filter", "first", "following", "for", "foreign", "from", "full", "generated", "glob",
    "group", "groups", "having", "if", "ignore", "immediate", "in", "index", "indexed", "initially", "inner",
    "insert", "instead", "intersect", "into", "is", "isnull", "join", "key", "last", "left", "like", "limit",
    "match", "materialized", "natural", "no", "not", "nothing", "notnull", "null", "nulls", "of", "offset",
    "on", "or", "order", "others", "outer", "over", "partition", "plan", "pragma", "preceding", "primary",
    "query", "raise", "range", "recursive", "references", "regexp", "reindex", "release", "rename", "replace",
    "restrict", "returning", "right", "rollback", "row", "rows", "savepoint", "select", "set", "table", "temp",
    "temporary", "then", "ties", "to", "transaction", "trigger", "unbounded", "union", "unique", "update",
    "using", "vacuum", "values", "view", "virtual", "when", "where", "window", "with", "without",
  ],
};

const SETS: Record<DialectKind, ReadonlySet<string>> = {
  postgres: new Set(RESERVED.postgres),
  mysql: new Set(RESERVED.mysql),
  sqlite: new Set(RESERVED.sqlite),
};

/** True when the Core quotes `word` as a reserved word of the Dialect; case does not matter. */
export function isReserved(dialect: DialectKind, word: string): boolean {
  return SETS[dialect].has(word.toLowerCase());
}

/** True when `word` is reserved in any Dialect, so an alias made from it stays bare wherever the model runs. */
export function isReservedAnywhere(word: string): boolean {
  const w = word.toLowerCase();
  return SETS.postgres.has(w) || SETS.mysql.has(w) || SETS.sqlite.has(w);
}
