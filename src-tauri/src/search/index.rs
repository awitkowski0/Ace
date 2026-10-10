//! Per-project file index (paths only) + fuzzy matcher with IntelliJ-style camel-hump semantics.
use crate::remote::ssh;
use crate::Location;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

pub const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".godot", "build", "dist", ".gradle", ".idea"];

pub fn skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

#[derive(Clone)]
pub struct Entry {
    pub rel: String,
    /// byte offset of the file name inside `rel`
    pub name_off: u32,
}

impl Entry {
    pub fn new(rel: String) -> Self {
        let name_off = rel.rfind('/').map(|i| i + 1).unwrap_or(0) as u32;
        Entry { rel, name_off }
    }
    pub fn name(&self) -> &str {
        &self.rel[self.name_off as usize..]
    }
}

#[derive(Default)]
pub struct SymState {
    pub map: HashMap<String, Arc<Vec<super::symbols::Sym>>>,
    pub dirty: HashSet<String>,
    pub full: bool,
    pub remote_at: Option<Instant>,
}

pub struct Index {
    pub root: String,
    pub host: String,
    pub local: bool,
    pub files: RwLock<Vec<Entry>>, // sorted by rel
    pub built: Instant,
    pub refreshing: AtomicBool,
    pub gi: Gitignore,
    pub sym: Mutex<SymState>,
}

fn rel_skipped(rel: &str) -> bool {
    rel.split('/').any(skip_dir)
}

pub fn build_local(root: &str) -> Vec<Entry> {
    let out = Mutex::new(Vec::<Entry>::new());
    struct Flush<'a> {
        buf: Vec<Entry>,
        out: &'a Mutex<Vec<Entry>>,
    }
    impl Drop for Flush<'_> {
        fn drop(&mut self) {
            self.out.lock().unwrap().append(&mut self.buf);
        }
    }
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .threads(threads)
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && skip_dir(&e.file_name().to_string_lossy()))
        })
        .build_parallel()
        .run(|| {
            let mut f = Flush { buf: Vec::with_capacity(1024), out: &out };
            let prefix = prefix.clone();
            Box::new(move |res| {
                if let Ok(e) = res {
                    if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        if let Some(rel) = e.path().to_string_lossy().strip_prefix(prefix.as_str()) {
                            f.buf.push(Entry::new(rel.to_string()));
                        }
                    }
                }
                ignore::WalkState::Continue
            })
        });
    let mut v = out.into_inner().unwrap();
    v.sort_by(|a, b| a.rel.cmp(&b.rel));
    v
}

pub fn build_remote(host: &str, root: &str) -> Result<Vec<Entry>, String> {
    let cmd = format!(
        "cd {r} && (rg --files --hidden -g '!.git' -g '!node_modules' -g '!target' -g '!.godot' -g '!build' -g '!dist' 2>/dev/null || find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/target/*' -not -path '*/build/*' -not -path '*/dist/*' | sed 's|^\\./||')",
        r = ssh::quote(root)
    );
    let out = ssh::exec_login(host, &cmd)?;
    let mut v: Vec<Entry> = out.lines().filter(|l| !l.is_empty()).map(|l| Entry::new(l.to_string())).collect();
    v.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(v)
}

