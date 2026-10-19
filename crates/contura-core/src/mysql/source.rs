//! The export read: one connection of its own in a consistent snapshot, streamed row by
//! row with `query_iter` (never `query`, which collects) into chunks.

use std::collections::HashMap;
use std::sync::Arc;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, OptsBuilder, Pool, Value as MyValue};

use super::quote::quote_ident;
use super::session::{BYTES, NUMERIC, type_name};
use super::{query_err, session_err};
use crate::backup::data::{
    PendingRows, SnapshotFacts, SnapshotRead, TableAsk, TableFacts, snapshot_channel,
    snapshot_opened,
};
use crate::backup::structure::mysql::read_structure;
use crate::common::sql_scoped;
use crate::error::{Error, Result};
use crate::jobs::source::{
    Opened, Producer, RowSource, SourceColumn, SourceRequest, TableStorage, check_one_statement,
    checked_query, source_channel, start_source, value_kind,
};
use crate::model::{ColumnInfo, DialectKind, ObjectPath};
use crate::query::Canceller;

/// How a value is carried from the text protocol.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Carry {
    Number,
    Bytes,
    Text,
}

const SPATIAL: &[&str] = &[
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
    "geomcollection",
];

struct TableColumn {
    info: ColumnInfo,
    data_type: String,
}

/// Stops the read's statement from a pooled connection.
struct Kill {
    pool: Pool,
    id: u32,
}

#[async_trait::async_trait]
impl Canceller for Kill {
    async fn cancel(&self) -> Result<()> {
        let mut conn = self.pool.get_conn().await.map_err(query_err)?;
        conn.query_drop(format!("KILL QUERY {}", self.id))
            .await
            .map_err(query_err)
    }
}

pub(super) async fn open(
    opts: OptsBuilder,
    pool: Pool,
    read_only: bool,
    req: &SourceRequest,
) -> Result<Box<dyn RowSource>> {
    // A Query is checked before any connection opens.
    if let SourceRequest::Query { sql, .. } = req {
        checked_query(DialectKind::MySql, sql)?;
    }
    let req = req.clone();
    start_source(move |p| {
        tokio::spawn(produce(opts, pool, read_only, req, p));
    })
    .await
}

async fn produce(opts: OptsBuilder, pool: Pool, read_only: bool, req: SourceRequest, p: Producer) {
    let mut conn = match Conn::new(opts).await {
        Ok(c) => c,
        Err(e) => {
            let _ = p.ready.send(Err(Error::Connect(format!(
                "cannot open a connection for the export: {e}"
            ))));
            return;
        }
    };
    let kill = Arc::new(Kill {
        pool,
        id: conn.id(),
    });
    match plan(&mut conn, &req).await {
        Ok(planned) => stream(&mut conn, planned, kill, p, read_only).await,
        Err(e) => {
            let _ = p.ready.send(Err(e));
        }
    }
    // Closing without COMMIT ends the read-only transaction.
    let _ = conn.disconnect().await;
}

/// The SELECT and how to carry its values. A Query's columns are known only from its
/// result, so `columns` is None for one and `carry` is filled in then.
struct Plan {
    sql: String,
    carry: Vec<Carry>,
    columns: Option<Vec<SourceColumn>>,
    estimate: Option<u64>,
}

/// Starts the snapshot and works out the SELECT. Table columns are known here; a
/// Query's come from its result.
async fn plan(conn: &mut Conn, req: &SourceRequest) -> Result<Plan> {
    conn.query_drop("SET SESSION net_write_timeout = 600")
        .await
        .map_err(query_err)?;
    conn.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        .await
        .map_err(query_err)?;
    plan_select(conn, req).await
}

