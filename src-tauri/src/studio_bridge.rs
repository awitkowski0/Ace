//! Live Studio bridge for the `ace-studio` MCP server (plugins/ace-studio, tools/ace-mcp). Docs: docs/ANIMSTUDIO.md.
//!
//! Ace listens on a per-user unix socket (`$ACE_STUDIO_SOCK`, default `$TMPDIR/ace-studio-<uid>.sock`, mode 0600) speaking JSON
//! lines: one request line `{"id":n,"op":"...","args":{...}}`, one reply line `{"id":n,"ok":true,"value":...}` or
//! `{"id":n,"ok":false,"error":"..."}`. A connection may send several requests. This is NOT the QA automation socket: it only
//! forwards a fixed set of ops to `window.__aceStudioBridge(op, args)` (src/components/animstudio/bridge.ts), never arbitrary JS.
//! `ping` is answered here. Requests carrying `args.file` are routed to the project window that has that file open
//! (asked via `file_text`); everything else goes to the active window.
//! Windows has no unix sockets: the same protocol runs over loopback TCP (see `local_ipc`), with a `.json` discovery file
//! beside the path above and the token as the first line of every connection.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Local IPC for the Ace bridges (studio bridge, QA automation). Unix: a unix domain socket at the given path (mode 0600).
/// Windows: a loopback TCP listener on 127.0.0.1 (random port) plus a discovery file at the same path with the `.json`
/// extension, `{"port":N,"token":"<hex>"}` (mode 0600). Clients send `<token>\n` first; connections with another first line
/// are dropped before any request is read.
pub(crate) mod local_ipc {
    use std::io::{self, Read, Write};
    use std::path::Path;
    use std::time::Duration;
    #[cfg(unix)]
    use std::os::unix::net::{UnixListener, UnixStream};
    #[cfg(windows)]
    use std::net::{TcpListener, TcpStream};

    pub(crate) enum Stream {
        #[cfg(unix)]
        Unix(UnixStream),
        #[cfg(windows)]
        Tcp(TcpStream),
    }

    impl Stream {
        /// Client side: connect to the endpoint published at `path` (Windows: and send the token line).
        pub(crate) fn connect(path: &Path) -> io::Result<Stream> {
            #[cfg(unix)]
            {
                UnixStream::connect(path).map(Stream::Unix)
            }
            #[cfg(windows)]
            {
                let (port, token) = read_endpoint(path)?;
                let mut s = TcpStream::connect(("127.0.0.1", port))?;
                s.write_all(format!("{token}\n").as_bytes())?;
                Ok(Stream::Tcp(s))
            }
        }

        pub(crate) fn try_clone(&self) -> io::Result<Stream> {
            match self {
                #[cfg(unix)]
                Stream::Unix(s) => s.try_clone().map(Stream::Unix),
                #[cfg(windows)]
                Stream::Tcp(s) => s.try_clone().map(Stream::Tcp),
            }
        }

        fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            match self {
                #[cfg(unix)]
                Stream::Unix(s) => s.set_read_timeout(d),
                #[cfg(windows)]
                Stream::Tcp(s) => s.set_read_timeout(d),
            }
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self {
                #[cfg(unix)]
                Stream::Unix(s) => s.read(buf),
                #[cfg(windows)]
                Stream::Tcp(s) => s.read(buf),
            }
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            match self {
                #[cfg(unix)]
                Stream::Unix(s) => s.write(buf),
                #[cfg(windows)]
                Stream::Tcp(s) => s.write(buf),
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            match self {
                #[cfg(unix)]
                Stream::Unix(s) => s.flush(),
                #[cfg(windows)]
                Stream::Tcp(s) => s.flush(),
            }
        }
    }

    pub(crate) enum Listener {
        #[cfg(unix)]
        Unix(UnixListener),
        #[cfg(windows)]
        Tcp(TcpListener, String),
    }

    /// Bind the endpoint at `path`, replacing a stale one. Unix: the socket file, mode 0600. Windows: a loopback listener and
    /// the discovery file (`path` with `.json`, mode 0600) holding the port and a fresh token.
    pub(crate) fn bind(path: &Path) -> io::Result<Listener> {
        let _ = std::fs::remove_file(path);
        #[cfg(unix)]
        {
            let l = UnixListener::bind(path)?;
            let _ = crate::platform::set_mode(path, 0o600);
            Ok(Listener::Unix(l))
        }
        #[cfg(windows)]
        {
            let l = TcpListener::bind(("127.0.0.1", 0))?;
            let token = random_token();
            let file = endpoint_file(path);
            let _ = std::fs::remove_file(&file);
            let body = serde_json::json!({"port": l.local_addr()?.port(), "token": token});
            std::fs::write(&file, body.to_string())?;
            let _ = crate::platform::set_mode(&file, 0o600);
            Ok(Listener::Tcp(l, token))
        }
    }

