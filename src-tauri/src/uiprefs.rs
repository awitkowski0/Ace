//! Global UI preferences (colour scheme ...) in `<data dir>/ui-prefs.json` (honours ATELIER_DATA_DIR, so harness runs never
//! touch the real file). Global like IntelliJ's look-and-feel: shared by every project window.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

fn file() -> PathBuf {
    crate::pstore::data_dir().join("ui-prefs.json")
}
fn read() -> BTreeMap<String, String> {
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn ui_pref_get(name: String) -> Option<String> {
    let _g = LOCK.lock();
    read().get(&name).cloned()
}

#[tauri::command]
pub fn ui_pref_set(name: String, value: Option<String>) -> Result<(), String> {
    let _g = LOCK.lock();
    let mut m = read();
    match value {
        Some(v) => m.insert(name, v),
        None => m.remove(&name),
    };
    let f = file();
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}
