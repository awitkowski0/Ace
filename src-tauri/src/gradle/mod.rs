//! Gradle tool window backend (docs/GRADLE.md): task discovery through an init script, cache fingerprint, soft stop.
//!
//!   gradle_fingerprint(root, dirs) -> "cksum len"   hash of settings/build/properties files (local and remote: one `sh -c`)
//!   gradle_discover(root) -> {json, elapsedMs}      runs `./gradlew help` (else `gradle`) with `--init-script`; ALWAYS the user's
//!                                                   normal daemon (no --no-daemon, no jvmargs, no --stop). One run per root at a time.
//!   gradle_cancel(root)                             kills the discovery CLIENT of that root
//!   gradle_soft_stop(runId)                         graceful cancel of a run: SIGINT to the client only, then TERM/KILL of that pid only
use crate::remote::ssh;
use crate::runner::{self, Spec};
use crate::Location;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

const INIT: &str = include_str!("ace-init.gradle");
const MARKER: &str = "ACE-GRADLE-JSON:";

fn inflight() -> &'static Mutex<HashMap<String, u64>> {
    static M: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    M.get_or_init(Default::default)
}
fn key(l: &Location) -> String {
    format!("{}:{}", if l.is_local() { "local" } else { &l.host }, l.path.trim_end_matches('/'))
}

fn spec(root: &Location, shell: Option<String>, argv: Vec<String>) -> Spec {
    Spec { host: root.host.clone(), cwd: root.path.clone(), shell, argv, ..Default::default() }
}