    /// Accept connections on a named thread. Each one is authorized and then served on its own thread as `serve(app, stream)`.
    pub(crate) fn spawn_server<A: Clone + Send + 'static>(listener: Listener, name: &str, app: A, serve: fn(A, Stream)) {
        let token = listener.token();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || loop {
                let Ok(conn) = listener.accept() else { continue };
                let (app, token) = (app.clone(), token.clone());
                std::thread::spawn(move || {
                    if let Some(s) = authorize(conn, token.as_deref()) {
                        serve(app, s);
                    }
                });
            })
            .ok();
    }

    impl Listener {
        fn accept(&self) -> io::Result<Stream> {
            match self {
                #[cfg(unix)]
                Listener::Unix(l) => l.accept().map(|(s, _)| Stream::Unix(s)),
                #[cfg(windows)]
                Listener::Tcp(l, _) => l.accept().map(|(s, _)| Stream::Tcp(s)),
            }
        }

        fn token(&self) -> Option<String> {
            match self {
                #[cfg(unix)]
                Listener::Unix(_) => None,
                #[cfg(windows)]
                Listener::Tcp(_, t) => Some(t.clone()),
            }
        }
    }

    /// Windows: the first line must be the token (read byte by byte so nothing after it is consumed). Unix: no token.
    fn authorize(mut conn: Stream, token: Option<&str>) -> Option<Stream> {
        let Some(token) = token else { return Some(conn) };
        conn.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut got = Vec::new();
        let mut b = [0u8; 1];
        loop {
            match conn.read(&mut b) {
                Ok(1) if b[0] == b'\n' => break,
                Ok(1) if got.len() < 256 => got.push(b[0]),
                _ => return None,
            }
        }
        if got.strip_suffix(b"\r").unwrap_or(&got) != token.as_bytes() {
            return None;
        }
        conn.set_read_timeout(None).ok()?;
        Some(conn)
    }

    #[cfg(windows)]
    fn endpoint_file(path: &Path) -> std::path::PathBuf {
        path.with_extension("json")
    }

    #[cfg(windows)]
    fn read_endpoint(path: &Path) -> io::Result<(u16, String)> {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(endpoint_file(path))?)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let port = v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok());
        let token = v.get("token").and_then(|t| t.as_str()).map(str::to_string);
        match (port, token) {
            (Some(p), Some(t)) => Ok((p, t)),
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, "discovery file has no port or token")),
        }
    }

    #[cfg(windows)]
    fn random_token() -> String {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        (0u32..4)
            .map(|i| {
                let mut h = RandomState::new().build_hasher();
                h.write_u32(i);
                h.write_u32(std::process::id());
                h.write_u128(nanos);
                format!("{:016x}", h.finish())
            })
            .collect()
    }
}

const OPS: &[&str] = &["file_text", "apply_text", "open", "state", "screenshot", "set_time", "select", "run_game"];

type Pending = Mutex<HashMap<u64, (String, Sender<Result<String, String>>)>>;
fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn sock_path() -> std::path::PathBuf {
    std::env::var_os("ACE_STUDIO_SOCK").filter(|v| !v.is_empty()).map(Into::into).unwrap_or_else(|| {
        let tag = crate::platform::user_tag();
        std::env::temp_dir().join(format!("ace-studio-{tag}.sock"))
    })
}

/// Callback from the injected script (`invoke("studio_bridge_result", {id, ok, value})`).
#[tauri::command]
pub fn studio_bridge_result(id: u64, ok: bool, value: String) {
    if let Some((_, tx)) = pending().lock().remove(&id) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value) });
    }
}

pub fn start(app: &AppHandle) {
    // QA harness runs must not claim the real user's socket (they only bind when pointed at their own via ACE_STUDIO_SOCK)
    if crate::automation::enabled() && std::env::var_os("ACE_STUDIO_SOCK").is_none() {
        return;
    }
    let path = sock_path();
    // another live Ace instance already serves this socket
    if local_ipc::Stream::connect(&path).is_ok() {
        return;
    }
    let listener = match local_ipc::bind(&path) {
        Ok(l) => l,
        Err(e) => return eprintln!("[studio-bridge] bind {}: {e}", path.display()),
    };
    local_ipc::spawn_server(listener, "studio-bridge", app.clone(), serve);
}

