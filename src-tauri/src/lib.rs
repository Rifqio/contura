mod browser;
mod commands;
mod fatal;
mod folders;
mod job_commands;
mod paths;
mod window_size;

use std::sync::Arc;

use contura_core::ai::{AiProviderKind, AiService};
use contura_core::connections::ConnectionService;
use contura_core::secrets::{self, DeferredSecretStore, KeyringSecretStore, SecretStore};
use contura_core::store::AppStore;
use tauri::{Manager, RunEvent, WebviewWindowBuilder, window::Color};

/// The longest quitting waits for running queries and jobs to stop.
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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
            commands::set_ai_sync_mode,
            commands::ai_context_changed,
            commands::ai_clear_context,
            commands::ai_context_status,
            commands::ai_resync,
            commands::ai_clear_all,
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
            commands::list_diagrams,
            commands::read_diagram,
            commands::list_flow_table_links,
            commands::write_diagram,
            commands::write_diagram_layout,
            commands::delete_diagram,
            commands::rename_diagram,
            commands::save_diagram_copy,
            commands::icon_index,
            commands::icon_sets,
            commands::icon,
            commands::open_url,
            commands::write_binary_file,
            commands::list_groups,
            commands::save_group,
            commands::delete_group,
            commands::set_group_image,
            commands::clear_group_image,
            commands::group_image,
            commands::move_connection,
            commands::last_group,
            commands::set_last_group,
            commands::ui_prefs,
            commands::save_ui_prefs,
            commands::keymap,
            commands::save_keymap,
            commands::recent_items,
            commands::record_recent,
            commands::create_sqlite_database,
            commands::open_query_session,
            commands::execute_sql,
            commands::visual_query_sql,
            commands::run_visual_query,
            commands::prepare_run,
            commands::confirm_run,
            commands::plan_edits,
            commands::confirm_edits,
            commands::apply_edits,
            commands::table_design,
            commands::table_ddl,
            commands::lineage,
            commands::view_dependencies,
            commands::read_lineage_layout,
            commands::write_lineage_layout,
            commands::delete_lineage_layout,
            commands::plan_design,
            commands::confirm_design,
            commands::apply_design,
            commands::forget_recent,
            commands::classify_sql,
            commands::explain_statement,
            commands::fetch_more_rows,
            commands::cancel_query,
            commands::close_query_result,
            commands::close_query_session,
            commands::query_history,
            commands::clear_query_history,
            commands::saved_query_runs,
            commands::data_folder_info,
            commands::open_data_folder,
            commands::secret_store_kind,
            commands::clear_recent,
            commands::restore_recent,
            commands::connection_opened_times,
            commands::list_saved_queries,
            commands::save_saved_query,
            commands::delete_saved_query,
            commands::load_query_tabs,
            commands::save_query_tabs,
            commands::ai_settings,
            commands::save_ai_settings,
            commands::ai_confirm_key_host,
            commands::ai_test,
            commands::ai_models,
            commands::ai_known_models,
            commands::set_ai_model_prefs,
            commands::ai_record_action,
            commands::ai_ask_stream,
            commands::ai_cancel,
            commands::ai_cancel_place,
            commands::ai_compact,
            commands::ai_undo_compact,
            commands::ai_preview,
            commands::ai_diagram_preview,
            commands::ai_diagram_ask,
            commands::ai_record_tool_result,
            commands::ai_recent_tool_uses,
            commands::list_ai_threads,
            commands::get_ai_thread,
            commands::ai_answer_record,
            commands::ai_search_threads,
            commands::save_ai_thread,
            commands::delete_ai_thread,
            commands::clear_ai_threads,
            job_commands::preview_export,
            job_commands::start_export,
            job_commands::inspect_import_file,
            job_commands::plan_import,
            job_commands::check_import_file,
            job_commands::confirm_import,
            job_commands::start_import,
            job_commands::plan_script,
            job_commands::script_statements,
            job_commands::confirm_script,
            job_commands::start_script,
            job_commands::plan_transfer,
            job_commands::transfer_sample,
            job_commands::confirm_transfer,
            job_commands::start_transfer,
            job_commands::plan_backup,
            job_commands::start_backup,
            job_commands::compare_schemas,
            job_commands::compare_ddl,
            job_commands::plan_sync,
            job_commands::confirm_sync,
            job_commands::apply_sync,
            job_commands::inspect_restore,
            job_commands::plan_restore,
            job_commands::restore_statements,
            job_commands::confirm_restore,
            job_commands::start_restore,
            job_commands::cancel_job,
            job_commands::list_jobs,
            job_commands::job_events,
            job_commands::reveal_in_folder,
            job_commands::read_text_file,
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
        // when it next writes: stop running queries and jobs first so they do not
        // commit (Q22). Quitting never waits on a server longer than EXIT_WAIT.
        if let RunEvent::ExitRequested { .. } = event
            && let Some(service) = handle.try_state::<ConnectionService>()
        {
            tauri::async_runtime::block_on(service.stop_everything(EXIT_WAIT));
        }
    });
}

