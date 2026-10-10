mod claude;
mod daemons;
mod fs;
mod git;
mod location;
mod lsp;
mod procs;
mod pty;
mod remote;
mod search;

pub use location::Location;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            // == pty ==
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
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
            lsp::lsp_send,
            lsp::lsp_stop,
            // == claude ==
            claude::claude_sessions,
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
        .build(tauri::generate_context!())
        .expect("error while building Atelier")
        .run(|_app, event| {
            // Kill every tracked child (pty, ssh, LSP, claude) when the app exits.
            if let tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } = event {
                procs::kill_all();
                remote::ssh::close_all();
            }
        });
}
