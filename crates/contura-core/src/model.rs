use crate::ai::AiAccess;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type ConnectionId = uuid::Uuid;
pub type GroupId = uuid::Uuid;

pub const PAGE_SIZE: u32 = 1000;
pub const PREVIEW_CHARS: usize = 1024;
pub const PREVIEW_BYTES: usize = 1024;
pub const FULL_VALUE_LIMIT: u64 = 16 * 1024 * 1024;

/// When an Ask checks the AI Context against the database: `Automatic` before an Ask
/// (at most once a minute), `Manual` only on Re-sync.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiSyncMode {
    #[default]
    Automatic,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DialectKind {
    MySql,
    Postgres,
    Sqlite,
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
    /// The database file of a SQLite Connection; `None` for server Dialects.
    #[serde(default)]
    pub file: Option<PathBuf>,
    /// Typed queries past this are cancelled on the server. `None` means no limit.
    #[serde(default)]
    pub query_timeout_secs: Option<u32>,
    /// What the AI assistant may see of this Connection.
    #[serde(default)]
    pub ai_access: AiAccess,
    /// When the AI Context is checked against the database.
    #[serde(default)]
    pub ai_sync: AiSyncMode,
    /// Writes ask for confirmation first.
    #[serde(default)]
    pub production: bool,
    /// Writes are blocked by the Core and refused by the server.
    #[serde(default)]
    pub read_only: bool,
}

/// The eight design-next Group slots. The nine names saved by older builds
/// still load through the aliases and are written back as the new slot.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupColor {
    Teal,
    #[serde(alias = "red", alias = "rose")]
    Indigo,
    Green,
    #[serde(alias = "orange", alias = "amber")]
    Gold,
    Lime,
    #[serde(alias = "blue")]
    Sky,
    Violet,
    #[serde(alias = "slate")]
    Pink,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    System,
    Light,
    #[default]
    Dark,
}

/// Grid row height in pixels: 24 (compact) or 28 (comfortable).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(transparent)]
pub struct RowHeight(pub u32);

impl Default for RowHeight {
    fn default() -> Self {
        Self(28)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorPrefs {
    pub family: String,
    pub size: u32,
    pub line_height: u32,
    pub ligatures: bool,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            family: "JetBrains Mono".into(),
            size: 13,
            line_height: 20,
            ligatures: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiPrefs {
    pub theme: ThemeChoice,
    #[serde(default)]
    pub row_height: RowHeight,
    #[serde(default)]
    pub editor: EditorPrefs,
    #[serde(default)]
    pub brighter_comments: bool,
    #[serde(default)]
    pub inline_suggestions: bool,
    #[serde(default)]
    pub history_keep_days: Option<u32>,
}

/// Shortcut overrides by command id; an empty list unbinds the command.
pub type KeymapOverrides = std::collections::BTreeMap<String, Vec<String>>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: GroupId,
    pub name: String,
    pub color: GroupColor,
    /// Whether `group-images/<id>.png` exists; filled in by the service.
    #[serde(default)]
    pub has_image: bool,
}

/// The largest Group image the data folder accepts.
pub const GROUP_IMAGE_MAX: usize = 262_144;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
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
pub struct SchemaInfo {
    pub name: String,
    pub is_system: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub kind: ObjectKind,
    pub name: String,
    /// The database's own row estimate; tables only.
    #[serde(default)]
    pub rows: Option<u64>,
    /// The database's own size estimate in bytes, data and indexes; tables only.
    #[serde(default)]
    pub bytes: Option<u64>,
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
    /// A SQL expression over the table's columns, such as `status = 'paid'`.
    #[serde(default)]
    pub filter: Option<String>,
}

impl PageRequest {
    /// ` WHERE (...)` for the filter, or nothing. The filter sits on lines of its
    /// own, so a `--` comment in it cannot reach the ORDER BY and LIMIT after it.
    /// Callers also check the whole query is one statement before running it.
    pub fn where_sql(&self) -> String {
        match self.filter.as_deref().map(str::trim) {
            Some(f) if !f.is_empty() => format!(" WHERE (\n{f}\n)"),
            _ => String::new(),
        }
    }

    pub fn has_filter(&self) -> bool {
        !self.where_sql().is_empty()
    }
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
    fn group_color_reads_all_nine_old_names() {
        let json = include_str!("../tests/fixtures/old_group_colours.json");
        let read: Vec<GroupColor> = serde_json::from_str(json).unwrap();
        assert_eq!(
            read,
            vec![
                GroupColor::Indigo,
                GroupColor::Gold,
                GroupColor::Gold,
                GroupColor::Green,
                GroupColor::Teal,
                GroupColor::Sky,
                GroupColor::Violet,
                GroupColor::Indigo,
                GroupColor::Pink,
            ]
        );
    }

    #[test]
    fn group_color_writes_the_new_slot() {
        assert_eq!(
            serde_json::to_string(&GroupColor::Indigo).unwrap(),
            r#""indigo""#
        );
    }

    #[test]
    fn timeout_field_defaults_to_none_for_old_configs() {
        let json = r#"{"id":"6f2c0b1e-7a7e-4c8e-9a4b-1f0d6e2a9c11","name":"old","dialect":"mysql",
            "host":"h","port":3306,"user":"u","database":null,"ssl":{"mode":"disable"},"groupId":null}"#;
        let c: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.query_timeout_secs, None);
    }

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
    fn postgres_dialect_serializes_as_postgres() {
        assert_eq!(
            serde_json::to_string(&DialectKind::Postgres).unwrap(),
            r#""postgres""#
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

    #[test]
    fn old_groups_load_without_has_image() {
        let g: Group = serde_json::from_str(
            r#"{"id":"6f9619ff-8b86-d011-b42d-00c04fc964ff","name":"Shop","color":"teal"}"#,
        )
        .unwrap();
        assert!(!g.has_image);
    }

    #[test]
    fn old_objects_load_without_rows() {
        let o: DbObject = serde_json::from_str(r#"{"kind":"table","name":"t"}"#).unwrap();
        assert_eq!(o.rows, None);
    }
}
