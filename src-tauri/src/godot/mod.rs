//! Godot integration (docs/GODOT.md). Game processes are started by the generic runner (runner.rs); this module adds
//!   godot_find(configured?)            -> binary path (configured, login PATH, /opt/homebrew/bin, Godot.app)
//!   godot_scan(root)                   -> project facts (name, main scene, scenes, SceneTree scripts, README text), local only
//!   godot_dbg_listen(id)               -> port: a TCP listener Ace owns; the game dials it with `--remote-debug tcp://127.0.0.1:<port>`
//!   godot_dbg_send(id, cmd, data)      one remote-debugger message (Variant-encoded) to the connected game
//!   godot_dbg_close(id)
//!   godot_open_editor(...)             launches the real Godot editor, detached (never killed by Ace)
//! Events (window scoped): `godot://dbg/<id>` {cmd, thread, data}, `godot://dbg-conn/<id>`, `godot://dbg-closed/<id>`.
//! Why the remote debugger and not Godot's DAP server: docs/GODOT.md ("Debugging").
mod variant;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, WebviewWindow};

const MAC_APP: &str = "/Applications/Godot.app/Contents/MacOS/Godot";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotBin {
    pub path: String,
    pub source: String,
}

fn is_exec(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub fn find_godot(configured: Option<&str>) -> Option<GodotBin> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        let c = if let Some(rest) = c.strip_prefix("~/") { dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| c.into()) } else { c.into() };
        if is_exec(&c) {
            return Some(GodotBin { path: c.to_string_lossy().into_owned(), source: "configured".into() });
        }
        return None;
    }
    for dir in crate::lsp::login_path().split(':').filter(|d| !d.is_empty()) {
        let p = Path::new(dir).join("godot");
        if is_exec(&p) {
            return Some(GodotBin { path: p.to_string_lossy().into_owned(), source: "PATH".into() });
        }
    }
    for p in ["/opt/homebrew/bin/godot", "/usr/local/bin/godot", MAC_APP] {
        if is_exec(Path::new(p)) {
            return Some(GodotBin { path: p.into(), source: "known location".into() });
        }
    }
    None
}

#[tauri::command]
pub fn godot_find(configured: Option<String>) -> Option<GodotBin> {
    find_godot(configured.as_deref())
}

// ---------------------------------------------------------------- project scan

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanScript {
    pub path: String, // res://tools/sim/x.gd
    pub kind: String, // SceneTree | MainLoop
    pub doc: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub is_project: bool,
    pub name: String,
    pub main_scene: String, // res://… or ""
    pub scenes: Vec<String>,
    pub scripts: Vec<ScanScript>,
    pub readme: String,
}

fn ini_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut cur = String::new();
    for l in text.lines() {
        let l = l.trim();
        if let Some(s) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            cur = s.to_string();
        } else if cur == section {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim() == key {
                    let v = v.trim();
                    return Some(v.trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

fn tool_script(rel: &str) -> bool {
    if rel.starts_with("addons/") {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() >= 2 && parts[..parts.len() - 1].contains(&"tools")
}

fn head_kind(text: &str) -> Option<(String, String)> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?m)^\s*(?:class_name\s+\w+\s+)?extends\s+(SceneTree|MainLoop)\b").unwrap());
    let m = re.captures(text)?;
    let doc = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("##").map(|d| d.trim().to_string()))
        .unwrap_or_default();
    Some((m[1].to_string(), doc))
}

pub fn scan_project(root: &str) -> Scan {
    let rootp = Path::new(root);
    let pg = rootp.join("project.godot");
    let Ok(text) = std::fs::read_to_string(&pg) else { return Scan::default() };
    let mut scan = Scan {
        is_project: true,
        name: ini_value(&text, "application", "config/name").unwrap_or_default(),
        main_scene: ini_value(&text, "application", "run/main_scene").unwrap_or_default(),
        ..Default::default()
    };
    // uid:// main scenes: resolve through the text of project.godot is impossible; leave as is (the UI falls back to a scene list)
    scan.readme = std::fs::read_to_string(rootp.join("README.md")).unwrap_or_default().chars().take(400_000).collect();
    let mut walk = ignore::WalkBuilder::new(rootp);
    walk.hidden(false).git_ignore(true).git_global(false).git_exclude(false).parents(false);
    walk.filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        !(n == ".git" || n == ".godot" || n == "node_modules" || n == ".ace" || n == ".import")
    });
    let mut visited = 0usize;
    for ent in walk.build().flatten() {
        visited += 1;
        if visited > 300_000 {
            break;
        }
        if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(rel) = ent.path().strip_prefix(rootp) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.ends_with(".tscn") {
            if scan.scenes.len() < 5000 {
                scan.scenes.push(format!("res://{rel}"));
            }
        } else if rel.ends_with(".gd") && tool_script(&rel) {
            let mut head = Vec::new();
            if let Ok(f) = std::fs::File::open(ent.path()) {
                let _ = f.take(8192).read_to_end(&mut head);
            }
            if let Some((kind, doc)) = head_kind(&String::from_utf8_lossy(&head)) {
                scan.scripts.push(ScanScript { path: format!("res://{rel}"), kind, doc });
            }
        }
    }
    // Godot 4.4+ stores the main scene as uid://…: find the scene whose header carries it
    if scan.main_scene.starts_with("uid://") {
        let want = format!("uid=\"{}\"", scan.main_scene);
        for sc in &scan.scenes {
            let mut head = Vec::new();
            if let Ok(f) = std::fs::File::open(rootp.join(sc.trim_start_matches("res://"))) {
                let _ = f.take(300).read_to_end(&mut head);
            }
            if String::from_utf8_lossy(&head).contains(&want) {
                scan.main_scene = sc.clone();
                break;
            }
        }
    }
    scan.scenes.sort();
    scan.scripts.sort_by(|a, b| a.path.cmp(&b.path));
    scan
}

