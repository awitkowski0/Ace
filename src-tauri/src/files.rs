//! File-list interop: Finder pasteboard (file URLs), Reveal in Finder, Trash, recursive local copy.
use std::path::Path;
use tauri::AppHandle;

/// Pasteboard used by the file list. Same QA isolation as the terminal clipboard (private board under ACE_AUTOMATION).
#[cfg(target_os = "macos")]
fn pasteboard() -> objc2::rc::Retained<objc2_app_kit::NSPasteboard> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    if crate::appenv::var_os("ACE_AUTOMATION").is_some() {
        NSPasteboard::pasteboardWithName(&NSString::from_str("ace-qa-files"))
    } else {
        NSPasteboard::generalPasteboard()
    }
}

/// AppKit pasteboard / workspace calls are made on the main thread.
#[cfg(target_os = "macos")]
fn main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    crate::windows::on_main(app, f).ok_or_else(|| "main thread unavailable".to_string())
}

/// Windows: the file list lives in the Windows clipboard (CF_HDROP) and the Recycle Bin. Both go through Windows
/// PowerShell, so no COM/Win32 bindings are needed. The script travels as `-EncodedCommand` (no quoting to get wrong)
/// and user data only ever travels in env vars or stdin, never inside the script text. No console window is shown.
#[cfg(windows)]
pub(crate) fn powershell(script: &str, env: &[(&str, &str)], stdin: Option<&str>) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;
    use std::process::{Command, Stdio};
    // UTF-8 goes through raw std streams, so the console code page never mangles Unicode paths or text.
    const PRELUDE: &str = r#"$ErrorActionPreference='Stop';
function Out-Utf8([string]$t){$b=[Text.Encoding]::UTF8.GetBytes($t);$s=[Console]::OpenStandardOutput();$s.Write($b,0,$b.Length);$s.Flush()}
function Err-Utf8([string]$t){$b=[Text.Encoding]::UTF8.GetBytes($t);$s=[Console]::OpenStandardError();$s.Write($b,0,$b.Length);$s.Flush()}
function In-Utf8{$r=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8);$r.ReadToEnd()}
"#;
    let full = format!("{PRELUDE}{script}");
    let utf16: Vec<u8> = full.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]).arg(base64::engine::general_purpose::STANDARD.encode(utf16));
    cmd.envs(env.iter().copied());
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = crate::platform::no_window(&mut cmd).spawn().map_err(|e| e.to_string())?;
    if let Some(text) = stdin {
        if let Some(mut input) = child.stdin.take() {
            input.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "powershell failed".to_string() } else { err })
    }
}

/// Windows file-list clipboard under ACE_AUTOMATION: a process-private slot, so QA never touches the real clipboard.
#[cfg(windows)]
static QA_FILES: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());

/// Paths are joined with LF for the env var (a Windows path cannot contain a control character).
#[cfg(windows)]
fn joined(paths: &[String]) -> String {
    paths.join("\n")
}

/// Put file URLs on the pasteboard (Finder can ⌘V them; text targets get the paths).
#[tauri::command]
pub fn files_clipboard_write(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = &app;
        if crate::appenv::var_os("ACE_AUTOMATION").is_some() {
            *QA_FILES.lock() = paths;
            return Ok(());
        }
        // SetFileDropList puts real file references on the clipboard (Ctrl+V in Explorer pastes them). Set-Clipboard -Path
        // would copy the files' contents as text instead.
        return powershell(
            r#"Add-Type -AssemblyName System.Windows.Forms;
$list=New-Object System.Collections.Specialized.StringCollection;
foreach($p in $env:ACE_PATHS.Split([char]10)){ if($p -ne ''){ [void]$list.Add($p) } }
if($list.Count -gt 0){ [System.Windows.Forms.Clipboard]::SetFileDropList($list) } else { [System.Windows.Forms.Clipboard]::Clear() }"#,
            &[("ACE_PATHS", &joined(&paths))],
            None,
        )
        .map(|_| ());
    }
    #[cfg(target_os = "macos")]
    {
        return main(&app, move || {
            use objc2::runtime::ProtocolObject;
            use objc2_app_kit::NSPasteboardWriting;
            use objc2_foundation::{NSArray, NSString, NSURL};
            let urls: Vec<_> = paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(p))).collect();
            let objs: Vec<_> = urls.iter().map(|u| ProtocolObject::<dyn NSPasteboardWriting>::from_ref(&**u)).collect();
            let pb = pasteboard();
            pb.clearContents();
            if pb.writeObjects(&NSArray::from_slice(&objs)) { Ok(()) } else { Err("pasteboard write failed".to_string()) }
        })?;
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, paths);
        Err("file clipboard unsupported".into())
    }
}

