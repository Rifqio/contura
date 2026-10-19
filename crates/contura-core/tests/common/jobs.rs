//! The every-type fixture for the job tests (Tasks 2 and 7 to 9).
//!
//! `every_type_table` builds one table holding each type family the spec names, filled in
//! SQL (`generate_series` on PostgreSQL, a recursive CTE on MySQL and SQLite), so a
//! 100,000-row table costs one statement. Column `id` is the primary key, 1..=rows.
//! Row 1 holds the extreme values (the largest bigint and unsigned bigint); every tenth
//! row holds NULLs in its nullable columns.

use contura_core::dialect::Dialect;
use contura_core::jobs::source::{RowSource, Value};
use contura_core::model::DialectKind;

/// The columns of the every-type table, in order, per Dialect.
pub fn every_type_columns(kind: DialectKind) -> Vec<&'static str> {
    match kind {
        DialectKind::MySql => vec![
            "id", "tiny_n", "small_n", "int_n", "big_n", "u_int", "u_big", "dec_n", "float_n",
            "real_n", "flag", "body", "bin", "doc", "day", "at_time", "at_ts", "at_tz", "mood",
            "uid",
        ],
        DialectKind::Postgres => vec![
            "id", "small_n", "int_n", "big_n", "dec_n", "float_n", "real_n", "flag", "body", "bin",
            "doc", "day", "at_time", "at_ts", "at_tz", "mood", "uid", "tags", "names",
        ],
        DialectKind::Sqlite => vec![
            "id", "small_n", "int_n", "big_n", "dec_n", "float_n", "flag", "body", "bin", "doc",
            "day", "at_time", "at_ts", "at_tz", "mood", "uid",
        ],
    }
}

