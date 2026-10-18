//! The risks a design plan carries, shown above its SQL before Apply.

use serde::{Deserialize, Serialize};

use crate::model::DialectKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesignWarning {
    /// The column and its values are dropped (also a drop plus an add of one name).
    DropColumn { column: String },
    /// Values may not fit the new type.
    NarrowType {
        column: String,
        from: String,
        to: String,
        /// What else the change loses, in plain words, such as
        /// "MySQL TIMESTAMP holds only dates from 1970 to 2038.".
        #[serde(default)]
        note: Option<String>,
    },
    /// A new rule that rows already in the table may break; the change then fails.
    ExistingRows { rule: Rule, name: String },
    /// A rule the table loses.
    DropRule { rule: Rule, name: String },
    /// PostgreSQL rewrites the table under a lock that blocks readers.
    RewriteLock { table: String },
    /// SQLite copies the whole table into a new one.
    RebuildCopy { table: String },
    /// Views, routines or applications may use the old name.
    RenameColumn { from: String, to: String },
    /// The table and every row in it are dropped.
    DropTable {
        table: String,
        /// Filled by the service from a bounded count; the planner leaves it `None`.
        rows: Option<RowCount>,
        /// Other tables with a Foreign Key to this one.
        referenced_by: Vec<String>,
    },
    /// SQLite with Foreign Keys on: a drop first deletes every row of `table`,
    /// which runs the ON DELETE action of a key in `child` that points at it.
    ChildRows {
        table: String,
        child: String,
        action: ChildAction,
    },
}

/// What a SQLite drop does to a child table's rows (ON DELETE).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChildAction {
    /// CASCADE: the matching rows are deleted.
    Delete,
    /// SET NULL: the key columns are cleared.
    Clear,
    /// SET DEFAULT: the key columns are set to their defaults.
    SetDefault,
    /// NO ACTION or RESTRICT: the drop fails while a row points at the table.
    Fail,
}