fn build_gitignore(root: &str) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let _ = b.add(Path::new(root).join(".gitignore"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

pub fn build(loc: &Location) -> Result<Index, String> {
    let (files, local) = if loc.is_local() { (build_local(&loc.path), true) } else { (build_remote(&loc.host, &loc.path)?, false) };
    Ok(Index {
        root: loc.path.trim_end_matches('/').to_string(),
        host: loc.host.clone(),
        local,
        files: RwLock::new(files),
        built: Instant::now(),
        refreshing: AtomicBool::new(false),
        gi: if local { build_gitignore(&loc.path) } else { Gitignore::empty() },
        sym: Mutex::new(SymState::default()),
    })
}

type Cell = Arc<OnceLock<Result<Arc<Index>, String>>>;
fn registry() -> &'static Mutex<HashMap<String, Cell>> {
    static R: OnceLock<Mutex<HashMap<String, Cell>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn key(loc: &Location) -> String {
    format!("{}:{}", if loc.is_local() { "local" } else { &loc.host }, loc.path.trim_end_matches('/'))
}

/// Get (building if needed) the index. Remote indexes are refreshed in the background when stale.
pub fn get(loc: &Location) -> Result<Arc<Index>, String> {
    let k = key(loc);
    let cell = registry().lock().unwrap().entry(k.clone()).or_default().clone();
    let res = cell.get_or_init(|| build(loc).map(Arc::new)).clone();
    match res {
        Ok(ix) => {
            if !ix.local && ix.built.elapsed().as_secs() > 90 && !ix.refreshing.swap(true, Ordering::SeqCst) {
                let loc = loc.clone();
                std::thread::spawn(move || {
                    if let Ok(new) = build(&loc) {
                        let c: Cell = Arc::new(OnceLock::new());
                        let _ = c.set(Ok(Arc::new(new)));
                        registry().lock().unwrap().insert(key(&loc), c);
                    }
                });
            }
            Ok(ix)
        }
        Err(e) => {
            registry().lock().unwrap().remove(&k); // allow retry
            Err(e)
        }
    }
}

pub fn existing_for_root(root: &str) -> Option<Arc<Index>> {
    let k = format!("local:{}", root.trim_end_matches('/'));
    let c = registry().lock().unwrap().get(&k).cloned()?;
    c.get().and_then(|r| r.as_ref().ok().cloned())
}

pub fn drop_key(k: &str) {
    registry().lock().unwrap().remove(k);
}

pub fn drop_index(loc: &Location) {
    registry().lock().unwrap().remove(&key(loc));
}

impl Index {
    pub fn count(&self) -> usize {
        self.files.read().unwrap().len()
    }
    fn insert(&self, rel: String) {
        let mut f = self.files.write().unwrap();
        if let Err(i) = f.binary_search_by(|e| e.rel.as_str().cmp(&rel)) {
            f.insert(i, Entry::new(rel));
        }
    }
    fn remove_prefix(&self, rel: &str) {
        let mut f = self.files.write().unwrap();
        let dir = format!("{rel}/");
        f.retain(|e| e.rel != rel && !e.rel.starts_with(&dir));
    }

    /// Apply an fs watcher event (local only).
    pub fn apply_change(&self, abs: &str) {
        let Some(rel) = abs.strip_prefix(&self.root).map(|r| r.trim_start_matches('/')) else { return };
        if rel.is_empty() || rel_skipped(rel) {
            return;
        }
        let p = Path::new(abs);
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() => {
                if self.gi.matched_path_or_any_parents(p, false).is_ignore() {
                    return;
                }
                self.insert(rel.to_string());
                self.sym.lock().unwrap().dirty.insert(rel.to_string());
            }
            Ok(m) if m.is_dir() => {
                if self.gi.matched_path_or_any_parents(p, true).is_ignore() {
                    return;
                }
                self.remove_prefix(rel);
                let sub = build_local(abs);
                for e in sub {
                    self.insert(format!("{rel}/{}", e.rel));
                }
            }
            _ => {
                self.remove_prefix(rel);
                let mut s = self.sym.lock().unwrap();
                s.map.remove(rel);
            }
        }
    }
}

// ---------------------------------------------------------------- matching

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub name_start: u32,
    /// matched character indices into `rel`
    pub indices: Vec<u32>,
    pub score: u32,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub hits: Vec<FileHit>,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub total: usize,
    pub elapsed_ms: f64,
}

/// Split a trailing `:42` / `:42:7` / `(42)` off the query.
pub fn split_line_suffix(q: &str) -> (&str, Option<u32>, Option<u32>) {
    let q = q.trim();
    if let Some(i) = q.rfind(':') {
        let tail = &q[i + 1..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            let n: u32 = tail.parse().unwrap_or(0);
            let head = &q[..i];
            if let Some(j) = head.rfind(':') {
                let t2 = &head[j + 1..];
                if !t2.is_empty() && t2.bytes().all(|b| b.is_ascii_digit()) {
                    return (&head[..j], t2.parse().ok(), Some(n));
                }
            }
            return (head, Some(n), None);
        }
    }
    (q, None, None)
}


pub fn query_files(ix: &Index, raw: &str, limit: usize, recent: &[String]) -> FileResult {
    let t0 = Instant::now();
    let (q, line, col) = split_line_suffix(raw);
    let mut res = FileResult { line, col, ..Default::default() };
    if q.is_empty() {
        return res;
    }
    let recent_rank: HashMap<&str, u32> = recent
        .iter()
        .filter_map(|p| p.strip_prefix(&ix.root).map(|r| r.trim_start_matches('/')))
        .enumerate()
        .map(|(i, r)| (r, 100u32.saturating_sub(i as u32 * 3)))
        .collect();
    let q_nospace: String = q.chars().filter(|c| !c.is_whitespace()).collect();
    let files = ix.files.read().unwrap();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let chunk = (files.len() / threads).max(2000);
    let mut scored: Vec<(i32, u32, usize)> = Vec::new(); // score, len, idx
    std::thread::scope(|s| {
        let mut hs = Vec::new();
        for (ci, part) in files.chunks(chunk).enumerate() {
            let recent_rank = &recent_rank;
            let q = q_nospace.as_str();
            hs.push(s.spawn(move || {
                let mut out = Vec::new();
                for (j, e) in part.iter().enumerate() {
                    if let Some(m) = super::fuzzy::match_path(q, &e.rel, e.name_off as usize) {
                        let sc = m.score + recent_rank.get(e.rel.as_str()).copied().unwrap_or(0) as i32;
                        out.push((sc, e.rel.len() as u32, ci * chunk + j));
                    }
                }
                out
            }));
        }
        for h in hs {
            scored.extend(h.join().unwrap());
        }
    });
    res.total = scored.len();
    let k = limit.min(scored.len());
    if k > 0 && k < scored.len() {
        scored.select_nth_unstable_by(k - 1, |a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.truncate(k);
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    for (sc, _, idx) in scored {
        let e = &files[idx];
        let name_char_off = e.rel[..e.name_off as usize].chars().count() as u32;
        let mut indices = super::fuzzy::match_path(&q_nospace, &e.rel, e.name_off as usize).map(|m| m.indices).unwrap_or_default();
        indices.sort_unstable();
        indices.dedup();
        res.hits.push(FileHit {
            path: format!("{}/{}", ix.root, e.rel),
            rel: e.rel.clone(),
            name: e.name().to_string(),
            name_start: name_char_off,
            indices,
            score: sc.max(0) as u32,
        });
    }
    res.elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    res
}
