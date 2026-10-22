//! When an AI Context is checked against the catalog and rebuilt: the preview never
//! checks, an Ask on a Connection set to Automatically checks at most once a minute, and
//! Manual never queries until Re-sync. A failed check or rebuild keeps
//! the last Context.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::ai::AiAccess;
use crate::ai::context::build::build_context;
use crate::ai::context::cards::cleaner;
use crate::ai::context::store::{ContextKey, ContextMeta, ContextStore};
use crate::ai::log::{Level, Log, ProcessStep, StepKind, error_kind};
use crate::ai::preview::{CatalogReader, count_of, long_secrets};
use crate::ai::rails::Secrets;
use crate::ai::request::TableRef;
use crate::error::{Error, Result};
use crate::model::{AiSyncMode, ConnectionConfig, ConnectionId, DialectKind};

/// An Ask checks the fingerprint at most this often per Context; after a failed check
/// or build, nothing is queried for as long.
pub const CHECK_EVERY_MS: i64 = 60_000;

/// A Context the preview built has no fingerprint. The first Ask check takes the one it
/// reads as that Context's when it was built at most this long ago, rather than build
/// the same schema again; an older one is rebuilt.
pub const ADOPT_WITHIN_MS: i64 = 10 * 60_000;

/// Whether `then` is less than `CHECK_EVERY_MS` before `now`; a time in the future (the
/// clock moved back) is not.
fn within_a_minute(now_ms: i64, then: i64) -> bool {
    (0..CHECK_EVERY_MS).contains(&(now_ms - then))
}

/// What `ensure` keeps in memory per Context: one check or build at a time, so two Asks
/// at once read the fingerprint once, and when the last check or build failed. Also how
/// many stale marks each Connection has had, so a build that overlaps one keeps it.
#[derive(Default)]
pub struct ContextGates {
    keys: Mutex<HashMap<ContextKey, Arc<tokio::sync::Mutex<Gate>>>>,
    marks: Mutex<HashMap<ConnectionId, u64>>,
}

#[derive(Default)]
struct Gate {
    failed_at: Option<i64>,
    /// When a build the preview ran failed: after a failed Ask the preview may still
    /// build once, then it backs off too.
    preview_failed_at: Option<i64>,
}

impl Gate {
    fn clear(&mut self) {
        self.failed_at = None;
        self.preview_failed_at = None;
    }
}

impl ContextGates {
    fn gate(&self, key: &ContextKey) -> Arc<tokio::sync::Mutex<Gate>> {
        let mut map = self.keys.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key.clone()).or_default().clone()
    }

    /// Counts a stale mark of `connection`. A store calls it before it writes the mark,
    /// so a build that reads the count after its own write never misses one.
    pub fn note_mark(&self, connection: ConnectionId) {
        let mut map = self.marks.lock().unwrap_or_else(|e| e.into_inner());
        *map.entry(connection).or_default() += 1;
    }

    fn marks(&self, connection: ConnectionId) -> u64 {
        let map = self.marks.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&connection).copied().unwrap_or(0)
    }
}

/// What `ensure` runs for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Purpose {
    Preview,
    Ask,
    Resync,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RebuildReason {
    First,
    Changed,
    Stale,
    Asked,
}

/// What `ensure` did about the schema; the Steps Schema row says it in fixed wording.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchemaCheck {
    /// The fingerprint was read and equals the stored one.
    Match,
    /// Checked less than `CHECK_EVERY_MS` ago, so no query ran.
    Recent,
    Rebuilt {
        reason: RebuildReason,
    },
    /// Marked stale and not rebuilt (the preview, or Manual).
    Stale,
    /// Not checked (the preview, or Manual).
    Unchecked,
    /// The check or the rebuild failed; the last Context is kept and used.
    Failed,
    /// There is no Context and none could be built.
    Missing,
}

