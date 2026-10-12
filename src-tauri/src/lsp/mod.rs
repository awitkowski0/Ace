//! LSP bridge (owned by the LSP agent). Thin JSON-RPC framing over a child's stdio or a TCP socket.
//! The frontend does all protocol work; Rust only spawns/connects, frames, and forwards.
//!   lsp_detect() -> [ServerInfo]            which servers exist (PATH of the user's login shell, cached)
//!   lsp_start({serverId, root}) -> sessionId
//!   lsp_send(sessionId, json)
//!   lsp_stop(sessionId)
//! Events: `lsp://msg/<sessionId>` (payload = raw JSON text), `lsp://closed/<sessionId>`.
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use crate::platform::{self, Sig};
use std::collections::{BTreeSet, HashSet};

const GODOT_ADDR: &str = "127.0.0.1:6005";

struct Session {
    owner: String, // window label: receives the messages and stops the session when it closes
    root: String,
    tx: Sender<Vec<u8>>,
    proc_id: Option<u64>,
    tcp: Option<TcpStream>,
}

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<String, Session>>,
    next: Mutex<u64>,
    /// Headless Godot per project root, shared by the windows on that root (`Warm::users`).
    warm: Mutex<HashMap<String, Warm>>,
    pause: GodotPause,
}

/// Idle suspension of OUR headless Godot (never a user-launched editor on 6005, which we do not own).
/// Idle headless Godot burns 4-13% CPU and no CLI flag helps, so after `PAUSE_AFTER` without LSP traffic and without a
/// focused .gd editor the whole process group gets SIGSTOP; the next outgoing message / focus SIGCONTs it first.
#[derive(Default)]
struct GodotPause {
    last_ms: AtomicU64,
    /// windows whose focused editor is a .gd file
    gd_focus: Mutex<HashSet<String>>,
    paused: AtomicBool,
    watcher: AtomicBool,
}

const PAUSE_AFTER: Duration = Duration::from_secs(20);

fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

impl GodotPause {
    fn touch(&self) {
        self.last_ms.store(now_ms(), Ordering::Relaxed);
    }
}

fn warm_pids(st: &LspState) -> Vec<u32> {
    st.warm.lock().unwrap().values().filter_map(|w| w.proc_id).filter_map(crate::procs::pid).collect()
}

/// SIGCONT our Godot if it is suspended. Cheap when it is not. Returns true if it had to be resumed.
fn resume_godot(app: &AppHandle) -> bool {
    let st = app.state::<LspState>();
    st.pause.touch();
    if !st.pause.paused.swap(false, Ordering::SeqCst) {
        return false;
    }
    for pid in warm_pids(&st) {
        platform::signal_group(pid, Sig::Cont);
    }
    let _ = app.emit("lsp://godot-paused", false);
    true
}

fn pause_tick(app: &AppHandle) {
    let st = app.state::<LspState>();
    let pids = warm_pids(&st);
    let paused = st.pause.paused.load(Ordering::SeqCst);
    if pids.is_empty() {
        if paused {
            st.pause.paused.store(false, Ordering::SeqCst);
            let _ = app.emit("lsp://godot-paused", false);
        }
    } else if !paused {
        let idle = now_ms().saturating_sub(st.pause.last_ms.load(Ordering::Relaxed));
        if idle >= PAUSE_AFTER.as_millis() as u64 && st.pause.gd_focus.lock().unwrap().is_empty() {
            st.pause.paused.store(true, Ordering::SeqCst);
            for pid in pids {
                platform::signal_group(pid, Sig::Stop);
            }
            let _ = app.emit("lsp://godot-paused", true);
        }
    }
}

/// One watcher thread per app, started when the first Godot of ours becomes ready.
fn start_pause_watcher(app: &AppHandle) {
    let st = app.state::<LspState>();
    if st.pause.watcher.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new().name("godot-pause".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        pause_tick(&app);
    }).ok();
}

/// Frontend: a .gd editor is (not) the focused editor of a focused window. Focusing resumes immediately.
#[tauri::command]
pub fn lsp_godot_focus(app: AppHandle, window: WebviewWindow, focused: bool) {
    let st = app.state::<LspState>();
    {
        let mut g = st.pause.gd_focus.lock().unwrap();
        if focused { g.insert(window.label().to_string()); } else { g.remove(window.label()); }
    }
    if focused {
        resume_godot(&app);
    } else {
        st.pause.touch(); // start the 20s idle clock from the moment the editor loses focus
    }
}

