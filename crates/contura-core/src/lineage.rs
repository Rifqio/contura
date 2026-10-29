//! Lineage (step 6+, B2): the tables around one table, read from catalog details only,
//! and the `table:` links of the diagrams in `<data>\diagrams`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::diagrams::{
    DiagramKind, READ_MAX, diagram_head, diagrams_dir, is_blank_or_comment, is_frame_header,
    read_flow_line,
};
use crate::dialect::Dialect;
use crate::error::{Error, Result};
use crate::jobs::paths::{
    LINEAGE_DIR, LINEAGE_HASH_LEN, PartialFile, PathUse, check_user_path, flow_file_name, hex,
};
use crate::model::ObjectPath;

/// The most tables a lineage holds; past it `truncated` is set (the fast mode takes over).
pub const MAX_TABLES: usize = 300;

/// The longest a lineage reads the catalog; then it returns what it found, `truncated`.
pub const DEADLINE: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    pub center: ObjectPath,
    /// The center first, then the rest in the order they were reached.
    pub tables: Vec<LineageTable>,
    /// Every Foreign Key between two of `tables`, once each.
    pub links: Vec<LineageLink>,
    /// More tables were in reach than `MAX_TABLES`, or the walk stopped at `DEADLINE`.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineageTable {
    pub path: ObjectPath,
    /// The key columns, Foreign Key columns and columns a link points to, in table order.
    pub columns: Vec<LineageColumn>,
    /// Every column of the table.
    pub column_count: u32,
    /// Steps from the center: negative for tables it uses, positive for tables using it.
    pub distance: i32,
    /// Why the table's details could not be read, in plain words; the card then holds only
    /// the columns its known keys name, and the walk does not go past it.
    #[serde(default)]
    pub unreadable: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineageColumn {
    pub name: String,
    /// The type as the server writes it.
    pub ty: String,
    pub pk: bool,
    pub fk: bool,
    pub nullable: bool,
}

/// One Foreign Key: `from` holds the key, `to` is the table it points to.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineageLink {
    pub from: ObjectPath,
    pub from_columns: Vec<String>,
    pub to: ObjectPath,
    pub to_columns: Vec<String>,
    /// Upper case, such as `CASCADE`; `None` for the Dialect's default.
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
    /// A key column can be empty, so a row need not point anywhere.
    pub nullable: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Both,
    /// The tables the center points to.
    Uses,
    /// The tables that point to the center.
    UsedBy,
}

/// How a diagram's flow lines meet a node with a `table:`: into it, out of it, or both.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Reads,
    Writes,
    Both,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowTableLink {
    /// The diagram name: the file name without `.flow`.
    pub file: String,
    pub node: String,
    /// The node's kind as written (`store`, `io`, ...); `step` for an unkinded flowchart
    /// node and `node` for an unkinded one elsewhere.
    pub kind: String,
    /// The `table:` value as written, such as `shop.orders`.
    pub table: String,
    /// The title of the board frame the node is in; `None` when the file has one frame.
    #[serde(default)]
    pub frame: Option<String>,
    pub access: Access,
    /// What touches the table. A step kind (`io`, `step`, `subprocess`, `process`, or an
    /// unkinded flowchart node) is itself the step, with its own access. Any other node
    /// (a store, a service node) names the process or step nodes on the other end of its
    /// directed lines, each once in the order first written, at most `MAX_PROCESSES`;
    /// entities, externals, stores, start, end, decision and other `table:` nodes are not
    /// processes.
    #[serde(default)]
    pub processes: Vec<FlowProcess>,
}

/// A process or step that meets a `table:` node, and what it does with the table: a line
/// from it into the node writes, a line out of the node into it reads.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowProcess {
    pub node: String,
    pub access: Access,
}

/// The most links one line makes (the language's `MAX_FAN_LINKS`).
const MAX_FAN_LINKS: usize = 100;

/// The most processes named for one `table:` node.
pub const MAX_PROCESSES: usize = 20;

/// Node kinds that are themselves the step touching their `table:`; an unkinded flowchart
/// node is a `step`.
const STEP_KINDS: [&str; 4] = ["io", "step", "subprocess", "process"];

/// Node kinds that never count as the process touching a table.
const NOT_PROCESSES: [&str; 6] = ["entity", "external", "store", "start", "end", "decision"];

/// The views that read a table, as the catalog records them (lineage's Views source).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewDependencies {
    /// The server keeps a record of what views read (PostgreSQL, MySQL 8.0.13 and later).
    /// When false, `views` is empty and the UI falls back to a name match, said as one.
    pub catalog: bool,
    /// At most `MAX_VIEWS`, by schema (or database) and name.
    pub views: Vec<ObjectPath>,
    /// More than `MAX_VIEWS` views read the table; only the first are listed.
    #[serde(default)]
    pub capped: bool,
}

/// The most views lineage lists for one table.
pub const MAX_VIEWS: usize = 200;

/// The largest lineage layout file Contura writes or reads.
pub const LINEAGE_LAYOUT_MAX: usize = 1024 * 1024;

/// `<data>\diagrams\.lineage\<hash>.layout.json` for table `path` of Connection `id`. The
/// name is the first 32 hex digits of a SHA-256 of the Connection id and the table path, so
/// no part of the table's name reaches the file system.
pub fn lineage_layout_path(data_dir: &Path, id: uuid::Uuid, path: &ObjectPath) -> PathBuf {
    let key = serde_json::to_string(&(
        "contura-lineage-layout-1",
        id.to_string(),
        &path.database,
        &path.schema,
        &path.name,
    ))
    .unwrap_or_default();
    let digest: [u8; 32] = Sha256::digest(key.as_bytes()).into();
    let name = format!("{}.layout.json", &hex(&digest)[..LINEAGE_HASH_LEN]);
    diagrams_dir(data_dir).join(LINEAGE_DIR).join(name)
}

fn layout_err(path: &Path, what: &str, e: std::io::Error) -> Error {
    Error::File(format!("cannot {what} {}: {e}", path.display()))
}

/// Refuses text that is not a version 1 layout object, or over `LINEAGE_LAYOUT_MAX`.
fn check_layout_text(text: &str) -> Result<()> {
    if text.len() > LINEAGE_LAYOUT_MAX {
        return Err(Error::InvalidInput(
            "The lineage layout is too large to save.".into(),
        ));
    }
    let version = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.as_object()?.get("version")?.as_u64());
    if version != Some(1) {
        return Err(Error::InvalidInput(
            "The lineage layout is not a version 1 layout file.".into(),
        ));
    }
    Ok(())
}

