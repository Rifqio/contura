//! MySQL ALTER TABLE plans: one statement, split only where MySQL refuses the mix (D4).

use super::model::MySqlColumn;
use super::plan::{
    Alter, ColumnChange, DesignMode, DesignPlan, checked_action, fk_target, invalid,
    kept_attributes,
};
use crate::common::sql_ident;
use crate::ddl::{ColumnSql, FkSql, column_sql, foreign_key_sql, idents, lit};
use crate::error::Result;
use crate::model::DialectKind;

const MY: DialectKind = DialectKind::MySql;

/// The column restated in full (D2), keeping its character set, collation and
/// `ON UPDATE` (S4) unless its new type cannot hold them.
fn full_definition(ch: &ColumnChange) -> String {
    let (text, temporal) = kept_attributes(MY, &ch.base, &ch.column.type_sql, ch.type_change);
    let mysql = ch.base.mysql.as_ref().map(|m| MySqlColumn {
        charset: m.charset.clone().filter(|_| text),
        collation: m.collation.clone().filter(|_| text),
        on_update: m.on_update.clone().filter(|_| temporal),
    });
    column_sql(
        MY,
        &ColumnSql {
            name: ch.column.name.clone(),
            type_sql: ch.column.type_sql.clone(),
            nullable: ch.column.nullable,
            default_sql: ch.column.default_sql.clone(),
            increment: ch.column.increment,
            sqlite_autoincrement: false,
            primary_inline: false,
            unique_inline: false,
            comment: ch.column.comment.clone(),
            mysql,
            collation: ch.base.collation.clone().filter(|_| text),
            explicit_null: true,
        },
    )
}

