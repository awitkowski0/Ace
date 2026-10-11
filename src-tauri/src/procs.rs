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

/// Owner of every child registered without an explicit window: killed only when the app exits.
pub const APP_OWNER: &str = "app";

struct Entry {
    owner: String,
    kind: String,
    label: String,
    pid: Option<u32>,
    start: Option<u64>,
    handle: Handle,
}

#[derive(Serialize, Clone)]
pub struct TrackedProc {
    pub id: u64,
    pub owner: String,
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
    register_for(APP_OWNER, kind, label, child)
}

/// Like `register`, but tagged with the window label that owns the child: `kill_owner(label)` kills it when that
/// window closes (the app-wide `kill_all` still takes everything).
pub fn register_for(owner: &str, kind: &str, label: &str, child: Child) -> u64 {
    let pid = Some(child.id());
    insert(owner, kind, label, pid, Handle::Child(child))
}

/// Register an arbitrary kill closure (called once on kill / app exit).
pub fn register_killer(kind: &str, label: &str, pid: Option<u32>, killer: Box<dyn FnMut() + Send>) -> u64 {
    register_killer_for(APP_OWNER, kind, label, pid, killer)
}

pub fn register_killer_for(owner: &str, kind: &str, label: &str, pid: Option<u32>, killer: Box<dyn FnMut() + Send>) -> u64 {
    insert(owner, kind, label, pid, Handle::Killer(killer))
}

/// Move a registered child to another owner (e.g. a shared Godot that outlives the window that started it).
pub fn set_owner(id: u64, owner: &str) {
    if let Some(e) = reg().lock().unwrap().map.get_mut(&id) {
        e.owner = owner.into();
    }
}

