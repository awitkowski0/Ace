//! Find in Files: ripgrep internals locally, `rg --json` (fallback `grep -rn`) over ssh remotely.
use super::index::skip_dir;
use crate::remote::ssh;
use crate::Location;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextOpts {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub words: bool,
    #[serde(default)]
    pub regex: bool,
    /// e.g. `*.gd` or `*.gd, *.tscn`
    #[serde(default)]
    pub mask: String,
    /// absolute directory to restrict to (defaults to the root)
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub path: String,
    pub rel: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
    /// utf16 [start, end) ranges inside `text`
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: f64,
    pub matches: Vec<TextMatch>,
    pub done: bool,
    pub total: usize,
    pub truncated: bool,
    pub error: Option<String>,
    pub elapsed_ms: f64,
}

pub fn split_masks(mask: &str) -> Vec<String> {
    mask.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()
}

fn pattern_of(o: &TextOpts) -> String {
    let p = if o.regex { o.query.clone() } else { regex::escape(&o.query) };
    p
}

fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

/// Build a (trimmed, ranged) match from a raw line + byte ranges.
fn make_match(path: String, rel: String, lnum: u32, line: &str, byte_ranges: &[(usize, usize)]) -> TextMatch {
    let trimmed = line.trim_end_matches(['\n', '\r']);
    let lead = trimmed.len() - trimmed.trim_start().len();
    let first = byte_ranges.first().map(|r| r.0).unwrap_or(0);
    let col = utf16_len(&trimmed[..first.min(trimmed.len())]) + 1;
    let body = &trimmed[lead..];
    let mut end = body.len().min(400);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let text = &body[..end];
    let mut ranges = Vec::new();
    for &(s, e) in byte_ranges {
        if s < lead || s - lead >= end {
            continue;
        }
        let (s, e) = (s - lead, (e - lead).min(end));
        ranges.push([utf16_len(&text[..s]), utf16_len(&text[..e])]);
    }
    TextMatch { path, rel, line: lnum, col, text: text.to_string(), ranges }
}

/// Parallel local search. `emit` is called from worker threads with batches (done=false), and once at
/// the end with done=true. Returns total matches.
pub fn search_local(root: &str, o: &TextOpts, id: f64, cancel: &AtomicBool, emit: &(dyn Fn(Batch) + Sync)) -> usize {
    let t0 = Instant::now();
    let fail = |msg: String| {
        emit(Batch { id, done: true, error: Some(msg), ..Default::default() });
        0
    };
    if o.query.is_empty() {
        return fail("empty query".into());
    }
    let matcher = match RegexMatcherBuilder::new().case_insensitive(!o.case_sensitive).word(o.words).build(&pattern_of(o)) {
        Ok(m) => m,
        Err(e) => return fail(e.to_string()),
    };
    let scope = o.scope.clone().unwrap_or_else(|| root.to_string());
    let mut wb = WalkBuilder::new(&scope);
    wb.hidden(false).follow_links(false).threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8));
    wb.filter_entry(|e| {
        e.depth() == 0 || !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && skip_dir(&e.file_name().to_string_lossy()))
    });
    let masks = split_masks(&o.mask);
    if !masks.is_empty() {
        let mut ob = OverrideBuilder::new(&scope);
        for m in &masks {
            let _ = ob.add(m);
        }
        if let Ok(ov) = ob.build() {
            wb.overrides(ov);
        }
    }
    let max = o.max_results.unwrap_or(5000);
    let total = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let prefix = format!("{}/", root.trim_end_matches('/'));

    struct Buf<'a> {
        v: Vec<TextMatch>,
        last: Instant,
        id: f64,
        emit: &'a (dyn Fn(Batch) + Sync),
    }
    impl Buf<'_> {
        fn flush(&mut self) {
            if !self.v.is_empty() {
                (self.emit)(Batch { id: self.id, matches: std::mem::take(&mut self.v), ..Default::default() });
            }
            self.last = Instant::now();
        }
    }
    impl Drop for Buf<'_> {
        fn drop(&mut self) {
            self.flush();
        }
    }

    wb.build_parallel().run(|| {
        let mut searcher = SearcherBuilder::new().line_number(true).binary_detection(BinaryDetection::quit(0)).build();
        let matcher = matcher.clone();
        let mut buf = Buf { v: Vec::new(), last: Instant::now(), id, emit };
        let (total, truncated, prefix) = (&total, &truncated, &prefix);
        Box::new(move |res| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(e) = res else { return WalkState::Continue };
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = e.path().to_string_lossy().into_owned();
            let rel = path.strip_prefix(prefix.as_str()).unwrap_or(&path).to_string();
            let m2 = matcher.clone();
            let r = searcher.search_path(
                &matcher,
                e.path(),
                Lossy(|lnum, line| {
                    let mut ranges = Vec::new();
                    let _ = m2.find_iter(line.as_bytes(), |m| {
                        ranges.push((m.start(), m.end()));
                        true
                    });
                    buf.v.push(make_match(path.clone(), rel.clone(), lnum as u32, line, &ranges));
                    let n = total.fetch_add(1, Ordering::Relaxed) + 1;
                    if n >= max {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    Ok(!cancel.load(Ordering::Relaxed))
                }),
            );
            let _ = r;
            if buf.v.len() >= 100 || buf.last.elapsed() > Duration::from_millis(40) {
                buf.flush();
            }
            if total.load(Ordering::Relaxed) >= max {
                WalkState::Quit
            } else {
                WalkState::Continue
            }
        })
    });
    let n = total.load(Ordering::Relaxed);
    emit(Batch { id, done: true, total: n, truncated: truncated.load(Ordering::Relaxed), elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0, ..Default::default() });
    n
}

