mod commands;
mod db;
mod extension_server;
mod pack;
mod palette;
mod tags;
mod vault;

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::{FeedbackQueueState, TagCountBackfillState};
use crate::db::Db;
use crate::vault::{ensure_vault, get_vault_paths, write_vault_readme};

const TRAY_OPEN_ID: &str = "tray_open_qooti";
const TRAY_NOTIFICATIONS_ID: &str = "tray_toggle_notifications_qooti";
const TRAY_QUIT_ID: &str = "tray_quit_qooti";
const PREF_TRAY_NOTIFICATIONS_ENABLED: &str = "trayNotificationsEnabled";

struct AppBackgroundState {
    allow_quit: AtomicBool,
    notifications_enabled: AtomicBool,
}

fn show_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn read_pref_bool(db: &Arc<Db>, key: &str, default: bool) -> bool {
    let conn = db.conn();
    conn.query_row("SELECT value FROM preferences WHERE key = ?", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .map(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
    .unwrap_or(default)
}

fn write_pref_bool(db: &Arc<Db>, key: &str, value: bool) {
    let conn = db.conn();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)",
        rusqlite::params![key, if value { "true" } else { "false" }],
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            match app.path().app_log_dir() {
                Ok(log_dir) => {
                    if let Err(err) = std::fs::create_dir_all(&log_dir) {
                        log::warn!("[logging] failed to create app log dir {:?}: {}", log_dir, err);
                    } else {
                        commands::configure_app_log_dir(log_dir.clone());
                        log::info!("[logging] app log dir ready at {}", log_dir.display());
                    }
                }
                Err(err) => {
                    log::warn!("[logging] app_log_dir not available from path resolver: {}", err);
                }
            }
            let vault_paths = get_vault_paths(app.handle())?;
            ensure_vault(&vault_paths)?;
            let vault = Arc::new(vault_paths);

            let database = Db::open(&vault.db_path)?;
            {
                let conn = database.conn();
                commands::ensure_extension_key(&*conn).map_err(|e| e.to_string())?;
            }
            let db = Arc::new(database);
            write_vault_readme(&vault.root);
            let _ = commands::migrate_vault_filenames_to_uuid(&db, &vault);

            let extension_queue = extension_server::ExtensionQueue(Arc::new(
                std::sync::Mutex::new(std::collections::VecDeque::new()),
            ));
            extension_server::spawn(vault.db_path.clone(), extension_queue.0.clone());
            app.manage(extension_queue);

            let notifications_enabled = read_pref_bool(&db, PREF_TRAY_NOTIFICATIONS_ENABLED, true);
            app.manage(db.clone());
            app.manage(vault);
            app.manage(TagCountBackfillState(Arc::new(AtomicBool::new(false))));
            let feedback_queue_state = FeedbackQueueState::new();
            commands::start_feedback_delivery_worker(db.clone(), feedback_queue_state.clone());
            app.manage(feedback_queue_state);
            app.manage(AppBackgroundState {
                allow_quit: AtomicBool::new(false),
                notifications_enabled: AtomicBool::new(notifications_enabled),
            });

            let tray_open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Qooti", true, None::<&str>)?;
            let tray_notifications = CheckMenuItem::with_id(
                app,
                TRAY_NOTIFICATIONS_ID,
                "Enable notifications",
                true,
                notifications_enabled,
                None::<&str>,
            )?;
            let tray_quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Qooti", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&tray_open, &tray_notifications, &tray_quit])?;

            let mut tray_builder = TrayIconBuilder::with_id("qooti-tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event({
                    let tray_notifications = tray_notifications.clone();
                    move |app, event: MenuEvent| match event.id().as_ref() {
                        TRAY_OPEN_ID => show_main_window(app),
                        TRAY_NOTIFICATIONS_ID => {
                            let app_state = app.state::<AppBackgroundState>();
                            let next = !app_state.notifications_enabled.load(Ordering::Relaxed);
                            app_state
                                .notifications_enabled
                                .store(next, Ordering::Relaxed);
                            let _ = tray_notifications.set_checked(next);
                            let db = app.state::<Arc<Db>>().inner().clone();
                            write_pref_bool(&db, PREF_TRAY_NOTIFICATIONS_ENABLED, next);
                        }
                        TRAY_QUIT_ID => {
                            let app_state = app.state::<AppBackgroundState>();
                            app_state.allow_quit.store(true, Ordering::Relaxed);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray: &TrayIcon<_>, event: TrayIconEvent| match event {
                    TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder.build(app)?;

            // Always enable logging for debugging "actions stop after first use" (logs to stderr / devtools)
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("qooti".to_string()),
                        }),
                    ])
                    .build(),
            )?;

            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match updater_handle.updater() {
                    Ok(updater) => match updater.check().await {
                        Ok(update) => {
                            log::info!(
                                "[Updater] startup check ok; update available={}",
                                update.is_some()
                            );
                        }
                        Err(err) => {
                            log::error!("[Updater] startup check failed: {}", err);
                        }
                    },
                    Err(err) => {
                        log::error!("[Updater] startup updater init failed: {}", err);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_state = window.app_handle().state::<AppBackgroundState>();
                if !app_state.allow_quit.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_inspirations,
            commands::list_inspirations_history,
            commands::list_collections,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::set_collection_visible_on_home,
            commands::set_collection_profile_image,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::get_collections_for_inspiration,
            commands::export_collection_as_pack,
            commands::select_collection_pack_file,
            commands::inspect_collection_pack,
            commands::import_collection_pack,
            commands::select_telegram_export_folder,
            commands::inspect_telegram_export,
            commands::import_telegram_export,
            commands::select_notion_export_zip,
            commands::inspect_notion_export_zip,
            commands::import_notion_export_zip,
            commands::list_notifications,
            commands::get_unread_notification_count,
            commands::mark_notifications_read,
            commands::create_admin_notification,
            commands::get_app_info,
            commands::get_preference,
            commands::set_preference,
            commands::get_survey_completed,
            commands::set_survey_completed,
            commands::get_survey_data,
            commands::save_survey_data,
            commands::clear_survey_data,
            commands::get_settings,
            commands::get_license_cache,
            commands::validate_license,
            commands::check_current_license_with_server,
            commands::refresh_license_status,
            commands::clear_license_cache,
            commands::open_folder,
            commands::open_external_url,
            commands::window_close,
            commands::window_hide,
            commands::window_quit,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_unmaximize,
            commands::window_is_maximized,
            commands::open_devtools,
            commands::copy_file_to_clipboard,
            commands::fetch_link_preview,
            commands::fetch_notion_gallery,
            commands::add_link_inspiration,
            commands::delete_inspiration,
            commands::clear_all_media,
            commands::update_inspiration,
            commands::download_video_from_url,
            commands::add_inspirations_from_paths,
            commands::import_media_from_paths,
            commands::add_inspirations_from_files,
            commands::add_thumbnail_from_url,
            commands::add_media_from_url,
            commands::add_thumbnail_from_video_url,
            commands::list_tags,
            commands::get_top_tags,
            commands::get_tag_count_status,
            commands::ensure_tag_counts_initialized,
            commands::create_user_tag,
            commands::rename_tag,
            commands::attach_tag_to_inspiration,
            commands::detach_tag_from_inspiration,
            commands::extract_palette,
            commands::extract_ocr_text,
            commands::claim_ocr_index_candidates,
            commands::finalize_ocr_index_result,
            commands::reset_ocr_status_for_inspiration,
            commands::queue_full_ocr_reindex,
            commands::get_ocr_index_stats,
            commands::get_inspiration_ocr_debug,
            commands::find_similar,
            commands::get_absolute_path_for_file,
            commands::read_image_as_base64,
            commands::get_extension_connection_status,
            commands::get_extension_key_for_copy,
            commands::regenerate_extension_key,
            commands::get_extension_pending,
            commands::submit_feedback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