/// The every-type table's statements; `schema` is the PostgreSQL schema (else unused).
pub fn every_type_statements(
    kind: DialectKind,
    schema: &str,
    name: &str,
    rows: u64,
) -> Vec<String> {
    match kind {
        DialectKind::MySql => {
            let t = format!("`{}`", name.replace('`', "``"));
            vec![
                format!(
                    "CREATE TABLE {t} (
                       id BIGINT PRIMARY KEY,
                       tiny_n TINYINT, small_n SMALLINT, int_n INT, big_n BIGINT,
                       u_int INT UNSIGNED, u_big BIGINT UNSIGNED,
                       dec_n DECIMAL(20,6), float_n DOUBLE, real_n FLOAT,
                       flag BOOLEAN, body LONGTEXT, bin VARBINARY(16), doc JSON,
                       day DATE, at_time TIME, at_ts DATETIME(6), at_tz TIMESTAMP(6) NULL,
                       mood ENUM('happy','sad','ok'), uid CHAR(36)
                     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
                ),
                "SET SESSION cte_max_recursion_depth = 10000000".into(),
                format!(
                    "INSERT INTO {t}
                     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {rows})
                     SELECT n,
                       (n % 255) - 127, n % 32767, n * 7 - 350000,
                       CASE WHEN n = 1 THEN 9223372036854775807 ELSE n * 1000000007 END,
                       n * 3,
                       CASE WHEN n = 1 THEN 18446744073709551615 ELSE n * 1000000009 END,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE n * 1.000001 END,
                       n / 7, n / 4,
                       n % 2 = 0,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE
                         CONCAT('row ', n, ' it''s \"q\" back', CHAR(92), 'slash ünï 表 😀',
                                CHAR(10), 'line2', CHAR(13), CHAR(10), 'end') END,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE UNHEX(CONCAT('00ff', LPAD(HEX(n), 8, '0'))) END,
                       JSON_OBJECT('n', n, 's', CONCAT('v', n), 'a', JSON_ARRAY(1, 2.5, 'x')),
                       DATE_ADD('2000-01-01', INTERVAL n % 10000 DAY),
                       SEC_TO_TIME(n % 86400),
                       TIMESTAMPADD(MICROSECOND, n * 1000001, '2001-02-03 04:05:06'),
                       TIMESTAMPADD(MICROSECOND, n * 1000001, '2001-02-03 04:05:06'),
                       ELT(1 + n % 3, 'happy', 'sad', 'ok'),
                       LOWER(CONCAT(LPAD(HEX(n), 8, '0'), '-0000-4000-8000-', LPAD(HEX(n), 12, '0')))
                     FROM seq"
                ),
                format!("ANALYZE TABLE {t}"),
            ]
        }
        DialectKind::Postgres => {
            let t = format!("\"{schema}\".\"{}\"", name.replace('"', "\"\""));
            let mood = format!("\"{schema}\".\"{}_mood\"", name.replace('"', "\"\""));
            vec![
                format!("CREATE TYPE {mood} AS ENUM ('happy', 'sad', 'ok')"),
                format!(
                    "CREATE TABLE {t} (
                       id bigint PRIMARY KEY,
                       small_n smallint, int_n integer, big_n bigint,
                       dec_n numeric(20,6), float_n double precision, real_n real,
                       flag boolean, body text, bin bytea, doc jsonb,
                       day date, at_time time, at_ts timestamp(6), at_tz timestamptz(6),
                       mood {mood}, uid uuid, tags integer[], names text[]
                     )"
                ),
                format!(
                    "INSERT INTO {t}
                     SELECT g,
                       (g % 32767)::smallint, (g * 7 - 350000)::int,
                       CASE WHEN g = 1 THEN 9223372036854775807 ELSE g::bigint * 1000000007 END,
                       CASE WHEN g % 10 = 0 THEN NULL ELSE g * 1.000001 END,
                       CASE WHEN g % 1000 = 2 THEN 'NaN'::float8
                            WHEN g % 1000 = 3 THEN 'Infinity'::float8
                            WHEN g % 1000 = 4 THEN '-Infinity'::float8
                            ELSE g / 7.0 END,
                       (g / 4.0)::real,
                       CASE WHEN g % 10 = 0 THEN NULL ELSE g % 2 = 0 END,
                       CASE WHEN g % 10 = 0 THEN NULL ELSE
                         'row ' || g || ' it''s \"q\" back\\slash ünï 表 😀' || chr(10) || 'line2'
                         || chr(13) || chr(10) || 'end' END,
                       CASE WHEN g % 10 = 0 THEN NULL ELSE decode('00ff' || lpad(to_hex(g), 8, '0'), 'hex') END,
                       jsonb_build_object('n', g, 's', 'v' || g, 'a', jsonb_build_array(1, 2.5, 'x')),
                       date '2000-01-01' + (g % 10000)::int,
                       time '00:00' + make_interval(secs => g % 86400),
                       timestamp '2001-02-03 04:05:06' + make_interval(secs => g * 1.000001),
                       timestamptz '2001-02-03 04:05:06+07' + make_interval(secs => g * 1.000001),
                       (ARRAY['happy', 'sad', 'ok'])[1 + g % 3]::{mood},
                       (lpad(to_hex(g), 8, '0') || '-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
                       ARRAY[g::int, g::int + 1, NULL],
                       ARRAY['x' || g, 'q\"uote', 'c,d', NULL]
                     FROM generate_series(1, {rows}) g"
                ),
                format!("ANALYZE {t}"),
            ]
        }
        DialectKind::Sqlite => {
            let t = format!("\"{}\"", name.replace('"', "\"\""));
            vec![
                format!(
                    "CREATE TABLE {t} (
                       id INTEGER PRIMARY KEY,
                       small_n SMALLINT, int_n INTEGER, big_n BIGINT,
                       dec_n DECIMAL(20,6), float_n REAL,
                       flag BOOLEAN, body TEXT, bin BLOB, doc JSON,
                       day DATE, at_time TIME, at_ts DATETIME, at_tz TIMESTAMP,
                       mood TEXT CHECK (mood IN ('happy', 'sad', 'ok')), uid TEXT
                     )"
                ),
                format!(
                    "INSERT INTO {t}
                     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < {rows})
                     SELECT n,
                       n % 32767, n * 7 - 350000,
                       CASE WHEN n = 1 THEN 9223372036854775807 ELSE n * 1000000007 END,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE n * 1.000001 END,
                       n / 7.0,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE n % 2 = 0 END,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE
                         'row ' || n || ' it''s \"q\" back\\slash ünï 表 😀' || char(10) || 'line2'
                         || char(13) || char(10) || 'end' END,
                       CASE WHEN n % 10 = 0 THEN NULL ELSE unhex('00ff' || printf('%08x', n)) END,
                       json_object('n', n, 's', 'v' || n, 'a', json_array(1, 2.5, 'x')),
                       date('2000-01-01', '+' || (n % 10000) || ' days'),
                       time(n % 86400, 'unixepoch'),
                       strftime('%Y-%m-%d %H:%M:%f', 981173106 + n * 1.000001, 'unixepoch'),
                       strftime('%Y-%m-%d %H:%M:%f', 981173106 + n * 1.000001, 'unixepoch') || '+00:00',
                       CASE n % 3 WHEN 0 THEN 'happy' WHEN 1 THEN 'sad' ELSE 'ok' END,
                       printf('%08x-0000-4000-8000-%012x', n, n)
                     FROM seq"
                ),
            ]
        }
    }
}

/// Creates `name` with every type family and `rows` rows, through a query session of
/// `db`'s own (MySQL: the configured database; PostgreSQL: schema `public`).
pub async fn every_type_table(db: &dyn Dialect, kind: DialectKind, name: &str, rows: u64) {
    let session = db.open_query_session(None).await.expect("open a session");
    for sql in every_type_statements(kind, "public", name, rows) {
        session
            .execute(&sql)
            .await
            .unwrap_or_else(|e| panic!("fixture statement failed: {e}\n{sql}"));
    }
    session.close().await.ok();
}

/// Runs `sql` on a session of `db`'s own (for setup and for writes from another connection).
pub async fn run_sql(db: &dyn Dialect, sql: &str) {
    let session = db.open_query_session(None).await.expect("open a session");
    session
        .execute(sql)
        .await
        .unwrap_or_else(|e| panic!("statement failed: {e}\n{sql}"));
    session.close().await.ok();
}

fn sort_key(v: &Value) -> (i128, String) {
    match v {
        Value::Number(n) => (n.parse().unwrap_or(i128::MAX), String::new()),
        Value::Text(s) => (i128::MAX, s.clone()),
        other => (i128::MAX, format!("{other:?}")),
    }
}

/// Every row of `source`, sorted by the first column (numerically when it is a number).
pub async fn canonical_rows(mut source: Box<dyn RowSource>) -> Vec<Vec<Value>> {
    let mut rows = Vec::new();
    while let Some(chunk) = source.next_chunk().await.expect("read a chunk") {
        rows.extend(chunk.rows);
    }
    rows.sort_by_key(|r| r.first().map(sort_key));
    rows
}
