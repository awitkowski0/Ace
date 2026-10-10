//! Lightweight regex-based symbol extraction (cached per file in the index).
use super::index::{Index, SymState};
use crate::remote::ssh;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use regex::Regex;
use serde::Serialize;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sym {
    pub name: String,
    pub kind: &'static str, // class | function | signal | variable | constant | enum | interface | module | type
    pub line: u32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SymHit {
    pub name: String,
    pub kind: &'static str,
    pub path: String,
    pub rel: String,
    pub line: u32,
    pub indices: Vec<u32>,
    pub score: u32,
}

struct Rule {
    re: Regex,
    kind: &'static str,
    group: usize,
}
fn rules(lang: &str) -> &'static [Rule] {
    static T: OnceLock<std::collections::HashMap<&'static str, Vec<Rule>>> = OnceLock::new();
    let t = T.get_or_init(|| {
        let r = |p: &str, kind: &'static str, group: usize| Rule { re: Regex::new(p).unwrap(), kind, group };
        let mut m = std::collections::HashMap::new();
        m.insert("gd", vec![
            r(r"^\s*(?:static\s+)?func\s+(\w+)", "function", 1),
            r(r"^class_name\s+(\w+)", "class", 1),
            r(r"^\s*class\s+(\w+)", "class", 1),
            r(r"^\s*signal\s+(\w+)", "signal", 1),
            r(r"^enum\s+(\w+)", "enum", 1),
            r(r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+)?const\s+(\w+)", "constant", 1),
            r(r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+)?var\s+(\w+)", "variable", 1),
        ]);
        m.insert("ts", vec![
            r(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)", "function", 1),
            r(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)", "class", 1),
            r(r"^\s*(?:export\s+)?interface\s+(\w+)", "interface", 1),
            r(r"^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)", "enum", 1),
            r(r"^\s*(?:export\s+)?type\s+(\w+)\s*(?:<[^=]*>)?\s*=", "type", 1),
            r(r"^(?:export\s+)?(?:const|let|var)\s+(\w+)", "variable", 1),
        ]);
        m.insert("rs", vec![
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\x22[^\x22]*\x22\s+)?fn\s+(\w+)", "function", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|union)\s+(\w+)", "class", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)", "interface", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)", "enum", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)", "type", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)", "module", 1),
            r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)\s*:", "constant", 1),
        ]);
        m.insert("py", vec![
            r(r"^\s*(?:async\s+)?def\s+(\w+)", "function", 1),
            r(r"^\s*class\s+(\w+)", "class", 1),
            r(r"^([A-Z][A-Z0-9_]+)\s*[:=]", "constant", 1),
        ]);
        m.insert("java", vec![
            r(r"^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|record)\s+(\w+)", "class", 1),
            r(r"^\s*(?:(?:public|private|protected|static|abstract)\s+)*(?:interface|@interface)\s+(\w+)", "interface", 1),
            r(r"^\s*(?:(?:public|private|protected|static)\s+)*enum\s+(\w+)", "enum", 1),
            r(r"^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>\[\],.? ]+?\s+(\w+)\s*\(", "function", 1),
        ]);
        m.insert("kt", vec![
            r(r"^\s*(?:(?:public|private|protected|internal|data|sealed|open|abstract|inner|enum|annotation|value)\s+)*(?:class|object)\s+(\w+)", "class", 1),
            r(r"^\s*(?:(?:public|private|protected|internal|sealed|fun)\s+)*interface\s+(\w+)", "interface", 1),
            r(r"^\s*(?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?(\w+)", "function", 1),
            r(r"^\s*(?:(?:public|private|protected|internal|const|lateinit)\s+)*(?:val|var)\s+(\w+)", "variable", 1),
        ]);
        m
    });
    t.get(lang).map(|v| v.as_slice()).unwrap_or(&[])
}

pub fn lang_of(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?;
    Some(match ext {
        "gd" => "gd",
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "ts",
        "rs" => "rs",
        "py" => "py",
        "java" => "java",
        "kt" | "kts" => "kt",
        _ => return None,
    })
}

pub fn line_symbol(lang: &str, line: &str) -> Option<(&'static str, String)> {
    for r in rules(lang) {
        if let Some(c) = r.re.captures(line) {
            return Some((r.kind, c.get(r.group)?.as_str().to_string()));
        }
    }
    None
}

pub fn extract(lang: &str, text: &str) -> Vec<Sym> {
    let mut out = Vec::new();
    // GDScript/Python: variables only count at top-level (regex anchors handle gd); for py we skip vars.
    for (i, line) in text.lines().enumerate() {
        if line.len() > 400 {
            continue;
        }
        if let Some((kind, name)) = line_symbol(lang, line) {
            out.push(Sym { name, kind, line: i as u32 + 1 });
        }
    }
    out
}

