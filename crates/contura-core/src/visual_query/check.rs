//! Problems that stop a Visual Query from being written, each with the field
//! it belongs to, so the panel can show them where they are (D4).

use super::literal::{literal, pattern, split_in_list};
use super::plan::{Plan, plan};
use super::{
    ColumnRef, ColumnTypes, FilterOp, GroupBy, JoinKind, SortTarget, VisualQuery, VqColumn,
    VqFilter,
};
use crate::model::DialectKind;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqProblem {
    pub target: ProblemTarget,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProblemTarget {
    Query,
    Columns,
    /// A table card, by its id.
    Table {
        id: String,
    },
    Join {
        id: String,
    },
    Filter {
        index: usize,
    },
    Sort {
        index: usize,
    },
}

fn problem(target: ProblemTarget, message: impl Into<String>) -> VqProblem {
    VqProblem {
        target,
        message: message.into(),
    }
}

/// Whether a SQLite version string is 3.39.0 or later. A version that does not
/// parse is taken as new enough; the server then has the last word.
fn sqlite_has_right_join(server_version: &str) -> bool {
    let mut parts = server_version
        .trim()
        .split('.')
        .map(|p| p.parse::<u32>().ok());
    let (Some(Some(major)), Some(Some(minor))) = (parts.next(), parts.next()) else {
        return true;
    };
    (major, minor) >= (3, 39)
}

/// Every problem in `vq`, in panel order: the query, Columns, Joins, filters,
/// sorts. Empty means the query can be written.
pub fn check(
    kind: DialectKind,
    server_version: &str,
    vq: &VisualQuery,
    types: &ColumnTypes,
) -> Vec<VqProblem> {
    if vq.version > 1 {
        return vec![problem(
            ProblemTarget::Query,
            "This Visual Query was saved by a newer Contura. Update Contura to open it.",
        )];
    }
    if let Some(built) = vq.dialect.filter(|d| *d != kind) {
        let name = match built {
            DialectKind::MySql => "MySQL",
            DialectKind::Postgres => "PostgreSQL",
            DialectKind::Sqlite => "SQLite",
        };
        return vec![problem(
            ProblemTarget::Query,
            format!("This Visual Query was built for {name}. Open it on a {name} Connection."),
        )];
    }
    let mut problems = Vec::new();
    let plan = plan(vq);
    let nul = |s: &str| s.contains('\0');
    let unknown = |id: &str| !plan.index.contains_key(id);

    if vq.database.as_deref().is_some_and(nul) {
        problems.push(problem(
            ProblemTarget::Query,
            "The database name has a NUL character. Remove it.",
        ));
    }
    let mut ids = HashSet::new();
    let mut aliases: HashSet<String> = HashSet::new();
    for t in &vq.tables {
        let target = || ProblemTarget::Table { id: t.id.clone() };
        if !ids.insert(t.id.as_str()) {
            problems.push(problem(
                ProblemTarget::Query,
                "Two table cards share one id. Remove one and add it again.",
            ));
        } else if nul(&t.name) || nul(&t.alias) || t.schema.as_deref().is_some_and(nul) {
            problems.push(problem(
                target(),
                "A table name, schema or alias has a NUL character. Remove it.",
            ));
        } else if t.alias.trim().is_empty() {
            problems.push(problem(target(), "Give every table an alias."));
        } else if !aliases.insert(t.alias.to_lowercase()) {
            problems.push(problem(
                target(),
                format!(
                    "Alias {} is used by two tables. Give each its own.",
                    t.alias
                ),
            ));
        }
    }

    if vq.columns.is_empty() {
        // Item 37: nothing ticked selects every column, which a grouped query cannot do.
        if matches!(&vq.group_by, GroupBy::Manual { columns } if !columns.is_empty()) {
            problems.push(problem(ProblemTarget::Columns, NO_COLUMN_GROUPED));
        }
    } else if let Some(n) = vq.columns.iter().position(|c| unknown(&c.table)) {
        problems.push(problem(
            ProblemTarget::Columns,
            format!("Column {} names a table that is not in the query.", n + 1),
        ));
    } else if let Some(n) = vq
        .columns
        .iter()
        .position(|c| nul(&c.column) || c.alias.as_deref().is_some_and(nul))
    {
        problems.push(problem(
            ProblemTarget::Columns,
            format!("Column {} {NUL_IN_NAME}", n + 1),
        ));
    } else if let Some(n) = vq.columns.iter().position(|c| c.column.is_empty()) {
        problems.push(problem(
            ProblemTarget::Columns,
            format!("Column {} has no column name. Pick one.", n + 1),
        ));
    } else if !vq.columns.iter().any(|c| plan.keeps(&c.table)) {
        problems.push(problem(ProblemTarget::Columns, ALL_BEHIND_PENDING));
    }

    let written = plan.written_kinds();
    for (j, join) in vq.joins.iter().enumerate() {
        let target = || ProblemTarget::Join {
            id: join.id.clone(),
        };
        if unknown(&join.left) || unknown(&join.right) {
            problems.push(problem(
                target(),
                "This Join names a table that is not in the query.",
            ));
            continue;
        }
        if plan.self_joins.contains(&j) {
            problems.push(problem(target(), SELF_JOIN));
            continue;
        }
        let pairs = join
            .on
            .iter()
            .chain(join.pending.iter().flatten().flat_map(|c| &c.on));
        if pairs
            .clone()
            .any(|p| nul(&p.left_column) || nul(&p.right_column))
        {
            problems.push(problem(target(), format!("This Join {NUL_IN_NAME}")));
            continue;
        }
        if join
            .on
            .iter()
            .any(|p| p.left_column.is_empty() || p.right_column.is_empty())
        {
            problems.push(problem(
                target(),
                "Pick both columns of every pair in this Join.",
            ));
            continue;
        }
        // Judged on the kinds as written, after the plan: a pending Join or one
        // with no pairs writes no JOIN at all.
        if kind == DialectKind::MySql && written.get(&j) == Some(&JoinKind::Full) {
            problems.push(problem(
                target(),
                "MySQL has no FULL JOIN. Pick Left or Right.",
            ));
        } else if kind == DialectKind::Sqlite
            && matches!(written.get(&j), Some(JoinKind::Right | JoinKind::Full))
            && !sqlite_has_right_join(server_version)
        {
            // The kind as written, after the swap: a Left Join reached from
            // its right side is a RIGHT JOIN.
            problems.push(problem(
                target(),
                "RIGHT and FULL JOIN need SQLite 3.39 or later.",
            ));
        }
    }

    for (index, filter) in vq.filters.iter().enumerate() {
        let target = || ProblemTarget::Filter { index };
        if unknown(&filter.table) {
            problems.push(problem(
                target(),
                format!(
                    "Filter {} names a table that is not in the query.",
                    index + 1
                ),
            ));
        } else if !plan.keeps(&filter.table) {
            // Left out by a pending pick: not written, so not judged.
        } else if nul(&filter.column) {
            problems.push(problem(
                target(),
                format!("Filter {} {NUL_IN_NAME}", index + 1),
            ));
        } else if let Some(message) = filter_problem(kind, index + 1, filter, types) {
            problems.push(problem(target(), message));
        }
    }

    if let GroupBy::Manual { columns } = &vq.group_by {
        if columns.iter().any(|c| unknown(&c.table)) {
            problems.push(problem(
                ProblemTarget::Query,
                "A GROUP BY column names a table that is not in the query.",
            ));
        } else if columns.iter().any(|c| nul(&c.column)) {
            problems.push(problem(
                ProblemTarget::Query,
                format!("A GROUP BY column {NUL_IN_NAME}"),
            ));
        } else if columns.iter().any(|c| c.column.is_empty()) {
            problems.push(problem(
                ProblemTarget::Query,
                "A GROUP BY row has no column. Pick one.",
            ));
        }
    }
    problems.extend(sort_problems(vq, &plan));
    problems
}

/// Nothing is ticked (so every column is selected) while a manual GROUP BY groups (item 37).
pub(crate) const NO_COLUMN_GROUPED: &str =
    "A grouped query needs ticked columns. Tick the ones to show.";
/// Every ticked column sits on a table left out by a pending pick.
pub(crate) const ALL_BEHIND_PENDING: &str =
    "Every ticked column is behind a Join that needs a key. Pick one first.";
pub(crate) const SELF_JOIN: &str =
    "A Join cannot join a table to itself. Add the table again for a self join.";
const NUL_IN_NAME: &str = "has a NUL character in a name. Remove it.";

fn filter_problem(
    kind: DialectKind,
    n: usize,
    filter: &VqFilter,
    types: &ColumnTypes,
) -> Option<String> {
    if filter.column.is_empty() {
        return Some(format!("Pick a column for filter {n}."));
    }
    let blank = |v: &String| v.trim().is_empty();
    let values = picked_values(filter);
    match filter.op {
        FilterOp::IsNull | FilterOp::IsNotNull => return None,
        FilterOp::In | FilterOp::NotIn if values.is_empty() => {
            return Some("IN needs at least one value.".into());
        }
        FilterOp::Between if values.len() < 2 || values.iter().any(blank) => {
            return Some("BETWEEN needs two values.".into());
        }
        FilterOp::In | FilterOp::NotIn | FilterOp::Between => {}
        _ if values.first().is_none_or(blank) => {
            return Some(format!("Give filter {n} a value."));
        }
        _ => {}
    }
    let type_text = types
        .get(&filter.table)
        .and_then(|columns| columns.get(&filter.column))
        .map(String::as_str);
    let like = matches!(filter.op, FilterOp::Like | FilterOp::NotLike);
    values.iter().find_map(|v| {
        let written = if like {
            pattern(kind, v)
        } else {
            literal(kind, type_text, v)
        };
        written.err().map(|m| m.replace("{column}", &filter.column))
    })
}

/// The values a filter writes, as `check` judges them and the generator writes
/// them: IN items split and pooled from every entry, BETWEEN the first two,
/// IS NULL none, any other operator the first.
pub(crate) fn picked_values(filter: &VqFilter) -> Vec<String> {
    match filter.op {
        FilterOp::IsNull | FilterOp::IsNotNull => Vec::new(),
        FilterOp::In | FilterOp::NotIn => filter
            .values
            .iter()
            .flat_map(|v| split_in_list(v))
            .collect(),
        FilterOp::Between => filter.values.iter().take(2).cloned().collect(),
        _ => filter.values.iter().take(1).cloned().collect(),
    }
}

/// Sort rows the server would refuse: an output index that is gone; under D8,
/// while the query groups, a column that is not an output (or a listed GROUP
/// BY column), which fails on PostgreSQL and MySQL's `ONLY_FULL_GROUP_BY`; and
/// under DISTINCT, a column that is not an output, which both refuse too.
/// Sorts on a table left out by a pending pick are not written, so not judged.
fn sort_problems(vq: &VisualQuery, plan: &Plan) -> Vec<VqProblem> {
    let manual: Vec<&ColumnRef> = match &vq.group_by {
        GroupBy::Manual { columns } => columns.iter().filter(|c| plan.keeps(&c.table)).collect(),
        GroupBy::Auto => Vec::new(),
    };
    // Only what is written counts: a column on a table left out is no output.
    let written: Vec<&VqColumn> = vq.columns.iter().filter(|c| plan.keeps(&c.table)).collect();
    let groups = written.iter().any(|c| c.aggregate.is_some()) || !manual.is_empty();
    // Item 37: nothing ticked selects every column of every written table, so each is an output.
    let all = vq.columns.is_empty();
    let is_output = |table: &str, column: &str| {
        all || written
            .iter()
            .any(|c| c.aggregate.is_none() && c.table == table && c.column == column)
    };
    let grouped = |table: &str, column: &str| {
        is_output(table, column)
            || manual
                .iter()
                .any(|c| c.table == table && c.column == column)
    };
    vq.order_by
        .iter()
        .enumerate()
        .filter_map(|(index, sort)| {
            let message = match &sort.target {
                SortTarget::Output { index: output } if *output >= vq.columns.len() => format!(
                    "Sort {} names an output column that is no longer there. Pick another.",
                    index + 1
                ),
                SortTarget::Output { .. } => return None,
                SortTarget::Column { table, .. } if !plan.index.contains_key(table.as_str()) => {
                    format!("Sort {} names a table that is not in the query.", index + 1)
                }
                SortTarget::Column { table, .. } if !plan.keeps(table) => return None,
                SortTarget::Column { column, .. } if column.contains('\0') => {
                    format!("Sort {} {NUL_IN_NAME}", index + 1)
                }
                SortTarget::Column { column, .. } if column.is_empty() => {
                    format!("Sort {} has no column. Pick one.", index + 1)
                }
                SortTarget::Column { table, column } if groups && !grouped(table, column) => {
                    let alias = vq
                        .tables
                        .iter()
                        .find(|t| &t.id == table)
                        .map_or(table.as_str(), |t| t.alias.as_str());
                    format!(
                        "Sort by an output column when the query groups. {alias}.{column} is not in the output."
                    )
                }
                SortTarget::Column { table, column } if vq.distinct && !is_output(table, column) => {
                    "Sort by an output column when the query is Distinct.".to_string()
                }
                SortTarget::Column { .. } => return None,
            };
            Some(problem(ProblemTarget::Sort { index }, message))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::visual_query::{
        Aggregate, ColumnPair, ColumnRef, FilterOp, GroupBy, JoinKind, Joiner, SortDir, SortTarget,
        VqColumn, VqFilter, VqJoin, VqSort, VqTable,
    };
    use std::collections::HashMap;

    const PG: DialectKind = DialectKind::Postgres;
    const MY: DialectKind = DialectKind::MySql;
    const LITE: DialectKind = DialectKind::Sqlite;

    fn table(id: &str, name: &str, alias: &str) -> VqTable {
        VqTable {
            id: id.into(),
            schema: None,
            name: name.into(),
            alias: alias.into(),
            x: 0.0,
            y: 0.0,
        }
    }

    fn col(table: &str, column: &str, aggregate: Option<Aggregate>) -> VqColumn {
        VqColumn {
            table: table.into(),
            column: column.into(),
            alias: None,
            aggregate,
        }
    }

    fn filter(column: &str, op: FilterOp, values: &[&str]) -> VqFilter {
        VqFilter {
            joiner: Joiner::And,
            table: "t1".into(),
            column: column.into(),
            op,
            values: values.iter().map(|v| v.to_string()).collect(),
        }
    }

    fn join(id: &str, kind: JoinKind) -> VqJoin {
        VqJoin {
            id: id.into(),
            left: "t1".into(),
            right: "t2".into(),
            kind,
            on: vec![ColumnPair {
                left_column: "store_id".into(),
                right_column: "id".into(),
            }],
            pending: None,
        }
    }

    fn sort_column(table: &str, column: &str) -> VqSort {
        VqSort {
            target: SortTarget::Column {
                table: table.into(),
                column: column.into(),
            },
            dir: SortDir::Desc,
        }
    }

    /// orders o joined to stores s, ticking o.id.
    fn clean() -> VisualQuery {
        VisualQuery {
            version: 1,
            database: Some("app".into()),
            dialect: None,
            tables: vec![table("t1", "orders", "o"), table("t2", "stores", "s")],
            joins: vec![join("j1", JoinKind::Inner)],
            columns: vec![col("t1", "id", None)],
            filters: vec![],
            group_by: GroupBy::Auto,
            order_by: vec![],
            limit: Some(100),
            distinct: false,
        }
    }

    fn types() -> ColumnTypes {
        let mut orders = HashMap::new();
        orders.insert("id".to_string(), "integer".to_string());
        orders.insert("total".to_string(), "numeric(12,2)".to_string());
        orders.insert("status".to_string(), "text".to_string());
        let mut t = ColumnTypes::new();
        t.insert("t1".into(), orders);
        t
    }

    fn problems(kind: DialectKind, version: &str, vq: &VisualQuery) -> Vec<VqProblem> {
        check(kind, version, vq, &types())
    }

    fn one(target: ProblemTarget, message: &str) -> Vec<VqProblem> {
        vec![VqProblem {
            target,
            message: message.into(),
        }]
    }

    #[test]
    fn clean_query_has_no_problems() {
        for kind in [PG, MY, LITE] {
            assert_eq!(problems(kind, "3.45.1", &clean()), vec![]);
        }
    }

    #[test]
    fn newer_version_is_refused() {
        let mut vq = clean();
        vq.version = 2;
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Query,
                "This Visual Query was saved by a newer Contura. Update Contura to open it."
            )
        );
    }

    #[test]
    fn no_column_selects_all_and_is_no_problem() {
        // Item 37: nothing ticked reads every column, like Navicat.
        let mut vq = clean();
        vq.columns.clear();
        for kind in [PG, MY, LITE] {
            assert_eq!(problems(kind, "3.45.1", &vq), vec![]);
        }
    }

    #[test]
    fn no_column_with_distinct_sorts_by_any_column() {
        // `SELECT DISTINCT *` (or `o.*, s.*`) holds every column, so any column may sort it.
        let mut vq = clean();
        vq.columns.clear();
        vq.distinct = true;
        vq.order_by = vec![sort_column("t1", "status"), sort_column("t2", "name")];
        for kind in [PG, MY, LITE] {
            assert_eq!(problems(kind, "3.45.1", &vq), vec![]);
        }
    }

    #[test]
    fn no_column_with_a_manual_group_by_is_a_problem() {
        let mut vq = clean();
        vq.columns.clear();
        vq.group_by = GroupBy::Manual {
            columns: vec![ColumnRef {
                table: "t1".into(),
                column: "status".into(),
            }],
        };
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Columns,
                "A grouped query needs ticked columns. Tick the ones to show."
            )
        );
    }

    #[test]
    fn mysql_has_no_full_join() {
        let mut vq = clean();
        vq.joins = vec![join("j1", JoinKind::Full)];
        let expected = one(
            ProblemTarget::Join { id: "j1".into() },
            "MySQL has no FULL JOIN. Pick Left or Right.",
        );
        assert_eq!(problems(MY, "", &vq), expected);
        assert_eq!(problems(PG, "", &vq), vec![]);
        vq.joins = vec![join("j1", JoinKind::Right)];
        assert_eq!(problems(MY, "", &vq), vec![]);
    }

    #[test]
    fn old_sqlite_has_no_right_or_full_join() {
        let message = "RIGHT and FULL JOIN need SQLite 3.39 or later.";
        for kind in [JoinKind::Right, JoinKind::Full] {
            let mut vq = clean();
            vq.joins = vec![join("j1", kind)];
            assert_eq!(
                problems(LITE, "3.38.5", &vq),
                one(ProblemTarget::Join { id: "j1".into() }, message)
            );
            assert_eq!(problems(LITE, "3.39.0", &vq), vec![]);
            assert_eq!(problems(LITE, "3.45.1", &vq), vec![]);
            assert_eq!(problems(LITE, "4.0.0", &vq), vec![]);
        }
        let mut vq = clean();
        vq.joins = vec![join("j1", JoinKind::Left)];
        assert_eq!(problems(LITE, "3.30.0", &vq), vec![]);
    }

    #[test]
    fn filter_without_a_column() {
        let mut vq = clean();
        vq.filters = vec![
            filter("status", FilterOp::Eq, &["late"]),
            filter("", FilterOp::Eq, &["x"]),
        ];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Filter { index: 1 },
                "Pick a column for filter 2."
            )
        );
    }

    #[test]
    fn filter_without_a_value() {
        for values in [&[][..], &[""][..], &["  "][..]] {
            let mut vq = clean();
            vq.filters = vec![filter("status", FilterOp::Like, values)];
            assert_eq!(
                problems(PG, "", &vq),
                one(ProblemTarget::Filter { index: 0 }, "Give filter 1 a value.")
            );
        }
    }

    #[test]
    fn null_tests_need_no_value() {
        let mut vq = clean();
        vq.filters = vec![
            filter("status", FilterOp::IsNull, &[]),
            filter("status", FilterOp::IsNotNull, &[]),
        ];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn between_needs_two_values() {
        for values in [&["1"][..], &["1", ""][..], &[][..]] {
            let mut vq = clean();
            vq.filters = vec![filter("total", FilterOp::Between, values)];
            assert_eq!(
                problems(PG, "", &vq),
                one(
                    ProblemTarget::Filter { index: 0 },
                    "BETWEEN needs two values."
                )
            );
        }
        let mut vq = clean();
        vq.filters = vec![filter("total", FilterOp::Between, &["1", "2.5"])];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn in_needs_at_least_one_value() {
        for op in [FilterOp::In, FilterOp::NotIn] {
            for values in [&[][..], &[""][..], &[" , "][..]] {
                let mut vq = clean();
                vq.filters = vec![filter("status", op, values)];
                assert_eq!(
                    problems(PG, "", &vq),
                    one(
                        ProblemTarget::Filter { index: 0 },
                        "IN needs at least one value."
                    )
                );
            }
        }
        let mut vq = clean();
        vq.filters = vec![filter("status", FilterOp::In, &["'app', 'kiosk'"])];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn bad_number_names_the_column() {
        let mut vq = clean();
        vq.filters = vec![filter("total", FilterOp::Gt, &["12,5"])];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Filter { index: 0 },
                "total is a number column; 12,5 is not a number."
            )
        );
        vq.filters = vec![filter("id", FilterOp::In, &["1, x"])];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Filter { index: 0 },
                "id is a number column; x is not a number."
            )
        );
        vq.filters = vec![filter("total", FilterOp::Between, &["1", "lots"])];
        assert_eq!(
            problems(PG, "", &vq)[0].message,
            "total is a number column; lots is not a number."
        );
    }

    #[test]
    fn number_column_without_a_loaded_type_takes_any_value() {
        let mut vq = clean();
        vq.filters = vec![VqFilter {
            // stores is in the query, but no type is loaded for it.
            table: "t2".into(),
            ..filter("id", FilterOp::Eq, &["abc"])
        }];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn order_by_non_output_column_with_aggregate_is_a_problem() {
        let mut vq = clean();
        vq.columns = vec![
            col("t2", "name", None),
            col("t1", "id", Some(Aggregate::Count)),
        ];
        vq.order_by = vec![sort_column("t1", "placed_at")];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort by an output column when the query groups. o.placed_at is not in the output."
            )
        );
    }

    #[test]
    fn order_by_non_output_column_without_aggregate_is_fine() {
        let mut vq = clean();
        vq.columns = vec![col("t2", "name", None), col("t1", "id", None)];
        vq.order_by = vec![sort_column("t1", "placed_at")];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn order_by_output_column_while_grouping_is_fine() {
        let mut vq = clean();
        vq.columns = vec![
            col("t2", "name", None),
            col("t1", "id", Some(Aggregate::Count)),
        ];
        vq.order_by = vec![
            sort_column("t2", "name"),
            VqSort {
                target: SortTarget::Output { index: 1 },
                dir: SortDir::Desc,
            },
        ];
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn manual_group_by_allows_sorting_by_its_columns_only() {
        let mut vq = clean();
        vq.columns = vec![col("t1", "id", Some(Aggregate::Count))];
        vq.group_by = GroupBy::Manual {
            columns: vec![ColumnRef {
                table: "t2".into(),
                column: "city".into(),
            }],
        };
        vq.order_by = vec![sort_column("t2", "city"), sort_column("t2", "name")];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 1 },
                "Sort by an output column when the query groups. s.name is not in the output."
            )
        );
    }

    #[test]
    fn every_problem_is_listed_in_order() {
        let mut vq = clean();
        vq.columns = vec![col("gone", "id", None)];
        vq.joins = vec![join("j1", JoinKind::Full)];
        vq.filters = vec![
            filter("", FilterOp::Eq, &[]),
            filter("status", FilterOp::Eq, &[]),
        ];
        let targets: Vec<ProblemTarget> = problems(MY, "", &vq)
            .into_iter()
            .map(|p| p.target)
            .collect();
        assert_eq!(
            targets,
            vec![
                ProblemTarget::Columns,
                ProblemTarget::Join { id: "j1".into() },
                ProblemTarget::Filter { index: 0 },
                ProblemTarget::Filter { index: 1 },
            ]
        );
    }

    #[test]
    fn problem_serializes_with_a_kind_tag() {
        let p = VqProblem {
            target: ProblemTarget::Filter { index: 2 },
            message: "m".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["target"]["kind"], "filter");
        assert_eq!(v["target"]["index"], 2);
    }

    #[test]
    fn distinct_sort_by_a_non_output_column_is_a_problem() {
        let mut vq = clean();
        vq.distinct = true;
        vq.order_by = vec![sort_column("t1", "status"), sort_column("t1", "id")];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort by an output column when the query is Distinct."
            )
        );
        vq.distinct = false;
        assert_eq!(problems(PG, "", &vq), vec![]);
    }

    #[test]
    fn distinct_while_grouping_keeps_the_group_message() {
        let mut vq = clean();
        vq.distinct = true;
        vq.columns = vec![
            col("t2", "name", None),
            col("t1", "id", Some(Aggregate::Count)),
        ];
        vq.order_by = vec![sort_column("t1", "placed_at")];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort by an output column when the query groups. o.placed_at is not in the output."
            )
        );
    }

    #[test]
    fn sort_by_a_missing_output_index_is_a_problem() {
        let mut vq = clean();
        vq.order_by = vec![
            VqSort {
                target: SortTarget::Output { index: 0 },
                dir: SortDir::Asc,
            },
            VqSort {
                target: SortTarget::Output { index: 1 },
                dir: SortDir::Asc,
            },
        ];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 1 },
                "Sort 2 names an output column that is no longer there. Pick another."
            )
        );
    }

    #[test]
    fn nul_in_a_filter_value_is_a_problem() {
        let mut vq = clean();
        vq.filters = vec![
            filter("status", FilterOp::Eq, &["late"]),
            filter("status", FilterOp::In, &["a, b\0c"]),
        ];
        assert_eq!(
            problems(MY, "", &vq),
            one(
                ProblemTarget::Filter { index: 1 },
                "A value for status has a NUL character. Remove it."
            )
        );
    }

    #[test]
    fn array_column_takes_an_array_literal() {
        let mut t = types();
        t.get_mut("t1")
            .unwrap()
            .insert("tags".into(), "integer[]".into());
        let mut vq = clean();
        vq.filters = vec![filter("tags", FilterOp::Eq, &["{1,2}"])];
        assert_eq!(check(PG, "", &vq, &t), vec![]);
    }

    #[test]
    fn filters_and_sorts_left_out_by_a_pending_pick_are_not_judged() {
        let mut t = types();
        let mut stores = HashMap::new();
        stores.insert("rating".to_string(), "integer".to_string());
        t.insert("t2".into(), stores);
        let mut vq = clean();
        vq.tables.push(table("t3", "regions", "r"));
        vq.joins = vec![
            VqJoin {
                pending: Some(vec![]),
                ..join("j1", JoinKind::Inner)
            },
            VqJoin {
                id: "j2".into(),
                left: "t2".into(),
                right: "t3".into(),
                ..join("j2", JoinKind::Inner)
            },
        ];
        vq.columns = vec![col("t1", "id", Some(Aggregate::Count))];
        vq.filters = vec![
            VqFilter {
                table: "t2".into(),
                ..filter("rating", FilterOp::Gt, &["lots"])
            },
            VqFilter {
                table: "t3".into(),
                ..filter("", FilterOp::Eq, &[])
            },
            filter("total", FilterOp::Gt, &["lots"]),
        ];
        vq.order_by = vec![sort_column("t2", "name"), sort_column("t3", "name")];
        assert_eq!(
            check(PG, "", &vq, &t),
            one(
                ProblemTarget::Filter { index: 2 },
                "total is a number column; lots is not a number."
            )
        );
        vq.filters.pop();
        let p = crate::visual_query::preview(PG, "", &vq, &t);
        assert_eq!(p.problems, vec![]);
        assert!(p.query.is_some());
    }

    #[test]
    fn sqlite_judges_the_join_kind_after_the_swap() {
        // stores is the root, so the Left Join orders -> stores is reached from
        // its right side and written as RIGHT JOIN.
        let mut vq = clean();
        vq.tables.reverse();
        vq.joins = vec![join("j1", JoinKind::Left)];
        assert_eq!(
            problems(LITE, "3.38.5", &vq),
            one(
                ProblemTarget::Join { id: "j1".into() },
                "RIGHT and FULL JOIN need SQLite 3.39 or later."
            )
        );
        assert_eq!(problems(LITE, "3.39.0", &vq), vec![]);
        // A model Right Join reached from its right side is written LEFT: fine.
        vq.joins = vec![join("j1", JoinKind::Right)];
        assert_eq!(problems(LITE, "3.38.5", &vq), vec![]);
    }

    #[test]
    fn sort_is_not_flagged_when_the_only_aggregate_is_left_out() {
        let mut vq = clean();
        vq.joins = vec![VqJoin {
            on: vec![],
            pending: Some(vec![]),
            ..join("j1", JoinKind::Inner)
        }];
        vq.columns = vec![
            col("t1", "id", None),
            col("t2", "id", Some(Aggregate::Count)),
        ];
        vq.order_by = vec![sort_column("t1", "placed_at")];
        assert_eq!(problems(PG, "", &vq), vec![]);
        // With the aggregate on a written table, the same sort is flagged.
        vq.columns[1].table = "t1".into();
        assert_eq!(problems(PG, "", &vq).len(), 1);
    }

    #[test]
    fn every_column_left_out_is_a_columns_problem() {
        let mut vq = clean();
        vq.joins = vec![VqJoin {
            on: vec![],
            pending: Some(vec![]),
            ..join("j1", JoinKind::Inner)
        }];
        vq.columns = vec![col("t2", "name", None)];
        assert_eq!(
            problems(PG, "", &vq),
            one(ProblemTarget::Columns, ALL_BEHIND_PENDING)
        );
    }

    #[test]
    fn a_join_without_pairs_is_not_judged_and_leaves_nothing_out() {
        let mut vq = clean();
        vq.joins = vec![VqJoin {
            on: vec![],
            ..join("j1", JoinKind::Full)
        }];
        vq.columns = vec![col("t2", "name", None)];
        vq.filters = vec![VqFilter {
            table: "t2".into(),
            ..filter("name", FilterOp::Eq, &[])
        }];
        // stores is a CROSS JOIN, so its column and filter are written and judged;
        // the Join writes nothing, so even SQLite 3.38 has no problem with it.
        assert_eq!(
            problems(LITE, "3.38.5", &vq),
            one(ProblemTarget::Filter { index: 0 }, "Give filter 1 a value.")
        );
    }

    #[test]
    fn nul_in_a_name_is_a_problem_on_its_field() {
        let nul = "na\0me";
        let mut vq = clean();
        vq.tables[1].name = nul.into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Table { id: "t2".into() },
                "A table name, schema or alias has a NUL character. Remove it."
            )
        );
        let mut vq = clean();
        vq.tables[0].schema = Some(nul.into());
        assert_eq!(
            problems(PG, "", &vq)[0].target,
            ProblemTarget::Table { id: "t1".into() }
        );
        let mut vq = clean();
        vq.tables[0].alias = nul.into();
        assert_eq!(
            problems(PG, "", &vq)[0].target,
            ProblemTarget::Table { id: "t1".into() }
        );
        let mut vq = clean();
        vq.columns[0].column = nul.into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Columns,
                "Column 1 has a NUL character in a name. Remove it."
            )
        );
        let mut vq = clean();
        vq.columns[0].alias = Some(nul.into());
        assert_eq!(problems(PG, "", &vq)[0].target, ProblemTarget::Columns);
        let mut vq = clean();
        vq.joins[0].on[0].right_column = nul.into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Join { id: "j1".into() },
                "This Join has a NUL character in a name. Remove it."
            )
        );
        let mut vq = clean();
        vq.filters = vec![filter(nul, FilterOp::IsNull, &[])];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Filter { index: 0 },
                "Filter 1 has a NUL character in a name. Remove it."
            )
        );
        let mut vq = clean();
        vq.order_by = vec![sort_column("t1", nul)];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort 1 has a NUL character in a name. Remove it."
            )
        );
    }

    #[test]
    fn aliases_must_be_given_and_distinct() {
        let mut vq = clean();
        vq.tables[1].alias = "O".into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Table { id: "t2".into() },
                "Alias O is used by two tables. Give each its own."
            )
        );
        vq.tables[1].alias = " ".into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Table { id: "t2".into() },
                "Give every table an alias."
            )
        );
    }

    #[test]
    fn unknown_tables_and_self_joins_are_problems() {
        let mut vq = clean();
        vq.joins = vec![VqJoin {
            right: "t1".into(),
            ..join("j1", JoinKind::Inner)
        }];
        assert_eq!(
            problems(PG, "", &vq),
            one(ProblemTarget::Join { id: "j1".into() }, SELF_JOIN)
        );
        let mut vq = clean();
        vq.columns[0].table = "gone".into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Columns,
                "Column 1 names a table that is not in the query."
            )
        );
        let mut vq = clean();
        vq.order_by = vec![sort_column("gone", "id")];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort 1 names a table that is not in the query."
            )
        );
        let mut vq = clean();
        vq.group_by = GroupBy::Manual {
            columns: vec![ColumnRef {
                table: "gone".into(),
                column: "id".into(),
            }],
        };
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Query,
                "A GROUP BY column names a table that is not in the query."
            )
        );
        let mut vq = clean();
        vq.tables.push(table("t1", "orders", "o2"));
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Query,
                "Two table cards share one id. Remove one and add it again."
            )
        );
    }

    #[test]
    fn mysql_full_is_judged_only_when_written() {
        let mut vq = clean();
        vq.joins = vec![VqJoin {
            on: vec![],
            ..join("j1", JoinKind::Full)
        }];
        // No pairs: stores is a CROSS JOIN and no FULL JOIN is written.
        assert_eq!(problems(MY, "", &vq), vec![]);
        vq.joins[0].pending = Some(vec![]);
        vq.columns = vec![col("t1", "id", None)];
        // Pending: nothing is written for it yet.
        assert_eq!(problems(MY, "", &vq), vec![]);
        vq.joins = vec![join("j1", JoinKind::Full)];
        assert_eq!(
            problems(MY, "", &vq),
            one(
                ProblemTarget::Join { id: "j1".into() },
                "MySQL has no FULL JOIN. Pick Left or Right."
            )
        );
    }

    #[test]
    fn a_join_to_an_unknown_table_is_a_problem_on_the_join() {
        let mut vq = clean();
        vq.joins[0].right = "gone".into();
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Join { id: "j1".into() },
                "This Join names a table that is not in the query."
            )
        );
        let mut vq = clean();
        vq.joins[0].left = "gone".into();
        assert_eq!(problems(PG, "", &vq).len(), 1);
    }

    #[test]
    fn nul_in_the_database_or_a_group_by_column_is_a_problem() {
        let mut vq = clean();
        vq.database = Some("ap\0p".into());
        assert_eq!(
            problems(MY, "", &vq),
            one(
                ProblemTarget::Query,
                "The database name has a NUL character. Remove it."
            )
        );
        let mut vq = clean();
        vq.group_by = GroupBy::Manual {
            columns: vec![ColumnRef {
                table: "t1".into(),
                column: "i\0d".into(),
            }],
        };
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Query,
                "A GROUP BY column has a NUL character in a name. Remove it."
            )
        );
    }

    #[test]
    fn like_takes_any_pattern_on_a_number_column() {
        let mut vq = clean();
        for op in [FilterOp::Like, FilterOp::NotLike] {
            vq.filters = vec![filter("id", op, &["12%"])];
            for kind in [PG, MY, LITE] {
                assert_eq!(problems(kind, "", &vq), vec![], "{kind:?}");
            }
        }
        vq.filters = vec![filter("id", FilterOp::Like, &["1\0%"])];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Filter { index: 0 },
                "A value for id has a NUL character. Remove it."
            )
        );
    }

    #[test]
    fn empty_names_are_problems_on_their_field() {
        let mut vq = clean();
        vq.columns = vec![col("t1", "", None)];
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Columns,
                "Column 1 has no column name. Pick one."
            )
        );
        let mut vq = clean();
        vq.joins[0].on[0].right_column = String::new();
        assert_eq!(
            problems(MY, "", &vq),
            one(
                ProblemTarget::Join { id: "j1".into() },
                "Pick both columns of every pair in this Join."
            )
        );
        let mut vq = clean();
        vq.order_by = vec![sort_column("t1", "")];
        assert_eq!(
            problems(LITE, "", &vq),
            one(
                ProblemTarget::Sort { index: 0 },
                "Sort 1 has no column. Pick one."
            )
        );
        let mut vq = clean();
        vq.group_by = GroupBy::Manual {
            columns: vec![ColumnRef {
                table: "t1".into(),
                column: String::new(),
            }],
        };
        assert_eq!(
            problems(PG, "", &vq),
            one(
                ProblemTarget::Query,
                "A GROUP BY row has no column. Pick one."
            )
        );
    }

    #[test]
    fn a_model_built_for_another_dialect_is_refused() {
        let mut vq = clean();
        vq.dialect = Some(PG);
        assert_eq!(problems(PG, "", &vq), vec![]);
        assert_eq!(
            problems(MY, "", &vq),
            one(
                ProblemTarget::Query,
                "This Visual Query was built for PostgreSQL. Open it on a PostgreSQL Connection."
            )
        );
    }

    #[test]
    fn problem_target_table_serializes_with_its_id() {
        let v = serde_json::to_value(ProblemTarget::Table { id: "t1".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "table", "id": "t1" }));
    }
}
