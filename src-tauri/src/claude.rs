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
    pub session_id: Option<String>,
}

type Cache = Mutex<HashMap<String, (u64, u64, SessionInfo)>>;
fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Default::default)
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

fn projects_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn local_sessions() -> Vec<SessionInfo> {
    let Some(root) = projects_dir() else { return vec![] };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let Ok(dirs) = std::fs::read_dir(&root) else { return out };
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
            let key = p.to_string_lossy().into_owned();
            seen.insert(key.clone());
            let cached = cache().lock().unwrap().get(&key).filter(|c| c.0 == mtime && c.1 == md.len()).map(|c| c.2.clone());
            let mut info = match cached {
                Some(i) => i,
                None => {
                    let id = p.file_stem().unwrap().to_string_lossy().into_owned();
                    let i = parse_file(&p, &id, mtime, md.len());
                    cache().lock().unwrap().insert(key, (mtime, md.len(), i.clone()));
                    i
                }
            };
            if info.cwd.is_empty() {
                info.cwd = folder.replacen('-', "/", 1).replace('-', "/");
            }
            out.push(info);
        }
    }
    cache().lock().unwrap().retain(|k, _| seen.contains(k));
    out
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
    serde_json::from_str(out.trim()).map_err(|e| format!("bad session list from {host}: {e}"))
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
        out.push(RunningClaude { pid, cwd: cwds.get(&pid).cloned().unwrap_or_default(), session_id });
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
            Ok(r)
        } else {
            let script = r#"ps -eo pid=,comm=,args= | awk '$2=="claude"||/claude-code/{print}' | while read -r pid rest; do echo "P $pid $rest"; echo "C $pid $(readlink /proc/$pid/cwd 2>/dev/null)"; done"#;
            let out = ssh::exec(&host, script)?;
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let mut cwds = HashMap::new();
            let mut ps = String::new();
            for l in text.lines() {
                if let Some(r) = l.strip_prefix("P ") {
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
            Ok(parse_ps(&ps, &cwds))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- local watcher: emits `claude://changed` (debounced) ----
fn watcher() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    static W: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn claude_watch(app: tauri::AppHandle) -> Result<(), String> {
    use notify::{EventKind, Watcher};
    use tauri::Emitter;
    let mut g = watcher().lock().unwrap();
    if g.is_some() {
        return Ok(());
    }
    let Some(root) = projects_dir().filter(|p| p.exists()) else { return Ok(()) };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            std::thread::sleep(std::time::Duration::from_millis(700));
            while rx.try_recv().is_ok() {}
            let _ = app.emit("claude://changed", ());
        }
    });
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if !matches!(ev.kind, EventKind::Access(_)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(&root, notify::RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *g = Some(w);
    Ok(())
}

#[tauri::command]
pub fn claude_unwatch() {
    *watcher().lock().unwrap() = None; // dropping the watcher closes the channel and ends the debounce thread
}

#[tauri::command]
pub fn claude_reveal(path: String) -> Result<(), String> {
    std::process::Command::new("open").args(["-R", &path]).status().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn live_counts() {
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
