use std::collections::BTreeMap;

use mysql_async::Pool;
use mysql_async::prelude::Queryable;

use super::query_err;
use crate::error::Result;
use crate::schema_model::SmEndpoint;
use crate::sql_schema::{SqlColumn, SqlFk, SqlSchema, SqlTable, SqlTableKind};

fn endpoint(database: &str, table: String, column: String) -> SmEndpoint {
    SmEndpoint {
        schema: Some(database.to_string()),
        table,
        columns: vec![column],
    }
}

pub(crate) async fn sql_schema(pool: &Pool, database: &str) -> Result<SqlSchema> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let rows: Vec<(String, String, String, String, String)> = conn
        .exec(
            "SELECT CAST(c.TABLE_NAME AS CHAR), CAST(t.TABLE_TYPE AS CHAR), CAST(c.COLUMN_NAME AS CHAR), \
             CAST(c.COLUMN_TYPE AS CHAR), CAST(c.COLUMN_KEY AS CHAR) \
             FROM information_schema.COLUMNS c \
             JOIN information_schema.TABLES t \
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut tables: BTreeMap<String, SqlTable> = BTreeMap::new();
    for (table, table_type, name, type_name, key) in rows {
        let t = tables.entry(table.clone()).or_insert_with(|| SqlTable {
            schema: Some(database.to_string()),
            name: table,
            kind: if table_type == "VIEW" {
                SqlTableKind::View
            } else {
                SqlTableKind::Table
            },
            columns: Vec::new(),
        });
        t.columns.push(SqlColumn {
            name,
            type_name,
            pk: key == "PRI",
        });
    }

    let fk_rows: Vec<(String, String, String, String, String)> = conn
        .exec(
            "SELECT CAST(CONSTRAINT_NAME AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
             CAST(REFERENCED_TABLE_NAME AS CHAR), CAST(REFERENCED_COLUMN_NAME AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
               AND REFERENCED_TABLE_SCHEMA = TABLE_SCHEMA \
             ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
            (database,),
        )
        .await
        .map_err(query_err)?;
    // Rows of one constraint are adjacent, so a multi-column key folds into the last Foreign Key.
    let mut fks: Vec<((String, String), SqlFk)> = Vec::new();
    for (constraint, table, col, ref_table, ref_col) in fk_rows {
        let key = (table.clone(), constraint);
        match fks.last_mut() {
            Some((k, fk)) if *k == key => {
                fk.from.columns.push(col);
                fk.to.columns.push(ref_col);
            }
            _ => {
                let name = Some(key.1.clone());
                fks.push((
                    key,
                    SqlFk {
                        from: endpoint(database, table, col),
                        to: endpoint(database, ref_table, ref_col),
                        name,
                        // MySQL keeps no comment on a constraint.
                        comment: None,
                    },
                ))
            }
        }
    }

    Ok(SqlSchema {
        search_path: vec![database.to_string()],
        tables: tables.into_values().collect(),
        fks: fks.into_iter().map(|(_, fk)| fk).collect(),
    })
}
