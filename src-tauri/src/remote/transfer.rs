//! Transfer queue: upload/download files and directories by streaming through ssh (`cat` / `tar` pipes).
//! Parallelism 2. Progress via `remote://transfer` {id,name,direction,host,bytes,total,state,error}.
use super::{ops, read_all, run, spawn_tracked, ssh};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const PARALLEL: usize = 2;

#[derive(Clone)]
struct Job {
    id: String,
    /// label of the window that started the transfer: it alone receives the progress events
    owner: String,
    host: String,
    upload: bool,
    src: String,
    dest_dir: String,
    /// Name at the destination (differs from the source name when the user chose "Rename" on a conflict).
    dest_name: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    name: String,
    direction: &'static str,
    host: String,
    bytes: u64,
    total: u64,
    state: &'static str,
    error: Option<String>,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Job>,
    running: usize,
    all: HashMap<String, Arc<AtomicBool>>,
    procs: HashMap<String, Vec<u64>>,
    owners: HashMap<String, String>,
}
fn q() -> &'static Mutex<Queue> {
    static Q: OnceLock<Mutex<Queue>> = OnceLock::new();
    Q.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);

fn name_of(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p).to_string()
}

/// bsdtar `-s` expression renaming the top-level entry `from` to `to` (None when equal).
fn tar_subst(from: &str, to: &str) -> Option<String> {
    if from == to {
        return None;
    }
    let delim = [',', '|', '#', '!', '@', '%'].into_iter().find(|d| !from.contains(*d) && !to.contains(*d)).unwrap_or(',');
    let mut pat = String::new();
    for c in from.chars() {
        if "\\.^$*+?()[]{}|/".contains(c) {
            pat.push('\\');
        }
        pat.push(c);
    }
    let mut rep = String::new();
    for c in to.chars() {
        if c == '\\' || c == '&' {
            rep.push('\\');
        }
        rep.push(c);
    }
    Some(format!("{d}^{pat}{d}{rep}{d}", d = delim)) // only one top-level entry is archived, so a prefix rewrite is exact
}

fn emit(app: &AppHandle, j: &Job, bytes: u64, total: u64, state: &'static str, error: Option<String>) {
    crate::windows::emit_window(
        app,
        &j.owner,
        "remote://transfer",
        Progress { id: j.id.clone(), name: name_of(&j.src), direction: if j.upload { "upload" } else { "download" }, host: j.host.clone(), bytes, total, state, error },
    );
}

fn enqueue(app: &AppHandle, owner: &str, host: &str, upload: bool, srcs: Vec<String>, dest_dir: &str, dest_names: Option<Vec<String>>) -> Vec<String> {
    let mut ids = vec![];
    {
        let mut qq = q().lock().unwrap();
        for (i, s) in srcs.into_iter().enumerate() {
            let dest_name = dest_names.as_ref().and_then(|n| n.get(i)).filter(|n| !n.is_empty() && !n.contains('/')).cloned().unwrap_or_else(|| name_of(&s));
            let id = format!("t{}", NEXT.fetch_add(1, Ordering::Relaxed));
            let cancel = Arc::new(AtomicBool::new(false));
            let job = Job { id: id.clone(), owner: owner.to_string(), host: host.into(), upload, src: s, dest_dir: dest_dir.into(), dest_name, cancel: cancel.clone() };
            emit(app, &job, 0, 0, "queued", None);
            qq.all.insert(id.clone(), cancel);
            qq.owners.insert(id.clone(), owner.to_string());
            qq.pending.push_back(job);
            ids.push(id);
        }
    }
    pump(app);
    ids
}

fn pump(app: &AppHandle) {
    loop {
        let job = {
            let mut qq = q().lock().unwrap();
            if qq.running >= PARALLEL {
                return;
            }
            let Some(j) = qq.pending.pop_front() else { return };
            qq.running += 1;
            j
        };
        let app = app.clone();
        std::thread::spawn(move || {
            if job.cancel.load(Ordering::Relaxed) {
                emit(&app, &job, 0, 0, "cancelled", None);
            } else {
                emit(&app, &job, 0, 0, "running", None);
                let res = run_job(&app, &job);
                let cancelled = job.cancel.load(Ordering::Relaxed);
                match res {
                    _ if cancelled => emit(&app, &job, 0, 0, "cancelled", None),
                    Ok((b, t)) => emit(&app, &job, b, t.max(b), "done", None),
                    Err(e) => emit(&app, &job, 0, 0, "error", Some(e)),
                }
            }
            {
                let mut qq = q().lock().unwrap();
                qq.running -= 1;
                qq.all.remove(&job.id);
                qq.procs.remove(&job.id);
                qq.owners.remove(&job.id);
            }
            if job.upload {
                ops::invalidate(&job.host, &format!("{}/x", job.dest_dir));
            }
            pump(&app);
        });
    }
}