/// Copies secrets saved under the old "DB View" service to "Contura". Never blocks start-up:
/// a failure leaves the old entry in place and the app runs with whatever it can read.
fn migrate_legacy_secrets(store: &AppStore, current: &dyn SecretStore) {
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

/// On Linux the keyring (the Secret Service) is checked on another thread with a time
/// limit while the window opens. When it is missing or does not answer, secrets are kept
/// in memory until Contura closes, and the legacy migration is skipped. Elsewhere the
/// keyring is opened here as before, and an error stops start-up.
#[cfg(target_os = "linux")]
fn secret_store(
    _store: &AppStore,
    db: std::path::PathBuf,
) -> Result<DeferredSecretStore, Box<dyn std::error::Error>> {
    Ok(DeferredSecretStore::spawn(move || {
        let chosen = secrets::choose_secret_store(
            KeyringSecretStore::new_checked,
            secrets::KEYRING_PROBE_LIMIT,
        );
        if chosen.kind == secrets::SecretStoreKind::Keyring
            && let Ok(store) = AppStore::open(&db)
        {
            migrate_legacy_secrets(&store, chosen.store.as_ref());
        }
        chosen
    }))
}

#[cfg(not(target_os = "linux"))]
fn secret_store(
    store: &AppStore,
    _db: std::path::PathBuf,
) -> Result<DeferredSecretStore, Box<dyn std::error::Error>> {
    let keyring = KeyringSecretStore::new()?;
    migrate_legacy_secrets(store, &keyring);
    Ok(DeferredSecretStore::ready(secrets::ChosenSecretStore {
        store: Arc::new(keyring),
        kind: secrets::SecretStoreKind::Keyring,
    }))
}

fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = paths::data_dir()?;
    let store = AppStore::open(&data_dir.join("app.sqlite"))?;
    let secrets = Arc::new(secret_store(&store, data_dir.join("app.sqlite"))?);
    app.manage(commands::Secrets(secrets.clone()));
    let ai_store = AppStore::open(&data_dir.join("app.sqlite"))?;
    app.manage(AiService::new(ai_store, secrets.clone()));
    app.manage(ConnectionService::new(store, secrets).with_data_dir(data_dir.clone()));
    app.manage(commands::DataDir(data_dir.clone()));
    // tauri.conf.json's "main" entry (create: false) holds the title, the size and its
    // minimum, and decorations off: the app draws its own title bar (TitleBar.tsx).
    let main = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .ok_or("tauri.conf.json has no main window")?
        .clone();
    let mut builder = WebviewWindowBuilder::from_config(app, &main)?
        // Dracula's --c-bg-app, so the window is not white before the page paints.
        .background_color(Color(25, 26, 33, 255))
        .data_directory(data_dir.join("webview"));
    // 1280 x 800 CSS pixels at any display scaling and Text size, shrunk to the work area
    // of the primary monitor, where the window opens. Set on the builder, not with
    // set_size after build: tao measures the frame of a hidden undecorated window wrongly
    // and the client area came out 30 px taller.
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let area = monitor.work_area().size;
        let scale = monitor.scale_factor();
        let (width, height) =
            window_size::start_size(area.width, area.height, scale, window_size::text_scale());
        builder = builder
            .inner_size(f64::from(width) / scale, f64::from(height) / scale)
            .center();
    }
    builder.build()?;
    Ok(())
}
