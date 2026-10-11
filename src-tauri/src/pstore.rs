//! Per-project JSON side store in the app data dir (NOT in the project): run configurations, breakpoints, interpreter choice.
//!   pstore_get(root, name) -> Option<String>      pstore_set(root, name, json)
//! Files live in `<data dir>/projects/<fnv(host:path)>/<name>.json` next to a `project.txt` naming the project.
use crate::Location;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("ATELIER_DATA_DIR") {
        return d.into();
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("com.alexw.atelier")
}

fn project_dir(root: &Location) -> PathBuf {
    let key = format!("{}:{}", if root.is_local() { "local" } else { &root.host }, root.path.trim_end_matches('/'));
    let h = key.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    data_dir().join("projects").join(format!("{h:016x}"))
}

fn safe_name(name: &str) -> Result<&str, String> {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(name)
    } else {
        Err("bad store name".into())
    }
}

#[tauri::command]
pub fn pstore_get(root: Location, name: String) -> Result<Option<String>, String> {
    let p = project_dir(&root).join(format!("{}.json", safe_name(&name)?));
    Ok(std::fs::read_to_string(p).ok())
}

#[tauri::command]
pub fn pstore_set(root: Location, name: String, json: String) -> Result<(), String> {
    let dir = project_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::write(dir.join("project.txt"), format!("{}:{}\n", root.host, root.path));
    let path = dir.join(format!("{}.json", safe_name(&name)?));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
