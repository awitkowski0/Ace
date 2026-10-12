use super::*;
use std::fs;
use std::time::UNIX_EPOCH;

pub struct LocalBackend;

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}
fn e<T: std::fmt::Display>(path: &str, err: T) -> String {
    format!("{path}: {err}")
}

impl FsBackend for LocalBackend {
    fn list_dir(&self, path: &str) -> FsResult<Vec<DirEntry>> {
        let mut out = Vec::new();
        for ent in fs::read_dir(path).map_err(|x| e(path, x))? {
            let ent = ent.map_err(|x| e(path, x))?;
            let p = ent.path();
            let lmeta = fs::symlink_metadata(&p).ok();
            let is_symlink = lmeta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
            // follow symlinks for dir-ness
            let meta = fs::metadata(&p).ok().or(lmeta);
            out.push(DirEntry {
                name: ent.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                is_symlink,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| ms(m.modified())),
            });
        }
        Ok(out)
    }
    fn read_file(&self, path: &str) -> FsResult<String> {
        let bytes = fs::read(path).map_err(|x| e(path, x))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
    fn write_file(&self, path: &str, contents: &str) -> FsResult<()> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|x| e(path, x))?;
            }
        }
        fs::write(path, contents).map_err(|x| e(path, x))
    }
    fn stat(&self, path: &str) -> FsResult<FileStat> {
        let lmeta = fs::symlink_metadata(path);
        match fs::metadata(path) {
            Ok(m) => Ok(FileStat {
                exists: true,
                is_dir: m.is_dir(),
                is_file: m.is_file(),
                is_symlink: lmeta.map(|l| l.file_type().is_symlink()).unwrap_or(false),
                size: m.len(),
                modified: ms(m.modified()),
            }),
            Err(_) => Ok(FileStat { exists: false, is_dir: false, is_file: false, is_symlink: false, size: 0, modified: None }),
        }
    }
    fn rename(&self, from: &str, to: &str) -> FsResult<()> {
        fs::rename(from, to).map_err(|x| e(from, x))
    }
    fn delete(&self, path: &str) -> FsResult<()> {
        let m = fs::symlink_metadata(path).map_err(|x| e(path, x))?;
        if m.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|x| e(path, x))
    }
    fn create_dir(&self, path: &str) -> FsResult<()> {
        fs::create_dir_all(path).map_err(|x| e(path, x))
    }
    fn copy(&self, from: &str, to: &str) -> FsResult<()> {
        crate::files::copy_recursive(std::path::Path::new(from), std::path::Path::new(to))
    }
}
