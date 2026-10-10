//! Local watcher. Emits `fs://changed` with `{ root: string, paths: string[], kind: string }` to the windows that
//! watch the root. A watcher per root is shared by every window showing it (reference counted by window label), so
//! two windows on the same root share one inotify/FSEvents stream and closing one keeps the other's alive.
use crate::location::Location;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State, WebviewWindow};

struct Entry {
    _watcher: RecommendedWatcher,
    windows: Arc<Mutex<BTreeSet<String>>>,
}

#[derive(Default)]
pub struct WatchState(Mutex<HashMap<String, Entry>>);

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
pub fn fs_watch(app: AppHandle, window: WebviewWindow, state: State<WatchState>, loc: Location) -> Result<(), String> {
    let label = window.label().to_string();
    if !loc.is_local() {
        return crate::remote::watch::watch(app, &label, loc);
    }
    let root = loc.path.clone();
    let mut map = state.0.lock().unwrap();
    if let Some(e) = map.get(&root) {
        e.windows.lock().unwrap().insert(label);
        return Ok(());
    }
    let windows = Arc::new(Mutex::new(BTreeSet::from([label])));
    let (emit_root, targets) = (root.clone(), windows.clone());
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
            crate::search::notify_changed(&emit_root, &paths); // keep the shared file index fresh
            let labels = targets.lock().unwrap().clone();
            crate::windows::emit_windows(&app, labels.iter(), "fs://changed", Changed { root: emit_root.clone(), paths, kind: kind.into() });
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(std::path::Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    map.insert(root, Entry { _watcher: w, windows });
    Ok(())
}

#[tauri::command]
pub fn fs_unwatch(window: WebviewWindow, state: State<WatchState>, loc: Location) -> Result<(), String> {
    let label = window.label();
    crate::search::release_root(label, &loc);
    if !loc.is_local() {
        crate::remote::watch::unwatch(label, &loc);
        return Ok(());
    }
    let mut map = state.0.lock().unwrap();
    if let Some(e) = map.get(&loc.path) {
        let empty = {
            let mut w = e.windows.lock().unwrap();
            w.remove(label);
            w.is_empty()
        };
        if empty {
            map.remove(&loc.path);
        }
    }
    Ok(())
}

/// A window closed: stop watching for it everywhere (watchers nobody else uses are dropped).
pub fn release_window(label: &str) {
    use tauri::Manager;
    let Some(app) = crate::windows::app() else { return };
    let state = app.state::<WatchState>();
    let mut map = state.0.lock().unwrap();
    map.retain(|_, e| {
        let mut w = e.windows.lock().unwrap();
        w.remove(label);
        !w.is_empty()
    });
}

/// Windows currently watching `root` (tests / diagnostics).
#[allow(dead_code)]
pub fn watchers_of(app: &AppHandle, root: &str) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<WatchState>();
    let map = state.0.lock().unwrap();
    map.get(root).map(|e| e.windows.lock().unwrap().iter().cloned().collect()).unwrap_or_default()
}