#[tauri::command]
pub async fn godot_scan(root: String) -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_project(&root)).await.map_err(|e| e.to_string())
}

/// Scenes (res://…) whose text mentions `script` (a res:// path): "Run Scene" for the .gd in the editor.
#[tauri::command]
pub async fn godot_scenes_using(root: String, script: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let needle = format!("path=\"{script}\"");
        let mut out = Vec::new();
        let rootp = Path::new(&root);
        let mut walk = ignore::WalkBuilder::new(rootp);
        walk.hidden(false).git_ignore(true).git_global(false).git_exclude(false).parents(false);
        walk.filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !(n == ".git" || n == ".godot" || n == "node_modules" || n == ".ace")
        });
        for ent in walk.build().flatten() {
            if !ent.path().extension().map(|x| x == "tscn").unwrap_or(false) {
                continue;
            }
            if std::fs::read_to_string(ent.path()).map(|t| t.contains(&needle)).unwrap_or(false) {
                if let Ok(rel) = ent.path().strip_prefix(rootp) {
                    out.push(format!("res://{}", rel.to_string_lossy()));
                    if out.len() >= 20 {
                        break;
                    }
                }
            }
        }
        out.sort();
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// .gd files (res://…) modified after `since_ms` (epoch ms): what "Reload Scripts" sends to a running game.
#[tauri::command]
pub async fn godot_changed_scripts(root: String, since_ms: u64) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rootp = Path::new(&root);
        let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms);
        let mut out = Vec::new();
        let mut walk = ignore::WalkBuilder::new(rootp);
        walk.hidden(false).git_ignore(true).git_global(false).git_exclude(false).parents(false);
        walk.filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !(n == ".git" || n == ".godot" || n == "node_modules" || n == ".ace")
        });
        for ent in walk.build().flatten() {
            if ent.path().extension().map(|x| x == "gd").unwrap_or(false) {
                let newer = ent.metadata().ok().and_then(|m| m.modified().ok()).map(|t| t > since).unwrap_or(false);
                if newer {
                    if let Ok(rel) = ent.path().strip_prefix(rootp) {
                        out.push(format!("res://{}", rel.to_string_lossy()));
                    }
                }
            }
        }
        out.sort();
        out
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- remote debugger server

struct Conn {
    owner: String,
    port: u16,
    stream: Option<TcpStream>,
    closed: bool,
}

fn conns() -> &'static Mutex<HashMap<String, Arc<Mutex<Conn>>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Mutex<Conn>>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Opens the listener and returns its port. The first connection becomes the game; its messages arrive as events.
#[tauri::command]
pub fn godot_dbg_listen(app: AppHandle, window: WebviewWindow, id: String) -> Result<u16, String> {
    let owner = window.label().to_string();
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    let conn = Arc::new(Mutex::new(Conn { owner: owner.clone(), port, stream: None, closed: false }));
    conns().lock().unwrap().insert(id.clone(), conn.clone());
    std::thread::Builder::new()
        .name(format!("godot-dbg-{id}"))
        .spawn(move || {
            let emit = |ev: &str, payload: Value| crate::windows::emit_window(&app, &owner, &format!("godot://{ev}/{id}"), payload);
            let sock = match l.accept() {
                Ok((s, _)) => s,
                Err(_) => return,
            };
            if conn.lock().unwrap().closed {
                return;
            }
            let _ = sock.set_nodelay(true);
            let Ok(mut rd) = sock.try_clone() else { return };
            conn.lock().unwrap().stream = Some(sock);
            emit("dbg-conn", Value::Null);
            drop(l);
            let mut len = [0u8; 4];
            loop {
                if rd.read_exact(&mut len).is_err() {
                    break;
                }
                let n = u32::from_le_bytes(len) as usize;
                if n > 64 * 1024 * 1024 {
                    break;
                }
                let mut buf = vec![0u8; n];
                if rd.read_exact(&mut buf).is_err() {
                    break;
                }
                if let Ok(Value::Array(a)) = variant::decode(&buf) {
                    let mut it = a.into_iter();
                    let cmd = it.next().unwrap_or(Value::Null);
                    let thread = it.next().unwrap_or(Value::Null);
                    let data = it.next().unwrap_or(Value::Null);
                    emit("dbg", serde_json::json!({"cmd": cmd, "thread": thread, "data": data}));
                }
            }
            conns().lock().unwrap().remove(&id);
            emit("dbg-closed", Value::Null);
        })
        .map_err(|e| e.to_string())?;
    Ok(port)
}

