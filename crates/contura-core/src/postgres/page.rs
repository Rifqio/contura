//! Paged table data and full cell values.
//!
//! Pages run through the simple query protocol, so every value arrives as
//! Postgres's own text: numbers, dates and arrays read exactly as stored.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio_postgres::types::Type;
use tokio_postgres::{Client, GenericClient, SimpleQueryMessage};

use super::query_err;
use crate::common::{check_key, decode_hex, order_columns, quote_double, text_preview};
use crate::error::{Error, Result};
use crate::model::{
    Cell, ColumnInfo, FULL_VALUE_LIMIT, FullValue, FullValueRequest, ObjectPath, PAGE_SIZE,
    PREVIEW_BYTES, PREVIEW_CHARS, Page, PageRequest,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ColumnKind {
    Bytes,
    Number,
    Text,
}

/// A table's catalog facts, shared by the grid and the export read.
pub(super) struct Relation {
    /// `pg_class.relkind`: `r`, `p`, `m`, `v` or `f`.
    pub(super) relkind: String,
    /// `pg_class.reltuples`: the planner's row estimate, negative when never analyzed.
    pub(super) reltuples: f64,
    pub(super) columns: Vec<ColumnInfo>,
    pub(super) kinds: Vec<ColumnKind>,
    /// Whether `ORDER BY` works on each column's own type.
    sortable: Vec<bool>,
    /// Each column's base type name (`pg_type.typname`; a domain counts as its base).
    pub(super) bases: Vec<String>,
}

impl Relation {
    fn has_ctid(&self) -> bool {
        matches!(self.relkind.as_str(), "r" | "m" | "p")
    }
}

const RELATION_SQL: &str = "\
SELECT c.oid, c.relkind::text, c.reltuples::float8 \
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm', 'v', 'f')";

/// A domain over `bytea` counts as `bytea`; domains share their base type's category.
///
/// The last column says whether `ORDER BY` works on the column's own type. It
/// follows the server's rule for a default btree opclass: an exact match, an
/// enum, range or multirange, or exactly one binary-coercible match (or one
/// preferred in the type's category). Domains are judged by their base type,
/// arrays by their element type. A miss here only costs a sort by text. The
/// sixth column is the base type's name, for the export read.
const COLUMNS_SQL: &str = "\
SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), \
       EXISTS (SELECT 1 FROM pg_index i \
                WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)), \
       CASE WHEN COALESCE(NULLIF(t.typbasetype, 0), t.oid) = 'bytea'::regtype THEN 'b' \
            WHEN t.typcategory = 'N' THEN 'n' ELSE 't' END, \
       EXISTS (SELECT 1 FROM pg_opclass o JOIN pg_am m ON m.oid = o.opcmethod \
                WHERE m.amname = 'btree' AND o.opcdefault AND o.opcintype = s.oid) \
       OR s.typtype IN ('e', 'r', 'm') \
       OR (SELECT count(*) = 1 \
                  OR count(*) FILTER (WHERE p.typispreferred AND p.typcategory = s.typcategory) = 1 \
             FROM pg_opclass o JOIN pg_am m ON m.oid = o.opcmethod \
             JOIN pg_cast c ON c.casttarget = o.opcintype \
             JOIN pg_type p ON p.oid = o.opcintype \
            WHERE m.amname = 'btree' AND o.opcdefault \
              AND c.castsource = s.oid AND c.castmethod = 'b'), \
       b.typname::text \
  FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid \
  JOIN pg_type b ON b.oid = COALESCE(NULLIF(t.typbasetype, 0), t.oid) \
  JOIN pg_type e ON e.oid = CASE WHEN b.typcategory = 'A' THEN b.typelem ELSE b.oid END \
  JOIN pg_type s ON s.oid = COALESCE(NULLIF(e.typbasetype, 0), e.oid) \
 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
 ORDER BY a.attnum";

fn schema_of(path: &ObjectPath) -> Result<&str> {
    path.schema
        .as_deref()
        .ok_or_else(|| Error::InvalidInput("choose a schema".into()))
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_double(schema), quote_double(name))
}

