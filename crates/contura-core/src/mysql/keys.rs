//! Lineage's catalog reads (B2, P6): every Foreign Key touching one database in one
//! query, and the light column read of the tables lineage reached.

use mysql_async::Pool;
use mysql_async::prelude::Queryable;

use super::query_err;
use super::snapshot::rule;
use crate::error::Result;
use crate::lineage::{KeyColumn, KeyEdge, KeyTable};
use crate::model::ObjectPath;

fn path(database: String, name: String) -> ObjectPath {
    ObjectPath {
        database,
        schema: None,
        name,
    }
}

/// Every Foreign Key held by a table of `database` or pointing into it, in key order.
pub(super) async fn key_edges(pool: &Pool, database: &str) -> Result<Vec<KeyEdge>> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    let rows: Vec<Row> = conn
        .exec(
            "SELECT CAST(k.CONSTRAINT_NAME AS CHAR), CAST(k.TABLE_SCHEMA AS CHAR), \
             CAST(k.TABLE_NAME AS CHAR), CAST(k.COLUMN_NAME AS CHAR), \
             CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), \
             CAST(k.REFERENCED_COLUMN_NAME AS CHAR), CAST(r.DELETE_RULE AS CHAR), \
             CAST(r.UPDATE_RULE AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
              AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE (k.TABLE_SCHEMA = ? OR k.REFERENCED_TABLE_SCHEMA = ?) \
               AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            (database, database),
        )
        .await
        .map_err(query_err)?;
    let mut out: Vec<KeyEdge> = Vec::new();
    for (name, schema, table, column, ref_schema, ref_table, ref_column, on_delete, on_update) in
        rows
    {
        if let Some(last) = out.last_mut()
            && last.name == name
            && last.from.database == schema
            && last.from.name == table
        {
            last.from_columns.push(column);
            last.to_columns.push(ref_column);
            continue;
        }
        out.push(KeyEdge {
            name,
            from: path(schema, table),
            from_columns: vec![column],
            to: path(ref_schema, ref_table),
            to_columns: vec![ref_column],
            on_delete: rule(on_delete),
            on_update: rule(on_update),
        });
    }
    Ok(out)
}

/// The columns of the base tables among `tables` in `database`, in table order, with
/// their primary key part. A table that is not there is left out.
pub(super) async fn key_tables(
    pool: &Pool,
    database: &str,
    tables: &[String],
) -> Result<Vec<KeyTable>> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let marks = vec!["?"; tables.len()].join(", ");
    let sql = format!(
        "SELECT CAST(c.TABLE_NAME AS CHAR), CAST(c.COLUMN_NAME AS CHAR), \
         CAST(c.COLUMN_TYPE AS CHAR), CAST(c.IS_NULLABLE AS CHAR), \
         EXISTS (SELECT 1 FROM information_schema.STATISTICS s \
                 WHERE s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME \
                   AND s.INDEX_NAME = 'PRIMARY' AND s.COLUMN_NAME = c.COLUMN_NAME) \
         FROM information_schema.COLUMNS c \
         JOIN information_schema.TABLES t \
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
          AND t.TABLE_TYPE = 'BASE TABLE' \
         WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME IN ({marks}) \
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
    );
    let mut params: Vec<mysql_async::Value> = vec![database.into()];
    params.extend(tables.iter().map(|t| t.as_str().into()));
    let rows: Vec<(String, String, String, String, i64)> =
        conn.exec(sql, params).await.map_err(query_err)?;
    let mut out: Vec<KeyTable> = Vec::new();
    for (table, name, ty, nullable, pk) in rows {
        let column = KeyColumn {
            name,
            ty,
            nullable: nullable == "YES",
            pk: pk != 0,
        };
        match out.last_mut() {
            Some(last) if last.path.name == table => last.columns.push(column),
            _ => out.push(KeyTable {
                path: path(database.to_string(), table),
                columns: vec![column],
            }),
        }
    }
    Ok(out)
}

/// MySQL keeps `information_schema.VIEW_TABLE_USAGE` from 8.0.13; MariaDB and older MySQL
/// servers do not.
pub(super) fn has_view_table_usage(version: &str) -> bool {
    if version.to_ascii_lowercase().contains("mariadb") {
        return false;
    }
    let mut parts = version
        .split(|c: char| !c.is_ascii_digit())
        .take(3)
        .map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor, patch) = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    (major, minor, patch) >= (8, 0, 13)
}

/// The views that read `table`, from `VIEW_TABLE_USAGE`, at most `limit`; `None` on a
/// server without that table.
pub(super) async fn view_dependencies(
    pool: &Pool,
    table: &ObjectPath,
    limit: usize,
) -> Result<Option<Vec<ObjectPath>>> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let version: Option<String> = conn
        .query_first("SELECT VERSION()")
        .await
        .map_err(query_err)?;
    if !version.as_deref().is_some_and(has_view_table_usage) {
        return Ok(None);
    }
    let rows: Vec<(String, String)> = conn
        .exec(
            "SELECT DISTINCT CAST(VIEW_SCHEMA AS CHAR), CAST(VIEW_NAME AS CHAR) \
             FROM information_schema.VIEW_TABLE_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY 1, 2 LIMIT ?",
            (
                table.database.as_str(),
                table.name.as_str(),
                u64::try_from(limit).unwrap_or(u64::MAX),
            ),
        )
        .await
        .map_err(query_err)?;
    Ok(Some(
        rows.into_iter()
            .map(|(database, name)| path(database, name))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::has_view_table_usage;

    #[test]
    fn view_table_usage_from_8_0_13() {
        assert!(has_view_table_usage("8.0.30"));
        assert!(has_view_table_usage("8.0.13"));
        assert!(has_view_table_usage("8.4.0-log"));
        assert!(has_view_table_usage("9.1.0"));
        assert!(!has_view_table_usage("8.0.12"));
        assert!(!has_view_table_usage("5.7.44-log"));
        assert!(!has_view_table_usage("10.11.6-MariaDB"));
        assert!(!has_view_table_usage("11.4.2-MariaDB-ubu2404"));
        assert!(!has_view_table_usage(""));
    }
}