/// The Context an Ask or Re-sync ended with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub connection_id: ConnectionId,
    pub database: String,
    pub schema: String,
    pub sync: AiSyncMode,
    /// `None` when there is no Context.
    pub built_at: Option<i64>,
    pub table_count: u32,
    pub stale: bool,
    pub check: SchemaCheck,
}

/// One stored Context, for the AI access table and the Connection form.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextStatusRow {
    pub connection_id: ConnectionId,
    pub database: String,
    pub schema: String,
    pub built_at: i64,
    pub checked_at: i64,
    pub stale: bool,
    pub table_count: u32,
    pub bytes: u64,
}

/// The Context an Ask on `config` uses: the request's database, else the Connection's,
/// else the Dialect's default. The schema is the request's, else on PostgreSQL the one
/// schema every focus table names (all of them, at least one), else `public`; `""` on the
/// other Dialects.
pub fn context_key(
    config: &ConnectionConfig,
    database: Option<&str>,
    schema: Option<&str>,
    focus: &[TableRef],
) -> ContextKey {
    let database = database
        .map(str::to_string)
        .or_else(|| config.database.clone())
        .unwrap_or_else(|| {
            match config.dialect {
                DialectKind::Sqlite => "main",
                DialectKind::Postgres => "postgres",
                DialectKind::MySql => "",
            }
            .into()
        });
    let schema = match (schema, config.dialect) {
        (Some(s), _) => s.to_string(),
        (None, DialectKind::Postgres) => shared_schema(focus).unwrap_or("public").to_string(),
        (None, _) => String::new(),
    };
    ContextKey {
        connection_id: config.id,
        database,
        schema,
    }
}

/// The schema every table of `focus` names, when they all name the same one.
fn shared_schema(focus: &[TableRef]) -> Option<&str> {
    let first = focus.first()?.schema.as_deref()?;
    focus
        .iter()
        .all(|t| t.schema.as_deref() == Some(first))
        .then_some(first)
}

/// `ms` as whole minutes, hours or days; under a minute it is `None`.
fn age_parts(ms: i64) -> Option<(i64, &'static str)> {
    let minutes = ms.max(0) / 60_000;
    match minutes {
        0 => None,
        1..=59 => Some((minutes, "m")),
        60..=1_439 => Some((minutes / 60, "h")),
        _ => Some((minutes / 1_440, "d")),
    }
}

/// An age as the UI's `agoText` writes it: `just now`, `12m ago`, `2h ago`, `3d ago`.
pub fn ago_text(ms: i64) -> String {
    match age_parts(ms) {
        None => "just now".into(),
        Some((n, unit)) => format!("{n}{unit} ago"),
    }
}

/// An age for a log field, without "ago": `38s`, `3m`, `2h`, `3d`.
fn age_field(ms: i64) -> String {
    match age_parts(ms) {
        None => format!("{}s", ms.max(0) / 1_000),
        Some((n, unit)) => format!("{n}{unit}"),
    }
}

const RULE_MATCH: &str =
    "The catalog fingerprint equals the one stored with the AI Context, so no re-sync ran.";
const RULE_RECENT: &str = "The schema was checked less than a minute ago, so no query ran.";
const RULE_FIRST: &str =
    "First Ask on this database: the AI Context was built from the catalog. No rows are read.";
const RULE_CHANGED: &str =
    "The catalog fingerprint changed, so the AI Context was rebuilt. No rows are read.";
const RULE_STALE_REBUILT: &str =
    "Contura changed the schema here, so the AI Context was rebuilt. No rows are read.";
const RULE_ASKED: &str = "Re-sync rebuilt the AI Context. No rows are read.";
const RULE_STALE: &str = "The schema changed since the last sync. The context from then was used.";
const RULE_MANUAL: &str = "Sync is set to Manual, so the schema was not checked.";
const RULE_PREVIEW: &str = "The preview never checks the schema.";
const RULE_MISSING: &str = "The schema could not be read, so no tables are sent.";
const RULE_UNREADABLE: &str = "The AI Context could not be read, so no tables are sent.";

