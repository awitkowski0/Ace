//! Gradle tool window backend (docs/GRADLE.md): task discovery through an init script, cache fingerprint, soft stop.
//!
//!   gradle_fingerprint(root, dirs) -> "cksum len"   hash of settings/build/properties files (local and remote: one `sh -c`)
//!   gradle_discover(root) -> {json, elapsedMs}      runs `./gradlew help` (else `gradle`) with `--init-script`; ALWAYS the user's
//!                                                   normal daemon (no --no-daemon, no jvmargs, no --stop). One run per root at a time.
//!   gradle_cancel(root)                             kills the discovery CLIENT of that root
//!   gradle_soft_stop(runId)                         graceful cancel of a run: SIGINT to the client only, then TERM/KILL of that pid only
use crate::platform::{self, Sig};
use crate::remote::ssh;
use crate::runner::{self, Spec};
use crate::Location;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
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

/// The files a fingerprint covers, in the order the sh script visits them (globs expand sorted, like the shell).
#[cfg(any(windows, test))]
const FINGERPRINT_FILES: &[&str] = &[
    "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties",
    "gradle/*.gradle", "gradle/*.gradle.kts", "gradle/*.properties", "gradle/*.toml", "gradle/*.json",
    "buildSrc/settings.gradle", "buildSrc/settings.gradle.kts", "buildSrc/build.gradle", "buildSrc/build.gradle.kts",
];
#[cfg(any(windows, test))]
const FINGERPRINT_SUBDIR_FILES: &[&str] = &["build.gradle", "build.gradle.kts", "gradle.properties"];

