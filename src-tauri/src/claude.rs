//! Claude Code session manager backend: lists sessions (local + ssh hosts), running `claude` processes,
//! and watches ~/.claude/projects locally. Only head+tail of each JSONL is read; results cached by
//! (path, mtime, size).
use crate::remote::ssh;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const CHUNK: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub host: String,
    pub file: String,
    pub cwd: String,
    pub title: String,
    pub messages: u64,
    pub approx: bool,
    pub modified: u64, // unix ms
    pub size: u64,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunningClaude {
    pub pid: u32,
    pub cwd: String,
    /// Explicit `--resume <id>` argument.
    pub session_id: Option<String>,
    /// Plain `claude` (no --resume): the session whose jsonl in this cwd was appended in the last ~60s.
    /// Only set when unambiguous (candidates <= plain processes in that cwd). Never a guess otherwise.
    #[serde(default)]
    pub active_session_id: Option<String>,
}

const CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
struct DiskCache {
    version: u32,
    /// jsonl path -> (mtime ms, size, info)
    entries: HashMap<String, (u64, u64, SessionInfo)>,
    /// last full listing per host (shown immediately while the real refresh runs)
    snapshots: HashMap<String, Vec<SessionInfo>>,
}

struct CacheState {
    d: DiskCache,
    dirty: bool,
}
type Cache = Mutex<CacheState>;

fn cache_file() -> Option<std::path::PathBuf> {
    // A test override of the projects dir must never overwrite the real session snapshot.
    if crate::appenv::var_os("ACE_CLAUDE_PROJECTS").is_some() {
        return None;
    }
    dirs::cache_dir().map(|c| c.join("ace").join(format!("claude-sessions.v{CACHE_VERSION}.json")))
}

fn load_disk() -> DiskCache {
    let fresh = || DiskCache { version: CACHE_VERSION, ..Default::default() };
    let Some(p) = cache_file() else { return fresh() };
    let Ok(bytes) = std::fs::read(&p) else { return fresh() };
    match serde_json::from_slice::<DiskCache>(&bytes) {
        Ok(d) if d.version == CACHE_VERSION => d,
        _ => fresh(),
    }
}

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(CacheState { d: load_disk(), dirty: false }))
}

/// Atomically write the cache if it changed.
fn persist_cache() {
    let Some(p) = cache_file() else { return };
    let bytes = {
        let mut g = cache().lock().unwrap();
        if !g.dirty {
            return;
        }
        g.dirty = false;
        match serde_json::to_vec(&g.d) {
            Ok(b) => b,
            Err(_) => return,
        }
    };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(|b| {
            (b.get("type")?.as_str()? == "text").then(|| b.get("text")?.as_str().map(String::from)).flatten()
        }),
        _ => None,
    }
}

fn real_prompt(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") || t.starts_with("[Request interrupted") {
        return None;
    }
    let one: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(one.chars().take(120).collect())
}

fn lines_of(buf: &[u8], drop_first: bool, drop_last: bool) -> Vec<&str> {
    let mut s = buf;
    if drop_first {
        match s.iter().position(|&b| b == b'\n') {
            Some(i) => s = &s[i + 1..],
            None => return vec![],
        }
    }
    let mut v: Vec<&str> = s.split(|&b| b == b'\n').filter_map(|l| std::str::from_utf8(l).ok()).collect();
    if drop_last {
        v.pop();
    }
    v
}

fn count(buf: &[u8], pat: &[u8]) -> u64 {
    buf.windows(pat.len()).filter(|w| *w == pat).count() as u64
}

