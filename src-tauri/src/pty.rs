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
    pid: Option<u32>,
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
    /// zsh/bash integration (OSC 7 cwd + OSC 133 prompt marks); default on.
    pub shell_integration: Option<bool>,
    /// Override of $SHELL (tests).
    pub shell: Option<String>,
    /// Local interactive shells only: `<venv>/bin/activate`, sourced once at the first prompt (env `ATELIER_ACTIVATE`).
    pub activate: Option<String>,
    /// Claude notification channel (docs/AI-SESSIONS.md): file the Stop/Notification hooks append to. `claude ...` commands get
    /// `--settings <hooks>`; interactive shells get ATELIER_HOOK_FILE/ATELIER_PANE/ATELIER_CLAUDE_SETTINGS for the `claude` wrapper function.
    #[serde(default)]
    pub hook_file: Option<String>,
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

const ZSHENV: &str = include_str!("shell_integration/zshenv");
const ZSH_INTEGRATION: &str = include_str!("shell_integration/atelier.zsh");
const BASH_RCFILE: &str = include_str!("shell_integration/bash_rcfile");

/// Private directory with the shell-integration files (never the user's dotfiles). Rewritten when the content differs.
fn integration_dir() -> Option<std::path::PathBuf> {
    // zsh/bash only: no POSIX shell integration on Windows (a PowerShell integration can come later)
    if cfg!(windows) {
        return None;
    }
    static D: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    D.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("atelier-shell-integration-v1-{}", crate::platform::user_tag()));
        let zsh = dir.join("zsh");
        std::fs::create_dir_all(&zsh).ok()?;
        for (path, body) in [(zsh.join(".zshenv"), ZSHENV), (zsh.join("atelier.zsh"), ZSH_INTEGRATION), (dir.join("bash_rcfile"), BASH_RCFILE)] {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(body) {
                std::fs::write(&path, body).ok()?;
            }
        }
        Some(dir)
    })
    .clone()
}

/// Default local shell. Windows: `pwsh.exe`, else `powershell.exe`, else `cmd.exe` (first one on PATH).
fn default_shell() -> String {
    #[cfg(windows)]
    {
        let on_path = |exe: &str| std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file())).unwrap_or(false);
        ["pwsh.exe", "powershell.exe"].into_iter().find(|e| on_path(e)).unwrap_or("cmd.exe").to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

