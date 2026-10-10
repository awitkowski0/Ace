use serde::{Deserialize, Serialize};

/// Every path in Atelier. `host` is "local" or an ssh alias (e.g. "mc").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Location {
    pub host: String,
    pub path: String,
}

impl Location {
    pub fn is_local(&self) -> bool {
        self.host == "local" || self.host.is_empty()
    }
}

/// Project passed on the command line: `atelier ~/thematic-kyf` or `atelier mc:/srv/app` (like `idea .`).
#[tauri::command]
pub fn launch_location() -> Option<Location> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    if let Some((host, path)) = arg.split_once(':') {
        if !host.is_empty() && !host.contains('/') && path.starts_with(['/', '~']) {
            return Some(Location { host: host.into(), path: path.into() });
        }
    }
    let p = std::path::Path::new(&arg);
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().ok()?.join(p) };
    let abs = abs.canonicalize().unwrap_or(abs);
    Some(Location { host: "local".into(), path: abs.to_string_lossy().into_owned() })
}
