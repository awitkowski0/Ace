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
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const GODOT_ADDR: &str = "127.0.0.1:6005";

struct Session {
    tx: Sender<Vec<u8>>,
    proc_id: Option<u64>,
    tcp: Option<TcpStream>,
}

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<String, Session>>,
    next: Mutex<u64>,
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
    Spec { id: "gopls", label: "gopls", bin: "gopls", args: &[] },
    Spec { id: "jdtls", label: "jdtls", bin: "jdtls", args: &[] },
];

/// PATH of the user's login shell (GUI apps start with a minimal PATH). Resolved once.
fn login_path() -> &'static str {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
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
    login_path()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| PathBuf::from(d).join(bin))
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

fn read_loop<R: Read>(r: R, mut emit: impl FnMut(String)) {
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

fn spawn_writer<W: Write + Send + 'static>(mut w: W) -> Sender<Vec<u8>> {
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
        let _ = app.emit(&format!("lsp://closed/{id}"), ());
    }
}
use tauri::Manager;

fn connect_tcp(a: &str) -> Result<TcpStream, String> {
    let addr = a.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("bad addr")?;
    let s = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).map_err(|e| e.to_string())?;
    let _ = s.set_nodelay(true);
    Ok(s)
}

fn start_blocking(app: AppHandle, server_id: String, root: String, auto_godot: bool) -> Result<String, String> {
    let spec = SPECS.iter().find(|s| s.id == server_id).ok_or_else(|| format!("unknown server {server_id}"))?;
    let st = app.state::<LspState>();
    let id = {
        let mut n = st.next.lock().unwrap();
        *n += 1;
        format!("{}-{}", spec.id, *n)
    };
    if spec.bin.is_empty() {
        let mut proc_id = None;
        let sock = match connect_tcp(GODOT_ADDR) {
            Ok(s) => s,
            Err(e) if !auto_godot => return Err(format!("unreachable: {e}")),
            Err(e) => {
                // Auto-start a headless Godot editor on a free port.
                let godot = std::path::Path::new("/Applications/Godot.app/Contents/MacOS/Godot");
                if !godot.is_file() {
                    return Err(format!("unreachable: {e}"));
                }
                let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
                let mut child = Command::new(godot)
                    .args(["--path", &root, "--editor", "--headless", "--lsp-port", &port.to_string()])
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                    .spawn().map_err(|e| e.to_string())?;
                let addr = format!("127.0.0.1:{port}");
                let t0 = std::time::Instant::now();
                let sock = loop {
                    if let Ok(Some(st)) = child.try_wait() {
                        return Err(format!("godot exited early: {st}"));
                    }
                    if let Ok(s) = connect_tcp(&addr) {
                        break s;
                    }
                    if t0.elapsed() > Duration::from_secs(90) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("godot headless: LSP port did not open".into());
                    }
                    std::thread::sleep(Duration::from_millis(200));
                };
                proc_id = Some(crate::procs::register("lsp", "godot-headless", child));
                sock
            }
        };
        let rd = sock.try_clone().map_err(|e| e.to_string())?;
        let wr = sock.try_clone().map_err(|e| e.to_string())?;
        let tx = spawn_writer(wr);
        st.sessions.lock().unwrap().insert(id.clone(), Session { tx, proc_id, tcp: Some(sock) });
        let (a, i) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            let ev = format!("lsp://msg/{i}");
            read_loop(rd, |m| { let _ = a.emit(&ev, m); });
            finish(&a, &i);
        });
        return Ok(id);
    }
    let bin = which(spec.bin).ok_or_else(|| format!("{} not found on PATH", spec.bin))?;
    let mut cmd = Command::new(bin);
    cmd.args(spec.args).env("PATH", login_path()).current_dir(&root);
    if spec.id == "jdtls" {
        let dir = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("atelier/jdtls").join(format!("{:x}", root.bytes().fold(5381u64, |h, b| h.wrapping_mul(33) ^ b as u64)));
        cmd.arg("-data").arg(dir);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let proc_id = crate::procs::register("lsp", spec.label, child);
    let tx = spawn_writer(stdin);
    st.sessions.lock().unwrap().insert(id.clone(), Session { tx, proc_id: Some(proc_id), tcp: None });
    let (a, i) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let ev = format!("lsp://msg/{i}");
        read_loop(stdout, |m| { let _ = a.emit(&ev, m); });
        finish(&a, &i);
    });
    Ok(id)
}

#[tauri::command]
pub async fn lsp_start(app: AppHandle, server_id: String, root: String, auto_godot: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || start_blocking(app, server_id, root, auto_godot.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, session_id: String, json: String) -> Result<(), String> {
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
}