struct Warm {
    port: u16,
    proc_id: Option<u64>, // None while still starting
    users: BTreeSet<String>, // windows that asked for this root's Godot
}

#[cfg(target_os = "macos")]
const GODOT_BIN: &str = "/Applications/Godot.app/Contents/MacOS/Godot";
/// Windows: no fixed install dir; looked up on PATH (see `spawn_godot`).
#[cfg(windows)]
const GODOT_BIN: &str = "Godot.exe";
#[cfg(not(any(target_os = "macos", windows)))]
const GODOT_BIN: &str = "godot";

/// Spawn a headless Godot editor for `root` at low priority and wait until its LSP port accepts connections.
/// Returns (port, registry id). The child is tracked from spawn so an app exit during startup cannot orphan it.
fn spawn_godot(root: &str, low_priority: bool) -> Result<(u16, u64, Option<TcpStream>), String> {
    let godot = if cfg!(windows) { which_path(GODOT_BIN).unwrap_or_else(|| PathBuf::from(GODOT_BIN)) } else { PathBuf::from(GODOT_BIN) };
    if !godot.is_file() {
        return Err("Godot.app not found".into());
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let gargs = ["--path", root, "--editor", "--headless", "--lsp-port", &port.to_string()];
    // `nice` is a unix tool: on Windows the headless editor just runs at normal priority.
    let mut cmd = if low_priority && cfg!(unix) {
        let mut c = Command::new("/usr/bin/nice");
        c.args(["-n", "15"]).arg(&godot).args(gargs);
        c
    } else {
        let mut c = Command::new(&godot);
        c.args(gargs);
        c
    };
    crate::procs::group(&mut cmd);
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let early = crate::procs::register_killer("lsp", "godot-headless (starting)", Some(child.id()), Box::new(|| {}));
    let addr = format!("127.0.0.1:{port}");
    let t0 = std::time::Instant::now();
    let sock = loop {
        if let Ok(Some(st)) = child.try_wait() {
            crate::procs::unregister(early);
            return Err(format!("godot exited early: {st}"));
        }
        if let Ok(s) = connect_tcp(&addr) {
            break s;
        }
        if t0.elapsed() > Duration::from_secs(90) {
            let _ = child.kill();
            let _ = child.wait();
            crate::procs::unregister(early);
            return Err("godot headless: LSP port did not open".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    crate::procs::unregister(early);
    let id = crate::procs::register("lsp", "godot-headless", child);
    Ok((port, id, Some(sock)))
}

/// Exactly one headless Godot per project root: Idle -> Starting -> Ready, shared by pre-warm and `lsp_start`.
/// Concurrent callers for the same root wait for the single start in flight. Returns the LSP port.
fn ensure_godot(st: &LspState, owner: &str, root: &str) -> Result<u16, String> {
    ensure_godot_with(st, owner, root, &|r| spawn_godot(r, true))
}

type Spawner<'a> = &'a (dyn Fn(&str) -> Result<(u16, u64, Option<TcpStream>), String> + Sync);

fn ensure_godot_with(st: &LspState, owner: &str, root: &str, spawn: Spawner) -> Result<u16, String> {
    let t0 = std::time::Instant::now();
    loop {
        let mut w = st.warm.lock().unwrap();
        if let Some(c) = w.get_mut(root) {
            c.users.insert(owner.to_string());
            if c.proc_id.is_some() {
                return Ok(c.port);
            }
            drop(w); // another caller is starting it: wait
            if t0.elapsed() > Duration::from_secs(100) {
                return Err("godot start timed out".into());
            }
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        w.insert(root.to_string(), Warm { port: 0, proc_id: None, users: BTreeSet::from([owner.to_string()]) });
        drop(w);
        let res = spawn(root);
        let mut w = st.warm.lock().unwrap();
        let ours = w.get(root).map(|c| c.proc_id.is_none()).unwrap_or(false);
        return match res {
            Ok((port, id, _sock)) => {
                if ours {
                    let users = w.get(root).map(|c| c.users.clone()).unwrap_or_default();
                    w.insert(root.to_string(), Warm { port, proc_id: Some(id), users });
                    st.pause.touch();
                    st.pause.paused.store(false, Ordering::SeqCst);
                    Ok(port)
                } else {
                    crate::procs::kill(id); // dropped while starting (all users went away)
                    Err("superseded".into())
                }
            }
            Err(e) => {
                if ours {
                    w.remove(root);
                }
                Err(e)
            }
        };
    }
}

fn drop_warm(st: &LspState, root: &str) {
    let w = st.warm.lock().unwrap().remove(root);
    if let Some(p) = w.and_then(|c| c.proc_id) {
        crate::procs::kill(p);
    }
}

fn prewarm_blocking(app: AppHandle, owner: String, root: String) -> Result<(), String> {
    let st = app.state::<LspState>();
    if connect_tcp(GODOT_ADDR).is_ok() {
        return Ok(()); // an editor already serves 6005: reuse it, nothing to warm
    }
    let r = ensure_godot(&st, &owner, &root).map(|_| ());
    start_pause_watcher(&app);
    r
}

/// Idle headless Godot costs ~10% CPU and ~1.5 GB (--max-fps / --frame-delay / --fixed-fps measured: no change),
/// so stop a root's Godot when no Godot session on that root has existed for 5 minutes.
fn schedule_godot_reap(app: &AppHandle, root: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(300));
        let st = app.state::<LspState>();
        let busy = st.sessions.lock().unwrap().iter().any(|(k, s)| k.starts_with("godot-") && s.root == root);
        if !busy {
            drop_warm(&st, &root);
        }
    });
}

#[tauri::command]
pub async fn lsp_prewarm(app: AppHandle, window: WebviewWindow, root: String) -> Result<(), String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || prewarm_blocking(app, owner, root)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    id: String,
    label: String,
    transport: &'static str,
    available: bool,
    path: Option<String>,
}

struct Spec {
    id: &'static str,
    label: &'static str,
    bin: &'static str, // "" for tcp
    args: &'static [&'static str],
}
const SPECS: &[Spec] = &[
    Spec { id: "godot", label: "GDScript (Godot editor)", bin: "", args: &[] },
    Spec { id: "rust-analyzer", label: "rust-analyzer", bin: "rust-analyzer", args: &[] },
    Spec { id: "typescript", label: "typescript-language-server", bin: "typescript-language-server", args: &["--stdio"] },
    Spec { id: "pyright", label: "pyright", bin: "pyright-langserver", args: &["--stdio"] },
    Spec { id: "basedpyright", label: "basedpyright", bin: "basedpyright-langserver", args: &["--stdio"] },
    Spec { id: "gopls", label: "gopls", bin: "gopls", args: &[] },
    Spec { id: "jdtls", label: "jdtls", bin: "jdtls", args: &[] },
];