fn serve(app: AppHandle, conn: local_ipc::Stream) {
    let Ok(mut out) = conn.try_clone() else { return };
    for line in BufReader::new(conn).lines() {
        let Ok(line) = line else { return };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => handle(&app, &req),
            Err(e) => json!({"ok": false, "error": format!("bad request: {e}")}),
        };
        let id = serde_json::from_str::<Value>(&line).ok().and_then(|r| r.get("id").cloned()).unwrap_or(Value::Null);
        let mut reply = reply;
        reply["id"] = id;
        if out.write_all(reply.to_string().as_bytes()).is_err() || out.write_all(b"\n").is_err() {
            return;
        }
    }
}

fn handle(app: &AppHandle, req: &Value) -> Value {
    let op = req.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or(json!({}));
    if op == "ping" {
        return json!({"ok": true, "value": {"pong": true, "windows": crate::windows::ordered_labels(app).len()}});
    }
    if !OPS.contains(&op) {
        return json!({"ok": false, "error": format!("unknown op {op}")});
    }
    match route(app, op, &args) {
        Ok(v) => json!({"ok": true, "value": serde_json::from_str::<Value>(&v).unwrap_or(Value::Null)}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

fn labels(app: &AppHandle) -> Vec<String> {
    let mut v = crate::windows::ordered_labels(app);
    if let Some(a) = crate::windows::active_label() {
        v.retain(|l| *l != a);
        v.insert(0, a);
    }
    v.retain(|l| app.get_webview_window(l).is_some());
    v
}

fn route(app: &AppHandle, op: &str, args: &Value) -> Result<String, String> {
    let all = labels(app);
    if all.is_empty() {
        return Err("no project window".into());
    }
    // Ops that name a file go to the window that has it open; file_text probes every window.
    if args.get("file").is_some() && op != "run_game" {
        let mut first_err = None;
        for l in &all {
            let probe = if op == "file_text" { Some(run_in(app, l, op, args)) } else { Some(run_in(app, l, "file_text", &json!({"file": args["file"]}))) };
            match probe {
                Some(Ok(v)) => {
                    let open = serde_json::from_str::<Value>(&v).ok().and_then(|j| j.get("open").and_then(|o| o.as_bool())).unwrap_or(false);
                    if op == "file_text" {
                        if open {
                            return Ok(v);
                        }
                    } else if open {
                        return run_in(app, l, op, args);
                    }
                }
                Some(Err(e)) => first_err = first_err.or(Some(e)),
                None => {}
            }
        }
        if op == "file_text" {
            return Ok("{\"open\":false}".into());
        }
        // not open anywhere: `open` (and screenshot/set_time/select with a file) open it in the active window
        if matches!(op, "open" | "screenshot" | "set_time" | "select") {
            return run_in(app, &all[0], op, args);
        }
        return Err(first_err.unwrap_or_else(|| "that file is not open in Ace".into()));
    }
    run_in(app, &all[0], op, args)
}

fn run_in(app: &AppHandle, label: &str, op: &str, args: &Value) -> Result<String, String> {
    let Some(win) = app.get_webview_window(label) else { return Err(format!("no window {label}")) };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    pending().lock().insert(id, (label.to_string(), tx));
    let script = format!(
        "(async()=>{{const __id={id};const __s=(ok,v)=>window.__TAURI_INTERNALS__.invoke('studio_bridge_result',{{id:__id,ok,value:v}});\
try{{for(let i=0;i<250&&!window.__aceStudioBridge;i++)await new Promise(r=>setTimeout(r,20));\
if(!window.__aceStudioBridge)throw new Error('The Studio bridge is not loaded in this window');\
const r=await window.__aceStudioBridge({op},{args});__s(true,JSON.stringify(r===undefined?null:r))}}catch(e){{__s(false,String((e&&e.message)||e))}}}})();",
        op = serde_json::to_string(op).unwrap_or_default(),
        args = serde_json::to_string(args).unwrap_or_else(|_| "{}".into()),
    );
    if let Err(e) = win.eval(&script) {
        pending().lock().remove(&id);
        return Err(format!("eval failed: {e}"));
    }
    match rx.recv_timeout(Duration::from_secs(40)) {
        Ok(r) => r,
        Err(_) => {
            pending().lock().remove(&id);
            Err("Ace did not answer within 40s".into())
        }
    }
}
