//! Git module: shells out to `git` (locally, or through `remote::ssh` for remote roots).
//! All commands take the project `root: Location`; paths in arguments/results are relative to the
//! repository top level (git's own convention in porcelain v2), so we address them with `:(top)`.
//! Long-running network ops (fetch/pull/push) stream via `git://output` / `git://done` events and are
//! registered in the process registry (cancel with `procs_kill(job)`).
use crate::remote::ssh;
use crate::{procs, Location};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

// ---------- runner ----------

const BASE_ARGS: [&str; 2] = ["-c", "core.quotepath=off"];

fn run_raw(root: &Location, args: &[String], ok: &[i32]) -> Result<Vec<u8>, String> {
    let out = if root.is_local() {
        let mut c = Command::new("git");
        c.arg("-C").arg(&root.path)
            .args(BASE_ARGS).args(args)
            .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C")
            .stdin(Stdio::null());
        crate::platform::no_window(&mut c).output().map_err(|e| format!("git: {e}"))?
    } else {
        ssh::exec(&root.host, &ssh::login_wrap(&remote_line(root, args)))?
    };
    let code = out.status.code().unwrap_or(-1);
    if code == 0 || ok.contains(&code) {
        Ok(out.stdout)
    } else {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if e.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { e })
    }
}

fn remote_line(root: &Location, args: &[String]) -> String {
    let mut s = format!(
        "GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C {} -c core.quotepath=off",
        ssh::quote(&root.path)
    );
    for a in args {
        s.push(' ');
        s.push_str(&ssh::quote(a));
    }
    s
}

fn run(root: &Location, args: &[&str]) -> Result<String, String> {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_raw(root, &a, &[]).map(|b| String::from_utf8_lossy(&b).into_owned())
}
fn run_v(root: &Location, args: Vec<String>) -> Result<String, String> {
    run_raw(root, &args, &[]).map(|b| String::from_utf8_lossy(&b).into_owned())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn top(p: &str) -> String {
    format!(":(top){p}")
}
fn with_paths(mut base: Vec<String>, paths: &[String]) -> Vec<String> {
    base.push("--".into());
    base.extend(paths.iter().map(|p| top(p)));
    base
}
fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ---------- status ----------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub orig: Option<String>,
    pub index: String,
    pub worktree: String,
    /// modified | added | deleted | renamed | copied | typechange | conflict | untracked
    pub kind: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub is_repo: bool,
    pub toplevel: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<Change>,
}

fn kind_of(xy: &str) -> &'static str {
    let b: Vec<char> = xy.chars().collect();
    let (x, y) = (b[0], b[1]);
    if x == 'U' || y == 'U' || xy == "AA" || xy == "DD" {
        return "conflict";
    }
    let c = if x != '.' { x } else { y };
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        _ => "modified",
    }
}

fn parse_status(raw: &str, st: &mut Status) {
    let mut it = raw.split('\0');
    while let Some(tok) = it.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(h) = tok.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                st.oid = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                if v == "(detached)" { st.detached = true; } else { st.branch = Some(v.to_string()); }
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                let mut p = v.split(' ');
                st.ahead = p.next().and_then(|s| s.trim_start_matches('+').parse().ok()).unwrap_or(0);
                st.behind = p.next().and_then(|s| s.trim_start_matches('-').parse().ok()).unwrap_or(0);
            }
            continue;
        }
        let kindc = tok.as_bytes()[0];
        match kindc {
            b'1' => {
                let f: Vec<&str> = tok.splitn(9, ' ').collect();
                if f.len() == 9 { push(st, f[8], None, f[1]); }
            }
            b'2' => {
                let f: Vec<&str> = tok.splitn(10, ' ').collect();
                let orig = it.next().map(|s| s.to_string());
                if f.len() == 10 { push(st, f[9], orig, f[1]); }
            }
            b'u' => {
                let f: Vec<&str> = tok.splitn(11, ' ').collect();
                if f.len() == 11 { push(st, f[10], None, f[1]); }
            }
            b'?' => st.changes.push(Change {
                path: tok[2..].to_string(), orig: None, index: "?".into(), worktree: "?".into(), kind: "untracked".into(),
            }),
            _ => {}
        }
    }
}
fn push(st: &mut Status, path: &str, orig: Option<String>, xy: &str) {
    st.changes.push(Change {
        path: path.to_string(), orig,
        index: xy[0..1].to_string(), worktree: xy[1..2].to_string(), kind: kind_of(xy).into(),
    });
}

