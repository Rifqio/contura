//! The SQL text a Visual Query turns into, per Dialect.

use super::check::{ALL_BEHIND_PENDING, SELF_JOIN, picked_values};
use super::literal::{is_number_column, literal, pattern};
use super::names::bare_ident;
use super::plan::{Entry, Plan, plan};
use super::{
    Aggregate, ColumnTypes, FilterOp, GroupBy, JoinKind, Joiner, ProblemTarget, SortDir,
    SortTarget, VisualQuery, VqColumn, VqFilter, VqJoin, VqProblem, VqTable, check,
};
use crate::error::{Error, Result};
use crate::model::DialectKind;
use crate::safety::{StatementClass, classify, leading_word, statement_count};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedQuery {
    pub sql: String,
    pub parts: Vec<SqlPart>,
    /// Each output column's final name, in SELECT order (D7).
    pub outputs: Vec<String>,
    pub warnings: Vec<VqWarning>,
}

/// The lines of the text one piece of the model wrote, 1-based and inclusive.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlPart {
    pub part: PartKind,
    pub from_line: u32,
    pub to_line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PartKind {
    Select,
    /// The FROM line of the root, or the CROSS JOIN line of a table no Join reaches.
    From {
        table: String,
    },
    Join {
        join: String,
    },
    Where {
        filter: usize,
    },
    GroupBy,
    OrderBy,
    Limit,
}

/// `table` is a table id. `rows` is always `None` from the Core (D17).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VqWarning {
    CrossJoin { table: String, rows: Option<u64> },
    PendingPick { table: String },
    LeftOut { table: String, columns: Vec<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqPreview {
    pub query: Option<GeneratedQuery>,
    pub problems: Vec<VqProblem>,
}

/// The SQL text of `vq`. Refuses with the first problem `check` finds (D4), and
/// refuses its own text unless `classify` reads it as a read.
pub fn generate(
    kind: DialectKind,
    server_version: &str,
    vq: &VisualQuery,
    types: &ColumnTypes,
) -> Result<GeneratedQuery> {
    if let Some(first) = check(kind, server_version, vq, types).into_iter().next() {
        return Err(Error::InvalidInput(first.message));
    }
    write_checked(kind, vq, types)
}

/// The text of a query `check` already passed.
fn write_checked(
    kind: DialectKind,
    vq: &VisualQuery,
    types: &ColumnTypes,
) -> Result<GeneratedQuery> {
    let query = Writer::new(kind, vq, types)?.write()?;
    // Read, one statement, and a SELECT: true by construction, checked anyway.
    let one_select = statement_count(kind, &query.sql) == 1
        && leading_word(kind, &query.sql).is_some_and(|w| w.eq_ignore_ascii_case("SELECT"));
    if classify(kind, &query.sql) != StatementClass::Read || !one_select {
        return Err(Error::InvalidInput(
            "The generated SQL does not read as a SELECT, so it was not used.".into(),
        ));
    }
    Ok(query)
}

/// What the SQL pane shows: every problem, or the query when there are none.
pub fn preview(
    kind: DialectKind,
    server_version: &str,
    vq: &VisualQuery,
    types: &ColumnTypes,
) -> VqPreview {
    let problems = check(kind, server_version, vq, types);
    if !problems.is_empty() {
        return VqPreview {
            query: None,
            problems,
        };
    }
    match write_checked(kind, vq, types) {
        Ok(query) => VqPreview {
            query: Some(query),
            problems,
        },
        Err(e) => VqPreview {
            query: None,
            problems: vec![VqProblem {
                target: ProblemTarget::Query,
                message: match e {
                    Error::InvalidInput(m) => m,
                    other => other.to_string(),
                },
            }],
        },
    }
}

/// The row limit; every Dialect so far writes `LIMIT n`.
fn limit_clause(kind: DialectKind, n: u64) -> String {
    match kind {
        DialectKind::MySql | DialectKind::Postgres | DialectKind::Sqlite => format!("LIMIT {n}"),
    }
}

struct Writer<'a> {
    kind: DialectKind,
    vq: &'a VisualQuery,
    types: &'a ColumnTypes,
    plan: Plan<'a>,
    warnings: Vec<VqWarning>,
}

impl<'a> Writer<'a> {
    fn new(kind: DialectKind, vq: &'a VisualQuery, types: &'a ColumnTypes) -> Result<Self> {
        let plan = plan(vq);
        if !plan.self_joins.is_empty() {
            return Err(Error::InvalidInput(SELF_JOIN.into()));
        }
        let mut warnings = Vec::new();
        for (t, entry) in &plan.order {
            if *entry == Entry::Cross {
                warnings.push(VqWarning::CrossJoin {
                    table: vq.tables[*t].id.clone(),
                    rows: None,
                });
            }
        }
        for out in &plan.left_out {
            let id = &vq.tables[out.table].id;
            warnings.push(if out.behind_pick {
                VqWarning::PendingPick { table: id.clone() }
            } else {
                VqWarning::LeftOut {
                    table: id.clone(),
                    columns: vq
                        .columns
                        .iter()
                        .filter(|c| &c.table == id)
                        .map(|c| c.column.clone())
                        .collect(),
                }
            });
        }
        Ok(Writer {
            kind,
            vq,
            types,
            plan,
            warnings,
        })
    }

    fn ends(&self, join: &VqJoin) -> Result<(usize, usize)> {
        self.plan.ends(join).ok_or_else(|| {
            Error::InvalidInput(format!(
                "Join {} names a table that is not in the query.",
                join.id
            ))
        })
    }

