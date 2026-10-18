//! PostgreSQL ALTER TABLE plans: one statement per change, in one transaction.

use super::model::{Increment, TableDesign};
use super::plan::{
    DesignEdit, DesignMode, DesignPlan, checked_action, diff, fk_target, invalid, kept_attributes,
    rename_order,
};
use super::warning::{DesignWarning, TypeChange, rewrites_table, type_base};
use crate::common::{sql_ident, sql_scoped};
use crate::ddl::{ColumnSql, FkSql, column_sql, foreign_key_sql, idents, lit};
use crate::error::Result;
use crate::model::DialectKind;

const PG: DialectKind = DialectKind::Postgres;

const STRINGS: &[&str] = &["text", "character varying", "character", "citext", "name"];
const BITS: &[&str] = &["bit", "bit varying"];

/// Type families with an assignment cast between their members.
const FAMILIES: [&[&str]; 2] = [STRINGS, BITS];

/// A change within one type family takes no explicit cast (S5): the server's
/// assignment cast refuses a value that does not fit, where `USING c::varchar(5)`
/// would cut it short.
fn assignment_cast(from: &str, to: &str) -> bool {
    let (a, b) = (type_base(PG, from), type_base(PG, to));
    a == b
        || FAMILIES
            .iter()
            .any(|f| f.contains(&a.as_str()) && f.contains(&b.as_str()))
}

/// The `USING` clause of a type change, or none. Within a family there is none
/// (S5). Into a length-limited string or bit type the column is cast to the
/// unlimited form, so the server's assignment cast to the limit refuses values
/// that do not fit (S7) where `USING c::varchar(3)` would cut `12345` to `123`.
/// A non-string type into a bit type has no such form, so it is refused.
fn using_clause(column: &str, from: &str, to: &str) -> Result<String> {
    if assignment_cast(from, to) {
        return Ok(String::new());
    }
    let (a, b) = (type_base(PG, from), type_base(PG, to));
    let q = sql_ident(PG, column);
    let unlimited = if STRINGS.contains(&b.as_str()) {
        if b == "character" { "bpchar" } else { "text" }
    } else if BITS.contains(&b.as_str()) {
        if !STRINGS.contains(&a.as_str()) {
            return Err(invalid(format!(
                "Contura cannot change {column} from {from} to {to} without cutting its values. Change it in SQL."
            )));
        }
        "varbit"
    } else {
        return Ok(format!(" USING {q}::{to}"));
    };
    Ok(format!(" USING {q}::{unlimited}"))
}

