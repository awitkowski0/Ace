//! Remote watch. Prefers `inotifywait -m -r` over ssh when the host has it (probed once per host);
//! otherwise polls the directories that have recently been listed (hot dirs), in ONE ssh round trip per
//! tick, every 3s and only while the app window is focused. Backs off to 10s after 10 quiet ticks.
//! Emits the same `fs://changed` shape as the local watcher.
use super::{run, spawn_tracked, ssh};
use crate::location::Location;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
struct Changed {
    root: String,
    paths: Vec<String>,
    kind: String,
}

struct Handle {
    stop: Arc<AtomicBool>,
    proc_id: Option<u64>,
}

fn watches() -> &'static Mutex<HashMap<(String, String), Handle>> {
    static W: OnceLock<Mutex<HashMap<(String, String), Handle>>> = OnceLock::new();
    W.get_or_init(Default::default)
}
fn hot() -> &'static Mutex<HashMap<(String, String), Instant>> {
    static H: OnceLock<Mutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    H.get_or_init(Default::default)
}
fn inotify_probe() -> &'static Mutex<HashMap<String, bool>> {
    static P: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Record that `path` was listed (it's "open"); the poller watches recently-listed dirs only.
pub fn touch_hot(host: &str, path: &str) {
    let mut h = hot().lock().unwrap();
    h.insert((host.to_string(), path.to_string()), Instant::now());
    if h.len() > 200 {
        h.retain(|_, t| t.elapsed() < Duration::from_secs(600));
    }
}

fn hot_dirs(host: &str, root: &str) -> Vec<String> {
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let mut v: Vec<(Instant, String)> = hot()
        .lock()
        .unwrap()
        .iter()
        .filter(|((h, p), t)| h == host && t.elapsed() < Duration::from_secs(600) && (p == root || p.starts_with(&prefix)))
        .map(|((_, p), t)| (*t, p.clone()))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().take(40).map(|(_, p)| p).collect()
}

fn has_inotify(host: &str) -> bool {
    if let Some(v) = inotify_probe().lock().unwrap().get(host) {
        return *v;
    }
    let ok = run(host, "command -v inotifywait >/dev/null 2>&1 && echo yes").map(|o| !o.is_empty()).unwrap_or(false);
    inotify_probe().lock().unwrap().insert(host.to_string(), ok);
    ok
}

fn focused(app: &AppHandle) -> bool {
    let wins = app.webview_windows();
    wins.is_empty() || wins.values().any(|w| w.is_focused().unwrap_or(true))
}

pub fn watch(app: AppHandle, loc: Location) -> Result<(), String> {
    let key = (loc.host.clone(), loc.path.clone());
    if watches().lock().unwrap().contains_key(&key) {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let host = loc.host.clone();
    let root = loc.path.clone();
    let mut proc_id = None;
    if has_inotify(&host) {
        let script = format!(
            "inotifywait -m -r -q -e create,delete,modify,moved_to,moved_from --exclude '/(\\.git|node_modules|target|\\.godot)(/|$)' --format '%e|%w%f' {}",
            ssh::quote(&root)
        );
        let mut cmd = ssh::command(&host, false);
        cmd.arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let (mut child, id) = spawn_tracked(cmd, "ssh", &format!("inotifywait {host}:{root}"))?;
        proc_id = Some(id);
        let out = child.stdout.take().unwrap();
        let (stop2, host2, root2) = (stop.clone(), host.clone(), root.clone());
        std::thread::spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some((ev, p)) = line.split_once('|') {
                        let kind = if ev.contains("CREATE") || ev.contains("MOVED_TO") { "create" } else if ev.contains("DELETE") || ev.contains("MOVED_FROM") { "remove" } else { "modify" };
                        if tx.send((kind.to_string(), p.to_string())).is_err() {
                            break;
                        }
                    }
                }
            });
            // debounce 150ms
            loop {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(first) => {
                        let mut batch: HashMap<String, Vec<String>> = HashMap::new();
                        batch.entry(first.0).or_default().push(first.1);
                        let t0 = Instant::now();
                        while t0.elapsed() < Duration::from_millis(150) {
                            if let Ok((k, p)) = rx.recv_timeout(Duration::from_millis(50)) {
                                batch.entry(k).or_default().push(p);
                            }
                        }
                        for (k, mut paths) in batch {
                            paths.sort();
                            paths.dedup();
                            for p in &paths {
                                super::ops::invalidate(&host2, p);
                            }
                            let _ = app.emit("fs://changed", Changed { root: root2.clone(), paths, kind: k });
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
            }
            let _ = child.wait();
        });
    } else {
        let (stop2, host2, root2) = (stop.clone(), host.clone(), root.clone());
        std::thread::spawn(move || poll_loop(app, stop2, host2, root2));
    }
    watches().lock().unwrap().insert(key, Handle { stop, proc_id });
    Ok(())
}

