mod appenv;
mod automation;
mod claude;
mod claude_hooks;
mod daemons;
mod dap;
mod files;
pub mod platform;
mod fs;
mod git;
mod godot;
mod gradle;
mod hotswap;
mod jdwp;
mod jdwp_dbg;
mod location;
mod media;
mod lsp;
mod menu;
mod migrate;
mod procs;
mod pstore;
mod python;
mod pty;
mod remote;
mod runner;
mod search;
mod studio_bridge;
mod termext;
mod uiprefs;
mod windows;

pub use location::Location;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate::run(); // copy pre-rename Atelier data to the Ace locations (once) before anything reads app data
    procs::install();
    let mut context = tauri::generate_context!();
    // Harness runs must never talk to a real Ace: with automation on, the single-instance socket is derived from the
    // automation socket path (or ACE_INSTANCE_ID), so only processes sharing that socket form one instance.
    if let Some(id) = instance_id() {
        context.config_mut().identifier = format!("com.alexw.ace.{id}");
    }
    tauri::Builder::default()
        // Must be the first plugin: a second `ace <path>` hands its argv to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| windows::on_second_instance(app, argv, cwd)))
        .setup(|app| {
            menu::install(app.handle())?;
            automation::start(app.handle());
            // == studio_bridge ==
            studio_bridge::start(app.handle());
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
            fs::fs_copy,
            files::fs_trash,
            files::files_clipboard_write,
            files::files_clipboard_read,
            files::files_reveal,
            files::files_open,
            fs::fs_create_dir,
            fs::fs_home,
            fs::bytes::fs_read_bytes,
            fs::bytes::fs_probe,
            media::audio_decode_wav,
            media::audio_info,
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
            // == studio_bridge ==
            studio_bridge::studio_bridge_result,
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
            git::git_ls_files,
            git::git_stash_push,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_repo_state,
            git::git_resolve,
            git::git_rebase,
            git::git_merge_abort,
            git::git_user,
            git::git_gh,
            git::git_fetch_quiet,
            git::git_incoming,
            git::git_worktree_list,
            git::git_worktree_status,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
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
            claude_hooks::claude_hook_channel,
            claude_hooks::claude_turn_info,
            claude_hooks::claude_fallback_set,
            claude_hooks::claude_follow,
            claude_hooks::claude_unfollow,
            claude_hooks::claude_note_shown,
            claude_hooks::claude_note_claim,
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
            // == uiprefs == (global colour scheme)
            uiprefs::ui_pref_get,
            uiprefs::ui_pref_set,
            // == gradle ==
            gradle::gradle_fingerprint,
            gradle::gradle_discover,
            gradle::gradle_cancel,
            gradle::gradle_soft_stop,
            hotswap::hotswap_jdks,
            hotswap::gradle_debug_prepare,
            hotswap::gradle_debug_cleanup,
            hotswap::hotswap_run,
            hotswap::hotswap_dump,
            hotswap::hotswap_forget,
            jdwp::jdwp_free_port,
            jdwp::jdwp_attach,
            jdwp::jdwp_detach,
            jdwp::jdwp_kill_game,
            jdwp::jdwp_info,
            jdwp::jdwp_events,
            jdwp_dbg::jdwp_breakpoints,
            jdwp_dbg::jdwp_threads,
            jdwp_dbg::jdwp_stack,
            jdwp_dbg::jdwp_scopes,
            jdwp_dbg::jdwp_variables,
            jdwp_dbg::jdwp_resume,
            jdwp_dbg::jdwp_suspend,
            jdwp_dbg::jdwp_step,
            // == python == (run configs, interpreters, debugger, packages: docs/PYTHON.md)
            pstore::pstore_get,
            pstore::pstore_set,
            runner::run_start,
            runner::run_write,
            runner::run_close_stdin,
            runner::run_stop,
            runner::run_interrupt,
            runner::run_alive,
            runner::proc_exec,
            dap::dap_start,
            dap::dap_send,
            dap::dap_stop,
            python::py_discover,
            python::py_probe,
            python::py_tools,
            python::py_create_venv,
            python::py_create_conda,
            python::py_pypi_search,
            python::py_pypi_info,
            python::py_scripts_dir,
            python::py_script_source,
            python::py_filter,
            // == godot == (docs/GODOT.md)
            godot::godot_find,
            godot::godot_scan,
            godot::godot_scenes_using,
            godot::godot_changed_scripts,
            godot::godot_dbg_listen,
            godot::godot_dbg_send,
            godot::godot_dbg_close,
            godot::godot_open_editor,
        ])
        .build(context)
        .expect("error while building Ace")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if windows::on_exit_requested(app, code) {
                    api.prevent_exit();
                }
            }
            // macOS open-file events: `open -a Ace <folder>`, a folder dropped on the Dock icon.
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
    if let Ok(id) = crate::appenv::var("ACE_INSTANCE_ID") {
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
