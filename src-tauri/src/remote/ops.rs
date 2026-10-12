//! Remote filesystem operations over the multiplexed ssh connection (one round trip each).
use super::{read_all, run, spawn_tracked, ssh};
use crate::fs::{DirEntry, FileStat, FsResult};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_READ: usize = 10 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// numeric permission bits (e.g. 0o755 = 493)
    pub mode: u32,
}

type Key = (String, String);
fn cache() -> &'static Mutex<HashMap<Key, (Instant, Vec<RichEntry>)>> {
    static C: OnceLock<Mutex<HashMap<Key, (Instant, Vec<RichEntry>)>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

pub fn parent(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].to_string(),
    }
}
fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// Drop cached listings affected by a write at `path`.
pub fn invalidate(host: &str, path: &str) {
    let mut c = cache().lock().unwrap();
    c.remove(&(host.to_string(), parent(path)));
    c.remove(&(host.to_string(), path.trim_end_matches('/').to_string()));
}

/// Remote `~`/relative path expansion: paths starting with `~` are resolved by the remote shell.
fn qp(p: &str) -> String {
    if p == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("\"$HOME\"/{}", ssh::quote(rest))
    } else {
        ssh::quote(p)
    }
}

pub fn list_rich(host: &str, path: &str) -> FsResult<Vec<RichEntry>> {
    let key = (host.to_string(), path.trim_end_matches('/').to_string());
    if let Some((t, v)) = cache().lock().unwrap().get(&key) {
        if t.elapsed() < CACHE_TTL {
            return Ok(v.clone());
        }
    }
    let dir = if path.is_empty() { "/" } else { path };
    let script = format!(
        "find -H {} -mindepth 1 -maxdepth 1 -printf '%y%Y\\t%s\\t%T@\\t%m\\t%f\\0'",
        qp(dir)
    );
    let out = run(host, &script)?;
    let base = dir.to_string();
    let mut v: Vec<RichEntry> = out
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let s = String::from_utf8_lossy(rec);
            let mut it = s.splitn(5, '\t');
            let ty = it.next()?;
            let size = it.next()?.parse::<u64>().ok()?;
            let mt = it.next()?.parse::<f64>().ok()?;
            let mode = u32::from_str_radix(it.next()?, 8).unwrap_or(0);
            let name = it.next()?.to_string();
            let b = ty.as_bytes();
            Some(RichEntry {
                path: join(&base, &name),
                name,
                is_dir: b.get(1) == Some(&b'd'),
                is_symlink: b.first() == Some(&b'l'),
                size,
                modified: Some((mt * 1000.0) as u64),
                mode,
            })
        })
        .collect();
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    super::watch::touch_hot(host, &key.1);
    cache().lock().unwrap().insert(key, (Instant::now(), v.clone()));
    Ok(v)
}

pub fn list_dir(host: &str, path: &str) -> FsResult<Vec<DirEntry>> {
    Ok(list_rich(host, path)?
        .into_iter()
        .map(|e| DirEntry { name: e.name, path: e.path, is_dir: e.is_dir, is_symlink: e.is_symlink, size: e.size, modified: e.modified })
        .collect())
}