/// The saved layout of table `path`'s lineage, or `None` when there is none. A file that is
/// a link, too large or not a version 1 layout reads as none.
pub fn read_lineage_layout(
    data_dir: &Path,
    id: uuid::Uuid,
    path: &ObjectPath,
) -> Result<Option<String>> {
    let file = lineage_layout_path(data_dir, id, path);
    // The same guard as the write and the delete: a missing or linked `.lineage` folder
    // reads as no layout (P18).
    if check_user_path(&file, data_dir, PathUse::Flow).is_err() {
        return Ok(None);
    }
    match std::fs::symlink_metadata(&file) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(layout_err(&file, "read", e)),
    }
    let f = match std::fs::File::open(&file) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(layout_err(&file, "read", e)),
    };
    // Checked and read from the one opened handle, at most one byte past the limit, so a
    // file swapped after the check cannot make the read unbounded.
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    f.take(LINEAGE_LAYOUT_MAX as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| layout_err(&file, "read", e))?;
    if bytes.len() > LINEAGE_LAYOUT_MAX {
        return Ok(None);
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    Ok(check_layout_text(&text).is_ok().then_some(text))
}

/// Saves the moved cards of table `path`'s lineage through the diagrams folder guard
/// (`PathUse::Flow`), as a partial file renamed over the old one.
pub fn write_lineage_layout(
    data_dir: &Path,
    id: uuid::Uuid,
    path: &ObjectPath,
    layout: &str,
) -> Result<()> {
    check_layout_text(layout)?;
    let file = lineage_layout_path(data_dir, id, path);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| layout_err(dir, "create", e))?;
    }
    let mut w = PartialFile::create(&file, true, PathUse::Flow, data_dir)?.writer();
    w.write_all(layout.as_bytes())
        .map_err(|e| layout_err(&file, "write", e))?;
    w.commit().map(|_| ())
}

/// Reset: removes the saved layout of table `path`'s lineage; none is fine.
pub fn delete_lineage_layout(data_dir: &Path, id: uuid::Uuid, path: &ObjectPath) -> Result<()> {
    let file = lineage_layout_path(data_dir, id, path);
    if !file.exists() {
        return Ok(());
    }
    check_user_path(&file, data_dir, PathUse::Flow)?;
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(layout_err(&file, "remove", e)),
    }
}

/// One Foreign Key as lineage's catalog read gives it (P6): the Dialect's `key_edges`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEdge {
    /// The constraint name; SQLite keys are `fk_<id>`, as in the Table Designer.
    pub name: String,
    pub from: ObjectPath,
    pub from_columns: Vec<String>,
    pub to: ObjectPath,
    pub to_columns: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

/// One table's columns as lineage's light read gives them: the Dialect's `key_tables`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyTable {
    pub path: ObjectPath,
    pub columns: Vec<KeyColumn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyColumn {
    pub name: String,
    pub ty: String,
    pub nullable: bool,
    pub pk: bool,
}

/// Where lineage reads its catalog details; the Dialect in the app, a fake in tests.
#[async_trait::async_trait]
pub(crate) trait KeySource: Send + Sync {
    async fn key_edges(&self, database: &str, schema: Option<&str>) -> Result<Vec<KeyEdge>>;
    async fn key_tables(
        &self,
        database: &str,
        schema: Option<&str>,
        tables: &[String],
    ) -> Result<Vec<KeyTable>>;
}

pub(crate) struct DialectKeys(pub Arc<dyn Dialect>);

#[async_trait::async_trait]
impl KeySource for DialectKeys {
    async fn key_edges(&self, database: &str, schema: Option<&str>) -> Result<Vec<KeyEdge>> {
        self.0.key_edges(database, schema).await
    }
    async fn key_tables(
        &self,
        database: &str,
        schema: Option<&str>,
        tables: &[String],
    ) -> Result<Vec<KeyTable>> {
        self.0.key_tables(database, schema, tables).await
    }
}

/// The one database (MySQL, SQLite) or schema (PostgreSQL) a catalog read covers.
type Scope = (String, Option<String>);

fn scope(p: &ObjectPath) -> Scope {
    (p.database.clone(), p.schema.clone())
}

/// What `MISSING` and `LATE` say on a card lineage could not read.
const MISSING: &str = "Contura can't find this table.";
const LATE: &str = "Reading it took longer than 10s.";

enum Load {
    Ready,
    Failed(String),
    Late,
}

/// The key edges read so far, one catalog read per scope, all before `until`.
struct Graph<'a> {
    source: &'a dyn KeySource,
    until: Instant,
    fold: bool,
    edges: Vec<KeyEdge>,
    /// Each edge kept, by its constraint and holder table: one look per edge, so the de-dupe is
    /// linear in the edges read (P24 M9).
    seen: HashSet<EdgeKey>,
    loaded: Vec<(Scope, Option<String>)>,
}

/// An edge's constraint name and holder table; the table name folded where `same` folds it.
type EdgeKey = (String, String, Option<String>, String);

impl Graph<'_> {
    /// The same table: SQLite resolves table names without regard to case (P6 I3).
    fn same(&self, a: &ObjectPath, b: &ObjectPath) -> bool {
        a.database == b.database
            && a.schema == b.schema
            && if self.fold {
                a.name.eq_ignore_ascii_case(&b.name)
            } else {
                a.name == b.name
            }
    }

    fn edge_key(&self, e: &KeyEdge) -> EdgeKey {
        let table = if self.fold {
            e.from.name.to_ascii_lowercase()
        } else {
            e.from.name.clone()
        };
        (
            e.name.clone(),
            e.from.database.clone(),
            e.from.schema.clone(),
            table,
        )
    }

    fn left(&self) -> Duration {
        self.until.saturating_duration_since(Instant::now())
    }

    /// Reads the edges of `at` once. `strict` (the center's scope) returns the error.
    async fn ensure(&mut self, at: &Scope, strict: bool) -> Result<Load> {
        if let Some((_, failed)) = self.loaded.iter().find(|(s, _)| s == at) {
            return Ok(failed.clone().map_or(Load::Ready, Load::Failed));
        }
        let left = self.left();
        if left.is_zero() {
            return Ok(Load::Late);
        }
        let read = self.source.key_edges(&at.0, at.1.as_deref());
        match tokio::time::timeout(left, read).await {
            Err(_) => Ok(Load::Late),
            Ok(Err(e)) if strict => Err(e),
            Ok(Err(e)) => {
                let reason = e.to_string();
                self.loaded.push((at.clone(), Some(reason.clone())));
                Ok(Load::Failed(reason))
            }
            Ok(Ok(edges)) => {
                for e in edges {
                    if self.seen.insert(self.edge_key(&e)) {
                        self.edges.push(e);
                    }
                }
                self.loaded.push((at.clone(), None));
                Ok(Load::Ready)
            }
        }
    }
}

