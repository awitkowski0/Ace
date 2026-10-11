//! Debug Adapter Protocol bridge (same shape as the LSP bridge): Rust spawns the adapter (`python -m debugpy.adapter`, locally or
//! over ssh), frames Content-Length messages and forwards them; the frontend speaks DAP.
//!   dap_start({spec}) -> sessionId    dap_send(sessionId, json)    dap_stop(sessionId)
//! Events: `dap://msg/<id>` (raw JSON text), `dap://log/<id>` (adapter stderr line), `dap://closed/<id>`.
use crate::lsp::{read_loop, spawn_writer};
use crate::runner::{command_for, Spec};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, WebviewWindow};

struct Sess {
    owner: String,
    tx: Sender<Vec<u8>>,
    proc_id: u64,
}

fn sessions() -> &'static Mutex<HashMap<String, Sess>> {
    static S: OnceLock<Mutex<HashMap<String, Sess>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

#[tauri::command]
pub fn dap_start(app: AppHandle, window: WebviewWindow, id: Option<String>, spec: Spec) -> Result<String, String> {
    let owner = window.label().to_string();
    let id = id.unwrap_or_else(|| format!("dap-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    if !spec.is_local() {
        crate::remote::ssh::acquire(&owner, &spec.host);
    }
    let mut cmd = command_for(&spec, false)?;
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let proc_id = crate::procs::register_for(&owner, "dap", "debugpy adapter", child);
    let tx = spawn_writer(stdin);
    sessions().lock().unwrap().insert(id.clone(), Sess { owner: owner.clone(), tx, proc_id });
    {
        let (a, i, o) = (app.clone(), id.clone(), owner.clone());
        std::thread::spawn(move || {
            for l in BufReader::new(stderr).lines().map_while(Result::ok) {
                crate::windows::emit_window(&a, &o, &format!("dap://log/{i}"), l);
            }
        });
    }
    let (a, i, o) = (app, id.clone(), owner);
    std::thread::spawn(move || {
        let ev = format!("dap://msg/{i}");
        read_loop(stdout, |m| crate::windows::emit_window(&a, &o, &ev, m));
        if let Some(s) = sessions().lock().unwrap().remove(&i) {
            crate::procs::kill(s.proc_id);
        }
        crate::windows::emit_window(&a, &o, &format!("dap://closed/{i}"), ());
    });
    Ok(id)
}

#[tauri::command]
pub fn dap_send(session_id: String, json: String) -> Result<(), String> {
    let g = sessions().lock().unwrap();
    let s = g.get(&session_id).ok_or("no such debug session")?;
    s.tx.send(json.into_bytes()).map_err(|_| "debug session closed".to_string())
}

#[tauri::command]
pub fn dap_stop(session_id: String) {
    let s = sessions().lock().unwrap().remove(&session_id);
    if let Some(s) = s {
        crate::procs::kill(s.proc_id);
    }
}

pub fn release_window(label: &str) {
    sessions().lock().unwrap().retain(|_, s| s.owner != label);
}