impl ChildAction {
    /// The action for an ON DELETE rule as loaded (`None` is NO ACTION).
    pub(crate) fn from_rule(on_delete: Option<&str>) -> ChildAction {
        match on_delete.map(str::to_ascii_uppercase).as_deref() {
            Some("CASCADE") => ChildAction::Delete,
            Some("SET NULL") => ChildAction::Clear,
            Some("SET DEFAULT") => ChildAction::SetDefault,
            _ => ChildAction::Fail,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    NotNull,
    Unique,
    PrimaryKey,
    ForeignKey,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowCount {
    Exact {
        n: u64,
    },
    /// The count stopped at `n`; the table holds more.
    Over {
        n: u64,
    },
}

/// How a column's type changes, as far as its values are concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TypeChange {
    Same,
    /// Every value fits the new type.
    Widening,
    /// Some values may not fit, or Contura cannot tell.
    Narrowing,
}

/// A type split into its base words and its arguments, lower case, with the
/// Dialect's other spellings of the same type folded together.
#[derive(Debug, PartialEq, Eq)]
struct TypeParts {
    base: String,
    args: Vec<String>,
}

const MYSQL_INTEGERS: [&str; 5] = ["tinyint", "smallint", "mediumint", "int", "bigint"];
const POSTGRES_INTEGERS: [&str; 3] = ["smallint", "integer", "bigint"];

fn type_parts(kind: DialectKind, type_sql: &str) -> TypeParts {
    let lower = type_sql.trim().to_lowercase();
    let (outside, args) = match (lower.find('('), lower.rfind(')')) {
        (Some(open), Some(close)) if open < close => (
            format!("{} {}", &lower[..open], &lower[close + 1..]),
            lower[open + 1..close]
                .split(',')
                .map(|a| a.trim().to_string())
                .collect(),
        ),
        _ => (lower.clone(), Vec::new()),
    };
    let words = outside.split_whitespace().collect::<Vec<_>>().join(" ");
    let base = match (kind, words.as_str()) {
        (DialectKind::Postgres, "varchar") => "character varying",
        (DialectKind::Postgres, "char" | "bpchar") => "character",
        (DialectKind::Postgres, "varbit") => "bit varying",
        (DialectKind::Postgres, "int" | "int4") => "integer",
        (DialectKind::Postgres, "int2") => "smallint",
        (DialectKind::Postgres, "int8") => "bigint",
        (DialectKind::Postgres, "decimal") => "numeric",
        (DialectKind::Postgres, "timestamp without time zone") => "timestamp",
        (DialectKind::Postgres, "timestamp with time zone") => "timestamptz",
        (DialectKind::Postgres, "time without time zone") => "time",
        (DialectKind::Postgres, "bool") => "boolean",
        (DialectKind::Postgres, "float8") => "double precision",
        (DialectKind::Postgres, "float4") => "real",
        (DialectKind::MySql, "integer") => "int",
        (DialectKind::MySql, "dec" | "numeric" | "fixed") => "decimal",
        (_, other) => other,
    }
    .to_string();
    // A MySQL integer's argument is a display width, not a size (`int(10) unsigned`).
    let first = base.split(' ').next().unwrap_or_default();
    let args = if kind == DialectKind::MySql && MYSQL_INTEGERS.contains(&first) {
        Vec::new()
    } else {
        args
    };
    TypeParts { base, args }
}

/// When a type change rounds values instead of refusing them, what it rounds to:
/// a smaller numeric scale (`"scale"`), or a smaller fractional-second precision
/// of a time type (`"precision"`). The server cannot refuse either.
pub(crate) fn rounding(kind: DialectKind, from: &str, to: &str) -> Option<&'static str> {
    let (a, b) = (type_parts(kind, from), type_parts(kind, to));
    if a.base != b.base {
        return None;
    }
    let number = |args: &[String], at: usize| args.get(at).and_then(|x| x.parse::<u64>().ok());
    let numeric = matches!(a.base.as_str(), "numeric" | "decimal");
    let time = matches!(
        a.base.as_str(),
        "timestamp" | "timestamptz" | "time" | "time with time zone" | "interval" | "datetime"
    );
    if numeric {
        // A missing scale is 0 on MySQL and unlimited on PostgreSQL.
        let missing = if kind == DialectKind::MySql {
            Some(0)
        } else {
            None
        };
        let scale = |args: &[String]| {
            if args.len() > 1 {
                number(args, 1)
            } else {
                missing
            }
        };
        match (scale(&a.args), scale(&b.args)) {
            (Some(x), Some(y)) if y < x => return Some("scale"),
            (None, Some(_)) => return Some("scale"),
            _ => {}
        }
    }
    if time {
        // A missing precision is 0 on MySQL and the most there is on PostgreSQL.
        let missing = if kind == DialectKind::MySql {
            Some(0)
        } else {
            None
        };
        let precision = |args: &[String]| {
            if args.is_empty() {
                missing
            } else {
                number(args, 0)
            }
        };
        match (precision(&a.args), precision(&b.args)) {
            (Some(x), Some(y)) if y < x => return Some("precision"),
            (None, Some(_)) => return Some("precision"),
            _ => {}
        }
    }
    None
}

/// The base type, such as `character varying` for PostgreSQL `varchar(32)`.
pub(crate) fn type_base(kind: DialectKind, type_sql: &str) -> String {
    type_parts(kind, type_sql).base
}

fn ladder(kind: DialectKind) -> &'static [&'static str] {
    match kind {
        DialectKind::MySql => &MYSQL_INTEGERS,
        DialectKind::Postgres => &POSTGRES_INTEGERS,
        DialectKind::Sqlite => &[],
    }
}