struct Reached {
    path: ObjectPath,
    distance: i32,
    unreadable: Option<String>,
    columns: Option<Vec<KeyColumn>>,
}

/// A breadth-first walk from `center` over the Foreign Keys of each scope it enters,
/// read once per scope, then one light column read per scope for the tables reached.
/// A visited list stops cycles; no more than `MAX_TABLES` tables are reached, and the
/// whole walk stops at `deadline`; either sets `truncated`. Tables the center uses are
/// followed by their keys only, tables using it by the keys pointing at them only. A
/// `depth` of 0 means All. Only the center's own failure fails the call; any other table
/// keeps its card with `unreadable` set and is not walked further.
pub(crate) async fn walk(
    source: &dyn KeySource,
    center: ObjectPath,
    depth: u8,
    direction: Direction,
    fold: bool,
    deadline: Duration,
) -> Result<Lineage> {
    let mut g = Graph {
        source,
        until: Instant::now() + deadline,
        fold,
        edges: Vec::new(),
        seen: HashSet::new(),
        loaded: Vec::new(),
    };
    let mut reached = vec![Reached {
        path: center.clone(),
        distance: 0,
        unreadable: None,
        columns: None,
    }];
    let mut queue = VecDeque::from([0usize]);
    let mut truncated = false;
    while let Some(at) = queue.pop_front() {
        let (path, distance) = (reached[at].path.clone(), reached[at].distance);
        if depth != 0 && distance.unsigned_abs() >= u32::from(depth) {
            continue;
        }
        match g.ensure(&scope(&path), at == 0).await? {
            Load::Ready => {}
            Load::Failed(reason) => {
                reached[at].unreadable = Some(reason);
                continue;
            }
            Load::Late => {
                truncated = true;
                break;
            }
        }
        let mut next: Vec<(ObjectPath, i32)> = Vec::new();
        for e in &g.edges {
            if distance <= 0 && direction != Direction::UsedBy && g.same(&e.from, &path) {
                next.push((e.to.clone(), distance - 1));
            }
            if distance >= 0 && direction != Direction::Uses && g.same(&e.to, &path) {
                next.push((e.from.clone(), distance + 1));
            }
        }
        for (path, distance) in next {
            if reached.iter().any(|r| g.same(&r.path, &path)) {
                continue;
            }
            if reached.len() >= MAX_TABLES {
                truncated = true;
                continue;
            }
            reached.push(Reached {
                path,
                distance,
                unreadable: None,
                columns: None,
            });
            queue.push_back(reached.len() - 1);
        }
    }

    // The edges of every scope reached, so each card knows all its Foreign Key columns.
    let mut scopes: Vec<Scope> = Vec::new();
    for r in &reached {
        if !scopes.contains(&scope(&r.path)) {
            scopes.push(scope(&r.path));
        }
    }
    for s in &scopes {
        if let Load::Late = g.ensure(s, false).await? {
            truncated = true;
        }
    }

    // One light column read per scope; the center gets at least 2s of its own.
    for s in &scopes {
        let has_center = &scope(&reached[0].path) == s;
        let left = if has_center {
            g.left().max(Duration::from_secs(2))
        } else {
            g.left()
        };
        let names: Vec<String> = reached
            .iter()
            .filter(|r| &scope(&r.path) == s)
            .map(|r| r.path.name.clone())
            .collect();
        let read = if left.is_zero() {
            None
        } else {
            tokio::time::timeout(left, source.key_tables(&s.0, s.1.as_deref(), &names))
                .await
                .ok()
        };
        let found = match read {
            Some(Ok(found)) => found,
            Some(Err(e)) if has_center => return Err(e),
            None if has_center => return Err(Error::TimedOut(deadline.as_secs() as u32)),
            Some(Err(e)) => {
                let reason = e.to_string();
                for r in reached.iter_mut().filter(|r| &scope(&r.path) == s) {
                    r.unreadable.get_or_insert_with(|| reason.clone());
                }
                continue;
            }
            None => {
                truncated = true;
                for r in reached.iter_mut().filter(|r| &scope(&r.path) == s) {
                    r.unreadable.get_or_insert_with(|| LATE.to_string());
                }
                continue;
            }
        };
        for (i, r) in reached.iter_mut().enumerate() {
            if &scope(&r.path) != s {
                continue;
            }
            match found.iter().find(|t| g.same(&t.path, &r.path)) {
                Some(t) => {
                    // The catalog's spelling, so cards and links name the real table.
                    r.path = t.path.clone();
                    r.columns = Some(t.columns.clone());
                }
                None if i == 0 => return Err(Error::NotFound(r.path.name.clone())),
                None => {
                    r.unreadable.get_or_insert_with(|| MISSING.to_string());
                }
            }
        }
    }

    let links = links_between(&g, &reached);
    let tables = reached.iter().map(|r| card(&g, r, &links)).collect();
    Ok(Lineage {
        center: reached[0].path.clone(),
        tables,
        links,
        truncated,
    })
}

fn find<'a>(g: &Graph<'_>, reached: &'a [Reached], path: &ObjectPath) -> Option<&'a Reached> {
    reached.iter().find(|r| g.same(&r.path, path))
}

/// Every key whose two tables were both reached, once each, from the table holding it.
fn links_between(g: &Graph<'_>, reached: &[Reached]) -> Vec<LineageLink> {
    let mut out = Vec::new();
    for e in &g.edges {
        let (Some(from), Some(to)) = (find(g, reached, &e.from), find(g, reached, &e.to)) else {
            continue;
        };
        let nullable = from.columns.as_ref().is_some_and(|cols| {
            e.from_columns
                .iter()
                .any(|name| cols.iter().any(|c| &c.name == name && c.nullable && !c.pk))
        });
        out.push(LineageLink {
            from: from.path.clone(),
            from_columns: e.from_columns.clone(),
            to: to.path.clone(),
            to_columns: e.to_columns.clone(),
            on_delete: e.on_delete.clone(),
            on_update: e.on_update.clone(),
            nullable,
        });
    }
    out
}

