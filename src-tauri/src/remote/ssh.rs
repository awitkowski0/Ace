//! Shared SSH plumbing. Every remote feature (SFTP, terminal, Claude, daemons, git, search) talks to a
//! host through these helpers so they all reuse one multiplexed connection per host (ControlMaster)
//! and honour ~/.ssh/config, the agent and known_hosts.
//!
//!   let out = ssh::exec("mc", "ls ~/.claude/projects")?;          // non-interactive, plain sh
//!   let out = ssh::exec_login("mc", "claude --version")?;         // via `bash -lc` (login PATH)
//!   let mut cmd = ssh::command("mc", true); cmd.arg(ssh::login_wrap("cd /srv && claude -c"));  // pty use
#![allow(dead_code)]
use std::collections::BTreeSet;
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};

fn used_hosts() -> &'static Mutex<BTreeSet<String>> {
    static H: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// `ssh` with multiplexing options for `host`. `tty` adds `-tt` for interactive (pty) sessions.
/// The caller appends the remote command (already shell-quoted, see `quote`/`login_wrap`).
pub fn command(host: &str, tty: bool) -> Command {
    used_hosts().lock().unwrap().insert(host.to_string());
    let mut c = Command::new("ssh");
    c.args(mux_args());
    c.args([
        "-o", "ServerAliveInterval=30",
        "-o", "ConnectTimeout=8",
        "-o", "LogLevel=ERROR",
    ]);
    if tty {
        c.arg("-tt");
    } else {
        c.args(["-o", "BatchMode=yes", "-T"]);
    }
    c.arg(host).arg("--");
    c
}

/// ControlMaster options (one shared connection per host). Windows OpenSSH has no ControlMaster/ControlPath support, so
/// there plain `ssh` runs one connection per call.
#[cfg(not(windows))]
fn mux_args() -> &'static [&'static str] {
    &["-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/atelier-%C", "-o", "ControlPersist=120"]
}
#[cfg(windows)]
fn mux_args() -> &'static [&'static str] {
    &[]
}

/// Single-quote `s` for a POSIX shell.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Wrap a command so it runs in a login shell (needed for `claude`, `gradle`, etc. on mc).
pub fn login_wrap(cmd: &str) -> String {
    format!("bash -lc {}", quote(cmd))
}

/// Run `cmd` on `host` with the remote user's default (non-login) shell and capture output.
pub fn exec(host: &str, cmd: &str) -> Result<Output, String> {
    command(host, false)
        .arg(cmd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("ssh {host}: {e}"))
}

/// Like `exec`, but in a login shell. Returns stdout on success, stderr as the error otherwise.
pub fn exec_login(host: &str, cmd: &str) -> Result<String, String> {
    let out = exec(host, &login_wrap(cmd))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn host_users() -> &'static Mutex<std::collections::BTreeMap<String, BTreeSet<String>>> {
    static H: OnceLock<Mutex<std::collections::BTreeMap<String, BTreeSet<String>>>> = OnceLock::new();
    H.get_or_init(Default::default)
}

fn close_master(host: &str) {
    if cfg!(windows) {
        return; // no ControlMaster to close (see mux_args)
    }
    let _ = Command::new("ssh")
        .args(["-o", "ControlPath=~/.ssh/atelier-%C", "-o", "ConnectTimeout=2", "-O", "exit", host])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// A window starts using `host` (its project root or a terminal lives there). The multiplexed master is shared by all
/// windows; it is closed when the last window that acquired it releases it (or closes).
pub fn acquire(window: &str, host: &str) {
    if host.is_empty() || host == "local" {
        return;
    }
    host_users().lock().unwrap().entry(host.to_string()).or_default().insert(window.to_string());
}

/// Release one window's claim on `host`; closes the master when nobody else holds it.
pub fn release(window: &str, host: &str) {
    let last = {
        let mut m = host_users().lock().unwrap();
        match m.get_mut(host) {
            Some(set) => {
                set.remove(window);
                let empty = set.is_empty();
                if empty {
                    m.remove(host);
                }
                empty
            }
            None => false,
        }
    };
    if last {
        let h = host.to_string();
        std::thread::spawn(move || close_master(&h));
    }
}

pub fn release_window(window: &str) {
    let hosts: Vec<String> = host_users().lock().unwrap().iter().filter(|(_, s)| s.contains(window)).map(|(h, _)| h.clone()).collect();
    for h in hosts {
        release(window, &h);
    }
}

pub fn users_of(host: &str) -> usize {
    host_users().lock().unwrap().get(host).map(|s| s.len()).unwrap_or(0)
}

/// Close every master connection we opened. Called on app exit.
pub fn close_all() {
    if cfg!(windows) {
        return; // no ControlMaster to close (see mux_args)
    }
    let hosts: Vec<String> = used_hosts().lock().unwrap().iter().cloned().collect();
    for h in hosts {
        let _ = Command::new("ssh")
            .args(["-o", "ControlPath=~/.ssh/atelier-%C", "-o", "ConnectTimeout=2", "-O", "exit", &h])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Concrete (non-wildcard) `Host` aliases from ~/.ssh/config.
#[tauri::command]
pub fn remote_hosts() -> Vec<String> {
    let Some(path) = dirs::home_dir().map(|h| h.join(".ssh/config")) else { return vec![] };
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Host ").or_else(|| line.strip_prefix("Host\t")) else { continue };
        for h in rest.split_whitespace() {
            if !h.contains(['*', '?', '!']) && !out.iter().any(|x| x == h) {
                out.push(h.to_string());
            }
        }
    }
    out
}