#[tauri::command]
pub async fn gradle_fingerprint(window: WebviewWindow, root: Location, dirs: Vec<String>) -> Result<String, String> {
    const SCRIPT: &str = r#"{
for f in settings.gradle settings.gradle.kts build.gradle build.gradle.kts gradle.properties gradle/wrapper/gradle-wrapper.properties gradle/*.gradle gradle/*.gradle.kts gradle/*.properties gradle/*.toml gradle/*.json buildSrc/settings.gradle buildSrc/settings.gradle.kts buildSrc/build.gradle buildSrc/build.gradle.kts; do
  [ -f "$f" ] && { echo "== $f"; cat "$f"; }
done
for d in "$@"; do for n in build.gradle build.gradle.kts gradle.properties; do f="$d/$n"; [ -f "$f" ] && { echo "== $f"; cat "$f"; }; done; done
} | cksum"#;
    let owner = window.label().to_string();
    if !root.is_local() {
        ssh::acquire(&owner, &root.host);
    }
    let mut argv = vec!["/bin/sh".to_string(), "-c".into(), SCRIPT.into(), "sh".into()];
    argv.extend(dirs.into_iter().filter(|d| !d.contains('\n')));
    let sp = spec(&root, None, argv);
    tauri::async_runtime::spawn_blocking(move || {
        let o = runner::exec(&owner, &sp, None, Duration::from_secs(30))?;
        if o.code != Some(0) {
            return Err(format!("fingerprint failed: {}", o.stderr.trim()));
        }
        Ok(o.stdout.split_whitespace().collect::<Vec<_>>().join(" "))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub json: String,
    pub elapsed_ms: u64,
    pub offline: bool,
}

fn init_path() -> Result<String, String> {
    let dir = crate::pstore::data_dir().join("gradle");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("ace-init.gradle");
    if std::fs::read_to_string(&p).map(|s| s != INIT).unwrap_or(true) {
        std::fs::write(&p, INIT).map_err(|e| e.to_string())?;
    }
    Ok(p.to_string_lossy().into_owned())
}

fn discovery_script(local_init: Option<&str>) -> String {
    let setup = match local_init {
        Some(p) => format!("D=; F={}\n", ssh::quote(p)),
        None => format!("D=$(mktemp -d); F=\"$D/ace-init.gradle\"; echo {} | base64 -d > \"$F\"\n", B64.encode(INIT)),
    };
    // Order: offline + no configuration cache (an init script does not run when the configuration cache is reused);
    // old Gradle without --no-configuration-cache -> retry without it; online retry only for offline-looking failures.
    // Never --no-daemon / --stop / jvmargs: the normal shared daemon serves it.
    format!(
        r#"{setup}O=$(mktemp)
G=./gradlew; [ -x "$G" ] || G=gradle
attempt() {{ "$G" -q --console=plain "$@" -Dorg.gradle.configureondemand=false --init-script "$F" help > "$O" 2>&1; grep -q '^{MARKER}' "$O"; }}
if attempt --offline --no-configuration-cache; then echo offline > "$O.mode"
elif grep -q 'Unknown command-line option' "$O" && attempt --offline; then echo offline > "$O.mode"
elif grep -qiE 'offline|No cached version|Could not resolve|Could not download|Could not GET|UnknownHost|not found in' "$O" && attempt --no-configuration-cache; then echo online > "$O.mode"
fi
if [ -f "$O.mode" ]; then echo "ACE-MODE:$(cat "$O.mode")"; fi
cat "$O"; rc=0; grep -q '^{MARKER}' "$O" || rc=1
rm -f "$O" "$O.mode"; [ -n "$D" ] && rm -rf "$D"
exit $rc"#
    )
}

#[tauri::command]
pub async fn gradle_discover(window: WebviewWindow, root: Location) -> Result<Discovery, String> {
    let owner = window.label().to_string();
    let k = key(&root);
    {
        let mut m = inflight().lock().unwrap();
        if m.contains_key(&k) {
            return Err("busy".into());
        }
        m.insert(k.clone(), 0);
    }
    if !root.is_local() {
        ssh::acquire(&owner, &root.host);
    }
    let k2 = k.clone();
    let r = tauri::async_runtime::spawn_blocking(move || run_discovery(&owner, &root, &k2)).await.map_err(|e| e.to_string());
    inflight().lock().unwrap().remove(&k);
    r?
}

fn run_discovery(owner: &str, root: &Location, k: &str) -> Result<Discovery, String> {
    let init = if root.is_local() { Some(init_path()?) } else { None };
    let script = discovery_script(init.as_deref());
    let sp = spec(root, Some(script), vec![]);
    let mut cmd = runner::command_for(&sp, false)?;
    let t0 = Instant::now();
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("cannot start gradle: {e}"))?;
    let pid = child.id();
    let reg = crate::procs::register_killer_for(owner, "gradle", &format!("gradle discovery {}", root.path), Some(pid), Box::new(|| {}));
    if let Some(e) = inflight().lock().unwrap().get_mut(k) {
        *e = reg;
    }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let h1 = std::thread::spawn(move || { let mut b = Vec::new(); let _ = so.read_to_end(&mut b); b });
    let h2 = std::thread::spawn(move || { let mut b = Vec::new(); let _ = se.read_to_end(&mut b); b });
    let limit = Duration::from_secs(20 * 60);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if t0.elapsed() > limit {
            timed_out = true;
            crate::procs::kill(reg);
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    crate::procs::unregister(reg);
    let stdout = String::from_utf8_lossy(&h1.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&h2.join().unwrap_or_default()).into_owned();
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let offline = stdout.lines().any(|l| l == "ACE-MODE:offline");
    if let Some(line) = stdout.lines().find(|l| l.starts_with(MARKER)) {
        return Ok(Discovery { json: line[MARKER.len()..].to_string(), elapsed_ms, offline });
    }
    let mut text = stdout.lines().filter(|l| !l.starts_with("ACE-MODE:")).collect::<Vec<_>>().join("\n");
    if !stderr.trim().is_empty() {
        text.push('\n');
        text.push_str(stderr.trim());
    }
    if timed_out {
        text = format!("Timed out after 20 minutes.\n{text}");
    } else if status.map_or(false, |s| s.code().is_none()) {
        text = format!("Cancelled.\n{text}");
    }
    let t = text.trim();
    let tail = if t.len() > 30_000 { &t[t.len() - 30_000..] } else { t };
    Err(if tail.is_empty() { "Gradle produced no output (is gradle / java installed on this host?)".into() } else { tail.to_string() })
}

#[tauri::command]
pub fn gradle_cancel(root: Location) {
    let id = inflight().lock().unwrap().get(&key(&root)).copied().unwrap_or(0);
    if id != 0 {
        std::thread::spawn(move || crate::procs::kill(id));
    }
}

/// Graceful stop of a Gradle run: SIGINT to the Gradle CLIENT only (it cancels the build in the daemon; the daemon survives),
/// then TERM / KILL of that single pid if it is still there. Remote runs: ^C through the pty, then the normal stop.
#[tauri::command]
pub fn gradle_soft_stop(id: String) {
    let Some((pid, local)) = runner::run_pid(&id) else { return };
    if local {
        unsafe { libc::kill(pid as i32, libc::SIGINT) };
    } else {
        runner::run_interrupt(id.clone());
    }
    std::thread::spawn(move || {
        let wait = |ms: u64| {
            let t = Instant::now();
            while t.elapsed() < Duration::from_millis(ms) {
                if !runner::run_alive(id.clone()) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        };
        if wait(10_000) {
            return;
        }
        if local {
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
            if wait(3_000) {
                return;
            }
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        } else {
            runner::run_stop(id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_never_touches_daemons() {
        for s in [discovery_script(Some("/tmp/x/ace-init.gradle")), discovery_script(None)] {
            assert!(!s.contains("--no-daemon") && !s.contains("--stop") && !s.contains("jvmargs"), "{s}");
            assert!(s.contains("--init-script") && s.contains("-q") && s.contains("--offline"), "{s}");
        }
        assert!(INIT.contains(MARKER) && !INIT.contains("writeFile") && !INIT.contains(".text ="));
    }
}