/// Compares two types by base word and arguments. Anything Contura does not
/// know to be wider is `Narrowing`, so it warns when unsure.
pub(crate) fn type_change(kind: DialectKind, from: &str, to: &str) -> TypeChange {
    let (a, b) = (type_parts(kind, from), type_parts(kind, to));
    if a == b {
        return TypeChange::Same;
    }
    let varchar = |base: &str| base == "varchar" || base == "character varying";
    // Fixed-width binary and bit values are padded to a new size, so they change.
    let padded = matches!(a.base.as_str(), "binary" | "bit");
    let wider = if a.base == b.base && !padded {
        match (a.args.as_slice(), b.args.as_slice()) {
            // PostgreSQL `varchar` and `numeric` without arguments take any length.
            ([_, ..], []) => {
                kind == DialectKind::Postgres
                    && (a.base == "character varying" || a.base == "numeric")
            }
            ([size_a, rest_a @ ..], [size_b, rest_b @ ..]) if rest_a == rest_b => {
                match (size_a.parse::<u64>(), size_b.parse::<u64>()) {
                    (Ok(x), Ok(y)) => y >= x,
                    _ => false,
                }
            }
            _ => false,
        }
    } else {
        let rank = |base: &str| ladder(kind).iter().position(|t| *t == base);
        match (rank(&a.base), rank(&b.base)) {
            (Some(x), Some(y)) => y > x,
            _ => {
                // MySQL TIMESTAMP holds only 1970 to 2038, so there `date` widens
                // to `datetime` instead.
                let later = match kind {
                    DialectKind::MySql => "datetime",
                    _ => "timestamp",
                };
                (varchar(&a.base) && b.base == "text" && b.args.is_empty())
                    || (a.base == "date" && b.base == later)
            }
        }
    };
    if wider {
        TypeChange::Widening
    } else {
        TypeChange::Narrowing
    }
}

