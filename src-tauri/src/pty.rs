//! Terminal sessions (portable-pty). Local login shells and `ssh -tt` remote shells.
//!
//! Events: `pty://data/<id>` (base64 string, coalesced ~4ms / 64KB), `pty://exit/<id>` (exit code or null).
//! The frontend may pass its own `id` so it can subscribe before the first byte is produced.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::Condvar;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const COALESCE: Duration = Duration::from_millis(4);
const MAX_CHUNK: usize = 64 * 1024;
/// Flow control: bytes emitted to the frontend but not yet acknowledged (`pty_ack`) before the emitter blocks.
/// A blocked emitter fills the bounded channel, which blocks the reader, which makes the pty (and the child) wait.
const HIGH_WATER: usize = 1024 * 1024;

/// Unacknowledged byte counter shared by the emitter thread and `pty_ack`.
struct Credit {
    unacked: Mutex<usize>,
    cv: Condvar,
}

struct Session {
    owner: String,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    proc_id: u64,
    credit: Arc<Credit>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    pub host: String,
    pub cwd: String,
    pub command: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub login: Option<bool>,
    pub id: Option<String>,
}

/// Output sink: (data bytes) / (exit code).
pub enum Out {
    Data(Vec<u8>),
    Exit(Option<u32>),
}

fn expand_home(p: &str) -> String {
    if p == "~" || p.starts_with("~/") {
        if let Some(h) = dirs::home_dir() {
            return format!("{}{}", h.display(), &p[1..]);
        }
    }
    p.to_string()
}

fn build_command(o: &SpawnOpts) -> CommandBuilder {
    let mut cb;
    if o.host == "local" {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        cb = CommandBuilder::new(&shell);
        match &o.command {
            Some(c) => {
                cb.args(["-lc", c.as_str()]);
            }
            None => {
                if o.login.unwrap_or(true) {
                    cb.arg("-l");
                }
            }
        }
        let cwd = expand_home(&o.cwd);
        if std::path::Path::new(&cwd).is_dir() {
            cb.cwd(cwd);
        } else if let Some(h) = dirs::home_dir() {
            cb.cwd(h);
        }
    } else {
        use crate::remote::ssh::{command, login_wrap, quote};
        let c = command(&o.host, true);
        cb = CommandBuilder::new(c.get_program());
        for a in c.get_args() {
            cb.arg(a);
        }
        let cd = if o.cwd.is_empty() || o.cwd == "~" {
            "cd ~".to_string()
        } else if let Some(rest) = o.cwd.strip_prefix("~/") {
            format!("cd ~/{}", quote(rest))
        } else {
            format!("cd {}", quote(&o.cwd))
        };
        let remote = match &o.command {
            Some(c) => login_wrap(&format!("{cd} && {c}")),
            None => format!("{cd} && exec $SHELL -l"),
        };
        cb.arg(remote);
    }
    cb.env("TERM", "xterm-256color");
    cb.env("COLORTERM", "truecolor");
    cb.env("TERM_PROGRAM", "Atelier");
    cb
}

/// Core spawn path (also used by tests). Returns the session id.
pub fn spawn_with(o: SpawnOpts, owner: &str, sink: Arc<dyn Fn(&str, Out) + Send + Sync>) -> Result<String, String> {
    let id = o.id.clone().unwrap_or_else(|| format!("pty-{}", uuid_like()));
    let pair = native_pty_system()
        .openpty(PtySize { rows: o.rows.max(1), cols: o.cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let cb = build_command(&o);
    let mut child = pair.slave.spawn_command(cb).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut killer: Box<dyn ChildKiller + Send + Sync> = child.clone_killer();
    let pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let label = if o.host == "local" { "terminal".to_string() } else { format!("terminal@{}", o.host) };
    let proc_id = crate::procs::register_killer_for(owner, "pty", &label, pid, Box::new(move || {
        let _ = killer.kill();
    }));
    let credit = Arc::new(Credit { unacked: Mutex::new(0), cv: Condvar::new() });
    sessions().lock().unwrap().insert(id.clone(), Session { owner: owner.to_string(), writer, master: pair.master, proc_id, credit: credit.clone() });

    let (tx, rx) = sync_channel::<Vec<u8>>(64);
    std::thread::Builder::new().name(format!("pty-read-{id}")).spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    }).map_err(|e| e.to_string())?;

    let eid = id.clone();
    std::thread::Builder::new().name(format!("pty-emit-{id}")).spawn(move || {
        // Wait (bounded) until the frontend has caught up; gives up if the session vanished or never acks.
        let wait_credit = |eid: &str, n: usize| {
            let mut g = credit.unacked.lock().unwrap();
            let t0 = Instant::now();
            while *g > HIGH_WATER && t0.elapsed() < Duration::from_secs(30) {
                if !sessions().lock().unwrap().contains_key(eid) {
                    break;
                }
                g = credit.cv.wait_timeout(g, Duration::from_millis(200)).unwrap().0;
            }
            *g += n;
        };
        'outer: loop {
            let mut acc = match rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            };
            let deadline = Instant::now() + COALESCE;
            while acc.len() < MAX_CHUNK {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(c) => acc.extend_from_slice(&c),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        wait_credit(&eid, acc.len());
                        sink(&eid, Out::Data(acc));
                        break 'outer;
                    }
                }
            }
            wait_credit(&eid, acc.len());
            sink(&eid, Out::Data(acc));
        }
        let code = child.wait().ok().map(|s| s.exit_code());
        if let Some(s) = sessions().lock().unwrap().remove(&eid) {
            crate::procs::unregister(s.proc_id);
        }
        sink(&eid, Out::Exit(code));
    }).map_err(|e| e.to_string())?;
    Ok(id)
}

fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{:x}-{}", t, N.fetch_add(1, Ordering::Relaxed))
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, window: tauri::WebviewWindow, opts: SpawnOpts) -> Result<String, String> {
    // Output goes to the window that spawned the terminal and to no other window.
    let owner = window.label().to_string();
    if opts.host != "local" {
        crate::remote::ssh::acquire(&owner, &opts.host);
    }
    let label = owner.clone();
    let sink: Arc<dyn Fn(&str, Out) + Send + Sync> = Arc::new(move |id, out| match out {
        Out::Data(d) => crate::windows::emit_window(&app, &label, &format!("pty://data/{id}"), B64.encode(d)),
        Out::Exit(c) => crate::windows::emit_window(&app, &label, &format!("pty://exit/{id}"), c),
    });
    spawn_with(opts, &owner, sink)
}

/// A window closed: drop its terminals (the children themselves are killed by `procs::kill_owner`).
pub fn release_window(label: &str) {
    sessions().lock().unwrap().retain(|_, s| s.owner != label);
}

#[tauri::command]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let mut s = sessions().lock().unwrap();
    let sess = s.get_mut(&id).ok_or("no such pty")?;
    sess.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    sess.writer.flush().map_err(|e| e.to_string())
}

/// Frontend acknowledges `bytes` it has finished writing into xterm (flow control).
#[tauri::command]
pub fn pty_ack(id: String, bytes: usize) {
    let c = sessions().lock().unwrap().get(&id).map(|s| s.credit.clone());
    if let Some(c) = c {
        let mut g = c.unacked.lock().unwrap();
        *g = g.saturating_sub(bytes);
        c.cv.notify_all();
    }
}

#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let s = sessions().lock().unwrap();
    let sess = s.get(&id).ok_or("no such pty")?;
    sess.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: String) {
    let s = sessions().lock().unwrap().remove(&id);
    if let Some(s) = s {
        crate::procs::kill(s.proc_id);
        // dropping master/writer closes the pty so the reader thread ends
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_echo_hi() {
        let (tx, rx) = std::sync::mpsc::channel::<Out>();
        let tx = Mutex::new(tx);
        let sink: Arc<dyn Fn(&str, Out) + Send + Sync> = Arc::new(move |_, o| {
            let _ = tx.lock().unwrap().send(o);
        });
        let id = spawn_with(
            SpawnOpts { host: "local".into(), cwd: "/tmp".into(), command: Some("echo hi".into()), cols: 80, rows: 24, login: None, id: Some("t1".into()) },
            "test",
            sink,
        )
        .unwrap();
        assert_eq!(id, "t1");
        let mut text = Vec::new();
        let mut code = None;
        while let Ok(o) = rx.recv_timeout(Duration::from_secs(10)) {
            match o {
                Out::Data(d) => text.extend(d),
                Out::Exit(c) => {
                    code = c;
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&text).contains("hi"), "{:?}", String::from_utf8_lossy(&text));
        assert_eq!(code, Some(0));
        assert!(sessions().lock().unwrap().get("t1").is_none());
    }

    #[test]
    fn flow_control_pauses_until_ack() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let got = Arc::new(AtomicUsize::new(0));
        let g2 = got.clone();
        let sink: Arc<dyn Fn(&str, Out) + Send + Sync> = Arc::new(move |_, o| {
            if let Out::Data(d) = o {
                g2.fetch_add(d.len(), Ordering::SeqCst);
            }
        });
        spawn_with(
            SpawnOpts { host: "local".into(), cwd: "/tmp".into(), command: Some("yes | head -c 20000000".into()), cols: 80, rows: 24, login: None, id: Some("fc1".into()) },
            "test",
            sink,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let paused = got.load(Ordering::SeqCst);
        assert!(paused > 0 && paused <= HIGH_WATER + 3 * MAX_CHUNK, "unacked output must stop near the high-water mark, got {paused}");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(got.load(Ordering::SeqCst), paused, "no further output without acks");
        // ack as we go until the child finishes
        let t0 = Instant::now();
        let mut acked = 0;
        while sessions().lock().unwrap().contains_key("fc1") && t0.elapsed() < Duration::from_secs(20) {
            let now = got.load(Ordering::SeqCst);
            if now > acked {
                pty_ack("fc1".into(), now - acked);
                acked = now;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(got.load(Ordering::SeqCst) >= 19_000_000);
    }

    /// Live: `ssh -tt mc` pty path with login_wrap. Run: cargo test pty::tests::live_ssh -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_ssh() {
        for cmd in ["claude --version", "claude --resume --help | head -3"] {
            let (tx, rx) = std::sync::mpsc::channel::<Out>();
            let tx = Mutex::new(tx);
            let sink: Arc<dyn Fn(&str, Out) + Send + Sync> = Arc::new(move |_, o| {
                let _ = tx.lock().unwrap().send(o);
            });
            spawn_with(SpawnOpts { host: "mc".into(), cwd: "~".into(), command: Some(cmd.into()), cols: 100, rows: 30, login: None, id: Some("ssh1".into()) }, "test", sink).unwrap();
            let mut text = Vec::new();
            let mut code = None;
            while let Ok(o) = rx.recv_timeout(Duration::from_secs(30)) {
                match o {
                    Out::Data(d) => text.extend(d),
                    Out::Exit(c) => { code = c; break; }
                }
            }
            println!("[{cmd}] exit={code:?} out={:?}", String::from_utf8_lossy(&text));
            assert_eq!(code, Some(0));
        }
    }
}