/// The Steps Schema row's value and rule. Ages are from `ago_text`: `built_at` for
/// "synced", `checked_at` for a Recent check.
pub fn schema_wording(
    check: SchemaCheck,
    purpose: Purpose,
    built_at: Option<i64>,
    checked_at: Option<i64>,
    tables: u32,
    now_ms: i64,
) -> (String, String) {
    let synced = ago_text(now_ms - built_at.unwrap_or(now_ms));
    let pair = |value: String, rule: &str| (value, rule.to_string());
    match check {
        SchemaCheck::Match => pair(format!("match, synced {synced}"), RULE_MATCH),
        SchemaCheck::Recent => {
            let checked = ago_text(now_ms - checked_at.unwrap_or(now_ms));
            pair(format!("checked {checked}, synced {synced}"), RULE_RECENT)
        }
        SchemaCheck::Rebuilt { reason } => {
            let rule = match reason {
                RebuildReason::First => RULE_FIRST,
                RebuildReason::Changed => RULE_CHANGED,
                RebuildReason::Stale => RULE_STALE_REBUILT,
                RebuildReason::Asked => RULE_ASKED,
            };
            let tables = count_of(tables as usize, "table", "tables");
            pair(format!("re-synced, {tables}"), rule)
        }
        SchemaCheck::Stale => pair(format!("stale, synced {synced}"), RULE_STALE),
        SchemaCheck::Unchecked => {
            let rule = if purpose == Purpose::Preview {
                RULE_PREVIEW
            } else {
                RULE_MANUAL
            };
            pair(format!("not checked, synced {synced}"), rule)
        }
        SchemaCheck::Failed if built_at.is_none() => {
            pair("could not check".into(), RULE_UNREADABLE)
        }
        SchemaCheck::Failed => (
            format!("could not check, synced {synced}"),
            format!("Could not check the schema. The context from {synced} was used."),
        ),
        SchemaCheck::Missing => pair("could not read".into(), RULE_MISSING),
    }
}

/// What the fingerprint check found, for the log's `fingerprint` field.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    Skipped,
    /// Read by a build, with nothing to compare it with.
    Read,
    Match,
    Changed,
    Failed,
}

impl Check {
    fn word(self) -> &'static str {
        match self {
            Check::Skipped => "skipped",
            Check::Read => "read",
            Check::Match => "match",
            Check::Changed => "changed",
            Check::Failed => "failed",
        }
    }
}

/// Why a build wrote nothing.
enum BuildFail {
    Error(Error),
    /// The Connection went to AI access Never, or was deleted, while it built.
    Gone,
}

impl From<Error> for BuildFail {
    fn from(e: Error) -> Self {
        BuildFail::Error(e)
    }
}

fn schema_arg(key: &ContextKey) -> Option<&str> {
    Some(key.schema.as_str()).filter(|s| !s.is_empty())
}

