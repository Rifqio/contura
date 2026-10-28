mod browser;
mod commands;
mod fatal;
mod folders;
mod job_commands;
#[cfg(target_os = "linux")]
mod paste_guard;
mod paths;
mod updater;
mod window_size;

use std::sync::Arc;

use contura_core::ai::{AiProviderKind, AiService};
use contura_core::connections::ConnectionService;
use contura_core::secrets::{self, DeferredSecretStore, KeyringSecretStore, SecretStore};
use contura_core::store::AppStore;
use contura_core::update::UpdateService;
use tauri::{Manager, RunEvent, WebviewWindowBuilder, WindowEvent, window::Color};

/// The longest quitting waits for running queries and jobs to stop.
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A start made by an update waits for the old process to exit first. The old one
    // released its single-instance lock before starting this one; the data folder lock
    // (`start`) covers it until it has gone.
    updater::wait_for_previous();
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
        // The minimum window follows the monitor the window is on and Windows Text size: a
        // move can change both, focus comes back after Settings, and a resize lands a minimum
        // held back while the window was maximized. Not in ScaleFactorChanged: tao applies its
        // own new size right after it, and the Moved or Resized that follows refits instead.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let refit = matches!(
                event,
                WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(true)
            );
            if let (true, Some(fit)) = (refit, window.try_state::<window_size::WindowFit>()) {
                window_size::refit(window, &fit, window_size::Refit::Grow);
            }
        })
        .invoke_handler(tauri::generate_handler![
            window_size::set_interface_size,
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
            commands::count_rows,
            commands::locate_row,
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
            commands::first_start_guide,
            commands::first_start_guide_seen,
            commands::ui_prefs,
            commands::save_ui_prefs,
            commands::keymap,
            commands::save_keymap,
            commands::recent_items,
            commands::record_recent,
            commands::create_sqlite_database,
            commands::open_query_session,
            commands::execute_sql,
            commands::restore_script_sql_mode,
            commands::visual_query_sql,
            commands::run_visual_query,
            commands::plan_run,
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
            commands::column_orders,
            commands::save_column_order,
            commands::ai_settings,
            commands::save_ai_settings,
            commands::ai_confirm_key_host,
            commands::ai_test,
            commands::ai_models,
            commands::ai_known_models,
            commands::set_ai_model_prefs,
            commands::ai_record_action,
            commands::ai_thread_work,
            commands::ai_ask_stream,
            commands::ai_cancel,
            commands::ai_cancel_place,
            commands::ai_compact,
            commands::ai_name_chat,
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
            commands::ai_rename_thread,
            commands::save_ai_thread,
            commands::ai_append_turn,
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
            updater::update_status,
            updater::set_update_checks,
            updater::check_for_update,
            updater::download_update,
            updater::restart_to_update,
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
    // One Contura per data folder: a start made by an update waits for the old process to
    // let go of it; any other start waits briefly, then says another Contura has it.
    if let Some(lock) = paths::lock_data_dir(&data_dir, updater::data_lock_wait())? {
        app.manage(lock);
    }
    let store = AppStore::open(&data_dir.join("app.sqlite"))?;
    let secrets = Arc::new(secret_store(&store, data_dir.join("app.sqlite"))?);
    app.manage(commands::Secrets(secrets.clone()));
    let ai_store = AppStore::open(&data_dir.join("app.sqlite"))?;
    // A step purge a Connection delete left pending runs here (bounded by the thread caps).
    app.manage(AiService::open(ai_store, secrets.clone()));
    app.manage(ConnectionService::new(store, secrets).with_data_dir(data_dir.clone()));
    app.manage(commands::DataDir(data_dir.clone()));
    let (kind, target) = updater::install_target();
    app.manage(UpdateService::new(
        AppStore::open(&data_dir.join("app.sqlite"))?,
        &app.package_info().version.to_string(),
        kind,
        target,
    ));
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
    // The saved Interface size; usePrefs follows later changes through set_interface_size.
    let zoom = app
        .state::<ConnectionService>()
        .ui_prefs()
        .map(|p| p.interface_size.zoom())
        .unwrap_or(1.0);
    // 1280 x 800 CSS pixels at any display scaling and Text size, shrunk to the work area
    // of the primary monitor, where the window opens. Set on the builder, not with
    // set_size after build: tao measures the frame of a hidden undecorated window wrongly
    // and the client area came out 30 px taller. The minimum, 1024 x 480 CSS pixels under
    // Windows Text size and the Interface size, goes on the builder for the same reason.
    // The opening size is never under it: 1280 x 800 is 1024 x 640 at 125 percent.
    let text_scale = window_size::text_scale();
    let mut min_size = None;
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let area = monitor.work_area().size;
        let scale = monitor.scale_factor();
        let (width, height) = window_size::start_size(area.width, area.height, scale, text_scale);
        let (min_width, min_height) =
            window_size::min_size(area.width, area.height, scale, text_scale, zoom);
        builder = builder
            .inner_size(f64::from(width) / scale, f64::from(height) / scale)
            .min_inner_size(min_width, min_height)
            .center();
        min_size = Some((min_width, min_height));
    }
    // Display scale changes, monitor moves and focus refit the minimum (lib.rs on_window_event).
    app.manage(window_size::WindowFit::new(zoom, min_size));
    let window = builder.build()?;
    // WebKitGTK 2.54.0/2.54.1 crash on a paste of an empty selection (paste_guard.rs).
    #[cfg(target_os = "linux")]
    paste_guard::install(&window);
    // Before the page paints.
    if zoom != 1.0 {
        let _ = window.set_zoom(zoom);
    }
    // The window is up: an update's old program file can go.
    updater::cleanup_later(app.handle().clone());
    Ok(())
}