fn byte_to_utf16_ranges(text: &str, ranges: &[(usize, usize)]) -> Vec<[u32; 2]> {
    ranges
        .iter()
        .filter(|r| r.1 <= text.len() && text.is_char_boundary(r.0) && text.is_char_boundary(r.1))
        .map(|r| [utf16_len(&text[..r.0]), utf16_len(&text[..r.1])])
        .collect()
}

/// Remote search via `rg --json` (fallback grep -rn). Streams batches as lines arrive.
pub fn search_remote(
    loc: &Location,
    o: &TextOpts,
    id: f64,
    cancel: &AtomicBool,
    proc_slot: &Mutex<Option<u64>>,
    emit: &(dyn Fn(Batch) + Sync),
) -> usize {
    let t0 = Instant::now();
    let max = o.max_results.unwrap_or(5000);
    let mut flags = String::new();
    if !o.case_sensitive {
        flags.push_str(" -i");
    } else {
        flags.push_str(" -s");
    }
    if o.words {
        flags.push_str(" -w");
    }
    if !o.regex {
        flags.push_str(" -F");
    }
    for m in split_masks(&o.mask) {
        flags.push_str(&format!(" -g {}", ssh::quote(&m)));
    }
    let scope = o.scope.clone().unwrap_or_else(|| loc.path.clone());
    let q = ssh::quote(&o.query);
    let skip = "-g '!.git' -g '!node_modules' -g '!target' -g '!.godot' -g '!build' -g '!dist'";
    // grep fallback emits "path:line:text" lines (no --json); distinguished by the `RG=` marker line.
    let gflags = format!("{}{}{}", if o.case_sensitive { "" } else { " -i" }, if o.words { " -w" } else { "" }, if o.regex { " -E" } else { " -F" });
    let script = format!(
        "cd {} && if command -v rg >/dev/null 2>&1; then echo RG=1; rg --json -n --hidden{flags} {skip} -e {q} . ; else echo RG=0; grep -rnI{gflags} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target --exclude-dir=build --exclude-dir=dist -e {q} . ; fi",
        ssh::quote(&scope)
    );
    let mut cmd = ssh::command(&loc.host, false);
    cmd.arg(ssh::login_wrap(&script)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(Batch { id, done: true, error: Some(e.to_string()), ..Default::default() });
            return 0;
        }
    };
    let stdout = child.stdout.take().unwrap();
    *proc_slot.lock().unwrap() = Some(crate::procs::register("search", &format!("rg {}", o.query), child));
    let reader = std::io::BufReader::new(stdout);
    let mut rg = true;
    let mut batch: Vec<TextMatch> = Vec::new();
    let mut last = Instant::now();
    let mut total = 0usize;
    let mut truncated = false;
    let root_prefix = format!("{}/", scope.trim_end_matches('/'));
    let abs = |p: &str| {
        let p = p.strip_prefix("./").unwrap_or(p);
        if p.starts_with('/') { p.to_string() } else { format!("{root_prefix}{p}") }
    };
    let rel_of = |a: &str| a.strip_prefix(&format!("{}/", loc.path.trim_end_matches('/'))).unwrap_or(a).to_string();
    for line in reader.split(b'\n') {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(bytes) = line else { break };
        let line = String::from_utf8_lossy(&bytes).into_owned();
        if line == "RG=1" || line == "RG=0" {
            rg = line == "RG=1";
            continue;
        }
        let m = if rg {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if v["type"] != "match" {
                continue;
            }
            let d = &v["data"];
            let (Some(p), Some(ln), Some(text)) = (d["path"]["text"].as_str(), d["line_number"].as_u64(), d["lines"]["text"].as_str()) else { continue };
            let ranges: Vec<(usize, usize)> = d["submatches"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| Some((s["start"].as_u64()? as usize, s["end"].as_u64()? as usize))).collect())
                .unwrap_or_default();
            let a = abs(p);
            let rel = rel_of(&a);
            make_match(a, rel, ln as u32, text, &ranges)
        } else {
            let mut it = line.splitn(3, ':');
            let (Some(p), Some(ln), Some(text)) = (it.next(), it.next(), it.next()) else { continue };
            let Ok(ln) = ln.parse::<u32>() else { continue };
            let a = abs(p);
            let rel = rel_of(&a);
            // best-effort highlight (case-insensitive literal)
            let lower = text.to_lowercase();
            let needle = o.query.to_lowercase();
            let mut r = vec![];
            if !o.regex && !needle.is_empty() && lower.len() == text.len() {
                if let Some(i) = lower.find(&needle) {
                    r.push((i, i + needle.len()));
                }
            }
            make_match(a, rel, ln, text, &r)
        };
        batch.push(m);
        total += 1;
        if total >= max {
            truncated = true;
            break;
        }
        if batch.len() >= 100 || last.elapsed() > Duration::from_millis(60) {
            emit(Batch { id, matches: std::mem::take(&mut batch), ..Default::default() });
            last = Instant::now();
        }
    }
    if !batch.is_empty() {
        emit(Batch { id, matches: std::mem::take(&mut batch), ..Default::default() });
    }
    if let Some(pid) = proc_slot.lock().unwrap().take() {
        crate::procs::kill(pid);
        crate::procs::unregister(pid);
    }
    emit(Batch { id, done: true, total, truncated, elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0, ..Default::default() });
    total
}

