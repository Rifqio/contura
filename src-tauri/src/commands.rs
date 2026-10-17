use contura_core::Error;
use contura_core::ai::{
    AiAccess, AiAnswer, AiRequest, AiService, AiSettings, AiSettingsView, AiTestOk, AiThread,
    KeyChange, ThreadId,
};
use contura_core::connections::{ConnectionInput, ConnectionService, GroupInput};
use contura_core::model::{
    ConnectionConfig, ConnectionId, DbObject, FullValue, FullValueRequest, Group, GroupId,
    ObjectKind, ObjectPath, Page, PageRequest, SchemaInfo,
};
use contura_core::query::{
    Execution, HistoryEntry, HistoryFilter, MoreRows, QuerySessionId, SavedQuery, SavedQueryId,
    SavedQueryInput,
};
use contura_core::schema_model::SchemaModel;
use contura_core::sql_schema::SqlSchema;
use contura_core::suggest::SuggestedConnection;
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
pub async fn open_connection(service: Service<'_>, id: ConnectionId) -> Result<(), Error> {
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
pub fn read_model_files(path: PathBuf) -> Result<contura_core::model_files::ModelFiles, Error> {
    contura_core::model_files::read_model_files(&path)
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
pub fn create_sqlite_database(path: PathBuf) -> Result<(), Error> {
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
) -> Result<Execution, Error> {
    service.execute_sql(session, sql).await
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
    id: ConnectionId,
    filter: HistoryFilter,
) -> Result<Vec<HistoryEntry>, Error> {
    service.query_history(id, filter)
}

#[tauri::command]
pub fn clear_query_history(service: Service<'_>, id: ConnectionId) -> Result<(), Error> {
    service.clear_query_history(id)
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