/// The SELECT and how to carry its values, inside a snapshot already open.
async fn plan_select(conn: &mut Conn, req: &SourceRequest) -> Result<Plan> {
    let Some(parts) = req.table_parts() else {
        let SourceRequest::Query { database, sql } = req else {
            unreachable!("not a table, so a query");
        };
        if let Some(db) = database {
            conn.query_drop(format!("USE {}", quote_ident(db)))
                .await
                .map_err(query_err)?;
        }
        let sql = checked_query(DialectKind::MySql, sql)?;
        // The text protocol runs every statement it is given; preparing first refuses a
        // second one, as for a filter.
        let stmt = conn.prep(&sql).await.map_err(query_err)?;
        conn.close(stmt).await.map_err(query_err)?;
        return Ok(Plan {
            sql,
            carry: Vec::new(),
            columns: None,
            estimate: None,
        });
    };
    let path = parts.path;
    let all = table_columns(conn, path).await?;
    let infos: Vec<ColumnInfo> = all.iter().map(|c| c.info.clone()).collect();
    let read = parts.read(DialectKind::MySql, &infos)?;
    let srids = if all.iter().any(|c| SPATIAL.contains(&c.data_type.as_str())) {
        column_srids(conn, path).await?
    } else {
        HashMap::new()
    };
    let mut list = Vec::new();
    let mut carry = Vec::new();
    let mut columns = Vec::new();
    for &i in &read.selected {
        let c = &all[i];
        let q = quote_ident(&c.info.name);
        let data_type = c.data_type.as_str();
        if data_type == "bit" {
            list.push(format!("{q} + 0"));
            carry.push(Carry::Number);
        } else if SPATIAL.contains(&data_type) {
            // The SQL writer reads the SRID from ` SRID n` on the type, or from a value's
            // own `SRID=n;` (Q34 I1). A column declared with an SRID holds only that one;
            // any other spatial column carries each value's SRID unless it is 0.
            match srids.get(&c.info.name) {
                Some(_) => list.push(format!("ST_AsText({q})")),
                None => list.push(format!(
                    "IF(ST_SRID({q}) = 0, ST_AsText({q}), \
                     CONCAT('SRID=', ST_SRID({q}), ';', ST_AsText({q})))"
                )),
            }
            carry.push(Carry::Text);
        } else {
            list.push(q);
            carry.push(carry_of(data_type));
        }
        let type_name = match srids.get(&c.info.name) {
            Some(srid) => format!("{} SRID {srid}", c.info.type_name),
            None => c.info.type_name.clone(),
        };
        columns.push(SourceColumn {
            name: c.info.name.clone(),
            kind: value_kind(DialectKind::MySql, &c.info.type_name),
            type_name,
        });
    }
    let mut sql = format!(
        "SELECT {} FROM {}",
        list.join(", "),
        sql_scoped(DialectKind::MySql, &path.database, &path.name)
    );
    sql.push_str(&read.where_sql);
    if !read.order_by.is_empty() {
        let order: Vec<String> = read
            .order_by
            .iter()
            .map(|(c, desc)| format!("{} {}", quote_ident(c), if *desc { "DESC" } else { "ASC" }))
            .collect();
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    if read.has_filter {
        check_one_statement(DialectKind::MySql, &sql)?;
        // The text protocol runs every statement it is given; preparing first refuses a
        // filter that adds a second one, as the grid does.
        let stmt = conn.prep(&sql).await.map_err(query_err)?;
        conn.close(stmt).await.map_err(query_err)?;
    }
    let estimate = if read.plain {
        table_rows(conn, path).await?
    } else {
        None
    };
    Ok(Plan {
        sql,
        carry,
        columns: Some(columns),
        estimate,
    })
}

fn carry_of(data_type: &str) -> Carry {
    match super::page::classify(data_type) {
        super::page::ColumnKind::Number | super::page::ColumnKind::Bit => Carry::Number,
        super::page::ColumnKind::Bytes => Carry::Bytes,
        super::page::ColumnKind::Text => Carry::Text,
    }
}

async fn table_columns(conn: &mut Conn, path: &ObjectPath) -> Result<Vec<TableColumn>> {
    let rows: Vec<(String, String, String, String)> = conn
        .exec(
            "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
             CAST(DATA_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR) FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (&path.database, &path.name),
        )
        .await
        .map_err(query_err)?;
    if rows.is_empty() {
        return Err(Error::NotFound(format!(
            "table {}.{}",
            path.database, path.name
        )));
    }
    Ok(rows
        .into_iter()
        .map(|(name, type_name, data_type, key)| TableColumn {
            info: ColumnInfo {
                name,
                type_name,
                is_primary_key: key == "PRI",
            },
            data_type: data_type.to_ascii_lowercase(),
        })
        .collect())
}

/// The SRID each spatial column was declared with (`SRS_ID`, MySQL 8). A server without
/// that column (MySQL 5.7, MariaDB) gives none, and every value then carries its own
/// SRID; any other error is the server's and stops the read.
async fn column_srids(conn: &mut Conn, path: &ObjectPath) -> Result<HashMap<String, u32>> {
    let rows: std::result::Result<Vec<(String, u32)>, _> = conn
        .exec(
            "SELECT CAST(COLUMN_NAME AS CHAR), SRS_ID FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND SRS_ID IS NOT NULL",
            (&path.database, &path.name),
        )
        .await;
    match rows {
        Ok(rows) => Ok(rows.into_iter().collect()),
        Err(mysql_async::Error::Server(e)) if e.code == UNKNOWN_COLUMN => Ok(HashMap::new()),
        Err(e) => Err(query_err(e)),
    }
}

/// ER_BAD_FIELD_ERROR: the server has no such column.
const UNKNOWN_COLUMN: u16 = 1054;

/// The server's row estimate (`TABLE_ROWS`); None for a view.
async fn table_rows(conn: &mut Conn, path: &ObjectPath) -> Result<Option<u64>> {
    let found: Option<Option<u64>> = conn
        .exec_first(
            "SELECT TABLE_ROWS FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'",
            (&path.database, &path.name),
        )
        .await
        .map_err(query_err)?;
    Ok(found.flatten())
}

pub(super) async fn table_storage(pool: &Pool, path: &ObjectPath) -> Result<TableStorage> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let found: Option<Option<String>> = conn
        .exec_first(
            "SELECT CAST(ENGINE AS CHAR) FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            (&path.database, &path.name),
        )
        .await
        .map_err(query_err)?;
    let Some(engine) = found else {
        return Err(Error::NotFound(format!(
            "table {}.{}",
            path.database, path.name
        )));
    };
    Ok(match engine {
        // A view has no engine of its own.
        None => TableStorage::default(),
        Some(engine) => TableStorage {
            transactional: ["innodb", "ndbcluster", "ndb"]
                .contains(&engine.to_ascii_lowercase().as_str()),
            engine: Some(engine),
            sqlite_wal: None,
        },
    })
}