fn insert(owner: &str, kind: &str, label: &str, pid: Option<u32>, handle: Handle) -> u64 {
    let mut r = reg().lock().unwrap();
    r.next += 1;
    let id = r.next;
    let start = pid.and_then(proc_start);
    r.map.insert(id, Entry { owner: owner.into(), kind: kind.into(), label: label.into(), pid, start, handle });
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

/// Kill every child registered for `owner` (a window label). Returns how many entries were killed.
pub fn kill_owner(owner: &str) -> usize {
    let entries: Vec<Entry> = {
        let mut r = reg().lock().unwrap();
        let ids: Vec<u64> = r.map.iter().filter(|(_, e)| e.owner == owner).map(|(i, _)| *i).collect();
        let v: Vec<Entry> = ids.iter().filter_map(|i| r.map.remove(i)).collect();
        persist(&r);
        v
    };
    let n = entries.len();
    kill_entries(entries);
    n
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

/// Command-line fragments of shared build daemons. They are NEVER signalled by a window close / Stop: a Gradle client that just
/// spawned a daemon would otherwise take it down with its process group, and every other build using it with it.
const PROTECTED_CMDS: [&str; 2] = ["org.gradle.launcher.daemon.bootstrap.GradleDaemon", "org.jetbrains.kotlin.daemon.KotlinCompileDaemon"];

pub fn is_protected_cmd(cmd: &str) -> bool {
    PROTECTED_CMDS.iter().any(|m| cmd.contains(m))
}

#[derive(Clone)]
struct Pi {
    pid: u32,
    ppid: u32,
    pgid: u32,
    cmd: String,
}

fn take_u32(s: &mut &str) -> Option<u32> {
    let t = s.trim_start();
    let end = t.find(char::is_whitespace).unwrap_or(t.len());
    let v = t[..end].parse().ok()?;
    *s = &t[end..];
    Some(v)
}

fn parse_ps_line(l: &str) -> Option<Pi> {
    let mut r = l;
    let pid = take_u32(&mut r)?;
    let ppid = take_u32(&mut r)?;
    let pgid = take_u32(&mut r)?;
    Some(Pi { pid, ppid, pgid, cmd: r.trim().to_string() })
}

fn process_table_full() -> Vec<Pi> {
    let Ok(o) = std::process::Command::new("ps").args(["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="]).stdin(std::process::Stdio::null()).output() else {
        return vec![];
    };
    String::from_utf8_lossy(&o.stdout).lines().filter_map(parse_ps_line).collect()
}

/// Pids that must survive: every protected daemon and everything below it (workers, forked JVMs).
fn protected_pids(table: &[Pi]) -> std::collections::HashSet<u32> {
    let mut prot: std::collections::HashSet<u32> = table.iter().filter(|p| is_protected_cmd(&p.cmd)).map(|p| p.pid).collect();
    loop {
        let before = prot.len();
        for p in table {
            if prot.contains(&p.ppid) {
                prot.insert(p.pid);
            }
        }
        if prot.len() == before {
            break;
        }
    }
    prot
}

/// pid plus all descendants (via `ps`), flagged with whether each leads its own group. Protected daemons (and their subtrees) are
/// left out; a group that contains one is not signalled as a group but member by member.
fn collect_tree(root: u32, out: &mut Vec<(u32, bool)>) {
    if root <= 1 || root == std::process::id() {
        return;
    }
    let table = process_table_full();
    let prot = protected_pids(&table);
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if out.iter().any(|(q, _)| *q == p) || prot.contains(&p) {
            continue;
        }
        let leader = unsafe { libc::getpgid(p as i32) } == p as i32;
        let group_has_protected = leader && table.iter().any(|q| q.pgid == p && prot.contains(&q.pid));
        if group_has_protected {
            // no killpg: the daemon shares the group. Take the unprotected members one by one.
            out.push((p, false));
            for q in table.iter().filter(|q| q.pgid == p && !prot.contains(&q.pid)) {
                stack.push(q.pid);
            }
        } else {
            out.push((p, leader));
        }
        for c in table.iter().filter(|c| c.ppid == p) {
            stack.push(c.pid);
        }
    }
}

/// Kill every process whose command line contains one of `markers` (TERM, then KILL after `grace`), never a protected daemon.
/// Used for the game JVM of a Gradle debug run: it is a child of the daemon, so it is not part of the client's tree.
/// Returns the pids that were signalled.
pub fn kill_marked(markers: &[String], grace: std::time::Duration) -> Vec<u32> {
    let table = process_table_full();
    let me = std::process::id();
    let hit: Vec<u32> = table
        .iter()
        .filter(|p| p.pid != me && !is_protected_cmd(&p.cmd) && markers.iter().any(|m| !m.is_empty() && p.cmd.contains(m.as_str())))
        .map(|p| p.pid)
        .collect();
    for p in &hit {
        signal(*p, false, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + grace;
    while hit.iter().any(|p| alive(*p)) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    for p in &hit {
        if alive(*p) {
            signal(*p, false, libc::SIGKILL);
        }
    }
    hit
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
                crate::windows::on_signal_exit();
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
        id: *id, owner: e.owner.clone(), kind: e.kind.clone(), label: e.label.clone(), pid: e.pid,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn wait_gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        false
    }
    /// pid of the process whose command line contains `needle` (the fake daemon is not our direct child)
    fn find(needle: &str) -> Option<u32> {
        process_table_full().into_iter().find(|p| p.cmd.ends_with(needle)).map(|p| p.pid)
    }

    #[test]
    fn parses_ps_lines() {
        let p = parse_ps_line("  123   45   123 /bin/sh -c echo  hi").unwrap();
        assert_eq!((p.pid, p.ppid, p.pgid, p.cmd.as_str()), (123, 45, 123, "/bin/sh -c echo  hi"));
    }

    /// Window close / Stop kills the client's tree and process group but never a GradleDaemon sharing that group (or hanging below the client).
    #[test]
    fn kill_spares_gradle_daemons() {
        let tag = format!("acetest{}", std::process::id());
        // client shell (own process group, like runner::local_command): starts a fake daemon in the SAME group, a worker child of the
        // daemon, and an ordinary child that must die with the client.
        let script = format!(
            "(sh -c 'sleep 60; true' org.gradle.launcher.daemon.bootstrap.Grad\"\"leDaemon {tag}d &) ; (sh -c 'sleep 61; true' {tag}c &) ; sh -c 'sleep 62; true' {tag}x"
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        group(&mut cmd);
        let child = cmd.spawn().unwrap();
        let client = child.id();
        let id = register("test", "fake gradle client", child);
        std::thread::sleep(Duration::from_millis(500));
        let daemon = find(&format!("{tag}d")).expect("fake daemon running");
        let other = find(&format!("{tag}c")).expect("ordinary child running");
        assert_eq!(unsafe { libc::getpgid(daemon as i32) }, client as i32, "daemon shares the client's group");
        kill(id);
        assert!(wait_gone(client), "client killed");
        assert!(wait_gone(other), "ordinary child killed with the client");
        assert!(alive(daemon), "daemon survived the client's kill");
        // marker kill never touches a daemon even when the marker matches
        let hit = kill_marked(&[tag.clone()], Duration::from_millis(300));
        assert!(!hit.contains(&daemon) && alive(daemon));
        unsafe { libc::kill(daemon as i32, libc::SIGKILL) };
        assert!(wait_gone(daemon));
    }

    #[test]
    fn kill_marked_kills_only_matches() {
        let tag = format!("acemark{}", std::process::id());
        let a = Command::new("/bin/sh").args(["-c", &format!("sleep 63; true # {tag}")]).spawn().unwrap();
        let mut b = Command::new("/bin/sleep").arg("64").spawn().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let ap = a.id();
        let mut a = a;
        let hit = kill_marked(&[tag], Duration::from_millis(300));
        let _ = a.wait();
        assert!(hit.contains(&ap), "{hit:?}");
        assert!(b.try_wait().unwrap().is_none(), "unrelated process untouched");
        let _ = b.kill();
        let _ = b.wait();
    }
}
