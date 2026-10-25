use contura_core::Error;
use contura_core::ai::compact::{CompactRequest, compact_now};
use contura_core::ai::context::sync::{ContextInfo, ContextStatusRow, context_status, resync};
use contura_core::ai::diagram::{
    DiagramAskRequest, diagram_ask_stream, diagram_place, diagram_preview,
};
use contura_core::ai::memory::{
    AppendTurn, Compaction, CompactionId, ThreadHit, ThreadSummary, ThreadView, TurnView,
};
use contura_core::ai::models::{ModelList, ModelPicks};
use contura_core::ai::preview::{Preview, SameProvider, preview};
use contura_core::ai::request::AskRequest;
use contura_core::ai::sent::{AnswerAction, AnswerActionKind, AnswerRecord, ToolOutcome};
use contura_core::ai::stream::{AiEvent, ask_stream};
use contura_core::ai::tool_uses::ToolUseRow;
use contura_core::ai::{
    AiAccess, AiError, AiService, AiSettings, AiSettingsView, AiTestOk, AiThread, KeyChange,
    ThreadId,
};
use contura_core::connections::{
    ConnectionInput, ConnectionService, DataFolderInfo, DesignVerdict, EditOutcome, EditPlan,
    GroupInput,
};
use contura_core::design::{DesignOutcome, DesignRequest, TableDesign};
use contura_core::edits::EditSet;
use contura_core::explain::Plan;
use contura_core::model::{
    AiSyncMode, ConnectionConfig, ConnectionId, CountRequest, DbObject, DialectKind, FullValue,
    FullValueRequest, Group, GroupId, KeymapOverrides, LocateRequest, ObjectKind, ObjectPath, Page,
    PageRequest, RowCount, RowPlace, SchemaInfo, UiPrefs,
};
use contura_core::query::{
    Execution, HistoryEntry, HistoryFilter, MoreRows, QuerySessionId, SavedQuery, SavedQueryId,
    SavedQueryInput, SavedQueryRun,
};
use contura_core::recent::{RecentItem, RecentTarget};
use contura_core::safety::{self, PassId, RunVerdict, StatementClass};
use contura_core::schema_model::SchemaModel;
use contura_core::sql_schema::SqlSchema;
use contura_core::suggest::SuggestedConnection;
use contura_core::visual_query::{ColumnTypes, VisualQuery, VqPreview, VqRun};
use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

type Service<'a> = State<'a, ConnectionService>;
type Ai<'a> = State<'a, AiService>;

#[tauri::command]
pub fn list_connections(service: Service<'_>) -> Result<Vec<ConnectionConfig>, Error> {
    service.list()
}

#[tauri::command]
pub async fn save_connection(
    service: Service<'_>,
    input: ConnectionInput,
) -> Result<ConnectionConfig, Error> {
    service.save(input).await
}

#[tauri::command]
pub async fn set_connection_ai_access(
    service: Service<'_>,
    id: ConnectionId,
    access: AiAccess,
) -> Result<ConnectionConfig, Error> {
    service.set_ai_access(id, access).await
}

/// When an Ask checks the Connection's AI Context; only that field is rewritten.
#[tauri::command]
pub fn set_ai_sync_mode(
    service: Service<'_>,
    connection_id: ConnectionId,
    mode: AiSyncMode,
) -> Result<ConnectionConfig, Error> {
    service.set_ai_sync_mode(connection_id, mode)
}

/// The tree's Refresh: the Connection's AI Contexts are marked stale, with no database call.
#[tauri::command]
pub fn ai_context_changed(service: Service<'_>, connection_id: ConnectionId) -> Result<(), Error> {
    service.mark_ai_context_stale(connection_id)
}

/// Deletes one Connection's AI Context, or every one with no Connection.
#[tauri::command]
pub fn ai_clear_context(
    service: Service<'_>,
    connection_id: Option<ConnectionId>,
) -> Result<(), Error> {
    service.clear_ai_context(connection_id)
}

/// Every stored AI Context, or one Connection's: when it was built and checked, and its size.
#[tauri::command]
pub fn ai_context_status(
    service: Service<'_>,
    connection_id: Option<ConnectionId>,
) -> Result<Vec<ContextStatusRow>, Error> {
    context_status(&*service, connection_id)
}

/// Re-sync: rebuilds the AI Context of one database and schema. Refused at AI access Never.
#[tauri::command]
pub async fn ai_resync(
    app: AppHandle,
    connection_id: ConnectionId,
    database: Option<String>,
    schema: Option<String>,
) -> Result<ContextInfo, Error> {
    let reader = app.clone();
    let secrets = off_runtime(move || {
        let connections = reader.state::<ConnectionService>().list()?;
        reader
            .state::<AiService>()
            .secrets_for_redaction(&connections)
    })
    .await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let service = app.state::<ConnectionService>();
    resync(
        &*service,
        connection_id,
        database.as_deref(),
        schema.as_deref(),
        &secrets,
        now_ms,
    )
    .await
}

/// "Clear all AI data": every thread of every place and every AI Context.
#[tauri::command]
pub fn ai_clear_all(app: AppHandle) -> Result<(), Error> {
    app.state::<AiService>().clear_all_threads()?;
    app.state::<ConnectionService>().clear_ai_context(None)
}

/// Deletes the Connection, then its Recent steps kept with Asks on other Connections. The
/// purge reads and rewrites threads, so it runs off the async runtime; one that fails stays
/// pending in the AI store and runs on the next start, so the delete itself succeeded.
#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    service: Service<'_>,
    ai: Ai<'_>,
    id: ConnectionId,
) -> Result<(), Error> {
    ai.delete_connection(&service, id).await?;
    let _ = off_runtime(move || app.state::<AiService>().run_pending_purges()).await;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    service: Service<'_>,
    input: ConnectionInput,
) -> Result<String, Error> {
    service.test(input).await
}

#[tauri::command]
pub fn suggested_connections(service: Service<'_>) -> Result<Vec<SuggestedConnection>, Error> {
    service.suggestions()
}

#[tauri::command]
pub async fn open_connection(service: Service<'_>, id: ConnectionId) -> Result<String, Error> {
    service.open(id).await
}

#[tauri::command]
pub async fn close_connection(service: Service<'_>, id: ConnectionId) -> Result<(), Error> {
    service.close(id).await
}

#[tauri::command]
pub async fn list_databases(service: Service<'_>, id: ConnectionId) -> Result<Vec<String>, Error> {
    service.session(id).await?.list_databases().await
}

