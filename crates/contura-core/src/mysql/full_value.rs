use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mysql_async::Value;
use mysql_async::prelude::Queryable;

use super::link::Pool;

use super::page::{ColumnKind, ColumnMeta, table_column_meta};
use super::query_err;
use super::quote::quote_ident;
use crate::common::{check_key, decode_hex};
use crate::error::{Error, Result};
use crate::model::{Cell, ColumnInfo, FULL_VALUE_LIMIT, FullValue, FullValueRequest};

fn key_param(cell: &Cell) -> Result<Value> {
    match cell {
        Cell::Text {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated text value cannot identify a row".into(),
        )),
        Cell::Number { value } | Cell::Text { value, .. } => {
            Ok(Value::Bytes(value.clone().into_bytes()))
        }
        Cell::Bytes {
            truncated: true, ..
        } => Err(Error::InvalidInput(
            "a truncated binary value cannot identify a row".into(),
        )),
        Cell::Bytes { preview_hex, .. } => Ok(Value::Bytes(decode_hex(preview_hex)?)),
        Cell::Null => Err(Error::InvalidInput("key values must not be NULL".into())),
    }
}

/// The binary protocol sends numbers and dates as typed values, not bytes.
fn value_bytes(value: Value) -> Option<Vec<u8>> {
    let text = match value {
        Value::NULL => return None,
        Value::Bytes(bytes) => return Some(bytes),
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(n) => n.to_string(),
        Value::Double(n) => n.to_string(),
        Value::Date(y, mo, d, h, mi, s, us) => {
            let mut t = format!("{y:04}-{mo:02}-{d:02}");
            if (h, mi, s, us) != (0, 0, 0, 0) {
                t.push_str(&format!(" {h:02}:{mi:02}:{s:02}"));
            }
            if us != 0 {
                t.push_str(&format!(".{us:06}"));
            }
            t
        }
        Value::Time(negative, days, h, mi, s, us) => {
            let hours = u64::from(days) * 24 + u64::from(h);
            let mut t = format!(
                "{}{hours:02}:{mi:02}:{s:02}",
                if negative { "-" } else { "" }
            );
            if us != 0 {
                t.push_str(&format!(".{us:06}"));
            }
            t
        }
    };
    Some(text.into_bytes())
}

/// `WHERE` clause over the primary key; BIT keys arrive as decimal text, so they compare as `col + 0`.
fn key_clause(req: &FullValueRequest, cols: &[ColumnMeta]) -> Result<(String, Vec<Value>)> {
    let infos: Vec<ColumnInfo> = cols.iter().map(|c| c.info.clone()).collect();
    check_key(&infos, &req.key)?;
    let pk: Vec<&ColumnMeta> = cols.iter().filter(|c| c.info.is_primary_key).collect();
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for part in &req.key {
        let meta = pk
            .iter()
            .find(|c| c.info.name == part.column)
            .expect("checked above");
        let q = quote_ident(&meta.info.name);
        parts.push(if meta.kind == ColumnKind::Bit {
            format!("({q} + 0) = ?")
        } else {
            format!("{q} = ?")
        });
        params.push(key_param(&part.value)?);
    }
    Ok((parts.join(" AND "), params))
}

pub(crate) async fn fetch_full_value(pool: &Pool, req: &FullValueRequest) -> Result<FullValue> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let cols = table_column_meta(&mut conn, &req.table).await?;
    let target = cols
        .iter()
        .find(|c| c.info.name == req.column)
        .ok_or_else(|| Error::InvalidInput(format!("unknown column {}", req.column)))?;
    let (where_sql, params) = key_clause(req, &cols)?;
    let from = format!(
        "{}.{}",
        quote_ident(&req.table.database),
        quote_ident(&req.table.name)
    );
    let col = quote_ident(&target.info.name);

    let len_sql = format!("SELECT OCTET_LENGTH({col}) FROM {from} WHERE {where_sql}");
    let row: Option<Option<u64>> = conn
        .exec_first(len_sql, params.clone())
        .await
        .map_err(query_err)?;
    let len = row.ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    let Some(len) = len else {
        return Ok(FullValue::Text {
            value: String::new(),
        });
    };
    if len > FULL_VALUE_LIMIT {
        return Err(Error::ValueTooLarge(len));
    }

    let select = if target.kind == ColumnKind::Bit {
        format!("{col} + 0")
    } else {
        col
    };
    let sql = format!("SELECT {select} FROM {from} WHERE {where_sql}");
    let row: Option<Value> = conn.exec_first(sql, params).await.map_err(query_err)?;
    let value = row.ok_or_else(|| Error::NotFound("row no longer exists".into()))?;
    let bytes = value_bytes(value).unwrap_or_default();
    Ok(match target.kind {
        ColumnKind::Bytes => FullValue::Bytes {
            base64: STANDARD.encode(&bytes),
        },
        _ => FullValue::Text {
            value: String::from_utf8_lossy(&bytes).into_owned(),
        },
    })
}