/// Builds the Context from the catalog and writes it, unless the Connection may no longer
/// have one. `fingerprint` is one already read for this Ask; with Automatically and none,
/// it is read first (`check` says so), except for the preview, which never runs a
/// fingerprint query: its Context is stored with none and the next Ask checks it. Manual
/// stores none.
#[allow(clippy::too_many_arguments)]
async fn build(
    catalog: &dyn CatalogReader,
    config: &ConnectionConfig,
    key: &ContextKey,
    purpose: Purpose,
    fingerprint: Option<String>,
    check: &mut Check,
    clean: &(dyn Fn(&str) -> String + Sync),
    now_ms: i64,
) -> std::result::Result<ContextMeta, BuildFail> {
    let schema = schema_arg(key);
    let store = catalog.context();
    let marks = store.gates().marks(config.id);
    let fingerprint = match (config.ai_sync, fingerprint) {
        (AiSyncMode::Manual, _) => None,
        (AiSyncMode::Automatic, Some(f)) => Some(f),
        (AiSyncMode::Automatic, None) if purpose == Purpose::Preview => None,
        (AiSyncMode::Automatic, None) => {
            match catalog
                .schema_fingerprint(config.id, &key.database, schema)
                .await
            {
                Ok(f) => {
                    *check = Check::Read;
                    Some(f)
                }
                Err(e) => {
                    *check = Check::Failed;
                    return Err(e.into());
                }
            }
        }
    };
    let built = {
        let model = catalog
            .schema_snapshot(config.id, &key.database, schema)
            .await?;
        let saved = catalog.saved_queries().await?;
        build_context(&model, config.dialect, key.qualifier(), &saved, clean)
    };
    // Access may have dropped to Never while the catalog was read (Review Focus 2).
    let current = catalog.connection_config(config.id).await?;
    if !current.is_some_and(|c| c.ai_access != AiAccess::Never) {
        return Err(BuildFail::Gone);
    }
    let mut meta = store
        .replace_if_allowed(key, &built, fingerprint.as_deref(), now_ms, config)?
        .ok_or(BuildFail::Gone)?;
    // A schema change Contura made while this built may be missing from what it read:
    // the write must not drop its stale mark.
    if store.gates().marks(config.id) != marks {
        store.mark_stale(config.id)?;
        meta.stale = true;
    }
    Ok(meta)
}