fn track(id: &str, pid: u64) {
    q().lock().unwrap().procs.entry(id.to_string()).or_default().push(pid);
}

struct Meter<'a> {
    app: &'a AppHandle,
    job: &'a Job,
    total: u64,
    bytes: u64,
    last: Instant,
}
impl Meter<'_> {
    fn add(&mut self, n: u64) {
        self.bytes += n;
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            emit(self.app, self.job, self.bytes, self.total.max(self.bytes), "running", None);
        }
    }
}

fn pump_bytes(r: &mut impl Read, w: &mut impl Write, m: &mut Meter) -> std::io::Result<()> {
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if m.job.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = r.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        w.write_all(&buf[..n])?;
        m.add(n as u64);
    }
}

fn local_size(p: &Path) -> u64 {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|d| d.flatten().map(|e| local_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

fn run_job(app: &AppHandle, j: &Job) -> Result<(u64, u64), String> {
    if j.upload { upload(app, j) } else { download(app, j) }
}

fn finish(j: &Job, mut children: Vec<(std::process::Child, u64, &str)>) -> Result<(), String> {
    let mut err = String::new();
    for (c, id, label) in children.iter_mut() {
        let stderr = read_all(c.stderr.take());
        let st = c.wait().map_err(|e| e.to_string());
        crate::procs::unregister(*id);
        if !j.cancel.load(Ordering::Relaxed) {
            match st {
                Ok(s) if s.success() => {}
                Ok(_) => err = format!("{label}: {}", String::from_utf8_lossy(&stderr).trim()),
                Err(e) => err = e,
            }
        }
    }
    if err.is_empty() { Ok(()) } else { Err(err) }
}

fn kill_all_for(j: &Job) {
    let ids = q().lock().unwrap().procs.get(&j.id).cloned().unwrap_or_default();
    for i in ids {
        crate::procs::kill(i);
    }
}

fn upload(app: &AppHandle, j: &Job) -> Result<(u64, u64), String> {
    let src = Path::new(&j.src);
    let meta = std::fs::metadata(src).map_err(|e| format!("{}: {e}", j.src))?;
    let total = local_size(src);
    let mut m = Meter { app, job: j, total, bytes: 0, last: Instant::now() };
    let name = name_of(&j.src);
    if meta.is_dir() {
        let parent = src.parent().and_then(|p| p.to_str()).unwrap_or("/");
        let mut tar = Command::new("tar");
        tar.args(["--no-xattrs", "-cf", "-"]);
        if let Some(expr) = tar_subst(&name, &j.dest_name) {
            tar.args(["-s", &expr]);
        }
        tar.args(["-C", parent, &name]).env("COPYFILE_DISABLE", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut tc, tid) = spawn_tracked(tar, "tar", &format!("tar {name}"))?;
        track(&j.id, tid);
        let script = format!("mkdir -p -- {d} && tar -xf - -C {d}", d = ssh::quote(&j.dest_dir));
        let mut sc = ssh::command(&j.host, false);
        sc.arg(script).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let (mut sh, sid) = spawn_tracked(sc, "ssh", &format!("upload {name}"))?;
        track(&j.id, sid);
        let mut out = tc.stdout.take().unwrap();
        let mut stdin = sh.stdin.take().unwrap();
        let r = pump_bytes(&mut out, &mut stdin, &mut m);
        drop(stdin);
        if r.is_err() {
            kill_all_for(j);
        }
        let f = finish(j, vec![(tc, tid, "tar"), (sh, sid, "ssh")]);
        if let Err(e) = r {
            if !j.cancel.load(Ordering::Relaxed) {
                return Err(e.to_string());
            }
        }
        f?;
    } else {
        let dest = format!("{}/{}", j.dest_dir.trim_end_matches('/'), j.dest_name);
        let mode = crate::platform::mode(&meta.permissions()) & 0o7777;
        // commit (rename) only if the full size arrived, so a cancelled/broken stream never leaves a truncated file
        let script = format!(
            "mkdir -p -- {d} && t={t}.ace-tmp.$$ && if cat > \"$t\" && [ \"$(stat -c %s -- \"$t\")\" = {size} ] && chmod {mode:o} \"$t\" && mv -f -- \"$t\" {t}; then :; else rm -f \"$t\"; exit 1; fi",
            d = ssh::quote(&j.dest_dir),
            t = ssh::quote(&dest),
            size = meta.len()
        );
        let mut sc = ssh::command(&j.host, false);
        sc.arg(script).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let (mut sh, sid) = spawn_tracked(sc, "ssh", &format!("upload {name}"))?;
        track(&j.id, sid);
        let mut f = std::fs::File::open(src).map_err(|e| e.to_string())?;
        let mut stdin = sh.stdin.take().unwrap();
        let r = pump_bytes(&mut f, &mut stdin, &mut m);
        drop(stdin);
        if r.is_err() {
            kill_all_for(j);
        }
        let fin = finish(j, vec![(sh, sid, "ssh")]);
        if let Err(e) = r {
            if !j.cancel.load(Ordering::Relaxed) {
                return Err(e.to_string());
            }
        }
        fin?;
    }
    Ok((m.bytes, total))
}

fn download(app: &AppHandle, j: &Job) -> Result<(u64, u64), String> {
    let name = name_of(&j.src);
    let src = j.src.trim_end_matches('/');
    let info = String::from_utf8_lossy(&run(&j.host, &format!("p={p}; if [ -d \"$p\" ]; then echo d; du -sb -- \"$p\" | cut -f1; else echo f; stat -L -c %s -- \"$p\"; fi", p = ssh::quote(src)))?).to_string();
    let mut lines = info.lines();
    let is_dir = lines.next() == Some("d");
    let total: u64 = lines.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    std::fs::create_dir_all(&j.dest_dir).map_err(|e| e.to_string())?;
    let mut m = Meter { app, job: j, total, bytes: 0, last: Instant::now() };
    if is_dir {
        let script = format!("tar -cf - -C {} {}", ssh::quote(&ops::parent(src)), ssh::quote(&name));
        let mut sc = ssh::command(&j.host, false);
        sc.arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut sh, sid) = spawn_tracked(sc, "ssh", &format!("download {name}"))?;
        track(&j.id, sid);
        let mut tar = Command::new("tar");
        tar.args(["-xf", "-", "-C", &j.dest_dir]);
        if let Some(expr) = tar_subst(&name, &j.dest_name) {
            tar.args(["-s", &expr]);
        }
        tar.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let (mut tc, tid) = spawn_tracked(tar, "tar", &format!("untar {name}"))?;
        track(&j.id, tid);
        let mut out = sh.stdout.take().unwrap();
        let mut stdin = tc.stdin.take().unwrap();
        let r = pump_bytes(&mut out, &mut stdin, &mut m);
        drop(stdin);
        if r.is_err() {
            kill_all_for(j);
        }
        let fin = finish(j, vec![(sh, sid, "ssh"), (tc, tid, "tar")]);
        if let Err(e) = r {
            if !j.cancel.load(Ordering::Relaxed) {
                return Err(e.to_string());
            }
        }
        fin?;
    } else {
        let dest = Path::new(&j.dest_dir).join(&j.dest_name);
        let tmp = Path::new(&j.dest_dir).join(format!(".{}.ace-part", j.dest_name));
        let mut sc = ssh::command(&j.host, false);
        sc.arg(format!("cat -- {}", ssh::quote(src))).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut sh, sid) = spawn_tracked(sc, "ssh", &format!("download {name}"))?;
        track(&j.id, sid);
        let mut out = sh.stdout.take().unwrap();
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let r = pump_bytes(&mut out, &mut f, &mut m);
        drop(f);
        if r.is_err() {
            kill_all_for(j);
        }
        let fin = finish(j, vec![(sh, sid, "ssh")]);
        if r.is_err() || fin.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        if let Err(e) = r {
            if !j.cancel.load(Ordering::Relaxed) {
                return Err(e.to_string());
            }
        }
        fin?;
        if !j.cancel.load(Ordering::Relaxed) {
            std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok((m.bytes, total))
}

/// Upload local files/dirs into `remote_dir` on `host`. Returns transfer ids.
#[tauri::command]
pub fn remote_upload(app: AppHandle, window: tauri::WebviewWindow, host: String, local_paths: Vec<String>, remote_dir: String, dest_names: Option<Vec<String>>) -> Vec<String> {
    enqueue(&app, window.label(), &host, true, local_paths, &remote_dir, dest_names)
}

/// Download remote files/dirs into `local_dir`. Returns transfer ids.
#[tauri::command]
pub fn remote_download(app: AppHandle, window: tauri::WebviewWindow, host: String, remote_paths: Vec<String>, local_dir: String, dest_names: Option<Vec<String>>) -> Vec<String> {
    enqueue(&app, window.label(), &host, false, remote_paths, &local_dir, dest_names)
}

#[tauri::command]
pub fn remote_cancel(app: AppHandle, id: String) {
    let (queued, flag, ids) = {
        let mut qq = q().lock().unwrap();
        let pos = qq.pending.iter().position(|j| j.id == id);
        let queued = pos.and_then(|i| qq.pending.remove(i));
        if queued.is_some() {
            qq.all.remove(&id);
        }
        (queued, qq.all.get(&id).cloned(), qq.procs.get(&id).cloned().unwrap_or_default())
    };
    if let Some(j) = queued {
        emit(&app, &j, 0, 0, "cancelled", None);
        return;
    }
    if let Some(f) = flag {
        f.store(true, Ordering::Relaxed);
    }
    for i in ids {
        crate::procs::kill(i);
    }
}

/// A window closed: cancel the transfers it started (queued ones vanish, running ones are stopped and their ssh/tar
/// children killed). Other windows' transfers are untouched.
pub fn release_window(label: &str) {
    let (flags, procs) = {
        let mut qq = q().lock().unwrap();
        let ids: Vec<String> = qq.owners.iter().filter(|(_, o)| *o == label).map(|(i, _)| i.clone()).collect();
        let dropped: Vec<String> = qq.pending.iter().filter(|j| j.owner == label).map(|j| j.id.clone()).collect();
        qq.pending.retain(|j| j.owner != label);
        for d in &dropped {
            qq.all.remove(d);
            qq.owners.remove(d);
        }
        let mut flags = vec![];
        let mut procs = vec![];
        for id in &ids {
            if let Some(f) = qq.all.get(id) {
                flags.push(f.clone());
            }
            procs.extend(qq.procs.get(id).cloned().unwrap_or_default());
        }
        (flags, procs)
    };
    for f in flags {
        f.store(true, Ordering::Relaxed);
    }
    for p in procs {
        crate::procs::kill(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subst_expression() {
        assert_eq!(tar_subst("a", "a"), None);
        assert_eq!(tar_subst("my.dir", "my.dir copy").unwrap(), ",^my\\.dir,my.dir copy,");
        // delimiter avoids chars present in names
        assert!(tar_subst("a,b", "c").unwrap().starts_with('|'));
    }

    #[test]
    fn bsdtar_rename_roundtrip() {
        let d = std::env::temp_dir().join(format!("ace-tarsub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src/my.dir/sub")).unwrap();
        std::fs::write(d.join("src/my.dir/sub/f.txt"), "hi").unwrap();
        std::fs::create_dir_all(d.join("out")).unwrap();
        let expr = tar_subst("my.dir", "my.dir (1)").unwrap();
        let c = Command::new("tar").args(["-cf", "-", "-s", &expr, "-C"]).arg(d.join("src")).arg("my.dir").stdout(Stdio::piped()).spawn().unwrap();
        let x = Command::new("tar").args(["-xf", "-", "-C"]).arg(d.join("out")).stdin(c.stdout.unwrap()).status().unwrap();
        assert!(x.success());
        assert_eq!(std::fs::read_to_string(d.join("out/my.dir (1)/sub/f.txt")).unwrap(), "hi");
        let _ = std::fs::remove_dir_all(&d);
    }
}
