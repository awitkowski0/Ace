mod automation;
mod claude;
mod daemons;
mod fs;
mod git;
mod location;
mod lsp;
mod menu;
mod procs;
mod pty;
mod remote;
mod search;
mod termext;
mod windows;

pub use location::Location;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    procs::install();
    let mut context = tauri::generate_context!();
    // Harness runs must never talk to a real Atelier: with automation on, the single-instance socket is derived from the
    // automation socket path (or ATELIER_INSTANCE_ID), so only processes sharing that socket form one instance.
    if let Some(id) = instance_id() {
        context.config_mut().identifier = format!("com.alexw.atelier.{id}");
    }
    tauri::Builder::default()
        // Must be the first plugin: a second `atelier <path>` hands its argv to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| windows::on_second_instance(app, argv, cwd)))
        .setup(|app| {
            menu::install(app.handle())?;
            automation::start(app.handle());
            windows::startup(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| windows::on_window_event(window, event))
        .on_menu_event(|app, event| menu::on_event(app, &event.id().0))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // ---- managed state (append one `.manage(...)` line per module under its marker) ----
        .manage(fs::watch::WatchState::default())
        // == pty == (state)
        // == search == (state)
        // == git == (state)
        // == lsp == (state)
        .manage(lsp::LspState::default())
        // == claude == (state)
        // == remote == (state)
        // == daemons == (state)
        // ---- commands: add `module::command_name,` lines ONLY inside your own block ----
        .invoke_handler(tauri::generate_handler![
            // == fs ==
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_stat,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_create_dir,
            fs::fs_home,
            location::launch_location,
            fs::watch::fs_watch,
            fs::watch::fs_unwatch,
            procs::procs_list,
            procs::procs_kill,
            // == windows ==
            windows::win_list,
            windows::win_open_project,
            windows::win_switch_here,
            windows::win_set_project,
            windows::win_focus,
            windows::win_cycle,
            windows::win_new_welcome,
            windows::win_close_confirmed,
            windows::win_close_cancelled,
            windows::win_quit,
            windows::win_debug,
            windows::win_tabbed,
            windows::project_branch,
            // == automation ==
            automation::qa_enabled,
            automation::qa_result,
            // == pty ==
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            pty::pty_busy,
            pty::pty_cwd,
            termext::ghostty_themes,
            termext::ghostty_theme,
            termext::ghostty_config,
            termext::clipboard_write,
            termext::clipboard_read,
            termext::secure_keyboard_entry,
            // == search ==
            search::search_index,
            search::search_files,
            search::search_symbols,
            search::search_text,
            search::search_cancel,
            search::search_replace,
            // == git ==
            git::git_status,
            git::git_show,
            git::git_line_changes,
            git::git_stage,
            git::git_unstage,
            git::git_rollback,
            git::git_commit,
            git::git_commit_body,
            git::git_branches,
            git::git_checkout,
            git::git_delete_branch,
            git::git_stream,
            git::git_log,
            git::git_commit_files,
            git::git_blame,
            // == lsp ==
            lsp::lsp_detect,
            lsp::lsp_start,
            lsp::lsp_prewarm,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_godot_focus,
            // == claude ==
            claude::claude_sessions,
            claude::claude_sessions_cached,
            claude::claude_running,
            claude::claude_watch,
            claude::claude_unwatch,
            claude::claude_reveal,
            // == remote ==
            remote::ssh::remote_hosts,
            remote::extras::remote_list_dir,
            remote::extras::remote_home,
            remote::extras::remote_chmod,
            remote::extras::remote_disk_usage,
            remote::extras::remote_bookmarks_get,
            remote::extras::remote_bookmarks_set,
            remote::transfer::remote_upload,
            remote::transfer::remote_download,
            remote::transfer::remote_cancel,
            remote::watch::remote_watch_dir,
            remote::watch::remote_unwatch_dir,
            // == daemons ==
            daemons::daemons_list,
            daemons::daemons_summary,
            daemons::daemons_stop,
            daemons::daemons_kill,
            daemons::daemons_terminate,
            daemons::daemons_stop_all_gradle,
            daemons::daemons_cleanup_scan,
            daemons::daemons_cleanup_cancel,
            daemons::daemons_cleanup_run,
        ])
        .build(context)
        .expect("error while building Atelier")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if windows::on_exit_requested(app, code) {
                    api.prevent_exit();
                }
            }
            // macOS open-file events: `open -a Atelier <folder>`, a folder dropped on the Dock icon.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => windows::on_opened(app, urls),
            // Quitting (or the signal handler) kills every tracked child (pty, ssh, LSP, claude), whatever window owns it.
            tauri::RunEvent::Ready => windows::activate(app),
            tauri::RunEvent::Exit => {
                procs::kill_all();
                remote::ssh::close_all();
            }
            _ => {}
        });
}

/// Isolation key for automation runs (None in normal use).
fn instance_id() -> Option<String> {
    if let Ok(id) = std::env::var("ATELIER_INSTANCE_ID") {
        if !id.is_empty() {
            return Some(id.chars().filter(|c| c.is_ascii_alphanumeric()).collect());
        }
    }
    if automation::enabled() {
        let sock = automation::sock_path();
        let h = sock.to_string_lossy().bytes().fold(5381u64, |h, b| h.wrapping_mul(33) ^ b as u64);
        return Some(format!("qa{h:x}"));
    }
    None
}