    /// A Join's pairs as `new = old`, the newly written table first.
    fn pairs(&self, join: &VqJoin, l: usize, r: usize, new_is_left: bool) -> Vec<String> {
        join.on
            .iter()
            .map(|p| {
                let left = self.qualified(l, &p.left_column);
                let right = self.qualified(r, &p.right_column);
                if new_is_left {
                    format!("{left} = {right}")
                } else {
                    format!("{right} = {left}")
                }
            })
            .collect()
    }

    /// An output column's expression: `o.id`, `count(o.id)`, `count(DISTINCT o.id)`.
    fn expression(&self, table: usize, c: &VqColumn) -> String {
        let column = self.qualified(table, &c.column);
        match c.aggregate {
            None => column,
            Some(Aggregate::Count) => format!("count({column})"),
            Some(Aggregate::CountDistinct) => format!("count(DISTINCT {column})"),
            Some(Aggregate::Sum) => format!("sum({column})"),
            Some(Aggregate::Avg) => format!("avg({column})"),
            Some(Aggregate::Min) => format!("min({column})"),
            Some(Aggregate::Max) => format!("max({column})"),
        }
    }

    fn ident(&self, name: &str) -> String {
        bare_ident(self.kind, name)
    }

    fn qualified(&self, table: usize, column: &str) -> String {
        format!(
            "{}.{}",
            self.ident(&self.vq.tables[table].alias),
            self.ident(column)
        )
    }

    /// The table as FROM names it (D6, P1): PostgreSQL `schema.table`, or the
    /// bare table, left to `search_path`, for a card with no schema;
    /// MySQL `db.table` outside the tab's database; SQLite `scope.table` for an
    /// attached database.
    fn table_name(&self, table: &VqTable) -> String {
        let scope = match (self.kind, table.schema.as_deref()) {
            (_, None) => None,
            (DialectKind::Postgres, Some(s)) => Some(s),
            (DialectKind::MySql, Some(s)) => (Some(s) != self.vq.database.as_deref()).then_some(s),
            (DialectKind::Sqlite, Some(s)) => {
                (s != "main" && Some(s) != self.vq.database.as_deref()).then_some(s)
            }
        };
        match scope {
            Some(s) => format!("{}.{}", self.ident(s), self.ident(&table.name)),
            None => self.ident(&table.name),
        }
    }

    fn table_of(&self, id: &str, what: impl FnOnce() -> String) -> Result<usize> {
        self.plan
            .index
            .get(id)
            .copied()
            .ok_or_else(|| Error::InvalidInput(what()))
    }