fn card(g: &Graph<'_>, r: &Reached, links: &[LineageLink]) -> LineageTable {
    let fk = |name: &str| {
        g.edges
            .iter()
            .any(|e| g.same(&e.from, &r.path) && e.from_columns.iter().any(|c| c == name))
    };
    let target = |name: &str| {
        links
            .iter()
            .any(|l| l.to == r.path && l.to_columns.iter().any(|c| c == name))
    };
    let (columns, column_count) = match &r.columns {
        Some(cols) => (
            cols.iter()
                .filter_map(|c| {
                    let fk = fk(&c.name);
                    (c.pk || fk || target(&c.name)).then(|| LineageColumn {
                        name: c.name.clone(),
                        ty: c.ty.clone(),
                        pk: c.pk,
                        fk,
                        // A key column is never empty, whatever the catalog says of a rowid alias.
                        nullable: c.nullable && !c.pk,
                    })
                })
                .collect(),
            u32::try_from(cols.len()).unwrap_or(u32::MAX),
        ),
        // Unread: only the columns the known keys name.
        None => {
            let mut names: Vec<String> = Vec::new();
            for e in &g.edges {
                if g.same(&e.from, &r.path) {
                    names.extend(e.from_columns.iter().cloned());
                }
            }
            for l in links.iter().filter(|l| l.to == r.path) {
                names.extend(l.to_columns.iter().cloned());
            }
            let mut columns: Vec<LineageColumn> = Vec::new();
            for name in names {
                if columns.iter().any(|c| c.name == name) {
                    continue;
                }
                columns.push(LineageColumn {
                    fk: fk(&name),
                    name,
                    ty: String::new(),
                    pk: false,
                    nullable: false,
                });
            }
            (columns, 0)
        }
    };
    LineageTable {
        path: r.path.clone(),
        columns,
        column_count,
        distance: r.distance,
        unreadable: r.unreadable.clone(),
    }
}

/// Every node with a `table:` in the diagrams folder, with how the diagram's flow lines
/// meet it. Each `.flow` file is read line by line, with no full parse; a node that no
/// arrow touches is left out.
pub fn list_flow_table_links(data_dir: &Path) -> Result<Vec<FlowTableLink>> {
    let dir = diagrams_dir(data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::File(format!("cannot read {}: {e}", dir.display()))),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(file) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(name) = file.strip_suffix(".flow") else {
            continue;
        };
        if flow_file_name(name).ok().as_deref() != Some(file.as_str()) {
            continue;
        }
        if !entry.metadata().is_ok_and(|m| m.is_file()) {
            continue;
        }
        // A file that cannot be opened is skipped, as the diagram list skips it.
        let Ok(f) = std::fs::File::open(entry.path()) else {
            continue;
        };
        for found in scan_flow(f).links {
            out.push(FlowTableLink {
                file: name.to_string(),
                node: found.node,
                kind: found.kind,
                table: found.table,
                frame: found.frame,
                access: found.access,
                processes: found.processes,
            });
        }
    }
    out.sort_by(|a, b| (&a.file, &a.frame, &a.node).cmp(&(&b.file, &b.frame, &b.node)));
    Ok(out)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ScannedLink {
    pub node: String,
    pub kind: String,
    pub table: String,
    /// The frame's title; `None` when the file has one frame.
    pub frame: Option<String>,
    pub access: Access,
    pub processes: Vec<FlowProcess>,
}

pub(crate) struct FlowScan {
    pub links: Vec<ScannedLink>,
    /// The largest the line buffer grew, so a test can see the file was read line by line.
    #[cfg_attr(not(test), allow(dead_code))]
    pub peak_line: usize,
}

#[derive(Default)]
struct Touch {
    into: bool,
    out_of: bool,
    /// The nodes on the other end of the directed lines, first written first, with what
    /// each does: `into` when it sends into this node (writes), `out_of` when it takes from
    /// it (reads). Capped, so a node with a huge fan-out costs a bounded amount.
    others: Vec<(String, bool, bool)>,
}

/// The most other ends kept for one node: enough to name `MAX_PROCESSES` processes after
/// skipping stores, entities and other non-processes.
const MAX_OTHERS: usize = 64;

impl Touch {
    fn meet(&mut self, other: &str, writes: bool, reads: bool) {
        if let Some(o) = self.others.iter_mut().find(|o| o.0 == other) {
            o.1 |= writes;
            o.2 |= reads;
        } else if self.others.len() < MAX_OTHERS {
            self.others.push((other.to_string(), writes, reads));
        }
    }
}

/// One frame's nodes and lines while the file is read; every frame starts fresh.
#[derive(Default)]
struct FrameScan {
    kind: Option<DiagramKind>,
    title: String,
    /// Node name -> (kind, table), in the order written.
    nodes: Vec<(String, String, String)>,
    /// Every declared node's kind as written, or None when the line names none.
    kinds: HashMap<String, Option<String>>,
    touches: HashMap<String, Touch>,
}

/// Every node with a `table:` in `text`, touched by a line or not, in text order: its frame's
/// title (`None` when the text has one frame), its name and the value as written. A node
/// written twice in a frame counts once, with its last value. Read line by line like
/// `scan_flow`, with no full parse; the diagram Ask gates on it (Task 4b).
pub fn flow_table_nodes(text: &str) -> Vec<(Option<String>, String, String)> {
    flow_table_nodes_upto(text, usize::MAX).unwrap_or_default()
}