pub type CancelMap = Mutex<std::collections::HashMap<u64, (Arc<AtomicBool>, Arc<Mutex<Option<u64>>>)>>;

// ------------------------------------------------------------------ replace

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files: usize,
    pub replacements: usize,
    pub errors: Vec<String>,
}

pub fn replace_local(o: &TextOpts, replacement: &str, files: &[String]) -> Result<ReplaceResult, String> {
    let mut pat = pattern_of(o);
    if o.words {
        pat = format!(r"\b(?:{pat})\b");
    }
    let re = regex::RegexBuilder::new(&pat).case_insensitive(!o.case_sensitive).build().map_err(|e| e.to_string())?;
    let mut res = ReplaceResult { files: 0, replacements: 0, errors: vec![] };
    for f in files {
        let text = match std::fs::read_to_string(f) {
            Ok(t) => t,
            Err(e) => {
                res.errors.push(format!("{f}: {e}"));
                continue;
            }
        };
        let n = re.find_iter(&text).count();
        if n == 0 {
            continue;
        }
        let out = if o.regex { re.replace_all(&text, replacement).into_owned() } else { re.replace_all(&text, regex::NoExpand(replacement)).into_owned() };
        match std::fs::write(f, out) {
            Ok(_) => {
                res.files += 1;
                res.replacements += n;
            }
            Err(e) => res.errors.push(format!("{f}: {e}")),
        }
    }
    Ok(res)
}
