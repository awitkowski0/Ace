//! Process registry. EVERY child process Atelier spawns (pty, ssh, LSP, claude, git long-runners)
//! must be registered here so it is killed on app exit.
//!
//!   let child = std::process::Command::new(..).spawn()?;
//!   let id = crate::procs::register("pty", "zsh", child);   // returns registry id
//!   crate::procs::kill(id);                                  // optional early kill
//!
//! For handles you can't hand over (e.g. portable-pty killers), use `register_killer`.
//!
//! Lifecycle guarantees (see `install`):
//!  * SIGTERM/SIGINT/SIGHUP -> kill_all + ssh close_all -> exit.
//!  * `group(&mut cmd)` before spawn puts the child in its own process group; killing then takes the whole group
//!    (and, for children that did not use it, every descendant found via the process table).
//!  * Every tracked pid is recorded (pid + process start time) in `<data dir>/procs/<owner pid>.json`; on the next
//!    launch, leftovers of dead owners are reaped, but only when pid AND start time still match (pid reuse safe).
#![allow(dead_code)]
use serde::Serialize;
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Mutex, OnceLock};

enum Handle {
    Child(Child),
    Killer(Box<dyn FnMut() + Send>),
}

struct Entry {
    kind: String,
    label: String,
    pid: Option<u32>,
    start: Option<u64>,
    handle: Handle,
}

#[derive(Serialize, Clone)]
pub struct TrackedProc {
    pub id: u64,
    pub kind: String,
    pub label: String,
    pub pid: Option<u32>,
}

#[derive(Default)]
struct Registry {
    next: u64,
    map: HashMap<u64, Entry>,
}

fn reg() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Registry::default()))
}

pub fn register(kind: &str, label: &str, child: Child) -> u64 {
    let pid = Some(child.id());
    insert(kind, label, pid, Handle::Child(child))
}

/// Register an arbitrary kill closure (called once on kill / app exit).
pub fn register_killer(kind: &str, label: &str, pid: Option<u32>, killer: Box<dyn FnMut() + Send>) -> u64 {
    insert(kind, label, pid, Handle::Killer(killer))
}

fn insert(kind: &str, label: &str, pid: Option<u32>, handle: Handle) -> u64 {
    let mut r = reg().lock().unwrap();
    r.next += 1;
    let id = r.next;
    let start = pid.and_then(proc_start);
    r.map.insert(id, Entry { kind: kind.into(), label: label.into(), pid, start, handle });
    persist(&r);
    id
}

/// Forget an entry without killing it (process already exited).
pub fn unregister(id: u64) {
    let mut r = reg().lock().unwrap();
    r.map.remove(&id);
    persist(&r);
}

pub fn kill(id: u64) {
    let e = {
        let mut r = reg().lock().unwrap();
        let e = r.map.remove(&id);
        persist(&r);
        e
    };
    if let Some(e) = e {
        kill_entries(vec![e]);
    }
}

pub fn kill_all() {
    let entries: Vec<Entry> = {
        let mut r = reg().lock().unwrap();
        let v = r.map.drain().map(|(_, e)| e).collect();
        persist(&r);
        v
    };
    kill_entries(entries);
}

/// Two-phase kill: SIGTERM everything (handles first, then group/descendants), wait briefly, SIGKILL leftovers.
fn kill_entries(mut entries: Vec<Entry>) {
    let mut targets: Vec<(u32, bool)> = Vec::new(); // (pid, is group leader)
    for e in entries.iter_mut() {
        let verified = match (e.pid, e.start) {
            (Some(p), Some(s)) => proc_start(p) == Some(s),
            (Some(_), None) => true,
            _ => false,
        };
        if let Some(p) = e.pid.filter(|_| verified) {
            collect_tree(p, &mut targets);
        }
        if let Handle::Killer(k) = &mut e.handle {
            k();
        }
    }
    for (pid, leader) in &targets {
        signal(*pid, *leader, libc::SIGCONT); // a SIGSTOPped process (paused headless Godot) would never act on SIGTERM
        signal(*pid, *leader, libc::SIGTERM);
    }
    let reap = |entries: &mut Vec<Entry>| {
        for e in entries.iter_mut() {
            if let Handle::Child(c) = &mut e.handle {
                let _ = c.try_wait();
            }
        }
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
    loop {
        reap(&mut entries);
        if !targets.iter().any(|(p, _)| alive(*p)) || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    for (pid, leader) in &targets {
        if alive(*pid) {
            signal(*pid, *leader, libc::SIGKILL);
        }
    }
    for e in entries.iter_mut() {
        if let Handle::Child(c) = &mut e.handle {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn own_pgid() -> i32 {
    unsafe { libc::getpgrp() }
}

/// Signal a pid; if it leads its own process group (and it is not ours) signal the whole group.
fn signal(pid: u32, leader: bool, sig: i32) {
    if pid <= 1 || pid == std::process::id() {
        return;
    }
    unsafe {
        if leader && pid as i32 != own_pgid() {
            libc::killpg(pid as i32, sig);
        }
        libc::kill(pid as i32, sig);
    }
}

/// pid plus all descendants (via `ps`), flagged with whether each leads its own group.
fn collect_tree(root: u32, out: &mut Vec<(u32, bool)>) {
    if root <= 1 || root == std::process::id() {
        return;
    }
    let table = process_table();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if out.iter().any(|(q, _)| *q == p) {
            continue;
        }
        let leader = unsafe { libc::getpgid(p as i32) } == p as i32;
        out.push((p, leader));
        for (c, pp) in &table {
            if *pp == p {
                stack.push(*c);
            }
        }
    }
}

fn process_table() -> Vec<(u32, u32)> {
    let Ok(o) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).stdin(std::process::Stdio::null()).output() else {
        return vec![];
    };
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect()
}

/// Call before `spawn()`: the child becomes the leader of a new process group, so the group can be killed as a unit
/// (grandchildren included) and terminal job-control signals no longer reach it.
pub fn group(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0)
}

/// Process start time in microseconds since epoch (identity token that survives pid reuse).
#[cfg(target_os = "macos")]
fn proc_start(pid: u32) -> Option<u64> {
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let sz = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, sz);
        if n < sz {
            return None;
        }
        Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }
}
#[cfg(not(target_os = "macos"))]
fn proc_start(_pid: u32) -> Option<u64> {
    None
}