/// `flow_table_nodes`, but `None` as soon as more than `max` distinct nodes carry a
/// `table:`, so a hostile file is not read to its end. Linear in the text.
pub fn flow_table_nodes_upto(
    text: &str,
    max: usize,
) -> Option<Vec<(Option<String>, String, String)>> {
    let mut reader = BufReader::new(text.as_bytes().take(READ_MAX));
    let mut buf = Vec::new();
    let mut first = true;
    let mut frames = 0;
    let mut title = String::new();
    let mut out: Vec<(Option<String>, String, String)> = Vec::new();
    // The current frame's node name -> its index in `out`.
    let mut seen: HashMap<String, usize> = HashMap::new();
    while let Some(fits) = read_flow_line(&mut reader, &mut buf) {
        if !fits {
            first = false;
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        if first && is_blank_or_comment(&line) {
            continue;
        }
        if first || is_frame_header(&line) {
            first = false;
            frames += 1;
            title = diagram_head(line.as_bytes()).1.unwrap_or_default();
            seen.clear();
            continue;
        }
        if let Some(Line::Node { name, attrs }) = parse_line(line.trim())
            && let Some(table) = attrs.table
        {
            match seen.get(&name) {
                Some(&i) => out[i].2 = table,
                None => {
                    if out.len() >= max {
                        return None;
                    }
                    seen.insert(name.clone(), out.len());
                    out.push((Some(title.clone()), name, table));
                }
            }
        }
    }
    if frames <= 1 {
        for l in &mut out {
            l.0 = None;
        }
    }
    Some(out)
}

/// The `table:` nodes of one `.flow` file and the arrows that meet them, frame by frame.
pub(crate) fn scan_flow(reader: impl Read) -> FlowScan {
    let mut reader = BufReader::new(reader.take(READ_MAX));
    let mut buf = Vec::new();
    let mut peak_line = 0;
    let mut first = true;
    let mut frames = 0;
    let mut cur = FrameScan::default();
    let mut links = Vec::new();
    while let Some(fits) = read_flow_line(&mut reader, &mut buf) {
        peak_line = peak_line.max(buf.capacity());
        if !fits {
            first = false;
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        // Blank lines and comments before the first header belong to no frame.
        if first && is_blank_or_comment(&line) {
            continue;
        }
        let head = first || is_frame_header(&line);
        if head {
            if !first {
                finish_frame(std::mem::take(&mut cur), &mut links);
            }
            first = false;
            frames += 1;
            let (kind, title) = diagram_head(line.as_bytes());
            cur.kind = Some(kind);
            cur.title = title.unwrap_or_default();
            continue;
        }
        let kind = cur.kind.unwrap_or(DiagramKind::Unknown);
        match parse_line(line.trim()) {
            Some(Line::Node { name, attrs }) => {
                cur.kinds.insert(name.clone(), attrs.kind.clone());
                let Some(table) = attrs.table else { continue };
                let node_kind = attrs.kind.unwrap_or_else(|| {
                    if kind == DiagramKind::Flow {
                        "step"
                    } else {
                        "node"
                    }
                    .to_string()
                });
                match cur.nodes.iter_mut().find(|(n, _, _)| *n == name) {
                    Some(found) => *found = (name, node_kind, table),
                    None => cur.nodes.push((name, node_kind, table)),
                }
            }
            Some(Line::Links(found)) => {
                for (from, arrow, to) in found {
                    if from == to {
                        continue;
                    }
                    let both = match arrow {
                        Arrow::One => false,
                        Arrow::Both => true,
                        Arrow::Plain => continue,
                    };
                    let t = cur.touches.entry(to.clone()).or_default();
                    t.into = true;
                    t.out_of |= both;
                    // `from` sends into `to`: it writes there, and with `<>` reads too.
                    t.meet(&from, true, both);
                    let f = cur.touches.entry(from.clone()).or_default();
                    f.out_of = true;
                    f.into |= both;
                    // `to` takes from `from`: it reads it, and with `<>` writes too.
                    f.meet(&to, both, true);
                }
            }
            None => {}
        }
    }
    finish_frame(cur, &mut links);
    if frames <= 1 {
        for l in &mut links {
            l.frame = None;
        }
    }
    FlowScan { links, peak_line }
}

/// The links of one finished frame, added to `links` with the frame's title.
fn finish_frame(frame: FrameScan, links: &mut Vec<ScannedLink>) {
    let FrameScan {
        title,
        nodes,
        kinds,
        touches,
        ..
    } = frame;
    let tables: HashSet<&str> = nodes.iter().map(|n| n.0.as_str()).collect();
    let is_process = |name: &str| {
        !tables.contains(name)
            && kinds
                .get(name)
                .and_then(Option::as_deref)
                .is_none_or(|k| !NOT_PROCESSES.contains(&k))
    };
    for (node, kind, table) in &nodes {
        let Some(t) = touches.get(node) else { continue };
        let Some(access) = access_of(t.into, t.out_of) else {
            continue;
        };
        // A step with a `table:` (a flowchart io, step or subprocess, or a data flow process)
        // is itself what touches the table: its lines are control flow, not data flow (P18).
        // Only stores and service nodes look across their lines for the processes.
        let processes = if STEP_KINDS.contains(&kind.as_str()) {
            vec![FlowProcess {
                node: node.clone(),
                access,
            }]
        } else {
            t.others
                .iter()
                .filter(|(other, _, _)| is_process(other))
                .filter_map(|(other, writes, reads)| {
                    Some(FlowProcess {
                        node: other.clone(),
                        access: access_of(*writes, *reads)?,
                    })
                })
                .take(MAX_PROCESSES)
                .collect()
        };
        links.push(ScannedLink {
            node: node.clone(),
            kind: kind.clone(),
            table: table.clone(),
            frame: Some(title.clone()),
            access,
            processes,
        });
    }
}

/// `writes` and `reads` as one `Access`; `None` when neither.
fn access_of(writes: bool, reads: bool) -> Option<Access> {
    match (writes, reads) {
        (true, true) => Some(Access::Both),
        (true, false) => Some(Access::Writes),
        (false, true) => Some(Access::Reads),
        (false, false) => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arrow {
    /// `>` and the dashed `-->`: from the left end into the right one.
    One,
    /// `<>`.
    Both,
    /// `-`: no direction.
    Plain,
}

#[derive(Default)]
struct Attrs {
    kind: Option<String>,
    table: Option<String>,
}

enum Line {
    Node { name: String, attrs: Attrs },
    Links(Vec<(String, Arrow, String)>),
}

/// `"..."` with `\\`, `\"`, `\n` and `\r` escapes at the start of `s`, and the text after it.
fn quoted(s: &str) -> Option<(String, &str)> {
    let mut out = String::new();
    let mut chars = s.strip_prefix('"')?.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((out, &s[i + 2..])),
            // `\n` and `\r` are the line breaks the writer escapes (P5); `\\`, `\"` as is.
            '\\' => out.push(match chars.next()?.1 {
                'n' => '\n',
                'r' => '\r',
                c => c,
            }),
            c => out.push(c),
        }
    }
    None
}

/// A node name at the start of `s`: quoted, or bare up to the first piece of syntax
/// (`flowModel.ts` RESERVED), and the text after it.
fn name(s: &str) -> Option<(String, &str)> {
    name_in(s, false)
}

/// `name`, and with `at_comma` a bare name also stops at a comma: one end of a link line.
fn name_in(s: &str, at_comma: bool) -> Option<(String, &str)> {
    let s = s.trim_start();
    if s.starts_with('"') {
        return quoted(s);
    }
    let b = s.as_bytes();
    let space = |i: usize| b.get(i).is_none_or(u8::is_ascii_whitespace);
    let mut i = 0;
    while i < b.len() {
        let stop = match b[i] {
            b'[' | b']' | b'{' | b'}' | b':' | b'>' | b'<' | b'"' | b'\\' => true,
            b',' => at_comma,
            b'/' => b.get(i + 1) == Some(&b'/'),
            b'-' => b.get(i + 1) == Some(&b'-') || ((i == 0 || space(i - 1)) && space(i + 1)),
            _ => false,
        };
        if stop {
            break;
        }
        i += 1;
    }
    let n = s[..i].trim();
    (!n.is_empty()).then(|| (n.to_string(), &s[i..]))
}

fn arrow(s: &str) -> Option<(Arrow, &str)> {
    let s = s.trim_start();
    if let Some(rest) = s.strip_prefix("<>") {
        return Some((Arrow::Both, rest));
    }
    if let Some(rest) = s.strip_prefix("-->") {
        return Some((Arrow::One, rest));
    }
    if let Some(rest) = s.strip_prefix('>') {
        return Some((Arrow::One, rest));
    }
    // `--` is the dotted line with no arrowhead, `-` the plain one.
    let rest = s.strip_prefix("--").or_else(|| s.strip_prefix('-'))?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then_some((Arrow::Plain, rest))
}

/// The inside of `[...]` at the start of `s` (quotes kept), and the text after it.
fn bracket(s: &str) -> Option<(&str, &str)> {
    let body = s.strip_prefix('[')?;
    let mut in_quote = false;
    let mut escaped = false;
    for (i, c) in body.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            ']' if !in_quote => return Some((&body[..i], &body[i + 1..])),
            _ => {}
        }
    }
    None
}

