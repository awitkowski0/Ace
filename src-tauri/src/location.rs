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

/// First non-flag argument as a project location: `~/proj`, `./rel` (against `cwd`), `mc:/srv/app` (like `idea .`).
/// Used for argv at startup and for the argv of a second `atelier <path>` process (single instance).
pub fn parse_args(args: &[String], cwd: Option<&std::path::Path>) -> Option<Location> {
    let arg = args.iter().find(|a| !a.starts_with('-'))?;
    if let Some((host, path)) = arg.split_once(':') {
        if !host.is_empty() && !host.contains('/') && path.starts_with(['/', '~']) {
            return Some(Location { host: host.into(), path: path.into() });
        }
    }
    let p = std::path::Path::new(arg);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd?.join(p) };
    let abs = abs.canonicalize().unwrap_or(abs);
    Some(Location { host: "local".into(), path: abs.to_string_lossy().into_owned() })
}

/// The project shown by the calling window (assigned when the window was created from argv / session / an open request).
#[tauri::command]
pub fn launch_location(window: tauri::WebviewWindow) -> Option<Location> {
    crate::windows::win_project(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_argv_like_idea() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&a(&["-psn_0_1", "mc:/srv/app"]), None), Some(Location { host: "mc".into(), path: "/srv/app".into() }));
        assert_eq!(parse_args(&a(&["/tmp"]), None).map(|l| l.host), Some("local".into()));
        assert_eq!(parse_args(&a(&["rel"]), Some(std::path::Path::new("/nonexistent-dir"))).unwrap().path, "/nonexistent-dir/rel");
        assert_eq!(parse_args(&a(&["rel"]), None), None);
        assert_eq!(parse_args(&a(&[]), None), None);
    }
}
