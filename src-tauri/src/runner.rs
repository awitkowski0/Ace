//! Generic process runner behind Run configurations, the debuggee, the Python Console and package operations.
//! Local = a piped child in its own process group; remote (ssh alias) = `ssh -tt host bash -lc '<script>'` so killing the
//! local ssh hangs the remote command up. Every child is registered with `procs::register_for(window)`.
//!
//!   run_start({id?, spec, label?, kind?}) -> runId   events (window-scoped):
//!       `run://out/<id>`  [{s:"out"|"err", d: string}]   coalesced (~8 ms) segments in arrival order
//!       `run://exit/<id>` {code: number|null, signal: number|null}
//!   run_write(id, data)  run_close_stdin(id)  run_stop(id)
//!   proc_exec({spec, stdin?, timeoutMs?}) -> {code, stdout, stderr, timedOut}   one-shot capture
use crate::remote::ssh;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewWindow};

/// What to run and where. `argv` is exec'd directly; `shell` is a command line run by a login shell instead.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Spec {
    pub host: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub shell: Option<String>,
    pub env: HashMap<String, String>,
    /// directories put in front of PATH (a venv's bin dir)
    pub path_prepend: Vec<String>,
}

impl Spec {
    pub fn is_local(&self) -> bool {
        self.host.is_empty() || self.host == "local"
    }
}

fn expand_home(p: &str) -> String {
    if p == "~" || p.starts_with("~/") {
        if let Some(h) = dirs::home_dir() {
            return format!("{}{}", h.display(), &p[1..]);
        }
    }
    p.to_string()
}

const BASE_ENV: [(&str, &str); 2] = [("PYTHONUNBUFFERED", "1"), ("PYTHONIOENCODING", "utf-8")];

fn local_command(s: &Spec) -> Result<Command, String> {
    let mut cmd = if let Some(sh) = &s.shell {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", sh]);
        c
    } else {
        let first = s.argv.first().ok_or("empty command")?;
        let mut c = Command::new(first);
        c.args(&s.argv[1..]);
        c
    };
    let cwd = expand_home(&s.cwd);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    let mut path = s.path_prepend.join(":");
    if !path.is_empty() {
        path.push(':');
    }
    path.push_str(crate::lsp::login_path());
    cmd.env("PATH", path);
    for (k, v) in BASE_ENV {
        cmd.env(k, v);
    }
    cmd.envs(&s.env);
    if let Some(v) = s.path_prepend.first() {
        // `<venv>/bin` -> VIRTUAL_ENV, like an activated environment (does not override an explicit value)
        if let Some(root) = v.strip_suffix("/bin") {
            if !s.env.contains_key("VIRTUAL_ENV") && std::path::Path::new(root).join("pyvenv.cfg").is_file() {
                cmd.env("VIRTUAL_ENV", root);
            }
        }
    }
    crate::procs::group(&mut cmd);
    Ok(cmd)
}

fn valid_env_name(k: &str) -> bool {
    !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.chars().next().unwrap().is_ascii_digit()
}

pub fn remote_script(s: &Spec, tty_quiet: bool) -> String {
    let cd = if s.cwd.is_empty() || s.cwd == "~" {
        "cd ~".to_string()
    } else if let Some(rest) = s.cwd.strip_prefix("~/") {
        format!("cd ~/{}", ssh::quote(rest))
    } else {
        format!("cd {}", ssh::quote(&s.cwd))
    };
    let mut parts = vec![cd];
    if tty_quiet {
        parts.push("{ stty -echo -onlcr 2>/dev/null || true; }".into());
    }
    for (k, v) in BASE_ENV {
        parts.push(format!("export {k}={v}"));
    }
    for (k, v) in &s.env {
        if valid_env_name(k) {
            parts.push(format!("export {k}={}", ssh::quote(v)));
        }
    }
    if !s.path_prepend.is_empty() {
        parts.push(format!("export PATH={}:\"$PATH\"", ssh::quote(&s.path_prepend.join(":"))));
    }
    if let Some(v) = s.path_prepend.first().and_then(|v| v.strip_suffix("/bin")) {
        if !s.env.contains_key("VIRTUAL_ENV") {
            parts.push(format!("[ -f {} ] && export VIRTUAL_ENV={}", ssh::quote(&format!("{v}/pyvenv.cfg")), ssh::quote(v)));
        }
    }
    match &s.shell {
        Some(sh) => parts.push(sh.clone()),
        None => parts.push(format!("exec {}", s.argv.iter().map(|a| ssh::quote(a)).collect::<Vec<_>>().join(" "))),
    }
    parts.join(" && ")
}