fn ensure_local(ix: &Index) {
    let files: Vec<String> = {
        let f = ix.files.read().unwrap();
        let mut s = ix.sym.lock().unwrap();
        let todo: Vec<String> = if !s.full {
            s.full = true;
            f.iter().filter(|e| lang_of(&e.rel).is_some()).map(|e| e.rel.clone()).collect()
        } else {
            let d: Vec<String> = s.dirty.drain().collect();
            d
        };
        todo
    };
    if files.is_empty() {
        return;
    }
    ix.sym.lock().unwrap().dirty.clear();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let chunk = (files.len() / threads).max(64);
    let results: Vec<(String, Vec<Sym>)> = std::thread::scope(|s| {
        let hs: Vec<_> = files
            .chunks(chunk)
            .map(|part| {
                s.spawn(move || {
                    part.iter()
                        .filter_map(|rel| {
                            let lang = lang_of(rel)?;
                            let p = format!("{}/{}", ix.root, rel);
                            let md = std::fs::metadata(&p).ok()?;
                            if md.len() > 1_500_000 {
                                return None;
                            }
                            let text = std::fs::read_to_string(&p).ok()?;
                            Some((rel.clone(), extract(lang, &text)))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let mut s = ix.sym.lock().unwrap();
    for (rel, syms) in results {
        s.map.insert(rel, Arc::new(syms));
    }
}

fn ensure_remote(ix: &Index) -> Result<(), String> {
    {
        let s = ix.sym.lock().unwrap();
        if s.remote_at.map(|t| t.elapsed().as_secs() < 60).unwrap_or(false) {
            return Ok(());
        }
    }
    let cmd = format!(
        "cd {} && rg -n --no-heading --hidden -g '*.{{gd,ts,tsx,js,jsx,rs,py,java,kt}}' -g '!.git' -g '!node_modules' -g '!target' -g '!build' -g '!dist' -e '^\\s*(pub(\\([^)]*\\))?\\s+)?(export\\s+)?(default\\s+)?(async\\s+)?(static\\s+)?(abstract\\s+)?(fn|func|def|class|class_name|struct|enum|trait|signal|interface|function|type|mod|fun|object)\\s+\\w' -e '^(const|var|let)\\s+\\w+' 2>/dev/null | head -n 60000",
        ssh::quote(&ix.root)
    );
    let out = ssh::exec_login(&ix.host, &cmd).unwrap_or_default();
    let mut map: std::collections::HashMap<String, Vec<Sym>> = Default::default();
    for l in out.lines() {
        let mut it = l.splitn(3, ':');
        let (Some(p), Some(n), Some(text)) = (it.next(), it.next(), it.next()) else { continue };
        let Some(lang) = lang_of(p) else { continue };
        if let Some((kind, name)) = line_symbol(lang, text) {
            map.entry(p.to_string()).or_default().push(Sym { name, kind, line: n.parse().unwrap_or(1) });
        }
    }
    let mut s = ix.sym.lock().unwrap();
    s.map = map.into_iter().map(|(k, v)| (k, Arc::new(v))).collect();
    s.remote_at = Some(Instant::now());
    Ok(())
}

const CLASS_KINDS: &[&str] = &["class", "interface", "enum", "type", "module"];

pub fn query(ix: &Index, q: &str, classes_only: bool, limit: usize) -> Result<(Vec<SymHit>, f64), String> {
    let t0 = Instant::now();
    if ix.local {
        ensure_local(ix);
    } else {
        ensure_remote(ix)?;
    }
    if q.trim().is_empty() {
        return Ok((vec![], 0.0));
    }
    let pat = Pattern::parse(q.trim(), CaseMatching::Smart, Normalization::Smart);
    let mut m = Matcher::new(Config::DEFAULT);
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, String, Sym)> = Vec::new();
    {
        let s: std::sync::MutexGuard<SymState> = ix.sym.lock().unwrap();
        for (rel, syms) in s.map.iter() {
            for sym in syms.iter() {
                if classes_only && !CLASS_KINDS.contains(&sym.kind) {
                    continue;
                }
                buf.clear();
                if let Some(sc) = pat.score(Utf32Str::new(&sym.name, &mut buf), &mut m) {
                    let sc = sc + if matches!(sym.kind, "class" | "interface" | "enum") { 8 } else { 0 };
                    scored.push((sc, rel.clone(), sym.clone()));
                }
            }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.name.len().cmp(&b.2.name.len())).then(a.1.cmp(&b.1)).then(a.2.line.cmp(&b.2.line)));
    scored.truncate(limit);
    let hits = scored
        .into_iter()
        .map(|(score, rel, sym)| {
            let mut indices = Vec::new();
            buf.clear();
            pat.indices(Utf32Str::new(&sym.name, &mut buf), &mut m, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            SymHit { path: format!("{}/{}", ix.root, rel), rel, name: sym.name, kind: sym.kind, line: sym.line, indices, score }
        })
        .collect();
    Ok((hits, t0.elapsed().as_secs_f64() * 1000.0))
}