/// One `ALTER TABLE` with the clauses in the set order. When Foreign Keys are
/// dropped and a key is added, or an index under a dropped key is dropped, MySQL
/// refuses the mix, so the key drops run first on their own (D4).
pub(super) fn plan(a: &Alter) -> Result<DesignPlan> {
    let q = |name: &str| sql_ident(MY, name);
    let key_drops: Vec<String> = a
        .dropped_keys
        .iter()
        .map(|k| format!("DROP FOREIGN KEY {}", q(&k.name)))
        .collect();
    let mut rest = Vec::new();
    for i in &a.dropped_indexes {
        rest.push(if i.primary {
            "DROP PRIMARY KEY".to_string()
        } else {
            format!("DROP INDEX {}", q(&i.name))
        });
    }
    for c in &a.dropped_columns {
        rest.push(format!("DROP COLUMN {}", q(&c.name)));
    }
    // Clauses run in order and name columns by their new names, so renames,
    // changes and moves go in the edited column order.
    for ch in &a.changes {
        let position = ch
            .placement
            .as_ref()
            .map(|p| format!(" {}", p.sql(MY)))
            .unwrap_or_default();
        let restated = ch.definition_changed() || ch.comment || ch.placement.is_some();
        rest.push(match (ch.renamed, restated) {
            (true, false) => format!(
                "RENAME COLUMN {} TO {}",
                q(&ch.base.name),
                q(&ch.column.name)
            ),
            (true, true) => format!(
                "CHANGE COLUMN {} {}{position}",
                q(&ch.base.name),
                full_definition(ch)
            ),
            (false, _) => format!("MODIFY COLUMN {}{position}", full_definition(ch)),
        });
    }
    for n in &a.added_columns {
        let c = &n.column;
        let position = n
            .placement
            .as_ref()
            .map(|p| format!(" {}", p.sql(MY)))
            .unwrap_or_default();
        let def = column_sql(
            MY,
            &ColumnSql {
                name: c.name.clone(),
                type_sql: c.type_sql.clone(),
                nullable: c.nullable,
                default_sql: c.default_sql.clone(),
                increment: c.increment,
                sqlite_autoincrement: false,
                primary_inline: false,
                unique_inline: false,
                comment: c.comment.clone(),
                mysql: None,
                collation: None,
                explicit_null: false,
            },
        );
        rest.push(format!("ADD COLUMN {def}{position}"));
    }
    for (i, to) in &a.renamed_indexes {
        if i.primary {
            return Err(invalid("MySQL names every primary key PRIMARY."));
        }
        rest.push(format!("RENAME INDEX {} TO {}", q(&i.name), q(to)));
    }
    for i in &a.added_indexes {
        let columns = idents(MY, &i.columns);
        rest.push(match (i.primary, i.unique) {
            (true, _) => format!("ADD PRIMARY KEY ({columns})"),
            (false, true) => format!("ADD UNIQUE INDEX {} ({columns})", q(&i.name)),
            (false, false) => format!("ADD INDEX {} ({columns})", q(&i.name)),
        });
    }
    for k in &a.added_keys {
        let fk = foreign_key_sql(
            MY,
            &FkSql {
                name: (!k.name.trim().is_empty()).then(|| k.name.clone()),
                columns: k.columns.clone(),
                target: fk_target(MY, &a.path, &k.target)?,
                target_columns: k.target_columns.clone(),
                on_delete: checked_action(&k.on_delete)?,
                on_update: checked_action(&k.on_update)?,
            },
        );
        rest.push(format!("ADD {fk}"));
    }
    if let Some(comment) = &a.comment {
        rest.push(format!(
            "COMMENT = {}",
            lit(MY, comment.as_deref().unwrap_or(""))
        ));
    }

    let split = !key_drops.is_empty()
        && (!a.added_keys.is_empty()
            || a.dropped_indexes.iter().any(|i| {
                a.dropped_keys
                    .iter()
                    .any(|k| i.columns.starts_with(&k.columns))
            }));
    let statement =
        |clauses: &[String]| format!("ALTER TABLE {}\n  {}", a.table, clauses.join(",\n  "));
    let statements: Vec<String> = if split {
        vec![statement(&key_drops), statement(&rest)]
    } else {
        let all: Vec<String> = key_drops.into_iter().chain(rest).collect();
        if all.is_empty() {
            Vec::new()
        } else {
            vec![statement(&all)]
        }
    };
    Ok(DesignPlan {
        mode: if statements.len() > 1 {
            DesignMode::Sequential
        } else {
            DesignMode::Atomic
        },
        statements,
        warnings: a.warnings.clone(),
        before: 0,
        after: 0,
        checks: vec![],
        foreign_keys: None,
        loaded: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::model::{MySqlColumn, TableColumn};
    use crate::design::plan::fixtures::*;
    use crate::design::plan::{DesignEdit, Position};
    use crate::design::warning::{DesignWarning, Rule};
    use crate::model::DialectKind;

    const MY: DialectKind = DialectKind::MySql;

    fn one(plan: &DesignPlan) -> &str {
        assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
        assert_eq!(plan.mode, DesignMode::Atomic);
        &plan.statements[0]
    }

    #[test]
    fn merges_into_one_alter() {
        let base = orders(MY);
        let plan = alter(
            MY,
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "email".into(),
                },
                DesignEdit::AddColumn {
                    column: new_column("customer_id", "int"),
                    position: Position::After {
                        column: "status".into(),
                    },
                },
                change(&base, "total", |c| c.type_sql = "decimal(12,2)".into()),
                DesignEdit::AddForeignKey {
                    key: key_draft(MY, "orders_customer_fk", "customer_id"),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  DROP INDEX `email`,\n  MODIFY COLUMN `total` decimal(12,2) NULL,\n  ADD COLUMN `customer_id` int AFTER `status`,\n  ADD CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `shop`.`customers` (`id`) ON DELETE CASCADE"
        );
        assert_eq!(
            plan.warnings,
            vec![
                DesignWarning::DropRule {
                    rule: Rule::Unique,
                    name: "email".into()
                },
                DesignWarning::ExistingRows {
                    rule: Rule::ForeignKey,
                    name: "orders_customer_fk".into()
                },
            ]
        );
        assert_eq!((plan.before, plan.after), (0, 0));
    }

    #[test]
    fn full_restatement_keeps_every_attribute() {
        let mut base = orders(MY);
        base.columns.push(TableColumn {
            default_sql: Some("CURRENT_TIMESTAMP".into()),
            mysql: Some(MySqlColumn {
                charset: None,
                collation: None,
                on_update: Some("CURRENT_TIMESTAMP".into()),
            }),
            ..col("updated_at", "timestamp")
        });
        base.columns[1].mysql = Some(MySqlColumn {
            charset: Some("utf8mb4".into()),
            collation: Some("utf8mb4_bin".into()),
            on_update: None,
        });
        base.columns[1].collation = Some("utf8mb4_bin".into());
        base.columns[0].comment = Some("key".into());
        let plan = alter(
            MY,
            &base,
            vec![
                change(&base, "updated_at", |c| c.comment = Some("changed".into())),
                change(&base, "email", |c| c.comment = Some("it's".into())),
                change(&base, "id", |c| c.type_sql = "bigint".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `id` bigint AUTO_INCREMENT NOT NULL COMMENT 'key',\n  MODIFY COLUMN `email` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT 'it''s',\n  MODIFY COLUMN `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'changed'"
        );
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    }

    #[test]
    fn a_new_type_drops_what_it_cannot_hold() {
        let mut base = orders(MY);
        base.columns[1].mysql = Some(MySqlColumn {
            charset: Some("utf8mb4".into()),
            collation: Some("utf8mb4_bin".into()),
            on_update: None,
        });
        base.columns[4].mysql = Some(MySqlColumn {
            charset: None,
            collation: None,
            on_update: Some("CURRENT_TIMESTAMP".into()),
        });
        let plan = alter(
            MY,
            &base,
            vec![
                change(&base, "email", |c| c.type_sql = "int".into()),
                change(&base, "created_at", |c| {
                    c.type_sql = "date".into();
                    c.default_sql = None;
                }),
            ],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `email` int NULL,\n  MODIFY COLUMN `created_at` date NULL"
        );
        let plan = alter(
            MY,
            &base,
            vec![change(&base, "email", |c| c.type_sql = "text".into())],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `email` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL"
        );
        let lost = alter(
            MY,
            &base,
            vec![change(&base, "created_at", |c| c.type_sql = "date".into())],
        )
        .unwrap();
        assert_eq!(
            lost.warnings,
            vec![DesignWarning::NarrowType {
                column: "created_at".into(),
                from: "timestamp".into(),
                to: "date".into(),
                note: Some("The column loses ON UPDATE CURRENT_TIMESTAMP.".into()),
            }]
        );
    }

    #[test]
    fn date_to_timestamp_names_the_range() {
        let mut base = orders(MY);
        base.columns.push(col("shipped_on", "date"));
        let plan = alter(
            MY,
            &base,
            vec![change(&base, "shipped_on", |c| {
                c.type_sql = "timestamp".into()
            })],
        )
        .unwrap();
        assert_eq!(
            plan.warnings,
            vec![DesignWarning::NarrowType {
                column: "shipped_on".into(),
                from: "date".into(),
                to: "timestamp".into(),
                note: Some("MySQL TIMESTAMP holds only dates from 1970 to 2038.".into()),
            }]
        );
        let datetime = alter(
            MY,
            &base,
            vec![change(&base, "shipped_on", |c| {
                c.type_sql = "datetime".into()
            })],
        )
        .unwrap();
        assert!(datetime.warnings.is_empty(), "{:?}", datetime.warnings);
    }

    #[test]
    fn a_column_with_attributes_the_model_lacks_is_renamed_only() {
        let mut base = orders(MY);
        base.columns.push(TableColumn {
            advanced: true,
            ..col("hidden", "int")
        });
        base.unsupported = vec!["column hidden (invisible)".into()];
        let renamed = alter(
            MY,
            &base,
            vec![change(&base, "hidden", |c| c.name = "secret".into())],
        )
        .unwrap();
        assert_eq!(
            one(&renamed),
            "ALTER TABLE `shop`.`orders`\n  RENAME COLUMN `hidden` TO `secret`"
        );
        let refusals = [
            change(&base, "hidden", |c| c.comment = Some("x".into())),
            change(&base, "hidden", |c| c.type_sql = "bigint".into()),
            change(&base, "hidden", |c| c.nullable = false),
            change(&base, "hidden", |c| c.default_sql = Some("1".into())),
            change(&base, "hidden", |c| {
                c.name = "secret".into();
                c.comment = Some("x".into());
            }),
            DesignEdit::MoveColumn {
                name: "hidden".into(),
                position: Position::First,
            },
        ];
        for edit in refusals {
            let refused = refusal(alter(MY, &base, vec![edit]));
            assert_eq!(
                refused,
                "Contura cannot restate column hidden (invisible). Rename or drop it here, or change it in SQL."
            );
        }
        alter(
            MY,
            &base,
            vec![DesignEdit::DropColumn {
                name: "hidden".into(),
            }],
        )
        .unwrap();
    }

    #[test]
    fn mysql_rename_and_type_change_is_one_change() {
        let mut base = orders(MY);
        base.columns[2].name = "state".into();
        let plan = alter(
            MY,
            &base,
            vec![change(&base, "state", |c| {
                c.name = "status".into();
                c.type_sql = "varchar(32)".into();
            })],
        )
        .unwrap();
        let sql = one(&plan);
        assert_eq!(
            sql,
            "ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `state` `status` varchar(32) NOT NULL DEFAULT 'new'"
        );
        assert!(!sql.contains("DROP COLUMN"));
        assert_eq!(
            plan.warnings,
            vec![DesignWarning::RenameColumn {
                from: "state".into(),
                to: "status".into()
            }]
        );
        let rename_only = alter(
            MY,
            &base,
            vec![change(&base, "state", |c| c.name = "status".into())],
        )
        .unwrap();
        assert_eq!(
            one(&rename_only),
            "ALTER TABLE `shop`.`orders`\n  RENAME COLUMN `state` TO `status`"
        );
    }

    #[test]
    fn fk_change_splits_in_two() {
        let mut base = orders(MY);
        base.columns.push(col("customer_id", "int"));
        base.foreign_keys.push(key(MY, "fk_a", "customer_id"));
        let plan = alter(
            MY,
            &base,
            vec![
                DesignEdit::DropForeignKey {
                    name: "fk_a".into(),
                },
                DesignEdit::AddForeignKey {
                    key: key_draft(MY, "fk_a", "customer_id"),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `fk_a`",
                "ALTER TABLE `shop`.`orders`\n  ADD CONSTRAINT `fk_a` FOREIGN KEY (`customer_id`) REFERENCES `shop`.`customers` (`id`) ON DELETE CASCADE",
            ]
        );
        assert_eq!(plan.mode, DesignMode::Sequential);
    }

    #[test]
    fn fk_drop_with_its_index_splits_and_alone_does_not() {
        let mut base = orders(MY);
        base.columns.push(col("customer_id", "int"));
        base.indexes
            .push(idx("fk_a", &["customer_id"], false, false));
        base.foreign_keys.push(key(MY, "fk_a", "customer_id"));
        let drop_key = DesignEdit::DropForeignKey {
            name: "fk_a".into(),
        };
        let plan = alter(
            MY,
            &base,
            vec![
                drop_key.clone(),
                DesignEdit::DropIndex {
                    name: "fk_a".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `fk_a`",
                "ALTER TABLE `shop`.`orders`\n  DROP INDEX `fk_a`",
            ]
        );
        assert_eq!(plan.mode, DesignMode::Sequential);
        let alone = alter(
            MY,
            &base,
            vec![drop_key, change(&base, "total", |c| c.nullable = false)],
        )
        .unwrap();
        assert_eq!(
            one(&alone),
            "ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `fk_a`,\n  MODIFY COLUMN `total` decimal(10,2) NOT NULL"
        );
    }

    #[test]
    fn move_up_is_modify_after() {
        let base = orders(MY);
        let moved = |position| {
            alter(
                MY,
                &base,
                vec![DesignEdit::MoveColumn {
                    name: "total".into(),
                    position,
                }],
            )
            .unwrap()
        };
        assert_eq!(
            one(&moved(Position::After {
                column: "id".into()
            })),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `total` decimal(10,2) NULL AFTER `id`"
        );
        assert_eq!(
            one(&moved(Position::First)),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `total` decimal(10,2) NULL FIRST"
        );
        // Moving `status` down past `total` moves `status`, not `total`.
        let down = alter(
            MY,
            &base,
            vec![DesignEdit::MoveColumn {
                name: "status".into(),
                position: Position::After {
                    column: "total".into(),
                },
            }],
        )
        .unwrap();
        assert_eq!(
            one(&down),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `status` varchar(16) NOT NULL DEFAULT 'new' AFTER `total`"
        );
    }

    #[test]
    fn a_column_moved_next_to_a_new_one_is_placed_before_the_add() {
        // MySQL cannot place a column after one a later clause adds.
        let base = orders(MY);
        let plan = alter(
            MY,
            &base,
            vec![
                DesignEdit::AddColumn {
                    column: new_column("n", "int"),
                    position: Position::After {
                        column: "id".into(),
                    },
                },
                DesignEdit::MoveColumn {
                    name: "total".into(),
                    position: Position::After { column: "n".into() },
                },
                change(&base, "email", |c| c.name = "mail".into()),
                DesignEdit::MoveColumn {
                    name: "created_at".into(),
                    position: Position::After {
                        column: "mail".into(),
                    },
                },
            ],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  MODIFY COLUMN `total` decimal(10,2) NULL AFTER `id`,\n  RENAME COLUMN `email` TO `mail`,\n  MODIFY COLUMN `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP AFTER `mail`,\n  ADD COLUMN `n` int AFTER `id`"
        );
    }

    #[test]
    fn keys_indexes_and_comment() {
        let base = orders(MY);
        let plan = alter(
            MY,
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "PRIMARY".into(),
                },
                add_index("PRIMARY", &["id", "email"], true, true),
                DesignEdit::RenameIndex {
                    name: "email".into(),
                    to: "email_uq".into(),
                },
                add_index("ix_status", &["status"], false, false),
                add_index("ux_total", &["total"], true, false),
                DesignEdit::DropColumn {
                    name: "created_at".into(),
                },
                DesignEdit::AddColumn {
                    column: new_column("first", "int"),
                    position: Position::First,
                },
                DesignEdit::TableComment {
                    comment: Some("a\\b".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            one(&plan),
            "ALTER TABLE `shop`.`orders`\n  DROP PRIMARY KEY,\n  DROP COLUMN `created_at`,\n  ADD COLUMN `first` int FIRST,\n  RENAME INDEX `email` TO `email_uq`,\n  ADD PRIMARY KEY (`id`, `email`),\n  ADD INDEX `ix_status` (`status`),\n  ADD UNIQUE INDEX `ux_total` (`total`),\n  COMMENT = 'a\\\\b'"
        );
        let mut commented = base.clone();
        commented.comment = Some("old".into());
        let cleared = alter(
            MY,
            &commented,
            vec![DesignEdit::TableComment { comment: None }],
        )
        .unwrap();
        assert_eq!(one(&cleared), "ALTER TABLE `shop`.`orders`\n  COMMENT = ''");
    }

    #[test]
    fn the_primary_key_keeps_its_name() {
        let base = orders(MY);
        let refused = refusal(alter(
            MY,
            &base,
            vec![DesignEdit::RenameIndex {
                name: "PRIMARY".into(),
                to: "pk".into(),
            }],
        ));
        assert_eq!(refused, "MySQL names every primary key PRIMARY.");
    }
}