fn parse_file(path: &Path, id: &str, mtime: u64, size: u64) -> SessionInfo {
    let mut info = SessionInfo { id: id.into(), host: "local".into(), file: path.to_string_lossy().into(), modified: mtime, size, ..Default::default() };
    let Ok(mut f) = File::open(path) else { return info };
    let small = size <= CHUNK * 2;
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let _ = (&mut f).take(if small { size } else { CHUNK }).read_to_end(&mut head);
    if !small && f.seek(SeekFrom::Start(size - CHUNK)).is_ok() {
        let _ = f.read_to_end(&mut tail);
    }
    let (mut title_sum, mut title_ai, mut first, mut last_prompt) = (None::<String>, None::<String>, None::<String>, None::<String>);
    let mut visit = |line: &str, is_head: bool| {
        if line.len() > 200_000 || !line.starts_with('{') {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if info.cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                info.cwd = c.into();
            }
        }
        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() && b != "HEAD" {
                info.branch = Some(b.into());
            }
        }
        match v.get("type").and_then(Value::as_str) {
            Some("summary") => title_sum = v.get("summary").and_then(Value::as_str).map(String::from).or(title_sum.take()),
            Some("ai-title") => title_ai = v.get("aiTitle").and_then(Value::as_str).map(String::from).or(title_ai.take()),
            Some("last-prompt") => last_prompt = v.get("lastPrompt").and_then(Value::as_str).and_then(real_prompt).or(last_prompt.take()),
            Some("user") if is_head && first.is_none() && v.get("isMeta").and_then(Value::as_bool) != Some(true) => {
                first = v.get("message").and_then(|m| m.get("content")).and_then(text_of).and_then(|s| real_prompt(&s));
            }
            _ => {}
        }
    };
    for l in lines_of(&head, false, !small) {
        visit(l, true);
    }
    for l in lines_of(&tail, true, false) {
        visit(l, false);
    }
    info.title = title_sum.or(title_ai).or(first).or(last_prompt).unwrap_or_else(|| "(untitled)".into());
    let n = count(&head, b"\"type\":\"user\"") + count(&head, b"\"type\":\"assistant\"") + count(&tail, b"\"type\":\"user\"") + count(&tail, b"\"type\":\"assistant\"");
    let scanned = (head.len() + tail.len()) as u64;
    if small || scanned == 0 {
        info.messages = n;
    } else {
        info.messages = n * size / scanned;
        info.approx = true;
    }
    info
}

