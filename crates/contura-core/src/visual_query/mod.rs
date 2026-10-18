//! Visual Query: a query built from table cards, Joins, ticked columns,
//! filters and sorts. The Core owns every SQL text it turns into; this module
//! holds the saved model and the checks that run before any SQL is written.

mod check;
mod generate;
mod literal;
mod names;
mod plan;
mod reserved;

pub use check::{ProblemTarget, VqProblem, check};
pub use generate::{GeneratedQuery, PartKind, SqlPart, VqPreview, VqWarning, generate, preview};
pub use literal::split_in_list;
pub use reserved::is_reserved;

use crate::model::DialectKind;
use crate::query::Execution;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Column types the UI already holds: table id to column name to type text.
pub type ColumnTypes = HashMap<String, HashMap<String, String>>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualQuery {
    pub version: u32,
    pub database: Option<String>,
    #[serde(default)]
    pub dialect: Option<DialectKind>,
    pub tables: Vec<VqTable>,
    pub joins: Vec<VqJoin>,
    pub columns: Vec<VqColumn>,
    pub filters: Vec<VqFilter>,
    pub group_by: GroupBy,
    pub order_by: Vec<VqSort>,
    pub limit: Option<u64>,
    pub distinct: bool,
}

/// One table card. `schema` is the PostgreSQL schema, or the MySQL database or
/// SQLite scope when it differs from the tab's database (D6).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VqTable {
    pub id: String,
    pub schema: Option<String>,
    pub name: String,
    pub alias: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqJoin {
    pub id: String,
    pub left: String,
    pub right: String,
    pub kind: JoinKind,
    pub on: Vec<ColumnPair>,
    #[serde(default)]
    pub pending: Option<Vec<FkChoice>>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JoinKind {
    Inner,
    Left,
    Right,
    Full,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPair {
    pub left_column: String,
    pub right_column: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FkChoice {
    pub name: String,
    pub on: Vec<ColumnPair>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqColumn {
    pub table: String,
    pub column: String,
    pub alias: Option<String>,
    pub aggregate: Option<Aggregate>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Aggregate {
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
}

/// One filter row. An empty `column` means none is picked yet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqFilter {
    pub joiner: Joiner,
    pub table: String,
    pub column: String,
    pub op: FilterOp,
    pub values: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Joiner {
    And,
    Or,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Like,
    NotLike,
    In,
    NotIn,
    Between,
    IsNull,
    IsNotNull,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GroupBy {
    Auto,
    Manual { columns: Vec<ColumnRef> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub table: String,
    pub column: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqSort {
    pub target: SortTarget,
    pub dir: SortDir,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SortTarget {
    Output { index: usize },
    Column { table: String, column: String },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// A Visual Query run: the text that ran and the editor's result for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VqRun {
    pub sql: String,
    pub execution: Execution,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_round_trips_as_camel_case_json() {
        let json = r#"{
            "version": 1,
            "database": "app",
            "tables": [{"id": "t1", "schema": null, "name": "orders", "alias": "o", "x": 0, "y": 0}],
            "joins": [{"id": "j1", "left": "t1", "right": "t2", "kind": "left",
                       "on": [{"leftColumn": "store_id", "rightColumn": "id"}]}],
            "columns": [{"table": "t1", "column": "id", "alias": null, "aggregate": "countDistinct"}],
            "filters": [{"joiner": "and", "table": "t1", "column": "status", "op": "notIn", "values": ["a"]}],
            "groupBy": {"kind": "manual", "columns": [{"table": "t1", "column": "id"}]},
            "orderBy": [{"target": {"kind": "output", "index": 0}, "dir": "desc"},
                        {"target": {"kind": "column", "table": "t1", "column": "id"}, "dir": "asc"}],
            "limit": 100,
            "distinct": false
        }"#;
        let vq: VisualQuery = serde_json::from_str(json).unwrap();
        assert_eq!(vq.dialect, None);
        assert_eq!(vq.joins[0].pending, None);
        assert_eq!(vq.columns[0].aggregate, Some(Aggregate::CountDistinct));
        assert_eq!(vq.filters[0].op, FilterOp::NotIn);
        assert_eq!(
            vq.group_by,
            GroupBy::Manual {
                columns: vec![ColumnRef {
                    table: "t1".into(),
                    column: "id".into()
                }]
            }
        );
        let back = serde_json::to_value(&vq).unwrap();
        assert_eq!(back["groupBy"]["kind"], "manual");
        assert_eq!(back["orderBy"][0]["target"]["kind"], "output");
        assert_eq!(back["joins"][0]["on"][0]["leftColumn"], "store_id");
        let again: VisualQuery = serde_json::from_value(back).unwrap();
        assert_eq!(again, vq);
    }
}
