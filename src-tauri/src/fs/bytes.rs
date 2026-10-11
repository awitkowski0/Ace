//! Binary file access for the editor's non-text viewers (images, audio, 3D, archives, ...).
//! Bytes travel as a raw `tauri::ipc::Response` (an ArrayBuffer on the JS side): no base64, no JSON number arrays.
use super::FsResult;
use crate::location::Location;
use crate::remote::{run, ssh};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use tauri::ipc::Response;

/// Hard cap for one read (viewers apply their own, lower, guards first).
pub const MAX_BYTES: u64 = 512 * 1024 * 1024;

fn qp(p: &str) -> String {
    if p == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("\"$HOME\"/{}", ssh::quote(rest))
    } else {
        ssh::quote(p)
    }
}

pub fn read_bytes(loc: &Location, offset: u64, len: Option<u64>) -> FsResult<Vec<u8>> {
    let want = len.unwrap_or(MAX_BYTES).min(MAX_BYTES);
    if loc.host == "local" || loc.host.is_empty() {
        let mut f = std::fs::File::open(&loc.path).map_err(|e| format!("{}: {e}", loc.path))?;
        if offset > 0 {
            f.seek(SeekFrom::Start(offset)).map_err(|e| format!("{}: {e}", loc.path))?;
        }
        let mut v = Vec::new();
        f.take(want + 1).read_to_end(&mut v).map_err(|e| format!("{}: {e}", loc.path))?;
        if len.is_none() && v.len() as u64 > want {
            return Err(format!("{}: file larger than {} MB", loc.path, MAX_BYTES / 1024 / 1024));
        }
        v.truncate(want as usize);
        Ok(v)
    } else {
        let p = qp(&loc.path);
        let script = if offset > 0 {
            format!("tail -c +{} -- {p} | head -c {}", offset + 1, want + 1)
        } else {
            format!("head -c {} -- {p}", want + 1)
        };
        let mut v = run(&loc.host, &script)?;
        if len.is_none() && v.len() as u64 > want {
            return Err(format!("{}: file larger than {} MB", loc.path, MAX_BYTES / 1024 / 1024));
        }
        v.truncate(want as usize);
        Ok(v)
    }
}

/// Raw bytes of a file (or of the `[offset, offset+len)` range).
#[tauri::command]
pub async fn fs_read_bytes(loc: Location, offset: Option<u64>, len: Option<u64>) -> FsResult<Response> {
    tauri::async_runtime::spawn_blocking(move || read_bytes(&loc, offset.unwrap_or(0), len).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub size: u64,
    /// NUL bytes or invalid UTF-8 in the first 8 KB
    pub binary: bool,
    pub modified: Option<u64>,
}

fn looks_binary(head: &[u8]) -> bool {
    if head.contains(&0) {
        return true;
    }
    match std::str::from_utf8(head) {
        Ok(_) => false,
        // a multibyte sequence cut by the 8 KB window is fine
        Err(e) => e.error_len().is_some(),
    }
}

/// Size + binary sniff, used to decide between Monaco, a viewer, the "binary file" placeholder and the too-large guard.
#[tauri::command]
pub async fn fs_probe(loc: Location) -> FsResult<Probe> {
    tauri::async_runtime::spawn_blocking(move || {
        if loc.host == "local" || loc.host.is_empty() {
            let m = std::fs::metadata(&loc.path).map_err(|e| format!("{}: {e}", loc.path))?;
            let mut head = Vec::new();
            std::fs::File::open(&loc.path)
                .and_then(|f| f.take(8192).read_to_end(&mut head))
                .map_err(|e| format!("{}: {e}", loc.path))?;
            let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
            Ok(Probe { size: m.len(), binary: looks_binary(&head), modified })
        } else {
            let p = qp(&loc.path);
            let out = run(&loc.host, &format!("stat -c %s -- {p} && head -c 8192 -- {p}"))?;
            let nl = out.iter().position(|b| *b == b'\n').ok_or("probe: bad reply")?;
            let size = String::from_utf8_lossy(&out[..nl]).trim().parse::<u64>().map_err(|e| e.to_string())?;
            Ok(Probe { size, binary: looks_binary(&out[nl + 1..]), modified: None })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
