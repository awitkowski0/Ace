//! One-time startup migration from the pre-rename "Atelier" locations to the "Ace" ones (bundle id `com.alexw.atelier` ->
//! `com.alexw.ace`, binary `atelier` -> `ace`). Runs BEFORE anything reads app data and before the webview exists.
//!
//! Strictly COPY: the old directories are never moved, modified or deleted (so the old app / a rollback still works).
//! A pre-existing new directory (only ever QA/test leftovers, see `copy_dir_if_absent`) is renamed aside, not overwritten. A marker file in the new data dir makes the whole thing
//! run once. What moves:
//!   * `<data dir>/com.alexw.atelier` (run configs, breakpoints, session.json, ui-prefs.json, gradle, projects ...) -> `com.alexw.ace`
//!   * `<cache dir>/atelier` (Claude session cache, jdtls) -> `ace`, and `<cache dir>/com.alexw.atelier` -> `com.alexw.ace`
//!   * macOS WKWebView website data (localStorage, IndexedDB): `~/Library/WebKit/com.alexw.atelier` (bundled app, keyed by bundle
//!     id) and `~/Library/WebKit/atelier` (unbundled binary, keyed by process name) -> `com.alexw.ace` / `ace`. WebKit names the
//!     per-origin folders with a hash salted by the `Default/salt` file inside the same tree, so copying the tree as a whole keeps
//!     every folder resolvable. The frontend additionally copies `atelier.*` localStorage keys to `ace.*` (src/lib/migrateStorage.ts).
//!   * Windows: WebView2 profile under `%LOCALAPPDATA%\com.alexw.atelier`.
//! Skipped entirely under QA automation / an explicit data dir (harness runs use scratch dirs).
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MARKER: &str = ".migrated-from-atelier";
/// Top-level entries never copied: the process registry holds pids of the OLD app's children.
const SKIP: &[&str] = &["procs"];

/// Recursively copy `old` to `new`; returns whether a copy happened (false if `old` is not a directory).
/// Copies into `<new>.partial` first and renames, so an interrupted copy never leaves a half-filled `new`.
///
/// If `new` already exists it was created before the first real run of the renamed app (the marker is not written yet), i.e. by
/// QA-harness / test runs of the new binary, which create `procs/` and the unbundled-binary WebKit store. Such a leftover would
/// otherwise make the migration silently skip the user's data (and WebKit would keep its own salt), so it is renamed aside to
/// `<new>.pre-migration[-N]` (nothing is deleted) and the old data takes its place.
pub fn copy_dir_if_absent(old: &Path, new: &Path) -> io::Result<bool> {
    if !old.is_dir() {
        return Ok(false);
    }
    let suffixed = |tail: &str| {
        let mut p = new.as_os_str().to_owned();
        p.push(tail);
        PathBuf::from(p)
    };
    let partial = suffixed(".partial");
    if partial.exists() {
        fs::remove_dir_all(&partial)?; // our own leftover from an interrupted run
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_tree(old, &partial, true)?;
    if new.exists() {
        let mut aside = suffixed(".pre-migration");
        let mut n = 1;
        while aside.exists() {
            n += 1;
            aside = suffixed(&format!(".pre-migration-{n}"));
        }
        fs::rename(new, &aside)?;
    }
    fs::rename(&partial, new)?;
    Ok(true)
}

fn copy_tree(from: &Path, to: &Path, top: bool) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if top && SKIP.iter().any(|s| name == std::ffi::OsStr::new(s)) {
            continue;
        }
        let ty = entry.file_type()?;
        let dest = to.join(&name);
        if ty.is_dir() {
            copy_tree(&entry.path(), &dest, false)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &dest)?;
        } // symlinks, sockets, fifos: not data worth carrying over
    }
    Ok(())
}

/// Copy every `(old, new)` pair, then write the marker. No-op if the marker exists. Returns how many dirs were copied.
pub fn migrate(pairs: &[(PathBuf, PathBuf)], marker: &Path) -> usize {
    if marker.exists() {
        return 0;
    }
    let mut copied = 0;
    for (old, new) in pairs {
        match copy_dir_if_absent(old, new) {
            Ok(true) => copied += 1,
            Ok(false) => {}
            Err(e) => eprintln!("ace: migrating {} -> {} failed: {e}", old.display(), new.display()),
        }
    }
    if let Some(parent) = marker.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(marker, "copied from the pre-rename Atelier directories; the originals were left in place\n");
    copied
}

