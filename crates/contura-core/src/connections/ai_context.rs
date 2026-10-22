//! The AI Context over the Connection service's store connection, where every sync
//! trigger runs. Each call holds the store lock for that call only.

use super::{ConnectionService, same_target};
use crate::ai::AiAccess;
use crate::ai::context::build::query_tables;
use crate::ai::context::cards::cleaner;
use crate::ai::context::store::{
    self as ctx, BuiltContext, ContextKey, ContextMeta, ContextStore, FtsHit, GraphRow, StoredCard,
    StoredSavedQuery,
};
use crate::ai::context::tree::Area;
use crate::ai::rails::Secrets;
use crate::ai::redaction_secrets;
use crate::error::{Error, Result};
use crate::model::{AiSyncMode, ConnectionConfig, ConnectionId, DialectKind};
use crate::query::SavedQuery;

/// Shorter saved secrets are not matched: they would redact ordinary words.
const MIN_SECRET_CHARS: usize = 4;

impl ConnectionService {
    /// Rewrites only the Connection's sync mode; sessions are left alone.
    pub fn set_ai_sync_mode(&self, id: ConnectionId, mode: AiSyncMode) -> Result<ConnectionConfig> {
        let store = self.store()?;
        let mut config = store
            .list_connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound("connection not found".into()))?;
        config.ai_sync = mode;
        store.save_connection(&config)?;
        Ok(config)
    }

    /// Marks every Context of the Connection stale (plan ruling 8): a schema change can
    /// name any database or schema. No database call.
    pub fn mark_ai_context_stale(&self, id: ConnectionId) -> Result<()> {
        self.mark_stale(id).map(|_| ())
    }

    /// Deletes one Connection's Contexts, or every Context with `None`.
    pub fn clear_ai_context(&self, id: Option<ConnectionId>) -> Result<()> {
        self.clear_context(id)
    }

    /// The Secrets cleaner's input: every saved provider key and Connection password
    /// long enough to match exactly.
    fn context_secrets(&self) -> Result<Secrets> {
        let all = redaction_secrets(&*self.secrets, &self.list()?)?;
        let long = |list: Vec<String>| -> Vec<String> {
            list.into_iter()
                .filter(|s| s.chars().count() >= MIN_SECRET_CHARS)
                .collect()
        };
        Ok(Secrets {
            keys: long(all.keys),
            passwords: long(all.passwords),
        })
    }

    /// Puts `q` into every stored Context it belongs to and takes it out of the rest,
    /// from the stored tables alone: no database call, in both sync modes.
    pub(super) fn keep_saved_in_context(&self, q: &SavedQuery) -> Result<()> {
        let contexts = self.context_list(None)?;
        if contexts.is_empty() {
            return Ok(());
        }
        let configs = self.list()?;
        let secrets = self.context_secrets()?;
        let clean = cleaner(&secrets);
        for (key, _) in contexts {
            let Some(config) = configs.iter().find(|c| c.id == key.connection_id) else {
                self.remove_saved(Some(&key), q.id)?;
                continue;
            };
            let graph = self.context_graph(&key)?;
            let names: Vec<&str> = graph.iter().map(|g| g.table.as_str()).collect();
            match query_tables(&names, config.dialect, key.qualifier(), &q.sql) {
                Some(tables) => {
                    let stored = StoredSavedQuery {
                        id: q.id,
                        name: q.name.clone(),
                        sql: q.sql.clone(),
                        tables,
                    };
                    self.put_saved(&key, config.dialect, &stored, &clean)?;
                }
                None => self.remove_saved(Some(&key), q.id)?,
            }
        }
        Ok(())
    }
}

impl ContextStore for ConnectionService {
    fn context_meta(&self, key: &ContextKey) -> Result<Option<ContextMeta>> {
        ctx::context_meta(self.store()?.conn(), key)
    }
    fn replace_context(
        &self,
        key: &ContextKey,
        built: &BuiltContext,
        fingerprint: Option<&str>,
        now_ms: i64,
    ) -> Result<ContextMeta> {
        ctx::replace_context(self.store()?.conn(), key, built, fingerprint, now_ms)
    }
    /// The stored config is read under the same store lock as the write, and every clear
    /// takes that lock too, so a Context cleared at Never, delete or a re-point is not
    /// written back.
    fn replace_if_allowed(
        &self,
        key: &ContextKey,
        built: &BuiltContext,
        fingerprint: Option<&str>,
        now_ms: i64,
        from: &ConnectionConfig,
    ) -> Result<Option<ContextMeta>> {
        let store = self.store()?;
        let allowed = store.list_connections()?.iter().any(|c| {
            c.id == key.connection_id && c.ai_access != AiAccess::Never && same_target(c, from)
        });
        if !allowed {
            return Ok(None);
        }
        ctx::replace_context(store.conn(), key, built, fingerprint, now_ms).map(Some)
    }
    fn mark_checked(&self, key: &ContextKey, now_ms: i64) -> Result<()> {
        ctx::mark_checked(self.store()?.conn(), key, now_ms)
    }
    fn adopt_fingerprint(&self, key: &ContextKey, fingerprint: &str, now_ms: i64) -> Result<()> {
        ctx::adopt_fingerprint(self.store()?.conn(), key, fingerprint, now_ms)
    }
    fn search_context(
        &self,
        key: &ContextKey,
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<FtsHit>> {
        ctx::search_context(self.store()?.conn(), key, terms, limit)
    }
    fn context_graph(&self, key: &ContextKey) -> Result<Vec<GraphRow>> {
        ctx::context_graph(self.store()?.conn(), key)
    }
    fn context_cards(&self, key: &ContextKey, tables: &[String]) -> Result<Vec<StoredCard>> {
        ctx::context_cards(self.store()?.conn(), key, tables)
    }
    fn context_saved(&self, key: &ContextKey) -> Result<Vec<StoredSavedQuery>> {
        ctx::context_saved(self.store()?.conn(), key)
    }
    fn put_saved(
        &self,
        key: &ContextKey,
        dialect: DialectKind,
        q: &StoredSavedQuery,
        clean: &dyn Fn(&str) -> String,
    ) -> Result<()> {
        ctx::put_saved(self.store()?.conn(), key, dialect, q, clean)
    }
    fn remove_saved(&self, key: Option<&ContextKey>, id: uuid::Uuid) -> Result<()> {
        ctx::remove_saved(self.store()?.conn(), key, id)
    }
    fn context_areas(&self, key: &ContextKey) -> Result<Vec<Area>> {
        ctx::context_areas(self.store()?.conn(), key)
    }
    fn put_areas(&self, key: &ContextKey, areas: &[Area]) -> Result<()> {
        ctx::put_areas(self.store()?.conn(), key, areas)
    }
    fn mark_stale(&self, connection: ConnectionId) -> Result<u32> {
        self.context_gates.note_mark(connection);
        ctx::mark_stale(self.store()?.conn(), connection)
    }
    fn clear_context(&self, connection: Option<ConnectionId>) -> Result<()> {
        ctx::clear_context(self.store()?.conn(), connection)
    }
    fn context_list(
        &self,
        connection: Option<ConnectionId>,
    ) -> Result<Vec<(ContextKey, ContextMeta)>> {
        ctx::context_list(self.store()?.conn(), connection)
    }
    fn gates(&self) -> &crate::ai::context::sync::ContextGates {
        &self.context_gates
    }
}