    fn write(self) -> Result<GeneratedQuery> {
        let vq = self.vq;
        // Output columns that are written, with their index in `vq.columns`.
        let mut written: Vec<(usize, usize)> = Vec::new();
        for (i, c) in vq.columns.iter().enumerate() {
            let t = self.table_of(&c.table, || {
                format!("Column {} names a table that is not in the query.", i + 1)
            })?;
            if self.plan.kept.contains(&t) {
                written.push((i, t));
            }
        }
        if written.is_empty() {
            return Err(Error::InvalidInput(ALL_BEHIND_PENDING.into()));
        }
        let names = output_names(vq, &written);
        let mut lines: Vec<String> = Vec::new();
        let mut parts: Vec<SqlPart> = Vec::new();
        let mut push = |lines: &mut Vec<String>, part: PartKind, text: Vec<String>| {
            let from = lines.len() as u32 + 1;
            lines.extend(text);
            parts.push(SqlPart {
                part,
                from_line: from,
                to_line: lines.len() as u32,
            });
        };

        // SELECT
        let head = if vq.distinct {
            "SELECT DISTINCT "
        } else {
            "SELECT "
        };
        let pad = " ".repeat(head.len());
        let count = written.len();
        let select: Vec<String> = written
            .iter()
            .zip(&names)
            .enumerate()
            .map(|(n, ((i, t), name))| {
                let c = &vq.columns[*i];
                let expr = self.expression(*t, c);
                let item = if carries_as(c, name) {
                    format!("{expr} AS {}", self.ident(name))
                } else {
                    expr
                };
                let lead = if n == 0 { head } else { pad.as_str() };
                let comma = if n + 1 < count { "," } else { "" };
                format!("{lead}{item}{comma}")
            })
            .collect();
        push(&mut lines, PartKind::Select, select);

        // FROM and Joins
        for (t, entry) in &self.plan.order {
            let table = &vq.tables[*t];
            let named = format!("{} AS {}", self.table_name(table), self.ident(&table.alias));
            match entry {
                Entry::Root => push(
                    &mut lines,
                    PartKind::From {
                        table: table.id.clone(),
                    },
                    vec![format!("FROM {named}")],
                ),
                Entry::Cross => push(
                    &mut lines,
                    PartKind::From {
                        table: table.id.clone(),
                    },
                    vec![format!("CROSS JOIN {named}")],
                ),
                Entry::Join {
                    join,
                    from_right,
                    kind,
                } => {
                    let j = &vq.joins[*join];
                    let (l, r) = self.ends(j)?;
                    let keyword = match kind {
                        JoinKind::Inner => "JOIN",
                        JoinKind::Left => "LEFT JOIN",
                        JoinKind::Right => "RIGHT JOIN",
                        JoinKind::Full => "FULL JOIN",
                    };
                    let mut on = self.pairs(j, l, r, *from_right);
                    for c in self.plan.cycles.get(t).into_iter().flatten() {
                        let cycle = &vq.joins[*c];
                        let (cl, cr) = self.ends(cycle)?;
                        on.extend(self.pairs(cycle, cl, cr, cl == *t));
                    }
                    push(
                        &mut lines,
                        PartKind::Join { join: j.id.clone() },
                        vec![format!("{keyword} {named} ON {}", on.join(" AND "))],
                    );
                }
            }
        }

        // WHERE
        let mut first = true;
        for (i, f) in vq.filters.iter().enumerate() {
            let t = self.table_of(&f.table, || {
                format!("Filter {} names a table that is not in the query.", i + 1)
            })?;
            if !self.plan.kept.contains(&t) {
                continue;
            }
            let lead = match (first, f.joiner) {
                (true, _) => "WHERE ",
                (false, Joiner::And) => "  AND ",
                (false, Joiner::Or) => "  OR ",
            };
            first = false;
            let cond = self.condition(t, f)?;
            push(
                &mut lines,
                PartKind::Where { filter: i },
                vec![format!("{lead}{cond}")],
            );
        }

        // GROUP BY
        let mut group: Vec<String> = Vec::new();
        match &vq.group_by {
            GroupBy::Auto => {
                if written
                    .iter()
                    .any(|(i, _)| vq.columns[*i].aggregate.is_some())
                {
                    for (i, t) in &written {
                        let c = &vq.columns[*i];
                        if c.aggregate.is_none() {
                            group.push(self.qualified(*t, &c.column));
                        }
                    }
                }
            }
            GroupBy::Manual { columns } => {
                for c in columns {
                    let t = self.table_of(&c.table, || {
                        "A GROUP BY column names a table that is not in the query.".into()
                    })?;
                    if self.plan.kept.contains(&t) {
                        group.push(self.qualified(t, &c.column));
                    }
                }
            }
        }
        let mut seen = HashSet::new();
        group.retain(|g| seen.insert(g.clone()));
        if !group.is_empty() {
            push(
                &mut lines,
                PartKind::GroupBy,
                vec![format!("GROUP BY {}", group.join(", "))],
            );
        }

        // ORDER BY
        let mut sorts: Vec<String> = Vec::new();
        for (n, s) in vq.order_by.iter().enumerate() {
            let target = match &s.target {
                SortTarget::Output { index } => {
                    if *index >= vq.columns.len() {
                        return Err(Error::InvalidInput(format!(
                            "Sort {} names an output column that is no longer there. Pick another.",
                            n + 1
                        )));
                    }
                    let Some(p) = written.iter().position(|(i, _)| i == index) else {
                        continue;
                    };
                    // Ruling V2: an output the user named sorts by that name, but
                    // only when the SELECT item carries AS; any other sorts by its
                    // expression. SQLite reads a name with no AS as an input
                    // column, ambiguous when two tables have it.
                    let c = &vq.columns[*index];
                    let typed = c.alias.as_deref().is_some_and(|a| !a.trim().is_empty());
                    if typed && carries_as(c, &names[p]) {
                        self.ident(&names[p])
                    } else {
                        self.expression(written[p].1, c)
                    }
                }
                SortTarget::Column { table, column } => {
                    let t = self.table_of(table, || {
                        format!("Sort {} names a table that is not in the query.", n + 1)
                    })?;
                    if !self.plan.kept.contains(&t) {
                        continue;
                    }
                    self.qualified(t, column)
                }
            };
            sorts.push(match s.dir {
                SortDir::Asc => target,
                SortDir::Desc => format!("{target} DESC"),
            });
        }
        if !sorts.is_empty() {
            push(
                &mut lines,
                PartKind::OrderBy,
                vec![format!("ORDER BY {}", sorts.join(", "))],
            );
        }

        if let Some(n) = vq.limit {
            push(
                &mut lines,
                PartKind::Limit,
                vec![limit_clause(self.kind, n)],
            );
        }

        Ok(GeneratedQuery {
            sql: lines.join("\n"),
            parts,
            outputs: names,
            warnings: self.warnings,
        })
    }

    /// One filter's condition. Values are picked and written exactly as
    /// `check` judged them.
    fn condition(&self, t: usize, f: &VqFilter) -> Result<String> {
        let column = self.qualified(t, &f.column);
        let type_text = self
            .types
            .get(&f.table)
            .and_then(|c| c.get(&f.column))
            .map(String::as_str);
        let like = matches!(f.op, FilterOp::Like | FilterOp::NotLike);
        // V10: a pattern is text on any column; PostgreSQL has no LIKE on a
        // number, so the column is cast to text there.
        let column =
            if like && self.kind == DialectKind::Postgres && is_number_column(self.kind, type_text)
            {
                format!("{column}::text")
            } else {
                column
            };
        let values = picked_values(f)
            .iter()
            .map(|v| {
                if like {
                    pattern(self.kind, v)
                } else {
                    literal(self.kind, type_text, v)
                }
            })
            .collect::<std::result::Result<Vec<String>, String>>()
            .map_err(|m| Error::InvalidInput(m.replace("{column}", &f.column)))?;
        let one = || {
            values
                .first()
                .cloned()
                .ok_or_else(|| Error::InvalidInput("A filter is missing its value.".to_string()))
        };
        Ok(match f.op {
            FilterOp::Eq => format!("{column} = {}", one()?),
            FilterOp::Ne => format!("{column} <> {}", one()?),
            FilterOp::Lt => format!("{column} < {}", one()?),
            FilterOp::Le => format!("{column} <= {}", one()?),
            FilterOp::Gt => format!("{column} > {}", one()?),
            FilterOp::Ge => format!("{column} >= {}", one()?),
            FilterOp::Like => format!("{column} LIKE {}", one()?),
            FilterOp::NotLike => format!("{column} NOT LIKE {}", one()?),
            FilterOp::In | FilterOp::NotIn => {
                if values.is_empty() {
                    return Err(Error::InvalidInput("IN needs at least one value.".into()));
                }
                let not = if f.op == FilterOp::NotIn { "NOT " } else { "" };
                format!("{column} {not}IN ({})", values.join(", "))
            }
            FilterOp::Between => match values.as_slice() {
                [low, high] => format!("{column} BETWEEN {low} AND {high}"),
                _ => return Err(Error::InvalidInput("BETWEEN needs two values.".into())),
            },
            FilterOp::IsNull => format!("{column} IS NULL"),
            FilterOp::IsNotNull => format!("{column} IS NOT NULL"),
        })
    }
}

