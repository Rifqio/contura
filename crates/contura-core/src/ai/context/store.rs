//! The AI Context tables (migration 5): meta, Context Tree nodes, cards and the FTS index.
//! Free functions over the store's connection; `ContextStore` puts them behind a lock.

use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::ai::budget::estimate_tokens;
use crate::ai::context::build::{saved_text, words_of};
use crate::ai::context::sync::ContextGates;
use crate::ai::context::tree::{Area, SAVED_AREA_ID};
use crate::ai::preview::count_of;
use crate::error::{Error, Result};
use crate::model::{ConnectionConfig, ConnectionId, DialectKind};
use crate::store::AppStore;

/// One AI Context. `schema` is `""` when the Dialect has none.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ContextKey {
    pub connection_id: ConnectionId,
    pub database: String,
    pub schema: String,
}

impl ContextKey {
    /// What a qualified name in this Context's SQL starts with: the schema, or the
    /// database where the Dialect has no schema.
    pub fn qualifier(&self) -> &str {
        if self.schema.is_empty() {
            &self.database
        } else {
            &self.schema
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextMeta {
    pub fingerprint: Option<String>,
    pub built_at: i64,
    pub checked_at: i64,
    pub stale: bool,
    pub table_count: u32,
    pub bytes: u64,
}

/// A table's card without enum values, and with them in `card_rows` (`""` when equal).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCard {
    pub table: String,
    pub card: String,
    pub card_rows: String,
    pub tokens: u32,
    pub rows_tokens: u32,
    pub fk_out: Vec<String>,
    pub fk_in: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub table: String,
    pub tokens: u32,
    /// The tokens of the card with enum values; 0 when it equals the card.
    pub rows_tokens: u32,
    pub fk_out: Vec<String>,
    pub fk_in: Vec<String>,
}

/// A Saved Query that belongs to a Context; `sql` is already masked.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSavedQuery {
    pub id: uuid::Uuid,
    pub name: String,
    pub sql: String,
    pub tables: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FtsRow {
    pub node_id: String,
    pub names: String,
    pub words: String,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuiltContext {
    pub cards: Vec<StoredCard>,
    pub saved: Vec<StoredSavedQuery>,
    pub fts: Vec<FtsRow>,
    /// Built from the graph the cards give; `put_areas` rebuilds them for older Contexts.
    #[serde(default)]
    pub areas: Vec<Area>,
}

/// `score` is `-bm25(...)`: higher is better.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FtsHit {
    pub node_id: String,
    pub score: f64,
}

pub trait ContextStore: Send + Sync {
    fn context_meta(&self, key: &ContextKey) -> Result<Option<ContextMeta>>;
    fn replace_context(
        &self,
        key: &ContextKey,
        built: &BuiltContext,
        fingerprint: Option<&str>,
        now_ms: i64,
    ) -> Result<ContextMeta>;
    /// As `replace_context`, unless the Connection may no longer have a Context (AI access
    /// Never, or deleted) or no longer points where `from`, the config the build read
    /// the catalog through, did (another server, database or file): then nothing is
    /// written and `None` comes back. A store that keeps the Connections checks them
    /// under the same lock as the write, so a clear cannot slip in between. This one
    /// keeps no Connections and always writes.
    fn replace_if_allowed(
        &self,
        key: &ContextKey,
        built: &BuiltContext,
        fingerprint: Option<&str>,
        now_ms: i64,
        from: &ConnectionConfig,
    ) -> Result<Option<ContextMeta>> {
        let _ = from;
        self.replace_context(key, built, fingerprint, now_ms)
            .map(Some)
    }
    fn mark_checked(&self, key: &ContextKey, now_ms: i64) -> Result<()>;
    /// Stores `fingerprint` as checked now on a Context that has none (one the preview
    /// built); a Context with a fingerprint is left alone.
    fn adopt_fingerprint(&self, key: &ContextKey, fingerprint: &str, now_ms: i64) -> Result<()>;
    fn search_context(
        &self,
        key: &ContextKey,
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<FtsHit>>;
    fn context_graph(&self, key: &ContextKey) -> Result<Vec<GraphRow>>;
    fn context_cards(&self, key: &ContextKey, tables: &[String]) -> Result<Vec<StoredCard>>;
    fn context_saved(&self, key: &ContextKey) -> Result<Vec<StoredSavedQuery>>;
    /// Stores `q` in one Context. Its name and SQL go through `saved_text` here, so a
    /// caller cannot store them raw.
    fn put_saved(
        &self,
        key: &ContextKey,
        dialect: DialectKind,
        q: &StoredSavedQuery,
        clean: &dyn Fn(&str) -> String,
    ) -> Result<()>;
    fn remove_saved(&self, key: Option<&ContextKey>, id: uuid::Uuid) -> Result<()>;
    /// The Areas of the Context Tree, sorted by label; empty for a Context built before
    /// Areas existed. The saved queries node is not one of them.
    fn context_areas(&self, key: &ContextKey) -> Result<Vec<Area>>;
    /// Replaces the key's Area nodes and the tables' parents in one transaction; no
    /// catalog call, and cards, FTS rows and saved queries are left alone.
    fn put_areas(&self, key: &ContextKey, areas: &[Area]) -> Result<()>;
    fn mark_stale(&self, connection: ConnectionId) -> Result<u32>;
    fn clear_context(&self, connection: Option<ConnectionId>) -> Result<()>;
    fn context_list(
        &self,
        connection: Option<ConnectionId>,
    ) -> Result<Vec<(ContextKey, ContextMeta)>>;
    /// What `ensure` keeps in memory per Context while this store lives.
    fn gates(&self) -> &ContextGates;
}

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

/// The key columns as `?1`, `?2`, `?3`.
const KEY: &str = "connection_id = ?1 AND database = ?2 AND schema = ?3";

const TABLES: [&str; 4] = [
    "ai_context_meta",
    "ai_context_node",
    "ai_context_card",
    "ai_context_fts",
];

const META_COLUMNS: &str = "fingerprint, built_at, checked_at, stale, table_count, bytes";

/// Names weigh 10, split words 4, notes 1; the key columns and `node_id` nothing.
const BM25: &str = "bm25(ai_context_fts, 0, 0, 0, 0, 10.0, 4.0, 1.0)";

fn json_list(v: &[String]) -> Result<String> {
    serde_json::to_string(v).map_err(store_err)
}

fn parse_list(raw: &str) -> Result<Vec<String>> {
    serde_json::from_str(raw).map_err(store_err)
}

fn saved_node(id: uuid::Uuid) -> String {
    format!("q:{id}")
}

/// A Saved Query's FTS row: its name and tables, and the words `split_words` finds in its name.
pub(crate) fn saved_fts(q: &StoredSavedQuery) -> FtsRow {
    let mut names = vec![q.name.clone()];
    names.extend(q.tables.iter().cloned());
    FtsRow {
        node_id: saved_node(q.id),
        names: names.join(" "),
        words: words_of([q.name.as_str()]),
        note: String::new(),
    }
}

/// One row of `ai_context_node`; the key comes separately.
struct Node<'a> {
    id: String,
    parent: Option<&'a str>,
    kind: &'a str,
    label: &'a str,
    summary: &'a str,
    tables: String,
    tokens: u32,
}

impl<'a> Node<'a> {
    fn saved(q: &'a StoredSavedQuery) -> Result<Self> {
        Ok(Node {
            id: saved_node(q.id),
            parent: Some(SAVED_AREA_ID),
            kind: "saved_query",
            label: &q.name,
            summary: &q.sql,
            tables: json_list(&q.tables)?,
            tokens: estimate_tokens(&q.sql, false),
        })
    }
}

fn insert_node(db: &Connection, key: &ContextKey, n: &Node<'_>) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO ai_context_node
           (connection_id, database, schema, node_id, parent_id, kind, label, summary, tables, tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            n.id,
            n.parent,
            n.kind,
            n.label,
            n.summary,
            n.tables,
            n.tokens
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// An Area's node: its tables and outside joins in the `tables` column.
fn insert_area(db: &Connection, key: &ContextKey, a: &Area) -> Result<()> {
    let tables = serde_json::to_string(&serde_json::json!({
        "tables": a.tables,
        "joinsOut": a.joins_out,
    }))
    .map_err(store_err)?;
    insert_node(
        db,
        key,
        &Node {
            id: a.id.clone(),
            parent: Some("root"),
            kind: "area",
            label: &a.label,
            summary: &a.summary,
            tables,
            tokens: estimate_tokens(&a.summary, true),
        },
    )
}

/// The node of the saved queries Area, counting the Context's saved query nodes.
fn upsert_saved_area(db: &Connection, key: &ContextKey) -> Result<()> {
    let n: i64 = db
        .query_row(
            &format!("SELECT COUNT(*) FROM ai_context_node WHERE {KEY} AND kind = 'saved_query'"),
            params![key.connection_id.to_string(), key.database, key.schema],
            |r| r.get(0),
        )
        .map_err(store_err)?;
    if n == 0 {
        db.execute(
            &format!("DELETE FROM ai_context_node WHERE {KEY} AND node_id = ?4"),
            params![
                key.connection_id.to_string(),
                key.database,
                key.schema,
                SAVED_AREA_ID
            ],
        )
        .map_err(store_err)?;
        return Ok(());
    }
    insert_saved_area(db, key, usize::try_from(n).unwrap_or(0))
}

fn insert_saved_area(db: &Connection, key: &ContextKey, n: usize) -> Result<()> {
    let summary = format!("{}.", count_of(n, "saved query", "saved queries"));
    insert_node(
        db,
        key,
        &Node {
            id: SAVED_AREA_ID.into(),
            parent: Some("root"),
            kind: "area",
            label: "Saved queries",
            tokens: estimate_tokens(&summary, true),
            summary: &summary,
            tables: r#"{"tables":[],"joinsOut":[]}"#.into(),
        },
    )
}

fn insert_fts(db: &Connection, key: &ContextKey, row: &FtsRow) -> Result<()> {
    db.execute(
        "INSERT INTO ai_context_fts (connection_id, database, schema, node_id, names, words, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            row.node_id,
            row.names,
            row.words,
            row.note
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// A saved query's node and FTS row, in one Context or (`None`) in all.
fn delete_saved_rows(db: &Connection, key: Option<&ContextKey>, node_id: &str) -> Result<()> {
    for table in ["ai_context_node", "ai_context_fts"] {
        match key {
            Some(k) => db.execute(
                &format!("DELETE FROM {table} WHERE {KEY} AND node_id = ?4"),
                params![k.connection_id.to_string(), k.database, k.schema, node_id],
            ),
            None => db.execute(
                &format!("DELETE FROM {table} WHERE node_id = ?1"),
                params![node_id],
            ),
        }
        .map_err(store_err)?;
    }
    Ok(())
}

fn meta_row(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<ContextMeta> {
    Ok(ContextMeta {
        fingerprint: r.get(at)?,
        built_at: r.get(at + 1)?,
        checked_at: r.get(at + 2)?,
        stale: r.get(at + 3)?,
        table_count: r.get(at + 4)?,
        bytes: r.get::<_, i64>(at + 5)?.max(0) as u64,
    })
}

pub fn context_meta(db: &Connection, key: &ContextKey) -> Result<Option<ContextMeta>> {
    db.query_row(
        &format!("SELECT {META_COLUMNS} FROM ai_context_meta WHERE {KEY}"),
        params![key.connection_id.to_string(), key.database, key.schema],
        |r| meta_row(r, 0),
    )
    .optional()
    .map_err(store_err)
}

/// Deletes the key's rows and writes the built Context in one transaction: the root
/// node, a `t:<table>` node per card, a `q:<uuid>` node per saved query, the cards, the
/// FTS rows and the meta.
pub fn replace_context(
    db: &Connection,
    key: &ContextKey,
    built: &BuiltContext,
    fingerprint: Option<&str>,
    now_ms: i64,
) -> Result<ContextMeta> {
    let tx = db.unchecked_transaction().map_err(store_err)?;
    let k = params![key.connection_id.to_string(), key.database, key.schema];
    for table in TABLES {
        tx.execute(&format!("DELETE FROM {table} WHERE {KEY}"), k)
            .map_err(store_err)?;
    }
    let mut bytes: u64 = 0;
    let root = Node {
        id: "root".into(),
        parent: None,
        kind: "root",
        label: if key.schema.is_empty() {
            &key.database
        } else {
            &key.schema
        },
        summary: "",
        tables: "[]".into(),
        tokens: built
            .cards
            .iter()
            .fold(0u32, |sum, c| sum.saturating_add(c.tokens)),
    };
    insert_node(&tx, key, &root)?;
    let mut parent_of: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for a in &built.areas {
        insert_area(&tx, key, a)?;
        bytes += a.summary.len() as u64;
        for t in &a.tables {
            parent_of.insert(t.as_str(), a.id.as_str());
        }
    }
    if !built.saved.is_empty() {
        insert_saved_area(&tx, key, built.saved.len())?;
    }
    for c in &built.cards {
        let node = Node {
            id: format!("t:{}", c.table),
            parent: Some(parent_of.get(c.table.as_str()).copied().unwrap_or("root")),
            kind: "table",
            label: &c.table,
            summary: "",
            tables: "[]".into(),
            tokens: c.tokens,
        };
        insert_node(&tx, key, &node)?;
        tx.execute(
            "INSERT INTO ai_context_card
               (connection_id, database, schema, table_name, card, card_rows, tokens, rows_tokens,
                fk_out, fk_in)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                key.connection_id.to_string(),
                key.database,
                key.schema,
                c.table,
                c.card,
                c.card_rows,
                c.tokens,
                c.rows_tokens,
                json_list(&c.fk_out)?,
                json_list(&c.fk_in)?
            ],
        )
        .map_err(store_err)?;
        bytes += (c.card.len() + c.card_rows.len()) as u64;
    }
    for q in &built.saved {
        insert_node(&tx, key, &Node::saved(q)?)?;
        bytes += q.sql.len() as u64;
    }
    for row in &built.fts {
        insert_fts(&tx, key, row)?;
        bytes += (row.names.len() + row.words.len() + row.note.len()) as u64;
    }
    let meta = ContextMeta {
        fingerprint: fingerprint.map(str::to_string),
        built_at: now_ms,
        checked_at: now_ms,
        stale: false,
        table_count: u32::try_from(built.cards.len()).unwrap_or(u32::MAX),
        bytes,
    };
    tx.execute(
        &format!(
            "INSERT INTO ai_context_meta (connection_id, database, schema, {META_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ),
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            meta.fingerprint,
            meta.built_at,
            meta.checked_at,
            meta.stale,
            meta.table_count,
            i64::try_from(meta.bytes).unwrap_or(i64::MAX)
        ],
    )
    .map_err(store_err)?;
    tx.commit().map_err(store_err)?;
    Ok(meta)
}

pub fn mark_checked(db: &Connection, key: &ContextKey, now_ms: i64) -> Result<()> {
    db.execute(
        &format!("UPDATE ai_context_meta SET checked_at = ?4 WHERE {KEY}"),
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            now_ms
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

pub fn adopt_fingerprint(
    db: &Connection,
    key: &ContextKey,
    fingerprint: &str,
    now_ms: i64,
) -> Result<()> {
    db.execute(
        &format!(
            "UPDATE ai_context_meta SET fingerprint = ?4, checked_at = ?5
             WHERE {KEY} AND fingerprint IS NULL"
        ),
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            fingerprint,
            now_ms
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// Each term is one quoted FTS5 string, so `"`, `*`, `-`, `:`, `(`, `NEAR` and `OR` are
/// words, never syntax. Best first.
pub fn search_context(
    db: &Connection,
    key: &ContextKey,
    terms: &[String],
    limit: usize,
) -> Result<Vec<FtsHit>> {
    if terms.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let query = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut stmt = db
        .prepare(&format!(
            "SELECT node_id, -{BM25} FROM ai_context_fts
             WHERE ai_context_fts MATCH ?4 AND {KEY}
             ORDER BY {BM25}, node_id LIMIT ?5"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![
                key.connection_id.to_string(),
                key.database,
                key.schema,
                query,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |r| {
                Ok(FtsHit {
                    node_id: r.get(0)?,
                    score: r.get(1)?,
                })
            },
        )
        .map_err(store_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(store_err)
}

/// Every table's tokens and Foreign Key neighbours, sorted by table.
pub fn context_graph(db: &Connection, key: &ContextKey) -> Result<Vec<GraphRow>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT table_name, tokens, rows_tokens, fk_out, fk_in FROM ai_context_card WHERE {KEY}
             ORDER BY table_name"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![key.connection_id.to_string(), key.database, key.schema],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, u32>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (table, tokens, rows_tokens, fk_out, fk_in) = row.map_err(store_err)?;
        out.push(GraphRow {
            table,
            tokens,
            rows_tokens,
            fk_out: parse_list(&fk_out)?,
            fk_in: parse_list(&fk_in)?,
        });
    }
    Ok(out)
}

/// The cards of `tables`, in that order; a name with no card is skipped.
pub fn context_cards(
    db: &Connection,
    key: &ContextKey,
    tables: &[String],
) -> Result<Vec<StoredCard>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT card, card_rows, tokens, rows_tokens, fk_out, fk_in FROM ai_context_card
             WHERE {KEY} AND table_name = ?4"
        ))
        .map_err(store_err)?;
    let mut out = Vec::new();
    for table in tables {
        let row = stmt
            .query_row(
                params![
                    key.connection_id.to_string(),
                    key.database,
                    key.schema,
                    table
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u32>(2)?,
                        r.get::<_, u32>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(store_err)?;
        if let Some((card, card_rows, tokens, rows_tokens, fk_out, fk_in)) = row {
            out.push(StoredCard {
                table: table.clone(),
                card,
                card_rows,
                tokens,
                rows_tokens,
                fk_out: parse_list(&fk_out)?,
                fk_in: parse_list(&fk_in)?,
            });
        }
    }
    Ok(out)
}

/// The Context's saved queries, sorted by name.
pub fn context_saved(db: &Connection, key: &ContextKey) -> Result<Vec<StoredSavedQuery>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT node_id, label, summary, tables FROM ai_context_node
             WHERE {KEY} AND kind = 'saved_query' ORDER BY label, node_id"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![key.connection_id.to_string(), key.database, key.schema],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (node_id, name, sql, tables) = row.map_err(store_err)?;
        let id = node_id
            .strip_prefix("q:")
            .unwrap_or(&node_id)
            .parse()
            .map_err(store_err)?;
        out.push(StoredSavedQuery {
            id,
            name,
            sql,
            tables: parse_list(&tables)?,
        });
    }
    Ok(out)
}

/// Inserts or replaces the saved query's node and FTS row in one Context, its name and
/// SQL masked and cleaned by `saved_text` first (masking twice changes nothing).
pub fn put_saved(
    db: &Connection,
    key: &ContextKey,
    dialect: DialectKind,
    q: &StoredSavedQuery,
    clean: &dyn Fn(&str) -> String,
) -> Result<()> {
    let (name, sql) = saved_text(dialect, &q.name, &q.sql, clean);
    let q = &StoredSavedQuery {
        name,
        sql,
        ..q.clone()
    };
    let tx = db.unchecked_transaction().map_err(store_err)?;
    delete_saved_rows(&tx, Some(key), &saved_node(q.id))?;
    insert_node(&tx, key, &Node::saved(q)?)?;
    insert_fts(&tx, key, &saved_fts(q))?;
    upsert_saved_area(&tx, key)?;
    tx.commit().map_err(store_err)
}

/// The Areas of the Context Tree sorted by label; the saved queries node is not one.
pub fn context_areas(db: &Connection, key: &ContextKey) -> Result<Vec<Area>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT node_id, label, summary, tables FROM ai_context_node
             WHERE {KEY} AND kind = 'area' AND node_id <> ?4 ORDER BY label, node_id"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(
            params![
                key.connection_id.to_string(),
                key.database,
                key.schema,
                SAVED_AREA_ID
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(store_err)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Members {
        tables: Vec<String>,
        joins_out: Vec<String>,
    }
    let mut out = Vec::new();
    for row in rows {
        let (id, label, summary, raw) = row.map_err(store_err)?;
        let m: Members = serde_json::from_str(&raw).map_err(store_err)?;
        out.push(Area {
            id,
            label,
            hub: m.tables.first().cloned().unwrap_or_default(),
            tables: m.tables,
            joins_out: m.joins_out,
            summary,
        });
    }
    Ok(out)
}

/// Replaces the Area nodes and the tables' parents in one transaction.
pub fn put_areas(db: &Connection, key: &ContextKey, areas: &[Area]) -> Result<()> {
    let tx = db.unchecked_transaction().map_err(store_err)?;
    tx.execute(
        &format!("DELETE FROM ai_context_node WHERE {KEY} AND kind = 'area' AND node_id <> ?4"),
        params![
            key.connection_id.to_string(),
            key.database,
            key.schema,
            SAVED_AREA_ID
        ],
    )
    .map_err(store_err)?;
    tx.execute(
        &format!("UPDATE ai_context_node SET parent_id = 'root' WHERE {KEY} AND kind = 'table'"),
        params![key.connection_id.to_string(), key.database, key.schema],
    )
    .map_err(store_err)?;
    let mut parent = tx
        .prepare(&format!(
            "UPDATE ai_context_node SET parent_id = ?5 WHERE {KEY} AND node_id = ?4"
        ))
        .map_err(store_err)?;
    for a in areas {
        insert_area(&tx, key, a)?;
        for t in &a.tables {
            parent
                .execute(params![
                    key.connection_id.to_string(),
                    key.database,
                    key.schema,
                    format!("t:{t}"),
                    a.id
                ])
                .map_err(store_err)?;
        }
    }
    drop(parent);
    tx.commit().map_err(store_err)
}

/// `None` removes the saved query from every Context.
pub fn remove_saved(db: &Connection, key: Option<&ContextKey>, id: uuid::Uuid) -> Result<()> {
    let tx = db.unchecked_transaction().map_err(store_err)?;
    let node_id = saved_node(id);
    let touched: Vec<ContextKey> = match key {
        Some(k) => vec![k.clone()],
        None => {
            let mut stmt = tx
                .prepare(
                    "SELECT connection_id, database, schema FROM ai_context_node WHERE node_id = ?1",
                )
                .map_err(store_err)?;
            let rows = stmt
                .query_map(params![node_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?))
                })
                .map_err(store_err)?
                .collect::<rusqlite::Result<Vec<(String, String, String)>>>()
                .map_err(store_err)?;
            let mut keys = Vec::new();
            for (c, database, schema) in rows {
                keys.push(ContextKey {
                    connection_id: c.parse().map_err(store_err)?,
                    database,
                    schema,
                });
            }
            keys
        }
    };
    delete_saved_rows(&tx, key, &node_id)?;
    for k in &touched {
        upsert_saved_area(&tx, k)?;
    }
    tx.commit().map_err(store_err)
}

/// Marks every Context of the Connection stale; returns how many.
pub fn mark_stale(db: &Connection, connection: ConnectionId) -> Result<u32> {
    let n = db
        .execute(
            "UPDATE ai_context_meta SET stale = 1 WHERE connection_id = ?1",
            params![connection.to_string()],
        )
        .map_err(store_err)?;
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

/// `None` clears every Context.
pub fn clear_context(db: &Connection, connection: Option<ConnectionId>) -> Result<()> {
    let tx = db.unchecked_transaction().map_err(store_err)?;
    for table in TABLES {
        match connection {
            Some(c) => tx.execute(
                &format!("DELETE FROM {table} WHERE connection_id = ?1"),
                params![c.to_string()],
            ),
            None => tx.execute(&format!("DELETE FROM {table}"), []),
        }
        .map_err(store_err)?;
    }
    tx.commit().map_err(store_err)
}

/// Every stored Context, or one Connection's, sorted by key.
pub fn context_list(
    db: &Connection,
    connection: Option<ConnectionId>,
) -> Result<Vec<(ContextKey, ContextMeta)>> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT connection_id, database, schema, {META_COLUMNS} FROM ai_context_meta
             WHERE ?1 IS NULL OR connection_id = ?1
             ORDER BY connection_id, database, schema"
        ))
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![connection.map(|c| c.to_string())], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                meta_row(r, 3)?,
            ))
        })
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, database, schema, meta) = row.map_err(store_err)?;
        out.push((
            ContextKey {
                connection_id: id.parse().map_err(store_err)?,
                database,
                schema,
            },
            meta,
        ));
    }
    Ok(out)
}

