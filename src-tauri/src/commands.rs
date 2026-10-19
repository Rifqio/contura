use contura_core::Error;
use contura_core::ai::{
    AiAccess, AiAnswer, AiRequest, AiService, AiSettings, AiSettingsView, AiTestOk, AiThread,
    KeyChange, ThreadId,
};
use contura_core::connections::{
    ConnectionInput, ConnectionService, DataFolderInfo, DesignVerdict, EditOutcome, EditPlan,
    GroupInput,
};
use contura_core::design::{DesignOutcome, DesignRequest, TableDesign};
use contura_core::edits::EditSet;
use contura_core::explain::Plan;
use contura_core::model::{
    ConnectionConfig, ConnectionId, DbObject, DialectKind, FullValue, FullValueRequest, Group,
    GroupId, KeymapOverrides, ObjectKind, ObjectPath, Page, PageRequest, SchemaInfo, UiPrefs,
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

use tauri::State;

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

#[tauri::command]
pub async fn delete_connection(service: Service<'_>, id: ConnectionId) -> Result<(), Error> {
    service.delete(id).await
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

#[tauri::command]
pub fn clear_query_history(service: Service<'_>, id: Option<ConnectionId>) -> Result<(), Error> {
    service.clear_query_history(id)
}

#[tauri::command]
pub fn saved_query_runs(service: Service<'_>) -> Result<Vec<SavedQueryRun>, Error> {
    service.saved_query_runs()
}

#[tauri::command]
pub fn data_folder_info(service: Service<'_>) -> Result<DataFolderInfo, Error> {
    service.data_folder_info()
}

/// Shows the data folder in Explorer.
#[tauri::command]
pub fn open_data_folder(data: State<'_, DataDir>) -> Result<(), Error> {
    std::process::Command::new("explorer.exe")
        .arg(&data.0)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::File(e.to_string()))
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

#[tauri::command]
pub fn save_saved_query(service: Service<'_>, input: SavedQueryInput) -> Result<SavedQuery, Error> {
    service.save_saved_query(input)
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
pub fn ai_settings(ai: Ai<'_>, group_id: Option<GroupId>) -> Result<AiSettingsView, Error> {
    ai.settings(group_id)
}

#[tauri::command]
pub fn save_ai_settings(
    ai: Ai<'_>,
    group_id: Option<GroupId>,
    settings: AiSettings,
    override_group: bool,
    key: KeyChange,
) -> Result<(), Error> {
    ai.save_settings(group_id, settings, override_group, key)
}

#[tauri::command]
pub fn ai_test(ai: Ai<'_>, group_id: Option<GroupId>) -> Result<AiTestOk, Error> {
    ai.test(group_id)
}

#[tauri::command]
pub fn list_ai_threads(ai: Ai<'_>, place: String) -> Result<Vec<AiThread>, Error> {
    ai.list_threads(&place)
}

#[tauri::command]
pub fn save_ai_thread(ai: Ai<'_>, thread: AiThread) -> Result<(), Error> {
    ai.save_thread(&thread)
}

#[tauri::command]
pub fn delete_ai_thread(ai: Ai<'_>, id: ThreadId) -> Result<(), Error> {
    ai.delete_thread(id)
}

#[tauri::command]
pub fn clear_ai_threads(ai: Ai<'_>, place: String) -> Result<(), Error> {
    ai.clear_threads(&place)
}

#[tauri::command]
pub fn ai_ask(
    ai: Ai<'_>,
    group_id: Option<GroupId>,
    request: AiRequest,
) -> Result<AiAnswer, Error> {
    ai.ask(group_id, &request)
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