fn value_of(v: Option<MyValue>, carry: Carry) -> crate::jobs::source::Value {
    use crate::jobs::source::Value;
    match v {
        None | Some(MyValue::NULL) => Value::Null,
        Some(MyValue::Bytes(b)) => match carry {
            Carry::Number => Value::Number(String::from_utf8_lossy(&b).into_owned()),
            Carry::Bytes => Value::Bytes(b),
            // Text that is not UTF-8 is kept as its bytes rather than mangled.
            Carry::Text => match String::from_utf8(b) {
                Ok(s) => Value::Text(s),
                Err(e) => Value::Bytes(e.into_bytes()),
            },
        },
        // The text protocol sends bytes; anything else is written as SQL would show it.
        Some(other) => Value::Text(other.as_sql(true)),
    }
}

/// A Query's columns are carried by their result types: BIT and spatial columns come as
/// raw bytes there, while a table read selects them as `col + 0` and `ST_AsText(col)`.
async fn stream(conn: &mut Conn, plan: Plan, kill: Arc<Kill>, p: Producer, read_only: bool) {
    let Plan {
        sql,
        mut carry,
        columns,
        estimate,
    } = plan;
    let Producer { ready, mut feed } = p;
    let mut result = match conn.query_iter(sql.clone()).await {
        Ok(r) => r,
        Err(e) => {
            let _ = ready.send(Err(session_err(e, read_only)));
            return;
        }
    };
    let columns = match columns {
        Some(c) => c,
        None => {
            let Some(found) = result.columns().filter(|c| !c.is_empty()) else {
                let _ = result.drop_result().await;
                let _ = ready.send(Err(Error::InvalidInput(
                    "This statement returns no rows to export.".into(),
                )));
                return;
            };
            carry = found
                .iter()
                .map(|c| {
                    let t = type_name(c);
                    if NUMERIC.contains(&t) {
                        Carry::Number
                    } else if BYTES.contains(&t) {
                        Carry::Bytes
                    } else {
                        Carry::Text
                    }
                })
                .collect();
            found
                .iter()
                .map(|c| {
                    let t = type_name(c);
                    SourceColumn {
                        name: c.name_str().into_owned(),
                        type_name: t.to_string(),
                        kind: value_kind(DialectKind::MySql, t),
                    }
                })
                .collect()
        }
    };
    let opened = Opened {
        columns,
        estimate,
        sql,
        server: kill.clone(),
    };
    if ready.send(Ok(opened)).is_err() {
        let _ = kill.cancel().await;
        let _ = result.drop_result().await;
        return;
    }
    loop {
        match result.next().await {
            Ok(Some(mut row)) => {
                let values = carry
                    .iter()
                    .enumerate()
                    .map(|(i, c)| value_of(row.take(i), *c))
                    .collect();
                if !feed.push(values).await {
                    // Cancelled or dropped: stop the server sending the rest.
                    let _ = kill.cancel().await;
                    let _ = result.drop_result().await;
                    return;
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = result.drop_result().await;
                feed.fail(session_err(e, read_only)).await;
                return;
            }
        }
    }
    let _ = result.drop_result().await;
    feed.finish().await;
}

// ---- The Backup's snapshot (step 9) ----

/// Engines with transactions, whose tables the snapshot covers.
fn transactional(engine: &str) -> bool {
    ["innodb", "ndbcluster", "ndb"].contains(&engine.to_ascii_lowercase().as_str())
}

/// Opens the Backup's snapshot of `database` on a connection of its own; see
/// `Dialect::open_backup_read`.
pub(super) async fn backup_read(
    opts: OptsBuilder,
    pool: Pool,
    read_only: bool,
    database: &str,
    count_rows: bool,
) -> Result<SnapshotRead> {
    let (ready, opened, asks_tx, asks) = snapshot_channel();
    let database = database.to_string();
    tokio::spawn(async move {
        let mut conn = match Conn::new(opts).await {
            Ok(c) => c,
            Err(e) => {
                let _ = ready.send(Err(Error::Connect(format!(
                    "cannot open a connection for the backup: {e}"
                ))));
                return;
            }
        };
        let kill = Arc::new(Kill {
            pool,
            id: conn.id(),
        });
        let facts = snapshot_facts(&mut conn, &database, count_rows).await;
        let ok = facts.is_ok();
        if ready.send(facts).is_ok() && ok {
            serve(&mut conn, &database, kill, read_only, asks).await;
        }
        // Closing without COMMIT ends the read-only transaction.
        let _ = conn.disconnect().await;
    });
    snapshot_opened(opened, asks_tx).await
}

/// A table's name, engine, row estimate and data length.
type TableStat = (String, Option<String>, Option<u64>, Option<u64>);

async fn snapshot_facts(
    conn: &mut Conn,
    database: &str,
    count_rows: bool,
) -> Result<SnapshotFacts> {
    conn.query_drop("SET SESSION net_write_timeout = 600, time_zone = '+00:00'")
        .await
        .map_err(query_err)?;
    conn.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        .await
        .map_err(query_err)?;
    let parts = read_structure(conn, database).await?;
    let stats: Vec<TableStat> = conn
        .exec(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(ENGINE AS CHAR), TABLE_ROWS, DATA_LENGTH \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut tables = Vec::with_capacity(parts.tables.len());
    let mut non_snapshot = Vec::new();
    let mut data_bytes = 0u64;
    for name in &parts.tables {
        let stat = stats.iter().find(|s| &s.0 == name);
        data_bytes += stat.and_then(|s| s.3).unwrap_or(0);
        if let Some(engine) = stat.and_then(|s| s.1.as_deref())
            && !transactional(engine)
        {
            non_snapshot.push((name.clone(), engine.to_string()));
        }
        let rows = if count_rows {
            let n: Option<u64> = conn
                .query_first(format!(
                    "SELECT COUNT(*) FROM {}",
                    sql_scoped(DialectKind::MySql, database, name)
                ))
                .await
                .map_err(query_err)?;
            n.unwrap_or(0)
        } else {
            stat.and_then(|s| s.2).unwrap_or(0)
        };
        tables.push(TableFacts {
            name: name.clone(),
            rows,
        });
    }
    Ok(SnapshotFacts {
        parts,
        tables,
        data_bytes,
        non_snapshot,
    })
}

/// Serves each asked table's rows on the snapshot's connection, one after the other.
async fn serve(
    conn: &mut Conn,
    database: &str,
    kill: Arc<Kill>,
    read_only: bool,
    mut asks: tokio::sync::mpsc::Receiver<TableAsk>,
) {
    while let Some(ask) = asks.recv().await {
        let planned = async {
            let (columns, key) = backup_columns(conn, database, &ask.table).await?;
            let req = SourceRequest::Table {
                path: ObjectPath {
                    database: database.to_string(),
                    schema: None,
                    name: ask.table.clone(),
                },
                columns,
                filter: None,
                sort: None,
                keys: Vec::new(),
            };
            Ok::<_, Error>((plan_select(conn, &req).await?, key))
        }
        .await;
        match planned {
            Err(e) => {
                let _ = ask.reply.send(Err(e));
            }
            Ok((plan, key)) => {
                let (producer, pending) = source_channel();
                let rows = PendingRows {
                    source: pending,
                    overriding: false,
                    key,
                };
                if ask.reply.send(Ok(rows)).is_err() {
                    return;
                }
                stream(conn, plan, kill.clone(), producer, read_only).await;
            }
        }
    }
}

/// The table's columns the Backup writes: all but the generated ones (`VIRTUAL
/// GENERATED`, `STORED GENERATED`; an expression default is `DEFAULT_GENERATED` and stays).
/// Also the primary key's columns, to name a row in a message.
async fn backup_columns(
    conn: &mut Conn,
    database: &str,
    table: &str,
) -> Result<(Vec<String>, Vec<String>)> {
    let rows: Vec<(String, String, String)> = conn
        .exec(
            "SELECT CAST(COLUMN_NAME AS CHAR), CAST(EXTRA AS CHAR), CAST(COLUMN_KEY AS CHAR) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let key = rows
        .iter()
        .filter(|(_, _, k)| k == "PRI")
        .map(|(name, _, _)| name.clone())
        .collect();
    let columns = rows
        .into_iter()
        .filter(|(_, extra, _)| {
            let e = extra.to_ascii_uppercase();
            !e.contains("VIRTUAL GENERATED") && !e.contains("STORED GENERATED")
        })
        .map(|(name, _, _)| name)
        .collect();
    Ok((columns, key))
}
