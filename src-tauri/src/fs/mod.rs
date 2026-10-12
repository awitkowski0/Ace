//! Filesystem abstraction over local + remote backends.
//! Commands take a `Location` and dispatch on `host`.
pub mod local;
pub mod remote;
pub mod watch;
pub mod bytes;

use crate::location::Location;
use serde::{Deserialize, Serialize};

pub type FsResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// ms since epoch
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// Implemented by local (std::fs) and remote (SFTP/ssh) backends. Paths are plain strings
/// interpreted on the backend's own filesystem.
pub trait FsBackend: Send + Sync {
    fn list_dir(&self, path: &str) -> FsResult<Vec<DirEntry>>;
    fn read_file(&self, path: &str) -> FsResult<String>;
    fn write_file(&self, path: &str, contents: &str) -> FsResult<()>;
    fn stat(&self, path: &str) -> FsResult<FileStat>;
    fn rename(&self, from: &str, to: &str) -> FsResult<()>;
    fn delete(&self, path: &str) -> FsResult<()>;
    fn create_dir(&self, path: &str) -> FsResult<()>;
    /// Recursive copy; never overwrites (errors when `to` exists).
    fn copy(&self, from: &str, to: &str) -> FsResult<()>;
}

/// Pick a backend for a host. The remote agent replaces `remote::RemoteBackend` internals.
pub fn backend_for(host: &str) -> Box<dyn FsBackend> {
    if host == "local" || host.is_empty() {
        Box::new(local::LocalBackend)
    } else {
        Box::new(remote::RemoteBackend { host: host.to_string() })
    }
}

#[tauri::command]
pub async fn fs_list_dir(loc: Location) -> FsResult<Vec<DirEntry>> {
    backend_for(&loc.host).list_dir(&loc.path)
}
#[tauri::command]
pub async fn fs_read_file(loc: Location) -> FsResult<String> {
    backend_for(&loc.host).read_file(&loc.path)
}
#[tauri::command]
pub async fn fs_write_file(loc: Location, contents: String) -> FsResult<()> {
    backend_for(&loc.host).write_file(&loc.path, &contents)
}
#[tauri::command]
pub async fn fs_stat(loc: Location) -> FsResult<FileStat> {
    backend_for(&loc.host).stat(&loc.path)
}
#[tauri::command]
pub async fn fs_rename(from: Location, to: Location) -> FsResult<()> {
    if from.host != to.host {
        return Err("rename across hosts not supported".into());
    }
    backend_for(&from.host).rename(&from.path, &to.path)
}
#[tauri::command]
pub async fn fs_copy(from: Location, to: Location) -> FsResult<()> {
    if from.host != to.host {
        return Err("copy across hosts not supported".into());
    }
    backend_for(&from.host).copy(&from.path, &to.path)
}
#[tauri::command]
pub async fn fs_delete(loc: Location) -> FsResult<()> {
    backend_for(&loc.host).delete(&loc.path)
}
#[tauri::command]
pub async fn fs_create_dir(loc: Location) -> FsResult<()> {
    backend_for(&loc.host).create_dir(&loc.path)
}
#[tauri::command]
pub fn fs_home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}
