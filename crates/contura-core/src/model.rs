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
    /// Encrypt when the server offers TLS, else go on in plain text; any certificate is
    /// accepted (libpq `prefer`, MySQL `PREFERRED`). A TLS failure on a server that
    /// offers TLS is an error, never a fall back to plain text.
    Prefer,
    /// Encrypt, but accept any certificate.
    Require,
    /// The chain must lead to a CA from `ca_path`; the host name is not checked.
    VerifyCa {
        ca_path: PathBuf,
    },
    /// The chain and the host name are both checked. With `ca_path`, only those CAs are
    /// trusted (a private CA); without, the public roots are (a cloud server).
    VerifyFull {
        #[serde(default)]
        ca_path: Option<PathBuf>,
    },
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
    /// The diagram tab's side panel, kept across restarts.
    #[serde(default)]
    pub flow_side_panel: FlowSidePanel,
    /// How the diagram assistant's changes land: reviewed first, or applied at once.
    #[serde(default)]
    pub flow_assist_mode: FlowAssistMode,
    /// Item 36: the Visual Query's bottom panel height in px; `None` is the default.
    #[serde(default)]
    pub vq_panel_height: Option<u32>,
    /// What the place for Connections in no Group is called; `None` is "Ungrouped".
    #[serde(default)]
    pub ungrouped_label: Option<String>,
    /// Text and controls in every window, as a percent: 90, 100, 110 or 125.
    #[serde(default)]
    pub interface_size: InterfaceSize,
    /// Every data grid shades alternate rows.
    #[serde(default)]
    pub stripe_rows: bool,
    /// How the data grids draw SQL NULL. Copy and export always keep real NULL.
    #[serde(default)]
    pub null_as: NullDisplay,
}

/// The interface size as a percent of the normal size.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(transparent)]
pub struct InterfaceSize(pub u32);

impl InterfaceSize {
    /// The sizes the Appearance page offers; anything else reads as 100.
    pub const CHOICES: [u32; 4] = [90, 100, 110, 125];

    /// The size when it is one of the choices, otherwise 100.
    pub fn checked(self) -> Self {
        if Self::CHOICES.contains(&self.0) {
            self
        } else {
            Self::default()
        }
    }

    /// The webview zoom factor: 1.25 at 125 percent.
    pub fn zoom(self) -> f64 {
        f64::from(self.checked().0) / 100.0
    }
}

impl Default for InterfaceSize {
    fn default() -> Self {
        Self(100)
    }
}

/// How a data grid draws SQL NULL: the word, the empty-set sign, or nothing visible.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NullDisplay {
    #[default]
    Null,
    Symbol,
    Blank,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowAssistMode {
    #[default]
    Review,
    Auto,
}

/// Which tab the diagram side panel shows, and whether it is hidden to its rail.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowSidePanel {
    pub hidden: bool,
    pub tab: FlowSideTab,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowSideTab {
    #[default]
    Editor,
    Assistant,
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

/// UX step 8: a count stops after this many rows and one more, which reads as "1,000+".
pub const COUNT_CAP: u64 = 1000;

/// UX step 8: how many rows of a table match a filter, the same filter a page takes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    pub table: ObjectPath,
    #[serde(default)]
    pub filter: Option<String>,
}

impl CountRequest {
    /// ` WHERE (...)` for the filter, or nothing, as a page's.
    pub fn where_sql(&self) -> String {
        filter_where(self.filter.as_deref())
    }
}

/// Back after a followed key (M3): where the row with `key` is under a page's sort and
/// filter, so a row that only moved to another page is found there.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocateRequest {
    pub table: ObjectPath,
    pub sort: Option<SortSpec>,
    #[serde(default)]
    pub filter: Option<String>,
    /// The row's primary key, every part.
    pub key: Vec<KeyPart>,
}

impl LocateRequest {
    /// ` WHERE (...)` for the filter, or nothing, as a page's.
    pub fn where_sql(&self) -> String {
        filter_where(self.filter.as_deref())
    }
}

/// Where a row is: its 0-based place in the page order (the page is `index / PAGE_SIZE`),
/// no row has the key under the filter, or the server's time limit ran out first.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowPlace {
    Found {
        index: u64,
    },
    Missing,
    TimedOut,
    /// The server can't work a place out (MySQL 5.7 has no window functions).
    Unsupported,
}

/// A count: at most `COUNT_CAP + 1` rows, or the server's time limit ran out first.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowCount {
    Counted { rows: u64 },
    TimedOut,
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