#[tauri::command]
pub async fn list_schemas(
    service: Service<'_>,
    id: ConnectionId,
    database: String,
) -> Result<Vec<SchemaInfo>, Error> {
    service.session(id).await?.list_schemas(&database).await
}

#[tauri::command]
pub async fn list_objects(
    service: Service<'_>,
    id: ConnectionId,
    database: String,
    schema: Option<String>,
) -> Result<Vec<DbObject>, Error> {
    service
        .session(id)
        .await?
        .list_objects(&database, schema.as_deref())
        .await
}

#[tauri::command]
pub async fn object_definition(
    service: Service<'_>,
    id: ConnectionId,
    kind: ObjectKind,
    path: ObjectPath,
) -> Result<String, Error> {
    service
        .session(id)
        .await?
        .object_definition(kind, &path)
        .await
}

#[tauri::command]
pub async fn fetch_page(
    service: Service<'_>,
    id: ConnectionId,
    request: PageRequest,
) -> Result<Page, Error> {
    service.session(id).await?.fetch_page(&request).await
}

/// UX step 8: how many rows of a table match a filter (Rows that point here), capped at
/// 1,001, on a read of its own that the server stops after a few seconds.
#[tauri::command]
pub async fn count_rows(
    service: Service<'_>,
    id: ConnectionId,
    request: CountRequest,
) -> Result<RowCount, Error> {
    service
        .session(id)
        .await?
        .count_rows(&request, contura_core::dialect::COUNT_TIMEOUT_MS)
        .await
}

/// M3: where a row is under a page's sort and filter, for Back after a followed key, on a
/// read of its own that the server stops after a few seconds.
#[tauri::command]
pub async fn locate_row(
    service: Service<'_>,
    id: ConnectionId,
    request: LocateRequest,
) -> Result<RowPlace, Error> {
    service
        .session(id)
        .await?
        .locate_row(&request, contura_core::dialect::COUNT_TIMEOUT_MS)
        .await
}

#[tauri::command]
pub async fn fetch_full_value(
    service: Service<'_>,
    id: ConnectionId,
    request: FullValueRequest,
) -> Result<FullValue, Error> {
    service.session(id).await?.fetch_full_value(&request).await
}

/// Contura's own data folder; Schema Models and exports are never written inside it.
pub struct DataDir(pub PathBuf);

#[tauri::command]
pub fn read_model_files(
    data: State<'_, DataDir>,
    path: PathBuf,
) -> Result<contura_core::model_files::ModelFiles, Error> {
    contura_core::model_files::read_model_files(&path, &data.0)
}

#[tauri::command]
pub fn write_model_files(
    data: State<'_, DataDir>,
    path: PathBuf,
    dbml: String,
    layout: String,
) -> Result<(), Error> {
    contura_core::model_files::write_model_files(&path, &dbml, &layout, &data.0)
}

#[tauri::command]
pub fn write_text_file(data: State<'_, DataDir>, path: PathBuf, text: String) -> Result<(), Error> {
    contura_core::model_files::write_text_file(&path, &text, &data.0)
}

/// Every diagram in `<data>\diagrams`, newest first (step 6+).
#[tauri::command]
pub fn list_diagrams(
    data: State<'_, DataDir>,
) -> Result<Vec<contura_core::diagrams::DiagramEntry>, Error> {
    contura_core::diagrams::list_diagrams(&data.0)
}

/// Every node with a `table:` in the diagrams folder, and whether it reads or writes (B2),
/// off the main thread: it reads every `.flow` file (P6).
#[tauri::command]
pub async fn list_flow_table_links(
    data: State<'_, DataDir>,
) -> Result<Vec<contura_core::lineage::FlowTableLink>, Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || contura_core::lineage::list_flow_table_links(&dir))
        .await
        .map_err(|e| Error::File(format!("cannot read the diagrams folder: {e}")))?
}

/// Every packed icon name with its set and title (C1b). Async, off the main thread; a
/// damaged pack is an error, never a panic (P9).
#[tauri::command]
pub async fn icon_index() -> Result<Vec<contura_core::icons::IconEntry>, Error> {
    contura_core::icons::icon_index()
}

/// The packed icon sets with their licences and source links, for Icon credits.
#[tauri::command]
pub async fn icon_sets() -> Result<Vec<contura_core::icons::IconSet>, Error> {
    contura_core::icons::icon_sets()
}

/// Icon `name`'s SVG text, unchanged and checked again as it is served; the UI shows it
/// only as an image (P7, P9).
#[tauri::command]
pub async fn icon(name: String) -> Result<String, Error> {
    contura_core::icons::icon(&name)
}

/// Both files of diagram `name`, off the main thread; a file over 5 MB is refused (P24 M4).
#[tauri::command]
pub async fn read_diagram(
    data: State<'_, DataDir>,
    name: String,
) -> Result<contura_core::diagrams::DiagramFiles, Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || contura_core::diagrams::read_diagram(&dir, &name))
        .await
        .map_err(|e| Error::File(format!("cannot read the diagram: {e}")))?
}

/// Saves diagram `name`; without `overwrite`, a taken name is `DiagramExists`.
///
/// Kept sync on purpose, like `write_diagram_layout` and `rename_diagram`: sync commands run in
/// the order they were sent, so a save already sent lands before a later rename or replace
/// (P24 M2; the UI also waits for it).
#[tauri::command]
pub fn write_diagram(
    data: State<'_, DataDir>,
    name: String,
    text: String,
    layout: String,
    overwrite: bool,
) -> Result<(), Error> {
    contura_core::diagrams::write_diagram(&data.0, &name, &text, &layout, overwrite)
}

/// Saves only the layout file of diagram `name` (moves, Classic, the direction); the `.flow` is
/// left as it is, and a missing `.flow` is refused (P24 I1). Sync, as `write_diagram` is.
#[tauri::command]
pub fn write_diagram_layout(
    data: State<'_, DataDir>,
    name: String,
    layout: String,
) -> Result<(), Error> {
    contura_core::diagrams::write_diagram_layout(&data.0, &name, &layout)
}

/// Moves both files of diagram `name` to the Recycle Bin, off the main thread: the shell
/// call blocks and starts COM, which stays out of the webview's thread (P4).
#[tauri::command]
pub async fn delete_diagram(data: State<'_, DataDir>, name: String) -> Result<(), Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        contura_core::diagrams::delete_diagram(&dir, &name)
    })
    .await
    .map_err(|e| Error::File(format!("cannot move the diagram to the Recycle Bin: {e}")))?
}