/// PostgreSQL: a type change that rewrites the table. Only a longer `varchar`
/// and `varchar` to `text` keep the rows as they are.
pub(crate) fn rewrites_table(from: &str, to: &str) -> bool {
    let kind = DialectKind::Postgres;
    let change = type_change(kind, from, to);
    let (a, b) = (type_base(kind, from), type_base(kind, to));
    let keeps = a == "character varying"
        && change == TypeChange::Widening
        && (b == "character varying" || b == "text");
    change != TypeChange::Same && !keeps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_change_table() {
        use DialectKind::{MySql, Postgres};
        use TypeChange::{Narrowing, Same, Widening};
        let cases = [
            (Postgres, "character varying(16)", "varchar(32)", Widening),
            (Postgres, "character varying(16)", "VARCHAR(16)", Same),
            (Postgres, "character varying(32)", "varchar(16)", Narrowing),
            (Postgres, "character varying(32)", "varchar", Widening),
            (Postgres, "character varying", "varchar(32)", Narrowing),
            (Postgres, "character varying(32)", "text", Widening),
            (Postgres, "text", "varchar(32)", Narrowing),
            (Postgres, "numeric(10,2)", "numeric(12,2)", Widening),
            (Postgres, "numeric(10,2)", "decimal(12, 2)", Widening),
            (Postgres, "numeric(10,2)", "numeric(12,4)", Narrowing),
            (Postgres, "numeric(10,2)", "numeric(8,2)", Narrowing),
            (Postgres, "numeric(10,2)", "integer", Narrowing),
            (Postgres, "smallint", "integer", Widening),
            (Postgres, "integer", "int8", Widening),
            (Postgres, "bigint", "integer", Narrowing),
            (Postgres, "int4", "integer", Same),
            (Postgres, "date", "timestamp without time zone", Widening),
            (Postgres, "date", "timestamp(3)", Widening),
            (Postgres, "timestamp without time zone", "date", Narrowing),
            (
                Postgres,
                "timestamp(3) without time zone",
                "timestamp(3)",
                Same,
            ),
            (Postgres, "uuid", "text", Narrowing),
            (MySql, "int(11)", "int", Same),
            (MySql, "int", "bigint", Widening),
            (MySql, "tinyint", "mediumint", Widening),
            (MySql, "bigint", "int", Narrowing),
            (MySql, "int", "int unsigned", Narrowing),
            (MySql, "varchar(16)", "varchar(32)", Widening),
            (MySql, "varchar(16)", "text", Widening),
            (MySql, "decimal(10,2)", "decimal(12,2)", Widening),
            (MySql, "decimal(10,2)", "numeric(10,2)", Same),
            (MySql, "date", "timestamp", Narrowing),
            (MySql, "datetime", "timestamp", Narrowing),
            (MySql, "date", "datetime", Widening),
            (MySql, "int(10) unsigned", "int unsigned", Same),
            (MySql, "binary(8)", "binary(16)", Narrowing),
            (MySql, "varbinary(8)", "varbinary(16)", Widening),
            (Postgres, "bit(8)", "bit(16)", Narrowing),
            (MySql, "datetime", "date", Narrowing),
            (MySql, "enum('a')", "enum('a','b')", Narrowing),
        ];
        for (kind, from, to, want) in cases {
            assert_eq!(type_change(kind, from, to), want, "{kind:?} {from} -> {to}");
        }
    }

    #[test]
    fn rounding_cases() {
        use DialectKind::{MySql, Postgres};
        let cases = [
            (Postgres, "numeric(10,2)", "numeric(10,1)", Some("scale")),
            (Postgres, "numeric", "numeric(10,2)", Some("scale")),
            (Postgres, "numeric(10,2)", "numeric(12,2)", None),
            (Postgres, "numeric(10,2)", "numeric", None),
            (
                Postgres,
                "timestamp(6) without time zone",
                "timestamp(0)",
                Some("precision"),
            ),
            (
                Postgres,
                "timestamp without time zone",
                "timestamp(3)",
                Some("precision"),
            ),
            (
                Postgres,
                "timestamp(3) without time zone",
                "timestamp",
                None,
            ),
            (Postgres, "integer", "numeric(10,2)", None),
            (MySql, "decimal(10,2)", "decimal(10,1)", Some("scale")),
            (MySql, "decimal(10,2)", "decimal(12)", Some("scale")),
            (MySql, "datetime(3)", "datetime", Some("precision")),
            (MySql, "datetime", "datetime(3)", None),
            (MySql, "varchar(10)", "varchar(5)", None),
        ];
        for (kind, from, to, want) in cases {
            assert_eq!(rounding(kind, from, to), want, "{kind:?} {from} -> {to}");
        }
    }

    #[test]
    fn postgres_rewrite_rule() {
        assert!(!rewrites_table("character varying(16)", "varchar(32)"));
        assert!(!rewrites_table("character varying(16)", "text"));
        assert!(!rewrites_table(
            "character varying(16)",
            "character varying(16)"
        ));
        assert!(rewrites_table("character varying(32)", "varchar(16)"));
        assert!(rewrites_table("numeric(10,2)", "integer"));
        assert!(rewrites_table("integer", "bigint"));
        assert!(rewrites_table("text", "varchar(10)"));
    }

    #[test]
    fn warning_shape() {
        let json = |w: DesignWarning| serde_json::to_value(w).unwrap();
        assert_eq!(
            json(DesignWarning::DropTable {
                table: "orders".into(),
                rows: Some(RowCount::Over { n: 10_000 }),
                referenced_by: vec!["items".into()],
            }),
            serde_json::json!({"kind":"dropTable","table":"orders",
                "rows":{"kind":"over","n":10000},"referencedBy":["items"]})
        );
        assert_eq!(
            json(DesignWarning::ExistingRows {
                rule: Rule::NotNull,
                name: "total".into(),
            }),
            serde_json::json!({"kind":"existingRows","rule":"notNull","name":"total"})
        );
        assert_eq!(
            json(DesignWarning::ChildRows {
                table: "customers".into(),
                child: "orders".into(),
                action: ChildAction::SetDefault,
            }),
            serde_json::json!({"kind":"childRows","table":"customers","child":"orders",
                "action":"setDefault"})
        );
    }
}