/// ` WHERE (...)` for a filter, or nothing. The filter sits on lines of its own, so a
/// `--` comment in it cannot reach what follows. Callers also check the whole query is
/// one statement before running it.
fn filter_where(filter: Option<&str>) -> String {
    match filter.map(str::trim) {
        Some(f) if !f.is_empty() => format!(" WHERE (\n{f}\n)"),
        _ => String::new(),
    }
}

impl PageRequest {
    /// ` WHERE (...)` for the filter, or nothing.
    pub fn where_sql(&self) -> String {
        filter_where(self.filter.as_deref())
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
    fn flow_side_panel_round_trips_and_defaults() {
        let prefs = UiPrefs {
            flow_side_panel: FlowSidePanel {
                hidden: true,
                tab: FlowSideTab::Assistant,
            },
            ..UiPrefs::default()
        };
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(
            json["flowSidePanel"],
            serde_json::json!({ "hidden": true, "tab": "assistant" })
        );
        let back: UiPrefs = serde_json::from_value(json).unwrap();
        assert_eq!(back, prefs);
        // Prefs stored before the side panel load with it shown on the Editor tab.
        let old: UiPrefs = serde_json::from_str(r#"{"theme":"light"}"#).unwrap();
        assert_eq!(
            old.flow_side_panel,
            FlowSidePanel {
                hidden: false,
                tab: FlowSideTab::Editor,
            }
        );
        assert_eq!(
            serde_json::to_value(FlowSidePanel::default()).unwrap(),
            serde_json::json!({ "hidden": false, "tab": "editor" })
        );
    }

    #[test]
    fn flow_assist_mode_round_trips_and_defaults() {
        let prefs = UiPrefs {
            flow_assist_mode: FlowAssistMode::Auto,
            ..UiPrefs::default()
        };
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(json["flowAssistMode"], "auto");
        let back: UiPrefs = serde_json::from_value(json).unwrap();
        assert_eq!(back, prefs);
        assert_eq!(
            serde_json::to_value(UiPrefs::default()).unwrap()["flowAssistMode"],
            "review"
        );
        // Prefs stored before the choice existed load Review.
        let old: UiPrefs = serde_json::from_str(r#"{"theme":"light"}"#).unwrap();
        assert_eq!(old.flow_assist_mode, FlowAssistMode::Review);
    }

    #[test]
    fn appearance_prefs_round_trip_and_default() {
        let prefs = UiPrefs {
            interface_size: InterfaceSize(125),
            stripe_rows: true,
            null_as: NullDisplay::Symbol,
            ..UiPrefs::default()
        };
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(json["interfaceSize"], 125);
        assert_eq!(json["stripeRows"], true);
        assert_eq!(json["nullAs"], "symbol");
        let back: UiPrefs = serde_json::from_value(json).unwrap();
        assert_eq!(back, prefs);
        // Prefs stored before these settings load the normal size, no stripes and the word NULL.
        let old: UiPrefs = serde_json::from_str(r#"{"theme":"light"}"#).unwrap();
        assert_eq!(old.interface_size, InterfaceSize(100));
        assert!(!old.stripe_rows);
        assert_eq!(old.null_as, NullDisplay::Null);
    }

    #[test]
    fn interface_size_zoom_keeps_to_the_choices() {
        assert_eq!(InterfaceSize(90).zoom(), 0.9);
        assert_eq!(InterfaceSize(125).zoom(), 1.25);
        assert_eq!(InterfaceSize(0).zoom(), 1.0);
        assert_eq!(InterfaceSize(400).zoom(), 1.0);
        assert_eq!(InterfaceSize(105).checked(), InterfaceSize(100));
    }

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
        let s = SslMode::VerifyFull { ca_path: None };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"mode":"verifyFull","caPath":null})
        );
        let read: SslMode = serde_json::from_str(r#"{"mode":"verifyFull"}"#).unwrap();
        assert_eq!(read, SslMode::VerifyFull { ca_path: None });
        // M2: Preferred, and the saved modes read back as they were.
        assert_eq!(
            serde_json::to_value(SslMode::Prefer).unwrap(),
            serde_json::json!({"mode":"prefer"})
        );
        for (json, mode) in [
            (r#"{"mode":"prefer"}"#, SslMode::Prefer),
            (r#"{"mode":"disable"}"#, SslMode::Disable),
            (r#"{"mode":"require"}"#, SslMode::Require),
        ] {
            assert_eq!(serde_json::from_str::<SslMode>(json).unwrap(), mode);
        }
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
