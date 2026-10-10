//! Search & navigation: file index + fuzzy matching, symbols, Find in Files (streamed), replace.
mod index;
mod symbols;
mod text;
#[cfg(test)]
mod bench;

use crate::Location;
use index::{FileResult, Index};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Listener};
use text::{Batch, CancelMap, ReplaceResult, TextOpts};

fn cancels() -> &'static CancelMap {
    static C: OnceLock<CancelMap> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Keep local indexes fresh from the fs watcher (`fs://changed`). Installed once.
fn install_listener(app: &AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        app.listen("fs://changed", |ev| {
            #[derive(serde::Deserialize)]
            struct Ch {
                root: String,
                paths: Vec<String>,
            }
            let Ok(c) = serde_json::from_str::<Ch>(ev.payload()) else { return };
            let Some(ix) = index::existing_for_root(&c.root) else { return };
            for p in &c.paths {
                ix.apply_change(p);
            }
        });
    });
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub count: usize,
    pub elapsed_ms: f64,
}

/// Build (or fetch) the file index for a project root. Cheap when already built.
#[tauri::command]
pub async fn search_index(app: AppHandle, root: Location, rebuild: Option<bool>) -> Result<IndexInfo, String> {
    install_listener(&app);
    blocking(move || {
        let t = std::time::Instant::now();
        if rebuild.unwrap_or(false) {
            index::drop_index(&root);
        }
        let ix = index::get(&root)?;
        Ok::<_, String>(IndexInfo { count: ix.count(), elapsed_ms: t.elapsed().as_secs_f64() * 1000.0 })
    })
    .await?
}

/// Fuzzy file search. `recent` = absolute paths of recently opened files (most recent first).
#[tauri::command]
pub async fn search_files(app: AppHandle, root: Location, query: String, limit: Option<usize>, recent: Option<Vec<String>>) -> Result<FileResult, String> {
    install_listener(&app);
    blocking(move || {
        let ix = index::get(&root)?;
        Ok::<_, String>(index::query_files(&ix, &query, limit.unwrap_or(60), &recent.unwrap_or_default()))
    })
    .await?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolResult {
    pub hits: Vec<symbols::SymHit>,
    pub elapsed_ms: f64,
}

/// kind: "all" | "classes"
#[tauri::command]
pub async fn search_symbols(app: AppHandle, root: Location, query: String, kind: Option<String>, limit: Option<usize>) -> Result<SymbolResult, String> {
    install_listener(&app);
    blocking(move || {
        let ix: Arc<Index> = index::get(&root)?;
        let (hits, elapsed_ms) = symbols::query(&ix, &query, kind.as_deref() == Some("classes"), limit.unwrap_or(60))?;
        Ok::<_, String>(SymbolResult { hits, elapsed_ms })
    })
    .await?
}

/// Start a streamed text search. Results arrive on `search://results/<id>` as `Batch` payloads;
/// the last one has `done: true`. Cancel with `search_cancel(id)`.
#[tauri::command]
pub fn search_text(app: AppHandle, id: f64, root: Location, opts: TextOpts) {
    let cancel = Arc::new(AtomicBool::new(false));
    let slot = Arc::new(Mutex::new(None));
    cancels().lock().unwrap().insert(id as u64, (cancel.clone(), slot.clone()));
    tauri::async_runtime::spawn_blocking(move || {
        let ev = format!("search://results/{}", id as u64);
        let emit = |b: Batch| {
            let _ = app.emit(&ev, b);
        };
        if root.is_local() {
            text::search_local(&root.path, &opts, id, &cancel, &emit);
        } else {
            text::search_remote(&root, &opts, id, &cancel, &slot, &emit);
        }
        cancels().lock().unwrap().remove(&(id as u64));
    });
}

#[tauri::command]
pub fn search_cancel(id: f64) {
    if let Some((flag, slot)) = cancels().lock().unwrap().remove(&(id as u64)) {
        flag.store(true, Ordering::SeqCst);
        if let Some(pid) = slot.lock().unwrap().take() {
            crate::procs::kill(pid);
        }
    }
}

/// Replace in the given absolute files (local roots only).
#[tauri::command]
pub async fn search_replace(root: Location, opts: TextOpts, replacement: String, files: Vec<String>) -> Result<ReplaceResult, String> {
    if !root.is_local() {
        return Err("Replace in Files is only supported for local roots".into());
    }
    blocking(move || text::replace_local(&opts, &replacement, &files)).await?
}