#[tauri::command]
pub fn godot_dbg_send(id: String, cmd: String, thread: Option<i64>, data: Vec<Value>) -> Result<(), String> {
    let c = conns().lock().unwrap().get(&id).cloned().ok_or("no such debugger connection")?;
    let bytes = variant::frame_message(&cmd, thread.unwrap_or(1), &data)?;
    let mut g = c.lock().unwrap();
    let s = g.stream.as_mut().ok_or("the game has not connected")?;
    s.write_all(&bytes).and_then(|_| s.flush()).map_err(|e| e.to_string())
}

fn close_conn(id: &str) {
    let c = conns().lock().unwrap().remove(id);
    if let Some(c) = c {
        let (port, stream) = {
            let mut g = c.lock().unwrap();
            g.closed = true;
            (g.port, g.stream.take())
        };
        match stream {
            Some(s) => {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
            // still waiting in accept(): connect to ourselves so the thread wakes up and exits
            None => {
                let _ = TcpStream::connect(("127.0.0.1", port));
            }
        }
    }
}

#[tauri::command]
pub fn godot_dbg_close(id: String) {
    close_conn(&id);
}

pub fn release_window(label: &str) {
    let ids: Vec<String> = conns().lock().unwrap().iter().filter(|(_, c)| c.lock().unwrap().owner == label).map(|(k, _)| k.clone()).collect();
    for id in ids {
        close_conn(&id);
    }
}

// ---------------------------------------------------------------- open the real editor

/// Launch the Godot editor on the project (optionally on a scene). Detached and NOT tracked: it is Alex's editor, it must
/// survive Ace. With `ATELIER_GODOT_LAUNCH_LOG=<file>` the argv is appended to that file instead of launching (tests).
#[tauri::command]
pub fn godot_open_editor(project: String, scene: Option<String>, godot: Option<String>) -> Result<Vec<String>, String> {
    let bin = find_godot(godot.as_deref()).ok_or("Godot executable not found")?;
    let mut argv = vec![bin.path.clone(), "--path".into(), project.clone(), "-e".into()];
    if let Some(s) = scene.filter(|s| !s.is_empty()) {
        argv.push(s);
    }
    if let Ok(log) = std::env::var("ATELIER_GODOT_LAUNCH_LOG") {
        if !log.is_empty() {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
            writeln!(f, "{}", serde_json::to_string(&argv).unwrap_or_default()).map_err(|e| e.to_string())?;
            return Ok(argv);
        }
    }
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&project).process_group(0).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_kind_detects_scenetree() {
        assert_eq!(head_kind("## Sim\nextends SceneTree\n").unwrap().0, "SceneTree");
        assert_eq!(head_kind("class_name Foo extends MainLoop\n").unwrap().0, "MainLoop");
        assert!(head_kind("extends Node\n").is_none());
        assert!(head_kind("# extends SceneTree\n").is_none());
    }

    #[test]
    fn tool_script_paths() {
        assert!(tool_script("tools/a.gd"));
        assert!(tool_script("tools/sim/a.gd"));
        assert!(tool_script("scripts/characters/tools/check.gd"));
        assert!(!tool_script("scripts/ui/a.gd"));
        assert!(!tool_script("addons/x/tools/a.gd"));
    }

    #[test]
    fn ini_lookup() {
        let t = "[application]\n\nconfig/name=\"Share\"\nrun/main_scene=\"res://a.tscn\"\n[x]\nrun/main_scene=\"no\"";
        assert_eq!(ini_value(t, "application", "run/main_scene").unwrap(), "res://a.tscn");
        assert_eq!(ini_value(t, "application", "config/name").unwrap(), "Share");
    }
}
