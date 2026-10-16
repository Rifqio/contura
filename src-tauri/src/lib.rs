mod commands;
mod fatal;
mod paths;

use std::sync::Arc;

use dbview_core::connections::ConnectionService;
use dbview_core::secrets::KeyringSecretStore;
use dbview_core::store::AppStore;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
                    "DB View could not start.

{e}"
                ));
                std::process::exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
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
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        fatal::show_error(&format!(
            "DB View stopped with an error.

{e}"
        ));
        std::process::exit(1);
    }
}

fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = paths::data_dir()?;
    let store = AppStore::open(&data_dir.join("app.sqlite"))?;
    let secrets = Arc::new(KeyringSecretStore::new()?);
    app.manage(ConnectionService::new(store, secrets));
    app.manage(commands::DataDir(data_dir.clone()));
    WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("DB View")
        .data_directory(data_dir.join("webview"))
        .build()?;
    Ok(())
}
