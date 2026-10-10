//! QA automation harness. Compiled in always, but INERT unless `ATELIER_AUTOMATION=1` is set at launch:
//! then a unix socket (mode 0600) at `$ATELIER_AUTOMATION_SOCK` (default `$TMPDIR/atelier-automation.sock`)
//! accepts one request per connection: the raw bytes are an async JS function body, evaluated in the main
//! webview; the reply is one JSON line `{"ok":bool,"value":<json>|"error":string}`.
//! The webview returns values through the `qa_result` command. Timeout 30s.
//! A `<sock>.pid` file holds the app pid (used by scripts/qa/shot.sh).
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub fn enabled() -> bool {
    std::env::var("ATELIER_AUTOMATION").map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

type Pending = Mutex<HashMap<u64, Sender<Result<String, String>>>>;
fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn sock_path() -> std::path::PathBuf {
    std::env::var_os("ATELIER_AUTOMATION_SOCK")
        .map(Into::into)
        .unwrap_or_else(|| std::env::temp_dir().join("atelier-automation.sock"))
}

/// Frontend asks at startup whether to install `window.__qa`.
#[tauri::command]
pub fn qa_enabled() -> bool {
    enabled()
}

/// Callback from injected scripts: `invoke("qa_result", {id, ok, value})` (value is a JSON string or error text).
#[tauri::command]
pub fn qa_result(id: u64, ok: bool, value: String) {
    if !enabled() {
        return;
    }
    if let Some(tx) = pending().lock().remove(&id) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value) });
    }
}

pub fn start(app: &AppHandle) {
    if !enabled() {
        return;
    }
    let path = sock_path();
    if UnixStream::connect(&path).is_ok() {
        eprintln!("[automation] {} is served by another live instance; not binding", path.display());
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return eprintln!("[automation] bind {}: {e}", path.display()),
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = std::fs::write(format!("{}.pid", path.display()), std::process::id().to_string());
    eprintln!("[automation] listening on {}", path.display());
    let app = app.clone();
    std::thread::Builder::new()
        .name("automation".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let app = app.clone();
                std::thread::spawn(move || handle(app, conn));
            }
        })
        .ok();
}

fn trace() -> bool {
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(|| std::env::var_os("ATELIER_AUTOMATION_TRACE").is_some())
}

fn handle(app: AppHandle, mut conn: UnixStream) {
    let t0 = std::time::Instant::now();
    // A request ends at EOF or at a NUL byte. The NUL matters: Node's `socket.end()` sometimes never delivers the FIN
    // (measured ~1 in 700 connections), which used to leave `read_to_string` blocked until the client gave up.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match conn.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(i) = chunk[..n].iter().position(|b| *b == 0) {
                    buf.extend_from_slice(&chunk[..i]);
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return,
        }
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    if trace() { eprintln!("[automation] req {} bytes read in {:?}", body.len(), t0.elapsed()); }
    let reply = run_js(&app, &body);
    if trace() { eprintln!("[automation] reply after {:?}: {}", t0.elapsed(), reply.as_ref().map(|v| v.len().to_string()).unwrap_or_else(|e| e.clone())); }
    let line = match reply {
        Ok(v) => format!("{{\"ok\":true,\"value\":{}}}", if v.is_empty() { "null".into() } else { v }),
        Err(e) => json!({"ok": false, "error": e}).to_string(),
    };
    let _ = conn.write_all(line.as_bytes());
    let _ = conn.write_all(b"\n");
}

fn run_js(app: &AppHandle, body: &str) -> Result<String, String> {
    let Some(win) = app.get_webview_window("main") else { return Err("no main window".into()) };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    pending().lock().insert(id, tx);
    let script = format!(
        "(async()=>{{const __id={id};const __send=(ok,v)=>window.__TAURI_INTERNALS__.invoke('qa_result',{{id:__id,ok,value:v}});\
try{{const __r=await (async()=>{{\n{body}\n}})();let __s;try{{__s=JSON.stringify(__r===undefined?null:__r)}}catch(e){{__s=JSON.stringify(String(__r))}}\
__send(true,__s===undefined?'null':__s)}}catch(e){{__send(false,String((e&&e.stack)||e))}}}})();"
    );
    if let Err(e) = win.eval(&script) {
        pending().lock().remove(&id);
        return Err(format!("eval failed: {e}"));
    }
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(r) => r,
        Err(_) => {
            pending().lock().remove(&id);
            Err("timeout after 30s".into())
        }
    }
}