/// Checks and, when needed, rebuilds the Context of `key` for `purpose`, writing the log's
/// `schema` lines and returning the Context it ended with and the Steps Schema row. The
/// preview never runs a fingerprint query; an Ask on Automatically runs one at most once
/// per `CHECK_EVERY_MS`; Manual never queries except to build a
/// missing Context or on Re-sync. A failure keeps the last Context, and for a minute after
/// it nothing is queried for that Context except on Re-sync. One check or build runs per
/// Context at a time. Never called at AI access Never: such a Connection gets `Missing`
/// with no call at all.
pub async fn ensure(
    catalog: &dyn CatalogReader,
    config: &ConnectionConfig,
    key: &ContextKey,
    purpose: Purpose,
    clean: &(dyn Fn(&str) -> String + Sync),
    now_ms: i64,
    log: &mut Log,
) -> (ContextInfo, ProcessStep) {
    if config.ai_access == AiAccess::Never {
        return finish(
            config,
            key,
            purpose,
            None,
            SchemaCheck::Missing,
            now_ms,
            log,
        );
    }
    let store = catalog.context();
    // One check or build per Context at a time: a second Ask waits, then finds the first
    // one's check (Recent) or its fresh Context.
    let gate = store.gates().gate(key);
    let mut gate = gate.lock().await;
    let mut meta = match store.context_meta(key) {
        Ok(meta) => meta,
        Err(e) => {
            // Not "no Context": nothing is queried or built over a store that cannot be read.
            push_line(log, Check::Skipped, None, now_ms, &[]);
            log.push(Level::Warn, "schema", &[("error", error_kind(&e))]);
            return finish(config, key, purpose, None, SchemaCheck::Failed, now_ms, log);
        }
    };
    // After a failed check or build an Ask queries nothing for a minute; the preview may
    // still build once, until a build of its own fails. Re-sync always runs.
    let recent = |at: Option<i64>| at.is_some_and(|at| within_a_minute(now_ms, at));
    let backing_off = match purpose {
        Purpose::Resync => false,
        Purpose::Ask => recent(gate.failed_at),
        Purpose::Preview => recent(gate.preview_failed_at),
    };

    let mut fingerprint = Check::Skipped;
    let mut rebuild: Option<(RebuildReason, Option<String>)> = None;
    let mut check = SchemaCheck::Missing;
    match &meta {
        None if backing_off => {}
        // Re-sync says so even when there was nothing to re-sync: the user asked.
        None if purpose == Purpose::Resync => rebuild = Some((RebuildReason::Asked, None)),
        None => rebuild = Some((RebuildReason::First, None)),
        Some(_) if purpose == Purpose::Resync => rebuild = Some((RebuildReason::Asked, None)),
        Some(m) if purpose == Purpose::Preview || config.ai_sync == AiSyncMode::Manual => {
            check = if m.stale {
                SchemaCheck::Stale
            } else {
                SchemaCheck::Unchecked
            };
        }
        Some(_) if backing_off => check = SchemaCheck::Failed,
        Some(m) if m.stale => rebuild = Some((RebuildReason::Stale, None)),
        Some(m) if within_a_minute(now_ms, m.checked_at) => check = SchemaCheck::Recent,
        Some(m) => {
            match catalog
                .schema_fingerprint(config.id, &key.database, schema_arg(key))
                .await
            {
                Ok(f) if m.fingerprint.as_deref() == Some(f.as_str()) => {
                    fingerprint = Check::Match;
                    check = SchemaCheck::Match;
                    gate.clear();
                    if store.mark_checked(key, now_ms).is_ok()
                        && let Some(m) = meta.as_mut()
                    {
                        m.checked_at = now_ms;
                    }
                }
                Ok(f)
                    if m.fingerprint.is_none()
                        && (0..ADOPT_WITHIN_MS).contains(&(now_ms - m.built_at)) =>
                {
                    fingerprint = Check::Read;
                    check = SchemaCheck::Match;
                    gate.clear();
                    if store.adopt_fingerprint(key, &f, now_ms).is_ok()
                        && let Some(m) = meta.as_mut()
                    {
                        m.fingerprint = Some(f);
                        m.checked_at = now_ms;
                    }
                }
                // Built by the preview too long ago to take the fingerprint as its own.
                Ok(f) if m.fingerprint.is_none() => {
                    fingerprint = Check::Read;
                    rebuild = Some((RebuildReason::First, Some(f)));
                }
                Ok(f) => {
                    fingerprint = Check::Changed;
                    rebuild = Some((RebuildReason::Changed, Some(f)));
                }
                Err(e) => {
                    gate.failed_at = Some(now_ms);
                    push_line(log, Check::Failed, meta.as_ref(), now_ms, &[]);
                    log.push(Level::Warn, "schema", &[("error", error_kind(&e))]);
                    return finish(
                        config,
                        key,
                        purpose,
                        meta.as_ref(),
                        SchemaCheck::Failed,
                        now_ms,
                        log,
                    );
                }
            }
        }
    }

    if let Some((reason, known)) = rebuild {
        let started = Instant::now();
        match build(
            catalog,
            config,
            key,
            purpose,
            known,
            &mut fingerprint,
            clean,
            now_ms,
        )
        .await
        {
            Ok(built) => {
                gate.clear();
                let extra = [
                    ("rebuilt", reason_word(reason).to_string()),
                    ("tables", built.table_count.to_string()),
                    ("ms", started.elapsed().as_millis().to_string()),
                    ("bytes", built.bytes.to_string()),
                ];
                meta = Some(built);
                check = SchemaCheck::Rebuilt { reason };
                push_line(log, fingerprint, meta.as_ref(), now_ms, &extra);
            }
            Err(fail) => {
                // A Context cleared at Never during the build is gone: read it again.
                meta = store.context_meta(key).ok().flatten();
                check = if meta.is_some() {
                    SchemaCheck::Failed
                } else {
                    SchemaCheck::Missing
                };
                push_line(log, fingerprint, meta.as_ref(), now_ms, &[]);
                let kind = match &fail {
                    BuildFail::Error(e) => {
                        gate.failed_at = Some(now_ms);
                        if purpose == Purpose::Preview {
                            gate.preview_failed_at = Some(now_ms);
                        }
                        error_kind(e)
                    }
                    BuildFail::Gone => "never".into(),
                };
                log.push(Level::Warn, "schema", &[("error", kind)]);
            }
        }
    } else {
        push_line(log, fingerprint, meta.as_ref(), now_ms, &[]);
    }
    finish(config, key, purpose, meta.as_ref(), check, now_ms, log)
}

