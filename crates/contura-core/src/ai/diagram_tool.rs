//! The one tool a diagram Ask carries, `propose_diagram_changes`: its input type, its hand-written
//! JSON schema, and the checker that resolves and validates each change against an outline of the
//! open .flow file before the user sees it. Pure: no file, no database, no provider.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::rails::strip_invisible;
use crate::ai::sent::fnv1a64;

pub const TOOL_NAME: &str = "propose_diagram_changes";
pub const TOOL_DESCRIPTION: &str = "Proposes edits to this .flow file only. It cannot read or change a database. The user reviews every change.";
pub const MAX_OPS: usize = 50;
pub const NAME_CAP: usize = 200;
pub const LABEL_CAP: usize = 300;
pub const INPUT_CAP: usize = 64 * 1024;

/// The tool input: the file it was written against, that file's hash, and the changes in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposeInput {
    pub file: String,
    pub base_hash: String,
    pub ops: Vec<DiagramOp>,
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
    },
    RemoveNode {
        target: String,
    },
    RenameNode {
        target: String,
        name: String,
    },
    AddFlow {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    RemoveFlow {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    RelabelFlow {
        from: String,
        to: String,
        label: String,
    },
    /// `group: None` takes the shape out of every group.
    MoveToGroup {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<String>,
    },
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

fn branch(tag: &str, required: &[&str], properties: Value) -> Value {
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
            } => DiagramOp::AddNode {
                name: s(name),
                kind: o(kind),
                id: o(id),
                group: o(group),
            },
            DiagramOp::RemoveNode { target } => DiagramOp::RemoveNode { target: s(target) },
            DiagramOp::RenameNode { target, name } => DiagramOp::RenameNode {
                target: s(target),
                name: s(name),
            },
            DiagramOp::AddFlow { from, to, label } => DiagramOp::AddFlow {
                from: s(from),
                to: s(to),
                label: o(label),
            },
            DiagramOp::RemoveFlow { from, to, label } => DiagramOp::RemoveFlow {
                from: s(from),
                to: s(to),
                label: o(label),
            },
            DiagramOp::RelabelFlow { from, to, label } => DiagramOp::RelabelFlow {
                from: s(from),
                to: s(to),
                label: s(label),
            },
            DiagramOp::MoveToGroup { target, group } => DiagramOp::MoveToGroup {
                target: s(target),
                group: o(group),
            },
        })
        .collect();
    ProposeInput {
        file: s(input.file),
        base_hash: s(input.base_hash),
        ops,
    }
}

/// A way one change fails, before it is dressed as a status.
enum Fail {
    Drop(DropReason, String),
    Ambiguous(TargetField, String, Vec<Candidate>),
    /// Kept apart so the caller can tell a dropped earlier add from a plain typo.
    UnknownShape(String),
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

    /// The one line from `from` to `to` (with `label` when given): its position and end names.
    fn resolve_line(
        &self,
        from: &str,
        to: &str,
        label: Option<&str>,
    ) -> Result<(usize, String, String), Fail> {
        let f = self.shape(from, TargetField::From)?;
        let t = self.shape(to, TargetField::To)?;
        let mut hits: Vec<usize> = (0..self.live.links.len())
            .filter(|&i| {
                let l = &self.live.links[i];
                l.from == f && l.to == t && label.is_none_or(|x| l.label.as_deref() == Some(x))
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
                    },
                    vec![],
                ))
            }
            DiagramOp::RemoveNode { target } => {
                let t = self.shape(target, TargetField::Target)?;
                self.live.nodes.retain(|n| n.name != t);
                self.live.links.retain(|l| l.from != t && l.to != t);
                Ok((DiagramOp::RemoveNode { target: t.clone() }, vec![t]))
            }
            DiagramOp::RenameNode { target, name } => {
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
                    },
                    vec![t],
                ))
            }
            DiagramOp::AddFlow { from, to, label } => {
                let label = match label {
                    None => None,
                    Some(l) => Some(check_label(l)?),
                };
                let f = self.shape(from, TargetField::From)?;
                let t = self.shape(to, TargetField::To)?;
                let line = self.fresh_line();
                self.live.links.push(OutlineLink {
                    from: f.clone(),
                    to: t.clone(),
                    label: label.clone(),
                    line,
                });
                Ok((
                    DiagramOp::AddFlow {
                        from: f.clone(),
                        to: t.clone(),
                        label,
                    },
                    vec![f, t],
                ))
            }
            DiagramOp::RemoveFlow { from, to, label } => {
                let given = label.as_deref().map(str::trim);
                let (i, f, t) = self.resolve_line(from, to, given)?;
                let removed = self.live.links.remove(i);
                Ok((
                    DiagramOp::RemoveFlow {
                        from: f.clone(),
                        to: t.clone(),
                        label: removed.label,
                    },
                    vec![f, t],
                ))
            }
            DiagramOp::RelabelFlow { from, to, label } => {
                let label = check_label(label)?;
                let (i, f, t) = self.resolve_line(from, to, None)?;
                self.live.links[i].label = Some(label.clone());
                Ok((
                    DiagramOp::RelabelFlow {
                        from: f.clone(),
                        to: t.clone(),
                        label,
                    },
                    vec![f, t],
                ))
            }
            DiagramOp::MoveToGroup { target, group } => {
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
                    },
                    vec![t],
                ))
            }
        }
    }
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
        _ => None,
    }
}

