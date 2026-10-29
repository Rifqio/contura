//! The one tool a diagram Ask carries, `propose_diagram_changes`: its input type, its hand-written
//! JSON schema, and the checker that resolves and validates each change against an outline of the
//! open .flow file before the user sees it. Pure: no file, no database, no provider.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::board::{BoardFrameInput, BoardInput};
use crate::ai::rails::strip_invisible;
use crate::ai::sent::fnv1a64;

pub const TOOL_NAME: &str = "propose_diagram_changes";
pub const TOOL_DESCRIPTION: &str = "Proposes edits to this .flow file only. It cannot read or change a database. The user reviews every change.";
pub const MAX_OPS: usize = 50;
pub const NAME_CAP: usize = 200;
pub const LABEL_CAP: usize = 300;
pub const INPUT_CAP: usize = 64 * 1024;
/// The most frames one proposal adds (Decision 3).
pub const MAX_NEW_FRAMES: usize = 3;
/// The most frames a board holds; `MAX_BOARD_FRAMES` in `src/lang/flow/model.ts`.
pub const MAX_BOARD_FRAMES: usize = 50;
/// The diagram kind ids headers write, in `DIAGRAM_KINDS` order (`tests/fixtures/flow/er_rules.json`).
pub const DIAGRAM_KIND_IDS: [&str; 9] = [
    "dfd", "flow", "cloud", "er", "sequence", "state", "class", "mindmap", "timeline",
];
/// The shape kinds each diagram kind takes in brackets, in `DIAGRAM_KIND_IDS` order (`KINDS` in
/// `src/lang/flow/model.ts`, kept equal through `tests/fixtures/flow/kinds.json`). A new frame's
/// outline takes its kind's list.
pub const SHAPE_KINDS: [(&str, &[&str]); 9] = [
    ("dfd", &["entity", "process", "store"]),
    (
        "flow",
        &[
            "start",
            "end",
            "step",
            "decision",
            "io",
            "subprocess",
            "document",
            "database",
        ],
    ),
    ("cloud", &["service"]),
    ("er", &["entity", "weak"]),
    ("sequence", &[]),
    ("state", &["state", "choice", "fork"]),
    ("class", &[]),
    ("mindmap", &[]),
    ("timeline", &[]),
];
/// An ER column's flags, in the order the writer writes them (`COLUMN_FLAGS`).
pub const COLUMN_FLAGS: [&str; 3] = ["pk", "not null", "unique"];
/// An ER column name: letters, digits and `_`, not starting with a digit (`isColumnName`).
pub const COLUMN_NAME_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";

/// `COLUMN_NAME_PATTERN`, by hand.
pub fn is_column_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The most characters a follow-up question may have.
pub const FOLLOW_UP_CHARS: usize = 300;

/// The tool input: the file it was written against, that file's hash, and the changes in order.
/// With `follow_up` the model asks first: the call shows no proposal and its ops are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposeInput {
    pub file: String,
    pub base_hash: String,
    /// A follow-up call may leave the ops out.
    #[serde(default)]
    pub ops: Vec<DiagramOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<FollowUp>,
}

/// The one question the model asks when the request is vague (Decision 10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowUp {
    pub question: String,
}

