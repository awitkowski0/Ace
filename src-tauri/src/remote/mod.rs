//! remote module: ssh-backed filesystem, watch, transfers and extras. Owned by the remote agent.
//! `fs::remote::RemoteBackend` delegates to `ops`.
pub mod extras;
pub mod ops;
pub mod ssh;
pub mod transfer;
pub mod watch;

use crate::procs;
use std::io::Read;
use std::process::{Child, Command, Stdio};

/// Spawn `cmd` and register it in the process registry with a kill-by-pid closure, so the caller keeps
/// ownership of the `Child` (to read/write/wait) while app exit still kills it.
pub fn spawn_tracked(mut cmd: Command, kind: &str, label: &str) -> Result<(Child, u64), String> {
    let child = cmd.spawn().map_err(|e| format!("{label}: {e}"))?;
    let pid = child.id();
    let id = procs::register_killer(
        kind,
        label,
        Some(pid),
        Box::new(move || {
            let _ = Command::new("kill").arg(pid.to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }),
    );
    Ok((child, id))
}

pub fn read_all(r: Option<impl Read>) -> Vec<u8> {
    let mut v = Vec::new();
    if let Some(mut r) = r {
        let _ = r.read_to_end(&mut v);
    }
    v
}

/// Run a shell script on `host`, return stdout bytes; stderr becomes the error.
pub fn run(host: &str, script: &str) -> Result<Vec<u8>, String> {
    let out = ssh::exec(host, script)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if e.is_empty() { format!("ssh {host}: exit {}", out.status.code().unwrap_or(-1)) } else { e })
    }
}