/// The context functions over an `AppStore` of their own (test fakes use it).
pub struct StoreContext {
    store: Mutex<AppStore>,
    gates: ContextGates,
}

impl StoreContext {
    pub fn new(store: AppStore) -> Self {
        Self {
            store: Mutex::new(store),
            gates: ContextGates::default(),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, AppStore>> {
        self.store
            .lock()
            .map_err(|_| Error::Store("lock poisoned".into()))
    }
}

impl ContextStore for StoreContext {
    fn context_meta(&self, key: &ContextKey) -> Result<Option<ContextMeta>> {
        context_meta(self.lock()?.conn(), key)
    }
    fn replace_context(
        &self,
        key: &ContextKey,
        built: &BuiltContext,
        fingerprint: Option<&str>,
        now_ms: i64,
    ) -> Result<ContextMeta> {
        replace_context(self.lock()?.conn(), key, built, fingerprint, now_ms)
    }
    fn mark_checked(&self, key: &ContextKey, now_ms: i64) -> Result<()> {
        mark_checked(self.lock()?.conn(), key, now_ms)
    }
    fn adopt_fingerprint(&self, key: &ContextKey, fingerprint: &str, now_ms: i64) -> Result<()> {
        adopt_fingerprint(self.lock()?.conn(), key, fingerprint, now_ms)
    }
    fn search_context(
        &self,
        key: &ContextKey,
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<FtsHit>> {
        search_context(self.lock()?.conn(), key, terms, limit)
    }
    fn context_graph(&self, key: &ContextKey) -> Result<Vec<GraphRow>> {
        context_graph(self.lock()?.conn(), key)
    }
    fn context_cards(&self, key: &ContextKey, tables: &[String]) -> Result<Vec<StoredCard>> {
        context_cards(self.lock()?.conn(), key, tables)
    }
    fn context_saved(&self, key: &ContextKey) -> Result<Vec<StoredSavedQuery>> {
        context_saved(self.lock()?.conn(), key)
    }
    fn put_saved(
        &self,
        key: &ContextKey,
        dialect: DialectKind,
        q: &StoredSavedQuery,
        clean: &dyn Fn(&str) -> String,
    ) -> Result<()> {
        put_saved(self.lock()?.conn(), key, dialect, q, clean)
    }
    fn remove_saved(&self, key: Option<&ContextKey>, id: uuid::Uuid) -> Result<()> {
        remove_saved(self.lock()?.conn(), key, id)
    }
    fn context_areas(&self, key: &ContextKey) -> Result<Vec<Area>> {
        context_areas(self.lock()?.conn(), key)
    }
    fn put_areas(&self, key: &ContextKey, areas: &[Area]) -> Result<()> {
        put_areas(self.lock()?.conn(), key, areas)
    }
    fn mark_stale(&self, connection: ConnectionId) -> Result<u32> {
        self.gates.note_mark(connection);
        mark_stale(self.lock()?.conn(), connection)
    }
    fn clear_context(&self, connection: Option<ConnectionId>) -> Result<()> {
        clear_context(self.lock()?.conn(), connection)
    }
    fn context_list(
        &self,
        connection: Option<ConnectionId>,
    ) -> Result<Vec<(ContextKey, ContextMeta)>> {
        context_list(self.lock()?.conn(), connection)
    }
    fn gates(&self) -> &ContextGates {
        &self.gates
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const PG: DialectKind = DialectKind::Postgres;

    fn keep(text: &str) -> String {
        text.to_string()
    }

    fn open_tmp() -> (tempfile::TempDir, StoreContext) {
        let dir = tempfile::tempdir().unwrap();
        let store = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        (dir, StoreContext::new(store))
    }

    fn key(connection_id: Uuid, database: &str) -> ContextKey {
        ContextKey {
            connection_id,
            database: database.into(),
            schema: String::new(),
        }
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn card(table: &str, fk_out: &[&str], fk_in: &[&str]) -> StoredCard {
        StoredCard {
            table: table.into(),
            card: format!("{table}(id int pk)"),
            card_rows: String::new(),
            tokens: 5,
            rows_tokens: 0,
            fk_out: strs(fk_out),
            fk_in: strs(fk_in),
        }
    }

    fn fts(node_id: &str, names: &str, words: &str, note: &str) -> FtsRow {
        FtsRow {
            node_id: node_id.into(),
            names: names.into(),
            words: words.into(),
            note: note.into(),
        }
    }

    fn saved(name: &str, tables: &[&str]) -> StoredSavedQuery {
        StoredSavedQuery {
            id: Uuid::new_v4(),
            name: name.into(),
            sql: "select * from orders where id = ?".into(),
            tables: strs(tables),
        }
    }

    fn built(tables: &[&str]) -> BuiltContext {
        BuiltContext {
            areas: vec![],
            cards: tables.iter().map(|t| card(t, &[], &[])).collect(),
            saved: vec![],
            fts: tables
                .iter()
                .map(|t| fts(&format!("t:{t}"), &format!("{t} id"), "id", ""))
                .collect(),
        }
    }

    fn count(s: &StoreContext, sql: &str) -> i64 {
        s.lock()
            .unwrap()
            .conn()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn replace_writes_everything_in_one_go() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let q = saved("late orders", &["orders"]);
        let b = BuiltContext {
            areas: vec![],
            cards: vec![
                card("orders", &["customers"], &[]),
                card("customers", &[], &["orders"]),
            ],
            saved: vec![q.clone()],
            fts: vec![
                fts(
                    "t:orders",
                    "orders id customer_id",
                    "orders id customer",
                    "",
                ),
                fts(
                    "t:customers",
                    "customers id",
                    "customers id",
                    "people who buy",
                ),
                fts(
                    &format!("q:{}", q.id),
                    "late orders orders",
                    "late orders",
                    "",
                ),
            ],
        };
        let meta = s.replace_context(&k, &b, Some("fp1"), 1_000).unwrap();
        assert_eq!(meta.fingerprint.as_deref(), Some("fp1"));
        assert_eq!((meta.built_at, meta.checked_at), (1_000, 1_000));
        assert!(!meta.stale);
        assert_eq!(meta.table_count, 2);
        assert!(meta.bytes > 0);
        assert_eq!(s.context_meta(&k).unwrap(), Some(meta.clone()));
        assert_eq!(
            s.context_list(None).unwrap(),
            vec![(k.clone(), meta.clone())]
        );

        let cards = s
            .context_cards(&k, &strs(&["orders", "customers"]))
            .unwrap();
        assert_eq!(cards, vec![b.cards[0].clone(), b.cards[1].clone()]);
        assert_eq!(s.context_saved(&k).unwrap(), vec![q]);
        let graph = s.context_graph(&k).unwrap();
        assert_eq!(
            graph,
            vec![
                GraphRow {
                    table: "customers".into(),
                    tokens: 5,
                    rows_tokens: 0,
                    fk_out: vec![],
                    fk_in: strs(&["orders"]),
                },
                GraphRow {
                    table: "orders".into(),
                    tokens: 5,
                    rows_tokens: 0,
                    fk_out: strs(&["customers"]),
                    fk_in: vec![],
                },
            ]
        );
        // Root, two tables, one saved query and the saved queries Area.
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_node"), 5);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'root' AND parent_id IS NULL"
            ),
            1
        );
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_fts"), 3);
        // An unknown key has nothing.
        assert_eq!(s.context_meta(&key(Uuid::new_v4(), "shop")).unwrap(), None);
    }

    #[test]
    fn replace_drops_the_old_rows() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        s.replace_context(&k, &built(&["a", "b", "c"]), None, 1)
            .unwrap();
        let meta = s.replace_context(&k, &built(&["a"]), None, 2).unwrap();
        assert_eq!(meta.table_count, 1);
        assert_eq!(meta.fingerprint, None);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_card"), 1);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_node"), 2);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_fts"), 1);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_meta"), 1);
        assert!(s.context_cards(&k, &strs(&["b", "c"])).unwrap().is_empty());
        assert!(s.search_context(&k, &strs(&["b"]), 10).unwrap().is_empty());
    }

    #[test]
    fn search_ranks_names_over_notes() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let b = BuiltContext {
            areas: vec![],
            cards: vec![card("invoice_lines", &[], &[]), card("ledger", &[], &[])],
            saved: vec![],
            fts: vec![
                fts(
                    "t:ledger",
                    "ledger id",
                    "ledger id",
                    "every invoice ends up here",
                ),
                fts(
                    "t:invoice_lines",
                    "invoice_lines id",
                    "invoice lines id",
                    "",
                ),
            ],
        };
        s.replace_context(&k, &b, None, 1).unwrap();
        // Another Context's rows never show.
        let other = key(Uuid::new_v4(), "shop");
        s.replace_context(&other, &b, None, 1).unwrap();
        let hits = s.search_context(&k, &strs(&["invoice"]), 10).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.node_id.as_str()).collect();
        assert_eq!(ids, vec!["t:invoice_lines", "t:ledger"]);
        assert!(hits[0].score > hits[1].score);
        assert!(s.search_context(&k, &[], 10).unwrap().is_empty());
        assert_eq!(
            s.search_context(&k, &strs(&["invoice"]), 1).unwrap().len(),
            1
        );
    }

    #[test]
    fn fts_terms_with_operators_are_words() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let mut b = built(&["orders"]);
        b.fts[0].note = "NEAR OR col x".into();
        s.replace_context(&k, &b, None, 1).unwrap();
        for term in [
            "\"", "a\"b", "x*", "NEAR", "OR", "-id", "col:x", "(", "AND", "NOT", "",
        ] {
            assert!(s.search_context(&k, &strs(&[term]), 10).is_ok(), "{term}");
        }
        let all = strs(&["\"", "a\"b", "x*", "NEAR", "OR", "-id", "col:x", "("]);
        assert!(s.search_context(&k, &all, 10).is_ok());
        // Operators are words: NEAR and OR match the note.
        assert_eq!(s.search_context(&k, &strs(&["NEAR"]), 10).unwrap().len(), 1);
        assert_eq!(s.search_context(&k, &strs(&["-id"]), 10).unwrap().len(), 1);
    }

    #[test]
    fn case_names_are_two_rows() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let meta = s
            .replace_context(&k, &built(&["Orders", "orders"]), None, 1)
            .unwrap();
        assert_eq!(meta.table_count, 2);
        let cards = s.context_cards(&k, &strs(&["Orders", "orders"])).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].table, "Orders");
        assert_eq!(cards[1].table, "orders");
        assert_eq!(s.context_graph(&k).unwrap().len(), 2);
    }

    #[test]
    fn mark_stale_covers_every_key_of_the_connection() {
        let (_d, s) = open_tmp();
        let (c1, c2) = (Uuid::new_v4(), Uuid::new_v4());
        let (a, b, other) = (key(c1, "one"), key(c1, "two"), key(c2, "one"));
        for k in [&a, &b, &other] {
            s.replace_context(k, &built(&["t"]), None, 1).unwrap();
        }
        assert_eq!(s.mark_stale(c1).unwrap(), 2);
        assert!(s.context_meta(&a).unwrap().unwrap().stale);
        assert!(s.context_meta(&b).unwrap().unwrap().stale);
        assert!(!s.context_meta(&other).unwrap().unwrap().stale);
        assert_eq!(s.context_list(Some(c1)).unwrap().len(), 2);
        // A rebuild clears the mark; a check moves only checked_at.
        s.replace_context(&a, &built(&["t"]), None, 5).unwrap();
        assert!(!s.context_meta(&a).unwrap().unwrap().stale);
        s.mark_checked(&a, 9).unwrap();
        let m = s.context_meta(&a).unwrap().unwrap();
        assert_eq!((m.built_at, m.checked_at), (5, 9));
        assert_eq!(s.mark_stale(Uuid::new_v4()).unwrap(), 0);
    }

    #[test]
    fn clear_one_and_all() {
        let (_d, s) = open_tmp();
        let (c1, c2) = (Uuid::new_v4(), Uuid::new_v4());
        let (a, b) = (key(c1, "one"), key(c2, "one"));
        s.replace_context(&a, &built(&["t", "u"]), None, 1).unwrap();
        s.replace_context(&b, &built(&["t"]), None, 1).unwrap();
        s.put_saved(&b, PG, &saved("q", &["t"]), &keep).unwrap();
        s.clear_context(Some(c1)).unwrap();
        assert_eq!(s.context_meta(&a).unwrap(), None);
        assert!(s.context_graph(&a).unwrap().is_empty());
        assert!(s.context_meta(&b).unwrap().is_some());
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_fts"), 2);
        s.clear_context(None).unwrap();
        for table in [
            "ai_context_meta",
            "ai_context_node",
            "ai_context_card",
            "ai_context_fts",
        ] {
            assert_eq!(
                count(&s, &format!("SELECT COUNT(*) FROM {table}")),
                0,
                "{table}"
            );
        }
    }

    #[test]
    fn put_saved_masks_and_cleans() {
        let (_d, s) = open_tmp();
        let a = key(Uuid::new_v4(), "one");
        s.replace_context(&a, &built(&["orders"]), None, 1).unwrap();
        let token = "sk-abcdefghijklmnopqrstu";
        let mut q = saved(&format!("la\u{200B}te {token}"), &["orders"]);
        q.sql = format!("select * from orders where id = 42 -- {token}");
        s.put_saved(&a, PG, &q, &keep).unwrap();
        let stored = &s.context_saved(&a).unwrap()[0];
        assert_eq!(stored.name, "late [redacted]");
        assert_eq!(
            stored.sql,
            "select * from orders where id = ? -- [redacted]"
        );
        for (table, cols) in [
            ("ai_context_node", "label || summary"),
            ("ai_context_fts", "names || words || note"),
        ] {
            let leaked = count(
                &s,
                &format!(
                    "SELECT COUNT(*) FROM {table} WHERE {cols} LIKE '%abcdefghij%' \
                     OR {cols} LIKE '%42%' OR instr({cols}, char(8203)) > 0"
                ),
            );
            assert_eq!(leaked, 0, "{table}");
        }
    }

    #[test]
    fn put_and_remove_saved() {
        let (_d, s) = open_tmp();
        let c = Uuid::new_v4();
        let (a, b) = (key(c, "one"), key(c, "two"));
        s.replace_context(&a, &built(&["orders"]), None, 1).unwrap();
        s.replace_context(&b, &built(&["orders"]), None, 1).unwrap();
        let mut q = saved("late shipments", &["orders"]);
        s.put_saved(&a, PG, &q, &keep).unwrap();
        s.put_saved(&b, PG, &q, &keep).unwrap();
        assert_eq!(s.context_saved(&a).unwrap(), vec![q.clone()]);
        let hits = s.search_context(&a, &strs(&["shipments"]), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].node_id, format!("q:{}", q.id));

        // A rename replaces the node and its FTS row.
        q.name = "slow parcels".into();
        s.put_saved(&a, PG, &q, &keep).unwrap();
        assert_eq!(s.context_saved(&a).unwrap(), vec![q.clone()]);
        assert!(
            s.search_context(&a, &strs(&["shipments"]), 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            s.search_context(&a, &strs(&["parcels"]), 10).unwrap().len(),
            1
        );

        s.remove_saved(Some(&a), q.id).unwrap();
        assert!(s.context_saved(&a).unwrap().is_empty());
        assert_eq!(s.context_saved(&b).unwrap().len(), 1);
        s.put_saved(&a, PG, &q, &keep).unwrap();
        s.remove_saved(None, q.id).unwrap();
        assert!(s.context_saved(&a).unwrap().is_empty());
        assert!(s.context_saved(&b).unwrap().is_empty());
        assert!(
            s.search_context(&b, &strs(&["late"]), 10)
                .unwrap()
                .is_empty()
        );
        // The tables stay.
        assert_eq!(s.context_graph(&a).unwrap().len(), 1);
    }

    fn area(label: &str, tables: &[&str], joins: &[&str]) -> Area {
        Area {
            id: format!("a:{label}"),
            label: label.into(),
            hub: tables[0].into(),
            tables: strs(tables),
            joins_out: strs(joins),
            summary: format!("{label}: {}.", tables.join(", ")),
        }
    }

    fn with_areas(mut b: BuiltContext, areas: Vec<Area>) -> BuiltContext {
        b.areas = areas;
        b
    }

    fn node(s: &StoreContext, id: &str) -> (Option<String>, String, String, u32) {
        s.lock()
            .unwrap()
            .conn()
            .query_row(
                "SELECT parent_id, kind, summary, tokens FROM ai_context_node WHERE node_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    #[test]
    fn replace_writes_area_nodes_and_parents() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let a = area("orders", &["orders", "customers"], &["regions"]);
        let b = with_areas(built(&["orders", "customers", "tags"]), vec![a.clone()]);
        let plain = s
            .replace_context(&k, &built(&["orders", "customers", "tags"]), None, 1)
            .unwrap();
        let meta = s.replace_context(&k, &b, None, 1).unwrap();
        assert_eq!(meta.bytes, plain.bytes + a.summary.len() as u64);
        let (parent, kind, summary, tokens) = node(&s, "a:orders");
        assert_eq!(parent.as_deref(), Some("root"));
        assert_eq!(kind, "area");
        assert_eq!(summary, a.summary);
        assert_eq!(tokens, estimate_tokens(&a.summary, true));
        assert_eq!(node(&s, "t:orders").0.as_deref(), Some("a:orders"));
        assert_eq!(node(&s, "t:customers").0.as_deref(), Some("a:orders"));
        assert_eq!(node(&s, "t:tags").0.as_deref(), Some("root"));
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_fts WHERE node_id LIKE 'a:%'"
            ),
            0
        );
        assert_eq!(meta.table_count, 3);
    }

    #[test]
    fn context_areas_round_trips() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let zed = area("zed", &["zed", "zed_items"], &[]);
        let ord = area("orders", &["orders", "customers"], &["regions", "tags"]);
        let b = with_areas(
            built(&["orders", "customers", "zed", "zed_items"]),
            vec![zed.clone(), ord.clone()],
        );
        s.replace_context(&k, &b, None, 1).unwrap();
        assert_eq!(s.context_areas(&k).unwrap(), vec![ord, zed]);
        assert!(
            s.context_areas(&key(Uuid::new_v4(), "other"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn put_areas_replaces_only_areas() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let q = saved("late orders", &["orders"]);
        let mut b = with_areas(
            built(&["orders", "customers", "tags"]),
            vec![area("orders", &["orders"], &[])],
        );
        b.saved = vec![q.clone()];
        b.fts.push(saved_fts(&q));
        s.replace_context(&k, &b, None, 1).unwrap();
        let fts_before = count(&s, "SELECT COUNT(*) FROM ai_context_fts");
        let cards_before = s.context_graph(&k).unwrap();
        let meta_before = s.context_meta(&k).unwrap();

        let next = vec![
            area("customers", &["customers", "orders"], &[]),
            area("tags", &["tags"], &[]),
        ];
        s.put_areas(&k, &next).unwrap();
        assert_eq!(s.context_areas(&k).unwrap(), next);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'a:orders'"
            ),
            0
        );
        assert_eq!(node(&s, "t:orders").0.as_deref(), Some("a:customers"));
        assert_eq!(node(&s, "t:tags").0.as_deref(), Some("a:tags"));
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_fts"), fts_before);
        assert_eq!(s.context_graph(&k).unwrap(), cards_before);
        assert_eq!(s.context_meta(&k).unwrap(), meta_before);
        assert_eq!(s.context_saved(&k).unwrap(), vec![q.clone()]);
        assert_eq!(
            node(&s, &format!("q:{}", q.id)).0.as_deref(),
            Some("a:saved")
        );
        assert_eq!(node(&s, "a:saved").1, "area");

        // No Areas puts every table back under the root.
        s.put_areas(&k, &[]).unwrap();
        assert!(s.context_areas(&k).unwrap().is_empty());
        assert_eq!(node(&s, "t:orders").0.as_deref(), Some("root"));
    }

    #[test]
    fn saved_queries_hang_under_their_area() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let (q1, q2) = (saved("a", &["orders"]), saved("b", &["orders"]));
        let mut b = built(&["orders"]);
        b.saved = vec![q1.clone()];
        s.replace_context(&k, &b, None, 1).unwrap();
        let (parent, kind, summary, _) = node(&s, "a:saved");
        assert_eq!((parent.as_deref(), kind.as_str()), (Some("root"), "area"));
        assert_eq!(summary, "1 saved query.");
        assert_eq!(
            s.lock()
                .unwrap()
                .conn()
                .query_row(
                    "SELECT label FROM ai_context_node WHERE node_id = 'a:saved'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "Saved queries"
        );
        assert_eq!(
            node(&s, &format!("q:{}", q1.id)).0.as_deref(),
            Some("a:saved")
        );
        assert!(s.context_areas(&k).unwrap().is_empty());

        // A Context with no saved queries has no node; put_saved makes it.
        let k2 = key(Uuid::new_v4(), "older");
        s.replace_context(&k2, &built(&["orders"]), None, 1)
            .unwrap();
        let rows = "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'a:saved'";
        assert_eq!(count(&s, rows), 1);
        s.put_saved(&k2, PG, &q2, &keep).unwrap();
        assert_eq!(count(&s, rows), 2);
        assert_eq!(
            node(&s, &format!("q:{}", q2.id)).0.as_deref(),
            Some("a:saved")
        );
        assert!(s.context_areas(&k2).unwrap().is_empty());
    }

    #[test]
    fn remove_saved_recounts_the_saved_area() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let (q1, q2) = (saved("a", &["orders"]), saved("b", &["orders"]));
        s.replace_context(&k, &built(&["orders"]), None, 1).unwrap();
        s.put_saved(&k, PG, &q1, &keep).unwrap();
        s.put_saved(&k, PG, &q2, &keep).unwrap();
        assert_eq!(node(&s, "a:saved").2, "2 saved queries.");
        s.remove_saved(Some(&k), q1.id).unwrap();
        assert_eq!(node(&s, "a:saved").2, "1 saved query.");
        s.remove_saved(Some(&k), q2.id).unwrap();
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'a:saved'"
            ),
            0
        );
    }

    #[test]
    fn remove_saved_everywhere_recounts_each_context() {
        let (_d, s) = open_tmp();
        let (k1, k2) = (key(Uuid::new_v4(), "one"), key(Uuid::new_v4(), "two"));
        let (shared, other) = (saved("a", &["orders"]), saved("b", &["orders"]));
        for k in [&k1, &k2] {
            s.replace_context(k, &built(&["orders"]), None, 1).unwrap();
            s.put_saved(k, PG, &shared, &keep).unwrap();
        }
        s.put_saved(&k2, PG, &other, &keep).unwrap();
        s.remove_saved(None, shared.id).unwrap();
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'a:saved'"
            ),
            1
        );
        assert_eq!(node(&s, "a:saved").2, "1 saved query.");
    }

    #[test]
    fn areas_without_saved_queries_write_no_saved_node() {
        let (_d, s) = open_tmp();
        let k = key(Uuid::new_v4(), "shop");
        let b = with_areas(built(&["orders"]), vec![area("orders", &["orders"], &[])]);
        s.replace_context(&k, &b, None, 1).unwrap();
        assert_eq!(s.context_areas(&k).unwrap().len(), 1);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM ai_context_node WHERE node_id = 'a:saved'"
            ),
            0
        );
    }

    #[test]
    fn clear_removes_areas() {
        let (_d, s) = open_tmp();
        let c = Uuid::new_v4();
        let k = key(c, "shop");
        let b = with_areas(built(&["orders"]), vec![area("orders", &["orders"], &[])]);
        s.replace_context(&k, &b, None, 1).unwrap();
        s.put_saved(&k, PG, &saved("x", &["orders"]), &keep)
            .unwrap();
        s.clear_context(Some(c)).unwrap();
        assert!(s.context_areas(&k).unwrap().is_empty());
        assert_eq!(count(&s, "SELECT COUNT(*) FROM ai_context_node"), 0);
    }
}