fn pairs() -> Vec<(PathBuf, PathBuf)> {
    let mut v: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut add = |base: Option<PathBuf>, old: &str, new: &str| {
        if let Some(b) = base {
            let p = (b.join(old), b.join(new));
            if !v.contains(&p) {
                v.push(p);
            }
        }
    };
    add(dirs::data_dir(), "com.alexw.atelier", "com.alexw.ace");
    add(dirs::data_local_dir(), "com.alexw.atelier", "com.alexw.ace"); // Windows WebView2 / Linux (same as data_dir)
    add(dirs::cache_dir(), "atelier", "ace");
    add(dirs::cache_dir(), "com.alexw.atelier", "com.alexw.ace");
    if cfg!(target_os = "macos") {
        if let Some(h) = dirs::home_dir() {
            add(Some(h.join("Library/WebKit")), "com.alexw.atelier", "com.alexw.ace");
            add(Some(h.join("Library/WebKit")), "atelier", "ace");
        }
    }
    v
}

/// Call first thing in `run()`.
pub fn run() {
    if crate::appenv::var_os("ACE_DATA_DIR").is_some() || crate::appenv::var_os("ACE_AUTOMATION").is_some() {
        return;
    }
    let Some(data) = dirs::data_dir() else { return };
    migrate(&pairs(), &data.join("com.alexw.ace").join(MARKER));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ace-migrate-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(old: &Path) {
        fs::create_dir_all(old.join("projects/abc")).unwrap();
        fs::create_dir_all(old.join("procs")).unwrap();
        fs::write(old.join("session.json"), "S").unwrap();
        fs::write(old.join("projects/abc/runs.json"), "R").unwrap();
        fs::write(old.join("procs/123"), "pid").unwrap();
    }

    #[test]
    fn copies_tree_keeps_source_and_skips_procs() {
        let t = tmp("copy");
        let (old, new) = (t.join("com.alexw.atelier"), t.join("com.alexw.ace"));
        seed(&old);
        assert!(copy_dir_if_absent(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "S");
        assert_eq!(fs::read_to_string(new.join("projects/abc/runs.json")).unwrap(), "R");
        assert!(!new.join("procs").exists());
        assert!(old.join("session.json").exists() && old.join("procs/123").exists(), "source untouched");
        assert!(!t.join("com.alexw.ace.partial").exists());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn existing_destination_is_renamed_aside_not_overwritten_or_deleted() {
        let t = tmp("noover");
        let (old, new) = (t.join("old"), t.join("new"));
        seed(&old);
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("session.json"), "NEW").unwrap();
        assert!(copy_dir_if_absent(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("session.json")).unwrap(), "S");
        assert_eq!(fs::read_to_string(t.join("new.pre-migration/session.json")).unwrap(), "NEW");
        assert!(old.join("session.json").exists());
        assert!(!copy_dir_if_absent(&t.join("missing"), &t.join("dest")).unwrap());
        assert!(!t.join("dest").exists());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn runs_once_via_marker() {
        let t = tmp("marker");
        let (old, new) = (t.join("old"), t.join("new"));
        seed(&old);
        let marker = new.join(MARKER);
        let pairs = vec![(old.clone(), new.clone())];
        assert_eq!(migrate(&pairs, &marker), 1);
        assert!(marker.exists());
        // A later change to the old dir, and a deleted new dir content, must not trigger another copy.
        fs::remove_file(new.join("session.json")).unwrap();
        assert_eq!(migrate(&pairs, &marker), 0);
        assert!(!new.join("session.json").exists());
        let _ = fs::remove_dir_all(&t);
    }

    #[test]
    fn interrupted_partial_is_replaced() {
        let t = tmp("partial");
        let (old, new) = (t.join("old"), t.join("new"));
        seed(&old);
        fs::create_dir_all(t.join("new.partial")).unwrap();
        fs::write(t.join("new.partial/junk"), "x").unwrap();
        assert!(copy_dir_if_absent(&old, &new).unwrap());
        assert!(new.join("session.json").exists() && !new.join("junk").exists());
        let _ = fs::remove_dir_all(&t);
    }
}