#[tauri::command]
pub fn rename_diagram(data: State<'_, DataDir>, from: String, to: String) -> Result<(), Error> {
    contura_core::diagrams::rename_diagram(&data.0, &from, &to)
}

/// "Save a copy as...": both files at `path`, outside Contura's data folder.
#[tauri::command]
pub fn save_diagram_copy(
    data: State<'_, DataDir>,
    text: String,
    layout: String,
    path: PathBuf,
) -> Result<(), Error> {
    contura_core::diagrams::save_diagram_copy(&text, &layout, &path, &data.0)
}

#[tauri::command]
pub fn write_binary_file(
    data: State<'_, DataDir>,
    path: PathBuf,
    base64: String,
) -> Result<(), Error> {
    contura_core::model_files::write_base64_file(&path, &base64, &data.0)
}

/// A CREATE script for the model, in the model's own Dialect. Never executed.
#[tauri::command]
pub fn export_sql(model: SchemaModel) -> Result<String, Error> {
    contura_core::ddl::create_script(&model)
}

/// Reads a database (or Postgres schema) and writes it as DBML. Read only.
#[tauri::command]
pub async fn reverse_engineer(
    service: Service<'_>,
    id: ConnectionId,
    database: String,
    schema: Option<String>,
) -> Result<String, Error> {
    let model = service
        .session(id)
        .await?
        .schema_snapshot(&database, schema.as_deref())
        .await?;
    let connection = service
        .list()?
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.name)
        .unwrap_or_default();
    let place = match &schema {
        Some(s) => format!("{database}.{s}"),
        None => database,
    };
    Ok(contura_core::dbml_writer::write_dbml(
        &model,
        &format!("{connection} / {place}"),
    ))
}

#[tauri::command]
pub async fn schema_snapshot(
    service: Service<'_>,
    id: ConnectionId,
    database: String,
    schema: Option<String>,
) -> Result<SchemaModel, Error> {
    service
        .session(id)
        .await?
        .schema_snapshot(&database, schema.as_deref())
        .await
}

#[tauri::command]
pub async fn sql_schema(
    service: Service<'_>,
    id: ConnectionId,
    database: String,
) -> Result<SqlSchema, Error> {
    service.session(id).await?.sql_schema(&database).await
}

#[tauri::command]
pub fn list_groups(service: Service<'_>) -> Result<Vec<Group>, Error> {
    service.list_groups()
}

#[tauri::command]
pub fn save_group(service: Service<'_>, input: GroupInput) -> Result<Group, Error> {
    service.save_group(input)
}

#[tauri::command]
pub fn set_group_image(service: Service<'_>, id: GroupId, png: String) -> Result<Group, Error> {
    let bytes = contura_core::connections::decode_group_image(&png)?;
    service.set_group_image(id, &bytes)
}

#[tauri::command]
pub fn clear_group_image(service: Service<'_>, id: GroupId) -> Result<Group, Error> {
    service.clear_group_image(id)
}

#[tauri::command]
pub fn group_image(service: Service<'_>, id: GroupId) -> Result<Option<String>, Error> {
    Ok(service
        .group_image(id)?
        .map(|b| contura_core::model_files::encode_base64(&b)))
}

#[tauri::command]
pub fn delete_group(service: Service<'_>, id: GroupId) -> Result<(), Error> {
    service.delete_group(id)
}

#[tauri::command]
pub fn move_connection(
    service: Service<'_>,
    id: ConnectionId,
    group_id: Option<GroupId>,
) -> Result<ConnectionConfig, Error> {
    service.move_connection(id, group_id)
}

#[tauri::command]
pub fn last_group(service: Service<'_>) -> Result<Option<GroupId>, Error> {
    service.last_group()
}

#[tauri::command]
pub fn set_last_group(service: Service<'_>, id: Option<GroupId>) -> Result<(), Error> {
    service.set_last_group(id)
}

/// Whether the first start guide opens on its own (a data folder this start made, guide not closed yet).
#[tauri::command]
pub fn first_start_guide(service: Service<'_>) -> Result<bool, Error> {
    service.first_start_guide()
}

#[tauri::command]
pub fn first_start_guide_seen(service: Service<'_>) -> Result<(), Error> {
    service.first_start_guide_seen()
}

#[tauri::command]
pub fn ui_prefs(service: Service<'_>) -> Result<UiPrefs, Error> {
    service.ui_prefs()
}

#[tauri::command]
pub fn recent_items(service: Service<'_>) -> Result<Vec<RecentItem>, Error> {
    service.recent_items()
}

#[tauri::command]
pub fn record_recent(
    service: Service<'_>,
    target: RecentTarget,
    connection_id: Option<ConnectionId>,
) -> Result<(), Error> {
    service.record_recent(target, connection_id)
}

#[tauri::command]
pub fn save_ui_prefs(service: Service<'_>, prefs: UiPrefs) -> Result<(), Error> {
    service.save_ui_prefs(prefs)
}

#[tauri::command]
pub fn keymap(service: Service<'_>) -> Result<KeymapOverrides, Error> {
    service.keymap()
}

#[tauri::command]
pub fn save_keymap(service: Service<'_>, overrides: KeymapOverrides) -> Result<(), Error> {
    service.save_keymap(overrides)
}

#[tauri::command]
pub fn create_sqlite_database(data: State<'_, DataDir>, path: PathBuf) -> Result<(), Error> {
    // A new database never goes into Contura's data folder, beside app.sqlite (Q33).
    contura_core::jobs::paths::check_user_path(
        &path,
        &data.0,
        contura_core::jobs::paths::PathUse::Database,
    )?;
    contura_core::sqlite::create_database(&path)
}

#[tauri::command]
pub async fn open_query_session(
    service: Service<'_>,
    id: ConnectionId,
    database: Option<String>,
) -> Result<QuerySessionId, Error> {
    service.open_query_session(id, database).await
}

/// N3: a MySQL tab's framed script stopped before its footer: put its sql_mode back.
#[tauri::command]
pub async fn restore_script_sql_mode(
    service: Service<'_>,
    session: QuerySessionId,
) -> Result<bool, Error> {
    service.restore_script_sql_mode(session).await
}

#[tauri::command]
pub async fn execute_sql(
    service: Service<'_>,
    session: QuerySessionId,
    sql: String,
    pass: Option<PassId>,
) -> Result<Execution, Error> {
    service.execute_sql(session, sql, pass).await
}

