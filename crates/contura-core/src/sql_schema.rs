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
    /// PostgreSQL: the labels of the column's enum type, in their sort order, for the
    /// grid's enum picker. Empty for every other type and on the other Dialects.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFk {
    pub from: SmEndpoint,
    pub to: SmEndpoint,
    /// The constraint's name; SQLite has one only when the table's text gives it.
    #[serde(default)]
    pub name: Option<String>,
    /// The constraint's comment, where the server keeps one (PostgreSQL).
    #[serde(default)]
    pub comment: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_values_are_left_out_when_empty_and_default_when_missing() {
        let plain = SqlColumn {
            name: "id".into(),
            type_name: "int4".into(),
            pk: true,
            enum_values: Vec::new(),
        };
        let json = serde_json::to_string(&plain).unwrap();
        assert_eq!(json, r#"{"name":"id","typeName":"int4","pk":true}"#);
        assert_eq!(serde_json::from_str::<SqlColumn>(&json).unwrap(), plain);

        let mood = SqlColumn {
            name: "mood".into(),
            type_name: "mood".into(),
            pk: false,
            enum_values: vec!["sad".into(), "it's ok".into(), "a, b".into()],
        };
        let json = serde_json::to_string(&mood).unwrap();
        assert!(
            json.contains(r#""enumValues":["sad","it's ok","a, b"]"#),
            "{json}"
        );
        assert_eq!(serde_json::from_str::<SqlColumn>(&json).unwrap(), mood);
    }
}
