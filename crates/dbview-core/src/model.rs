use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type ConnectionId = uuid::Uuid;
pub type GroupId = uuid::Uuid;

pub const PAGE_SIZE: u32 = 1000;
pub const PREVIEW_CHARS: usize = 1024;
pub const PREVIEW_BYTES: usize = 1024;
pub const FULL_VALUE_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DialectKind {
    MySql,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SslMode {
    Disable,
    Require,
    VerifyCa { ca_path: PathBuf },
}

/// A saved Connection. It has no password field, by design: passwords live
/// only in the OS credential store. `group_id: None` means Ungrouped.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: ConnectionId,
    pub name: String,
    pub dialect: DialectKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: SslMode,
    pub group_id: Option<GroupId>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupColor {
    Red,
    Orange,
    Amber,
    Green,
    Teal,
    Blue,
    Violet,
    Rose,
    Slate,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub color: GroupColor,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPath {
    pub database: String,
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
    Procedure,
    Function,
    Trigger,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub kind: ObjectKind,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub is_primary_key: bool,
}

/// One grid cell. Numbers travel as strings so 64-bit and DECIMAL values
/// keep their exact digits in JavaScript.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Cell {
    Null,
    Number {
        value: String,
    },
    Text {
        value: String,
        truncated: bool,
        total_bytes: u64,
    },
    Bytes {
        preview_hex: String,
        truncated: bool,
        total_bytes: u64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub descending: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub table: ObjectPath,
    pub page: u32,
    pub sort: Option<SortSpec>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPart {
    pub column: String,
    pub value: Cell,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FullValueRequest {
    pub table: ObjectPath,
    pub column: String,
    pub key: Vec<KeyPart>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FullValue {
    Text { value: String },
    Bytes { base64: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_number_serializes_as_string() {
        let c = Cell::Number {
            value: "18446744073709551615".into(),
        };
        assert_eq!(
            serde_json::to_string(&c).unwrap(),
            r#"{"t":"number","value":"18446744073709551615"}"#
        );
    }
    #[test]
    fn ssl_mode_shape() {
        let s = SslMode::VerifyCa {
            ca_path: "C:/ca.pem".into(),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"mode":"verifyCa","caPath":"C:/ca.pem"})
        );
    }
}
