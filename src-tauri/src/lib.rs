mod commands;
mod fatal;
mod paths;

use std::sync::Arc;

use contura_core::ai::{AiProviderKind, AiService};
use contura_core::connections::ConnectionService;
use contura_core::secrets::{self, KeyringSecretStore};
use contura_core::store::AppStore;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        // First, so a second launch exits before it touches the data folder.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Tauri panics on a setup error, which aborts silently in release: report it, then exit.
            if let Err(e) = start(app) {
                fatal::show_error(&format!(
                    "Contura could not start.

{e}"
                ));
                std::process::exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::set_connection_ai_access,
            commands::delete_connection,
            commands::test_connection,
            commands::suggested_connections,
            commands::open_connection,
            commands::close_connection,
            commands::list_databases,
            commands::list_schemas,
            commands::list_objects,
            commands::object_definition,
            commands::fetch_page,
            commands::fetch_full_value,
            commands::schema_snapshot,
            commands::sql_schema,
            commands::reverse_engineer,
            commands::export_sql,
            commands::read_model_files,
            commands::write_model_files,
            commands::write_text_file,
            commands::write_binary_file,
            commands::list_groups,
            commands::save_group,
            commands::delete_group,
            commands::move_connection,
            commands::last_group,
            commands::set_last_group,
            commands::create_sqlite_database,
            commands::open_query_session,
            commands::execute_sql,
            commands::fetch_more_rows,
            commands::cancel_query,
            commands::close_query_result,
            commands::close_query_session,
            commands::query_history,
            commands::clear_query_history,
            commands::list_saved_queries,
            commands::save_saved_query,
            commands::delete_saved_query,
            commands::load_query_tabs,
            commands::save_query_tabs,
            commands::ai_settings,
            commands::save_ai_settings,
            commands::ai_test,
            commands::ai_ask,
            commands::list_ai_threads,
            commands::save_ai_thread,
            commands::delete_ai_thread,
            commands::clear_ai_threads,
        ])
        .build(tauri::generate_context!());
    let app = match result {
        Ok(app) => app,
        Err(e) => {
            fatal::show_error(&format!(
                "Contura stopped with an error.

{e}"
            ));
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        // Closing the app drops the query connections, but a server only notices
        // when it next writes: stop running queries first so they do not commit.
        if let RunEvent::ExitRequested { .. } = event
            && let Some(service) = handle.try_state::<ConnectionService>()
        {
            tauri::async_runtime::block_on(service.cancel_all_queries());
        }
    });
}

/// Copies secrets saved under the old "DB View" service to "Contura". Never blocks start-up:
/// a failure leaves the old entry in place and the app runs with whatever it can read.
fn migrate_legacy_secrets(store: &AppStore, current: &KeyringSecretStore) {
    let Ok(legacy) = KeyringSecretStore::legacy() else {
        return;
    };
    // An unreadable Connection row must not stop the AI keys from moving over.
    let ids: Vec<_> = store
        .list_connections()
        .map(|cs| cs.iter().map(|c| c.id).collect())
        .unwrap_or_default();
    secrets::migrate_from_legacy(current, &legacy, &ids, &AiProviderKind::key_accounts());
}

fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = paths::data_dir()?;
    let store = AppStore::open(&data_dir.join("app.sqlite"))?;
    let secrets = Arc::new(KeyringSecretStore::new()?);
    migrate_legacy_secrets(&store, &secrets);
    let ai_store = AppStore::open(&data_dir.join("app.sqlite"))?;
    app.manage(AiService::new(ai_store, secrets.clone()));
    app.manage(ConnectionService::new(store, secrets));
    app.manage(commands::DataDir(data_dir.clone()));
    WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Contura")
        .data_directory(data_dir.join("webview"))
        .build()?;
    Ok(())
}