/// The SQL a Visual Query writes, or the problems that stop it. Needs no open session.
#[tauri::command]
pub fn visual_query_sql(
    service: Service<'_>,
    id: ConnectionId,
    query: VisualQuery,
    types: ColumnTypes,
) -> Result<VqPreview, Error> {
    service.visual_query_sql(id, query, types)
}

/// Writes a Visual Query and runs it on the session as the editor runs a statement.
#[tauri::command]
pub async fn run_visual_query(
    service: Service<'_>,
    session: QuerySessionId,
    query: VisualQuery,
    types: ColumnTypes,
    pass: Option<PassId>,
) -> Result<VqRun, Error> {
    service.run_visual_query(session, query, types, pass).await
}

#[tauri::command]
pub fn plan_run(
    service: Service<'_>,
    session: QuerySessionId,
    statements: Vec<String>,
) -> Result<Vec<safety::PlannedRun>, Error> {
    service.plan_run(session, statements)
}

#[tauri::command]
pub fn prepare_run(
    service: Service<'_>,
    session: QuerySessionId,
    statements: Vec<String>,
) -> Result<RunVerdict, Error> {
    service.prepare_run(session, statements)
}

#[tauri::command]
pub fn classify_sql(dialect: DialectKind, sql: String) -> StatementClass {
    safety::classify(dialect, &sql)
}

#[tauri::command]
pub fn confirm_run(
    service: Service<'_>,
    session: QuerySessionId,
    statements: Vec<String>,
) -> Result<PassId, Error> {
    service.confirm_run(session, statements)
}

#[tauri::command]
pub async fn plan_edits(
    service: Service<'_>,
    id: ConnectionId,
    edits: EditSet,
) -> Result<EditPlan, Error> {
    service.plan_edits(id, edits).await
}

#[tauri::command]
pub async fn confirm_edits(
    service: Service<'_>,
    id: ConnectionId,
    edits: EditSet,
) -> Result<PassId, Error> {
    service.confirm_edits(id, edits).await
}

#[tauri::command]
pub async fn apply_edits(
    service: Service<'_>,
    id: ConnectionId,
    edits: EditSet,
    pass: Option<PassId>,
) -> Result<EditOutcome, Error> {
    service.apply_edits(id, edits, pass).await
}

#[tauri::command]
pub async fn table_design(
    service: Service<'_>,
    id: ConnectionId,
    path: ObjectPath,
) -> Result<TableDesign, Error> {
    service.table_design(id, path).await
}

/// The tables around `path` from catalog details; a `depth` of 0 is All (B2).
#[tauri::command]
pub async fn lineage(
    service: Service<'_>,
    id: ConnectionId,
    path: ObjectPath,
    depth: u8,
    direction: contura_core::lineage::Direction,
) -> Result<contura_core::lineage::Lineage, Error> {
    service.lineage(id, path, depth, direction).await
}

/// The views the catalog records as reading `path`, at most 200, off the main thread; on
/// SQLite and older MySQL `catalog` is false and the UI matches names instead.
#[tauri::command]
pub async fn view_dependencies(
    service: Service<'_>,
    id: ConnectionId,
    path: ObjectPath,
) -> Result<contura_core::lineage::ViewDependencies, Error> {
    service.view_dependencies(id, path).await
}

fn layout_join_err(e: tauri::Error) -> Error {
    Error::File(format!("cannot reach the lineage layout: {e}"))
}

/// The moved cards of `path`'s lineage, or null when none are saved.
#[tauri::command]
pub async fn read_lineage_layout(
    data: State<'_, DataDir>,
    id: ConnectionId,
    path: ObjectPath,
) -> Result<Option<String>, Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        contura_core::lineage::read_lineage_layout(&dir, id, &path)
    })
    .await
    .map_err(layout_join_err)?
}

/// Saves the moved cards of `path`'s lineage in `<data>\diagrams\.lineage`.
#[tauri::command]
pub async fn write_lineage_layout(
    data: State<'_, DataDir>,
    id: ConnectionId,
    path: ObjectPath,
    layout: String,
) -> Result<(), Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        contura_core::lineage::write_lineage_layout(&dir, id, &path, &layout)
    })
    .await
    .map_err(layout_join_err)?
}

/// Reset: removes the saved layout of `path`'s lineage.
#[tauri::command]
pub async fn delete_lineage_layout(
    data: State<'_, DataDir>,
    id: ConnectionId,
    path: ObjectPath,
) -> Result<(), Error> {
    let dir = data.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        contura_core::lineage::delete_lineage_layout(&dir, id, &path)
    })
    .await
    .map_err(layout_join_err)?
}

#[tauri::command]
pub async fn table_ddl(
    service: Service<'_>,
    id: ConnectionId,
    path: ObjectPath,
) -> Result<String, Error> {
    service.table_ddl(id, path).await
}

#[tauri::command]
pub async fn plan_design(
    service: Service<'_>,
    id: ConnectionId,
    request: DesignRequest,
) -> Result<DesignVerdict, Error> {
    service.plan_design(id, request).await
}

#[tauri::command]
pub async fn confirm_design(
    service: Service<'_>,
    id: ConnectionId,
    request: DesignRequest,
) -> Result<PassId, Error> {
    service.confirm_design(id, request).await
}

#[tauri::command]
pub async fn apply_design(
    service: Service<'_>,
    id: ConnectionId,
    request: DesignRequest,
    pass: Option<PassId>,
) -> Result<DesignOutcome, Error> {
    service.apply_design(id, request, pass).await
}

#[tauri::command]
pub fn forget_recent(
    service: Service<'_>,
    connection_id: ConnectionId,
    path: ObjectPath,
) -> Result<(), Error> {
    service.forget_recent(connection_id, &path)
}

#[tauri::command]
pub async fn explain_statement(
    service: Service<'_>,
    session: QuerySessionId,
    statement: String,
) -> Result<Plan, Error> {
    service.explain(session, statement).await
}

#[tauri::command]
pub async fn fetch_more_rows(
    service: Service<'_>,
    session: QuerySessionId,
) -> Result<MoreRows, Error> {
    service.fetch_more_rows(session).await
}

#[tauri::command]
pub async fn cancel_query(service: Service<'_>, session: QuerySessionId) -> Result<(), Error> {
    service.cancel_query(session).await
}

#[tauri::command]
pub async fn close_query_result(
    service: Service<'_>,
    session: QuerySessionId,
) -> Result<(), Error> {
    service.close_query_result(session).await
}

#[tauri::command]
pub async fn close_query_session(
    service: Service<'_>,
    session: QuerySessionId,
) -> Result<(), Error> {
    service.close_query_session(session).await
}