pub(super) async fn relation(
    client: &impl GenericClient,
    schema: &str,
    name: &str,
) -> Result<Relation> {
    let found = client
        .query_opt(RELATION_SQL, &[&schema, &name])
        .await
        .map_err(query_err)?
        .ok_or_else(|| Error::NotFound(format!("table {name} in {schema}")))?;
    let oid: u32 = found.try_get(0).map_err(query_err)?;
    let relkind: String = found.try_get(1).map_err(query_err)?;
    let reltuples: f64 = found.try_get(2).map_err(query_err)?;
    let rows = client
        .query(COLUMNS_SQL, &[&oid])
        .await
        .map_err(query_err)?;
    let mut columns = Vec::with_capacity(rows.len());
    let mut kinds = Vec::with_capacity(rows.len());
    let mut sortable = Vec::with_capacity(rows.len());
    let mut bases = Vec::with_capacity(rows.len());
    for row in &rows {
        columns.push(ColumnInfo {
            name: row.try_get(0).map_err(query_err)?,
            type_name: row.try_get(1).map_err(query_err)?,
            is_primary_key: row.try_get(2).map_err(query_err)?,
        });
        let kind: String = row.try_get(3).map_err(query_err)?;
        kinds.push(match kind.as_str() {
            "b" => ColumnKind::Bytes,
            "n" => ColumnKind::Number,
            _ => ColumnKind::Text,
        });
        sortable.push(row.try_get(4).map_err(query_err)?);
        bases.push(row.try_get(5).map_err(query_err)?);
    }
    Ok(Relation {
        relkind,
        reltuples,
        columns,
        kinds,
        sortable,
        bases,
    })
}

/// One `ORDER BY` term over the alias `t`. Qualified, so a bare name never resolves to a
/// same-named output column. A type with no ordering (json, xml, point) sorts by its text.
pub(super) fn order_term(rel: &Relation, column: &str, desc: bool) -> String {
    let dir = if desc { "DESC" } else { "ASC" };
    let i = rel
        .columns
        .iter()
        .position(|col| col.name == column)
        .expect("order_columns returns known columns");
    let cast = if rel.sortable[i] { "" } else { "::text" };
    format!("t.{}{cast} {dir}", quote_double(column))
}

/// Number columns and keys are selected whole. Every other column is cut to
/// the preview size in the SQL, plus its full byte length.
fn select_list(rel: &Relation) -> String {
    let mut list = Vec::new();
    for (c, kind) in rel.columns.iter().zip(&rel.kinds) {
        let q = quote_double(&c.name);
        match (kind, c.is_primary_key) {
            (ColumnKind::Bytes, true) => list.push(format!("encode({q}, 'hex')")),
            (ColumnKind::Number, _) | (ColumnKind::Text, true) => list.push(format!("{q}::text")),
            (ColumnKind::Text, false) => {
                list.push(format!("left({q}::text, {})", PREVIEW_CHARS + 1));
                list.push(format!("octet_length({q}::text)"));
            }
            (ColumnKind::Bytes, false) => {
                list.push(format!(
                    "encode(substring({q} from 1 for {PREVIEW_BYTES}), 'hex')"
                ));
                list.push(format!("octet_length({q})"));
            }
        }
    }
    list.join(", ")
}

fn total_of(text: Option<&str>) -> Result<u64> {
    text.unwrap_or("0")
        .parse()
        .map_err(|_| Error::Query("unexpected length from the server".into()))
}