/// Checks every proposed change in order over a live copy of the outline, so later changes see
/// earlier ones that passed.
pub fn check(
    input: &ProposeInput,
    outline: &FlowOutline,
    scope: &DiagramScope,
) -> Vec<ProposedChange> {
    let next_line = outline
        .nodes
        .iter()
        .map(|n| n.line)
        .chain(outline.groups.iter().map(|g| g.line))
        .chain(outline.links.iter().map(|l| l.line))
        .max()
        .unwrap_or(0);
    let mut checker = Checker {
        live: outline.clone(),
        selected: match scope {
            DiagramScope::Whole => None,
            DiagramScope::Selection { names } => Some(names.iter().cloned().collect()),
        },
        next_line,
    };
    let mut producers: Vec<Producer> = Vec::new();
    let mut out = Vec::with_capacity(input.ops.len());
    for (i, op) in input.ops.iter().enumerate() {
        let index = i as u32;
        let produced = produced_by(op);
        let (op_out, status, depends_on) = if i >= MAX_OPS {
            let status = ChangeStatus::Dropped {
                reason: DropReason::TooMany,
                message: format!("more than {MAX_OPS} changes in one go"),
            };
            (op.clone(), status, vec![])
        } else {
            match checker.apply(op) {
                Ok((resolved, used)) => {
                    let mut deps: Vec<u32> = producers
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
                Err(Fail::UnknownShape(word)) => {
                    // Only the word that found no shape can lean on a change that was dropped.
                    let mut deps: Vec<u32> = producers
                        .iter()
                        .filter(|p| !p.ok && fold(&p.name) == fold(&word))
                        .map(|p| p.index)
                        .collect();
                    deps.sort_unstable();
                    deps.dedup();
                    let status = if deps.is_empty() {
                        ChangeStatus::Dropped {
                            reason: DropReason::UnknownShape,
                            message: format!("there is no shape called {word}"),
                        }
                    } else {
                        ChangeStatus::Dropped {
                            reason: DropReason::DependsOnDropped,
                            message: "it needs a change that was dropped".to_string(),
                        }
                    };
                    (op.clone(), status, deps)
                }
            }
        };
        if let Some(name) = produced {
            producers.push(Producer {
                name,
                index,
                ok: status == ChangeStatus::Ok,
            });
        }
        out.push(ProposedChange {
            index,
            op: op_out,
            status,
            depends_on,
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
        }
    }

    fn link(from: &str, to: &str, label: Option<&str>, line: u32) -> OutlineLink {
        OutlineLink {
            from: from.into(),
            to: to.into(),
            label: label.map(Into::into),
            line,
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
        }
    }

    fn flow(from: &str, to: &str) -> DiagramOp {
        DiagramOp::AddFlow {
            from: from.into(),
            to: to.into(),
            label: None,
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
            },
            DiagramOp::RemoveNode { target: "a".into() },
            DiagramOp::RenameNode {
                target: "a".into(),
                name: "b".into(),
            },
            DiagramOp::AddFlow {
                from: "a".into(),
                to: "b".into(),
                label: Some("l".into()),
            },
            DiagramOp::RemoveFlow {
                from: "a".into(),
                to: "b".into(),
                label: Some("l".into()),
            },
            DiagramOp::RelabelFlow {
                from: "a".into(),
                to: "b".into(),
                label: "l".into(),
            },
            DiagramOp::MoveToGroup {
                target: "a".into(),
                group: Some("g".into()),
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
                    group: None
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
            },
            DiagramOp::RelabelFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: "".into(),
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
            },
            flow("order placed", "Ship"),
            flow("Order placed", "pick  AND pack"),
        ]);
        assert_eq!(out[0].status, ChangeStatus::Ok);
        assert_eq!(
            out[0].op,
            DiagramOp::RenameNode {
                target: "Pick and pack".into(),
                name: "Pack".into()
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
            },
            DiagramOp::RemoveFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: None,
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
            },
            DiagramOp::RemoveFlow {
                from: "Pick and pack".into(),
                to: "Ship".into(),
                label: Some("boxed".into()),
            },
            DiagramOp::RemoveFlow {
                from: "Order placed".into(),
                to: "Ship".into(),
                label: None,
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
            },
            flow("Order placed", "Dock"),
            DiagramOp::RenameNode {
                target: "Dock".into(),
                name: "Quay".into(),
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
            },
            DiagramOp::MoveToGroup {
                target: "Ship".into(),
                group: None,
            },
        ]);
        assert_eq!(
            out[0].op,
            DiagramOp::MoveToGroup {
                target: "Ship".into(),
                group: Some("Warehouse".into())
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
}
