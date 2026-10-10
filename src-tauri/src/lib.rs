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
            fs::watch::fs_watch,
            fs::watch::fs_unwatch,
            procs::procs_list,
            procs::procs_kill,
            // == pty ==
            // == search ==
            // == git ==
            // == lsp ==
            // == claude ==
            // == remote ==
            remote::ssh::remote_hosts,
            // == daemons ==
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
