// Keywords and built-in functions per Dialect, from the Editor intelligence design.
import type { DialectKind } from "../../api/types";

export interface SqlFunction {
  name: string;
  returns: string;
  /** Each signature's parameters, such as `["field text", "source timestamptz"]`. */
  signatures: string[][];
  doc: string;
}

const F = (name: string, returns: string, sigs: string[], doc: string): SqlFunction => ({
  name,
  returns,
  signatures: sigs.map((s) => (s ? s.split(", ") : [])),
  doc,
});

const KW_BASE =
  "SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT INNER OUTER CROSS GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE WITH CREATE REPLACE VIEW TABLE DISTINCT CASE WHEN THEN ELSE END LIKE BETWEEN EXISTS UNION INTERSECT EXCEPT NATURAL ALL ASC DESC TRUE FALSE USING DEFAULT ALTER DROP EXPLAIN TRUNCATE CAST CURRENT_DATE CURRENT_TIMESTAMP RECURSIVE".split(
    " ",
  );

const AGG = [
  F("count", "bigint", ["*", "expression any"], "Counts rows, or the values that are not NULL."),
  F("sum", "numeric", ["expression numeric"], "Adds up the values that are not NULL."),
  F("avg", "numeric", ["expression numeric"], "Average of the values that are not NULL."),
  F("min", "any", ["expression any"], "Smallest value."),
  F("max", "any", ["expression any"], "Largest value."),
  F("coalesce", "any", ["value any, ...more any"], "Returns the first argument that is not NULL."),
  F("lower", "text", ["s text"], "Lower-cases the text."),
  F("upper", "text", ["s text"], "Upper-cases the text."),
  F("length", "int", ["s text"], "Number of characters."),
  F("concat", "text", ["value any, ...more any"], "Joins the values as text."),
];

export const KEYWORDS: Record<DialectKind, string[]> = {
  // Each list also holds the Dialect's reserved words that can stand where a column could, since a column so named
  // must be quoted: words a column may legally be named (DAY, YEAR, ROWS ...) are keywords only in context (analyze.ts).
  postgres: [
    ...KW_BASE,
    ..."FULL ILIKE RETURNING LATERAL FILTER OVER PARTITION INTERVAL SIMILAR FETCH CONFLICT DO NOTHING MATERIALIZED ANALYZE".split(" "),
    ..."COLLATE FOR TO ARRAY ANY SOME ONLY BOTH LEADING TRAILING PLACING SYMMETRIC VARIADIC CONSTRAINT WINDOW CURRENT_TIME CURRENT_USER SESSION_USER CURRENT_ROLE CURRENT_CATALOG CURRENT_SCHEMA USER LOCALTIME LOCALTIMESTAMP".split(" "),
  ],
  mysql: [
    ...KW_BASE,
    ..."REGEXP STRAIGHT_JOIN DUPLICATE KEY IGNORE INTERVAL DIV".split(" "),
    ..."COLLATE FOR TO LOCK MATCH LEADING TRAILING BOTH CONVERT UNSIGNED CHAR CHARACTER DECIMAL INT INTEGER BINARY ROW ROWS RANGE OVER PARTITION WINDOW LATERAL DUAL FORCE USE INDEX XOR MOD RLIKE DISTINCTROW SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SQL_BIG_RESULT HIGH_PRIORITY LOW_PRIORITY DELAYED CURRENT_TIME CURRENT_USER LOCALTIME LOCALTIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP".split(" "),
    ..."SECOND_MICROSECOND MINUTE_MICROSECOND MINUTE_SECOND HOUR_MICROSECOND HOUR_SECOND HOUR_MINUTE DAY_MICROSECOND DAY_SECOND DAY_MINUTE DAY_HOUR YEAR_MONTH".split(" "),
  ],
  sqlite: [...KW_BASE, ..."FULL GLOB PRAGMA VACUUM RETURNING WITHOUT ROWID IGNORE ABORT".split(" "), ..."COLLATE ISNULL NOTNULL CURRENT_TIME".split(" ")],
};

