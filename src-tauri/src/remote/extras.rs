//! chmod, disk usage, bookmarks, and the two-pane browser's listing command (local + remote, with modes).
use super::{ops, run, ssh};
use crate::location::Location;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// List a directory (local or remote) including permission bits, for the Remote Files panes.
#[tauri::command]
pub async fn remote_list_dir(loc: Location) -> Result<Vec<ops::RichEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !loc.is_local() {
            return ops::list_rich(&loc.host, &loc.path);
        }
        use std::os::unix::fs::PermissionsExt;
        let mut v = Vec::new();
        for ent in std::fs::read_dir(&loc.path).map_err(|e| format!("{}: {e}", loc.path))?.flatten() {
            let p = ent.path();
            let l = std::fs::symlink_metadata(&p).ok();
            let m = std::fs::metadata(&p).ok().or(l.clone());
            let Some(m) = m else { continue };
            v.push(ops::RichEntry {
                name: ent.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                is_dir: m.is_dir(),
                is_symlink: l.map(|l| l.file_type().is_symlink()).unwrap_or(false),
                size: m.len(),
                modified: m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
                mode: m.permissions().mode() & 0o7777,
            });
        }
        v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remote_home(host: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ops::home(&host)).await.map_err(|e| e.to_string())?
}

/// `mode` is an octal string such as "644" or "u+x".
#[tauri::command]
pub async fn remote_chmod(loc: Location, mode: String, recursive: bool) -> Result<(), String> {
    if mode.is_empty() || !mode.chars().all(|c| c.is_ascii_alphanumeric() || "+-=,".contains(c)) {
        return Err(format!("invalid mode: {mode}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if loc.is_local() {
            let mut c = std::process::Command::new("chmod");
            if recursive { c.arg("-R"); }
            let o = c.arg(&mode).arg("--").arg(&loc.path).output().map_err(|e| e.to_string())?;
            return if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) };
        }
        let r = run(&loc.host, &format!("chmod {}{} -- {}", if recursive { "-R " } else { "" }, mode, ssh::quote(&loc.path))).map(|_| ());
        ops::invalidate(&loc.host, &loc.path);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

#[tauri::command]
pub async fn remote_disk_usage(loc: Location) -> Result<DiskUsage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run(&loc.host, &format!("df -B1 --output=size,used,avail -- {} | tail -n1", ssh::quote(&loc.path)))?;
        let t = String::from_utf8_lossy(&out);
        let n: Vec<u64> = t.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if n.len() < 3 { return Err("unexpected df output".into()); }
        Ok(DiskUsage { total: n[0], used: n[1], avail: n[2] })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub host: String,
    pub path: String,
    pub name: String,
}

fn bm_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let d = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("remote-bookmarks.json"))
}

#[tauri::command]
pub fn remote_bookmarks_get(app: AppHandle) -> Vec<Bookmark> {
    bm_file(&app).ok().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn remote_bookmarks_set(app: AppHandle, bookmarks: Vec<Bookmark>) -> Result<(), String> {
    std::fs::write(bm_file(&app)?, serde_json::to_string_pretty(&bookmarks).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