/// `~/.claude/projects`; `ACE_CLAUDE_PROJECTS` overrides it (automation tests with synthetic transcripts).
pub(crate) fn projects_dir() -> Option<std::path::PathBuf> {
    if let Some(p) = crate::appenv::var_os("ACE_CLAUDE_PROJECTS") {
        return Some(p.into());
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn folder_cwd(folder: &str) -> String {
    folder.replacen('-', "/", 1).replace('-', "/")
}

fn local_sessions() -> Vec<SessionInfo> {
    let Some(root) = projects_dir() else { return vec![] };
    // 1. stat everything (cheap), 2. parse only files whose (mtime,size) changed, in parallel.
    struct Item {
        path: std::path::PathBuf,
        folder: String,
        mtime: u64,
        size: u64,
    }
    let mut items: Vec<Item> = Vec::new();
    let Ok(dirs) = std::fs::read_dir(&root) else { return vec![] };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        let folder = d.file_name().to_string_lossy().into_owned();
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(md) = f.metadata() else { continue };
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            items.push(Item { path: p, folder: folder.clone(), mtime, size: md.len() });
        }
    }
    let mut out: Vec<Option<SessionInfo>> = vec![None; items.len()];
    let mut todo: Vec<usize> = Vec::new();
    {
        let g = cache().lock().unwrap();
        for (i, it) in items.iter().enumerate() {
            let key = it.path.to_string_lossy();
            match g.d.entries.get(key.as_ref()).filter(|c| c.0 == it.mtime && c.1 == it.size) {
                Some(c) => out[i] = Some(c.2.clone()),
                None => todo.push(i),
            }
        }
    }
    let changed = !todo.is_empty();
    if !todo.is_empty() {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        let chunk = todo.len().div_ceil(threads).max(1);
        let parsed: Vec<(usize, SessionInfo)> = std::thread::scope(|s| {
            let hs: Vec<_> = todo
                .chunks(chunk)
                .map(|c| {
                    let items = &items;
                    s.spawn(move || {
                        c.iter()
                            .map(|&i| {
                                let it = &items[i];
                                let id = it.path.file_stem().unwrap().to_string_lossy().into_owned();
                                (i, parse_file(&it.path, &id, it.mtime, it.size))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        let mut g = cache().lock().unwrap();
        for (i, info) in parsed {
            g.d.entries.insert(items[i].path.to_string_lossy().into_owned(), (items[i].mtime, items[i].size, info.clone()));
            out[i] = Some(info);
        }
    }
    let mut res = Vec::with_capacity(items.len());
    for (it, info) in items.iter().zip(out) {
        let mut info = info.unwrap();
        if info.cwd.is_empty() {
            info.cwd = folder_cwd(&it.folder);
        }
        res.push(info);
    }
    {
        let mut g = cache().lock().unwrap();
        let live: std::collections::HashSet<String> = items.iter().map(|i| i.path.to_string_lossy().into_owned()).collect();
        let before = g.d.entries.len();
        g.d.entries.retain(|k, _| live.contains(k));
        let mut sorted = res.clone();
        sorted.sort_by(|a, b| b.modified.cmp(&a.modified));
        g.d.snapshots.insert("local".into(), sorted);
        g.dirty = g.dirty || changed || before != g.d.entries.len();
    }
    persist_cache();
    res
}

const REMOTE_PY: &str = r#"
import os,sys,json,re
H=65536
root=os.path.expanduser('~/.claude/projects')
def real(s):
    t=s.strip()
    if not t or t[0]=='<' or t.startswith('Caveat:') or t.startswith('[Request interrupted'): return None
    return ' '.join(t.split())[:120]
def txt(c):
    if isinstance(c,str): return c
    if isinstance(c,list):
        for b in c:
            if isinstance(b,dict) and b.get('type')=='text': return b.get('text')
out=[]
for d in (os.listdir(root) if os.path.isdir(root) else []):
    dp=os.path.join(root,d)
    if not os.path.isdir(dp): continue
    for fn in os.listdir(dp):
        if not fn.endswith('.jsonl'): continue
        p=os.path.join(dp,fn)
        try:
            st=os.stat(p); size=st.st_size
            with open(p,'rb') as f:
                small=size<=2*H
                head=f.read(size if small else H)
                tail=b''
                if not small:
                    f.seek(size-H); tail=f.read()
        except Exception: continue
        cwd='';br=None;ts=None;ta=None;first=None;lp=None
        def visit(line,ish):
            global cwd,br,ts,ta,first,lp
            if len(line)>200000 or not line.startswith(b'{'): return
            try: v=json.loads(line)
            except Exception: return
            if not cwd and v.get('cwd'): cwd=v['cwd']
            b=v.get('gitBranch')
            if b and b!='HEAD': br=b
            t=v.get('type')
            if t=='summary': ts=v.get('summary') or ts
            elif t=='ai-title': ta=v.get('aiTitle') or ta
            elif t=='last-prompt': lp=real(v.get('lastPrompt') or '') or lp
            elif t=='user' and ish and first is None and not v.get('isMeta'):
                s=txt((v.get('message') or {}).get('content'))
                if s: first=real(s)
        hl=head.split(b'\n')
        if not small: hl=hl[:-1]
        for l in hl: visit(l,True)
        if tail:
            for l in tail.split(b'\n')[1:]: visit(l,False)
        n=sum(x.count(b'"type":"user"')+x.count(b'"type":"assistant"') for x in (head,tail))
        sc=len(head)+len(tail)
        approx=not small and sc>0
        msgs=n*size//sc if approx else n
        out.append(dict(id=fn[:-6],host=HOST,file=p,cwd=cwd or re.sub('-','/',d,count=0),title=ts or ta or first or lp or '(untitled)',messages=msgs,approx=approx,modified=int(st.st_mtime*1000),size=size,branch=br))
print(json.dumps(out))
"#;

fn remote_sessions(host: &str) -> Result<Vec<SessionInfo>, String> {
    let script = format!("HOST={}\n{}", format!("{:?}", host), REMOTE_PY);
    let cmd = format!("python3 -c {}", ssh::quote(&script));
    let out = ssh::exec_login(host, &cmd)?;
    let v: Vec<SessionInfo> = serde_json::from_str(out.trim()).map_err(|e| format!("bad session list from {host}: {e}"))?;
    let mut sorted = v.clone();
    sorted.sort_by(|a, b| b.modified.cmp(&a.modified));
    {
        let mut g = cache().lock().unwrap();
        g.d.snapshots.insert(host.to_string(), sorted);
        g.dirty = true;
    }
    persist_cache();
    Ok(v)
}

/// Last persisted listing for `host` (instant, may be stale). The UI shows it and then calls `claude_sessions`.
#[tauri::command]
pub async fn claude_sessions_cached(host: String) -> Result<Vec<SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let h = if host.is_empty() { "local".to_string() } else { host };
        cache().lock().unwrap().d.snapshots.get(&h).cloned().unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_sessions(host: String) -> Result<Vec<SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut v = if host == "local" || host.is_empty() { local_sessions() } else { remote_sessions(&host)? };
        v.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_ps(ps: &str, cwds: &HashMap<u32, String>) -> Vec<RunningClaude> {
    let mut out = Vec::new();
    for line in ps.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(comm)) = (it.next().and_then(|p| p.parse::<u32>().ok()), it.next()) else { continue };
        let args: Vec<&str> = it.collect();
        let base = comm.rsplit('/').next().unwrap_or(comm);
        let is_node = base == "node" && args.iter().any(|a| a.contains("claude-code") || a.ends_with("/claude"));
        if base != "claude" && !is_node {
            continue;
        }
        let session_id = args.iter().position(|a| *a == "--resume" || *a == "-r").and_then(|i| args.get(i + 1)).map(|s| s.to_string());
        out.push(RunningClaude { pid, cwd: cwds.get(&pid).cloned().unwrap_or_default(), session_id, active_session_id: None });
    }
    out
}

/// Claude's project folder name for a cwd: every non-alphanumeric char becomes '-'.
pub(crate) fn encode_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

const ACTIVE_WINDOW_SECS: u64 = 60;

/// For plain `claude` processes (no --resume): attach the session whose jsonl in that cwd was appended within
/// the last minute, but only when that is unambiguous (candidates <= plain procs in that cwd). Otherwise leave
/// `active_session_id` empty so the UI shows "running (session unknown)".
fn attach_active(procs: &mut [RunningClaude], recent: &HashMap<String, Vec<String>>) {
    let explicit: std::collections::HashSet<String> = procs.iter().filter_map(|p| p.session_id.clone()).collect();
    let mut plain_by_cwd: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in procs.iter().enumerate() {
        if p.session_id.is_none() && !p.cwd.is_empty() {
            plain_by_cwd.entry(p.cwd.clone()).or_default().push(i);
        }
    }
    for (cwd, idxs) in plain_by_cwd {
        let cands: Vec<&String> = recent.get(&cwd).map(|v| v.iter().filter(|id| !explicit.contains(*id)).collect()).unwrap_or_default();
        if !cands.is_empty() && cands.len() <= idxs.len() {
            if cands.len() == 1 && idxs.len() == 1 {
                procs[idxs[0]].active_session_id = Some(cands[0].clone());
            } else {
                // several plain procs: we know which sessions are live but not which pid owns which
                for (k, id) in cands.iter().enumerate() {
                    procs[idxs[k]].active_session_id = Some((*id).clone());
                }
            }
        }
    }
}

fn local_recent(cwds: &[String]) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    let Some(root) = projects_dir() else { return out };
    for cwd in cwds {
        let dir = root.join(encode_cwd(cwd));
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut v: Vec<(std::time::Duration, String)> = Vec::new();
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(md) = f.metadata() else { continue };
            let Ok(age) = md.modified().and_then(|m| m.elapsed().map_err(std::io::Error::other)) else { continue };
            if age.as_secs() <= ACTIVE_WINDOW_SECS {
                v.push((age, p.file_stem().unwrap().to_string_lossy().into_owned()));
            }
        }
        v.sort();
        if !v.is_empty() {
            out.insert(cwd.clone(), v.into_iter().map(|x| x.1).collect());
        }
    }
    out
}

#[tauri::command]
pub async fn claude_running(host: String) -> Result<Vec<RunningClaude>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if host == "local" || host.is_empty() {
            let ps = std::process::Command::new("ps").args(["-axo", "pid=,comm=,args="]).output().map_err(|e| e.to_string())?;
            let ps = String::from_utf8_lossy(&ps.stdout).into_owned();
            let mut r = parse_ps(&ps, &HashMap::new());
            if !r.is_empty() {
                let pids: Vec<String> = r.iter().map(|p| p.pid.to_string()).collect();
                let l = std::process::Command::new("lsof").args(["-a", "-d", "cwd", "-Fpn", "-p", &pids.join(",")]).output();
                if let Ok(l) = l {
                    let mut cur = 0u32;
                    let mut m = HashMap::new();
                    for line in String::from_utf8_lossy(&l.stdout).lines() {
                        if let Some(p) = line.strip_prefix('p') {
                            cur = p.parse().unwrap_or(0);
                        } else if let Some(n) = line.strip_prefix('n') {
                            m.insert(cur, n.to_string());
                        }
                    }
                    for p in &mut r {
                        p.cwd = m.get(&p.pid).cloned().unwrap_or_default();
                    }
                }
            }
            let mut cwds: Vec<String> = r.iter().filter(|p| p.session_id.is_none()).map(|p| p.cwd.clone()).filter(|c| !c.is_empty()).collect();
            cwds.sort();
            cwds.dedup();
            let recent = local_recent(&cwds);
            attach_active(&mut r, &recent);
            Ok(r)
        } else {
            let script = r#"ps -eo pid=,comm=,args= | awk '$2=="claude"||/claude-code/{print}' | while read -r pid rest; do echo "P $pid $rest"; c=$(readlink /proc/$pid/cwd 2>/dev/null); echo "C $pid $c"; d="$HOME/.claude/projects/$(printf %s "$c" | sed 's/[^A-Za-z0-9]/-/g')"; find "$d" -maxdepth 1 -name '*.jsonl' -mmin -1 2>/dev/null | while read -r f; do echo "J $c $(basename "$f" .jsonl)"; done; done"#;
            let out = ssh::exec(&host, script)?;
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let mut cwds = HashMap::new();
            let mut ps = String::new();
            let mut recent: HashMap<String, Vec<String>> = HashMap::new();
            for l in text.lines() {
                if let Some(r) = l.strip_prefix("J ") {
                    if let Some((c, id)) = r.rsplit_once(' ') {
                        let e = recent.entry(c.to_string()).or_default();
                        if !e.contains(&id.to_string()) {
                            e.push(id.to_string());
                        }
                    }
                } else if let Some(r) = l.strip_prefix("P ") {
                    ps.push_str(r);
                    ps.push('\n');
                } else if let Some(r) = l.strip_prefix("C ") {
                    if let Some((p, c)) = r.split_once(' ') {
                        if let Ok(p) = p.parse::<u32>() {
                            cwds.insert(p, c.to_string());
                        }
                    }
                }
            }
            let mut r = parse_ps(&ps, &cwds);
            attach_active(&mut r, &recent);
            Ok(r)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- local watcher: emits `claude://changed` (debounced) to the windows that asked for it ----
// One watcher for the whole app (the sessions dir is global), reference counted by window label. It is also the event source of the
// transcript fallback (claude_hooks::on_paths), which keeps it alive without the Claude panel being open.
fn watcher() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    static W: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}
fn watchers() -> &'static Mutex<std::collections::BTreeSet<String>> {
    static W: OnceLock<Mutex<std::collections::BTreeSet<String>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

pub(crate) fn ensure_watcher(app: &tauri::AppHandle) -> Result<(), String> {
    use notify::{EventKind, Watcher};
    let mut g = watcher().lock().unwrap();
    if g.is_some() {
        return Ok(());
    }
    let Some(root) = projects_dir().filter(|p| p.exists()) else { return Ok(()) };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<std::path::PathBuf>>();
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths: std::collections::HashSet<std::path::PathBuf> = first.into_iter().collect();
            std::thread::sleep(std::time::Duration::from_millis(700));
            while let Ok(more) = rx.try_recv() {
                paths.extend(more);
            }
            let labels = watchers().lock().unwrap().clone();
            if !labels.is_empty() {
                crate::windows::emit_windows(&app, labels.iter(), "claude://changed", ());
            }
            crate::claude_hooks::on_paths(&app, &paths);
        }
    });
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if !matches!(ev.kind, EventKind::Access(_)) {
                let _ = tx.send(ev.paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(&root, notify::RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *g = Some(w);
    Ok(())
}

/// Drop the shared watcher when neither the panel nor the notification fallback of any window needs it
/// (dropping it closes the channel and ends the debounce thread).
pub(crate) fn maybe_drop_watcher() {
    if watchers().lock().unwrap().is_empty() && !crate::claude_hooks::fallback_active() {
        *watcher().lock().unwrap() = None;
    }
}

#[tauri::command]
pub fn claude_watch(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    watchers().lock().unwrap().insert(window.label().to_string());
    ensure_watcher(&app)
}

#[tauri::command]
pub fn claude_unwatch(window: tauri::WebviewWindow) {
    watchers().lock().unwrap().remove(window.label());
    maybe_drop_watcher();
}

/// A window closed: leave the shared watcher, stop its hook listeners / followers / fallback scope.
pub fn release_window(label: &str) {
    watchers().lock().unwrap().remove(label);
    crate::claude_hooks::release_window(label);
    maybe_drop_watcher();
}

#[tauri::command]
pub fn claude_reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer needs `/select,"<path>"` verbatim (raw_arg), and it exits 1 even on success: only a spawn failure counts.
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        cmd.raw_arg(format!("/select,\"{path}\""));
        return crate::platform::no_window(&mut cmd).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    std::process::Command::new("open").args(["-R", &path]).status().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rc(pid: u32, cwd: &str, sid: Option<&str>) -> RunningClaude {
        RunningClaude { pid, cwd: cwd.into(), session_id: sid.map(String::from), active_session_id: None }
    }

    #[test]
    fn active_detection_never_guesses() {
        assert_eq!(encode_cwd("/Users/alexw/my_proj.x"), "-Users-alexw-my-proj-x");
        let mut recent = HashMap::new();
        recent.insert("/a".to_string(), vec!["s1".to_string()]);
        recent.insert("/b".to_string(), vec!["s2".to_string(), "s3".to_string()]);
        // one proc, one recently written jsonl -> attributed
        let mut p = vec![rc(1, "/a", None)];
        attach_active(&mut p, &recent);
        assert_eq!(p[0].active_session_id.as_deref(), Some("s1"));
        // one proc, two candidates -> ambiguous, nothing claimed
        let mut p = vec![rc(2, "/b", None)];
        attach_active(&mut p, &recent);
        assert_eq!(p[0].active_session_id, None);
        // explicit --resume of the only candidate -> plain proc stays unknown
        let mut p = vec![rc(3, "/a", Some("s1")), rc(4, "/a", None)];
        attach_active(&mut p, &recent);
        assert_eq!(p[1].active_session_id, None);
        // no recent writes -> unknown
        let mut p = vec![rc(5, "/c", None)];
        attach_active(&mut p, &recent);
        assert_eq!(p[0].active_session_id, None);
    }

    #[test]
    #[ignore]
    fn live_counts() {
        let t = std::time::Instant::now();
        let c = tauri::async_runtime::block_on(super::claude_sessions_cached("local".into())).unwrap();
        println!("cached list (disk load + deserialize): {} sessions in {:?}", c.len(), t.elapsed());
        for h in ["local", "mc"] {
            for round in 0..2 {
                let t = std::time::Instant::now();
                let v = if h == "local" { super::local_sessions() } else { super::remote_sessions(h).unwrap() };
                let untitled = v.iter().filter(|s| s.title == "(untitled)").count();
                let nocwd = v.iter().filter(|s| s.cwd.is_empty()).count();
                println!("{h} round{round}: {} sessions, untitled {untitled}, nocwd {nocwd}, {:?}", v.len(), t.elapsed());
            }
        }
        for h in ["local", "mc"] {
            let t = std::time::Instant::now();
            let r = tauri::async_runtime::block_on(super::claude_running(h.into())).unwrap();
            println!("running {h}: {} {:?}", r.len(), t.elapsed());
        }
    }
}