/// Decodes up to `max` data rows of a `select_list` result; `has_more` is true when
/// the server sent more.
fn decode_rows(
    messages: &[SimpleQueryMessage],
    rel: &Relation,
    max: usize,
) -> Result<(Vec<Vec<Cell>>, bool)> {
    let mut rows = Vec::new();
    let mut has_more = false;
    for message in messages {
        let SimpleQueryMessage::Row(row) = message else {
            continue;
        };
        if rows.len() == max {
            has_more = true;
            break;
        }
        let mut idx = 0;
        let mut cells = Vec::with_capacity(rel.columns.len());
        for (c, kind) in rel.columns.iter().zip(&rel.kinds) {
            let value = row.try_get(idx).map_err(query_err)?;
            idx += 1;
            let cell = match (kind, c.is_primary_key) {
                (ColumnKind::Number, _) => value.map(|v| Cell::Number { value: v.into() }),
                (ColumnKind::Text, true) => value.map(|v| text_preview(v, v.len() as u64)),
                (ColumnKind::Bytes, true) => value.map(|hex| Cell::Bytes {
                    preview_hex: hex.into(),
                    truncated: false,
                    total_bytes: hex.len() as u64 / 2,
                }),
                (ColumnKind::Text, false) => {
                    let total = row.try_get(idx).map_err(query_err)?;
                    idx += 1;
                    match value {
                        Some(v) => Some(text_preview(v, total_of(total)?)),
                        None => None,
                    }
                }
                (ColumnKind::Bytes, false) => {
                    let total = row.try_get(idx).map_err(query_err)?;
                    idx += 1;
                    match value {
                        Some(hex) => {
                            let total_bytes = total_of(total)?;
                            Some(Cell::Bytes {
                                preview_hex: hex.into(),
                                truncated: total_bytes > PREVIEW_BYTES as u64,
                                total_bytes,
                            })
                        }
                        None => None,
                    }
                }
            };
            cells.push(cell.unwrap_or(Cell::Null));
        }
        rows.push(cells);
    }
    Ok((rows, has_more))
}

/// Step 11f: up to `limit` rows of one base table (`r` or `p`) on `client`, which the
/// caller has put in a read-only transaction with its timeout. The grid's select list
/// and cells; no ORDER BY, no OFFSET, no filter.
pub(super) async fn sample_rows(
    client: &impl GenericClient,
    path: &ObjectPath,
    limit: u32,
) -> Result<Page> {
    let schema = schema_of(path)?;
    let rel = relation(client, schema, &path.name).await?;
    if !matches!(rel.relkind.as_str(), "r" | "p") {
        return Err(Error::InvalidInput("not a table".into()));
    }
    let sql = format!(
        "SELECT {} FROM {} AS t LIMIT {limit}",
        select_list(&rel),
        qualified(schema, &path.name)
    );
    let messages = client.simple_query(&sql).await.map_err(query_err)?;
    let (rows, _) = decode_rows(&messages, &rel, limit as usize)?;
    Ok(Page {
        columns: rel.columns,
        rows,
        has_more: false,
    })
}

pub(super) async fn fetch_page(client: &Client, req: &PageRequest) -> Result<Page> {
    let schema = schema_of(&req.table)?;
    let rel = relation(client, schema, &req.table.name).await?;
    // Sort keys are qualified with the alias `t`: a bare name would resolve to
    // the `"id"::text` output column first and sort numbers as text. A type
    // with no ordering (json, xml, point) sorts by its text instead.
    let mut order: Vec<String> = order_columns(&rel.columns, req.sort.as_ref())?
        .into_iter()
        .map(|(c, desc)| order_term(&rel, &c, desc))
        .collect();
    if !rel.columns.iter().any(|c| c.is_primary_key) && rel.has_ctid() {
        order.push("t.tableoid ASC".into());
        order.push("t.ctid ASC".into());
    }
    let mut sql = format!(
        "SELECT {} FROM {} AS t",
        select_list(&rel),
        qualified(schema, &req.table.name)
    );
    sql.push_str(&req.where_sql());
    if !order.is_empty() {
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    let offset = u64::from(req.page) * u64::from(PAGE_SIZE);
    sql.push_str(&format!(" LIMIT {} OFFSET {offset}", PAGE_SIZE + 1));
    if req.has_filter() {
        // The simple protocol runs every statement it is given; preparing the
        // same text first refuses a filter that tries to add a second one.
        client.prepare(&sql).await.map_err(query_err)?;
    }

    let messages = client.simple_query(&sql).await.map_err(query_err)?;
    let (rows, has_more) = decode_rows(&messages, &rel, PAGE_SIZE as usize)?;
    Ok(Page {
        columns: rel.columns,
        rows,
        has_more,
    })
}

/// The key value as the text sent for `$n`.
fn key_text(cell: &Cell) -> Result<String> {
    match cell {
        Cell::Text {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated text value cannot identify a row".into(),
        )),
        Cell::Number { value } | Cell::Text { value, .. } => Ok(value.clone()),
        Cell::Bytes {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated binary value cannot identify a row".into(),
        )),
        Cell::Bytes { preview_hex, .. } => {
            decode_hex(preview_hex)?;
            Ok(preview_hex.clone())
        }
        Cell::Null => Err(Error::InvalidInput("key values must not be NULL".into())),
    }
}