fn reason_word(reason: RebuildReason) -> &'static str {
    match reason {
        RebuildReason::First => "first",
        RebuildReason::Changed => "changed",
        RebuildReason::Stale => "stale",
        RebuildReason::Asked => "asked",
    }
}

/// The `schema` line: `fingerprint=… synced=…`, then a build's fields.
fn push_line(
    log: &mut Log,
    fingerprint: Check,
    meta: Option<&ContextMeta>,
    now_ms: i64,
    extra: &[(&str, String)],
) {
    let synced = meta.map_or_else(|| "never".into(), |m| age_field(now_ms - m.built_at));
    let mut fields = vec![
        ("fingerprint", fingerprint.word().to_string()),
        ("synced", synced),
    ];
    fields.extend(extra.iter().cloned());
    log.push(Level::Info, "schema", &fields);
}

fn finish(
    config: &ConnectionConfig,
    key: &ContextKey,
    purpose: Purpose,
    meta: Option<&ContextMeta>,
    check: SchemaCheck,
    now_ms: i64,
    log: &Log,
) -> (ContextInfo, ProcessStep) {
    let info = ContextInfo {
        connection_id: key.connection_id,
        database: key.database.clone(),
        schema: key.schema.clone(),
        sync: config.ai_sync,
        built_at: meta.map(|m| m.built_at),
        table_count: meta.map_or(0, |m| m.table_count),
        stale: meta.is_some_and(|m| m.stale),
        check,
    };
    let (value, rule) = schema_wording(
        check,
        purpose,
        info.built_at,
        meta.map(|m| m.checked_at),
        info.table_count,
        now_ms,
    );
    let step = ProcessStep {
        step: StepKind::Schema,
        at_ms: log.elapsed_ms(),
        value,
        rule,
        evidence: Vec::new(),
        by_model: false,
        left_out: None,
    };
    (info, step)
}

/// Re-sync: rebuilds the Context of one database and schema of the stored Connection,
/// cleaning with `secrets` as the preview does. Refused at AI access Never.
pub async fn resync(
    catalog: &dyn CatalogReader,
    id: ConnectionId,
    database: Option<&str>,
    schema: Option<&str>,
    secrets: &Secrets,
    now_ms: i64,
) -> Result<ContextInfo> {
    let config = catalog
        .connection_config(id)
        .await?
        .ok_or_else(|| Error::NotFound("connection not found".into()))?;
    if config.ai_access == AiAccess::Never {
        return Err(Error::InvalidInput(
            "AI access is Never for this Connection.".into(),
        ));
    }
    let key = context_key(&config, database, schema, &[]);
    let secrets = long_secrets(secrets);
    let clean = cleaner(&secrets);
    let (info, _) = ensure(
        catalog,
        &config,
        &key,
        Purpose::Resync,
        &clean,
        now_ms,
        &mut Log::new(),
    )
    .await;
    Ok(info)
}