export const FUNCTIONS: Record<DialectKind, SqlFunction[]> = {
  postgres: [
    ...AGG,
    F("round", "numeric", ["v numeric", "v numeric, s int"], "Rounds v, to s decimal places when s is given."),
    F("date_trunc", "timestamptz", ["field text, source timestamptz", "field text, source timestamptz, time_zone text"], "Cuts a timestamp down to the given precision, such as 'day' or 'week'."),
    F("date_part", "double precision", ["field text, source timestamptz"], "Gets one field, such as 'hour', from a timestamp."),
    F("date_bin", "timestamptz", ["stride interval, source timestamptz, origin timestamptz"], "Puts a timestamp into buckets of the given stride."),
    F("now", "timestamptz", [""], "Start time of the current transaction."),
    F("to_char", "text", ["value timestamptz, format text", "value numeric, format text"], "Formats a timestamp or number as text."),
    F("to_date", "date", ["text text, format text"], "Reads a date from text."),
    F("to_timestamp", "timestamptz", ["text text, format text", "epoch double precision"], "Reads a timestamp from text or Unix seconds."),
    F("to_number", "numeric", ["text text, format text"], "Reads a number from text."),
    F("nullif", "any", ["a any, b any"], "NULL when a equals b, otherwise a."),
    F("string_agg", "text", ["value text, delimiter text"], "Joins the values with the delimiter."),
    F("array_agg", "anyarray", ["value any"], "Collects the values into an array."),
    F("greatest", "any", ["value any, ...more any"], "Largest of the arguments."),
    F("least", "any", ["value any, ...more any"], "Smallest of the arguments."),
    F("json_build_object", "json", ["key text, value any, ...more any"], "Builds a JSON object from pairs."),
    F("generate_series", "setof int", ["start int, stop int", "start int, stop int, step int"], "A row for each value in the range."),
  ],
  mysql: [
    ...AGG,
    F("round", "decimal", ["x decimal", "x decimal, d int"], "Rounds x to d decimal places."),
    F("ifnull", "any", ["expr1 any, expr2 any"], "expr2 when expr1 is NULL."),
    F("date", "date", ["expr datetime"], "The date part of a datetime."),
    F("date_format", "varchar", ["date datetime, format varchar"], "Formats a date, such as '%Y-%m-%d'."),
    F("date_add", "datetime", ["date datetime, interval_expr interval"], "Adds an interval to a date."),
    F("date_sub", "datetime", ["date datetime, interval_expr interval"], "Subtracts an interval from a date."),
    F("datediff", "int", ["a date, b date"], "Days from b to a."),
    F("now", "datetime", [""], "Current date and time."),
    F("curdate", "date", [""], "Current date."),
    F("group_concat", "text", ["expr any"], "Joins the values with commas."),
    F("json_object", "json", ["key varchar, value any, ...more any"], "Builds a JSON object from pairs."),
  ],
  sqlite: [
    ...AGG,
    F("round", "real", ["x real", "x real, digits int"], "Rounds x to the given digits."),
    F("ifnull", "any", ["x any, y any"], "y when x is NULL."),
    F("date", "text", ["time text, modifier text"], "The date as YYYY-MM-DD."),
    F("datetime", "text", ["time text, modifier text"], "The date and time as YYYY-MM-DD HH:MM:SS."),
    F("strftime", "text", ["format text, time text"], "Formats a time with % codes."),
    F("julianday", "real", ["time text"], "Days since noon in Greenwich on November 24, 4714 B.C."),
    F("unixepoch", "int", ["time text"], "Seconds since 1970."),
    F("group_concat", "text", ["x any", "x any, separator text"], "Joins the values."),
    F("printf", "text", ["format text, ...args any"], "Formats text like C printf."),
  ],
};

export const START_KW = ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "CREATE", "ALTER", "DROP", "EXPLAIN", "TRUNCATE"];
export const AFTER_TABLE_KW = ["JOIN", "LEFT JOIN", "INNER JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "WHERE", "GROUP BY", "ORDER BY", "LIMIT", "ON", "AS", "USING"];
export const EXPR_KW = ["AND", "OR", "NOT", "IS NULL", "IS NOT NULL", "IN", "LIKE", "ILIKE", "BETWEEN", "AS", "ASC", "DESC", "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "FROM", "REGEXP", "GLOB"];
export const COL_KW = ["CASE", "NOT", "NULL", "TRUE", "FALSE", "EXISTS", "DISTINCT", "CAST", "CURRENT_DATE", "CURRENT_TIMESTAMP", "INTERVAL"];

/** Every keyword of any Dialect, so a Dialect's keyword is never taken for a table name. */
export const ALL_KEYWORDS = new Set(Object.values(KEYWORDS).flat());

export const keywordSet = (d: DialectKind) => new Set(KEYWORDS[d]);
export const functionMap = (d: DialectKind) => new Map(FUNCTIONS[d].map((f) => [f.name, f]));
