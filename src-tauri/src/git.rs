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
use tauri::{AppHandle, Emitter};

// ---------- runner ----------

const BASE_ARGS: [&str; 2] = ["-c", "core.quotepath=off"];

fn run_raw(root: &Location, args: &[String], ok: &[i32]) -> Result<Vec<u8>, String> {
    let out = if root.is_local() {
        Command::new("git")
            .arg("-C").arg(&root.path)
            .args(BASE_ARGS).args(args)
            .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("git: {e}"))?
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

fn pump(mut r: impl Read + Send + 'static, app: AppHandle, job: u64) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let (mut buf, mut cur) = ([0u8; 4096], Vec::<u8>::new());
        let flush = |cur: &mut Vec<u8>| {
            if !cur.is_empty() {
                let _ = app.emit("git://output", OutEv { job, line: String::from_utf8_lossy(cur).into_owned() });
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
pub async fn git_stream(app: AppHandle, root: Location, op: String, args: Vec<String>) -> Result<u64, String> {
    if !matches!(op.as_str(), "fetch" | "pull" | "push") {
        return Err(format!("unsupported op {op}"));
    }
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
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("git: {e}"))?;
        let (so, se, pid) = (child.stdout.take(), child.stderr.take(), child.id());
        let child = Arc::new(Mutex::new(child));
        let kc = child.clone();
        let job = procs::register_killer("git", &format!("git {op} ({})", root.path), Some(pid), Box::new(move || {
            let _ = kc.lock().unwrap().kill();
        }));
        let mut hs = vec![];
        if let Some(s) = so { hs.push(pump(s, app.clone(), job)); }
        if let Some(s) = se { hs.push(pump(s, app.clone(), job)); }
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
            let _ = app.emit("git://done", DoneEv { job, op, ok: code == Some(0), code });
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

#[cfg(test)]
mod tests {
    use super::*;
    fn sh(d: &str, c: &str) {
        assert!(Command::new("sh").arg("-c").arg(c).current_dir(d).status().unwrap().success(), "{c}");
    }
    #[test]
    fn scratch_repo_flow() {
        let d = std::env::var("ATELIER_GIT_TEST_DIR").unwrap_or_else(|_| "/tmp/atelier-git-test".into());
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
}