/// One proposed change. Shapes and groups are named by their words; the checker resolves them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum DiagramOp {
    AddNode {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<String>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    RemoveNode {
        target: String,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    RenameNode {
        target: String,
        name: String,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    AddFlow {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    RemoveFlow {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    RelabelFlow {
        from: String,
        to: String,
        label: String,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    /// `group: None` takes the shape out of every group.
    MoveToGroup {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<String>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    /// A new frame of a `DIAGRAM_KIND_IDS` kind; later changes name it by `title`.
    AddFrame { title: String, kind: String },
    /// ER frames only. No `type` (or an empty one) is an untyped column.
    AddColumn {
        table: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flags: Option<Vec<String>>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    RemoveColumn {
        table: String,
        column: String,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
    SetColumn {
        table: String,
        column: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#type: Option<String>,
        /// The title of the frame this change is in; on a one-frame board it may be left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
    },
}

impl DiagramOp {
    /// The frame title the op names, if any. `add_frame` names none: it makes one.
    pub fn frame(&self) -> Option<&str> {
        match self {
            DiagramOp::AddFrame { .. } => None,
            DiagramOp::AddNode { frame, .. }
            | DiagramOp::RemoveNode { frame, .. }
            | DiagramOp::RenameNode { frame, .. }
            | DiagramOp::AddFlow { frame, .. }
            | DiagramOp::RemoveFlow { frame, .. }
            | DiagramOp::RelabelFlow { frame, .. }
            | DiagramOp::MoveToGroup { frame, .. }
            | DiagramOp::AddColumn { frame, .. }
            | DiagramOp::RemoveColumn { frame, .. }
            | DiagramOp::SetColumn { frame, .. } => frame.as_deref(),
        }
    }

    /// The same op naming `frame` instead; `add_frame` is left as it is.
    pub fn with_frame(mut self, to: Option<String>) -> DiagramOp {
        match &mut self {
            DiagramOp::AddFrame { .. } => {}
            DiagramOp::AddNode { frame, .. }
            | DiagramOp::RemoveNode { frame, .. }
            | DiagramOp::RenameNode { frame, .. }
            | DiagramOp::AddFlow { frame, .. }
            | DiagramOp::RemoveFlow { frame, .. }
            | DiagramOp::RelabelFlow { frame, .. }
            | DiagramOp::MoveToGroup { frame, .. }
            | DiagramOp::AddColumn { frame, .. }
            | DiagramOp::RemoveColumn { frame, .. }
            | DiagramOp::SetColumn { frame, .. } => *frame = to,
        }
        self
    }
}

/// The hash of the file text the model was shown.
pub fn base_hash_of(text: &str) -> String {
    format!("{:016x}", fnv1a64(text.as_bytes()))
}

fn name_schema() -> Value {
    json!({ "type": "string", "maxLength": NAME_CAP })
}

fn label_schema() -> Value {
    json!({ "type": "string", "maxLength": LABEL_CAP })
}

/// One op's branch; every op but `add_frame` takes an optional `frame`, the title of its frame.
fn branch(tag: &str, required: &[&str], mut properties: Value) -> Value {
    if tag != "add_frame" {
        properties["frame"] = name_schema();
    }
    json!({
        "type": "object",
        "properties": {
            tag: {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            }
        },
        "required": [tag],
        "additionalProperties": false,
    })
}

/// The JSON schema of [`ProposeInput`], written by hand to match the type field for field.
pub fn input_schema() -> Value {
    let ops = vec![
        branch(
            "add_node",
            &["name"],
            json!({
                "name": name_schema(),
                "kind": name_schema(),
                "id": name_schema(),
                "group": name_schema(),
            }),
        ),
        branch(
            "remove_node",
            &["target"],
            json!({ "target": name_schema() }),
        ),
        branch(
            "rename_node",
            &["target", "name"],
            json!({ "target": name_schema(), "name": name_schema() }),
        ),
        branch(
            "add_flow",
            &["from", "to"],
            json!({ "from": name_schema(), "to": name_schema(), "label": label_schema() }),
        ),
        branch(
            "remove_flow",
            &["from", "to"],
            json!({ "from": name_schema(), "to": name_schema(), "label": label_schema() }),
        ),
        branch(
            "relabel_flow",
            &["from", "to", "label"],
            json!({ "from": name_schema(), "to": name_schema(), "label": label_schema() }),
        ),
        branch(
            "move_to_group",
            &["target"],
            json!({
                "target": name_schema(),
                // Null or missing takes the shape out of every group.
                "group": { "type": ["string", "null"], "maxLength": NAME_CAP },
            }),
        ),
        branch(
            "add_frame",
            &["title", "kind"],
            json!({
                "title": name_schema(),
                "kind": { "type": "string", "enum": DIAGRAM_KIND_IDS },
            }),
        ),
        branch(
            "add_column",
            &["table", "name"],
            json!({
                "table": name_schema(),
                "name": name_schema(),
                "type": name_schema(),
                "flags": {
                    "type": "array",
                    "maxItems": COLUMN_FLAGS.len(),
                    "items": { "type": "string", "enum": COLUMN_FLAGS },
                },
            }),
        ),
        branch(
            "remove_column",
            &["table", "column"],
            json!({ "table": name_schema(), "column": name_schema() }),
        ),
        branch(
            "set_column",
            &["table", "column"],
            json!({
                "table": name_schema(),
                "column": name_schema(),
                "name": name_schema(),
                "type": name_schema(),
            }),
        ),
    ];
    json!({
        "type": "object",
        "properties": {
            "file": { "type": "string" },
            "base_hash": { "type": "string" },
            "ops": {
                "type": "array",
                "maxItems": MAX_OPS,
                "items": { "oneOf": ops },
            },
            "follow_up": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "maxLength": FOLLOW_UP_CHARS },
                },
                "required": ["question"],
                "additionalProperties": false,
            },
        },
        "required": ["file", "base_hash", "ops"],
        "additionalProperties": false,
    })
}

/// What the worker knows of the open file: its shapes, groups and lines with their line numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOutline {
    pub kind: Option<String>,
    /// The shape kinds this diagram takes.
    pub kinds: Vec<String>,
    pub nodes: Vec<OutlineNode>,
    pub groups: Vec<OutlineGroup>,
    pub links: Vec<OutlineLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub name: String,
    pub id: Option<String>,
    pub kind: Option<String>,
    pub group: Option<String>,
    pub line: u32,
    pub table: bool,
    /// An ER table's column names, in row order; none on every other shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineGroup {
    pub name: String,
    pub group: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineLink {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub line: u32,
    /// In an ERD, the column the line starts at (`from` is then its table).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_column: Option<String>,
}

/// What the Ask was pointed at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiagramScope {
    Whole,
    Selection { names: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DropReason {
    UnknownShape,
    UnknownGroup,
    UnknownFlow,
    NameTaken,
    IdReused,
    EmptyLabel,
    BadName,
    UnknownKind,
    OutsideSelection,
    DependsOnDropped,
    TooMany,
    /// The frame the change names is not on the board, or is a clashing copy.
    UnknownFrame,
    /// A new frame's title is a board title, ignoring case.
    FrameTaken,
    /// Past `MAX_NEW_FRAMES` in one proposal, or past `MAX_BOARD_FRAMES` on the board.
    TooManyFrames,
    UnknownColumn,
    ColumnTaken,
    /// A column change in a frame that is not an ER diagram.
    NotAnErd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetField {
    Target,
    From,
    To,
    Group,
}

/// One of the shapes (or lines) a word could mean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub name: String,
    pub id: Option<String>,
    pub line: u32,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChangeStatus {
    Ok,
    Dropped {
        reason: DropReason,
        message: String,
    },
    Ambiguous {
        field: TargetField,
        word: String,
        candidates: Vec<Candidate>,
    },
}

/// One checked change; `op` holds the resolved names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedChange {
    pub index: u32,
    pub op: DiagramOp,
    pub status: ChangeStatus,
    pub depends_on: Vec<u32>,
    /// On a board, the title of the frame the change was checked in. Records saved before
    /// boards have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
}

/// Invisible characters out (R2.2) and the ends trimmed, on every string.
pub fn clean_input(input: ProposeInput) -> ProposeInput {
    fn s(text: String) -> String {
        strip_invisible(&text).0.trim().to_string()
    }
    fn o(text: Option<String>) -> Option<String> {
        text.map(s)
    }
    let ops = input
        .ops
        .into_iter()
        .map(|op| match op {
            DiagramOp::AddNode {
                name,
                kind,
                id,
                group,
                frame,
            } => DiagramOp::AddNode {
                name: s(name),
                kind: o(kind),
                id: o(id),
                group: o(group),
                frame: o(frame),
            },
            DiagramOp::RemoveNode { target, frame } => DiagramOp::RemoveNode {
                target: s(target),
                frame: o(frame),
            },
            DiagramOp::RenameNode {
                target,
                name,
                frame,
            } => DiagramOp::RenameNode {
                target: s(target),
                name: s(name),
                frame: o(frame),
            },
            DiagramOp::AddFlow {
                from,
                to,
                label,
                frame,
            } => DiagramOp::AddFlow {
                from: s(from),
                to: s(to),
                label: o(label),
                frame: o(frame),
            },
            DiagramOp::RemoveFlow {
                from,
                to,
                label,
                frame,
            } => DiagramOp::RemoveFlow {
                from: s(from),
                to: s(to),
                label: o(label),
                frame: o(frame),
            },
            DiagramOp::RelabelFlow {
                from,
                to,
                label,
                frame,
            } => DiagramOp::RelabelFlow {
                from: s(from),
                to: s(to),
                label: s(label),
                frame: o(frame),
            },
            DiagramOp::MoveToGroup {
                target,
                group,
                frame,
            } => DiagramOp::MoveToGroup {
                target: s(target),
                group: o(group),
                frame: o(frame),
            },
            DiagramOp::AddFrame { title, kind } => DiagramOp::AddFrame {
                title: s(title),
                kind: s(kind),
            },
            DiagramOp::AddColumn {
                table,
                name,
                r#type,
                flags,
                frame,
            } => DiagramOp::AddColumn {
                table: s(table),
                name: s(name),
                r#type: o(r#type),
                flags: flags.map(|f| f.into_iter().map(s).collect()),
                frame: o(frame),
            },
            DiagramOp::RemoveColumn {
                table,
                column,
                frame,
            } => DiagramOp::RemoveColumn {
                table: s(table),
                column: s(column),
                frame: o(frame),
            },
            DiagramOp::SetColumn {
                table,
                column,
                name,
                r#type,
                frame,
            } => DiagramOp::SetColumn {
                table: s(table),
                column: s(column),
                name: o(name),
                r#type: o(r#type),
                frame: o(frame),
            },
        })
        .collect();
    ProposeInput {
        file: s(input.file),
        base_hash: s(input.base_hash),
        ops,
        // On one line and at most 300 characters, whatever the model sent; a blank question
        // asks nothing, so the call is read as a proposal.
        follow_up: input
            .follow_up
            .map(|f| FollowUp {
                question: s(f.question)
                    .split(|c: char| c.is_control())
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(FOLLOW_UP_CHARS)
                    .collect(),
            })
            .filter(|f| !f.question.is_empty()),
    }
}

/// A way one change fails, before it is dressed as a status.
enum Fail {
    Drop(DropReason, String),
    Ambiguous(TargetField, String, Vec<Candidate>),
    /// Kept apart so the caller can tell a dropped earlier add from a plain typo.
    UnknownShape(String),
    /// The same for anything else that was not found: `word` is what a dropped change would
    /// have brought in (a table, or `table.column`).
    Missing {
        reason: DropReason,
        message: String,
        word: String,
    },
}

fn drop_with(reason: DropReason, message: impl Into<String>) -> Fail {
    Fail::Drop(reason, message.into())
}

/// Lower case with runs of spaces folded to one.
fn fold(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_word_start(name_word: &str, prefix: &str) -> bool {
    name_word.starts_with(prefix)
}

/// Rule 4: after a leading article, every word starts a word of the name.
fn words_match(word: &str, name: &str) -> bool {
    let lower = word.trim().to_lowercase();
    let mut rest = lower.as_str();
    for article in ["the ", "a ", "an "] {
        if let Some(r) = rest.strip_prefix(article) {
            rest = r;
            break;
        }
    }
    let wanted: Vec<&str> = rest.split_whitespace().collect();
    if wanted.is_empty() {
        return false;
    }
    let name = name.to_lowercase();
    let have: Vec<&str> = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    wanted
        .iter()
        .all(|w| have.iter().any(|h| is_word_start(h, w)))
}

struct Producer {
    name: String,
    index: u32,
    ok: bool,
}

struct Checker {
    live: FlowOutline,
    selected: Option<HashSet<String>>,
    next_line: u32,
}

impl Checker {
    fn shape_candidate(&self, i: usize) -> Candidate {
        let node = &self.live.nodes[i];
        let first = self
            .live
            .links
            .iter()
            .filter(|l| l.from == node.name)
            .min_by_key(|l| l.line);
        let mut detail = format!("line {}", node.line);
        if let Some(label) = first.and_then(|l| l.label.as_ref()) {
            detail.push_str(&format!(", {label}"));
        }
        Candidate {
            name: node.name.clone(),
            id: node.id.clone(),
            line: node.line,
            detail,
        }
    }

    /// The position of the shape `word` means, by the four rules in order.
    fn resolve_shape(&self, word: &str, field: TargetField) -> Result<usize, Fail> {
        let nodes = &self.live.nodes;
        let folded = fold(word);
        let matches = |rule: usize, n: &OutlineNode| match rule {
            0 => n.name == word,
            1 => n.id.as_deref() == Some(word),
            2 => fold(&n.name) == folded,
            _ => words_match(word, &n.name),
        };
        for rule in 0..4 {
            let mut hits: Vec<usize> = (0..nodes.len())
                .filter(|&i| matches(rule, &nodes[i]))
                .collect();
            match hits.len() {
                0 => continue,
                1 => return Ok(hits[0]),
                _ => {
                    hits.sort_by_key(|&i| nodes[i].line);
                    let candidates = hits
                        .into_iter()
                        .take(5)
                        .map(|i| self.shape_candidate(i))
                        .collect();
                    return Err(Fail::Ambiguous(field, word.to_string(), candidates));
                }
            }
        }
        Err(Fail::UnknownShape(word.to_string()))
    }

    /// Groups resolve by an exact name, then by name ignoring case and repeated spaces.
    fn resolve_group(&self, word: &str) -> Result<String, Fail> {
        let groups = &self.live.groups;
        let folded = fold(word);
        let matches = |rule: usize, g: &OutlineGroup| match rule {
            0 => g.name == word,
            _ => fold(&g.name) == folded,
        };
        for rule in 0..2 {
            let mut hits: Vec<&OutlineGroup> = groups.iter().filter(|g| matches(rule, g)).collect();
            match hits.len() {
                0 => continue,
                1 => return Ok(hits[0].name.clone()),
                _ => {
                    hits.sort_by_key(|g| g.line);
                    let candidates = hits
                        .into_iter()
                        .take(5)
                        .map(|g| Candidate {
                            name: g.name.clone(),
                            id: None,
                            line: g.line,
                            detail: format!("line {}", g.line),
                        })
                        .collect();
                    return Err(Fail::Ambiguous(
                        TargetField::Group,
                        word.to_string(),
                        candidates,
                    ));
                }
            }
        }
        Err(drop_with(
            DropReason::UnknownGroup,
            format!("there is no group called {word}"),
        ))
    }

    /// A shape by its words, kept inside the selection when there is one.
    fn shape(&self, word: &str, field: TargetField) -> Result<String, Fail> {
        let i = self.resolve_shape(word, field)?;
        let name = self.live.nodes[i].name.clone();
        if let Some(sel) = &self.selected
            && !sel.contains(&name)
        {
            return Err(drop_with(
                DropReason::OutsideSelection,
                format!("{word} is outside the selection"),
            ));
        }
        Ok(name)
    }

    /// The one line from `from` to `to` (with `label` when given): its position and its ends.
    /// In an ERD a column end matches only that column's line; a table end, any line between
    /// the tables.
    fn resolve_line(
        &self,
        from: &str,
        to: &str,
        label: Option<&str>,
    ) -> Result<(usize, End, End), Fail> {
        let f = self.end(from, TargetField::From)?;
        let t = self.end(to, TargetField::To)?;
        let mut hits: Vec<usize> = (0..self.live.links.len())
            .filter(|&i| {
                let l = &self.live.links[i];
                l.from == f.shape
                    && l.to == t.shape
                    && (f.column.is_none() || l.from_column == f.column)
                    && (t.column.is_none() || l.to_column == t.column)
                    && label.is_none_or(|x| l.label.as_deref() == Some(x))
            })
            .collect();
        match hits.len() {
            0 => Err(drop_with(
                DropReason::UnknownFlow,
                format!("there is no line from {from} to {to}"),
            )),
            1 => Ok((hits[0], f, t)),
            _ => {
                hits.sort_by_key(|&i| self.live.links[i].line);
                let candidates = hits
                    .into_iter()
                    .take(5)
                    .map(|i| {
                        let l = &self.live.links[i];
                        let mut detail = format!("line {}", l.line);
                        if let Some(label) = &l.label {
                            detail.push_str(&format!(", {label}"));
                        }
                        Candidate {
                            name: format!("{} > {}", l.from, l.to),
                            id: None,
                            line: l.line,
                            detail,
                        }
                    })
                    .collect();
                Err(Fail::Ambiguous(
                    TargetField::Target,
                    format!("{from} to {to}"),
                    candidates,
                ))
            }
        }
    }

    fn is_erd(&self) -> bool {
        self.live.kind.as_deref() == Some("er")
    }

    fn need_erd(&self) -> Result<(), Fail> {
        if self.is_erd() {
            Ok(())
        } else {
            Err(drop_with(
                DropReason::NotAnErd,
                "columns are only in ER diagrams",
            ))
        }
    }

    /// The position of the ER table `word` means.
    fn table(&self, word: &str) -> Result<usize, Fail> {
        let name = match self.shape(word, TargetField::Target) {
            Ok(name) => name,
            Err(Fail::UnknownShape(w)) => {
                return Err(Fail::Missing {
                    reason: DropReason::UnknownShape,
                    message: format!("there is no table called {w}"),
                    word: w,
                });
            }
            Err(e) => return Err(e),
        };
        let i = self.live.nodes.iter().position(|n| n.name == name);
        match i {
            Some(i) if self.live.nodes[i].columns.is_some() => Ok(i),
            _ => Err(drop_with(
                DropReason::UnknownShape,
                format!("{name} is not a table"),
            )),
        }
    }

    /// The position of `word` among table `t`'s columns: exact, then the one equal ignoring case.
    fn column(&self, t: usize, word: &str) -> Result<usize, Fail> {
        let node = &self.live.nodes[t];
        let columns = node.columns.as_deref().unwrap_or_default();
        if let Some(i) = columns.iter().position(|c| c == word) {
            return Ok(i);
        }
        let lower = word.to_lowercase();
        let hits: Vec<usize> = (0..columns.len())
            .filter(|&i| columns[i].to_lowercase() == lower)
            .collect();
        match hits[..] {
            [i] => Ok(i),
            _ => Err(Fail::Missing {
                reason: DropReason::UnknownColumn,
                message: format!("there is no column {}.{word}", node.name),
                word: format!("{}.{word}", node.name),
            }),
        }
    }

    /// Refuses a column name table `t` already has, ignoring case (`except` is the column
    /// being renamed).
    fn column_taken(&self, t: usize, name: &str, except: Option<usize>) -> Result<(), Fail> {
        let node = &self.live.nodes[t];
        let lower = name.to_lowercase();
        let taken = node
            .columns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .enumerate()
            .any(|(i, c)| Some(i) != except && c.to_lowercase() == lower);
        if taken {
            return Err(drop_with(
                DropReason::ColumnTaken,
                format!("there is already a column {}.{name}", node.name),
            ));
        }
        Ok(())
    }

    /// One end of a line. In an ERD `table.column` names a column of a table (the parse's
    /// rule: a whole shape name first, then the longest table before a dot).
    fn end(&self, word: &str, field: TargetField) -> Result<End, Fail> {
        match self.shape(word, field) {
            Ok(name) => Ok(End {
                text: name.clone(),
                shape: name,
                column: None,
            }),
            Err(Fail::UnknownShape(w)) if self.is_erd() => {
                let mut cut = word.rfind('.');
                while let Some(dot) = cut.filter(|&d| d > 0) {
                    match self.shape(&word[..dot], field) {
                        Ok(table) => {
                            let t = self.live.nodes.iter().position(|n| n.name == table);
                            if let Some(t) = t.filter(|&t| self.live.nodes[t].columns.is_some()) {
                                let c = self.column(t, &word[dot + 1..])?;
                                let column =
                                    self.live.nodes[t].columns.as_ref().unwrap()[c].clone();
                                return Ok(End {
                                    text: format!("{table}.{column}"),
                                    shape: table,
                                    column: Some(column),
                                });
                            }
                        }
                        Err(Fail::UnknownShape(_)) => {}
                        Err(e) => return Err(e),
                    }
                    cut = word[..dot].rfind('.');
                }
                Err(Fail::UnknownShape(w))
            }
            Err(e) => Err(e),
        }
    }

    fn fresh_line(&mut self) -> u32 {
        self.next_line += 1;
        self.next_line
    }

    fn name_taken(&self, name: &str, except: Option<&str>) -> Result<(), Fail> {
        let folded = fold(name);
        if self
            .live
            .nodes
            .iter()
            .any(|n| fold(&n.name) == folded && Some(n.name.as_str()) != except)
        {
            return Err(drop_with(
                DropReason::NameTaken,
                format!("there is already a shape called {name}"),
            ));
        }
        Ok(())
    }

    /// Checks `op`, applies it to the live outline when it passes, and returns the op with real
    /// names plus the shape names it used.
    fn apply(&mut self, op: &DiagramOp) -> Result<(DiagramOp, Vec<String>), Fail> {
        match op {
            DiagramOp::AddNode {
                name,
                kind,
                id,
                group,
                frame,
            } => {
                let name = name.trim().to_string();
                check_name(&name)?;
                self.name_taken(&name, None)?;
                let id = nonempty(id);
                if let Some(id) = &id {
                    check_one_line(id)?;
                    if let Some(other) = self
                        .live
                        .nodes
                        .iter()
                        .find(|n| n.id.as_deref() == Some(id.as_str()))
                    {
                        return Err(drop_with(
                            DropReason::IdReused,
                            format!("id {id} is already used by {}", other.name),
                        ));
                    }
                }
                let kind = match nonempty(kind) {
                    None => None,
                    Some(k) => {
                        let known = self.live.kinds.iter().find(|x| **x == k).or_else(|| {
                            self.live.kinds.iter().find(|x| x.eq_ignore_ascii_case(&k))
                        });
                        match known {
                            Some(x) => Some(x.clone()),
                            None => {
                                return Err(drop_with(
                                    DropReason::UnknownKind,
                                    format!("{k} is not a shape of this diagram"),
                                ));
                            }
                        }
                    }
                };
                let group = match nonempty(group) {
                    None => None,
                    Some(g) => Some(self.resolve_group(&g)?),
                };
                let line = self.fresh_line();
                self.live.nodes.push(OutlineNode {
                    name: name.clone(),
                    id: id.clone(),
                    kind: kind.clone(),
                    group: group.clone(),
                    line,
                    table: false,
                    // Every shape an ERD takes is a table.
                    columns: (self.is_erd()
                        && kind.as_deref().is_none_or(|k| k == "entity" || k == "weak"))
                    .then(Vec::new),
                });
                if let Some(sel) = &mut self.selected {
                    sel.insert(name.clone());
                }
                Ok((
                    DiagramOp::AddNode {
                        name,
                        kind,
                        id,
                        group,
                        frame: frame.clone(),
                    },
                    vec![],
                ))
            }
            DiagramOp::RemoveNode { target, frame } => {
                let t = self.shape(target, TargetField::Target)?;
                self.live.nodes.retain(|n| n.name != t);
                self.live.links.retain(|l| l.from != t && l.to != t);
                Ok((
                    DiagramOp::RemoveNode {
                        target: t.clone(),
                        frame: frame.clone(),
                    },
                    vec![t],
                ))
            }
            DiagramOp::RenameNode {
                target,
                name,
                frame,
            } => {
                let name = name.trim().to_string();
                check_name(&name)?;
                let t = self.shape(target, TargetField::Target)?;
                self.name_taken(&name, Some(&t))?;
                for n in &mut self.live.nodes {
                    if n.name == t {
                        n.name = name.clone();
                    }
                }
                for l in &mut self.live.links {
                    if l.from == t {
                        l.from = name.clone();
                    }
                    if l.to == t {
                        l.to = name.clone();
                    }
                }
                if let Some(sel) = &mut self.selected
                    && sel.remove(&t)
                {
                    sel.insert(name.clone());
                }
                Ok((
                    DiagramOp::RenameNode {
                        target: t.clone(),
                        name,
                        frame: frame.clone(),
                    },
                    vec![t],
                ))
            }
            DiagramOp::AddFlow {
                from,
                to,
                label,
                frame,
            } => {
                let label = match label {
                    None => None,
                    Some(l) => Some(check_label(l)?),
                };
                let f = self.end(from, TargetField::From)?;
                let t = self.end(to, TargetField::To)?;
                let line = self.fresh_line();
                self.live.links.push(OutlineLink {
                    from: f.shape.clone(),
                    to: t.shape.clone(),
                    label: label.clone(),
                    line,
                    from_column: f.column.clone(),
                    to_column: t.column.clone(),
                });
                Ok((
                    DiagramOp::AddFlow {
                        from: f.text.clone(),
                        to: t.text.clone(),
                        label,
                        frame: frame.clone(),
                    },
                    used_by(&[f, t]),
                ))
            }
            DiagramOp::RemoveFlow {
                from,
                to,
                label,
                frame,
            } => {
                let given = label.as_deref().map(str::trim);
                let (i, f, t) = self.resolve_line(from, to, given)?;
                let removed = self.live.links.remove(i);
                Ok((
                    DiagramOp::RemoveFlow {
                        from: f.text.clone(),
                        to: t.text.clone(),
                        label: removed.label,
                        frame: frame.clone(),
                    },
                    used_by(&[f, t]),
                ))
            }
            DiagramOp::RelabelFlow {
                from,
                to,
                label,
                frame,
            } => {
                let label = check_label(label)?;
                let (i, f, t) = self.resolve_line(from, to, None)?;
                self.live.links[i].label = Some(label.clone());
                Ok((
                    DiagramOp::RelabelFlow {
                        from: f.text.clone(),
                        to: t.text.clone(),
                        label,
                        frame: frame.clone(),
                    },
                    used_by(&[f, t]),
                ))
            }
            DiagramOp::MoveToGroup {
                target,
                group,
                frame,
            } => {
                let group = match nonempty(group) {
                    None => None,
                    Some(g) => Some(self.resolve_group(&g)?),
                };
                let t = self.shape(target, TargetField::Target)?;
                for n in &mut self.live.nodes {
                    if n.name == t {
                        n.group = group.clone();
                    }
                }
                Ok((
                    DiagramOp::MoveToGroup {
                        target: t.clone(),
                        group,
                        frame: frame.clone(),
                    },
                    vec![t],
                ))
            }
            // A board adds frames; one diagram on its own has nowhere to put one.
            DiagramOp::AddFrame { .. } => Err(drop_with(
                DropReason::UnknownFrame,
                "New diagrams are added on a board.",
            )),
            DiagramOp::AddColumn {
                table,
                name,
                r#type,
                flags,
                frame,
            } => {
                self.need_erd()?;
                let t = self.table(table)?;
                let name = name.trim().to_string();
                check_column_name(&name)?;
                self.column_taken(t, &name, None)?;
                let r#type = column_type(r#type)?;
                let flags = column_flags(flags.as_deref().unwrap_or_default())?;
                let node = &mut self.live.nodes[t];
                node.columns.get_or_insert_with(Vec::new).push(name.clone());
                let table = node.name.clone();
                let used = vec![table.clone(), format!("{table}.{name}")];
                Ok((
                    DiagramOp::AddColumn {
                        table,
                        name,
                        r#type,
                        flags: (!flags.is_empty()).then_some(flags),
                        frame: frame.clone(),
                    },
                    used,
                ))
            }
            DiagramOp::RemoveColumn {
                table,
                column,
                frame,
            } => {
                self.need_erd()?;
                let t = self.table(table)?;
                let c = self.column(t, column.trim())?;
                let node = &mut self.live.nodes[t];
                let column = node.columns.get_or_insert_with(Vec::new).remove(c);
                let table = node.name.clone();
                // The lines that use the column go with it, as `deleteColumn` lands them.
                self.live.links.retain(|l| {
                    !((l.from == table && l.from_column.as_ref() == Some(&column))
                        || (l.to == table && l.to_column.as_ref() == Some(&column)))
                });
                let used = vec![table.clone(), format!("{table}.{column}")];
                Ok((
                    DiagramOp::RemoveColumn {
                        table,
                        column,
                        frame: frame.clone(),
                    },
                    used,
                ))
            }
            DiagramOp::SetColumn {
                table,
                column,
                name,
                r#type,
                frame,
            } => {
                self.need_erd()?;
                let t = self.table(table)?;
                let c = self.column(t, column.trim())?;
                let name = nonempty(name);
                if let Some(name) = &name {
                    check_column_name(name)?;
                    self.column_taken(t, name, Some(c))?;
                }
                let r#type = column_type(r#type)?;
                let node = &mut self.live.nodes[t];
                let columns = node.columns.get_or_insert_with(Vec::new);
                let column = columns[c].clone();
                if let Some(name) = &name {
                    columns[c] = name.clone();
                }
                let table = node.name.clone();
                // The lines that name the column follow it, as `setColumn` lands them.
                if let Some(name) = &name {
                    for l in &mut self.live.links {
                        if l.from == table && l.from_column.as_ref() == Some(&column) {
                            l.from_column = Some(name.clone());
                        }
                        if l.to == table && l.to_column.as_ref() == Some(&column) {
                            l.to_column = Some(name.clone());
                        }
                    }
                }
                let used = vec![table.clone(), format!("{table}.{column}")];
                Ok((
                    DiagramOp::SetColumn {
                        table,
                        column,
                        name,
                        r#type,
                        frame: frame.clone(),
                    },
                    used,
                ))
            }
        }
    }
}

/// One end of a line: the shape (an ERD's table) it is on, the column when it names one, and
/// the end as the change writes it (`table.column`, or the shape's name).
struct End {
    shape: String,
    column: Option<String>,
    text: String,
}

/// The names a line's ends use: each shape, and each `table.column`.
fn used_by(ends: &[End]) -> Vec<String> {
    let mut used = Vec::new();
    for e in ends {
        used.push(e.shape.clone());
        if e.column.is_some() {
            used.push(e.text.clone());
        }
    }
    used
}

fn check_column_name(name: &str) -> Result<(), Fail> {
    if name.trim().is_empty() {
        return Err(drop_with(DropReason::EmptyLabel, "a column needs a name"));
    }
    if is_column_name(name) {
        Ok(())
    } else {
        Err(drop_with(
            DropReason::BadName,
            format!("{name} is not a column name"),
        ))
    }
}

/// A column's type: none when missing or empty, one line of at most `NAME_CAP` characters.
fn column_type(text: &Option<String>) -> Result<Option<String>, Fail> {
    let Some(t) = nonempty(text) else {
        return Ok(None);
    };
    if t.contains(['\n', '\r']) {
        return Err(drop_with(
            DropReason::BadName,
            "a type cannot hold a line break",
        ));
    }
    if t.chars().count() > NAME_CAP {
        return Err(drop_with(
            DropReason::BadName,
            format!("the type is longer than {NAME_CAP} characters"),
        ));
    }
    Ok(Some(t))
}

/// Flags as `COLUMN_FLAGS` spells them, each once, in the order the writer writes them.
fn column_flags(flags: &[String]) -> Result<Vec<String>, Fail> {
    let mut seen = [false; COLUMN_FLAGS.len()];
    // An empty flag says nothing; it is left out.
    for flag in flags.iter().filter(|f| !f.trim().is_empty()) {
        let Some(i) = COLUMN_FLAGS.iter().position(|f| *f == fold(flag)) else {
            return Err(drop_with(
                DropReason::BadName,
                format!("{} is not a column flag", flag.trim()),
            ));
        };
        seen[i] = true;
    }
    Ok(COLUMN_FLAGS
        .iter()
        .zip(seen)
        .filter(|(_, on)| *on)
        .map(|(f, _)| f.to_string())
        .collect())
}

fn nonempty(text: &Option<String>) -> Option<String> {
    text.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn check_one_line(text: &str) -> Result<(), Fail> {
    if text.contains(['\n', '\r']) {
        return Err(drop_with(
            DropReason::BadName,
            "a name cannot hold a line break",
        ));
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), Fail> {
    check_one_line(name)?;
    if name.chars().count() > NAME_CAP {
        return Err(drop_with(
            DropReason::BadName,
            format!("the name is longer than {NAME_CAP} characters"),
        ));
    }
    if name.trim().is_empty() {
        return Err(drop_with(
            DropReason::EmptyLabel,
            "the change leaves an empty label",
        ));
    }
    Ok(())
}

fn check_label(label: &str) -> Result<String, Fail> {
    let label = label.trim();
    check_one_line(label)?;
    if label.chars().count() > LABEL_CAP {
        return Err(drop_with(
            DropReason::BadName,
            format!("the label is longer than {LABEL_CAP} characters"),
        ));
    }
    if label.is_empty() {
        return Err(drop_with(
            DropReason::EmptyLabel,
            "the change leaves an empty label",
        ));
    }
    Ok(label.to_string())
}

/// The name an op brings into the diagram, if any.
fn produced_by(op: &DiagramOp) -> Option<String> {
    match op {
        DiagramOp::AddNode { name, .. } | DiagramOp::RenameNode { name, .. } => {
            Some(name.trim().to_string())
        }
        DiagramOp::AddColumn { table, name, .. }
        | DiagramOp::SetColumn {
            table,
            name: Some(name),
            ..
        } => Some(format!("{}.{}", table.trim(), name.trim())),
        _ => None,
    }
}

/// One outline's checker and the names its passed or dropped changes brought in.
struct Run {
    checker: Checker,
    producers: Vec<Producer>,
}

impl Run {
    fn new(outline: &FlowOutline, selected: Option<HashSet<String>>) -> Run {
        let next_line = outline
            .nodes
            .iter()
            .map(|n| n.line)
            .chain(outline.groups.iter().map(|g| g.line))
            .chain(outline.links.iter().map(|l| l.line))
            .max()
            .unwrap_or(0);
        Run {
            checker: Checker {
                live: outline.clone(),
                selected,
                next_line,
            },
            producers: Vec::new(),
        }
    }

    /// Checks one op over the live outline; later ops in this run see it when it passes.
    fn op(&mut self, index: u32, op: &DiagramOp) -> (DiagramOp, ChangeStatus, Vec<u32>) {
        let produced = produced_by(op);
        let (op_out, status, depends_on) = match self.checker.apply(op) {
            Ok((resolved, used)) => {
                let mut deps: Vec<u32> = self
                    .producers
                    .iter()
                    .filter(|p| p.ok && used.contains(&p.name))
                    .map(|p| p.index)
                    .collect();
                deps.sort_unstable();
                deps.dedup();
                (resolved, ChangeStatus::Ok, deps)
            }
            Err(Fail::Drop(reason, message)) => (
                op.clone(),
                ChangeStatus::Dropped { reason, message },
                vec![],
            ),
            Err(Fail::Ambiguous(field, word, candidates)) => (
                op.clone(),
                ChangeStatus::Ambiguous {
                    field,
                    word,
                    candidates,
                },
                vec![],
            ),
            Err(fail @ (Fail::UnknownShape(_) | Fail::Missing { .. })) => {
                let (reason, message, word) = match fail {
                    Fail::Missing {
                        reason,
                        message,
                        word,
                    } => (reason, message, word),
                    Fail::UnknownShape(word) => (
                        DropReason::UnknownShape,
                        format!("there is no shape called {word}"),
                        word,
                    ),
                    _ => unreachable!(),
                };
                // Only the word that found nothing can lean on a change that was dropped.
                let mut deps: Vec<u32> = self
                    .producers
                    .iter()
                    .filter(|p| !p.ok && fold(&p.name) == fold(&word))
                    .map(|p| p.index)
                    .collect();
                deps.sort_unstable();
                deps.dedup();
                let status = if deps.is_empty() {
                    ChangeStatus::Dropped { reason, message }
                } else {
                    ChangeStatus::Dropped {
                        reason: DropReason::DependsOnDropped,
                        message: "it needs a change that was dropped".to_string(),
                    }
                };
                (op.clone(), status, deps)
            }
        };
        if let Some(name) = produced {
            self.producers.push(Producer {
                name,
                index,
                ok: status == ChangeStatus::Ok,
            });
        }
        (op_out, status, depends_on)
    }
}

fn too_many() -> ChangeStatus {
    ChangeStatus::Dropped {
        reason: DropReason::TooMany,
        message: format!("more than {MAX_OPS} changes in one go"),
    }
}

/// Checks every proposed change in order over a live copy of the outline, so later changes see
/// earlier ones that passed.
pub fn check(
    input: &ProposeInput,
    outline: &FlowOutline,
    scope: &DiagramScope,
) -> Vec<ProposedChange> {
    let selected = match scope {
        DiagramScope::Whole => None,
        DiagramScope::Selection { names } => Some(names.iter().cloned().collect()),
    };
    let mut run = Run::new(outline, selected);
    let mut out = Vec::with_capacity(input.ops.len());
    for (i, op) in input.ops.iter().enumerate() {
        let index = i as u32;
        let (op, status, depends_on) = if i >= MAX_OPS {
            (op.clone(), too_many(), vec![])
        } else {
            run.op(index, op)
        };
        out.push(ProposedChange {
            index,
            op,
            status,
            depends_on,
            frame: None,
        });
    }
    out
}

/// The frame a change names (Decision 2): an exact title, else the one title equal to it
/// ignoring case; on a one-frame board no name means that frame. A clashing frame (a title
/// already taken) is never a target. Returns the frame's position in `frames`.
pub fn resolve_frame(frames: &[BoardFrameInput], word: Option<&str>) -> Option<usize> {
    let titles: Vec<(&str, bool)> = frames.iter().map(|f| (f.title.as_str(), f.clash)).collect();
    resolve_among(&titles, word)
}

/// `resolve_frame` over `(title, clash)` pairs.
fn resolve_among(titles: &[(&str, bool)], word: Option<&str>) -> Option<usize> {
    let word = word.map(str::trim).filter(|w| !w.is_empty());
    let Some(word) = word else {
        return (titles.len() == 1 && !titles[0].1).then_some(0);
    };
    let open = || (0..titles.len()).filter(|&i| !titles[i].1);
    if let Some(i) = open().find(|&i| titles[i].0 == word) {
        return Some(i);
    }
    let lower = word.to_lowercase();
    let mut hits = open().filter(|&i| titles[i].0.to_lowercase() == lower);
    match (hits.next(), hits.next()) {
        (Some(i), None) => Some(i),
        _ => None,
    }
}

/// A frame a check can put changes in: one of the board's, or one an `add_frame` made.
struct Target {
    title: String,
    clash: bool,
    /// The `add_frame` that made it; every change in it needs that one.
    made_by: Option<u32>,
    run: Option<Run>,
}

/// Checks an `add_frame` against the board and the frames added so far (Decision 3).
fn check_add_frame(
    title: &str,
    kind: &str,
    targets: &[Target],
    added: usize,
) -> std::result::Result<(String, &'static str), ChangeStatus> {
    let dropped = |reason, message: String| ChangeStatus::Dropped { reason, message };
    let title = title.trim();
    if let Err(Fail::Drop(reason, message)) = check_name(title) {
        return Err(dropped(reason, message));
    }
    if kind.trim().is_empty() {
        return Err(dropped(
            DropReason::UnknownKind,
            "the new diagram needs a kind".to_string(),
        ));
    }
    let Some(kind) = DIAGRAM_KIND_IDS
        .iter()
        .find(|k| k.eq_ignore_ascii_case(kind.trim()))
    else {
        return Err(dropped(
            DropReason::UnknownKind,
            format!("{} is not a diagram kind", kind.trim()),
        ));
    };
    let lower = title.to_lowercase();
    if targets.iter().any(|t| t.title.to_lowercase() == lower) {
        return Err(dropped(
            DropReason::FrameTaken,
            format!("There is already a diagram called {title} on this board."),
        ));
    }
    if targets.len() >= MAX_BOARD_FRAMES {
        return Err(dropped(
            DropReason::TooManyFrames,
            format!("A board holds at most {MAX_BOARD_FRAMES} diagrams."),
        ));
    }
    if added >= MAX_NEW_FRAMES {
        return Err(dropped(
            DropReason::TooManyFrames,
            format!("There are at most {MAX_NEW_FRAMES} new diagrams in one go."),
        ));
    }
    Ok((title.to_string(), kind))
}

/// Checks a board's changes: each in the frame it names, over a live copy of that frame's
/// outline, in order. Input indexes are kept; `depends_on` stays within a frame, and
/// `MAX_OPS` counts across frames. An `add_frame` that passes makes an empty frame of its
/// kind that later changes may name; each of them needs it.
///
/// A change with no `frame` resolves only while there is one target: on a one-frame board
/// it is that frame before an `add_frame` passes, and after it (two targets) the same change
/// drops `UnknownFrame` ("The change does not name a diagram on this board.").
pub fn check_board(input: &ProposeInput, board: &BoardInput) -> Vec<ProposedChange> {
    let mut targets: Vec<Target> = board
        .frames
        .iter()
        .map(|f| Target {
            title: f.title.clone(),
            clash: f.clash,
            made_by: None,
            run: None,
        })
        .collect();
    // Titles of `add_frame`s that were dropped, for the changes that name them.
    let mut dropped_frames: Vec<(String, u32)> = Vec::new();
    let mut added = 0usize;
    let mut out = Vec::with_capacity(input.ops.len());
    for (i, op) in input.ops.iter().enumerate() {
        let index = i as u32;
        let (op, status, depends_on, frame) = if i >= MAX_OPS {
            (op.clone(), too_many(), vec![], None)
        } else if let DiagramOp::AddFrame { title, kind } = op {
            match check_add_frame(title, kind, &targets, added) {
                Ok((title, kind)) => {
                    added += 1;
                    // A later try with this title is the frame changes now mean.
                    let lower = title.to_lowercase();
                    dropped_frames.retain(|(t, _)| *t != lower);
                    let kinds = SHAPE_KINDS
                        .iter()
                        .find(|(k, _)| *k == kind)
                        .map_or(&[][..], |(_, kinds)| *kinds);
                    let empty = FlowOutline {
                        kind: Some(kind.to_string()),
                        kinds: kinds.iter().map(|k| k.to_string()).collect(),
                        nodes: Vec::new(),
                        groups: Vec::new(),
                        links: Vec::new(),
                    };
                    targets.push(Target {
                        title: title.clone(),
                        clash: false,
                        made_by: Some(index),
                        run: Some(Run::new(&empty, None)),
                    });
                    let op = DiagramOp::AddFrame {
                        title: title.clone(),
                        kind: kind.to_string(),
                    };
                    (op, ChangeStatus::Ok, vec![], Some(title))
                }
                Err(status) => {
                    dropped_frames.push((title.trim().to_lowercase(), index));
                    (op.clone(), status, vec![], None)
                }
            }
        } else {
            let word = op.frame().map(str::trim).filter(|w| !w.is_empty());
            // A change naming a new frame that was dropped needs that `add_frame`, even when a
            // board frame has the same title: it was never meant for that one.
            let needs = word
                .map(str::to_lowercase)
                .and_then(|w| dropped_frames.iter().find(|(t, _)| *t == w))
                .map(|(_, i)| *i);
            let titles: Vec<(&str, bool)> = targets
                .iter()
                .map(|t| (t.title.as_str(), t.clash))
                .collect();
            let at = resolve_among(&titles, op.frame());
            match (needs, at) {
                (Some(needs), _) => {
                    let status = ChangeStatus::Dropped {
                        reason: DropReason::DependsOnDropped,
                        message: "it needs a change that was dropped".to_string(),
                    };
                    (op.clone(), status, vec![needs], None)
                }
                (None, Some(at)) => {
                    let target = &mut targets[at];
                    let run = match &mut target.run {
                        Some(run) => run,
                        empty => empty.insert(Run::new(&board.frames[at].outline, None)),
                    };
                    let (resolved, status, mut deps) = run.op(index, op);
                    if let Some(made_by) = target.made_by
                        && status == ChangeStatus::Ok
                    {
                        deps.insert(0, made_by);
                    }
                    let title = Some(target.title.clone());
                    (resolved.with_frame(title.clone()), status, deps, title)
                }
                (None, None) => {
                    let status = ChangeStatus::Dropped {
                        reason: DropReason::UnknownFrame,
                        message: match word {
                            Some(title) => {
                                format!("There is no diagram called {title} on this board.")
                            }
                            None => "The change does not name a diagram on this board.".to_string(),
                        },
                    };
                    (op.clone(), status, vec![], None)
                }
            }
        };
        out.push(ProposedChange {
            index,
            op,
            status,
            depends_on,
            frame,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, id: Option<&str>, line: u32) -> OutlineNode {
        OutlineNode {
            name: name.into(),
            id: id.map(Into::into),
            kind: None,
            group: None,
            line,
            table: false,
            columns: None,
        }
    }

    fn link(from: &str, to: &str, label: Option<&str>, line: u32) -> OutlineLink {
        OutlineLink {
            from: from.into(),
            to: to.into(),
            label: label.map(Into::into),
            line,
            from_column: None,
            to_column: None,
        }
    }

    fn outline() -> FlowOutline {
        FlowOutline {
            kind: Some("flowchart".into()),
            kinds: vec!["start".into(), "process".into(), "decision".into()],
            nodes: vec![
                node("Order placed", Some("1.1"), 2),
                node("Pick and pack", Some("2.1"), 3),
                node("Ship", None, 4),
            ],
            groups: vec![OutlineGroup {
                name: "Warehouse".into(),
                group: None,
                line: 1,
            }],
            links: vec![
                link("Order placed", "Pick and pack", None, 5),
                link("Pick and pack", "Ship", Some("boxed"), 6),
            ],
        }
    }

    fn input(ops: Vec<DiagramOp>) -> ProposeInput {
        ProposeInput {
            file: "a.flow".into(),
            base_hash: "0".into(),
            ops,
            follow_up: None,
        }
    }

    fn run(ops: Vec<DiagramOp>) -> Vec<ProposedChange> {
        check(&input(ops), &outline(), &DiagramScope::Whole)
    }

    fn add(name: &str) -> DiagramOp {
        DiagramOp::AddNode {
            name: name.into(),
            kind: None,
            id: None,
            group: None,
            frame: None,
        }
    }

    fn flow(from: &str, to: &str) -> DiagramOp {
        DiagramOp::AddFlow {
            from: from.into(),
            to: to.into(),
            label: None,
            frame: None,
        }
    }

    fn dropped(change: &ProposedChange) -> (DropReason, &str) {
        match &change.status {
            ChangeStatus::Dropped { reason, message } => (*reason, message),
            other => panic!("expected Dropped, got {other:?}"),
        }
    }

    #[test]
    fn schema_snapshot() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/ai/diagram_tool_schema.json"
        );
        let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(input_schema(), want);
    }

    #[test]
    fn schema_matches_every_variant() {
        let samples = vec![
            DiagramOp::AddNode {
                name: "a".into(),
                kind: Some("k".into()),
                id: Some("i".into()),
                group: Some("g".into()),
                frame: Some("f".into()),
            },
            DiagramOp::RemoveNode {
                target: "a".into(),
                frame: Some("f".into()),
            },
            DiagramOp::RenameNode {
                target: "a".into(),
                name: "b".into(),
                frame: Some("f".into()),
            },
            DiagramOp::AddFlow {
                from: "a".into(),
                to: "b".into(),
                label: Some("l".into()),
                frame: Some("f".into()),
            },
            DiagramOp::RemoveFlow {
                from: "a".into(),
                to: "b".into(),
                label: Some("l".into()),
                frame: Some("f".into()),
            },
            DiagramOp::RelabelFlow {
                from: "a".into(),
                to: "b".into(),
                label: "l".into(),
                frame: Some("f".into()),
            },
            DiagramOp::MoveToGroup {
                target: "a".into(),
                group: Some("g".into()),
                frame: Some("f".into()),
            },
            DiagramOp::AddFrame {
                title: "t".into(),
                kind: "er".into(),
            },
            DiagramOp::AddColumn {
                table: "a".into(),
                name: "c".into(),
                r#type: Some("int".into()),
                flags: Some(vec!["pk".into()]),
                frame: Some("f".into()),
            },
            DiagramOp::RemoveColumn {
                table: "a".into(),
                column: "c".into(),
                frame: Some("f".into()),
            },
            DiagramOp::SetColumn {
                table: "a".into(),
                column: "c".into(),
                name: Some("d".into()),
                r#type: Some("text".into()),
                frame: Some("f".into()),
            },
        ];
        let schema = input_schema();
        let branches = schema["properties"]["ops"]["items"]["oneOf"]
            .as_array()
            .unwrap();
        assert_eq!(branches.len(), samples.len());
        assert_eq!(schema["properties"]["ops"]["maxItems"], 50);
        for sample in samples {
            let wire = serde_json::to_value(&sample).unwrap();
            let (tag, body) = wire.as_object().unwrap().iter().next().unwrap();
            let branch = branches
                .iter()
                .find(|b| b["properties"].get(tag).is_some())
                .unwrap_or_else(|| panic!("no branch for {tag}"));
            let props = branch["properties"][tag]["properties"].as_object().unwrap();
            let mut have: Vec<&String> = body.as_object().unwrap().keys().collect();
            let mut want: Vec<&String> = props.keys().collect();
            have.sort();
            want.sort();
            assert_eq!(have, want, "{tag}");
            let back: DiagramOp = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(back, sample);
        }
    }

    #[test]
    fn move_to_group_takes_a_null_or_missing_group() {
        for text in [
            r#"{"move_to_group":{"target":"A","group":null}}"#,
            r#"{"move_to_group":{"target":"A"}}"#,
        ] {
            let op: DiagramOp = serde_json::from_str(text).unwrap();
            assert_eq!(
                op,
                DiagramOp::MoveToGroup {
                    target: "A".into(),
                    group: None,
                    frame: None
                },
                "{text}"
            );
        }
    }

    #[test]
    fn unknown_field_is_refused() {
        let bad = r#"{"add_node":{"name":"A","colour":"red"}}"#;
        assert!(serde_json::from_str::<DiagramOp>(bad).is_err());
        let bad = r#"{"file":"a","base_hash":"b","ops":[],"extra":1}"#;
        assert!(serde_json::from_str::<ProposeInput>(bad).is_err());
    }

    #[test]
    fn base_hash_is_sixteen_hex() {
        let h = base_hash_of("a -> b");
        assert_eq!(h.len(), 16);
        assert_eq!(h, base_hash_of("a -> b"));
        assert_ne!(h, base_hash_of("a -> c"));
    }

    #[test]
    fn unknown_shape_dropped() {
        let out = run(vec![flow("Ship", "Shipping")]);
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::UnknownShape,
                "there is no shape called Shipping"
            )
        );
    }

    #[test]
    fn id_reused_dropped() {
        let out = run(vec![DiagramOp::AddNode {
            name: "New".into(),
            kind: None,
            id: Some("2.1".into()),
            group: None,
            frame: None,
        }]);
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::IdReused,
                "id 2.1 is already used by Pick and pack"
            )
        );
    }

    #[test]
    fn empty_label_dropped() {
        let out = run(vec![
            DiagramOp::RenameNode {
                target: "Ship".into(),
                name: "  ".into(),
                frame: None,
            },
            DiagramOp::RelabelFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: "".into(),
                frame: None,
            },
        ]);
        assert_eq!(
            dropped(&out[0]),
            (DropReason::EmptyLabel, "the change leaves an empty label")
        );
        assert_eq!(dropped(&out[1]).0, DropReason::EmptyLabel);
    }

    #[test]
    fn name_taken_dropped() {
        let out = run(vec![add("Ship"), add("order PLACED")]);
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::NameTaken,
                "there is already a shape called Ship"
            )
        );
        assert_eq!(dropped(&out[1]).0, DropReason::NameTaken);
    }

    #[test]
    fn unknown_kind_dropped() {
        let out = run(vec![DiagramOp::AddNode {
            name: "Stock".into(),
            kind: Some("store".into()),
            id: None,
            group: None,
            frame: None,
        }]);
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::UnknownKind,
                "store is not a shape of this diagram"
            )
        );
    }

    #[test]
    fn unknown_group_dropped() {
        let out = run(vec![DiagramOp::MoveToGroup {
            target: "Ship".into(),
            group: Some("Dock".into()),
            frame: None,
        }]);
        assert_eq!(
            dropped(&out[0]),
            (DropReason::UnknownGroup, "there is no group called Dock")
        );
    }

    #[test]
    fn resolve_by_id_and_case() {
        let out = run(vec![
            DiagramOp::RenameNode {
                target: "2.1".into(),
                name: "Pack".into(),
                frame: None,
            },
            flow("order placed", "Ship"),
            flow("Order placed", "pick  AND pack"),
        ]);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(
            out[0].op,
            DiagramOp::RenameNode {
                target: "Pick and pack".into(),
                name: "Pack".into(),
                frame: None
            }
        );
        assert_eq!(out[1].op, flow("Order placed", "Ship"));
        // "Pick and pack" was renamed by the first change.
        assert_eq!(dropped(&out[2]).0, DropReason::UnknownShape);
        let again = run(vec![flow("Order placed", "pick AND pack")]);
        assert_eq!(again[0].op, flow("Order placed", "Pick and pack"));
    }

    #[test]
    fn resolve_by_words() {
        let out = run(vec![flow("the order", "pack")]);
        assert_eq!(out[0].op, flow("Order placed", "Pick and pack"));
    }

    #[test]
    fn the_check_is_ambiguous() {
        let mut o = outline();
        o.nodes.push(node("Check stock", None, 8));
        o.nodes.push(node("Check payment", None, 9));
        o.links
            .push(link("Check stock", "Ship", Some("checks stock"), 10));
        let out = check(
            &input(vec![flow("the check", "Ship")]),
            &o,
            &DiagramScope::Whole,
        );
        match &out[0].status {
            ChangeStatus::Ambiguous {
                field,
                word,
                candidates,
            } => {
                assert_eq!(*field, TargetField::From);
                assert_eq!(word, "the check");
                assert_eq!(candidates.len(), 2);
                assert_eq!(candidates[0].name, "Check stock");
                assert_eq!(candidates[0].detail, "line 8, checks stock");
                assert_eq!(candidates[1].name, "Check payment");
                assert_eq!(candidates[1].detail, "line 9");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ops_see_earlier_ops() {
        let out = run(vec![add("Customs check"), flow("Customs check", "Ship")]);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(out[1].depends_on, vec![0]);
        assert!(out[0].depends_on.is_empty());
    }

    #[test]
    fn removed_shapes_take_their_lines() {
        let out = run(vec![
            DiagramOp::RemoveNode {
                target: "Ship".into(),
                frame: None,
            },
            DiagramOp::RemoveFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: None,
                frame: None,
            },
        ]);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[1]).0, DropReason::UnknownShape);
    }

    #[test]
    fn lines_resolve_and_relabel() {
        let out = run(vec![
            DiagramOp::RelabelFlow {
                from: "pick and pack".into(),
                to: "Ship".into(),
                label: "sealed".into(),
                frame: None,
            },
            DiagramOp::RemoveFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: Some("boxed".into()),
                frame: None,
            },
            DiagramOp::RemoveFlow {
                from: "Order placed".into(),
                to: "Ship".into(),
                label: None,
                frame: None,
            },
        ]);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        // The relabel changed the live line, so "boxed" no longer matches.
        assert_eq!(dropped(&out[1]).0, DropReason::UnknownFlow);
        assert_eq!(
            dropped(&out[2]),
            (
                DropReason::UnknownFlow,
                "there is no line from Order placed to Ship"
            )
        );
    }

    #[test]
    fn two_lines_are_ambiguous() {
        let mut o = outline();
        o.links.push(link("Pick and pack", "Ship", Some("late"), 7));
        let op = DiagramOp::RemoveFlow {
            from: "Pick and pack".into(),
            to: "Ship".into(),
            label: None,
            frame: None,
        };
        let out = check(&input(vec![op]), &o, &DiagramScope::Whole);
        match &out[0].status {
            ChangeStatus::Ambiguous {
                field, candidates, ..
            } => {
                assert_eq!(*field, TargetField::Target);
                assert_eq!(candidates.len(), 2);
                assert_eq!(candidates[0].line, 6);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn drop_cascades_to_dependents() {
        let out = run(vec![
            add("Ship"),
            flow("Ship", "Order placed"),
            DiagramOp::AddNode {
                name: "Dock".into(),
                kind: Some("store".into()),
                id: None,
                group: None,
                frame: None,
            },
            flow("Order placed", "Dock"),
            DiagramOp::RenameNode {
                target: "Dock".into(),
                name: "Quay".into(),
                frame: None,
            },
            flow("Quay", "Ship"),
        ]);
        assert_eq!(dropped(&out[0]).0, DropReason::NameTaken);
        // "Ship" still exists, so that line is its own business.
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[2]).0, DropReason::UnknownKind);
        assert_eq!(
            dropped(&out[3]),
            (
                DropReason::DependsOnDropped,
                "it needs a change that was dropped"
            )
        );
        assert_eq!(out[3].depends_on, vec![2]);
        assert_eq!(dropped(&out[4]).0, DropReason::DependsOnDropped);
        assert_eq!(out[4].depends_on, vec![2]);
        // "Quay" was produced by a dropped rename.
        assert_eq!(dropped(&out[5]).0, DropReason::DependsOnDropped);
        assert_eq!(out[5].depends_on, vec![4]);
    }

    #[test]
    fn names_with_syntax_are_kept() {
        let tricky = ["Customs > check [x]", "a // b", "say \"hi\"", "x -- y", "]"];
        let ops = tricky.iter().map(|n| add(n)).collect();
        for c in run(ops) {
            assert_eq!(c.status, ChangeStatus::Ok);
        }
        let out = run(vec![add("two\nlines"), add(&"n".repeat(201))]);
        assert_eq!(
            dropped(&out[0]),
            (DropReason::BadName, "a name cannot hold a line break")
        );
        assert_eq!(
            dropped(&out[1]),
            (
                DropReason::BadName,
                "the name is longer than 200 characters"
            )
        );
        let long = DiagramOp::AddFlow {
            from: "Ship".into(),
            to: "Order placed".into(),
            label: Some("l".repeat(301)),
            frame: None,
        };
        assert_eq!(
            dropped(&run(vec![long])[0]),
            (
                DropReason::BadName,
                "the label is longer than 300 characters"
            )
        );
        let cleaned = clean_input(input(vec![add("  Fi\u{202E}x \u{200B}")]));
        assert_eq!(cleaned.ops, vec![add("Fix")]);
        assert_eq!(run(cleaned.ops)[0].status, ChangeStatus::Ok);
    }

    #[test]
    fn selection_scope() {
        let scope = DiagramScope::Selection {
            names: vec!["Ship".into()],
        };
        let out = check(
            &input(vec![
                flow("Order placed", "Pick and pack"),
                add("Customs"),
                flow("Customs", "Ship"),
                DiagramOp::RemoveNode {
                    target: "Order placed".into(),
                    frame: None,
                },
            ]),
            &outline(),
            &scope,
        );
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::OutsideSelection,
                "Order placed is outside the selection"
            )
        );
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(out[2].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[3]).0, DropReason::OutsideSelection);
    }

    #[test]
    fn move_to_group() {
        let out = run(vec![
            DiagramOp::MoveToGroup {
                target: "Ship".into(),
                group: Some("warehouse".into()),
                frame: None,
            },
            DiagramOp::MoveToGroup {
                target: "Ship".into(),
                group: None,
                frame: None,
            },
        ]);
        assert_eq!(
            out[0].op,
            DiagramOp::MoveToGroup {
                target: "Ship".into(),
                group: Some("Warehouse".into()),
                frame: None
            }
        );
        assert_eq!(out[1].status, ChangeStatus::Ok);
    }

    #[test]
    fn fifty_one_ops() {
        let ops = (0..51).map(|i| add(&format!("Shape {i}"))).collect();
        let out = run(ops);
        assert_eq!(out.len(), 51);
        assert!(out[..50].iter().all(|c| c.status == ChangeStatus::Ok));
        assert_eq!(
            dropped(&out[50]),
            (DropReason::TooMany, "more than 50 changes in one go")
        );
    }

    #[test]
    fn wire_shapes() {
        let scope: DiagramScope =
            serde_json::from_str(r#"{"kind":"selection","names":["A"]}"#).unwrap();
        assert_eq!(
            scope,
            DiagramScope::Selection {
                names: vec!["A".into()]
            }
        );
        let c = &run(vec![add("Z")])[0];
        let v = serde_json::to_value(c).unwrap();
        assert_eq!(v["status"], json!({"kind": "ok"}));
        assert_eq!(v["dependsOn"], json!([]));
    }

    // ---- boards: every op names its frame ------------------------------------------

    use crate::ai::board::{BoardSelected, BoxIn};

    fn frame_of(index: u32, title: &str, outline: FlowOutline, clash: bool) -> BoardFrameInput {
        BoardFrameInput {
            index,
            title: title.into(),
            kind: Some("flow".into()),
            from: 0,
            to: 0,
            line: 1,
            outline,
            problems: Vec::new(),
            r#box: BoxIn {
                x: 0,
                y: 0,
                w: 100,
                h: 100,
            },
            clash,
        }
    }

    fn board_of(frames: Vec<BoardFrameInput>) -> BoardInput {
        BoardInput {
            frames,
            focus: Vec::new(),
            selected: BoardSelected::default(),
            sketches: Vec::new(),
            create: None,
            follow_up: None,
            attachment: None,
        }
    }

    fn shapes(names: &[(&str, u32)], links: &[(&str, &str, u32)]) -> FlowOutline {
        FlowOutline {
            kind: Some("flowchart".into()),
            kinds: Vec::new(),
            nodes: names.iter().map(|(n, l)| node(n, None, *l)).collect(),
            groups: Vec::new(),
            links: links.iter().map(|(f, t, l)| link(f, t, None, *l)).collect(),
        }
    }

    /// "Checkout" (Cart, Pay) and "Refund" (Pay, Refund), both with a `Pay`.
    fn two_frames() -> BoardInput {
        board_of(vec![
            frame_of(
                0,
                "Checkout",
                shapes(&[("Cart", 2), ("Pay", 3)], &[("Cart", "Pay", 4)]),
                false,
            ),
            frame_of(
                1,
                "Refund",
                shapes(&[("Pay", 7), ("Refund", 8)], &[("Pay", "Refund", 9)]),
                false,
            ),
        ])
    }

    fn framed(frame: Option<&str>, op: DiagramOp) -> DiagramOp {
        op.with_frame(frame.map(Into::into))
    }

    fn remove(target: &str) -> DiagramOp {
        DiagramOp::RemoveNode {
            target: target.into(),
            frame: None,
        }
    }

    #[test]
    fn ops_check_against_their_own_frame() {
        let out = check_board(
            &input(vec![
                framed(Some("Refund"), remove("Pay")),
                framed(Some("Checkout"), flow("Pay", "Cart")),
                framed(Some("Refund"), flow("Pay", "Refund")),
            ]),
            &two_frames(),
        );
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[0].frame.as_deref(), Some("Refund"));
        assert_eq!(out[0].op, framed(Some("Refund"), remove("Pay")));
        // Checkout still has its own Pay: the removal was in Refund.
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(out[1].frame.as_deref(), Some("Checkout"));
        assert!(out[1].depends_on.is_empty());
        // Refund's later change sees its own removal.
        assert_eq!(dropped(&out[2]).0, DropReason::UnknownShape);
        assert_eq!(out[2].frame.as_deref(), Some("Refund"));
        // Input indexes are kept.
        let indexes: Vec<u32> = out.iter().map(|c| c.index).collect();
        assert_eq!(indexes, vec![0, 1, 2]);
    }

    #[test]
    fn a_frame_title_matches_without_case_when_unique() {
        let b = two_frames();
        assert_eq!(resolve_frame(&b.frames, Some("Refund")), Some(1));
        assert_eq!(resolve_frame(&b.frames, Some("checkout")), Some(0));
        assert_eq!(resolve_frame(&b.frames, Some("  REFUND ")), Some(1));
        // Two titles that differ only in case: the exact one wins, a third spelling is neither.
        let mut cased = two_frames();
        cased.frames[1].title = "CHECKOUT".into();
        assert_eq!(resolve_frame(&cased.frames, Some("CHECKOUT")), Some(1));
        assert_eq!(resolve_frame(&cased.frames, Some("Checkout")), Some(0));
        assert_eq!(resolve_frame(&cased.frames, Some("checkout")), None);
        let out = check_board(
            &input(vec![framed(Some("refund"), remove("pay"))]),
            &two_frames(),
        );
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[0].frame.as_deref(), Some("Refund"));
        assert_eq!(out[0].op, framed(Some("Refund"), remove("Pay")));
    }

    #[test]
    fn an_unknown_frame_drops_with_its_message() {
        let out = check_board(
            &input(vec![
                framed(Some("Shipping"), remove("Pay")),
                framed(None, remove("Pay")),
            ]),
            &two_frames(),
        );
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::UnknownFrame,
                "There is no diagram called Shipping on this board."
            )
        );
        assert_eq!(out[0].frame, None);
        // Two frames and no name: which one is not ours to guess.
        assert_eq!(dropped(&out[1]).0, DropReason::UnknownFrame);
        assert_eq!(out[1].frame, None);
        assert_eq!(
            serde_json::to_value(DropReason::UnknownFrame).unwrap(),
            json!("unknownFrame")
        );
    }

    #[test]
    fn a_one_frame_board_needs_no_frame() {
        let b = board_of(vec![frame_of(0, "Orders", outline(), false)]);
        assert_eq!(resolve_frame(&b.frames, None), Some(0));
        assert_eq!(resolve_frame(&b.frames, Some("")), Some(0));
        let out = check_board(&input(vec![remove("Ship")]), &b);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[0].frame.as_deref(), Some("Orders"));
        // A named frame still has to exist.
        let out = check_board(&input(vec![framed(Some("Refund"), remove("Ship"))]), &b);
        assert_eq!(dropped(&out[0]).0, DropReason::UnknownFrame);
    }

    #[test]
    fn a_clashing_title_is_never_a_target() {
        let mut b = two_frames();
        b.frames
            .push(frame_of(2, "Refund", shapes(&[("Pay", 12)], &[]), true));
        b.frames
            .push(frame_of(3, "Archive", shapes(&[("Pay", 15)], &[]), true));
        // The first "Refund" is the target; the clashing copy never is.
        assert_eq!(resolve_frame(&b.frames, Some("Refund")), Some(1));
        assert_eq!(resolve_frame(&b.frames, Some("Archive")), None);
        assert_eq!(resolve_frame(&b.frames, Some("archive")), None);
        let out = check_board(&input(vec![framed(Some("Archive"), remove("Pay"))]), &b);
        assert_eq!(dropped(&out[0]).0, DropReason::UnknownFrame);
        // A board whose only frame clashes has no target either.
        let lone = board_of(vec![frame_of(0, "Orders", outline(), true)]);
        assert_eq!(resolve_frame(&lone.frames, None), None);
    }

    #[test]
    fn depends_on_stays_within_a_frame() {
        let out = check_board(
            &input(vec![
                framed(Some("Checkout"), add("Fraud check")),
                framed(Some("Refund"), flow("Fraud check", "Pay")),
                framed(Some("Checkout"), flow("Fraud check", "Pay")),
                framed(Some("Refund"), add("Pay")),
                framed(Some("Checkout"), flow("Pay", "Cart")),
            ]),
            &two_frames(),
        );
        assert_eq!(out[0].status, ChangeStatus::Ok);
        // Checkout's new shape is not Refund's.
        assert_eq!(dropped(&out[1]).0, DropReason::UnknownShape);
        assert!(out[1].depends_on.is_empty());
        assert_eq!(out[2].status, ChangeStatus::Ok);
        assert_eq!(out[2].depends_on, vec![0]);
        // A dropped add in Refund is nothing Checkout's changes lean on.
        assert_eq!(dropped(&out[3]).0, DropReason::NameTaken);
        assert_eq!(out[4].status, ChangeStatus::Ok);
        assert!(out[4].depends_on.is_empty());
    }

    #[test]
    fn fifty_ops_across_frames_is_the_cap() {
        let ops = (0..51)
            .map(|i| {
                let f = if i % 2 == 0 { "Checkout" } else { "Refund" };
                framed(Some(f), add(&format!("Shape {i}")))
            })
            .collect();
        let out = check_board(&input(ops), &two_frames());
        assert_eq!(out.len(), 51);
        assert!(out[..50].iter().all(|c| c.status == ChangeStatus::Ok));
        assert_eq!(
            dropped(&out[50]),
            (DropReason::TooMany, "more than 50 changes in one go")
        );
    }

    #[test]
    fn the_schema_has_frame_on_every_op() {
        let schema = input_schema();
        let branches = schema["properties"]["ops"]["items"]["oneOf"]
            .as_array()
            .unwrap();
        for b in branches {
            let (tag, body) = b["properties"].as_object().unwrap().iter().next().unwrap();
            // `add_frame` makes a frame; it names none.
            if tag == "add_frame" {
                assert!(body["properties"].get("frame").is_none());
                continue;
            }
            assert_eq!(body["properties"]["frame"], name_schema(), "{tag}");
            let required = body["required"].as_array().unwrap();
            assert!(!required.contains(&json!("frame")), "{tag}");
        }
        // A missing or null frame reads as none.
        let op: DiagramOp = serde_json::from_str(r#"{"remove_node":{"target":"A"}}"#).unwrap();
        assert_eq!(op.frame(), None);
        let op: DiagramOp =
            serde_json::from_str(r#"{"remove_node":{"target":"A","frame":"Refund"}}"#).unwrap();
        assert_eq!(op.frame(), Some("Refund"));
    }

    #[test]
    fn a_resolved_frame_is_written_on_every_change() {
        let mut b = two_frames();
        b.frames[1].outline.nodes.push(node("pay", None, 10));
        let out = check_board(
            &input(vec![
                framed(Some("refund"), remove("Nothing")),
                framed(Some("REFUND"), remove("PAY")),
            ]),
            &b,
        );
        assert_eq!(dropped(&out[0]).0, DropReason::UnknownShape);
        assert_eq!(out[0].op.frame(), Some("Refund"));
        assert!(matches!(out[1].status, ChangeStatus::Ambiguous { .. }));
        assert_eq!(out[1].op.frame(), Some("Refund"));
        assert_eq!(out[1].frame.as_deref(), Some("Refund"));
    }

    #[test]
    fn a_pre_boards_change_reloads() {
        let old = r#"{"index":0,"op":{"remove_node":{"target":"A"}},"status":{"kind":"ok"},"dependsOn":[]}"#;
        let change: ProposedChange = serde_json::from_str(old).unwrap();
        assert_eq!(change.frame, None);
        assert_eq!(change.op.frame(), None);
        assert_eq!(serde_json::to_string(&change).unwrap(), old);
    }

    #[test]
    fn clean_input_cleans_the_frame() {
        let cleaned = clean_input(input(vec![framed(
            Some("  Re\u{200B}fund\u{202E} "),
            remove("Pay"),
        )]));
        assert_eq!(cleaned.ops, vec![framed(Some("Refund"), remove("Pay"))]);
    }

    // ---- new frames and ER columns --------------------------------------------------

    fn add_frame(title: &str, kind: &str) -> DiagramOp {
        DiagramOp::AddFrame {
            title: title.into(),
            kind: kind.into(),
        }
    }

    fn table(name: &str, columns: &[&str], line: u32) -> OutlineNode {
        OutlineNode {
            kind: Some("entity".into()),
            columns: Some(columns.iter().map(|c| c.to_string()).collect()),
            ..node(name, None, line)
        }
    }

    /// `two_frames` plus "Orders ERD": orders(id, total), customers(id, email), orders > customers.
    fn with_erd() -> BoardInput {
        let mut b = two_frames();
        b.frames.push(frame_of(
            2,
            "Orders ERD",
            FlowOutline {
                kind: Some("er".into()),
                kinds: vec!["entity".into(), "weak".into()],
                nodes: vec![
                    table("orders", &["id", "total"], 12),
                    table("customers", &["id", "email"], 16),
                ],
                groups: Vec::new(),
                links: vec![link("orders", "customers", Some("placed by"), 20)],
            },
            false,
        ));
        b
    }

    fn erd(op: DiagramOp) -> DiagramOp {
        framed(Some("Orders ERD"), op)
    }

    fn add_column(
        table: &str,
        name: &str,
        r#type: Option<&str>,
        flags: Option<&[&str]>,
    ) -> DiagramOp {
        DiagramOp::AddColumn {
            table: table.into(),
            name: name.into(),
            r#type: r#type.map(Into::into),
            flags: flags.map(|f| f.iter().map(|x| x.to_string()).collect()),
            frame: None,
        }
    }

    fn remove_column(table: &str, column: &str) -> DiagramOp {
        DiagramOp::RemoveColumn {
            table: table.into(),
            column: column.into(),
            frame: None,
        }
    }

    fn set_column(
        table: &str,
        column: &str,
        name: Option<&str>,
        r#type: Option<&str>,
    ) -> DiagramOp {
        DiagramOp::SetColumn {
            table: table.into(),
            column: column.into(),
            name: name.map(Into::into),
            r#type: r#type.map(Into::into),
            frame: None,
        }
    }

    #[test]
    fn add_frame_then_nodes_in_it() {
        let out = check_board(
            &input(vec![
                add_frame("Shipping", "flow"),
                framed(Some("Shipping"), add("Pack")),
                framed(Some("shipping"), add("Pay")),
                framed(Some("Shipping"), flow("Pack", "Pay")),
                framed(Some("Checkout"), flow("Pack", "Pay")),
            ]),
            &two_frames(),
        );
        assert!(
            out[..4].iter().all(|c| c.status == ChangeStatus::Ok),
            "{out:?}"
        );
        assert_eq!(out[0].frame.as_deref(), Some("Shipping"));
        assert_eq!(out[0].op, add_frame("Shipping", "flow"));
        // The new frame starts empty: its Pay is not Checkout's.
        assert_eq!(out[2].frame.as_deref(), Some("Shipping"));
        assert_eq!(out[2].op, framed(Some("Shipping"), add("Pay")));
        // Every change in the new frame needs the frame.
        assert_eq!(out[1].depends_on, vec![0]);
        assert_eq!(out[3].depends_on, vec![0, 1, 2]);
        // Checkout has no Pack.
        assert_eq!(dropped(&out[4]).0, DropReason::UnknownShape);
        // The title is cleaned like every other string.
        let cleaned = clean_input(input(vec![add_frame(" Ship\u{200B}ping ", " flow ")]));
        assert_eq!(cleaned.ops, vec![add_frame("Shipping", "flow")]);
    }

    #[test]
    fn a_frame_title_taken_in_any_case_drops() {
        let out = check_board(
            &input(vec![
                add_frame("refund", "flow"),
                add_frame("Returns", "flow"),
                add_frame("RETURNS", "state"),
                add_frame("", "flow"),
            ]),
            &two_frames(),
        );
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::FrameTaken,
                "There is already a diagram called refund on this board."
            )
        );
        assert_eq!(out[0].frame, None);
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[2]).0, DropReason::FrameTaken);
        assert_eq!(dropped(&out[3]).0, DropReason::EmptyLabel);
    }

    #[test]
    fn four_new_frames_drop_the_fourth() {
        let out = check_board(
            &input(vec![
                add_frame("A", "flow"),
                add_frame("B", "er"),
                add_frame("C", "dfd"),
                add_frame("D", "flow"),
                framed(Some("D"), add("Start")),
            ]),
            &two_frames(),
        );
        assert!(out[..3].iter().all(|c| c.status == ChangeStatus::Ok));
        assert_eq!(
            dropped(&out[3]),
            (
                DropReason::TooManyFrames,
                "There are at most 3 new diagrams in one go."
            )
        );
        // Nothing can be put in a frame that was not added.
        assert_eq!(dropped(&out[4]).0, DropReason::DependsOnDropped);
        assert_eq!(out[4].depends_on, vec![3]);
        // A full board takes no new frame at all.
        let mut full = two_frames();
        for i in 2..MAX_BOARD_FRAMES {
            full.frames.push(frame_of(
                i as u32,
                &format!("F{i}"),
                shapes(&[], &[]),
                false,
            ));
        }
        let out = check_board(&input(vec![add_frame("One more", "flow")]), &full);
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::TooManyFrames,
                "A board holds at most 50 diagrams."
            )
        );
    }

    #[test]
    fn add_frame_kind_is_a_kind_id() {
        let out = check_board(
            &input(vec![
                add_frame("Steps", "flowchart"),
                add_frame("Tables", "ER"),
                framed(Some("Steps"), add("Start")),
            ]),
            &two_frames(),
        );
        assert_eq!(
            dropped(&out[0]),
            (DropReason::UnknownKind, "flowchart is not a diagram kind")
        );
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(out[1].op, add_frame("Tables", "er"));
        assert_eq!(dropped(&out[2]).0, DropReason::DependsOnDropped);
        assert_eq!(out[2].depends_on, vec![0]);
        assert_eq!(
            DIAGRAM_KIND_IDS,
            [
                "dfd", "flow", "cloud", "er", "sequence", "state", "class", "mindmap", "timeline"
            ]
        );
    }

    #[test]
    fn column_ops_need_an_erd() {
        let out = check_board(
            &input(vec![
                framed(Some("Checkout"), add_column("Pay", "id", None, None)),
                framed(Some("Checkout"), remove_column("Pay", "id")),
                framed(Some("Checkout"), set_column("Pay", "id", Some("key"), None)),
                add_frame("Ledger", "er"),
                framed(Some("Ledger"), add("entries")),
                framed(
                    Some("Ledger"),
                    add_column("entries", "id", Some("int"), Some(&["pk"])),
                ),
            ]),
            &with_erd(),
        );
        for c in &out[..3] {
            assert_eq!(
                dropped(c),
                (DropReason::NotAnErd, "columns are only in ER diagrams")
            );
        }
        // A new ER frame's table takes columns.
        assert!(
            out[3..].iter().all(|c| c.status == ChangeStatus::Ok),
            "{out:?}"
        );
        assert_eq!(out[5].depends_on, vec![3, 4]);
    }

    #[test]
    fn add_column_checks_the_name_and_flags() {
        let out = check_board(
            &input(vec![
                erd(add_column(
                    "Orders",
                    "customer_id",
                    Some("int"),
                    Some(&["NOT NULL", "pk", "pk"]),
                )),
                erd(add_column("orders", "2bad", None, None)),
                erd(add_column("orders", "Total", None, None)),
                erd(add_column("orders", "note", None, Some(&["indexed"]))),
                erd(add_column("nope", "id", None, None)),
                erd(add_column("orders", "customer_id", None, None)),
                erd(add_column("orders", "placed", Some(""), Some(&[]))),
            ]),
            &with_erd(),
        );
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(
            out[0].op,
            erd(add_column(
                "orders",
                "customer_id",
                Some("int"),
                Some(&["pk", "not null"])
            ))
        );
        assert_eq!(
            dropped(&out[1]),
            (DropReason::BadName, "2bad is not a column name")
        );
        assert_eq!(
            dropped(&out[2]),
            (
                DropReason::ColumnTaken,
                "there is already a column orders.Total"
            )
        );
        assert_eq!(
            dropped(&out[3]),
            (DropReason::BadName, "indexed is not a column flag")
        );
        assert_eq!(
            dropped(&out[4]),
            (DropReason::UnknownShape, "there is no table called nope")
        );
        assert_eq!(dropped(&out[5]).0, DropReason::ColumnTaken);
        // An empty type is an untyped column; no flags is none.
        assert_eq!(out[6].op, erd(add_column("orders", "placed", None, None)));
        // Column fields are cleaned.
        let cleaned = clean_input(input(vec![
            add_column(" orders\u{200B}", " note ", Some(" text "), Some(&[" pk "])),
            set_column("orders ", " total", Some(" sum\u{202E}"), Some(" int ")),
            remove_column(" orders", "id "),
        ]));
        assert_eq!(
            cleaned.ops,
            vec![
                add_column("orders", "note", Some("text"), Some(&["pk"])),
                set_column("orders", "total", Some("sum"), Some("int")),
                remove_column("orders", "id"),
            ]
        );
    }

    #[test]
    fn remove_column_needs_the_column() {
        let out = check_board(
            &input(vec![
                erd(remove_column("orders", "missing")),
                erd(remove_column("orders", "TOTAL")),
                erd(set_column("orders", "total", Some("sum"), None)),
                erd(set_column("customers", "email", Some("mail"), Some("text"))),
                erd(set_column("customers", "id", Some("MAIL"), None)),
                erd(add_column("customers", "phone", None, None)),
                erd(remove_column("customers", "phone")),
            ]),
            &with_erd(),
        );
        assert_eq!(
            dropped(&out[0]),
            (
                DropReason::UnknownColumn,
                "there is no column orders.missing"
            )
        );
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(out[1].op, erd(remove_column("orders", "total")));
        // The removal is seen by later changes.
        assert_eq!(dropped(&out[2]).0, DropReason::UnknownColumn);
        assert_eq!(out[3].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[4]).0, DropReason::ColumnTaken);
        assert_eq!(out[6].status, ChangeStatus::Ok);
        assert_eq!(out[6].depends_on, vec![5]);
    }

    #[test]
    fn an_er_line_names_columns() {
        let out = check_board(
            &input(vec![
                erd(add_column("orders", "customer_id", Some("int"), None)),
                erd(flow("orders.customer_id", "customers.id")),
                erd(flow("orders.nope", "customers.id")),
                erd(flow("Orders.ID", "customers")),
                erd(DiagramOp::RemoveFlow {
                    from: "orders.total".into(),
                    to: "customers.id".into(),
                    label: None,
                    frame: None,
                }),
                erd(DiagramOp::RemoveFlow {
                    from: "orders.customer_id".into(),
                    to: "customers.ID".into(),
                    label: None,
                    frame: None,
                }),
                framed(Some("Checkout"), flow("Cart.id", "Pay")),
            ]),
            &with_erd(),
        );
        assert_eq!(out[1].status, ChangeStatus::Ok, "{out:?}");
        assert_eq!(out[1].op, erd(flow("orders.customer_id", "customers.id")));
        assert_eq!(out[1].depends_on, vec![0]);
        assert_eq!(
            dropped(&out[2]),
            (DropReason::UnknownColumn, "there is no column orders.nope")
        );
        assert_eq!(out[3].status, ChangeStatus::Ok);
        assert_eq!(out[3].op, erd(flow("orders.id", "customers")));
        // A line named by its columns is that line only.
        assert_eq!(
            dropped(&out[4]),
            (
                DropReason::UnknownFlow,
                "there is no line from orders.total to customers.id"
            )
        );
        assert_eq!(out[5].status, ChangeStatus::Ok, "{out:?}");
        assert_eq!(
            out[5].op,
            erd(DiagramOp::RemoveFlow {
                from: "orders.customer_id".into(),
                to: "customers.id".into(),
                label: None,
                frame: None,
            })
        );
        assert_eq!(out[5].depends_on, vec![0]);
        // Outside an ERD a dotted end is a shape name like any other.
        assert_eq!(dropped(&out[6]).0, DropReason::UnknownShape);
    }

    #[test]
    fn rust_rules_match_the_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/flow/er_rules.json"
        );
        let rules: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(rules["flags"], json!(COLUMN_FLAGS));
        assert_eq!(rules["kinds"], json!(DIAGRAM_KIND_IDS));
        assert_eq!(rules["name"], json!(COLUMN_NAME_PATTERN));
        let re = regex::Regex::new(COLUMN_NAME_PATTERN).unwrap();
        for name in [
            "id", "_x", "a1_b", "A", "", "1a", "a-b", "a b", "é", "a.b", "x\n",
        ] {
            assert_eq!(is_column_name(name), re.is_match(name), "{name:?}");
        }
    }

    // ---- fix round 1 ------------------------------------------------------------------

    #[test]
    fn a_change_for_a_dropped_new_frame_never_lands_in_its_namesake() {
        let out = check_board(
            &input(vec![
                add_frame("refund", "flow"),
                framed(Some("refund"), add("Chargeback")),
                add_frame("Checkout", "flowchart"),
                framed(Some("Checkout"), add("Fraud check")),
                add_frame("Later", "nope"),
                add_frame("Later", "flow"),
                framed(Some("Later"), add("Start")),
            ]),
            &two_frames(),
        );
        assert_eq!(dropped(&out[0]).0, DropReason::FrameTaken);
        // Meant for the new frame, not the board's Refund.
        assert_eq!(dropped(&out[1]).0, DropReason::DependsOnDropped);
        assert_eq!(out[1].depends_on, vec![0]);
        assert_eq!(out[1].frame, None);
        assert_eq!(dropped(&out[2]).0, DropReason::UnknownKind);
        assert_eq!(dropped(&out[3]).0, DropReason::DependsOnDropped);
        assert_eq!(out[3].depends_on, vec![2]);
        // A title added after a dropped try is the new frame.
        assert_eq!(dropped(&out[4]).0, DropReason::UnknownKind);
        assert_eq!(out[5].status, ChangeStatus::Ok);
        assert_eq!(out[6].status, ChangeStatus::Ok);
        assert_eq!(out[6].depends_on, vec![5]);
    }

    fn typed(name: &str, kind: &str) -> DiagramOp {
        DiagramOp::AddNode {
            name: name.into(),
            kind: Some(kind.into()),
            id: None,
            group: None,
            frame: None,
        }
    }

    #[test]
    fn a_new_frame_knows_its_shape_kinds() {
        let out = check_board(
            &input(vec![
                add_frame("Steps", "flow"),
                framed(Some("Steps"), typed("Paid?", "decision")),
                framed(Some("Steps"), typed("Stock", "store")),
                add_frame("Tables", "er"),
                framed(Some("Tables"), typed("orders", "Entity")),
                framed(
                    Some("Tables"),
                    add_column("orders", "id", Some("int"), Some(&["pk"])),
                ),
            ]),
            &two_frames(),
        );
        assert_eq!(out[1].status, ChangeStatus::Ok, "{out:?}");
        assert_eq!(
            dropped(&out[2]),
            (
                DropReason::UnknownKind,
                "store is not a shape of this diagram"
            )
        );
        assert_eq!(out[4].status, ChangeStatus::Ok);
        assert_eq!(out[4].op, framed(Some("Tables"), typed("orders", "entity")));
        assert_eq!(out[5].status, ChangeStatus::Ok);
        assert_eq!(out[5].depends_on, vec![3, 4]);
    }

    #[test]
    fn shape_kinds_match_the_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/flow/kinds.json"
        );
        let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let have: serde_json::Map<String, Value> = SHAPE_KINDS
            .iter()
            .map(|(k, kinds)| (k.to_string(), json!(kinds)))
            .collect();
        assert_eq!(Value::Object(have), want);
        let ids: Vec<&str> = SHAPE_KINDS.iter().map(|(k, _)| *k).collect();
        assert_eq!(ids, DIAGRAM_KIND_IDS);
    }

    #[test]
    fn empty_subjects_say_what_is_missing() {
        let out = check_board(
            &input(vec![
                erd(add_column("orders", "", None, None)),
                erd(add_column("orders", "note", None, Some(&["", "pk"]))),
                add_frame("Shipping", " "),
                erd(add_column("orders", "memo", Some("text\nmore"), None)),
                erd(set_column("orders", "total", None, Some("a\rb"))),
            ]),
            &with_erd(),
        );
        assert_eq!(
            dropped(&out[0]),
            (DropReason::EmptyLabel, "a column needs a name")
        );
        assert_eq!(out[1].status, ChangeStatus::Ok);
        assert_eq!(
            out[1].op,
            erd(add_column("orders", "note", None, Some(&["pk"])))
        );
        assert_eq!(
            dropped(&out[2]),
            (DropReason::UnknownKind, "the new diagram needs a kind")
        );
        assert_eq!(
            dropped(&out[3]),
            (DropReason::BadName, "a type cannot hold a line break")
        );
        assert_eq!(dropped(&out[4]).1, "a type cannot hold a line break");
    }

    // ---- Task 2 review minors 5 and 6 --------------------------------------------------

    #[test]
    fn column_edits_keep_line_ends_current() {
        let mut board = with_erd();
        // The ERD's line runs orders.id > customers.id.
        let line = &mut board.frames[2].outline.links[0];
        line.from_column = Some("id".into());
        line.to_column = Some("id".into());
        let remove_line = |from: &str, to: &str| {
            erd(DiagramOp::RemoveFlow {
                from: from.into(),
                to: to.into(),
                label: None,
                frame: None,
            })
        };
        let out = check_board(
            &input(vec![
                erd(set_column("orders", "id", Some("order_id"), None)),
                // The renamed column's line is found by its new name.
                remove_line("orders.order_id", "customers.id"),
            ]),
            &board,
        );
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[1].status, ChangeStatus::Ok, "{out:?}");
        assert_eq!(out[1].depends_on, vec![0]);
        // A removed column takes its lines with it, as the landing does.
        let out = check_board(
            &input(vec![
                erd(remove_column("customers", "id")),
                remove_line("orders", "customers"),
            ]),
            &board,
        );
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(dropped(&out[1]).0, DropReason::UnknownFlow, "{out:?}");
    }

    #[test]
    fn frameless_changes_around_a_new_frame() {
        let mut board = two_frames();
        board.frames.truncate(1);
        let out = check_board(
            &input(vec![
                add("Before"),
                add_frame("Refund", "flow"),
                add("After"),
            ]),
            &board,
        );
        // One frame before the add_frame: a change with no frame is in it.
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(out[0].frame.as_deref(), Some("Checkout"));
        assert_eq!(out[1].status, ChangeStatus::Ok);
        // Two targets after it: the same change names no diagram.
        assert_eq!(
            dropped(&out[2]),
            (
                DropReason::UnknownFrame,
                "The change does not name a diagram on this board."
            )
        );
        assert_eq!(out[2].frame, None);
    }
}