/// `body` split on the commas outside quotes.
fn items(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut in_quote, mut escaped) = (0, false, false);
    for (i, c) in body.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            ',' if !in_quote => {
                out.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&body[start..]);
    out
}

fn attrs(body: &str) -> Attrs {
    let mut out = Attrs::default();
    for item in items(body) {
        let item = item.trim();
        match item.split_once(':') {
            Some((key, value)) => {
                if key.trim() == "table" {
                    let value = value.trim();
                    let value = match quoted(value) {
                        Some((v, rest)) if rest.trim().is_empty() => v,
                        _ => value.to_string(),
                    };
                    if !value.is_empty() {
                        out.table = Some(value);
                    }
                }
            }
            None if !item.is_empty() && out.kind.is_none() => out.kind = Some(item.to_string()),
            None => {}
        }
    }
    out
}

/// One end of a link line: names separated by commas outside quotes (`A, B`), and the text
/// after the last one.
fn ends(s: &str) -> Option<(Vec<String>, &str)> {
    let (first, mut rest) = name_in(s, true)?;
    let mut out = vec![first];
    while let Some(after) = rest.trim_start().strip_prefix(',') {
        let Some((next, r)) = name_in(after, true) else {
            break;
        };
        out.push(next);
        rest = r;
    }
    Some((out, rest))
}