#[tauri::command]
pub fn query_history(
    service: Service<'_>,
    id: Option<ConnectionId>,
    filter: HistoryFilter,
) -> Result<Vec<HistoryEntry>, Error> {
    service.query_history(id, filter)
}

/// Clears the Connection's history (every Connection's with `None`), then its Recent steps
/// kept with Asks on other Connections.
#[tauri::command]
pub fn clear_query_history(
    service: Service<'_>,
    ai: Ai<'_>,
    id: Option<ConnectionId>,
) -> Result<(), Error> {
    ai.clear_query_history(&service, id)
}

#[tauri::command]
pub fn saved_query_runs(service: Service<'_>) -> Result<Vec<SavedQueryRun>, Error> {
    service.saved_query_runs()
}

#[tauri::command]
pub fn data_folder_info(service: Service<'_>) -> Result<DataFolderInfo, Error> {
    service.data_folder_info()
}

/// The secret store this run uses, so the password and API key fields can say when
/// secrets are kept only until Contura closes.
pub struct Secrets(pub std::sync::Arc<contura_core::secrets::DeferredSecretStore>);

/// Async and off the main thread: the answer waits for the keyring check (bounded).
#[tauri::command]
pub async fn secret_store_kind(
    secrets: State<'_, Secrets>,
) -> Result<contura_core::secrets::SecretStoreKind, Error> {
    let store = secrets.0.clone();
    tauri::async_runtime::spawn_blocking(move || store.kind())
        .await
        .map_err(|e| Error::Secret(format!("cannot check the keyring: {e}")))
}

/// Shows the data folder in the system's file manager.
#[tauri::command]
pub fn open_data_folder(data: State<'_, DataDir>) -> Result<(), Error> {
    crate::folders::open_folder(&data.0)
}

#[tauri::command]
pub fn clear_recent(service: Service<'_>) -> Result<Vec<RecentItem>, Error> {
    service.clear_recent()
}

#[tauri::command]
pub fn restore_recent(service: Service<'_>, items: Vec<RecentItem>) -> Result<(), Error> {
    service.restore_recent(items)
}

#[tauri::command]
pub fn connection_opened_times(
    service: Service<'_>,
) -> Result<std::collections::HashMap<ConnectionId, i64>, Error> {
    service.connection_opened_times()
}

#[tauri::command]
pub fn list_saved_queries(service: Service<'_>) -> Result<Vec<SavedQuery>, Error> {
    service.list_saved_queries()
}

/// Off the runtime: keeping the AI Context's copy up to date reads the saved secrets.
#[tauri::command]
pub async fn save_saved_query(app: AppHandle, input: SavedQueryInput) -> Result<SavedQuery, Error> {
    off_runtime(move || app.state::<ConnectionService>().save_saved_query(input)).await
}

#[tauri::command]
pub fn delete_saved_query(service: Service<'_>, id: SavedQueryId) -> Result<(), Error> {
    service.delete_saved_query(id)
}

#[tauri::command]
pub fn load_query_tabs(service: Service<'_>, place: String) -> Result<Option<String>, Error> {
    service.load_query_tabs(place)
}

#[tauri::command]
pub fn save_query_tabs(service: Service<'_>, place: String, json: String) -> Result<(), Error> {
    service.save_query_tabs(place, json)
}

#[tauri::command]
pub fn column_orders(
    service: Service<'_>,
    id: ConnectionId,
) -> Result<std::collections::HashMap<String, Vec<String>>, Error> {
    service.column_orders(id)
}

#[tauri::command]
pub fn save_column_order(
    service: Service<'_>,
    id: ConnectionId,
    table: String,
    columns: Option<Vec<String>>,
) -> Result<(), Error> {
    service.save_column_order(id, table, columns)
}

// These three read or write the saved key, which waits for the start-up keyring check:
// async and off the main thread, so the window keeps painting meanwhile.
#[tauri::command]
pub async fn ai_settings(
    app: AppHandle,
    group_id: Option<GroupId>,
) -> Result<AiSettingsView, Error> {
    off_runtime(move || app.state::<AiService>().settings(group_id)).await
}

#[tauri::command]
pub async fn save_ai_settings(
    app: AppHandle,
    group_id: Option<GroupId>,
    settings: AiSettings,
    override_group: bool,
    key: KeyChange,
) -> Result<(), Error> {
    off_runtime(move || {
        app.state::<AiService>()
            .save_settings(group_id, settings, override_group, key)
    })
    .await
}

/// "Send the saved key to <host>?": binds the saved key to the host the settings now use.
#[tauri::command]
pub async fn ai_confirm_key_host(
    app: AppHandle,
    group_id: Option<GroupId>,
    host: String,
) -> Result<(), Error> {
    off_runtime(move || app.state::<AiService>().confirm_key_host(group_id, &host)).await
}

/// One short request with the saved settings and key.
#[tauri::command]
pub async fn ai_test(app: AppHandle, group_id: Option<GroupId>) -> Result<AiTestOk, Error> {
    let (provider, _, model) =
        off_runtime(move || app.state::<AiService>().provider_for(group_id)).await?;
    contura_core::ai::test_provider(&*provider, &model).await
}

/// The provider's models, fetched with the saved key and stored for the offline list.
#[tauri::command]
pub async fn ai_models(app: AppHandle, group_id: Option<GroupId>) -> Result<ModelList, Error> {
    let reader = app.clone();
    let (provider, settings, _) =
        off_runtime(move || reader.state::<AiService>().provider_for(group_id)).await?;
    let listed = provider
        .models(&mut contura_core::ai::log::Log::new())
        .await?;
    // A store write blocks too.
    off_runtime(move || app.state::<AiService>().store_listing(&settings, listed)).await
}

/// The model list with no network: the built-in records and the last fetched listing.
#[tauri::command]
pub fn ai_known_models(ai: Ai<'_>, group_id: Option<GroupId>) -> Result<ModelList, Error> {
    ai.known_models(group_id)
}

/// Remembers the picker's thinking and caching picks for `model` and makes it current.
#[tauri::command]
pub fn set_ai_model_prefs(
    ai: Ai<'_>,
    group_id: Option<GroupId>,
    model: String,
    picks: ModelPicks,
) -> Result<(), Error> {
    ai.set_model_prefs(group_id, &model, picks)
}

/// Ends a stream that was stopped from the Core's side: Stop it (`ai_cancel_place`) aborts
/// the task at its next wait, so the Ask sends no `done` or `error` of its own and the
/// webview would keep showing it as writing. Dropped before `ended`, it sends
/// `Error{Cancelled}`, the shape a Stop ends with.
struct EndOnDrop<F: Fn(AiEvent)> {
    send: F,
    ended: bool,
}