pub fn read_file(host: &str, path: &str) -> FsResult<String> {
    let bytes = run(host, &format!("head -c {} -- {}", MAX_READ + 1, qp(path)))?;
    if bytes.len() > MAX_READ {
        return Err(format!("{path}: file larger than {} MB", MAX_READ / 1024 / 1024));
    }
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(format!("{path}: binary file"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write_file(host: &str, path: &str, contents: &str) -> FsResult<()> {
    // Resolve symlinks, keep mode, write to a sibling temp file then rename over the target.
    let script = format!(
        "p=$(readlink -f -- {p} 2>/dev/null || printf %s {p}); t=\"$p.atelier-tmp.$$\"; \
         if cat > \"$t\"; then m=$(stat -c %a -- \"$p\" 2>/dev/null); [ -n \"$m\" ] && chmod \"$m\" \"$t\"; mv -f -- \"$t\" \"$p\"; \
         else rm -f -- \"$t\"; exit 1; fi",
        p = qp(path)
    );
    let mut cmd = ssh::command(host, false);
    cmd.arg(script).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let (mut child, id) = spawn_tracked(cmd, "ssh", &format!("write {host}:{path}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let data = contents.as_bytes().to_vec();
    // write from a thread so a failing remote can't deadlock us on a full pipe
    let w = std::thread::spawn(move || {
        let r = stdin.write_all(&data);
        drop(stdin);
        r
    });
    let err = read_all(child.stderr.take());
    let st = child.wait().map_err(|e| e.to_string());
    crate::procs::unregister(id);
    let _ = w.join();
    invalidate(host, path);
    if st?.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&err).trim().to_string())
    }
}

pub fn stat(host: &str, path: &str) -> FsResult<FileStat> {
    let script = format!(
        "p={p}; if [ -L \"$p\" ]; then printf 'L '; else printf 'N '; fi; stat -L -c '%F|%s|%Y' -- \"$p\" 2>/dev/null || echo MISSING",
        p = qp(path)
    );
    let out = String::from_utf8_lossy(&run(host, &script)?).trim().to_string();
    let (l, rest) = out.split_once(' ').unwrap_or(("N", &out));
    if rest == "MISSING" {
        return Ok(FileStat { exists: false, is_dir: false, is_file: false, is_symlink: l == "L", size: 0, modified: None });
    }
    let mut it = rest.split('|');
    let kind = it.next().unwrap_or("");
    let size = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mt = it.next().and_then(|s| s.parse::<u64>().ok()).map(|s| s * 1000);
    Ok(FileStat {
        exists: true,
        is_dir: kind == "directory",
        is_file: kind.contains("file"),
        is_symlink: l == "L",
        size,
        modified: mt,
    })
}

pub fn rename(host: &str, from: &str, to: &str) -> FsResult<()> {
    let script = format!(
        "if [ -e {t} ] || [ -L {t} ]; then echo 'target already exists' >&2; exit 1; fi; mv -- {f} {t}",
        f = qp(from),
        t = qp(to)
    );
    let r = run(host, &script).map(|_| ());
    invalidate(host, from);
    invalidate(host, to);
    r
}

pub fn copy(host: &str, from: &str, to: &str) -> FsResult<()> {
    let script = format!(
        "if [ -e {t} ] || [ -L {t} ]; then echo 'target already exists' >&2; exit 1; fi; cp -R -P -- {f} {t}",
        f = qp(from),
        t = qp(to)
    );
    let r = run(host, &script).map(|_| ());
    invalidate(host, to);
    r
}

pub fn delete(host: &str, path: &str) -> FsResult<()> {
    let t = path.trim_end_matches('/');
    if t.is_empty() || t == "~" || t.matches('/').count() < 2 && t.starts_with('/') {
        return Err(format!("refusing to delete {path}"));
    }
    let script = format!(
        "p={p}; r=$(readlink -f -- \"$p\" 2>/dev/null); if [ \"$p\" = \"$HOME\" ] || [ \"$r\" = \"$HOME\" ] || [ \"$r\" = / ]; then echo 'refusing to delete home or root' >&2; exit 1; fi; rm -rf -- \"$p\"",
        p = qp(t)
    );
    let r = run(host, &script).map(|_| ());
    invalidate(host, path);
    r
}

pub fn create_dir(host: &str, path: &str) -> FsResult<()> {
    let r = run(host, &format!("mkdir -p -- {}", qp(path))).map(|_| ());
    invalidate(host, path);
    r
}

pub fn home(host: &str) -> FsResult<String> {
    Ok(String::from_utf8_lossy(&run(host, "printf %s \"$HOME\"")?).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    #[test]
    #[ignore]
    fn live_mc() {
        let h = "mc";
        let t = Instant::now();
        let home = home(h).unwrap();
        println!("home {home} (cold {:?})", t.elapsed());
        let t = Instant::now();
        let l = list_rich(h, &home).unwrap();
        println!("list_dir {} entries {:?}", l.len(), t.elapsed());
        invalidate(h, &format!("{home}/x"));
        let t = Instant::now();
        list_rich(h, &home).unwrap();
        println!("list_dir warm {:?}", t.elapsed());
        let d = "/tmp/atelier-test-unit";
        create_dir(h, d).unwrap();
        let f = format!("{d}/a b'c.txt");
        let t = Instant::now();
        write_file(h, &f, "héllo\nworld\n").unwrap();
        println!("write {:?}", t.elapsed());
        let t = Instant::now();
        assert_eq!(read_file(h, &f).unwrap(), "héllo\nworld\n");
        println!("read {:?}", t.elapsed());
        println!("stat {:?}", stat(h, &f).unwrap());
        println!("stat missing {:?}", stat(h, &format!("{d}/nope")).unwrap());
        rename(h, &f, &format!("{d}/b.txt")).unwrap();
        assert_eq!(list_dir(h, d).unwrap().len(), 1);
        assert!(delete(h, "/tmp").is_err());
        delete(h, d).unwrap();
        assert!(!stat(h, d).unwrap().exists);
    }
}
