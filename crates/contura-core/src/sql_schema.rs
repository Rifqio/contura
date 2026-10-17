//! A names-only index of one database for the editor's language service: tables, views,
//! column types and Foreign Keys. Never row data.

use serde::{Deserialize, Serialize};

use crate::schema_model::SmEndpoint;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlSchema {
    /// Schemas an unqualified name resolves against, in order.
    pub search_path: Vec<String>,
    pub tables: Vec<SqlTable>,
    pub fks: Vec<SqlFk>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlTable {
    pub schema: Option<String>,
    pub name: String,
    pub kind: SqlTableKind,
    pub columns: Vec<SqlColumn>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlTableKind {
    Table,
    View,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumn {
    pub name: String,
    pub type_name: String,
    pub pk: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFk {
    pub from: SmEndpoint,
    pub to: SmEndpoint,
}