impl<F: Fn(AiEvent)> EndOnDrop<F> {
    fn new(send: F) -> Self {
        Self { send, ended: false }
    }

    /// The work ran to its end and sent its own last event.
    fn ended(&mut self) {
        self.ended = true;
    }
}

impl<F: Fn(AiEvent)> Drop for EndOnDrop<F> {
    fn drop(&mut self) {
        if !self.ended {
            (self.send)(AiEvent::Error {
                error: AiError::Cancelled,
                partial: false,
            });
        }
    }
}

/// Sends `event` to the webview; a page that has gone away is not an error.
fn send_to(events: &Channel<AiEvent>) -> impl Fn(AiEvent) + Send + Sync + 'static {
    let events = events.clone();
    move |e| {
        let _ = events.send(e);
    }
}

/// Removes a running Ask from the AI service when its task ends, however it ends:
/// done, failed, or aborted by Stop (dropping the task drops this).
struct Finish {
    app: AppHandle,
    request_id: String,
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.app.state::<AiService>().finish(&self.request_id);
    }
}

/// Starts an Ask and returns once it is registered; its events go to `events` and end
/// with `done` or `error`. Refused at once when it cannot start: no provider, a key
/// bound to another host, or another Ask running in the same place.
#[tauri::command]
pub async fn ai_ask_stream(
    app: AppHandle,
    request: AskRequest,
    events: Channel<AiEvent>,
) -> Result<(), Error> {
    let group = request.group_id;
    let reader = app.clone();
    let wanted = request.model.clone().filter(|m| !m.trim().is_empty());
    let (provider, model, settings, secrets, same) = off_runtime(move || {
        let ai = reader.state::<AiService>();
        let (provider, settings, model) = ai.provider_for(group)?;
        // From the same read as the provider, so a save in between cannot mix the two.
        let model = ai.model_info_in(&settings, wanted.as_deref().unwrap_or(&model))?;
        let connections = reader.state::<ConnectionService>().list()?;
        Ok((
            provider,
            model,
            settings,
            ai.secrets_for_redaction(&connections)?,
            ai.same_provider(group, &connections)?,
        ))
    })
    .await?;
    let place = request.place.clone();
    let request_id = request.request_id.clone();
    // The task waits until the Ask is registered, so it can never finish before it starts.
    let (go, registered) = tokio::sync::oneshot::channel::<()>();
    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered.await.is_err() {
            return;
        }
        let _finish = Finish {
            app: task_app.clone(),
            request_id: request.request_id.clone(),
        };
        let mut end = EndOnDrop::new(send_to(&events));
        let connections = task_app.state::<ConnectionService>();
        // Nothing about a Connection whose Group sends to another provider goes.
        let catalog = SameProvider::new(&*connections, same);
        let asks = task_app.state::<AiService>();
        let emit = |e: AiEvent| {
            // R6.3: the answer's SQL goes into the register, whatever the Ask's Connection.
            if let AiEvent::Done { sql_blocks, .. } = &e {
                for block in sql_blocks {
                    connections.register_ai_sql(&block.statements);
                }
            }
            // The save of the answer writes it into the record.
            if let AiEvent::Context { info } = &e {
                asks.remember_context(&request.request_id, info.clone());
            }
            // The webview is sent the stamp without the steps on other Connections; the
            // save of the turn puts them back on the question.
            asks.hold_other_steps(&request.request_id, &e);
            // A page that has gone away is not an error.
            let _ = events.send(e);
        };
        // Every error has already been sent as the last event.
        let _ = ask_stream(
            &*provider, &catalog, &settings, &model, &secrets, &request, &emit,
        )
        .await;
        end.ended();
    });
    let ai = app.state::<AiService>();
    if let Err(e) = ai.start(&place, &request_id, task.inner().abort_handle()) {
        task.abort();
        return Err(e);
    }
    let _ = go.send(());
    Ok(())
}

/// What a diagram Ask would send, built in the Core: the Sends list and "Show exactly".
/// The diagram is not database data, so only the global settings apply.
#[tauri::command]
pub async fn ai_diagram_preview(
    app: tauri::AppHandle,
    request: DiagramAskRequest,
) -> Result<Preview, Error> {
    let wanted = request.model.clone().filter(|m| !m.trim().is_empty());
    let (settings, model, secrets) = off_runtime(move || {
        let ai = app.state::<AiService>();
        let settings = ai.settings(None)?.settings;
        let model = ai.model_info_in(&settings, wanted.as_deref().unwrap_or(&settings.model))?;
        let connections = app.state::<ConnectionService>().list()?;
        Ok((settings, model, ai.secrets_for_redaction(&connections)?))
    })
    .await?;
    diagram_preview(
        &settings,
        &model,
        &secrets,
        &request,
        &mut contura_core::ai::log::Log::new(),
    )
}

/// Starts a diagram Ask and returns once it is registered, under the diagram's place so
/// one runs per diagram and `ai_cancel` stops it; its events end with `done` or `error`.
/// The .flow file is read off the runtime, before the model is asked and again after.
#[tauri::command]
pub async fn ai_diagram_ask(
    app: AppHandle,
    data: State<'_, DataDir>,
    request: DiagramAskRequest,
    events: Channel<AiEvent>,
) -> Result<(), Error> {
    let reader = app.clone();
    let wanted = request.model.clone().filter(|m| !m.trim().is_empty());
    let (provider, model, settings, secrets) = off_runtime(move || {
        let ai = reader.state::<AiService>();
        let (provider, settings, model) = ai.provider_for(None)?;
        let model = ai.model_info_in(&settings, wanted.as_deref().unwrap_or(&model))?;
        let connections = reader.state::<ConnectionService>().list()?;
        Ok((
            provider,
            model,
            settings,
            ai.secrets_for_redaction(&connections)?,
        ))
    })
    .await?;
    let place = diagram_place(&request.file);
    let request_id = request.request_id.clone();
    let dir = data.0.clone();
    let (go, registered) = tokio::sync::oneshot::channel::<()>();
    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered.await.is_err() {
            return;
        }
        let _finish = Finish {
            app: task_app,
            request_id: request.request_id.clone(),
        };
        let mut end = EndOnDrop::new(send_to(&events));
        // A page that has gone away is not an error.
        let emit = |e: AiEvent| {
            let _ = events.send(e);
        };
        let file = request.file.clone();
        let disk = || -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, Error>> + Send>> {
            let (dir, file) = (dir.clone(), file.clone());
            Box::pin(async move {
                tauri::async_runtime::spawn_blocking(move || {
                    contura_core::diagrams::read_diagram(&dir, &file).map(|files| files.text)
                })
                .await
                .map_err(|e| Error::File(format!("cannot read the diagram: {e}")))?
            })
        };
        // Every error has already been sent as the last event.
        let _ = diagram_ask_stream(
            &*provider, &settings, &model, &secrets, &request, &disk, &emit,
        )
        .await;
        end.ended();
    });
    let ai = app.state::<AiService>();
    if let Err(e) = ai.start(&place, &request_id, task.inner().abort_handle()) {
        task.abort();
        return Err(e);
    }
    let _ = go.send(());
    Ok(())
}