// ---- pidfile ----

fn pid_dir() -> Option<std::path::PathBuf> {
    Some(dirs::data_dir()?.join("com.alexw.atelier").join("procs"))
}
fn own_file() -> Option<std::path::PathBuf> {
    Some(pid_dir()?.join(format!("{}.json", std::process::id())))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Rec {
    pid: u32,
    start: u64,
    kind: String,
    label: String,
}
#[derive(serde::Serialize, serde::Deserialize)]
struct PidFile {
    owner: u32,
    owner_start: u64,
    procs: Vec<Rec>,
}

fn persist(r: &Registry) {
    let Some(path) = own_file() else { return };
    let procs: Vec<Rec> = r
        .map
        .values()
        .filter_map(|e| Some(Rec { pid: e.pid?, start: e.start?, kind: e.kind.clone(), label: e.label.clone() }))
        .collect();
    if procs.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    let me = std::process::id();
    let f = PidFile { owner: me, owner_start: proc_start(me).unwrap_or(0), procs };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(s) = serde_json::to_vec(&f) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(tmp, path);
        }
    }
}

/// Kill tracked children left behind by Atelier instances that died without cleaning up.
/// Returns how many processes were reaped.
pub fn reap_stale() -> usize {
    let Some(dir) = pid_dir() else { return 0 };
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    let mut reaped = 0;
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(f) = serde_json::from_slice::<PidFile>(&bytes) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if f.owner == std::process::id() {
            continue;
        }
        // Owner still running (another Atelier window/instance)? Leave its children alone.
        if f.owner_start != 0 && proc_start(f.owner) == Some(f.owner_start) {
            continue;
        }
        let mut targets = Vec::new();
        for r in &f.procs {
            if proc_start(r.pid) == Some(r.start) {
                eprintln!("[procs] reaping orphan {} '{}' pid {}", r.kind, r.label, r.pid);
                collect_tree(r.pid, &mut targets);
                reaped += 1;
            }
        }
        for (p, l) in &targets {
            signal(*p, *l, libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for (p, l) in &targets {
            if alive(*p) {
                signal(*p, *l, libc::SIGKILL);
            }
        }
        let _ = std::fs::remove_file(&path);
    }
    reaped
}

/// Install once at startup: signal handlers + stale-child reaper (off the main thread).
pub fn install() {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    if let Ok(mut sigs) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        let _ = std::thread::Builder::new().name("procs-signals".into()).spawn(move || {
            if let Some(sig) = sigs.forever().next() {
                // Watchdog: never hang on shutdown.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    std::process::exit(1);
                });
                kill_all();
                crate::remote::ssh::close_all();
                if let Some(p) = own_file() {
                    let _ = std::fs::remove_file(p);
                }
                std::process::exit(128 + sig);
            }
        });
    }
    let _ = std::thread::Builder::new().name("procs-reaper".into()).spawn(|| {
        reap_stale();
    });
}

/// Pid of a registered process (None once unregistered / killed).
pub fn pid(id: u64) -> Option<u32> {
    reg().lock().unwrap().map.get(&id).and_then(|e| e.pid)
}

pub fn list() -> Vec<TrackedProc> {
    reg().lock().unwrap().map.iter().map(|(id, e)| TrackedProc {
        id: *id, kind: e.kind.clone(), label: e.label.clone(), pid: e.pid,
    }).collect()
}

#[tauri::command]
pub fn procs_list() -> Vec<TrackedProc> {
    list()
}
#[tauri::command]
pub fn procs_kill(id: u64) {
    kill(id)
}
