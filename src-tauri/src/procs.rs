//! Process registry. EVERY child process Atelier spawns (pty, ssh, LSP, claude, git long-runners)
//! must be registered here so it is killed on app exit.
//!
//!   let child = std::process::Command::new(..).spawn()?;
//!   let id = crate::procs::register("pty", "zsh", child);   // returns registry id
//!   crate::procs::kill(id);                                  // optional early kill
//!
//! For handles you can't hand over (e.g. portable-pty killers), use `register_killer`.
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
    r.map.insert(id, Entry { kind: kind.into(), label: label.into(), pid, handle });
    id
}

/// Forget an entry without killing it (process already exited).
pub fn unregister(id: u64) {
    reg().lock().unwrap().map.remove(&id);
}

pub fn kill(id: u64) {
    if let Some(mut e) = reg().lock().unwrap().map.remove(&id) {
        kill_entry(&mut e);
    }
}

fn kill_entry(e: &mut Entry) {
    match &mut e.handle {
        Handle::Child(c) => {
            let _ = c.kill();
            let _ = c.wait();
        }
        Handle::Killer(k) => k(),
    }
}

pub fn kill_all() {
    let entries: Vec<Entry> = reg().lock().unwrap().map.drain().map(|(_, e)| e).collect();
    for mut e in entries {
        kill_entry(&mut e);
    }
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