/// The ALTER plan, one statement per change, in the set order.
pub(super) fn plan(base: &TableDesign, edits: &[DesignEdit]) -> Result<DesignPlan> {
    if edits
        .iter()
        .any(|e| matches!(e, DesignEdit::MoveColumn { .. }))
    {
        return Err(invalid("PostgreSQL cannot reorder columns."));
    }
    let a = diff(PG, base, edits)?;
    if a.added_columns.iter().any(|n| !n.at_end) {
        return Err(invalid(
            "PostgreSQL adds new columns after the existing ones.",
        ));
    }
    let schema = a.path.schema.clone().unwrap_or_default();
    let q = |name: &str| sql_ident(PG, name);
    let t = |rest: String| format!("ALTER TABLE {} {rest}", a.table);
    let mut warnings = a.warnings.clone();
    let mut out = Vec::new();

    for k in &a.dropped_keys {
        out.push(t(format!("DROP CONSTRAINT {}", q(&k.name))));
    }
    for i in &a.dropped_indexes {
        out.push(if i.constraint {
            t(format!("DROP CONSTRAINT {}", q(&i.name)))
        } else {
            format!("DROP INDEX {}", sql_scoped(PG, &schema, &i.name))
        });
    }
    for c in &a.dropped_columns {
        out.push(t(format!("DROP COLUMN {}", q(&c.name))));
    }
    let renames = a
        .changes
        .iter()
        .filter(|ch| ch.renamed)
        .map(|ch| (ch.base.name.clone(), ch.column.name.clone()))
        .collect();
    for (from, to) in rename_order(renames, "columns")? {
        out.push(t(format!("RENAME COLUMN {} TO {}", q(&from), q(&to))));
    }
    for ch in &a.changes {
        let c = &ch.column;
        let alter = |rest: String| t(format!("ALTER COLUMN {} {rest}", q(&c.name)));
        let serial = ch.base.increment == Increment::Serial;
        if ch.increment && serial {
            return Err(invalid(format!(
                "{} is a serial column: change its default instead.",
                ch.base.name
            )));
        }
        // An identity column takes neither a default nor DROP NOT NULL, so its
        // identity goes first; a new one comes after both.
        if ch.increment && !c.increment {
            out.push(alter("DROP IDENTITY".into()));
        }
        let retyped = ch.type_change != TypeChange::Same;
        // The server casts the old default to the new type and refuses when it
        // cannot, so the default steps aside around the type change (S6a).
        let default_aside = retyped && ch.base.default_sql.is_some();
        if default_aside {
            out.push(alter("DROP DEFAULT".into()));
        }
        if retyped {
            let (keeps, _) = kept_attributes(PG, &ch.base, &c.type_sql, ch.type_change);
            let collate = ch
                .base
                .collation
                .as_ref()
                .filter(|_| keeps)
                .map(|co| format!(" COLLATE {}", q(co)))
                .unwrap_or_default();
            let using = using_clause(&c.name, &ch.base.type_sql, &c.type_sql)?;
            out.push(alter(format!("TYPE {}{collate}{using}", c.type_sql)));
            let lock = DesignWarning::RewriteLock {
                table: a.path.name.clone(),
            };
            if rewrites_table(&ch.base.type_sql, &c.type_sql) && !warnings.contains(&lock) {
                warnings.push(lock);
            }
        }
        if ch.nullable {
            out.push(alter(
                if c.nullable {
                    "DROP NOT NULL"
                } else {
                    "SET NOT NULL"
                }
                .into(),
            ));
        }
        if default_aside {
            if let Some(d) = &c.default_sql {
                out.push(alter(format!("SET DEFAULT {d}")));
            }
        } else if ch.default {
            out.push(alter(match &c.default_sql {
                Some(d) => format!("SET DEFAULT {d}"),
                None => "DROP DEFAULT".into(),
            }));
        }
        if ch.increment && c.increment {
            out.push(alter("ADD GENERATED BY DEFAULT AS IDENTITY".into()));
        }
    }
    for n in &a.added_columns {
        let c = &n.column;
        let def = column_sql(
            PG,
            &ColumnSql {
                name: c.name.clone(),
                type_sql: c.type_sql.clone(),
                nullable: c.nullable,
                default_sql: c.default_sql.clone(),
                increment: c.increment,
                sqlite_autoincrement: false,
                primary_inline: false,
                unique_inline: false,
                comment: None,
                mysql: None,
                collation: None,
                explicit_null: false,
            },
        );
        out.push(t(format!("ADD COLUMN {def}")));
    }
    let index_renames = a
        .renamed_indexes
        .iter()
        .map(|(i, to)| (i.name.clone(), to.clone()))
        .collect();
    for (from, to) in rename_order(index_renames, "indexes")? {
        out.push(format!(
            "ALTER INDEX {} RENAME TO {}",
            sql_scoped(PG, &schema, &from),
            q(&to)
        ));
    }
    for i in &a.added_indexes {
        let columns = idents(PG, &i.columns);
        out.push(match (i.primary, i.name.trim().is_empty()) {
            (true, true) => t(format!("ADD PRIMARY KEY ({columns})")),
            (true, false) => t(format!(
                "ADD CONSTRAINT {} PRIMARY KEY ({columns})",
                q(&i.name)
            )),
            (false, _) => format!(
                "CREATE {}INDEX {} ON {} ({columns})",
                if i.unique { "UNIQUE " } else { "" },
                q(&i.name),
                a.table
            ),
        });
    }
    for k in &a.added_keys {
        let fk = foreign_key_sql(
            PG,
            &FkSql {
                name: (!k.name.trim().is_empty()).then(|| k.name.clone()),
                columns: k.columns.clone(),
                target: fk_target(PG, &a.path, &k.target)?,
                target_columns: k.target_columns.clone(),
                on_delete: checked_action(&k.on_delete)?,
                on_update: checked_action(&k.on_update)?,
            },
        );
        out.push(t(format!("ADD {fk}")));
    }

    let text = |comment: &Option<String>| match comment {
        Some(c) => lit(PG, c),
        None => "NULL".into(),
    };
    if let Some(comment) = &a.comment {
        out.push(format!("COMMENT ON TABLE {} IS {}", a.table, text(comment)));
    }
    let commented = a
        .changes
        .iter()
        .filter(|ch| ch.comment)
        .map(|ch| &ch.column)
        .chain(
            a.added_columns
                .iter()
                .map(|n| &n.column)
                .filter(|c| c.comment.is_some()),
        );
    for c in commented {
        out.push(format!(
            "COMMENT ON COLUMN {}.{} IS {}",
            a.table,
            q(&c.name),
            text(&c.comment)
        ));
    }

    Ok(DesignPlan {
        statements: out,
        warnings,
        mode: DesignMode::Transaction,
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
    use crate::design::model::{Increment, TableColumn};
    use crate::design::plan::fixtures::*;
    use crate::design::plan::{ColumnDraft, DesignMode, Position};
    use crate::design::warning::{DesignWarning, Rule};
    use crate::model::DialectKind;

    const PG: DialectKind = DialectKind::Postgres;
    const T: &str = "ALTER TABLE \"public\".\"orders\"";

    fn statements(base: &TableDesign, edits: Vec<DesignEdit>) -> DesignPlan {
        let plan = alter(PG, base, edits).unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!((plan.before, plan.after), (0, 0));
        plan
    }

    fn t(rest: &str) -> String {
        format!("{T} {rest}")
    }

    #[test]
    fn type_change_uses_a_cast_and_warns() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![change(&base, "total", |c| c.type_sql = "integer".into())],
        );
        assert_eq!(
            plan.statements,
            vec![t(
                "ALTER COLUMN \"total\" TYPE integer USING \"total\"::integer"
            )]
        );
        assert_eq!(
            plan.warnings,
            vec![
                DesignWarning::NarrowType {
                    column: "total".into(),
                    from: "numeric(10,2)".into(),
                    to: "integer".into(),
                    note: None,
                },
                DesignWarning::RewriteLock {
                    table: "orders".into()
                },
            ]
        );
    }

    #[test]
    fn longer_varchar_neither_narrows_nor_rewrites() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![change(&base, "status", |c| {
                c.type_sql = "varchar(32)".into()
            })],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ALTER COLUMN \"status\" DROP DEFAULT"),
                t("ALTER COLUMN \"status\" TYPE varchar(32)"),
                t("ALTER COLUMN \"status\" SET DEFAULT 'new'"),
            ]
        );
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    }

    #[test]
    fn length_narrowing_takes_no_explicit_cast() {
        // An explicit cast to varchar(40) cuts longer values short; the assignment
        // cast refuses them, so the change fails and rolls back instead (S5).
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![
                change(&base, "email", |c| c.type_sql = "varchar(40)".into()),
                change(&base, "total", |c| c.type_sql = "numeric(8,2)".into()),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ALTER COLUMN \"email\" TYPE varchar(40)"),
                t("ALTER COLUMN \"total\" TYPE numeric(8,2)"),
            ]
        );
        assert_eq!(
            plan.warnings[0],
            DesignWarning::NarrowType {
                column: "email".into(),
                from: "character varying(80)".into(),
                to: "varchar(40)".into(),
                note: None,
            }
        );
        let fixed = statements(
            &base,
            vec![change(&base, "email", |c| c.type_sql = "char(4)".into())],
        );
        assert_eq!(
            fixed.statements,
            vec![t("ALTER COLUMN \"email\" TYPE char(4)")]
        );
    }

    #[test]
    fn into_a_limited_type_the_cast_is_to_the_unlimited_form() {
        // `USING c::varchar(3)` would cut 12345 to 123; through text the server's
        // assignment cast to varchar(3) refuses it instead (S7).
        let mut base = orders(PG);
        base.columns.push(col("n", "integer"));
        base.columns.push(col("flags", "text"));
        let retype = |name: &str, to: &str| {
            alter(
                PG,
                &base,
                vec![change(&base, name, |c| c.type_sql = to.into())],
            )
        };
        let cases = [
            ("total", "varchar(3)", "USING \"total\"::text"),
            ("n", "char(4)", "USING \"n\"::bpchar"),
            ("n", "text", "USING \"n\"::text"),
            ("flags", "bit(4)", "USING \"flags\"::varbit"),
            ("flags", "varbit(4)", "USING \"flags\"::varbit"),
            ("email", "integer", "USING \"email\"::integer"),
        ];
        for (name, to, using) in cases {
            let plan = retype(name, to).unwrap();
            assert_eq!(
                plan.statements,
                vec![t(&format!("ALTER COLUMN \"{name}\" TYPE {to} {using}"))],
                "{name} -> {to}"
            );
        }
        let refused = refusal(retype("n", "bit(4)"));
        assert_eq!(
            refused,
            "Contura cannot change n from integer to bit(4) without cutting its values. Change it in SQL."
        );
    }

    #[test]
    fn a_type_change_steps_the_default_aside() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![change(&base, "status", |c| {
                c.type_sql = "integer".into();
                c.default_sql = Some("0".into());
            })],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ALTER COLUMN \"status\" DROP DEFAULT"),
                t("ALTER COLUMN \"status\" TYPE integer USING \"status\"::integer"),
                t("ALTER COLUMN \"status\" SET DEFAULT 0"),
            ]
        );
        let dropped = statements(
            &base,
            vec![change(&base, "status", |c| {
                c.type_sql = "text".into();
                c.default_sql = None;
            })],
        );
        assert_eq!(
            dropped.statements,
            vec![
                t("ALTER COLUMN \"status\" DROP DEFAULT"),
                t("ALTER COLUMN \"status\" TYPE text"),
            ]
        );
    }

    #[test]
    fn index_rename_cycles_are_refused() {
        let mut base = orders(PG);
        base.indexes.push(idx("a_ix", &["status"], false, false));
        base.indexes.push(idx("b_ix", &["total"], false, false));
        let rename = |name: &str, to: &str| DesignEdit::RenameIndex {
            name: name.into(),
            to: to.into(),
        };
        let swap = refusal(alter(
            PG,
            &base,
            vec![
                rename("a_ix", "x_ix"),
                rename("b_ix", "a_ix"),
                rename("x_ix", "b_ix"),
            ],
        ));
        assert!(swap.contains("indexes a_ix, b_ix swap names"), "{swap}");
    }

    #[test]
    fn a_type_change_keeps_the_collation() {
        let mut base = orders(PG);
        base.columns[1].collation = Some("C".into());
        let plan = statements(
            &base,
            vec![change(&base, "email", |c| c.type_sql = "text".into())],
        );
        assert_eq!(
            plan.statements,
            vec![t("ALTER COLUMN \"email\" TYPE text COLLATE \"C\"")]
        );
        let plan = statements(
            &base,
            vec![change(&base, "email", |c| c.type_sql = "integer".into())],
        );
        assert_eq!(
            plan.statements,
            vec![t(
                "ALTER COLUMN \"email\" TYPE integer USING \"email\"::integer"
            )]
        );
    }

    #[test]
    fn nullability_and_defaults() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![
                change(&base, "total", |c| {
                    c.nullable = false;
                    c.default_sql = Some("0".into());
                }),
                change(&base, "status", |c| {
                    c.nullable = true;
                    c.default_sql = None;
                }),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ALTER COLUMN \"status\" DROP NOT NULL"),
                t("ALTER COLUMN \"status\" DROP DEFAULT"),
                t("ALTER COLUMN \"total\" SET NOT NULL"),
                t("ALTER COLUMN \"total\" SET DEFAULT 0"),
            ]
        );
        assert_eq!(
            plan.warnings,
            vec![DesignWarning::ExistingRows {
                rule: Rule::NotNull,
                name: "total".into()
            }]
        );
    }

    #[test]
    fn comments_are_comment_on() {
        let mut base = orders(PG);
        base.columns[2].comment = Some("s".into());
        let plan = statements(
            &base,
            vec![
                change(&base, "email", |c| c.comment = Some("it's".into())),
                change(&base, "status", |c| c.comment = None),
                DesignEdit::TableComment {
                    comment: Some("a\\b".into()),
                },
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        comment: Some("n".into()),
                        ..new_column("note", "text")
                    },
                    position: Position::Last,
                },
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ADD COLUMN \"note\" text"),
                "COMMENT ON TABLE \"public\".\"orders\" IS E'a\\\\b'".to_string(),
                "COMMENT ON COLUMN \"public\".\"orders\".\"email\" IS 'it''s'".to_string(),
                "COMMENT ON COLUMN \"public\".\"orders\".\"status\" IS NULL".to_string(),
                "COMMENT ON COLUMN \"public\".\"orders\".\"note\" IS 'n'".to_string(),
            ]
        );
        assert!(plan.warnings.is_empty());
        let mut commented = base.clone();
        commented.comment = Some("old".into());
        let cleared = statements(&commented, vec![DesignEdit::TableComment { comment: None }]);
        assert_eq!(
            cleared.statements,
            vec!["COMMENT ON TABLE \"public\".\"orders\" IS NULL"]
        );
    }

    #[test]
    fn constraint_index_drops_by_constraint_and_plain_index_by_name() {
        let mut base = orders(PG);
        base.indexes
            .push(idx("ix", &["status", "total"], true, false));
        let plan = statements(
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "orders_email_key".into(),
                },
                DesignEdit::DropIndex { name: "ix".into() },
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("DROP CONSTRAINT \"orders_email_key\""),
                "DROP INDEX \"public\".\"ix\"".to_string(),
            ]
        );
        assert_eq!(
            plan.warnings,
            vec![
                DesignWarning::DropRule {
                    rule: Rule::Unique,
                    name: "orders_email_key".into()
                },
                DesignWarning::DropRule {
                    rule: Rule::Unique,
                    name: "ix".into()
                },
            ]
        );
    }

    #[test]
    fn primary_key_change_drops_then_adds() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "orders_pkey".into(),
                },
                add_index("orders_pkey", &["id", "email"], true, true),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("DROP CONSTRAINT \"orders_pkey\""),
                t("ADD CONSTRAINT \"orders_pkey\" PRIMARY KEY (\"id\", \"email\")"),
            ]
        );
        assert_eq!(
            plan.warnings,
            vec![
                DesignWarning::DropRule {
                    rule: Rule::PrimaryKey,
                    name: "orders_pkey".into()
                },
                DesignWarning::ExistingRows {
                    rule: Rule::PrimaryKey,
                    name: "orders_pkey".into()
                },
            ]
        );
    }

    #[test]
    fn statements_run_in_the_set_order() {
        let mut base = orders(PG);
        base.columns.push(col("customer_id", "integer"));
        base.indexes
            .push(idx("orders_total_ix", &["total"], false, false));
        base.foreign_keys
            .push(key(PG, "orders_customer_fkey", "customer_id"));
        let plan = statements(
            &base,
            vec![
                DesignEdit::AddForeignKey {
                    key: key_draft(PG, "orders_buyer_fkey", "buyer_id"),
                },
                add_index("orders_note_ix", &["note"], false, false),
                DesignEdit::RenameIndex {
                    name: "orders_total_ix".into(),
                    to: "orders_amount_ix".into(),
                },
                DesignEdit::AddColumn {
                    column: new_column("note", "text"),
                    position: Position::Last,
                },
                change(&base, "total", |c| c.name = "amount".into()),
                DesignEdit::DropColumn {
                    name: "created_at".into(),
                },
                DesignEdit::DropIndex {
                    name: "orders_email_key".into(),
                },
                DesignEdit::DropForeignKey {
                    name: "orders_customer_fkey".into(),
                },
                change(&base, "customer_id", |c| c.name = "buyer_id".into()),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("DROP CONSTRAINT \"orders_customer_fkey\""),
                t("DROP CONSTRAINT \"orders_email_key\""),
                t("DROP COLUMN \"created_at\""),
                t("RENAME COLUMN \"total\" TO \"amount\""),
                t("RENAME COLUMN \"customer_id\" TO \"buyer_id\""),
                t("ADD COLUMN \"note\" text"),
                "ALTER INDEX \"public\".\"orders_total_ix\" RENAME TO \"orders_amount_ix\""
                    .to_string(),
                "CREATE INDEX \"orders_note_ix\" ON \"public\".\"orders\" (\"note\")".to_string(),
                t(
                    "ADD CONSTRAINT \"orders_buyer_fkey\" FOREIGN KEY (\"buyer_id\") REFERENCES \"public\".\"customers\" (\"id\") ON DELETE CASCADE"
                ),
            ]
        );
    }

    #[test]
    fn renames_run_in_an_order_that_works() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![
                change(&base, "status", |c| c.name = "state".into()),
                change(&base, "email", |c| c.name = "status".into()),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("RENAME COLUMN \"status\" TO \"state\""),
                t("RENAME COLUMN \"email\" TO \"status\""),
            ]
        );
        let swap = refusal(alter(
            PG,
            &base,
            vec![
                change(&base, "status", |c| c.name = "x".into()),
                change(&base, "email", |c| c.name = "status".into()),
                DesignEdit::ChangeColumn {
                    name: "x".into(),
                    column: ColumnDraft {
                        name: "email".into(),
                        ..same(&base, "status")
                    },
                },
            ],
        ));
        assert!(swap.contains("swap names"), "{swap}");
    }

    #[test]
    fn identity_toggles_and_serial_does_not() {
        let mut base = orders(PG);
        base.columns.push(TableColumn {
            increment: Increment::Serial,
            nullable: false,
            default_sql: Some("nextval('orders_n_seq'::regclass)".into()),
            ..col("n", "integer")
        });
        let plan = statements(
            &base,
            vec![
                change(&base, "id", |c| {
                    c.increment = false;
                    c.nullable = true;
                }),
                change(&base, "total", |c| {
                    c.increment = true;
                    c.nullable = false;
                    c.type_sql = "bigint".into();
                }),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ALTER COLUMN \"id\" DROP IDENTITY"),
                t("ALTER COLUMN \"id\" DROP NOT NULL"),
                t("ALTER COLUMN \"total\" TYPE bigint USING \"total\"::bigint"),
                t("ALTER COLUMN \"total\" SET NOT NULL"),
                t("ALTER COLUMN \"total\" ADD GENERATED BY DEFAULT AS IDENTITY"),
            ]
        );
        let serial = refusal(alter(
            PG,
            &base,
            vec![change(&base, "n", |c| c.increment = false)],
        ));
        assert_eq!(serial, "n is a serial column: change its default instead.");
    }

    #[test]
    fn columns_cannot_move() {
        let base = orders(PG);
        let moved = refusal(alter(
            PG,
            &base,
            vec![DesignEdit::MoveColumn {
                name: "total".into(),
                position: Position::First,
            }],
        ));
        assert_eq!(moved, "PostgreSQL cannot reorder columns.");
        let first = refusal(alter(
            PG,
            &base,
            vec![DesignEdit::AddColumn {
                column: new_column("n", "int"),
                position: Position::First,
            }],
        ));
        assert_eq!(
            first,
            "PostgreSQL adds new columns after the existing ones."
        );
    }

    #[test]
    fn new_columns_and_unique_indexes() {
        let base = orders(PG);
        let plan = statements(
            &base,
            vec![
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        nullable: false,
                        default_sql: Some("''".into()),
                        ..new_column("note", "text")
                    },
                    position: Position::Last,
                },
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        nullable: false,
                        increment: true,
                        ..new_column("seq", "bigint")
                    },
                    position: Position::Last,
                },
                add_index("orders_note_uq", &["note"], true, false),
            ],
        );
        assert_eq!(
            plan.statements,
            vec![
                t("ADD COLUMN \"note\" text NOT NULL DEFAULT ''"),
                t("ADD COLUMN \"seq\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL"),
                "CREATE UNIQUE INDEX \"orders_note_uq\" ON \"public\".\"orders\" (\"note\")"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn fragments_are_checked() {
        let base = orders(PG);
        let bad = refusal(alter(
            PG,
            &base,
            vec![change(&base, "total", |c| {
                c.type_sql = "int; drop table x".into()
            })],
        ));
        assert_eq!(bad, "The type of total is not one SQL expression.");
        let bad = refusal(alter(
            PG,
            &base,
            vec![change(&base, "total", |c| {
                c.default_sql = Some("0 -- x".into())
            })],
        ));
        assert_eq!(bad, "The default of total is not one SQL expression.");
    }
}