pub fn command_for(s: &Spec, tty: bool) -> Result<Command, String> {
    if s.is_local() { local_command(s) } else { Ok(remote_command(s, tty)) }
}

fn remote_command(s: &Spec, tty: bool) -> Command {
    let mut c = ssh::command(&s.host, tty);
    c.arg(ssh::login_wrap(&remote_script(s, tty)));
    crate::procs::group(&mut c);
    c
}

// ---------------------------------------------------------------- one-shot exec

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

pub fn exec(owner: &str, s: &Spec, stdin: Option<&str>, timeout: Duration) -> Result<ExecOut, String> {
    let mut cmd = if s.is_local() { local_command(s)? } else { remote_command(s, false) };
    let mut child = cmd
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", s.argv.first().map(String::as_str).unwrap_or("command")))?;
    let pid = child.id();
    let pid_reg = crate::procs::register_killer_for(owner, "exec", s.argv.first().map(String::as_str).unwrap_or("sh"), Some(pid), Box::new(|| {}));
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        let text = text.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = si.write_all(&text);
        });
    }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let h1 = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let h2 = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let t0 = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {}
            Err(_) => break None,
        }
        if t0.elapsed() > timeout {
            timed_out = true;
            crate::procs::kill(pid_reg);
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    crate::procs::unregister(pid_reg);
    let stdout = String::from_utf8_lossy(&h1.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&h2.join().unwrap_or_default()).into_owned();
    Ok(ExecOut { code: status.and_then(|s| s.code().or_else(|| s.signal().map(|g| 128 + g))), stdout, stderr, timed_out })
}

#[tauri::command]
pub async fn proc_exec(window: WebviewWindow, spec: Spec, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<ExecOut, String> {
    let owner = window.label().to_string();
    if !spec.is_local() {
        ssh::acquire(&owner, &spec.host);
    }
    tauri::async_runtime::spawn_blocking(move || exec(&owner, &spec, stdin.as_deref(), Duration::from_millis(timeout_ms.unwrap_or(60_000))))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- streaming runs

struct Run {
    owner: String,
    stdin: Option<ChildStdin>,
    proc_id: u64,
    pid: u32,
    local: bool,
}

fn runs() -> &'static Mutex<HashMap<String, Run>> {
    static R: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

enum Msg {
    Data(bool, Vec<u8>),
    Exit(Option<i32>, Option<i32>),
}

#[derive(Serialize, Clone)]
struct Seg {
    s: &'static str,
    d: String,
}

/// Append `bytes` to `carry`, return the longest valid UTF-8 prefix as text and keep an incomplete trailing sequence.
fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                return out;
            }
            Err(e) => {
                let ok = e.valid_up_to();
                out.push_str(std::str::from_utf8(&carry[..ok]).unwrap());
                match e.error_len() {
                    None => {
                        carry.drain(..ok);
                        return out;
                    }
                    Some(n) => {
                        out.push('\u{FFFD}');
                        carry.drain(..ok + n);
                    }
                }
            }
        }
    }
}