/// PATH of the user's login shell (GUI apps start with a minimal PATH). Resolved once.
pub(crate) fn login_path() -> &'static str {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
        // Windows GUI apps inherit the full user PATH already; there is no login shell to ask.
        if cfg!(windows) {
            return std::env::var("PATH").unwrap_or_default();
        }
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = Command::new(sh)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let cur = std::env::var("PATH").unwrap_or_default();
        format!("{from_shell}:{cur}:/opt/homebrew/bin:/usr/local/bin")
    })
}

fn which(bin: &str) -> Option<PathBuf> {
    which_path(bin).or_else(|| {
        if bin != "rust-analyzer" {
            return None;
        }
        let out = Command::new("rustup").arg("which").arg(bin).env("PATH", login_path()).stderr(Stdio::null()).output().ok()?;
        let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        (out.status.success() && p.is_file()).then_some(p)
    })
}

fn which_path(bin: &str) -> Option<PathBuf> {
    // Windows: executables carry an extension, and npm-installed servers are `.cmd` shims.
    let names: &[String] = &if cfg!(windows) {
        [bin.to_string(), format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")].to_vec()
    } else {
        vec![bin.to_string()]
    };
    std::env::split_paths(login_path())
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

#[tauri::command]
pub async fn lsp_detect() -> Vec<ServerInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        SPECS
            .iter()
            .map(|s| {
                if s.bin.is_empty() {
                    ServerInfo { id: s.id.into(), label: s.label.into(), transport: "tcp", available: true, path: Some(GODOT_ADDR.into()) }
                } else {
                    let p = which(s.bin);
                    ServerInfo { id: s.id.into(), label: s.label.into(), transport: "stdio", available: p.is_some(), path: p.map(|p| p.to_string_lossy().into()) }
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

pub(crate) fn read_loop<R: Read>(r: R, mut emit: impl FnMut(String)) {
    let mut br = BufReader::new(r);
    loop {
        let mut len: Option<usize> = None;
        loop {
            let mut line = String::new();
            match br.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some(v) = l.strip_prefix("Content-Length:") {
                len = v.trim().parse().ok();
            }
        }
        let Some(n) = len else { continue };
        let mut buf = vec![0u8; n];
        if br.read_exact(&mut buf).is_err() {
            return;
        }
        emit(String::from_utf8_lossy(&buf).into_owned());
    }
}

pub(crate) fn spawn_writer<W: Write + Send + 'static>(mut w: W) -> Sender<Vec<u8>> {
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(body) = rx.recv() {
            let head = format!("Content-Length: {}\r\n\r\n", body.len());
            if w.write_all(head.as_bytes()).and_then(|_| w.write_all(&body)).and_then(|_| w.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

fn finish(app: &AppHandle, id: &str) {
    let st = app.state::<LspState>();
    let s = st.sessions.lock().unwrap().remove(id);
    if let Some(s) = s {
        if let Some(p) = s.proc_id {
            crate::procs::kill(p);
        }
        crate::windows::emit_window(app, &s.owner, &format!("lsp://closed/{id}"), ());
        if id.starts_with("godot-") {
            schedule_godot_reap(app, s.root.clone());
        }
    }
}
use tauri::Manager;

fn connect_tcp(a: &str) -> Result<TcpStream, String> {
    let addr = a.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("bad addr")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).map_err(|e| e.to_string())?;
    let _ = s.set_nodelay(true);
    Ok(s)
}

fn start_blocking(app: AppHandle, owner: String, server_id: String, root: String, auto_godot: bool, bin_override: Option<String>, path_prepend: Vec<String>) -> Result<String, String> {
    let spec = SPECS.iter().find(|s| s.id == server_id).ok_or_else(|| format!("unknown server {server_id}"))?;
    let st = app.state::<LspState>();
    let id = {
        let mut n = st.next.lock().unwrap();
        *n += 1;
        format!("{}-{}", spec.id, *n)
    };
    if spec.bin.is_empty() {
        let proc_id = None;
        let sock = match connect_tcp(GODOT_ADDR) {
            Ok(s) => s,
            Err(e) if !auto_godot => return Err(format!("unreachable: {e}")),
            Err(e) => {
                if !auto_godot && !st.warm.lock().unwrap().contains_key(&root) {
                    return Err(format!("unreachable: {e}"));
                }
                let mut tries = 0;
                loop {
                    resume_godot(&app); // a suspended Godot accepts TCP (kernel backlog) but cannot answer
                    let port = ensure_godot(&st, &owner, &root).map_err(|m| if m.contains("not found") { format!("unreachable: {e}") } else { m })?;
                    match connect_tcp(&format!("127.0.0.1:{port}")) {
                        Ok(s) => break s,
                        Err(_) if tries == 0 => {
                            tries += 1;
                            drop_warm(&st, &root); // dead instance: start a fresh one once
                        }
                        Err(x) => return Err(x),
                    }
                }
            }
        };
        start_pause_watcher(&app);
        let rd = sock.try_clone().map_err(|e| e.to_string())?;
        let wr = sock.try_clone().map_err(|e| e.to_string())?;
        let tx = spawn_writer(wr);
        st.sessions.lock().unwrap().insert(id.clone(), Session { owner: owner.clone(), root: root.clone(), tx, proc_id, tcp: Some(sock) });
        let (a, i, o) = (app.clone(), id.clone(), owner.clone());
        std::thread::spawn(move || {
            let ev = format!("lsp://msg/{i}");
            read_loop(rd, |m| {
                a.state::<LspState>().pause.touch(); // incoming traffic (diagnostics etc.) keeps Godot awake
                crate::windows::emit_window(&a, &o, &ev, m);
            });
            finish(&a, &i);
        });
        return Ok(id);
    }
    let bin = match bin_override.as_deref().filter(|b| std::path::Path::new(b).is_file()) {
        Some(b) => PathBuf::from(b),
        None => which(spec.bin).ok_or_else(|| format!("{} not found on PATH", spec.bin))?,
    };
    let mut cmd = Command::new(bin);
    let sep = if cfg!(windows) { ";" } else { ":" };
    let path = path_prepend.iter().map(|p| format!("{p}{sep}")).collect::<String>() + login_path();
    cmd.args(spec.args).env("PATH", path).current_dir(&root);
    if spec.id == "jdtls" {
        let dir = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("ace/jdtls").join(format!("{:x}", root.bytes().fold(5381u64, |h, b| h.wrapping_mul(33) ^ b as u64)));
        cmd.arg("-data").arg(dir);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let proc_id = crate::procs::register_for(&owner, "lsp", spec.label, child);
    let tx = spawn_writer(stdin);
    st.sessions.lock().unwrap().insert(id.clone(), Session { owner: owner.clone(), root: root.clone(), tx, proc_id: Some(proc_id), tcp: None });
    let (a, i, o) = (app.clone(), id.clone(), owner.clone());
    std::thread::spawn(move || {
        let ev = format!("lsp://msg/{i}");
        read_loop(stdout, |m| crate::windows::emit_window(&a, &o, &ev, m));
        finish(&a, &i);
    });
    Ok(id)
}

#[tauri::command]
pub async fn lsp_start(app: AppHandle, window: WebviewWindow, server_id: String, root: String, auto_godot: Option<bool>, bin: Option<String>, path_prepend: Option<Vec<String>>) -> Result<String, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || start_blocking(app, owner, server_id, root, auto_godot.unwrap_or(false), bin, path_prepend.unwrap_or_default())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lsp_send(app: AppHandle, state: State<'_, LspState>, session_id: String, json: String) -> Result<(), String> {
    if session_id.starts_with("godot-") {
        resume_godot(&app); // SIGCONT before the message is queued to the socket, so Godot sees it as soon as it runs
    }
    let g = state.sessions.lock().unwrap();
    let s = g.get(&session_id).ok_or("no such session")?;
    s.tx.send(json.into_bytes()).map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn lsp_stop(state: State<'_, LspState>, session_id: String) {
    let s = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(s) = s {
        if let Some(t) = s.tcp {
            let _ = t.shutdown(std::net::Shutdown::Both);
        }
        if let Some(p) = s.proc_id {
            crate::procs::kill(p);
        }
    }
}

/// A window closed: stop the LSP sessions it owns and drop its claim on shared headless Godots. A Godot whose last user
/// went away is killed right away (other windows on the same root keep it alive).
pub fn release_window(app: &AppHandle, label: &str) {
    let st = app.state::<LspState>();
    let mine: Vec<String> = st.sessions.lock().unwrap().iter().filter(|(_, s)| s.owner == label).map(|(k, _)| k.clone()).collect();
    for id in mine {
        let s = st.sessions.lock().unwrap().remove(&id);
        if let Some(s) = s {
            if let Some(t) = s.tcp {
                let _ = t.shutdown(std::net::Shutdown::Both);
            }
            if let Some(p) = s.proc_id {
                crate::procs::kill(p);
            }
        }
    }
    st.pause.gd_focus.lock().unwrap().remove(label);
    let orphaned: Vec<String> = {
        let mut w = st.warm.lock().unwrap();
        let mut dead = vec![];
        for (root, c) in w.iter_mut() {
            c.users.remove(label);
            if c.users.is_empty() {
                dead.push(root.clone());
            }
        }
        dead
    };
    for root in orphaned {
        drop_warm(&st, &root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_roundtrip_over_tcp() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let srv = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let w = spawn_writer(s.try_clone().unwrap());
            read_loop(s, |m| { w.send(m.clone().into_bytes()).unwrap(); got.push(m); });
            got
        });
        let c = TcpStream::connect(addr).unwrap();
        let tx = spawn_writer(c.try_clone().unwrap());
        let big = format!("{{\"a\":\"{}\"}}", "é".repeat(70000));
        tx.send(b"{\"x\":1}".to_vec()).unwrap();
        tx.send(big.clone().into_bytes()).unwrap();
        let mut echoed = Vec::new();
        read_loop(c.try_clone().unwrap(), |m| { echoed.push(m); if echoed.len() == 2 { c.shutdown(std::net::Shutdown::Both).unwrap(); } });
        assert_eq!(echoed, vec!["{\"x\":1}".to_string(), big]);
        let _ = srv.join();
    }

    #[test]
    fn concurrent_start_spawns_one_godot_per_root() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let st = LspState::default();
        let spawned = AtomicUsize::new(0);
        let spawn = |_r: &str| -> Result<(u16, u64, Option<TcpStream>), String> {
            spawned.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            Ok((4242, 0, None))
        };
        let ports: Vec<u16> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..8).map(|_| s.spawn(|| ensure_godot_with(&st, "w", "/p", &spawn).unwrap())).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(spawned.load(Ordering::SeqCst), 1);
        assert!(ports.iter().all(|p| *p == 4242));
        // failure clears the state so a later call can retry
        let st2 = LspState::default();
        assert!(ensure_godot_with(&st2, "w", "/p", &|_| Err("boom".into())).is_err());
        assert_eq!(ensure_godot_with(&st2, "w", "/p", &|_| Ok((7, 0, None))).unwrap(), 7);
    }
}