/// Every stored Context, or one Connection's.
pub fn context_status(
    store: &dyn ContextStore,
    connection: Option<ConnectionId>,
) -> Result<Vec<ContextStatusRow>> {
    Ok(store
        .context_list(connection)?
        .into_iter()
        .map(|(k, m)| ContextStatusRow {
            connection_id: k.connection_id,
            database: k.database,
            schema: k.schema,
            built_at: m.built_at,
            checked_at: m.checked_at,
            stale: m.stale,
            table_count: m.table_count,
            bytes: m.bytes,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DialectKind, SslMode};

    fn config(dialect: DialectKind, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::from_u128(7),
            name: "c".into(),
            dialect,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: database.map(str::to_string),
            ssl: SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }
    }

    #[test]
    fn ago_text_cases() {
        assert_eq!(ago_text(0), "just now");
        assert_eq!(ago_text(59_999), "just now");
        assert_eq!(ago_text(60_000), "1m ago");
        assert_eq!(ago_text(7_200_000), "2h ago");
        assert_eq!(ago_text(172_800_000), "2d ago");
        assert_eq!(ago_text(-5), "just now");
    }

    #[test]
    fn context_key_cases() {
        let pg = config(DialectKind::Postgres, Some("shop"));
        let k = context_key(&pg, None, None, &[]);
        assert_eq!((k.database.as_str(), k.schema.as_str()), ("shop", "public"));
        let k = context_key(&pg, Some("crm"), Some("sales"), &[]);
        assert_eq!((k.database.as_str(), k.schema.as_str()), ("crm", "sales"));
        assert_eq!(k.connection_id, pg.id);
        let k = context_key(&config(DialectKind::Postgres, None), None, None, &[]);
        assert_eq!(
            (k.database.as_str(), k.schema.as_str()),
            ("postgres", "public")
        );
        let k = context_key(&config(DialectKind::Sqlite, None), None, None, &[]);
        assert_eq!((k.database.as_str(), k.schema.as_str()), ("main", ""));
        let k = context_key(&config(DialectKind::MySql, None), Some("shop"), None, &[]);
        assert_eq!((k.database.as_str(), k.schema.as_str()), ("shop", ""));
        let k = context_key(&config(DialectKind::MySql, None), None, None, &[]);
        assert_eq!((k.database.as_str(), k.schema.as_str()), ("", ""));
    }

    #[test]
    fn context_key_schema_from_focus() {
        use crate::ai::request::TableRef;
        let t = |schema: Option<&str>, name: &str| TableRef {
            schema: schema.map(str::to_string),
            name: name.into(),
        };
        let pg = config(DialectKind::Postgres, Some("shop"));
        let billing = [
            t(Some("billing"), "invoices"),
            t(Some("billing"), "customers"),
        ];
        assert_eq!(context_key(&pg, None, None, &billing).schema, "billing");
        let mixed = [t(Some("billing"), "invoices"), t(Some("crm"), "customers")];
        assert_eq!(context_key(&pg, None, None, &mixed).schema, "public");
        let partly = [t(Some("billing"), "invoices"), t(None, "customers")];
        assert_eq!(context_key(&pg, None, None, &partly).schema, "public");
        assert_eq!(context_key(&pg, None, None, &[]).schema, "public");
        // The request's schema wins.
        assert_eq!(
            context_key(&pg, None, Some("sales"), &billing).schema,
            "sales"
        );
        // MySQL and SQLite are unchanged.
        let my = config(DialectKind::MySql, None);
        assert_eq!(context_key(&my, Some("shop"), None, &billing).schema, "");
        let lite = config(DialectKind::Sqlite, None);
        assert_eq!(context_key(&lite, None, None, &billing).schema, "");
    }

    #[test]
    fn info_serializes_camel_case_with_kind() {
        let info = ContextInfo {
            connection_id: uuid::Uuid::from_u128(7),
            database: "shop".into(),
            schema: "public".into(),
            sync: AiSyncMode::Automatic,
            built_at: Some(5),
            table_count: 2,
            stale: false,
            check: SchemaCheck::Rebuilt {
                reason: RebuildReason::First,
            },
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "connectionId": "00000000-0000-0000-0000-000000000007",
                "database": "shop", "schema": "public", "sync": "automatic",
                "builtAt": 5, "tableCount": 2, "stale": false,
                "check": { "kind": "rebuilt", "reason": "first" }
            })
        );
        assert_eq!(
            serde_json::to_value(SchemaCheck::Failed).unwrap(),
            serde_json::json!({ "kind": "failed" })
        );
    }
}
