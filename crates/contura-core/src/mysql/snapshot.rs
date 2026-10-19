use std::collections::BTreeMap;

use mysql_async::Pool;
use mysql_async::prelude::Queryable;

use super::query_err;
use crate::design::{
    IncomingRef, Increment, MySqlColumn, TableColumn, TableDesign, TableForeignKey, TableIndex,
    add_attribute, advanced_note,
};
use crate::error::{Error, Result};
use crate::model::{DialectKind, ObjectPath};
use crate::schema_model::{
    SchemaModel, SmColumn, SmDefault, SmEndpoint, SmIndex, SmRef, SmTable, classify_default,
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
pub(super) fn rule(r: String) -> Option<String> {
    (r != "NO ACTION" && r != "RESTRICT").then_some(r)
}

/// `COLUMN_DEFAULT` is not SQL: literals come unquoted, so the column's type decides.
fn typed_default(raw: &str, expression_default: bool, data_type: &str) -> SmDefault {
    if expression_default {
        classify_default(raw, false)
    } else {
        let numeric = NUMERIC_TYPES.contains(&data_type.to_ascii_lowercase().as_str());
        classify_default(raw, !numeric)
    }
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
        let default = default.map(|d| typed_default(&d, expression_default, &data_type));
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

/// Every column line of `SHOW CREATE TABLE`, with what a MySQL restatement of it would lose: the version comments
/// `SHOW CREATE TABLE` writes for INVISIBLE, SRID, COLUMN_FORMAT, STORAGE and
/// ENGINE_ATTRIBUTE, such as `/*!80023 INVISIBLE */`.
fn column_attributes(create_sql: &str) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for line in create_sql.lines() {
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        // The name is quoted with backquotes, with double quotes under
        // ANSI_QUOTES (a doubled quote stands for one), or bare when
        // sql_quote_show_create is off. Key and constraint lines are skipped.
        let quote = rest.chars().next().filter(|c| *c == '`' || *c == '"');
        let mut name = String::new();
        let mut after = None;
        match quote {
            Some(q) => {
                let mut chars = rest.char_indices().skip(1).peekable();
                while let Some((at, c)) = chars.next() {
                    if c == q {
                        if chars.peek().map(|(_, n)| *n) == Some(q) {
                            chars.next();
                        } else {
                            after = Some(at + 1);
                            break;
                        }
                    }
                    name.push(c);
                }
            }
            None => {
                let word: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
                const NOT_COLUMNS: [&str; 8] = [
                    "PRIMARY",
                    "KEY",
                    "UNIQUE",
                    "INDEX",
                    "CONSTRAINT",
                    "FULLTEXT",
                    "SPATIAL",
                    "CHECK",
                ];
                if word.is_empty() || word.starts_with(')') || NOT_COLUMNS.contains(&word.as_str())
                {
                    continue;
                }
                after = Some(word.len());
                name = word;
            }
        }
        let Some(after) = after else { continue };
        let mut attrs = Vec::new();
        for (at, _) in rest[after..].match_indices("/*!") {
            let tail = &rest[after + at + 3..];
            let word: String = tail
                .trim_start_matches(|c: char| c.is_ascii_digit())
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
                .collect();
            let attribute = match word.as_str() {
                "INVISIBLE" => "invisible",
                "SRID" => "srid",
                "COLUMN_FORMAT" => "column format",
                "STORAGE" => "storage",
                "ENGINE_ATTRIBUTE" | "SECONDARY_ENGINE_ATTRIBUTE" => "engine attribute",
                _ => continue,
            };
            add_attribute(&mut attrs, attribute);
        }
        out.insert(name, attrs);
    }
    out
}

/// The text after `on update ` in `EXTRA`, such as `CURRENT_TIMESTAMP`.
fn on_update(extra: &str) -> Option<String> {
    const KEY: &str = "on update ";
    let at = extra.to_ascii_lowercase().find(KEY)?;
    non_empty(extra[at + KEY.len()..].trim().to_string())
}

/// One table for the Table Designer: the snapshot's queries, filtered by table, with
/// real index and key names and nothing folded into columns.
pub(crate) async fn table_design(pool: &Pool, path: &ObjectPath) -> Result<TableDesign> {
    let mut conn = pool.get_conn().await.map_err(query_err)?;
    table_design_on(&mut conn, path).await
}

/// `table_design` on a given connection, whatever its session settings.
pub(crate) async fn table_design_on(
    conn: &mut mysql_async::Conn,
    path: &ObjectPath,
) -> Result<TableDesign> {
    let (database, table) = (path.database.as_str(), path.name.as_str());

    let found: Option<(String, String, Option<String>)> = conn
        .exec_first(
            "SELECT CAST(TABLE_TYPE AS CHAR), CAST(TABLE_COMMENT AS CHAR), \
             CAST(TABLE_COLLATION AS CHAR) \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let (comment, table_collation) = match found {
        Some((kind, comment, collation)) if kind == "BASE TABLE" => (non_empty(comment), collation),
        _ => return Err(Error::NotFound(table.to_string())),
    };
    let mut unsupported = Vec::new();

    type ColRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<ColRow> = conn
        .exec(
            "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE AS CHAR), \
             CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR), CAST(COLUMN_COMMENT AS CHAR), \
             CAST(DATA_TYPE AS CHAR), CAST(CHARACTER_SET_NAME AS CHAR), CAST(COLLATION_NAME AS CHAR) \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let mut columns = Vec::with_capacity(rows.len());
    for (name, type_sql, nullable, default, extra, comment, data_type, charset, collation) in rows {
        let extra_l = extra.to_ascii_lowercase();
        let expression_default = extra_l.contains("default_generated");
        let generated = extra_l.contains("generated") && !expression_default;
        if generated {
            unsupported.push(format!("generated column {name}"));
        }
        let default_sql = default.filter(|_| !generated).map(|d| {
            crate::ddl::default_sql(
                DialectKind::MySql,
                &typed_default(&d, expression_default, &data_type),
            )
        });
        columns.push(TableColumn {
            name,
            type_sql,
            nullable: nullable == "YES",
            default_sql,
            increment: if extra_l.contains("auto_increment") {
                Increment::AutoIncrement
            } else {
                Increment::None
            },
            comment: non_empty(comment),
            generated,
            // Only a collation other than the table's is the column's own.
            collation: collation
                .clone()
                .filter(|c| Some(c) != table_collation.as_ref()),
            advanced: false,
            identity_always: false,
            mysql: Some(MySqlColumn {
                charset,
                collation,
                on_update: on_update(&extra),
            }),
            sqlite_autoincrement: false,
        });
    }

    type StatRow = (
        String,
        i64,
        Option<String>,
        Option<String>,
        String,
        Option<i64>,
        Option<String>,
    );
    let stats: Vec<StatRow> = conn
        .exec(
            "SELECT CAST(INDEX_NAME AS CHAR), NON_UNIQUE, CAST(COLUMN_NAME AS CHAR), \
             CAST(EXPRESSION AS CHAR), CAST(INDEX_TYPE AS CHAR), SUB_PART, CAST(COLLATION AS CHAR) \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let mut indexes: Vec<TableIndex> = Vec::new();
    // What each index has that the model does not carry, by position in `indexes`.
    let mut index_attrs: Vec<Vec<String>> = Vec::new();
    for (name, non_unique, column, expression, index_type, sub_part, collation) in stats {
        let (part, is_expression) = match column {
            Some(c) => (c, false),
            None => (expression.unwrap_or_default(), true),
        };
        let mut attrs = Vec::new();
        if sub_part.is_some() {
            add_attribute(&mut attrs, "prefix length");
        }
        if collation.as_deref() == Some("D") {
            add_attribute(&mut attrs, "descending order");
        }
        match index_type.as_str() {
            "FULLTEXT" => add_attribute(&mut attrs, "fulltext"),
            "SPATIAL" => add_attribute(&mut attrs, "spatial"),
            _ => {}
        }
        if let Some(last) = indexes.last_mut()
            && last.name == name
        {
            last.columns.push(part);
            last.expression |= is_expression;
            let all = index_attrs.last_mut().expect("one list per index");
            for a in attrs {
                add_attribute(all, &a);
            }
            continue;
        }
        index_attrs.push(attrs);
        indexes.push(TableIndex {
            primary: name == "PRIMARY",
            name,
            columns: vec![part],
            unique: non_unique == 0,
            constraint: false,
            sql: None,
            method: Some(index_type.to_ascii_lowercase()),
            predicate: None,
            expression: is_expression,
            advanced: false,
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
            "SELECT CAST(k.CONSTRAINT_NAME AS CHAR), CAST(k.COLUMN_NAME AS CHAR), \
             CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), \
             CAST(k.REFERENCED_COLUMN_NAME AS CHAR), CAST(r.DELETE_RULE AS CHAR), CAST(r.UPDATE_RULE AS CHAR), \
             CAST(r.MATCH_OPTION AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
              AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let mut foreign_keys: Vec<TableForeignKey> = Vec::new();
    // InnoDB has no DEFERRABLE, and it reports MATCH as NONE, so this rarely fires.
    let mut fk_attrs: Vec<Vec<String>> = Vec::new();
    for (name, column, ref_schema, ref_table, ref_column, on_delete, on_update, match_option) in
        ref_rows
    {
        if let Some(last) = foreign_keys.last_mut()
            && last.name == name
        {
            last.columns.push(column);
            last.target_columns.push(ref_column);
            continue;
        }
        foreign_keys.push(TableForeignKey {
            name,
            columns: vec![column],
            target: ObjectPath {
                database: ref_schema,
                schema: None,
                name: ref_table,
            },
            target_columns: vec![ref_column],
            on_delete: rule(on_delete),
            on_update: rule(on_update),
            advanced: false,
        });
        fk_attrs.push(match match_option.as_str() {
            "NONE" | "SIMPLE" | "" => Vec::new(),
            m => vec![format!("match {}", m.to_ascii_lowercase())],
        });
    }

    let incoming: Vec<(String, String, String)> = conn
        .exec(
            "SELECT DISTINCT CAST(CONSTRAINT_NAME AS CHAR), CAST(TABLE_SCHEMA AS CHAR), \
             CAST(TABLE_NAME AS CHAR) FROM information_schema.KEY_COLUMN_USAGE \
             WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? \
             ORDER BY 2, 3, 1",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    let referenced_by = incoming
        .into_iter()
        .map(|(name, schema, from)| IncomingRef {
            name,
            table: ObjectPath {
                database: schema,
                schema: None,
                name: from,
            },
            on_delete: None,
        })
        .collect();

    let checks: Vec<String> = conn
        .exec(
            "SELECT CAST(CONSTRAINT_NAME AS CHAR) FROM information_schema.TABLE_CONSTRAINTS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' \
             ORDER BY CONSTRAINT_NAME",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    unsupported.extend(checks.into_iter().map(|n| format!("check {n}")));
    let triggers: Vec<String> = conn
        .exec(
            "SELECT CAST(TRIGGER_NAME AS CHAR) FROM information_schema.TRIGGERS \
             WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME",
            (database, table),
        )
        .await
        .map_err(query_err)?;
    unsupported.extend(triggers.into_iter().map(|n| format!("trigger {n}")));
    for (index, attrs) in indexes.iter_mut().zip(&index_attrs) {
        if !attrs.is_empty() {
            index.advanced = true;
            unsupported.push(advanced_note("index", &index.name, attrs));
        }
    }
    for (key, attrs) in foreign_keys.iter_mut().zip(&fk_attrs) {
        if !attrs.is_empty() {
            key.advanced = true;
            unsupported.push(advanced_note("foreign key", &key.name, attrs));
        }
    }
    // Column attributes information_schema does not show in every version
    // (SRID, COLUMN_FORMAT, STORAGE, ENGINE_ATTRIBUTE) come from SHOW CREATE TABLE.
    let create: Option<(String, String)> = conn
        .query_first(format!(
            "SHOW CREATE TABLE {}.{}",
            super::quote::quote_ident(database),
            super::quote::quote_ident(table)
        ))
        .await
        .map_err(query_err)?;
    let column_attrs = create
        .map(|(_, sql)| column_attributes(&sql))
        .unwrap_or_default();
    // A column whose line was not read counts as advanced: fail safe.
    let unread = vec!["definition not read".to_string()];
    for column in &mut columns {
        let attrs = column_attrs.get(&column.name).unwrap_or(&unread);
        if !attrs.is_empty() {
            column.advanced = true;
            unsupported.push(advanced_note("column", &column.name, attrs));
        }
    }

    Ok(TableDesign {
        path: path.clone(),
        columns,
        indexes,
        foreign_keys,
        referenced_by,
        comment,
        unsupported,
        sqlite: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_column_attributes_a_restatement_would_lose() {
        let sql = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `h` int DEFAULT NULL /*!80023 INVISIBLE */ COMMENT 'x',\n  `g` point NOT NULL /*!80003 SRID 4326 */,\n  `f` int /*!50606 COLUMN_FORMAT FIXED */ /*!50606 STORAGE DISK */ DEFAULT NULL,\n  `we``ird` int /*!80021 ENGINE_ATTRIBUTE '{}' */,\n  `n` varchar(9) DEFAULT 'INVISIBLE',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
        let attrs = column_attributes(sql);
        let get = |n: &str| attrs.get(n).cloned().unwrap_or_default();
        assert_eq!(get("h"), ["invisible"]);
        assert_eq!(get("g"), ["srid"]);
        assert_eq!(get("f"), ["column format", "storage"]);
        assert_eq!(get("we`ird"), ["engine attribute"]);
        assert!(get("id").is_empty() && get("n").is_empty());
        // Every column line is read, key lines are not.
        assert_eq!(attrs.len(), 6);
    }

    #[test]
    fn reads_double_quoted_and_bare_names() {
        let ansi = "CREATE TABLE \"t\" (
  \"id\" int,
  \"a\"\"b\" int DEFAULT NULL /*!80023 INVISIBLE */,
  PRIMARY KEY (\"id\")
)";
        let attrs = column_attributes(ansi);
        assert_eq!(
            attrs.get("a\"b").cloned().unwrap_or_default(),
            ["invisible"]
        );
        assert!(attrs["id"].is_empty());
        assert_eq!(attrs.len(), 2);
        let bare = "CREATE TABLE t (
  id int,
  h int DEFAULT NULL /*!80023 INVISIBLE */,
  PRIMARY KEY (id),
  UNIQUE KEY u (h),
  CONSTRAINT c FOREIGN KEY (h) REFERENCES p (id)
)";
        let attrs = column_attributes(bare);
        assert_eq!(attrs["h"], ["invisible"]);
        assert_eq!(attrs.len(), 2);
    }
}