pub(super) async fn fetch_full_value(client: &Client, req: &FullValueRequest) -> Result<FullValue> {
    let schema = schema_of(&req.table)?;
    let rel = relation(client, schema, &req.table.name).await?;
    let target = rel
        .columns
        .iter()
        .position(|c| c.name == req.column)
        .ok_or_else(|| Error::InvalidInput(format!("unknown column {}", req.column)))?;
    check_key(&rel.columns, &req.key)?;

    let mut parts = Vec::new();
    let mut params = Vec::new();
    for (n, part) in req.key.iter().enumerate() {
        let i = rel
            .columns
            .iter()
            .position(|c| c.name == part.column)
            .expect("checked above");
        let q = quote_double(&part.column);
        let n = n + 1;
        parts.push(if rel.kinds[i] == ColumnKind::Bytes {
            format!("{q} = decode(${n}, 'hex')")
        } else {
            format!("{q} = CAST(${n} AS {})", rel.columns[i].type_name)
        });
        params.push(key_text(&part.value)?);
    }
    let types = vec![Type::TEXT; params.len()];
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let from = qualified(schema, &req.table.name);
    let where_sql = parts.join(" AND ");
    let col = quote_double(&rel.columns[target].name);
    let is_bytes = rel.kinds[target] == ColumnKind::Bytes;

    let len_expr = if is_bytes {
        format!("octet_length({col})")
    } else {
        format!("octet_length({col}::text)")
    };
    let len_sql = format!("SELECT {len_expr} FROM {from} WHERE {where_sql}");
    let stmt = client
        .prepare_typed(&len_sql, &types)
        .await
        .map_err(query_err)?;
    let row = client
        .query_opt(&stmt, &params)
        .await
        .map_err(query_err)?
        .ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    let len: Option<i32> = row.try_get(0).map_err(query_err)?;
    let Some(len) = len else {
        return Ok(FullValue::Text {
            value: String::new(),
        });
    };
    let len = len as u64;
    if len > FULL_VALUE_LIMIT {
        return Err(Error::ValueTooLarge(len));
    }

    let select = if is_bytes {
        format!("{col}::bytea")
    } else {
        format!("{col}::text")
    };
    let sql = format!("SELECT {select} FROM {from} WHERE {where_sql}");
    let stmt = client
        .prepare_typed(&sql, &types)
        .await
        .map_err(query_err)?;
    let row = client
        .query_opt(&stmt, &params)
        .await
        .map_err(query_err)?
        .ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    Ok(if is_bytes {
        let bytes: Option<Vec<u8>> = row.try_get(0).map_err(query_err)?;
        FullValue::Bytes {
            base64: STANDARD.encode(bytes.unwrap_or_default()),
        }
    } else {
        let text: Option<String> = row.try_get(0).map_err(query_err)?;
        FullValue::Text {
            value: text.unwrap_or_default(),
        }
    })
}