/// The sh script `gradle_fingerprint` runs for remote roots (unix hosts) and on macOS: `cksum` of the build files.
const FINGERPRINT_SH: &str = r#"{
for f in settings.gradle settings.gradle.kts build.gradle build.gradle.kts gradle.properties gradle/wrapper/gradle-wrapper.properties gradle/*.gradle gradle/*.gradle.kts gradle/*.properties gradle/*.toml gradle/*.json buildSrc/settings.gradle buildSrc/settings.gradle.kts buildSrc/build.gradle buildSrc/build.gradle.kts; do
  [ -f "$f" ] && { echo "== $f"; cat "$f"; }
done
for d in "$@"; do for n in build.gradle build.gradle.kts gradle.properties; do f="$d/$n"; [ -f "$f" ] && { echo "== $f"; cat "$f"; }; done; done
} | cksum"#;

/// POSIX `cksum` (CRC-32, polynomial 0x04c11db7, the byte length appended LSB-first, then inverted), as `"crc len"`.
#[cfg(any(windows, test))]
fn posix_cksum(data: &[u8]) -> String {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = (i as u32) << 24;
        for _ in 0..8 {
            c = if c & 0x8000_0000 != 0 { (c << 1) ^ 0x04c1_1db7 } else { c << 1 };
        }
        *t = c;
    }
    let step = |crc: u32, b: u8| (crc << 8) ^ table[(((crc >> 24) ^ b as u32) & 0xff) as usize];
    let mut crc = data.iter().fold(0u32, |crc, &b| step(crc, b));
    let mut n = data.len() as u64;
    while n != 0 {
        crc = step(crc, (n & 0xff) as u8);
        n >>= 8;
    }
    format!("{} {}", !crc, data.len())
}

/// Expand a fingerprint glob (`dir/prefix*suffix`, the star in the last component) like the shell: sorted, files only,
/// no dot-files. Returns the relative paths as the script would print them.
#[cfg(any(windows, test))]
fn expand_glob(root: &std::path::Path, pat: &str) -> Vec<String> {
    let (dir, fpat) = match pat.rfind('/') {
        Some(i) => (&pat[..i], &pat[i + 1..]),
        None => ("", pat),
    };
    let Some((prefix, suffix)) = fpat.split_once('*') else { return vec![] };
    let Ok(rd) = std::fs::read_dir(if dir.is_empty() { root.to_path_buf() } else { root.join(dir) }) else { return vec![] };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n.len() >= prefix.len() + suffix.len() && n.starts_with(prefix) && n.ends_with(suffix))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|n| if dir.is_empty() { n } else { format!("{dir}/{n}") })
        .filter(|rel| root.join(rel).is_file())
        .collect()
}

/// The fingerprint of a local root computed in Rust: same files, same order, same bytes as `FINGERPRINT_SH` (see the
/// parity test). Used on Windows, where there is no `/bin/sh`.
#[cfg(any(windows, test))]
fn local_fingerprint(root: &std::path::Path, dirs: &[String]) -> String {
    let mut rels: Vec<String> = Vec::new();
    for f in FINGERPRINT_FILES {
        if f.contains('*') {
            rels.extend(expand_glob(root, f));
        } else if root.join(f).is_file() {
            rels.push(f.to_string());
        }
    }
    for d in dirs.iter().filter(|d| !d.contains('\n')) {
        for n in FINGERPRINT_SUBDIR_FILES {
            let f = format!("{d}/{n}");
            if root.join(&f).is_file() {
                rels.push(f);
            }
        }
    }
    let mut buf = Vec::new();
    for f in rels {
        buf.extend_from_slice(format!("== {f}\n").as_bytes());
        buf.extend_from_slice(&std::fs::read(root.join(&f)).unwrap_or_default());
    }
    posix_cksum(&buf)
}

#[tauri::command]
pub async fn gradle_fingerprint(window: WebviewWindow, root: Location, dirs: Vec<String>) -> Result<String, String> {
    let owner = window.label().to_string();
    #[cfg(windows)]
    {
        if root.is_local() {
            let path = std::path::PathBuf::from(&root.path);
            return tauri::async_runtime::spawn_blocking(move || Ok(local_fingerprint(&path, &dirs)))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !root.is_local() {
        ssh::acquire(&owner, &root.host);
    }
    let mut argv = vec!["/bin/sh".to_string(), "-c".into(), FINGERPRINT_SH.into(), "sh".into()];
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

/// One captured run of a discovery client (registered with procs while it runs).
struct Captured {
    stdout: String,
    stderr: String,
    status: Option<std::process::ExitStatus>,
    timed_out: bool,
}

/// Spawn `cmd`, register it as the discovery client of `k`, read both pipes, and kill it when `t0 + limit` passes.
fn run_captured(owner: &str, root: &Location, k: &str, mut cmd: Command, t0: Instant, limit: Duration) -> Result<Captured, String> {
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
    Ok(Captured {
        stdout: String::from_utf8_lossy(&h1.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&h2.join().unwrap_or_default()).into_owned(),
        status,
        timed_out,
    })
}

fn run_discovery(owner: &str, root: &Location, k: &str) -> Result<Discovery, String> {
    let init = if root.is_local() { Some(init_path()?) } else { None };
    let t0 = Instant::now();
    let limit = Duration::from_secs(20 * 60);
    let mut out = match init.as_deref() {
        // Windows has no POSIX sh for the discovery script: run the same attempts directly (see `discover_windows`).
        Some(p) if cfg!(windows) => discover_windows(owner, root, k, p, t0, limit)?,
        _ => {
            let script = discovery_script(init.as_deref());
            let sp = spec(root, Some(script), vec![]);
            let cmd = runner::command_for(&sp, false)?;
            run_captured(owner, root, k, cmd, t0, limit)?
        }
    };
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let stdout = std::mem::take(&mut out.stdout);
    let stderr = out.stderr;
    let offline = stdout.lines().any(|l| l == "ACE-MODE:offline");
    if let Some(line) = stdout.lines().find(|l| l.starts_with(MARKER)) {
        return Ok(Discovery { json: line[MARKER.len()..].to_string(), elapsed_ms, offline });
    }
    let mut text = stdout.lines().filter(|l| !l.starts_with("ACE-MODE:")).collect::<Vec<_>>().join("\n");
    if !stderr.trim().is_empty() {
        text.push('\n');
        text.push_str(stderr.trim());
    }
    if out.timed_out {
        text = format!("Timed out after 20 minutes.\n{text}");
    } else if out.status.map_or(false, |s| s.code().is_none()) {
        text = format!("Cancelled.\n{text}");
    }
    let t = text.trim();
    let tail = if t.len() > 30_000 { &t[t.len() - 30_000..] } else { t };
    Err(if tail.is_empty() { "Gradle produced no output (is gradle / java installed on this host?)".into() } else { tail.to_string() })
}

/// Windows discovery: the same attempt order as `discovery_script` (offline, then the Unknown-option retry, then online),
/// run without a shell. Uses `gradlew.bat` of the project, else `gradle` (through cmd, so `gradle.bat` resolves).
/// A successful attempt's output gets the `ACE-MODE:` line the script would print.
#[cfg(windows)]
fn discover_windows(owner: &str, root: &Location, k: &str, init: &str, t0: Instant, limit: Duration) -> Result<Captured, String> {
    let wrapper = std::path::Path::new(&root.path).join("gradlew.bat");
    let gradle = |extra: &[&str]| -> Command {
        let mut c = if wrapper.is_file() {
            Command::new(&wrapper)
        } else {
            let mut c = Command::new("cmd");
            c.args(["/C", "gradle"]);
            c
        };
        c.args(["-q", "--console=plain"]).args(extra).args(["-Dorg.gradle.configureondemand=false", "--init-script", init, "help"]);
        if std::path::Path::new(&root.path).is_dir() {
            c.current_dir(&root.path);
        }
        platform::new_group(&mut c);
        c
    };
    let run = |extra: &[&str]| run_captured(owner, root, k, gradle(extra), t0, limit);
    let has_marker = |c: &Captured| c.stdout.lines().any(|l| l.starts_with(MARKER));
    let mut c = run(&["--offline", "--no-configuration-cache"])?;
    let mut mode = has_marker(&c).then_some("offline");
    if mode.is_none() && format!("{}{}", c.stdout, c.stderr).contains("Unknown command-line option") {
        c = run(&["--offline"])?;
        mode = has_marker(&c).then_some("offline");
    }
    if mode.is_none() {
        let all = format!("{}{}", c.stdout, c.stderr).to_lowercase();
        let offline_like = ["offline", "no cached version", "could not resolve", "could not download", "could not get", "unknownhost", "not found in"];
        if offline_like.iter().any(|m| all.contains(m)) {
            c = run(&["--no-configuration-cache"])?;
            mode = has_marker(&c).then_some("online");
        }
    }
    if let Some(m) = mode {
        c.stdout = format!("ACE-MODE:{m}\n{}", c.stdout);
    }
    Ok(c)
}

#[cfg(not(windows))]
fn discover_windows(_owner: &str, _root: &Location, _k: &str, _init: &str, _t0: Instant, _limit: Duration) -> Result<Captured, String> {
    Err("windows discovery on a non-windows build".into())
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
        platform::signal_pid(pid, Sig::Int);
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
            platform::signal_pid(pid, Sig::Term);
            if wait(3_000) {
                return;
            }
            platform::signal_pid(pid, Sig::Kill);
        } else {
            runner::run_stop(id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Rust fingerprint must equal the sh script's `cksum` output for the same tree (mac/unix; the Windows path uses it).
    #[cfg(unix)]
    #[test]
    fn fingerprint_rust_matches_sh() {
        let d = std::env::temp_dir().join(format!("ace-fp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let write = |rel: &str, body: &[u8]| {
            let p = d.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        write("settings.gradle", b"rootProject.name = 'x'\n");
        write("build.gradle.kts", &[0u8, 255, 10, 13, 0]);
        write("gradle/libs.versions.toml", b"[versions]\n");
        write("gradle/b.gradle", b"b");
        write("gradle/a.gradle", b"a");
        write("gradle/.hidden.gradle", b"h");
        write("gradle/dir.gradle/x", b"d");
        write("gradle/wrapper/gradle-wrapper.properties", b"wrap");
        write("buildSrc/build.gradle", b"bs");
        write("app/build.gradle", b"app");
        write("app/gradle.properties", b"");
        write("lib/sub/build.gradle.kts", b"sub");
        write("empty/x.txt", b"");
        let dirs: Vec<String> = ["app", "lib/sub", "missing", "empty"].iter().map(|s| s.to_string()).collect();
        let out = std::process::Command::new("/bin/sh")
            .arg("-c").arg(FINGERPRINT_SH).arg("sh").args(&dirs)
            .current_dir(&d).env("LC_ALL", "C").output().unwrap();
        let sh = String::from_utf8_lossy(&out.stdout).split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(local_fingerprint(&d, &dirs), sh);
        assert_eq!(posix_cksum(b""), "4294967295 0");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn discovery_never_touches_daemons() {
        for s in [discovery_script(Some("/tmp/x/ace-init.gradle")), discovery_script(None)] {
            assert!(!s.contains("--no-daemon") && !s.contains("--stop") && !s.contains("jvmargs"), "{s}");
            assert!(s.contains("--init-script") && s.contains("-q") && s.contains("--offline"), "{s}");
        }
        assert!(INIT.contains(MARKER) && !INIT.contains("writeFile") && !INIT.contains(".text ="));
    }
}