/// Each written output's final name (D7). A user's name is kept; a plain
/// column keeps its own name unless another output has it, then
/// `<alias>_<column>`; an aggregate is `<aggregate>_<column>`; a name already
/// taken gets `_2`, `_3`, ... Names compare without case.
fn output_names(vq: &VisualQuery, written: &[(usize, usize)]) -> Vec<String> {
    let typed = |i: usize| {
        vq.columns[i]
            .alias
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string)
    };
    let first: Vec<String> = written
        .iter()
        .map(|(i, _)| {
            let c = &vq.columns[*i];
            typed(*i).unwrap_or_else(|| match c.aggregate {
                None => c.column.clone(),
                Some(a) => format!("{}_{}", aggregate_word(a), c.column),
            })
        })
        .collect();
    let lower: Vec<String> = first.iter().map(|n| n.to_lowercase()).collect();
    let candidates: Vec<String> = written
        .iter()
        .enumerate()
        .map(|(n, (i, t))| {
            let c = &vq.columns[*i];
            let clash = lower
                .iter()
                .enumerate()
                .any(|(m, other)| m != n && *other == lower[n]);
            if typed(*i).is_none() && c.aggregate.is_none() && clash {
                format!("{}_{}", vq.tables[*t].alias, c.column)
            } else {
                first[n].clone()
            }
        })
        .collect();
    // Typed names claim theirs first, then defaults in order.
    let mut taken: HashSet<String> = HashSet::new();
    let mut out: Vec<Option<String>> = vec![None; candidates.len()];
    let typed_first = (0..candidates.len())
        .filter(|n| typed(written[*n].0).is_some())
        .chain((0..candidates.len()).filter(|n| typed(written[*n].0).is_none()));
    for n in typed_first {
        let base = &candidates[n];
        let mut name = base.clone();
        let mut k = 2;
        while !taken.insert(name.to_lowercase()) {
            name = format!("{base}_{k}");
            k += 1;
        }
        out[n] = Some(name);
    }
    out.into_iter().map(|n| n.unwrap_or_default()).collect()
}

/// Whether the SELECT item is written `<expression> AS <name>`: every
/// aggregate, and a plain column whose final name differs from the column.
fn carries_as(c: &VqColumn, name: &str) -> bool {
    c.aggregate.is_some() || name != c.column
}

fn aggregate_word(a: Aggregate) -> &'static str {
    match a {
        Aggregate::Count => "count",
        Aggregate::CountDistinct => "count_distinct",
        Aggregate::Sum => "sum",
        Aggregate::Avg => "avg",
        Aggregate::Min => "min",
        Aggregate::Max => "max",
    }
}

#[cfg(test)]
mod tests {
    //! Golden cases live in `golden/`: `<case>.json` (`{ query, types, outputs,
    //! warnings? }`), overridden per Dialect by `<case>.<dialect>.json` (P3), the
    //! expected text in `<case>.<dialect>.sql`, and the hand-written PostgreSQL
    //! shape in `<case>.shape.json` (P5, read by the query diagram's tests).
    //! On PostgreSQL a table whose `schema` is null in the golden model is read
    //! as `public`, so most cases need no PostgreSQL override.
    //! `CONTURA_BLESS=1` rewrites the `.sql` files from the generator.

    use super::*;
    use crate::error::Error;
    use crate::safety::{StatementClass, classify};
    use crate::visual_query::check;
    use crate::visual_query::names::bare_ident;
    use crate::visual_query::{
        Aggregate, FilterOp, GroupBy, Joiner, SortDir, SortTarget, VqColumn, VqFilter, VqSort,
        VqTable,
    };
    use std::fs;
    use std::path::PathBuf;

    const CASES: &[&str] = &[
        "late_orders_by_store",
        "single_table",
        "inner_left_right_full",
        "composite_on",
        "swap_when_reached_from_right",
        "cycle_condition_anded",
        "cross_join_groups",
        "pending_pick_leaves_out",
        "both_with_s2",
        "self_join_two_aliases",
        "root_removed_chain",
        "aggregates_and_default_names",
        "auto_group_by",
        "manual_group_by",
        "no_aggregate_no_group_by",
        "order_by_output_and_column",
        "limit_and_distinct",
        "literals",
        "names",
        "qualification",
        "empty_on_cross_join",
        "alias_equals_column",
    ];

    const DIALECTS: [(DialectKind, &str); 3] = [
        (DialectKind::MySql, "mysql"),
        (DialectKind::Postgres, "postgres"),
        (DialectKind::Sqlite, "sqlite"),
    ];

