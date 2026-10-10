//! Local watcher. Emits `fs://changed` with `{ root: string, paths: string[], kind: string }`.
use crate::location::Location;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatchState(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct Changed {
    root: String,
    paths: Vec<String>,
    kind: String,
}

fn noisy(p: &str) -> bool {
    ["/node_modules/", "/target/", "/.godot/", "/dist/"].iter().any(|n| p.contains(n))
}

#[tauri::command]
pub fn fs_watch(app: AppHandle, state: State<WatchState>, loc: Location) -> Result<(), String> {
    if !loc.is_local() {
        return crate::remote::watch::watch(app, loc);
    }
    let root = loc.path.clone();
    let mut map = state.0.lock().unwrap();
    if map.contains_key(&root) {
        return Ok(());
    }
    let emit_root = root.clone();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let paths: Vec<String> = ev
                .paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !noisy(p))
                .collect();
            if paths.is_empty() {
                return;
            }
            let kind = match ev.kind {
                EventKind::Create(_) => "create",
                EventKind::Remove(_) => "remove",
                EventKind::Modify(_) => "modify",
                _ => "other",
            };
            let _ = app.emit("fs://changed", Changed { root: emit_root.clone(), paths, kind: kind.into() });
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(std::path::Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    map.insert(root, w);
    Ok(())
}

#[tauri::command]
pub fn fs_unwatch(state: State<WatchState>, loc: Location) -> Result<(), String> {
    if !loc.is_local() {
        crate::remote::watch::unwatch(&loc);
        return Ok(());
    }
    state.0.lock().unwrap().remove(&loc.path);
    Ok(())
}