/// A node line (`Orders [store, table: shop.orders]`) or a link line
/// (`A, B > C > D: label`); `None` for a comment, a group, a brace or anything else.
fn parse_line(line: &str) -> Option<Line> {
    if line.is_empty() || line.starts_with("//") || line.starts_with('}') {
        return None;
    }
    // A comma list followed by an arrow is a link line; any other line reads as a node line,
    // where a bare comma is part of the name.
    if let Some((first, rest)) = ends(line)
        && let Some((mut kind, mut rest)) = arrow(rest)
    {
        let mut from = first;
        let mut out = Vec::new();
        'segments: while let Some((to, after)) = ends(rest) {
            for f in &from {
                for t in &to {
                    if out.len() >= MAX_FAN_LINKS {
                        break 'segments;
                    }
                    out.push((f.clone(), kind, t.clone()));
                }
            }
            match arrow(after) {
                Some((k, r)) => {
                    from = to;
                    kind = k;
                    rest = r;
                }
                None => break,
            }
        }
        return Some(Line::Links(out));
    }
    let (first, rest) = name(line)?;
    // `Name {` opens a group; anything after the brace on the same line is read as a line.
    if let Some(inner) = rest.trim_start().strip_prefix('{') {
        return parse_line(inner.trim().trim_end_matches('}').trim());
    }
    let (body, after) = bracket(rest.trim_start())?;
    // `Name [icon: x] {` opens a group, which is not a node.
    if let Some(inner) = after.trim_start().strip_prefix('{') {
        return parse_line(inner.trim().trim_end_matches('}').trim());
    }
    Some(Line::Node {
        name: first,
        attrs: attrs(body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagrams::MAX_LINE;

    fn found(scan: &FlowScan) -> Vec<(&str, &str, &str, Access)> {
        scan.links
            .iter()
            .map(|l| (l.node.as_str(), l.kind.as_str(), l.table.as_str(), l.access))
            .collect()
    }

    #[test]
    fn flow_links_scan() {
        // A data flow: into the store writes, out of it reads.
        let dfd = "diagram dfd \"Checkout\"\n\
                   Checkout [process, id: 1]\n\
                   Orders [store, id: D1, table: shop.orders]\n\
                   Stock [store, table: shop.stock]\n\
                   Checkout > Orders: new order\n\
                   Stock --> Checkout: stock level\n";
        assert_eq!(
            found(&scan_flow(dfd.as_bytes())),
            [
                ("Orders", "store", "shop.orders", Access::Writes),
                ("Stock", "store", "shop.stock", Access::Reads),
            ]
        );

        // A flowchart io step, declared after the arrows that use it, inside a group.
        let flow = "diagram flow \"Handover\"\n\
                    Start [start] \n\
                    Start > \"Load: orders\" > Done: ok\n\
                    Steps {\n\
                    \x20 \"Load: orders\" [io, table: \"shop.orders\"]\n\
                    \x20 Plain [table: shop.plain]\n\
                    }\n\
                    Plain - Done\n\
                    Plain <> Start\n";
        assert_eq!(
            found(&scan_flow(flow.as_bytes())),
            [
                ("Load: orders", "io", "shop.orders", Access::Both),
                ("Plain", "step", "shop.plain", Access::Both),
            ]
        );

        // A 3 MB comment block, and one 1 MB comment line, are read a line at a time. The whole file stays under READ_MAX.
        let mut big = String::from("diagram dfd \"Big\"\nP [process]\n");
        let comment = format!("// {}\n", "x".repeat(97));
        while big.len() < 3 * 1024 * 1024 {
            big.push_str(&comment);
        }
        big.push_str(&format!(
            "// {} T [store, table: shop.hidden]\n",
            "y".repeat(1 << 20)
        ));
        big.push_str("T [store, table: shop.t]\nP > T\n");
        let scan = scan_flow(big.as_bytes());
        assert_eq!(found(&scan), [("T", "store", "shop.t", Access::Writes)]);
        assert!(
            scan.peak_line <= 2 * MAX_LINE,
            "the line buffer grew to {}",
            scan.peak_line
        );
    }

    #[test]
    fn names_follow_the_writer_quoting() {
        assert_eq!(name("Charge card [x]").unwrap().0, "Charge card");
        assert_eq!(name("e-mail > b").unwrap().0, "e-mail");
        assert_eq!(name("a - b").unwrap().0, "a");
        assert_eq!(name("a --> b").unwrap().0, "a");
        assert_eq!(
            name(r#""say \"hi\" \\ now" > b"#).unwrap().0,
            r#"say "hi" \ now"#
        );
        assert!(name("// note").is_none());
        // A line break in a name is written `\n` or `\r` (P5); `\\n` stays a backslash and n.
        assert_eq!(name(r#""two\nlines\r" > b"#).unwrap().0, "two\nlines\r");
        assert_eq!(name(r#""a\\nb" > c"#).unwrap().0, "a\\nb");
        assert!(parse_line("G [icon: x] {").is_none());
        // A dotted `--` is a line with no direction, not a node line.
        assert!(matches!(
            parse_line("A -- B"),
            Some(Line::Links(l)) if l == [("A".into(), Arrow::Plain, "B".into())]
        ));
    }

    fn path(name: &str) -> ObjectPath {
        ObjectPath {
            database: "main".into(),
            schema: None,
            name: name.into(),
        }
    }

    fn edge(from: &str, to: &str) -> KeyEdge {
        KeyEdge {
            name: format!("{from}_{to}"),
            from: path(from),
            from_columns: vec![format!("{to}_id")],
            to: path(to),
            to_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        }
    }

    /// A catalog of `edges` over tables `a`..`z`; each read is counted and waits `wait`.
    struct Fake {
        edges: Vec<KeyEdge>,
        wait: Duration,
        edge_reads: std::sync::Mutex<u32>,
        table_reads: std::sync::Mutex<u32>,
    }

    impl Fake {
        fn new(edges: Vec<KeyEdge>, wait: Duration) -> Fake {
            Fake {
                edges,
                wait,
                edge_reads: std::sync::Mutex::new(0),
                table_reads: std::sync::Mutex::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl KeySource for Fake {
        async fn key_edges(&self, _: &str, _: Option<&str>) -> Result<Vec<KeyEdge>> {
            *self.edge_reads.lock().unwrap() += 1;
            tokio::time::sleep(self.wait).await;
            Ok(self.edges.clone())
        }
        async fn key_tables(
            &self,
            _: &str,
            _: Option<&str>,
            tables: &[String],
        ) -> Result<Vec<KeyTable>> {
            *self.table_reads.lock().unwrap() += 1;
            Ok(tables
                .iter()
                .map(|t| KeyTable {
                    path: path(t),
                    columns: vec![KeyColumn {
                        name: "id".into(),
                        ty: "integer".into(),
                        nullable: false,
                        pk: true,
                    }],
                })
                .collect())
        }
    }

    #[tokio::test]
    async fn each_scope_is_read_once() {
        // a -> b -> c -> a, and a -> c: a cycle with a shortcut.
        let fake = Fake::new(
            vec![
                edge("a", "b"),
                edge("b", "c"),
                edge("c", "a"),
                edge("a", "c"),
            ],
            Duration::ZERO,
        );
        let l = walk(&fake, path("a"), 0, Direction::Both, false, DEADLINE)
            .await
            .unwrap();
        assert_eq!(*fake.edge_reads.lock().unwrap(), 1);
        assert_eq!(*fake.table_reads.lock().unwrap(), 1);
        assert_eq!(l.tables.len(), 3);
        assert_eq!(l.links.len(), 4);
        assert!(!l.truncated);
    }

    #[tokio::test]
    async fn the_deadline_returns_what_was_found() {
        let fake = Fake::new(vec![edge("a", "b")], Duration::from_millis(300));
        let l = walk(
            &fake,
            path("a"),
            0,
            Direction::Both,
            false,
            Duration::from_millis(50),
        )
        .await
        .unwrap();
        assert!(l.truncated);
        assert_eq!(l.tables.len(), 1, "the center still has its card");
        assert_eq!(l.tables[0].unreadable, None);
        assert_eq!(l.tables[0].columns.len(), 1);
    }

    #[test]
    fn one_line_groups_are_scanned() {
        let text = "diagram dfd \"G\"
                    P [process]
                    Store { S [store, table: shop.s] }
                    Boxed [icon: box] { T [store, table: shop.t] }
                    P > S
                    T > P
";
        assert_eq!(
            found(&scan_flow(text.as_bytes())),
            [
                ("S", "store", "shop.s", Access::Writes),
                ("T", "store", "shop.t", Access::Reads),
            ]
        );
    }

    type Who<'a> = Vec<(&'a str, Option<&'a str>, &'a str, &'a str, Access)>;

    fn by_frame(scan: &FlowScan) -> Who<'_> {
        scan.links
            .iter()
            .flat_map(|l| {
                l.processes.iter().map(|p| {
                    (
                        l.table.as_str(),
                        l.frame.as_deref(),
                        l.node.as_str(),
                        p.node.as_str(),
                        p.access,
                    )
                })
            })
            .collect()
    }

    #[test]
    fn multi_frame_files_scan_each_frame() {
        let text = "diagram dfd \"Orders\"\n\
                    Orders [store, table: shop.orders]\n\
                    Pay [process]\n\
                    Pay > Orders\n\
                    \n\
                    diagram dfd \"Refunds\"\n\
                    Orders [store, table: shop.refunds]\n\
                    Refund [process]\n\
                    Orders > Refund\n";
        let scan = scan_flow(text.as_bytes());
        assert_eq!(scan.links.len(), 2);
        assert_eq!(
            by_frame(&scan),
            [
                (
                    "shop.orders",
                    Some("Orders"),
                    "Orders",
                    "Pay",
                    Access::Writes
                ),
                (
                    "shop.refunds",
                    Some("Refunds"),
                    "Orders",
                    "Refund",
                    Access::Reads
                ),
            ]
        );
        assert_eq!(scan.links[0].access, Access::Writes);
        assert_eq!(scan.links[1].access, Access::Reads);
    }

    #[test]
    fn one_frame_files_name_no_frame() {
        let text = "diagram dfd \"Solo\"\nS [store, table: shop.s]\nP [process]\nP > S\n";
        let scan = scan_flow(text.as_bytes());
        assert_eq!(scan.links.len(), 1);
        assert_eq!(scan.links[0].frame, None);
    }

    #[test]
    fn fan_out_lines_meet_each_end() {
        let text = "diagram dfd \"Fan\"\n\
                    Orders [store, table: shop.orders]\n\
                    Pay [process]\n\
                    Ship [process]\n\
                    Pay, Ship > Orders\n";
        let scan = scan_flow(text.as_bytes());
        assert_eq!(
            by_frame(&scan),
            [
                ("shop.orders", None, "Orders", "Pay", Access::Writes),
                ("shop.orders", None, "Orders", "Ship", Access::Writes),
            ]
        );
        assert!(matches!(
            parse_line("A > B, C > D"),
            Some(Line::Links(l)) if l.len() == 4
        ));
    }

    #[test]
    fn a_quoted_comma_name_is_one_end() {
        let text = "diagram dfd \"Q\"\n\
                    Orders [store, table: shop.orders]\n\
                    \"Pay, ship\" > Orders\n";
        let scan = scan_flow(text.as_bytes());
        assert_eq!(
            by_frame(&scan),
            [("shop.orders", None, "Orders", "Pay, ship", Access::Writes)]
        );
    }

    #[test]
    fn dotted_line_is_plain() {
        let text = "diagram dfd \"D\"\n\
                    Orders [store, table: shop.orders]\n\
                    Pay [process]\n\
                    Pay -- Orders\n";
        assert!(scan_flow(text.as_bytes()).links.is_empty());
    }

    #[test]
    fn a_leading_comment_is_no_frame() {
        let text = "\u{feff}// shop\n\ndiagram dfd \"Solo\"\n\
                    S [store, table: shop.s]\n\
                    P [process]\n\
                    P > S\n";
        let scan = scan_flow(text.as_bytes());
        assert_eq!(scan.links.len(), 1);
        assert_eq!(scan.links[0].frame, None);
        // A board that starts with a comment still names its frames.
        let board =
            format!("// shop\n{text}\ndiagram dfd \"Two\"\nT [store, table: shop.t]\nP > T\n");
        let scan = scan_flow(board.as_bytes());
        let frames: Vec<_> = scan.links.iter().map(|l| l.frame.as_deref()).collect();
        assert_eq!(frames, [Some("Solo"), Some("Two")]);
    }

    fn pairs(line: &str) -> Vec<(String, Arrow, String)> {
        match parse_line(line) {
            Some(Line::Links(l)) => l,
            _ => panic!("not a link line: {line}"),
        }
    }

    #[test]
    fn fan_out_pairs_are_exact() {
        let one = Arrow::One;
        let p = |a: &str, b: &str| (a.to_string(), one, b.to_string());
        assert_eq!(
            pairs("A, B > C > D, E"),
            [p("A", "C"), p("B", "C"), p("C", "D"), p("C", "E")]
        );
        assert_eq!(
            pairs("A > B, C > D"),
            [p("A", "B"), p("A", "C"), p("B", "D"), p("C", "D")]
        );
        // A trailing comma drops nothing and adds nothing.
        assert_eq!(pairs("A > B,"), [p("A", "B")]);
        // One line makes at most MAX_FAN_LINKS links.
        let side = |n: &str| {
            (0..20)
                .map(|i| format!("{n}{i}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        assert_eq!(
            pairs(&format!("{} > {}", side("A"), side("B"))).len(),
            MAX_FAN_LINKS
        );
    }

    #[test]
    fn table_nodes_upto_stops_at_the_cap_and_keeps_last_value() {
        let big: String = (0..100_000)
            .map(|i| format!("N{i} [table: t{i}]\n"))
            .collect();
        let start = std::time::Instant::now();
        assert!(flow_table_nodes_upto(&big, 500).is_none());
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        let dup = "A [table: a.x]\nA [table: a.y]\n";
        assert_eq!(
            flow_table_nodes_upto(dup, 1).unwrap(),
            [(None, "A".to_string(), "a.y".to_string())]
        );
    }

    #[test]
    fn every_table_node_is_listed_touched_or_not() {
        // A node no arrow touches is still a link to its table (Task 4b): the diagram Ask
        // sends it whatever its lines are.
        let one = "diagram flow \"Handover\"\n\
                   Orders [table: shop.orders]\n\
                   Plain\n\
                   Steps {\n\
                   \x20 Load [io, table: \"shop.stock\"]\n\
                   }\n";
        assert_eq!(
            flow_table_nodes(one),
            [
                (None, "Orders".to_string(), "shop.orders".to_string()),
                (None, "Load".to_string(), "shop.stock".to_string()),
            ]
        );
        // On a board each names its frame, in text order.
        let board =
            "diagram flow \"A\"\nX [table: a.x]\n\ndiagram dfd \"B\"\nY [store, table: b.y]\n";
        assert_eq!(
            flow_table_nodes(board),
            [
                (Some("A".to_string()), "X".to_string(), "a.x".to_string()),
                (Some("B".to_string()), "Y".to_string(), "b.y".to_string()),
            ]
        );
    }
}