    #[derive(Deserialize)]
    struct Case {
        query: VisualQuery,
        #[serde(default)]
        types: ColumnTypes,
        outputs: Vec<String>,
        #[serde(default)]
        warnings: Option<Vec<VqWarning>>,
    }

    fn golden() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/visual_query/golden")
    }

    fn read(path: &PathBuf) -> String {
        fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
            .replace("\r\n", "\n")
    }

    fn version(kind: DialectKind) -> &'static str {
        if kind == DialectKind::Sqlite {
            rusqlite::version()
        } else {
            ""
        }
    }

    /// The case's model for one Dialect; `name` picks the override file, so a
    /// name with no override (such as "default") reads `<case>.json`.
    fn load(case: &str, kind: DialectKind, name: &str) -> Case {
        let over = golden().join(format!("{case}.{name}.json"));
        let path = if over.exists() {
            over
        } else {
            golden().join(format!("{case}.json"))
        };
        let mut c: Case = serde_json::from_str(&read(&path))
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        if kind == DialectKind::Postgres {
            for t in &mut c.query.tables {
                t.schema.get_or_insert_with(|| "public".into());
            }
        }
        c
    }

    fn gen_case(case: &str, kind: DialectKind, name: &str) -> (Case, GeneratedQuery) {
        let c = load(case, kind, name);
        let q = generate(kind, version(kind), &c.query, &c.types)
            .unwrap_or_else(|e| panic!("{case} on {name}: {e}"));
        (c, q)
    }

    fn each(mut f: impl FnMut(&str, DialectKind, &str, &Case, &GeneratedQuery)) {
        for case in CASES {
            for (kind, name) in DIALECTS {
                let (c, q) = gen_case(case, kind, name);
                f(case, kind, name, &c, &q);
            }
        }
    }

    #[test]
    fn golden_text_per_dialect() {
        let bless = std::env::var_os("CONTURA_BLESS").is_some();
        let mut failures = Vec::new();
        each(|case, _kind, name, c, q| {
            let path = golden().join(format!("{case}.{name}.sql"));
            if bless {
                fs::write(&path, format!("{}\n", q.sql)).unwrap();
            }
            let expected = fs::read_to_string(&path)
                .unwrap_or_default()
                .replace("\r\n", "\n");
            if expected.trim_end() != q.sql {
                failures.push(format!("{case}.{name}.sql differs; generated:\n{}", q.sql));
            }
            if q.outputs != c.outputs {
                failures.push(format!("{case} on {name}: outputs {:?}", q.outputs));
            }
            if let Some(w) = &c.warnings
                && &q.warnings != w
            {
                failures.push(format!("{case} on {name}: warnings {:?}", q.warnings));
            }
        });
        assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    }

    #[test]
    fn late_orders_by_store_postgres_is_the_spec_example() {
        let (_, q) = gen_case("late_orders_by_store", DialectKind::Postgres, "postgres");
        let spec = "SELECT s.name,
       s.city,
       count(o.id) AS late_orders,
       sum(o.total) AS late_total
FROM sales.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN public.customers AS c ON c.id = o.customer_id
WHERE o.status = 'late'
  AND o.placed_at >= '2026-10-01'
  AND o.channel IN ('app', 'kiosk')
GROUP BY s.name, s.city
ORDER BY late_orders DESC, s.name
LIMIT 50";
        assert_eq!(q.sql, spec);
    }

    #[test]
    fn every_golden_classifies_read() {
        each(|case, kind, name, _c, q| {
            assert_eq!(
                classify(kind, &q.sql),
                StatementClass::Read,
                "{case} on {name}"
            );
        });
    }

    #[test]
    fn same_input_same_text() {
        each(|case, kind, name, c, q| {
            let again = generate(kind, version(kind), &c.query, &c.types).unwrap();
            assert_eq!(&again, q, "{case} on {name}");
            let json = serde_json::to_string(&c.query).unwrap();
            let back: VisualQuery = serde_json::from_str(&json).unwrap();
            let third = generate(kind, version(kind), &back, &c.types).unwrap();
            assert_eq!(&third, q, "{case} on {name} after a JSON round trip");
        });
    }

    #[test]
    fn parts_match_the_text() {
        each(|case, kind, name, c, q| {
            let lines: Vec<&str> = q.sql.lines().collect();
            let mut next = 1;
            let mut first_from = true;
            for p in &q.parts {
                let at = format!("{case} on {name}: {p:?}");
                assert_eq!(p.from_line, next, "{at}: parts leave a gap or overlap");
                assert!(p.from_line <= p.to_line, "{at}");
                next = p.to_line + 1;
                let line = lines[p.from_line as usize - 1];
                match &p.part {
                    PartKind::Select => assert!(line.starts_with("SELECT "), "{at}"),
                    PartKind::From { table } => {
                        let lead = if first_from { "FROM " } else { "CROSS JOIN " };
                        first_from = false;
                        assert!(line.starts_with(lead), "{at}");
                        let t = c.query.tables.iter().find(|t| &t.id == table).unwrap();
                        assert!(line.ends_with(&as_alias(kind, &t.alias)), "{at}");
                    }
                    PartKind::Join { join } => {
                        assert!(
                            ["JOIN ", "LEFT JOIN ", "RIGHT JOIN ", "FULL JOIN "]
                                .iter()
                                .any(|k| line.starts_with(k)),
                            "{at}"
                        );
                        // The line brings in one of the Join's two tables.
                        let j = c.query.joins.iter().find(|j| &j.id == join).unwrap();
                        let head = line.split(" ON ").next().unwrap();
                        assert!(
                            [&j.left, &j.right].iter().any(|id| {
                                let t = c.query.tables.iter().find(|t| &&t.id == id).unwrap();
                                head.ends_with(&as_alias(kind, &t.alias))
                            }),
                            "{at}"
                        );
                    }
                    PartKind::Where { filter } => {
                        assert!(
                            ["WHERE ", "  AND ", "  OR "]
                                .iter()
                                .any(|k| line.starts_with(k)),
                            "{at}"
                        );
                        let column = &c.query.filters[*filter].column;
                        assert!(line.contains(&bare_ident(kind, column)), "{at}");
                    }
                    PartKind::GroupBy => assert!(line.starts_with("GROUP BY "), "{at}"),
                    PartKind::OrderBy => assert!(line.starts_with("ORDER BY "), "{at}"),
                    PartKind::Limit => assert!(line.starts_with("LIMIT "), "{at}"),
                }
            }
            assert_eq!(
                next as usize,
                lines.len() + 1,
                "{case} on {name}: lines left over"
            );
        });
    }

    fn as_alias(kind: DialectKind, alias: &str) -> String {
        format!(" AS {}", bare_ident(kind, alias))
    }

    #[test]
    fn outputs_are_final_names() {
        each(|case, kind, name, _c, q| {
            let select = q.parts.iter().find(|p| p.part == PartKind::Select).unwrap();
            let lines: Vec<&str> = q.sql.lines().collect();
            let items = &lines[select.from_line as usize - 1..select.to_line as usize];
            assert_eq!(items.len(), q.outputs.len(), "{case} on {name}");
            for (line, out) in items.iter().zip(&q.outputs) {
                let item = line.trim_end_matches(',');
                let quoted = bare_ident(kind, out);
                assert!(
                    item.ends_with(&format!(" AS {quoted}"))
                        || (!item.contains(" AS ") && item.ends_with(&format!(".{quoted}"))),
                    "{case} on {name}: {item} is not named {out}"
                );
            }
        });
    }

    /// The hand-written shapes (P5) agree with the PostgreSQL text: the same
    /// aliases in FROM order, the same Join kinds and ON pair counts, the same
    /// outputs.
    #[test]
    fn shape_files_agree_with_the_postgres_text() {
        #[derive(Deserialize)]
        struct Shape {
            tables: Vec<ShapeTable>,
            joins: Vec<ShapeJoin>,
            outputs: Vec<String>,
        }
        #[derive(Deserialize)]
        struct ShapeTable {
            alias: String,
            schema: String,
            name: String,
        }
        #[derive(Deserialize)]
        struct ShapeJoin {
            table: String,
            kind: String,
            on: Vec<[String; 2]>,
        }
        let pg = DialectKind::Postgres;
        let q = |s: &str| bare_ident(pg, s);
        let column = |s: &str| {
            let (alias, col) = s.split_once('.').unwrap();
            format!("{}.{}", q(alias), q(col))
        };
        for case in CASES {
            let shape: Shape =
                serde_json::from_str(&read(&golden().join(format!("{case}.shape.json"))))
                    .unwrap_or_else(|e| panic!("{case}.shape.json: {e}"));
            let (_, generated) = gen_case(case, pg, "postgres");
            let mut tables = Vec::new();
            let mut joins = Vec::new();
            for line in generated.sql.lines() {
                let found = [
                    ("FROM ", "from"),
                    ("JOIN ", "inner"),
                    ("LEFT JOIN ", "left"),
                    ("RIGHT JOIN ", "right"),
                    ("FULL JOIN ", "full"),
                    ("CROSS JOIN ", "cross"),
                ]
                .iter()
                .find(|(k, _)| line.starts_with(k))
                .map(|(k, v)| (k.len(), *v));
                let Some((skip, kind)) = found else { continue };
                let (head, on) = line.split_once(" ON ").unwrap_or((line, ""));
                let (table, alias) = head[skip..].rsplit_once(" AS ").unwrap();
                tables.push((alias.to_string(), table.to_string()));
                if kind != "from" {
                    let pairs: Vec<String> = if on.is_empty() {
                        Vec::new()
                    } else {
                        on.split(" AND ").map(str::to_string).collect()
                    };
                    joins.push((alias.to_string(), kind.to_string(), pairs));
                }
            }
            let shape_tables: Vec<(String, String)> = shape
                .tables
                .iter()
                .map(|t| (q(&t.alias), format!("{}.{}", q(&t.schema), q(&t.name))))
                .collect();
            assert_eq!(shape_tables, tables, "{case}: tables");
            let shape_joins: Vec<(String, String, Vec<String>)> = shape
                .joins
                .iter()
                .map(|j| {
                    let pairs =
                        j.on.iter()
                            .map(|[a, b]| format!("{} = {}", column(a), column(b)))
                            .collect();
                    (q(&j.table), j.kind.clone(), pairs)
                })
                .collect();
            assert_eq!(shape_joins, joins, "{case}: joins");
            assert_eq!(shape.outputs, generated.outputs, "{case}: outputs");
        }
    }

    /// Text outside every quoted name and literal.
    fn outside_quotes(sql: &str) -> String {
        let mut out = String::new();
        let mut open: Option<char> = None;
        for c in sql.chars() {
            match open {
                Some(q) if c == q => open = None,
                Some(_) => {}
                None if matches!(c, '\'' | '"' | '`') => open = Some(c),
                None => out.push(c),
            }
        }
        assert!(open.is_none(), "unclosed quote in {sql}");
        out
    }

    #[test]
    fn hostile_names_stay_read() {
        let table = "x; DROP TABLE y";
        let column = "a\" OR 1=1 --";
        let value = "'); DROP TABLE y; --";
        let alias = "x`\"; DROP TABLE y; --";
        for (kind, name) in DIALECTS {
            let vq = VisualQuery {
                version: 1,
                database: None,
                dialect: Some(kind),
                tables: vec![VqTable {
                    id: "t1".into(),
                    // A schema, MySQL database or SQLite scope, all written.
                    schema: Some(table.to_string()),
                    name: table.into(),
                    alias: alias.into(),
                    x: 0.0,
                    y: 0.0,
                }],
                joins: vec![],
                columns: vec![
                    VqColumn {
                        table: "t1".into(),
                        column: column.into(),
                        alias: None,
                        aggregate: None,
                    },
                    VqColumn {
                        table: "t1".into(),
                        column: column.into(),
                        alias: Some(table.into()),
                        aggregate: Some(Aggregate::Count),
                    },
                ],
                filters: vec![
                    VqFilter {
                        joiner: Joiner::And,
                        table: "t1".into(),
                        column: column.into(),
                        op: FilterOp::Eq,
                        values: vec![value.into()],
                    },
                    VqFilter {
                        joiner: Joiner::Or,
                        table: "t1".into(),
                        column: column.into(),
                        op: FilterOp::In,
                        values: vec![format!("{value}, b; DROP TABLE y; --")],
                    },
                ],
                group_by: GroupBy::Auto,
                order_by: vec![VqSort {
                    target: SortTarget::Output { index: 1 },
                    dir: SortDir::Desc,
                }],
                limit: Some(5),
                distinct: false,
            };
            let q = generate(kind, version(kind), &vq, &ColumnTypes::new())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                classify(kind, &q.sql),
                StatementClass::Read,
                "{name}: {}",
                q.sql
            );
            let bare = outside_quotes(&q.sql);
            for bad in ["DROP", ";", "--", "OR 1"] {
                assert!(
                    !bare.contains(bad),
                    "{name}: {bad} outside quotes in\n{}",
                    q.sql
                );
            }
        }
    }

    fn refused(
        kind: DialectKind,
        server_version: &str,
        vq: &VisualQuery,
        types: &ColumnTypes,
    ) -> String {
        match generate(kind, server_version, vq, types) {
            Err(Error::InvalidInput(m)) => m,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn refusals_come_from_check() {
        let full = load("inner_left_right_full", DialectKind::MySql, "default");
        assert_eq!(
            refused(DialectKind::MySql, "", &full.query, &full.types),
            "MySQL has no FULL JOIN. Pick Left or Right."
        );

        let mut single = load("single_table", DialectKind::MySql, "mysql");
        single.query.columns.clear();
        assert_eq!(
            refused(DialectKind::Postgres, "", &single.query, &single.types),
            "Tick at least one column."
        );

        let mut bad = load("literals", DialectKind::Postgres, "postgres");
        bad.query.filters.truncate(1);
        bad.query.filters[0].column = "total".into();
        bad.query.filters[0].op = FilterOp::Eq;
        bad.query.filters[0].values = vec!["12,5".into()];
        assert_eq!(
            refused(DialectKind::Postgres, "", &bad.query, &bad.types),
            "total is a number column; 12,5 is not a number."
        );

        let right = load(
            "swap_when_reached_from_right",
            DialectKind::Sqlite,
            "sqlite",
        );
        assert_eq!(
            refused(DialectKind::Sqlite, "3.38.5", &right.query, &right.types),
            "RIGHT and FULL JOIN need SQLite 3.39 or later."
        );
        assert!(generate(DialectKind::Sqlite, "3.39.0", &right.query, &right.types).is_ok());
    }

    #[test]
    fn sort_by_a_missing_output_is_refused() {
        let mut c = load("single_table", DialectKind::MySql, "mysql");
        c.query.order_by = vec![VqSort {
            target: SortTarget::Output { index: 9 },
            dir: SortDir::Asc,
        }];
        assert_eq!(
            refused(DialectKind::MySql, "", &c.query, &c.types),
            "Sort 1 names an output column that is no longer there. Pick another."
        );
    }

    #[test]
    fn a_filter_on_an_unknown_table_is_refused() {
        let mut c = load("literals", DialectKind::MySql, "mysql");
        c.query.filters[0].table = "gone".into();
        assert_eq!(
            refused(DialectKind::MySql, "", &c.query, &c.types),
            "Filter 1 names a table that is not in the query."
        );
    }

    #[test]
    fn every_column_behind_a_pending_pick_is_refused() {
        let mut c = load("pending_pick_leaves_out", DialectKind::MySql, "mysql");
        c.query.columns.retain(|col| col.table == "t2");
        c.query.order_by.clear();
        let message = "Every ticked column is behind a Join that needs a key. Pick one first.";
        assert_eq!(refused(DialectKind::MySql, "", &c.query, &c.types), message);
        let p = preview(DialectKind::MySql, "", &c.query, &c.types);
        assert_eq!(p.query, None);
        assert_eq!(p.problems.len(), 1);
        assert_eq!(p.problems[0].message, message);
    }

    #[test]
    fn preview_gives_problems_or_the_query() {
        let full = load("inner_left_right_full", DialectKind::MySql, "default");
        let p = preview(DialectKind::MySql, "", &full.query, &full.types);
        assert_eq!(p.query, None);
        assert_eq!(
            p.problems,
            check(DialectKind::MySql, "", &full.query, &full.types)
        );
        assert!(!p.problems.is_empty());

        let (c, q) = gen_case("single_table", DialectKind::MySql, "mysql");
        let p = preview(DialectKind::MySql, "", &c.query, &c.types);
        assert_eq!(p.problems, vec![]);
        assert_eq!(p.query, Some(q));
    }

    #[test]
    fn limit_is_the_same_on_every_dialect() {
        for (kind, _) in DIALECTS {
            assert_eq!(limit_clause(kind, 50), "LIMIT 50");
        }
    }

    #[test]
    fn sort_by_name_only_when_the_select_carries_as() {
        for (kind, name) in DIALECTS {
            let (_, q) = gen_case("alias_equals_column", kind, name);
            // `o.id` typed as `id` is written without AS, so the sort names the
            // column; `c.id AS customer_id` sorts by its name.
            assert!(q.sql.starts_with("SELECT o.id,\n"), "{name}: {}", q.sql);
            assert!(
                q.sql.ends_with("\nORDER BY o.id DESC, customer_id"),
                "{name}: {}",
                q.sql
            );
        }
    }

    #[test]
    fn a_left_join_reached_from_its_right_side_is_refused_on_old_sqlite() {
        let mut c = load("single_table", DialectKind::Sqlite, "sqlite");
        c.query.tables.insert(
            0,
            VqTable {
                id: "t2".into(),
                schema: None,
                name: "stores".into(),
                alias: "s".into(),
                x: 0.0,
                y: 0.0,
            },
        );
        c.query.joins = vec![VqJoin {
            id: "j1".into(),
            left: "t1".into(),
            right: "t2".into(),
            kind: JoinKind::Left,
            on: vec![crate::visual_query::ColumnPair {
                left_column: "store_id".into(),
                right_column: "id".into(),
            }],
            pending: None,
        }];
        assert_eq!(
            refused(DialectKind::Sqlite, "3.38.5", &c.query, &c.types),
            "RIGHT and FULL JOIN need SQLite 3.39 or later."
        );
        let q = generate(DialectKind::Sqlite, "3.39.0", &c.query, &c.types).unwrap();
        assert!(
            q.sql
                .contains("\nRIGHT JOIN orders AS o ON o.store_id = s.id")
        );
    }

    /// Every SQLite golden file runs on an in-memory database whose tables have
    /// every column the golden models name, so a text the server would refuse
    /// (an ambiguous name, a bad qualifier) fails here, not live.
    #[test]
    fn every_sqlite_golden_runs() {
        use std::collections::BTreeMap;
        let mut tables: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        for case in CASES {
            let c = load(case, DialectKind::Sqlite, "sqlite");
            let vq = &c.query;
            let mut need = |id: &str, column: &str| {
                if let Some(t) = vq.tables.iter().find(|t| t.id == id) {
                    let scope = match t.schema.as_deref() {
                        Some(s) if s != "main" && Some(s) != vq.database.as_deref() => s,
                        _ => "main",
                    };
                    // SQLite names compare without case.
                    let cols = tables
                        .entry((scope.to_string(), t.name.to_lowercase()))
                        .or_default();
                    if !cols.iter().any(|c| c.eq_ignore_ascii_case(column)) {
                        cols.push(column.to_string());
                    }
                }
            };
            for col in &vq.columns {
                need(&col.table, &col.column);
            }
            for f in &vq.filters {
                need(&f.table, &f.column);
            }
            for j in &vq.joins {
                for p in &j.on {
                    need(&j.left, &p.left_column);
                    need(&j.right, &p.right_column);
                }
            }
            for s in &vq.order_by {
                if let SortTarget::Column { table, column } = &s.target {
                    need(table, column);
                }
            }
            if let GroupBy::Manual { columns } = &vq.group_by {
                for g in columns {
                    need(&g.table, &g.column);
                }
            }
        }
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("ATTACH DATABASE ':memory:' AS archive")
            .unwrap();
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        for ((scope, name), cols) in &tables {
            let cols: Vec<String> = cols.iter().map(|c| quote(c)).collect();
            let sql = format!(
                "CREATE TABLE {}.{} ({})",
                quote(scope),
                quote(name),
                cols.join(", ")
            );
            db.execute_batch(&sql)
                .unwrap_or_else(|e| panic!("{sql}: {e}"));
        }
        for case in CASES {
            let sql = read(&golden().join(format!("{case}.sqlite.sql")));
            let mut stmt = db
                .prepare(sql.trim_end())
                .unwrap_or_else(|e| panic!("{case}.sqlite.sql: {e}\n{sql}"));
            let mut rows = stmt.query([]).unwrap();
            while rows.next().unwrap().is_some() {}
        }
    }

    #[test]
    fn bundled_sqlite_is_3_39_or_later() {
        let v: Vec<u32> = rusqlite::version()
            .split('.')
            .map(|p| p.parse().unwrap())
            .collect();
        assert!((v[0], v[1], v[2]) >= (3, 39, 0), "{}", rusqlite::version());
    }

    #[test]
    fn preview_serializes_with_kind_tags() {
        let (c, _) = gen_case("cross_join_groups", DialectKind::MySql, "mysql");
        let p = preview(DialectKind::MySql, "", &c.query, &c.types);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["query"]["parts"][0]["part"]["kind"], "select");
        assert_eq!(v["query"]["parts"][0]["fromLine"], 1);
        assert_eq!(v["query"]["warnings"][0]["kind"], "crossJoin");
        assert_eq!(v["query"]["warnings"][0]["rows"], serde_json::Value::Null);
    }
}