#[tauri::command]
pub async fn git_status(root: Location) -> Result<Status, String> {
    blocking(move || {
        let top = match run(&root, &["rev-parse", "--show-toplevel"]) {
            Ok(t) => t.trim().to_string(),
            Err(e) if e.contains("not a git repository") || e.contains("No such file") => return Ok(Status::default()),
            Err(e) => return Err(e),
        };
        let raw = run(&root, &["status", "--porcelain=v2", "-z", "--branch", "-uall"])?;
        let mut st = Status { is_repo: true, toplevel: top, ..Default::default() };
        parse_status(&raw, &mut st);
        Ok(st)
    })
    .await
}

// ---------- content / diff ----------

/// Content of `<rev>:<path>`; rev "" = index. None when the path doesn't exist at that rev.
#[tauri::command]
pub async fn git_show(root: Location, rev: String, path: String) -> Result<Option<String>, String> {
    blocking(move || {
        Ok(run_raw(&root, &sv(&["show", &format!("{rev}:{path}")]), &[]).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineChange {
    pub kind: String, // added | modified | deleted
    pub start: u32,
    pub end: u32,
}

/// HEAD vs working tree line ranges for the editor gutter.
#[tauri::command]
pub async fn git_line_changes(root: Location, path: String) -> Result<Vec<LineChange>, String> {
    blocking(move || {
        let out = run_v(&root, with_paths(sv(&["diff", "-U0", "--no-color", "--no-ext-diff", "HEAD"]), &[path]))?;
        let mut v = vec![];
        for l in out.lines().filter(|l| l.starts_with("@@")) {
            // @@ -a,b +c,d @@
            let plus = l.split(' ').nth(2).unwrap_or("+0");
            let minus = l.split(' ').nth(1).unwrap_or("-0");
            let rng = |s: &str| -> (u32, u32) {
                let s = &s[1..];
                let mut p = s.split(',');
                (p.next().and_then(|x| x.parse().ok()).unwrap_or(0), p.next().and_then(|x| x.parse().ok()).unwrap_or(1))
            };
            let (c, d) = rng(plus);
            let (_, b) = rng(minus);
            if d == 0 {
                v.push(LineChange { kind: "deleted".into(), start: c.max(1), end: c.max(1) });
            } else {
                v.push(LineChange { kind: if b == 0 { "added" } else { "modified" }.into(), start: c, end: c + d - 1 });
            }
        }
        Ok(v)
    })
    .await
}

// ---------- index / commit ----------

#[tauri::command]
pub async fn git_stage(root: Location, paths: Vec<String>) -> Result<(), String> {
    blocking(move || run_v(&root, with_paths(sv(&["add", "-A"]), &paths)).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage(root: Location, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        run_v(&root, with_paths(sv(&["restore", "--staged"]), &paths))
            .or_else(|_| run_v(&root, with_paths(sv(&["rm", "--cached", "-r", "-q"]), &paths)))
            .map(|_| ())
    })
    .await
}

#[derive(Deserialize)]
pub struct RollbackItem {
    pub path: String,
    pub orig: Option<String>,
    pub kind: String,
}

#[tauri::command]
pub async fn git_rollback(root: Location, items: Vec<RollbackItem>) -> Result<(), String> {
    blocking(move || {
        let sel = |f: &dyn Fn(&RollbackItem) -> bool| -> Vec<String> { items.iter().filter(|i| f(i)).map(|i| i.path.clone()).collect() };
        let untracked = sel(&|i| i.kind == "untracked");
        let added = sel(&|i| i.kind == "added");
        let mut restore = sel(&|i| !matches!(i.kind.as_str(), "untracked" | "added" | "renamed"));
        let renamed: Vec<&RollbackItem> = items.iter().filter(|i| i.kind == "renamed").collect();
        if !untracked.is_empty() {
            run_v(&root, with_paths(sv(&["clean", "-fdq"]), &untracked))?;
        }
        if !added.is_empty() {
            run_v(&root, with_paths(sv(&["rm", "--cached", "-q", "-f"]), &added))?;
        }
        if !renamed.is_empty() {
            let news: Vec<String> = renamed.iter().map(|r| r.path.clone()).collect();
            run_v(&root, with_paths(sv(&["rm", "-q", "-f"]), &news))?;
            restore.extend(renamed.iter().filter_map(|r| r.orig.clone()));
        }
        if !restore.is_empty() {
            run_v(&root, with_paths(sv(&["restore", "--source=HEAD", "--staged", "--worktree"]), &restore))?;
        }
        Ok(())
    })
    .await
}

/// Commit exactly `paths` (stages them first; `origs` = rename sources, only used in the commit pathspec). Empty paths => commit the index.
#[tauri::command]
pub async fn git_commit(root: Location, message: String, amend: bool, paths: Vec<String>, origs: Vec<String>) -> Result<String, String> {
    blocking(move || {
        if !paths.is_empty() {
            run_v(&root, with_paths(sv(&["add", "-A"]), &paths))?;
        }
        let mut a = sv(&["commit", "-m", &message]);
        if amend { a.push("--amend".into()); }
        if !paths.is_empty() {
            let mut all = paths.clone();
            all.extend(origs);
            a = with_paths(a, &all);
        }
        run_v(&root, a)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_body(root: Location, rev: String) -> Result<String, String> {
    blocking(move || run(&root, &["log", "-1", "--format=%B", &rev]).map(|s| s.trim_end().to_string())).await
}

// ---------- branches ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub upstream: Option<String>,
    pub current: bool,
}
#[derive(Serialize, Default)]
pub struct Branches {
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
}

#[tauri::command]
pub async fn git_branches(root: Location) -> Result<Branches, String> {
    blocking(move || {
        let out = run(&root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(HEAD)", "refs/heads", "refs/remotes"])?;
        let mut b = Branches::default();
        for l in out.lines() {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 4 { continue; }
            let br = Branch { name: f[1].to_string(), upstream: (!f[2].is_empty()).then(|| f[2].to_string()), current: f[3] == "*" };
            if f[0].starts_with("refs/heads/") {
                b.local.push(br);
            } else if !f[0].ends_with("/HEAD") {
                b.remote.push(br);
            }
        }
        Ok(b)
    })
    .await
}

/// create=false: `checkout <name>` (track=true: `checkout --track <remote/name>`); create=true: `checkout -b name [start]`.
#[tauri::command]
pub async fn git_checkout(root: Location, name: String, create: bool, start_point: Option<String>, track: bool) -> Result<String, String> {
    blocking(move || {
        let mut a = sv(&["checkout"]);
        if create {
            a.extend(sv(&["-b", &name]));
            if let Some(s) = start_point { a.push(s); }
        } else {
            if track { a.push("--track".into()); }
            a.push(name);
        }
        run_v(&root, a)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(root: Location, name: String, force: bool) -> Result<String, String> {
    blocking(move || run(&root, &["branch", if force { "-D" } else { "-d" }, &name])).await
}

// ---------- fetch / pull / push (streamed) ----------

#[derive(Serialize, Clone)]
struct OutEv { job: u64, line: String }
#[derive(Serialize, Clone)]
struct DoneEv { job: u64, op: String, ok: bool, code: Option<i32> }

fn pump(mut r: impl Read + Send + 'static, app: AppHandle, label: String, job: u64) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let (mut buf, mut cur) = ([0u8; 4096], Vec::<u8>::new());
        let flush = |cur: &mut Vec<u8>| {
            if !cur.is_empty() {
                crate::windows::emit_window(&app, &label, "git://output", OutEv { job, line: String::from_utf8_lossy(cur).into_owned() });
                cur.clear();
            }
        };
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 { break; }
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' { flush(&mut cur); } else { cur.push(b); }
            }
        }
        flush(&mut cur);
    })
}

/// op: "fetch" | "pull" | "push". `args` are extra flags/refspecs. Returns the job id (= process registry id).
#[tauri::command]
pub async fn git_stream(app: AppHandle, window: tauri::WebviewWindow, root: Location, op: String, args: Vec<String>) -> Result<u64, String> {
    if !matches!(op.as_str(), "fetch" | "pull" | "push") {
        return Err(format!("unsupported op {op}"));
    }
    let label = window.label().to_string();
    blocking(move || {
        let mut a = vec![op.clone(), "--progress".to_string()];
        a.extend(args);
        let mut cmd = if root.is_local() {
            let mut c = Command::new("git");
            c.arg("-C").arg(&root.path).args(BASE_ARGS).args(&a)
                .env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
            c
        } else {
            let mut c = ssh::command(&root.host, false);
            c.arg(ssh::login_wrap(&remote_line(&root, &a)));
            c
        };
        crate::platform::no_window(&mut cmd);
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("git: {e}"))?;
        let (so, se, pid) = (child.stdout.take(), child.stderr.take(), child.id());
        let child = Arc::new(Mutex::new(child));
        let kc = child.clone();
        let job = procs::register_killer_for(&label, "git", &format!("git {op} ({})", root.path), Some(pid), Box::new(move || {
            let _ = kc.lock().unwrap().kill();
        }));
        let mut hs = vec![];
        if let Some(s) = so { hs.push(pump(s, app.clone(), label.clone(), job)); }
        if let Some(s) = se { hs.push(pump(s, app.clone(), label.clone(), job)); }
        std::thread::spawn(move || {
            for h in hs { let _ = h.join(); }
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(s)) => break s.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            procs::unregister(job);
            crate::windows::emit_window(&app, &label, "git://done", DoneEv { job, op, ok: code == Some(0), code });
        });
        Ok(job)
    })
    .await
}

// ---------- log ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
}

#[tauri::command]
pub async fn git_log(root: Location, skip: u32, limit: u32, all: bool, rev: Option<String>, search: Option<String>) -> Result<Vec<Commit>, String> {
    blocking(move || {
        let mut a = sv(&["log", "--date-order", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e", "-i"]);
        a.push(format!("--skip={skip}"));
        a.push(format!("-n{limit}"));
        if all { a.push("--all".into()); }
        if let Some(s) = search.filter(|s| !s.is_empty()) { a.push(format!("--grep={s}")); }
        if let Some(r) = rev { a.push(r); }
        a.push("--".into());
        let out = match run_v(&root, a) {
            Ok(o) => o,
            Err(e) if e.contains("does not have any commits") || e.contains("bad default revision") => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        Ok(out.split('\x1e').filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 7 { return None; }
            Some(Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(), email: f[3].to_string(), time: f[4].parse().unwrap_or(0),
                refs: f[5].split(", ").filter(|s| !s.is_empty()).map(String::from).collect(),
                subject: f[6].to_string(),
            })
        }).collect())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub status: String,
    pub path: String,
    pub orig: Option<String>,
}

#[tauri::command]
pub async fn git_commit_files(root: Location, hash: String) -> Result<Vec<CommitFile>, String> {
    blocking(move || {
        let out = run(&root, &["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", "--root", "-m", "--first-parent", &hash])?;
        let mut it = out.split('\0').filter(|s| !s.is_empty());
        let mut v = vec![];
        while let Some(s) = it.next() {
            let st = s.chars().next().unwrap_or('M');
            if st == 'R' || st == 'C' {
                let (o, n) = (it.next(), it.next());
                if let (Some(o), Some(n)) = (o, n) { v.push(CommitFile { status: st.to_string(), path: n.into(), orig: Some(o.into()) }); }
            } else if let Some(p) = it.next() {
                v.push(CommitFile { status: st.to_string(), path: p.into(), orig: None });
            }
        }
        Ok(v)
    })
    .await
}

// ---------- blame ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameRange {
    pub start: u32,
    pub count: u32,
    pub hash: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
}

#[tauri::command]
pub async fn git_blame(root: Location, path: String) -> Result<Vec<BlameRange>, String> {
    blocking(move || {
        // blame doesn't understand :(top) pathspecs; run it from the top level instead.
        let tl = Location { host: root.host.clone(), path: run(&root, &["rev-parse", "--show-toplevel"])?.trim().to_string() };
        let out = run_v(&tl, sv(&["blame", "--porcelain", "--", &path]))?;
        let mut meta: HashMap<String, (String, i64, String)> = HashMap::new();
        let (mut cur, mut fin) = (String::new(), 0u32);
        let mut lines: Vec<(u32, String)> = vec![];
        for l in out.lines() {
            if l.starts_with('\t') {
                lines.push((fin, cur.clone()));
                continue;
            }
            let mut p = l.split(' ');
            let first = p.next().unwrap_or("");
            if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
                cur = first.to_string();
                fin = p.nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
                meta.entry(cur.clone()).or_default();
            } else if let Some(v) = l.strip_prefix("author ") {
                meta.entry(cur.clone()).or_default().0 = v.into();
            } else if let Some(v) = l.strip_prefix("author-time ") {
                meta.entry(cur.clone()).or_default().1 = v.parse().unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("summary ") {
                meta.entry(cur.clone()).or_default().2 = v.into();
            }
        }
        let mut v: Vec<BlameRange> = vec![];
        for (n, h) in lines {
            if let Some(last) = v.last_mut() {
                if last.hash == h && last.start + last.count == n { last.count += 1; continue; }
            }
            let m = meta.get(&h).cloned().unwrap_or_default();
            v.push(BlameRange { start: n, count: 1, hash: h, author: m.0, time: m.1, summary: m.2 });
        }
        Ok(v)
    })
    .await
}

// ---------- profiles support (Asset Dev: docs/PROFILES.md) ----------
// Safe update + commit helpers used by src/components/profiles. Never a bare `git stash` / `git stash pop`: stashes are tagged with a
// unique message and re-applied / dropped by commit SHA, so a stash made by someone else is never touched.

/// Tracked + untracked (not ignored) files below the project root matching `pathspecs` (git pathspecs, e.g. `:(glob)**/assets/**`),
/// relative to the project root. Files deleted in the work tree are left out.
#[tauri::command]
pub async fn git_ls_files(root: Location, pathspecs: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || {
        let mut a = sv(&["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
        if !pathspecs.is_empty() {
            a.push("--".into());
            a.extend(pathspecs.iter().cloned());
        }
        let raw = run_raw(&root, &a, &[]).map(|b| String::from_utf8_lossy(&b).into_owned())?;
        let mut del = sv(&["ls-files", "-z", "--deleted"]);
        if !pathspecs.is_empty() {
            del.push("--".into());
            del.extend(pathspecs.iter().cloned());
        }
        let gone: std::collections::HashSet<String> = run_raw(&root, &del, &[])
            .map(|b| String::from_utf8_lossy(&b).split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
            .unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        Ok(raw.split('\0').filter(|s| !s.is_empty() && !gone.contains(*s) && seen.insert(s.to_string())).map(|s| s.to_string()).collect())
    })
    .await
}

/// `git stash push --include-untracked -m <message>`. Returns the stash commit SHA, or None when there was nothing to stash.
/// `message` must be unique (the caller tags it); the SHA is verified against it so an unrelated older stash is never returned.
#[tauri::command]
pub async fn git_stash_push(root: Location, message: String) -> Result<Option<String>, String> {
    blocking(move || {
        run_v(&root, sv(&["stash", "push", "--include-untracked", "-m", &message]))?;
        let sha = run_raw(&root, &sv(&["rev-parse", "-q", "--verify", "refs/stash"]), &[1])
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default();
        if sha.len() != 40 {
            return Ok(None);
        }
        let subject = run_v(&root, sv(&["log", "-1", "--format=%s", &sha]))?;
        Ok(subject.trim_end().ends_with(&message).then_some(sha))
    })
    .await
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `git stash apply <sha>` (the stash stays in the list; drop it with git_stash_drop once the result is fine).
#[tauri::command]
pub async fn git_stash_apply(root: Location, sha: String) -> Result<String, String> {
    if !is_sha(&sha) { return Err("not a commit id".into()); }
    blocking(move || run_v(&root, sv(&["stash", "apply", &sha]))).await
}

/// Drops the stash whose commit is `sha` (no-op when it is already gone).
#[tauri::command]
pub async fn git_stash_drop(root: Location, sha: String) -> Result<bool, String> {
    if !is_sha(&sha) { return Err("not a commit id".into()); }
    blocking(move || {
        let list = run(&root, &["stash", "list", "--format=%H"])?;
        match list.lines().position(|l| l.trim() == sha) {
            Some(i) => run_v(&root, sv(&["stash", "drop", &format!("stash@{{{i}}}")])).map(|_| true),
            None => Ok(false),
        }
    })
    .await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub rebasing: bool,
    pub merging: bool,
}

#[tauri::command]
pub async fn git_repo_state(root: Location) -> Result<RepoState, String> {
    blocking(move || {
        let has = |r: &str| run_raw(&root, &sv(&["rev-parse", "-q", "--verify", r]), &[1]).map(|b| !b.is_empty()).unwrap_or(false);
        Ok(RepoState { rebasing: has("REBASE_HEAD"), merging: has("MERGE_HEAD") })
    })
    .await
}

/// Resolve a conflicted file by taking one side wholesale (`side` = "ours" | "theirs"), then stage it. A side that deleted the file wins as a delete.
#[tauri::command]
pub async fn git_resolve(root: Location, path: String, side: String) -> Result<(), String> {
    if side != "ours" && side != "theirs" { return Err("side must be ours or theirs".into()); }
    blocking(move || {
        let flag = format!("--{side}");
        let p = [path.clone()];
        if run_v(&root, with_paths(sv(&["checkout", &flag]), &p)).is_ok() {
            run_v(&root, with_paths(sv(&["add", "-A"]), &p)).map(|_| ())
        } else {
            run_v(&root, with_paths(sv(&["rm", "-q", "-f"]), &p)).map(|_| ())
        }
    })
    .await
}

/// `continue` | `abort` for a rebase stopped on conflicts (no editor is opened).
#[tauri::command]
pub async fn git_rebase(root: Location, action: String) -> Result<String, String> {
    if action != "continue" && action != "abort" { return Err("bad rebase action".into()); }
    blocking(move || run_v(&root, sv(&["-c", "core.editor=true", "rebase", &format!("--{action}")]))).await
}

/// `git merge --abort` / `git reset --merge`-free helper: abort a merge left by a failed pull.
#[tauri::command]
pub async fn git_merge_abort(root: Location) -> Result<String, String> {
    blocking(move || run_v(&root, sv(&["merge", "--abort"]))).await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitUser {
    pub name: String,
    pub email: String,
}

#[tauri::command]
pub async fn git_user(root: Location) -> Result<GitUser, String> {
    blocking(move || {
        let get = |k: &str| run_raw(&root, &sv(&["config", "--get", k]), &[1]).map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
        Ok(GitUser { name: get("user.name"), email: get("user.email") })
    })
    .await
}

fn gh_bin() -> String {
    for p in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
        if std::path::Path::new(p).exists() { return p.to_string(); }
    }
    "gh".into()
}

/// GitHub CLI, restricted to `--version`, `pr create ...` and `pr view ...`. Returns stdout (the PR URL for create).
#[tauri::command]
pub async fn git_gh(root: Location, args: Vec<String>) -> Result<String, String> {
    let ok = matches!(args.first().map(|s| s.as_str()), Some("--version"))
        || (args.len() >= 2 && args[0] == "pr" && (args[1] == "create" || args[1] == "view"));
    if !ok { return Err("unsupported gh command".into()); }
    blocking(move || {
        let out = if root.is_local() {
            let mut c = Command::new(gh_bin());
            c.args(&args).current_dir(&root.path)
                .env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
            crate::platform::no_window(&mut c).output().map_err(|e| format!("gh: {e}"))?
        } else {
            let mut line = format!("cd {} && GH_PROMPT_DISABLED=1 gh", ssh::quote(&root.path));
            for a in &args { line.push(' '); line.push_str(&ssh::quote(a)); }
            ssh::exec(&root.host, &ssh::login_wrap(&line))?
        };
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if e.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { e })
        }
    })
    .await
}

/// Quiet background `git fetch --prune` (never prompts; local or over the shared ssh connection). Used by the Asset Dev "newer version" notice.
#[tauri::command]
pub async fn git_fetch_quiet(root: Location) -> Result<(), String> {
    blocking(move || run_v(&root, sv(&["fetch", "--quiet", "--prune", "--no-tags"])).map(|_| ())).await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    /// commits on the upstream of the current branch that HEAD does not have
    pub behind: u32,
    pub authors: Vec<String>,
    /// upstream tip (snooze key: a dismissed notice stays dismissed until this changes)
    pub tip: Option<String>,
    /// the repository's main branch (origin/HEAD, else origin/main|master) and how far HEAD is behind it
    pub base: Option<String>,
    pub base_behind: u32,
    pub base_tip: Option<String>,
    pub base_authors: Vec<String>,
}

#[tauri::command]
pub async fn git_incoming(root: Location, base: Option<String>) -> Result<Incoming, String> {
    blocking(move || {
        let ok1 = |a: &[&str]| run_raw(&root, &sv(a), &[1, 128]).map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
        let count_authors = |range: &str| -> (u32, Vec<String>) {
            let out = ok1(&["log", "--format=%an", range]);
            let mut authors: Vec<String> = vec![];
            let mut n = 0;
            for l in out.lines().filter(|l| !l.trim().is_empty()) {
                n += 1;
                if !authors.iter().any(|a| a == l) && authors.len() < 3 { authors.push(l.to_string()); }
            }
            (n, authors)
        };
        let mut inc = Incoming::default();
        let up = ok1(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        if !up.is_empty() {
            let (n, a) = count_authors("HEAD..@{u}");
            inc.behind = n;
            inc.authors = a;
            let tip = ok1(&["rev-parse", "@{u}"]);
            inc.tip = (!tip.is_empty()).then_some(tip);
        }
        // `base` (from .ace/config.json assets.baseBranch, e.g. origin/v1.20.1) wins when it exists; else origin/HEAD, origin/main, origin/master
        let mut base = base.filter(|b| !b.trim().is_empty() && !ok1(&["rev-parse", "-q", "--verify", b.trim()]).is_empty()).map(|b| b.trim().to_string()).unwrap_or_default();
        if base.is_empty() { base = ok1(&["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]); }
        if base.is_empty() {
            for c in ["origin/main", "origin/master"] {
                if !ok1(&["rev-parse", "-q", "--verify", c]).is_empty() { base = c.to_string(); break; }
            }
        }
        if !base.is_empty() && base != up {
            let (n, a) = count_authors(&format!("HEAD..{base}"));
            inc.base_behind = n;
            inc.base_authors = a;
            let tip = ok1(&["rev-parse", &base]);
            inc.base_tip = (!tip.is_empty()).then_some(tip);
            inc.base = Some(base);
        }
        Ok(inc)
    })
    .await
}

// ---------- worktrees ----------
// Parsing of `git worktree list --porcelain` lives in the frontend (src/lib/worktrees.ts, vitest); Rust only runs git.

/// Raw `git worktree list --porcelain` (local or remote). Run from any directory of the repo.
#[tauri::command]
pub async fn git_worktree_list(root: Location) -> Result<String, String> {
    blocking(move || run(&root, &["worktree", "list", "--porcelain"])).await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// tracked files with changes (untracked files are skipped on purpose: this must stay cheap)
    pub dirty: u32,
}

/// Cheap status of one worktree folder: `status --porcelain=v2 --branch -uno`.
#[tauri::command]
pub async fn git_worktree_status(path: Location) -> Result<WorktreeStatus, String> {
    blocking(move || {
        let raw = run(&path, &["status", "--porcelain=v2", "-z", "--branch", "-uno"])?;
        let mut st = Status::default();
        parse_status(&raw, &mut st);
        Ok(WorktreeStatus { branch: st.branch, detached: st.detached, upstream: st.upstream, ahead: st.ahead, behind: st.behind, dirty: st.changes.len() as u32 })
    })
    .await
}

/// `worktree add`: existing branch -> `add <path> <branch>`; new branch -> `add -b <branch> <path> [start]`;
/// track (remote branch `origin/x`) -> `add --track -b x <path> origin/x`.
#[tauri::command]
pub async fn git_worktree_add(root: Location, path: String, branch: String, new_branch: bool, start: Option<String>, track: bool) -> Result<String, String> {
    blocking(move || {
        let mut a = sv(&["worktree", "add"]);
        if track { a.push("--track".into()); }
        if new_branch {
            let local = if track { branch.split_once('/').map(|x| x.1.to_string()).unwrap_or(branch.clone()) } else { branch.clone() };
            a.extend(sv(&["-b", &local, &path]));
            if let Some(s) = start.filter(|s| !s.is_empty()) { a.push(s); } else if track { a.push(branch); }
        } else {
            a.push(path);
            a.push(branch);
        }
        run_v(&root, a)
    })
    .await
}

/// force -> `-f -f` (removes dirty and locked worktrees). Without force git itself refuses when files are modified/untracked.
#[tauri::command]
pub async fn git_worktree_remove(root: Location, path: String, force: bool) -> Result<String, String> {
    blocking(move || {
        let mut a = sv(&["worktree", "remove"]);
        if force { a.extend(sv(&["-f", "-f"])); }
        a.push(path);
        run_v(&root, a)
    })
    .await
}

/// Forget worktrees whose folder is gone (the UI previews them from the `prunable` flag of the list).
#[tauri::command]
pub async fn git_worktree_prune(root: Location) -> Result<(), String> {
    blocking(move || run(&root, &["worktree", "prune"]).map(|_| ())).await
}

#[cfg(all(test, unix))] // fixtures are built with sh -c
mod tests {
    use super::*;
    fn sh(d: &str, c: &str) {
        assert!(Command::new("sh").arg("-c").arg(c).current_dir(d).status().unwrap().success(), "{c}");
    }
    #[test]
    fn scratch_repo_flow() {
        let d = crate::appenv::var("ACE_GIT_TEST_DIR").unwrap_or_else(|_| "/tmp/ace-git-test".into());
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(format!("{d}/src/a")).unwrap();
        sh(&d, "git init -q -b main && git config user.email t@t && git config user.name T");
        sh(&d, "printf 'one\\ntwo\\nthree\\n' > src/a/f.txt && echo x > g.txt && git add -A && git commit -qm first");
        sh(&d, "printf 'one\\nTWO\\nthree\\nfour\\n' > src/a/f.txt && git mv g.txt h.txt && echo n > new.txt");
        let root = Location { host: "local".into(), path: d.clone() };
        macro_rules! rt { ($e:expr) => { tauri::async_runtime::block_on($e) }; }
        let st = rt!(git_status(root.clone())).unwrap();
        assert!(st.is_repo && st.branch.as_deref() == Some("main"));
        let kinds: Vec<_> = st.changes.iter().map(|c| (c.path.as_str(), c.kind.as_str(), c.orig.clone())).collect();
        println!("{kinds:?}");
        assert!(kinds.contains(&("h.txt", "renamed", Some("g.txt".into()))));
        assert!(kinds.contains(&("new.txt", "untracked", None)));
        let lc = rt!(git_line_changes(root.clone(), "src/a/f.txt".into())).unwrap();
        assert_eq!(lc.iter().map(|l| (l.kind.as_str(), l.start, l.end)).collect::<Vec<_>>(), vec![("modified", 2, 2), ("added", 4, 4)]);
        assert_eq!(rt!(git_show(root.clone(), "HEAD".into(), "src/a/f.txt".into())).unwrap().unwrap(), "one\ntwo\nthree\n");
        let out = rt!(git_commit(root.clone(), "second".into(), false, vec!["src/a/f.txt".into(), "h.txt".into()], vec!["g.txt".into()])).unwrap();
        println!("{out}");
        let st = rt!(git_status(root.clone())).unwrap();
        assert_eq!(st.changes.len(), 1);
        rt!(git_checkout(root.clone(), "feat".into(), true, None, false)).unwrap();
        let b = rt!(git_branches(root.clone())).unwrap();
        assert!(b.local.iter().any(|x| x.name == "feat" && x.current));
        let log = rt!(git_log(root.clone(), 0, 10, false, None, None)).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "second");
        let files = rt!(git_commit_files(root.clone(), log[0].hash.clone())).unwrap();
        assert!(files.iter().any(|f| f.status == "R" && f.path == "h.txt"));
        let bl = rt!(git_blame(root.clone(), "src/a/f.txt".into())).unwrap();
        assert_eq!(bl.iter().map(|b| b.count).sum::<u32>(), 4);
        rt!(git_rollback(root.clone(), vec![RollbackItem { path: "new.txt".into(), orig: None, kind: "untracked".into() }])).unwrap();
        assert!(rt!(git_status(root.clone())).unwrap().changes.is_empty());
        let nr = Location { host: "local".into(), path: "/tmp".into() };
        assert!(!rt!(git_status(nr)).unwrap().is_repo);
    }

    #[test]
    fn worktree_commands() {
        let d = crate::appenv::var("ACE_GIT_WT_TEST_DIR").unwrap_or_else(|_| format!("{}/ace-wt-test", std::env::temp_dir().display()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(format!("{d}/main")).unwrap();
        let m = format!("{d}/main");
        sh(&m, "git init -q -b main && git config user.email t@t && git config user.name T && echo a > a.txt && git add -A && git commit -qm first && git branch exist");
        let root = Location { host: "local".into(), path: m.clone() };
        macro_rules! rt { ($e:expr) => { tauri::async_runtime::block_on($e) }; }
        let w1 = format!("{d}/main-feat");
        rt!(git_worktree_add(root.clone(), w1.clone(), "feat".into(), true, None, false)).unwrap();
        let w2 = format!("{d}/main-exist");
        rt!(git_worktree_add(root.clone(), w2.clone(), "exist".into(), false, None, false)).unwrap();
        let raw = rt!(git_worktree_list(root.clone())).unwrap();
        assert_eq!(raw.matches("worktree ").count(), 3, "{raw}");
        assert!(raw.contains("branch refs/heads/feat"));
        // dirty count is cheap (-uno): tracked edit counts, untracked file does not
        std::fs::write(format!("{w1}/a.txt"), "changed").unwrap();
        std::fs::write(format!("{w1}/new.txt"), "x").unwrap();
        let st = rt!(git_worktree_status(Location { host: "local".into(), path: w1.clone() })).unwrap();
        assert_eq!((st.branch.as_deref(), st.dirty), (Some("feat"), 1));
        // refuses a dirty worktree without force, removes with force
        assert!(rt!(git_worktree_remove(root.clone(), w1.clone(), false)).is_err());
        rt!(git_worktree_remove(root.clone(), w1.clone(), true)).unwrap();
        assert!(!std::path::Path::new(&w1).exists());
        // prune: delete a worktree folder behind git's back
        std::fs::remove_dir_all(&w2).unwrap();
        assert!(rt!(git_worktree_list(root.clone())).unwrap().contains("prunable"));
        rt!(git_worktree_prune(root.clone())).unwrap();
        assert_eq!(rt!(git_worktree_list(root.clone())).unwrap().matches("worktree ").count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
