use std::collections::BTreeMap;

use mysql_async::Pool;
use mysql_async::prelude::Queryable;

use super::query_err;
use crate::error::Result;
use crate::model::DialectKind;
use crate::schema_model::{
    SchemaModel, SmColumn, SmEndpoint, SmIndex, SmRef, SmTable, classify_default,
};

const NUMERIC_TYPES: &[&str] = &[
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "float",
    "double",
    "bit",
];

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// Auto-generated InnoDB constraint names (`orders_ibfk_1`) carry no meaning.
fn ref_name(name: String, table: &str) -> Option<String> {
    let auto = name
        .strip_prefix(&format!("{table}_ibfk_"))
        .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()));
    (!auto).then_some(name)
}

/// InnoDB treats RESTRICT and NO ACTION alike, and both are the default.
fn rule(r: String) -> Option<String> {
    (r != "NO ACTION" && r != "RESTRICT").then_some(r)
}

pub(crate) async fn schema_snapshot(pool: &Pool, database: &str) -> Result<SchemaModel> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    let mut skipped = Vec::new();

    let tables: Vec<(String, String, String)> = conn
        .exec(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(TABLE_TYPE AS CHAR), CAST(TABLE_COMMENT AS CHAR) \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut by_name: BTreeMap<String, SmTable> = BTreeMap::new();
    let mut order = Vec::new();
    for (name, kind, comment) in tables {
        if kind == "BASE TABLE" {
            order.push(name.clone());
            by_name.insert(
                name.clone(),
                SmTable {
                    schema: None,
                    name,
                    alias: None,
                    note: non_empty(comment),
                    columns: Vec::new(),
                    indexes: Vec::new(),
                },
            );
        } else {
            skipped.push(format!("view {name}"));
        }
    }

    type ColRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
    );
    let columns: Vec<ColRow> = conn
        .exec(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), \
             CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR), \
             CAST(COLUMN_COMMENT AS CHAR), CAST(DATA_TYPE AS CHAR), CAST(GENERATION_EXPRESSION AS CHAR) \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            (database,),
        )
        .await
        .map_err(query_err)?;
    for (table, name, type_name, nullable, default, extra, comment, data_type, generation) in
        columns
    {
        let Some(t) = by_name.get_mut(&table) else {
            continue;
        };
        let extra_l = extra.to_ascii_lowercase();
        let expression_default = extra_l.contains("default_generated");
        let generated = extra_l.contains("generated") && !expression_default;
        let mut note = non_empty(comment);
        if generated {
            skipped.push(format!("generated column {table}.{name}"));
            note = Some(format!("generated: {generation}"));
        }
        let default = default.map(|d| {
            if expression_default {
                classify_default(&d, false)
            } else {
                let numeric = NUMERIC_TYPES.contains(&data_type.to_ascii_lowercase().as_str());
                classify_default(&d, !numeric)
            }
        });
        t.columns.push(SmColumn {
            name,
            type_name,
            pk: false,
            increment: extra_l.contains("auto_increment"),
            not_null: nullable == "NO",
            unique: false,
            default,
            note,
        });
    }

    let stats: Vec<(String, String, i64, String)> = conn
        .exec(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(INDEX_NAME AS CHAR), NON_UNIQUE, CAST(COLUMN_NAME AS CHAR) \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut grouped: BTreeMap<(String, String), (bool, Vec<String>)> = BTreeMap::new();
    for (table, index, non_unique, column) in stats {
        grouped
            .entry((table, index))
            .or_insert((non_unique == 0, Vec::new()))
            .1
            .push(column);
    }
    for ((table, index), (unique, cols)) in grouped {
        let Some(t) = by_name.get_mut(&table) else {
            continue;
        };
        let primary = index == "PRIMARY";
        if cols.len() == 1 && (primary || unique) {
            if let Some(c) = t.columns.iter_mut().find(|c| c.name == cols[0]) {
                if primary {
                    c.pk = true;
                } else {
                    c.unique = true;
                }
            }
            continue;
        }
        t.indexes.push(SmIndex {
            name: (!primary).then_some(index),
            columns: cols,
            unique: unique || primary,
            pk: primary,
        });
    }

    type RefRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    let ref_rows: Vec<RefRow> = conn
        .exec(
            "SELECT CAST(k.CONSTRAINT_NAME AS CHAR), CAST(k.TABLE_NAME AS CHAR), CAST(k.COLUMN_NAME AS CHAR), \
             CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), \
             CAST(k.REFERENCED_COLUMN_NAME AS CHAR), CAST(r.DELETE_RULE AS CHAR), CAST(r.UPDATE_RULE AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
              AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            (database,),
        )
        .await
        .map_err(query_err)?;
    let mut refs: Vec<(String, String, SmRef)> = Vec::new();
    for (constraint, table, column, ref_schema, ref_table, ref_column, on_delete, on_update) in
        ref_rows
    {
        if let Some((t, c, r)) = refs.last_mut()
            && *t == table
            && *c == constraint
        {
            r.from.columns.push(column);
            r.to.columns.push(ref_column);
            continue;
        }
        let name = ref_name(constraint.clone(), &table);
        refs.push((
            table.clone(),
            constraint,
            SmRef {
                name,
                from: SmEndpoint {
                    schema: None,
                    table,
                    columns: vec![column],
                },
                to: SmEndpoint {
                    schema: (ref_schema != database).then_some(ref_schema),
                    table: ref_table,
                    columns: vec![ref_column],
                },
                on_delete: rule(on_delete),
                on_update: rule(on_update),
            },
        ));
    }

    let routines: Vec<(String, String)> = conn
        .exec(
            "SELECT CAST(ROUTINE_TYPE AS CHAR), CAST(ROUTINE_NAME AS CHAR) FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            (database,),
        )
        .await
        .map_err(query_err)?;
    skipped.extend(
        routines
            .into_iter()
            .map(|(kind, name)| format!("{} {name}", kind.to_ascii_lowercase())),
    );
    let triggers: Vec<String> = conn
        .exec(
            "SELECT CAST(TRIGGER_NAME AS CHAR) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? \
             ORDER BY TRIGGER_NAME",
            (database,),
        )
        .await
        .map_err(query_err)?;
    skipped.extend(triggers.into_iter().map(|n| format!("trigger {n}")));
    let checks: Vec<String> = conn
        .exec(
            "SELECT CAST(CONSTRAINT_NAME AS CHAR) FROM information_schema.CHECK_CONSTRAINTS \
             WHERE CONSTRAINT_SCHEMA = ? ORDER BY CONSTRAINT_NAME",
            (database,),
        )
        .await
        .map_err(query_err)?;
    skipped.extend(checks.into_iter().map(|n| format!("check constraint {n}")));

    let tables = order
        .into_iter()
        .filter_map(|n| by_name.remove(&n))
        .collect();
    Ok(SchemaModel {
        dialect: DialectKind::MySql,
        tables,
        refs: refs.into_iter().map(|(_, _, r)| r).collect(),
        enums: Vec::new(),
        skipped,
    })
}