fn build_command(o: &SpawnOpts) -> CommandBuilder {
    let mut cb;
    let integ = o.shell_integration.unwrap_or(true) && o.command.is_none();
    if o.host == "local" {
        let shell = o.shell.clone().unwrap_or_else(default_shell);
        let base = shell.rsplit(&['/', '\\'][..]).next().unwrap_or("").to_string();
        let dir = if integ { integration_dir() } else { None };
        cb = CommandBuilder::new(&shell);
        match (&o.command, &dir) {
            (Some(c), _) => {
                // hook wrapping is POSIX-quoted; Windows shells run the command as given
                let wrapped = if o.hook_file.is_some() && !cfg!(windows) { crate::claude_hooks::wrap_command(c, "local") } else { None };
                let c = wrapped.as_deref().unwrap_or(c.as_str());
                if cfg!(windows) {
                    cb.args(if base.eq_ignore_ascii_case("cmd.exe") { ["/C", c] } else { ["-Command", c] });
                } else {
                    cb.args(["-lc", c]);
                }
            }
            (None, Some(d)) if base == "bash" => {
                // bash ignores --rcfile for login shells, so the rcfile emulates the login profile itself.
                cb.args(["--rcfile", d.join("bash_rcfile").to_string_lossy().as_ref(), "-i"]);
                cb.env("ATELIER_SHELL_INTEGRATION", "1");
                if !o.login.unwrap_or(true) {
                    cb.env("ATELIER_BASH_NOLOGIN", "1");
                }
            }
            (None, d) => {
                // `-l` is a POSIX login flag; pwsh/cmd do not take it
                if o.login.unwrap_or(true) && !cfg!(windows) {
                    cb.arg("-l");
                }
                if let (Some(d), "zsh") = (d, base.as_str()) {
                    let z = d.join("zsh");
                    if let Ok(orig) = std::env::var("ZDOTDIR") {
                        cb.env("ATELIER_ZDOTDIR_ORIG", orig);
                    }
                    cb.env("ZDOTDIR", z.to_string_lossy().as_ref());
                    cb.env("ATELIER_SHELL_INTEGRATION_DIR", z.to_string_lossy().as_ref());
                    cb.env("ATELIER_SHELL_INTEGRATION", "1");
                }
            }
        }
        if integ && dir.is_some() {
            if let Some(a) = o.activate.as_deref().filter(|a| std::path::Path::new(a).is_file()) {
                cb.env("ATELIER_ACTIVATE", a);
            }
        }
        let cwd = expand_home(&o.cwd);
        if std::path::Path::new(&cwd).is_dir() {
            cb.cwd(cwd);
        } else if let Some(h) = dirs::home_dir() {
            cb.cwd(h);
        }
        if let (Some(f), Some(id)) = (o.hook_file.as_deref(), o.id.as_deref()) {
            cb.env("ATELIER_HOOK_FILE", f);
            cb.env("ATELIER_PANE", id);
            cb.env("ATELIER_CLAUDE_SETTINGS", crate::claude_hooks::settings_json());
            if let Some(p) = crate::claude_hooks::plugin_dir() {
                cb.env("ATELIER_CLAUDE_PLUGIN_DIR", p);
            }
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
        let hook = o.hook_file.as_deref().zip(o.id.as_deref());
        let remote = match &o.command {
            Some(c) => match hook.and_then(|(f, id)| crate::claude_hooks::wrap_command(c, &o.host).map(|w| (f, id, w))) {
                Some((f, id, w)) => login_wrap(&format!("{cd} && {}{w}", crate::claude_hooks::env_prefix(f, id, false))),
                None => login_wrap(&format!("{cd} && {c}")),
            },
            None if integ => match hook {
                Some((f, id)) => remote_integration_command(&format!("{cd} && export {}", crate::claude_hooks::env_prefix(f, id, true).trim_end())),
                None => remote_integration_command(&cd),
            },
            None => format!("{cd} && exec $SHELL -l"),
        };
        cb.arg(remote);
    }
    cb.env("TERM", "xterm-256color");
    cb.env("COLORTERM", "truecolor");
    cb.env("TERM_PROGRAM", "Ace");
    cb.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cb
}

/// Remote bash with the integration passed through a pipe (`--rcfile <(...)`): nothing is written on the remote host.
/// Other remote shells just get their normal login shell.
pub fn remote_integration_command(cd: &str) -> String {
    let b64 = B64.encode(BASH_RCFILE);
    let inner = format!("ATELIER_SHELL_INTEGRATION=1 exec bash --rcfile <(printf %s {b64} | base64 -d) -i");
    format!("{cd} && if [ \"${{SHELL##*/}}\" = bash ]; then exec bash -c {}; else exec $SHELL -l; fi", crate::remote::ssh::quote(&inner))
}

/// Core spawn path (also used by tests). Returns the session id.
pub fn spawn_with(o: SpawnOpts, owner: &str, sink: Arc<dyn Fn(&str, Out) + Send + Sync>) -> Result<String, String> {
    let id = o.id.clone().unwrap_or_else(|| format!("pty-{}", uuid_like()));
    let o = SpawnOpts { id: Some(id.clone()), ..o };
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
    sessions().lock().unwrap().insert(id.clone(), Session { owner: owner.to_string(), writer, master: pair.master, proc_id, pid, credit: credit.clone() });

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

/// Process group leader of the terminal's foreground job (`tcgetpgrp`). Windows: no such thing, so None (callers fall back
/// to the shell's own pid).
fn foreground_group(master: &(dyn portable_pty::MasterPty + Send)) -> Option<i32> {
    #[cfg(unix)]
    {
        master.process_group_leader()
    }
    #[cfg(not(unix))]
    {
        let _ = master;
        None
    }
}

/// Is something other than the shell itself in the terminal's foreground (a running command)? Local ptys only; a remote
/// shell sits behind `ssh`, so the frontend uses OSC 133 there.
#[tauri::command]
pub fn pty_busy(id: String) -> bool {
    let s = sessions().lock().unwrap();
    let Some(sess) = s.get(&id) else { return false };
    match (foreground_group(&*sess.master), sess.pid) {
        (Some(g), Some(p)) => g as u32 != p,
        _ => false,
    }
}

/// Working directory of the terminal's foreground process (macOS: proc_pidinfo). Fallback for shells without OSC 7.
#[tauri::command]
pub fn pty_cwd(id: String) -> Option<String> {
    let (leader, pid) = {
        let s = sessions().lock().unwrap();
        let sess = s.get(&id)?;
        (foreground_group(&*sess.master), sess.pid)
    };
    let pid = leader.or(pid.map(|p| p as i32))?;
    cwd_of(pid)
}

#[cfg(target_os = "macos")]
fn cwd_of(pid: i32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if n < size {
        return None;
    }
    let bytes: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
}
#[cfg(not(target_os = "macos"))]
fn cwd_of(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned())
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
            SpawnOpts { host: "local".into(), cwd: "/tmp".into(), command: Some("echo hi".into()), cols: 80, rows: 24, login: None, shell_integration: None, shell: None, activate: None, hook_file: None, id: Some("t1".into()) },
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
            SpawnOpts { host: "local".into(), cwd: "/tmp".into(), command: Some("yes | head -c 20000000".into()), cols: 80, rows: 24, login: None, shell_integration: None, shell: None, activate: None, hook_file: None, id: Some("fc1".into()) },
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

    fn run_interactive(shell: &str, id: &str, script: &[&str]) -> String {
        run_interactive_with(shell, id, script, None)
    }

    fn run_interactive_with(shell: &str, id: &str, script: &[&str], activate: Option<String>) -> String {
        let (tx, rx) = std::sync::mpsc::channel::<Out>();
        let tx = Mutex::new(tx);
        let sink: Arc<dyn Fn(&str, Out) + Send + Sync> = Arc::new(move |_, o| {
            let _ = tx.lock().unwrap().send(o);
        });
        spawn_with(
            SpawnOpts { host: "local".into(), cwd: "/tmp".into(), command: None, cols: 80, rows: 24, login: Some(true), shell_integration: Some(true), shell: Some(shell.into()), activate, hook_file: None, id: Some(id.into()) },
            "test",
            sink,
        )
        .unwrap();
        let mut text = Vec::new();
        let mut sent = 0;
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(20) {
            match rx.recv_timeout(Duration::from_millis(700)) {
                Ok(Out::Data(d)) => text.extend(d),
                Ok(Out::Exit(_)) => break,
                Err(_) => {
                    // quiet: next input line
                    if sent < script.len() {
                        pty_write(id.into(), format!("{}\n", script[sent])).unwrap();
                        sent += 1;
                    }
                }
            }
        }
        String::from_utf8_lossy(&text).into_owned()
    }

    #[test]
    fn zsh_integration_emits_osc7_and_osc133() {
        if !std::path::Path::new("/bin/zsh").exists() {
            return;
        }
        let out = run_interactive("/bin/zsh", "zi1", &["cd /usr; echo marker-$((6*7))", "exit"]);
        assert!(out.contains("\x1b]133;A\x07"), "prompt start mark: {out:?}");
        assert!(out.contains("\x1b]133;C\x07"), "output start mark: {out:?}");
        assert!(out.contains("\x1b]133;D;0\x07"), "command finished mark: {out:?}");
        assert!(out.contains("marker-42"));
        assert!(out.contains("\x1b]7;file://") && out.contains("/usr\x07"), "osc7 after cd: {out:?}");
    }

    #[test]
    fn bash_integration_emits_osc7_and_osc133() {
        let bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"].into_iter().find(|p| std::path::Path::new(p).exists());
        let Some(bash) = bash else { return };
        let out = run_interactive(bash, "bi1", &["cd /usr; echo marker-$((6*7))", "exit"]);
        assert!(out.contains("\x1b]133;A\x07"), "prompt start mark: {out:?}");
        assert!(out.contains("\x1b]133;D;0\x07"), "command finished mark: {out:?}");
        assert!(out.contains("marker-42"));
        assert!(out.contains("\x1b]7;file://") && out.contains("/usr\x07"), "osc7 after cd: {out:?}");
    }

    /// Python "Activate virtualenv": the file named by `activate` is sourced once, before the first prompt, in zsh and bash.
    #[test]
    fn activate_script_is_sourced_once_at_the_first_prompt() {
        let dir = std::env::temp_dir().join(format!("ace-activate-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let act = dir.join("activate");
        std::fs::write(&act, "export ACE_ACT_TEST=on-$((20+22))\nACE_ACT_COUNT=$((${ACE_ACT_COUNT:-0}+1)); export ACE_ACT_COUNT\n").unwrap();
        let bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"].into_iter().find(|p| std::path::Path::new(p).exists());
        let shells: Vec<&str> = ["/bin/zsh"].into_iter().filter(|p| std::path::Path::new(p).exists()).chain(bash).collect();
        for (n, sh) in shells.iter().enumerate() {
            let out = run_interactive_with(sh, &format!("act{n}"), &["echo \"A=<$ACE_ACT_TEST> N=<$ACE_ACT_COUNT> E=<${ATELIER_ACTIVATE-unset}>\"", "exit"], Some(act.to_string_lossy().into_owned()));
            assert!(out.contains("A=<on-42> N=<1> E=<unset>"), "{sh}: {out:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_integration_command_is_a_pure_pipe() {
        let c = remote_integration_command("cd ~");
        assert!(c.starts_with("cd ~ && if [ \"${SHELL##*/}\" = bash ]"));
        assert!(c.contains("--rcfile <(printf %s ") && c.contains("base64 -d"));
        assert!(!c.contains("> ") && !c.contains("mktemp") && !c.contains("tee "), "must not write files remotely: {c}");
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
            spawn_with(SpawnOpts { host: "mc".into(), cwd: "~".into(), command: Some(cmd.into()), cols: 100, rows: 30, login: None, shell_integration: None, shell: None, activate: None, hook_file: None, id: Some("ssh1".into()) }, "test", sink).unwrap();
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