pub fn unwatch(loc: &Location) {
    if let Some(h) = watches().lock().unwrap().remove(&(loc.host.clone(), loc.path.clone())) {
        h.stop.store(true, Ordering::Relaxed);
        if let Some(id) = h.proc_id {
            crate::procs::kill(id);
        }
    }
}

type Snap = HashMap<String, HashMap<String, (u64, String)>>; // dir -> path -> (size, mtime)

fn poll_loop(app: AppHandle, stop: Arc<AtomicBool>, host: String, root: String) {
    let mut prev: Snap = HashMap::new();
    let mut quiet = 0u32;
    loop {
        let wait = if quiet >= 10 { 10 } else { 3 };
        for _ in 0..wait * 4 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if !focused(&app) {
            continue;
        }
        let dirs = hot_dirs(&host, &root);
        if dirs.is_empty() {
            continue;
        }
        // one round trip: a header line per dir followed by its entries
        let script: String = dirs
            .iter()
            .map(|d| format!("printf '#%s\\n' {q}; find -H {q} -mindepth 1 -maxdepth 1 -printf '%p\\t%s\\t%T@\\n' 2>/dev/null; ", q = ssh::quote(d)))
            .collect();
        let Ok(out) = run(&host, &script) else { continue };
        let text = String::from_utf8_lossy(&out);
        let mut cur: Snap = HashMap::new();
        let mut dir = String::new();
        for line in text.lines() {
            if let Some(d) = line.strip_prefix('#') {
                dir = d.to_string();
                cur.entry(dir.clone()).or_default();
            } else if let Some((p, rest)) = line.split_once('\t') {
                if let Some((sz, mt)) = rest.split_once('\t') {
                    cur.entry(dir.clone()).or_default().insert(p.to_string(), (sz.parse().unwrap_or(0), mt.to_string()));
                }
            }
        }
        let mut created = HashSet::new();
        let mut removed = HashSet::new();
        let mut modified = HashSet::new();
        for (d, now) in &cur {
            let Some(before) = prev.get(d) else { continue }; // first sight of a dir: baseline only
            for (p, v) in now {
                match before.get(p) {
                    None => { created.insert(p.clone()); }
                    Some(b) if b != v => { modified.insert(p.clone()); }
                    _ => {}
                }
            }
            for p in before.keys() {
                if !now.contains_key(p) {
                    removed.insert(p.clone());
                }
            }
        }
        prev = cur;
        let mut any = false;
        for (kind, set) in [("create", created), ("remove", removed), ("modify", modified)] {
            if set.is_empty() {
                continue;
            }
            any = true;
            let mut paths: Vec<String> = set.into_iter().collect();
            paths.sort();
            for p in &paths {
                super::ops::invalidate(&host, p);
            }
            let _ = app.emit("fs://changed", Changed { root: root.clone(), paths, kind: kind.into() });
        }
        quiet = if any { 0 } else { quiet + 1 };
    }
}