/// Keeps what the user did with the changes a diagram answer proposed. `None` for an
/// answer with no tool call.
#[tauri::command]
pub fn ai_record_tool_result(
    ai: Ai<'_>,
    thread_id: ThreadId,
    message_at: i64,
    outcome: ToolOutcome,
) -> Result<Option<ToolOutcome>, Error> {
    ai.record_tool_result(thread_id, message_at, outcome)
}

/// The 20 newest tool uses, for Recent tool uses.
#[tauri::command]
pub fn ai_recent_tool_uses(ai: Ai<'_>) -> Result<Vec<ToolUseRow>, Error> {
    ai.recent_tool_uses(20)
}

/// Compact now: folds the open Topic's older turns into one summary, whatever the 85%.
/// Registered like an Ask (`Busy` while one runs in the place, stopped by `ai_cancel`);
/// its log, status, Compact row and Sent record go to `events`, and a Stop ends them with
/// `Error{Cancelled}`. Returns the compaction once it is stored, its record trimmed as in
/// the `compacted` event.
#[tauri::command]
pub async fn ai_compact(
    app: AppHandle,
    request: CompactRequest,
    events: Channel<AiEvent>,
) -> Result<Compaction, Error> {
    let group = request.group_id;
    let reader = app.clone();
    let wanted = request.model.clone().filter(|m| !m.trim().is_empty());
    let (provider, model, settings, secrets, same) = off_runtime(move || {
        let ai = reader.state::<AiService>();
        let (provider, settings, model) = ai.provider_for(group)?;
        let model = ai.model_info_in(&settings, wanted.as_deref().unwrap_or(&model))?;
        let connections = reader.state::<ConnectionService>().list()?;
        Ok((
            provider,
            model,
            settings,
            ai.secrets_for_redaction(&connections)?,
            ai.same_provider(group, &connections)?,
        ))
    })
    .await?;
    let place = request.place.clone();
    let request_id = request.request_id.clone();
    let task_app = app.clone();
    let work = async move {
        let connections = task_app.state::<ConnectionService>();
        let catalog = SameProvider::new(&*connections, same);
        let mut end = EndOnDrop::new(send_to(&events));
        let emit = |e: AiEvent| {
            // A page that has gone away is not an error.
            let _ = events.send(e);
        };
        let out = compact_now(
            &*provider, &catalog, &settings, &model, &secrets, &request, &emit,
        )
        .await;
        end.ended();
        out
    };
    // As the `compacted` event: the record trimmed (the full one is fetched on demand).
    app.state::<AiService>()
        .run_registered(&place, &request_id, work)
        .await
        .map(|c| c.trimmed_copy())
}

/// Undoes a compaction: its messages show and go again. A second Undo returns the same
/// view.
#[tauri::command]
pub fn ai_undo_compact(
    ai: Ai<'_>,
    thread_id: ThreadId,
    compaction_id: CompactionId,
) -> Result<ThreadView, Error> {
    ai.undo_compaction(thread_id, compaction_id)
}

/// Stops a running Ask; false when it had already ended.
#[tauri::command]
pub fn ai_cancel(ai: Ai<'_>, request_id: String) -> bool {
    ai.cancel(&request_id)
}

/// Stops every running Ask or Compact now of the place; false when none was running.
#[tauri::command]
pub fn ai_cancel_place(ai: Ai<'_>, place: String) -> bool {
    ai.cancel_place(&place)
}

/// The place's threads as summaries. The Core reads every stored thread of the place
/// itself to register their SQL again (stored answers can be inserted and run), so no
/// message crosses IPC.
#[tauri::command]
pub fn list_ai_threads(
    ai: Ai<'_>,
    connections: State<'_, ConnectionService>,
    place: String,
) -> Result<Vec<ThreadSummary>, Error> {
    ai.list_threads_registering(&place, &connections)
}

/// A thread with its Topics and compactions; every record is trimmed.
#[tauri::command]
pub fn get_ai_thread(ai: Ai<'_>, thread_id: ThreadId) -> Result<Option<ThreadView>, Error> {
    ai.thread_view(thread_id)
}

/// The full stored record of the answer at `message_at`.
#[tauri::command]
pub fn ai_answer_record(
    ai: Ai<'_>,
    thread_id: ThreadId,
    message_at: i64,
) -> Result<Option<AnswerRecord>, Error> {
    ai.answer_record(thread_id, message_at)
}

/// Searches the Topics of a place's threads.
#[tauri::command]
pub fn ai_search_threads(ai: Ai<'_>, place: String, text: String) -> Result<Vec<ThreadHit>, Error> {
    ai.search_threads(&place, &text)
}

/// Saves a thread and returns its view; `request_id` is the Ask whose answer this save
/// adds, so the Core writes the AI Context that Ask used into the answer's record.
#[tauri::command]
pub fn save_ai_thread(
    ai: Ai<'_>,
    thread: AiThread,
    request_id: Option<String>,
) -> Result<ThreadView, Error> {
    ai.save_thread_for(&thread, request_id.as_deref())
}

/// Appends one Ask's turn to its stored thread and returns only the new messages, so the
/// thread never crosses IPC; `request_id` is the Ask, as for `save_ai_thread`.
#[tauri::command]
pub fn ai_append_turn(
    ai: Ai<'_>,
    turn: AppendTurn,
    request_id: Option<String>,
) -> Result<TurnView, Error> {
    ai.append_turn(turn, request_id.as_deref())
}

/// Keeps what the user did with an answer's SQL (Insert, Insert commented out, Open in new
/// tab) with the answer, for the Diagram's "You:" box. `None` for an answer kept before
/// records were.
#[tauri::command]
pub fn ai_record_action(
    ai: Ai<'_>,
    thread_id: ThreadId,
    message_at: i64,
    kind: AnswerActionKind,
) -> Result<Option<AnswerAction>, Error> {
    ai.record_action(thread_id, message_at, kind)
}