fn pump<R: Read + Send + 'static>(mut r: R, err: bool, tx: Sender<Msg>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Msg::Data(err, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub fn run_start(app: AppHandle, window: WebviewWindow, id: Option<String>, spec: Spec, label: Option<String>, kind: Option<String>) -> Result<String, String> {
    let owner = window.label().to_string();
    let id = id.unwrap_or_else(|| format!("run-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let local = spec.is_local();
    if !local {
        ssh::acquire(&owner, &spec.host);
    }
    let mut cmd = if local { local_command(&spec)? } else { remote_command(&spec, true) };
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", spec.argv.first().map(String::as_str).unwrap_or("command")))?;
    let pid = child.id();
    let label = label.unwrap_or_else(|| spec.argv.first().cloned().unwrap_or_else(|| "sh".into()));
    let proc_id = crate::procs::register_killer_for(&owner, kind.as_deref().unwrap_or("run"), &label, Some(pid), Box::new(|| {}));
    let stdin = child.stdin.take();
    runs().lock().unwrap().insert(id.clone(), Run { owner: owner.clone(), stdin, proc_id, pid, local });
    let (tx, rx) = channel::<Msg>();
    pump(child.stdout.take().unwrap(), false, tx.clone());
    pump(child.stderr.take().unwrap(), true, tx.clone());
    let wtx = tx;
    let wid = id.clone();
    std::thread::Builder::new().name(format!("run-wait-{wid}")).spawn(move || {
        let st = child.wait().ok();
        let _ = wtx.send(Msg::Exit(st.and_then(|s| s.code()), st.and_then(|s| s.signal())));
    }).map_err(|e| e.to_string())?;
    let eid = id.clone();
    std::thread::Builder::new().name(format!("run-emit-{eid}")).spawn(move || {
        let ev_out = format!("run://out/{eid}");
        let mut carry = [Vec::new(), Vec::new()];
        let mut exit: Option<(Option<i32>, Option<i32>)> = None;
        let mut exit_at: Option<Instant> = None;
        'outer: loop {
            let first = match exit_at {
                // after the process exited, give the pipes a moment to drain (grandchildren may keep them open)
                Some(t) => match rx.recv_timeout(Duration::from_millis(150).saturating_sub(t.elapsed())) {
                    Ok(m) => Some(m),
                    Err(_) => break 'outer,
                },
                None => match rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break 'outer,
                },
            };
            let mut segs: Vec<Seg> = Vec::new();
            let mut total = 0usize;
            let mut handle = |m: Msg, segs: &mut Vec<Seg>, total: &mut usize, exit: &mut Option<(Option<i32>, Option<i32>)>, exit_at: &mut Option<Instant>| match m {
                Msg::Data(err, b) => {
                    *total += b.len();
                    let t = decode(&mut carry[err as usize], &b);
                    if t.is_empty() {
                        return;
                    }
                    let s = if err { "err" } else { "out" };
                    match segs.last_mut() {
                        Some(l) if l.s == s => l.d.push_str(&t),
                        _ => segs.push(Seg { s, d: t }),
                    }
                }
                Msg::Exit(c, g) => {
                    *exit = Some((c, g));
                    *exit_at = Some(Instant::now());
                }
            };
            handle(first.unwrap(), &mut segs, &mut total, &mut exit, &mut exit_at);
            let deadline = Instant::now() + Duration::from_millis(8);
            while total < 64 * 1024 {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(m) => handle(m, &mut segs, &mut total, &mut exit, &mut exit_at),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            if !segs.is_empty() {
                crate::windows::emit_window(&app, &owner, &ev_out, segs);
            }
        }
        // flush a dangling partial sequence
        for (i, c) in carry.iter_mut().enumerate() {
            if !c.is_empty() {
                let d = String::from_utf8_lossy(c).into_owned();
                crate::windows::emit_window(&app, &owner, &ev_out, vec![Seg { s: if i == 1 { "err" } else { "out" }, d }]);
            }
        }
        if let Some(r) = runs().lock().unwrap().remove(&eid) {
            crate::procs::unregister(r.proc_id);
        }
        let (code, sig) = exit.unwrap_or((None, None));
        crate::windows::emit_window(&app, &owner, &format!("run://exit/{eid}"), serde_json::json!({ "code": code, "signal": sig }));
    }).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn run_write(id: String, data: String) -> Result<(), String> {
    let mut g = runs().lock().unwrap();
    let r = g.get_mut(&id).ok_or("process is not running")?;
    let si = r.stdin.as_mut().ok_or("stdin closed")?;
    si.write_all(data.as_bytes()).and_then(|_| si.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_close_stdin(id: String) {
    if let Some(r) = runs().lock().unwrap().get_mut(&id) {
        r.stdin = None;
    }
}

/// Stop = SIGTERM to the process tree, SIGKILL after ~400 ms (procs::kill). The exit event follows.
#[tauri::command]
pub fn run_stop(id: String) {
    let p = runs().lock().unwrap().get(&id).map(|r| r.proc_id);
    if let Some(p) = p {
        std::thread::spawn(move || crate::procs::kill(p));
    }
}

/// Ctrl+C: SIGINT to the local process group, or ^C through the ssh pty for remote runs.
#[tauri::command]
pub fn run_interrupt(id: String) {
    let mut g = runs().lock().unwrap();
    if let Some(r) = g.get_mut(&id) {
        if r.local {
            unsafe { libc::killpg(r.pid as i32, libc::SIGINT) };
        } else if let Some(si) = r.stdin.as_mut() {
            let _ = si.write_all(&[3]).and_then(|_| si.flush());
        }
    }
}

/// (client pid, local) of a streaming run; used by the Gradle soft stop.
pub fn run_pid(id: &str) -> Option<(u32, bool)> {
    runs().lock().unwrap().get(id).map(|r| (r.pid, r.local))
}

#[tauri::command]
pub fn run_alive(id: String) -> bool {
    runs().lock().unwrap().contains_key(&id)
}

pub fn release_window(label: &str) {
    runs().lock().unwrap().retain(|_, r| r.owner != label);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_keeps_split_utf8() {
        let mut c = Vec::new();
        let b = "é€".as_bytes();
        let a = decode(&mut c, &b[..1]);
        assert_eq!(a, "");
        let a = decode(&mut c, &b[1..3]);
        assert_eq!(a, "é");
        let a = decode(&mut c, &b[3..]);
        assert_eq!(a, "€");
        assert!(c.is_empty());
    }

    #[test]
    fn exec_captures_and_times_out() {
        let spec = Spec { host: "local".into(), cwd: "/tmp".into(), argv: vec!["/bin/sh".into(), "-c".into(), "echo hi; echo err >&2; exit 3".into()], ..Default::default() };
        let o = exec("test", &spec, None, Duration::from_secs(5)).unwrap();
        assert_eq!((o.code, o.stdout.trim(), o.stderr.trim()), (Some(3), "hi", "err"));
        let spec = Spec { host: "local".into(), argv: vec!["/bin/sleep".into(), "30".into()], ..Default::default() };
        let o = exec("test", &spec, None, Duration::from_millis(150)).unwrap();
        assert!(o.timed_out);
    }

    #[test]
    fn remote_script_quotes() {
        let spec = Spec { host: "mc".into(), cwd: "/srv/my app".into(), argv: vec!["python3".into(), "-c".into(), "print('x y')".into()], path_prepend: vec!["/srv/my app/.venv/bin".into()], ..Default::default() };
        let s = remote_script(&spec, true);
        assert!(s.starts_with("cd '/srv/my app' &&"), "{s}");
        assert!(s.contains("exec 'python3' '-c' 'print('\\''x y'\\'')'"), "{s}");
        assert!(s.contains("export PATH='/srv/my app/.venv/bin':\"$PATH\""), "{s}");
    }
}