/// File paths currently on the pasteboard (e.g. copied in Finder); empty when it holds no file URLs.
#[tauri::command]
pub fn files_clipboard_read(app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let _ = &app;
        if crate::appenv::var_os("ACE_AUTOMATION").is_some() {
            return Ok(QA_FILES.lock().clone());
        }
        return powershell(
            r#"Add-Type -AssemblyName System.Windows.Forms;
$names=@(Get-Clipboard -Format FileDropList | ForEach-Object { if($_ -is [string]){ $_ } else { $_.FullName } });
Out-Utf8 ($names -join "`n")"#,
            &[],
            None,
        )
        .map(|out| out.lines().filter(|l| !l.is_empty()).map(str::to_string).collect());
    }
    #[cfg(target_os = "macos")]
    {
        return main(&app, || {
            use objc2_foundation::{NSString, NSURL};
            let ty = NSString::from_str("public.file-url");
            let Some(items) = pasteboard().pasteboardItems() else { return vec![] };
            items
                .iter()
                .filter_map(|it| it.stringForType(&ty))
                .filter_map(|s| NSURL::URLWithString(&s))
                .filter(|u| u.isFileURL())
                .filter_map(|u| u.path().map(|p| p.to_string()))
                .collect()
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        Ok(vec![])
    }
}

/// Select the paths in a Finder window (NSWorkspace.activateFileViewerSelectingURLs).
#[tauri::command]
pub fn files_reveal(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if crate::appenv::var_os("ACE_AUTOMATION").is_some() {
        return Ok(()); // never pop Finder windows during QA
    }
    #[cfg(target_os = "macos")]
    {
        return main(&app, move || {
            use objc2_foundation::{NSArray, NSString, NSURL};
            use objc2_app_kit::NSWorkspace;
            let urls: Vec<_> = paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(p))).collect();
            NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&urls));
        });
    }
    #[cfg(windows)]
    {
        let _ = (&app, &paths);
        // `/select,"<path>"` must reach explorer verbatim, so raw_arg (no Rust argv quoting). Explorer exits 1 even on
        // success, so only a failed spawn counts as an error.
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        cmd.raw_arg(format!("/select,\"{}\"", paths[0]));
        return crate::platform::no_window(&mut cmd).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        std::process::Command::new("open").arg("-R").arg(&paths[0]).status().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Open with the default app (macOS: `open <path>`; Windows: the opener plugin's ShellExecute).
#[tauri::command]
pub fn files_open(app: AppHandle, path: String) -> Result<(), String> {
    if crate::appenv::var_os("ACE_AUTOMATION").is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        return app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        std::process::Command::new("open").arg(&path).status().map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err(format!("open failed: {path}")) })
    }
}

/// Move local files/folders to the Trash.
#[tauri::command]
pub fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    return trash_windows(&paths);
    #[cfg(not(windows))]
    {
        for p in &paths {
            trash_one(p)?;
        }
        Ok(())
    }
}

/// Recycle Bin via Microsoft.VisualBasic.FileIO (the same SendToRecycleBin the shell uses). Paths go in one env var;
/// the first failing path stops the batch and its name is reported, as with the macOS loop.
#[cfg(windows)]
fn trash_windows(paths: &[String]) -> Result<(), String> {
    powershell(
        r#"Add-Type -AssemblyName Microsoft.VisualBasic;
foreach($p in $env:ACE_PATHS.Split([char]10)){
  if($p -eq ''){ continue }
  try {
    if((Get-Item -LiteralPath $p -Force).PSIsContainer){ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }
  } catch { Err-Utf8 ($p + ': ' + $_.Exception.Message); exit 1 }
}"#,
        &[("ACE_PATHS", &joined(paths))],
        None,
    )
    .map(|_| ())
}

#[cfg_attr(windows, allow(dead_code))]
fn trash_one(p: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(p));
        return NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| format!("{p}: {}", e.localizedDescription()));
    }
    #[allow(unreachable_code)]
    {
        let m = std::fs::symlink_metadata(p).map_err(|e| format!("{p}: {e}"))?;
        if m.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| format!("{p}: {e}"))
    }
}

/// Recursive copy that never overwrites: errors if `to` exists, or if `to` lies inside `from`. Symlinks are copied as links.
pub fn copy_recursive(from: &Path, to: &Path) -> Result<(), String> {
    let e = |p: &Path, x: std::io::Error| format!("{}: {x}", p.display());
    if to.symlink_metadata().is_ok() {
        return Err(format!("{}: already exists", to.display()));
    }
    let m = std::fs::symlink_metadata(from).map_err(|x| e(from, x))?;
    if m.is_dir() {
        if to.starts_with(from) {
            return Err(format!("Cannot copy {} into itself", from.display()));
        }
        std::fs::create_dir(to).map_err(|x| e(to, x))?;
        for ent in std::fs::read_dir(from).map_err(|x| e(from, x))? {
            let ent = ent.map_err(|x| e(from, x))?;
            copy_recursive(&ent.path(), &to.join(ent.file_name()))?;
        }
        let _ = std::fs::set_permissions(to, m.permissions());
        Ok(())
    } else if m.file_type().is_symlink() {
        #[cfg_attr(not(unix), allow(unused_variables))]
        let target = std::fs::read_link(from).map_err(|x| e(from, x))?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, to).map_err(|x| e(to, x));
        #[allow(unreachable_code)]
        Err("symlink copy unsupported".into())
    } else {
        std::fs::copy(from, to).map(|_| ()).map_err(|x| e(to, x))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ace-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copies_tree_without_overwrite() {
        let d = tmp("copy");
        std::fs::create_dir_all(d.join("a/sub")).unwrap();
        std::fs::write(d.join("a/f.txt"), "hi").unwrap();
        std::fs::write(d.join("a/sub/g.txt"), "yo").unwrap();
        copy_recursive(&d.join("a"), &d.join("b")).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("b/f.txt")).unwrap(), "hi");
        assert_eq!(std::fs::read_to_string(d.join("b/sub/g.txt")).unwrap(), "yo");
        assert!(copy_recursive(&d.join("a"), &d.join("b")).unwrap_err().contains("already exists"));
        assert!(d.join("a/f.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_copy_into_self_and_copies_symlinks() {
        let d = tmp("self");
        std::fs::create_dir_all(d.join("a")).unwrap();
        assert!(copy_recursive(&d.join("a"), &d.join("a/inner")).unwrap_err().contains("itself"));
        std::fs::write(d.join("a/f"), "x").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("f", d.join("a/l")).unwrap();
            copy_recursive(&d.join("a"), &d.join("c")).unwrap();
            assert!(std::fs::symlink_metadata(d.join("c/l")).unwrap().file_type().is_symlink());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