#[tauri::command]
pub fn delete_ai_thread(ai: Ai<'_>, id: ThreadId) -> Result<(), Error> {
    ai.delete_thread(id)
}

/// Clears the place's threads, then the Recent steps of its Connections kept with Asks of
/// other places.
#[tauri::command]
pub fn clear_ai_threads(ai: Ai<'_>, service: Service<'_>, place: String) -> Result<(), Error> {
    ai.clear_place_history(&place, &service)
}

/// Runs `f` on the blocking pool: Credential Manager reads block, and an async command
/// must not hold a runtime worker while they do.
async fn off_runtime<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::File(format!("cannot read the saved secrets: {e}")))?
}

/// What the Ask would send, built in the Core: the Sends list and "Show exactly".
#[tauri::command]
pub async fn ai_preview(
    app: tauri::AppHandle,
    service: Service<'_>,
    request: AskRequest,
) -> Result<Preview, Error> {
    let group = request.group_id;
    let wanted = request.model.clone().filter(|m| !m.trim().is_empty());
    let (settings, model, secrets, same) = off_runtime(move || {
        let ai = app.state::<AiService>();
        let settings = ai.settings(group)?.settings;
        let model = ai.model_info_in(&settings, wanted.as_deref().unwrap_or(&settings.model))?;
        let connections = app.state::<ConnectionService>().list()?;
        Ok((
            settings,
            model,
            ai.secrets_for_redaction(&connections)?,
            ai.same_provider(group, &connections)?,
        ))
    })
    .await?;
    let catalog = SameProvider::new(&*service, same);
    preview(&catalog, &settings, &model, &secrets, &request).await
}

/// Opens an https link (an icon set's source in Icon credits) in the system browser. The
/// address is checked again here: https only, no user name or password (P9).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), Error> {
    let url = contura_core::links::safe_https_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || crate::browser::open(&url))
        .await
        .map_err(|e| Error::File(format!("The browser didn't open: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    /// On a one-thread runtime, `f` waits for a task on that runtime. It only gets its
    /// answer if `f` runs off the runtime's thread.
    #[test]
    fn credential_reads_run_off_the_runtime() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let got = rt.block_on(async move {
            let reply = tokio::spawn(async move {
                let _ = tx.send("read");
            });
            let got = off_runtime(move || {
                rx.recv_timeout(Duration::from_secs(5))
                    .map_err(|e| Error::File(e.to_string()))
            })
            .await;
            reply.await.unwrap();
            got
        });
        assert_eq!(got.unwrap(), "read");
    }

    fn sink() -> (
        Arc<Mutex<Vec<AiEvent>>>,
        impl Fn(AiEvent) + Send + Sync + 'static,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let into = events.clone();
        (events, move |e| into.lock().unwrap().push(e))
    }

    /// Stop it aborts the task, so the Ask sends nothing of its own: the guard ends the
    /// stream, or the inline box keeps writing.
    #[test]
    fn an_aborted_stream_ends_with_cancelled() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let (events, send) = sink();
        rt.block_on(async move {
            let task = tokio::spawn(async move {
                let _end = EndOnDrop::new(send);
                std::future::pending::<()>().await;
            });
            tokio::task::yield_now().await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
        let events = events.lock().unwrap();
        assert!(
            matches!(
                events.as_slice(),
                [AiEvent::Error {
                    error: AiError::Cancelled,
                    partial: false
                }]
            ),
            "{events:?}"
        );
    }

    #[test]
    fn a_finished_stream_sends_nothing_more() {
        let (events, send) = sink();
        let mut end = EndOnDrop::new(send);
        end.ended();
        drop(end);
        assert!(events.lock().unwrap().is_empty());
    }
}

/// Rules about how the commands are written, checked on this file's own text.
#[cfg(test)]
mod source_rules {
    /// Each command body, from its `pub async fn <name>(` or `pub fn <name>(` up to the
    /// next line that is exactly `}`.
    fn bodies() -> Vec<(String, Vec<&'static str>)> {
        let source: &'static str = include_str!("commands.rs");
        // The rules' own text is not a command.
        let source = &source[..source.find("mod source_rules").unwrap()];
        let lines: Vec<&str> = source.lines().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let rest = line
                .strip_prefix("pub async fn ")
                .or_else(|| line.strip_prefix("pub fn "));
            if let Some(rest) = rest {
                let name = rest.split('(').next().unwrap().to_string();
                let end = (i..lines.len()).find(|&j| lines[j] == "}").unwrap();
                out.push((name, lines[i..=end].to_vec()));
                i = end;
            }
            i += 1;
        }
        out
    }

    fn named(name: &str) -> Vec<&'static str> {
        bodies()
            .into_iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("no command {name}"))
            .1
    }

    #[test]
    fn store_writes_stay_off_the_runtime() {
        let mut found = 0;
        for (name, body) in bodies() {
            if !line_starts_async(&body) {
                continue;
            }
            // Inside an `off_runtime(move ||` closure from where it opens to the
            // `.await` that ends the call.
            let mut opened = false;
            for line in &body {
                if line.contains("off_runtime(move ||") {
                    opened = true;
                }
                let writes = ["store_listing(", "save_settings(", "set_model_prefs("]
                    .iter()
                    .any(|w| line.contains(w));
                if writes {
                    found += 1;
                    assert!(
                        opened || line.contains("off_runtime("),
                        "{name}: a store write on the runtime: {line}"
                    );
                }
                if line.contains(".await") {
                    opened = false;
                }
            }
        }
        assert!(found > 0, "the rule matched no store write");
    }

    fn line_starts_async(body: &[&str]) -> bool {
        body[0].starts_with("pub async fn ")
    }

    #[test]
    fn asks_read_settings_once() {
        for name in [
            "ai_ask_stream",
            "ai_preview",
            "ai_diagram_ask",
            "ai_diagram_preview",
            "ai_compact",
        ] {
            let body = named(name).join("\n");
            assert!(body.contains("model_info_in("), "{name} reads twice");
            assert!(!body.contains(".model_info("), "{name} reads twice");
        }
    }

    #[test]
    fn the_rules_see_the_commands() {
        let names: Vec<String> = bodies().into_iter().map(|(n, _)| n).collect();
        for want in ["ai_models", "ai_ask_stream", "ai_preview", "ai_diagram_ask"] {
            assert!(names.iter().any(|n| n == want), "{want}");
        }
    }
}
