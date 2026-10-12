//! OS seam for the few Unix-only calls the backend makes (signals, process groups, uid, file modes, exit signals).
//! Callers use these instead of `libc::*` / `std::os::unix::*` so the crate also builds for Windows
//! (`scripts/win/check.sh`). macOS behaviour is unchanged: every unix arm is the call it replaces.

use std::process::{Command, ExitStatus};

/// The signals the backend sends. On Windows, Term/Kill both end the process tree (`taskkill /T`, forced for Kill);
/// Stop/Cont are no-ops (there is no portable suspend) and report `false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
    Stop,
    Cont,
    Int,
    Hup,
}

#[cfg(unix)]
fn raw(s: Sig) -> i32 {
    match s {
        Sig::Term => libc::SIGTERM,
        Sig::Kill => libc::SIGKILL,
        Sig::Stop => libc::SIGSTOP,
        Sig::Cont => libc::SIGCONT,
        Sig::Int => libc::SIGINT,
        Sig::Hup => libc::SIGHUP,
    }
}

/// `kill(pid, sig)`. Returns true when the signal was delivered.
pub fn signal_pid(pid: u32, s: Sig) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, raw(s)) == 0 }
    }
    #[cfg(windows)]
    {
        windows_end(pid, s, false)
    }
}

/// `killpg(pgid, sig)`: the whole process group led by `pgid`. On Windows: the process tree rooted at `pgid`.
pub fn signal_group(pgid: u32, s: Sig) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::killpg(pgid as i32, raw(s)) == 0 }
    }
    #[cfg(windows)]
    {
        windows_end(pgid, s, true)
    }
}

#[cfg(windows)]
fn windows_end(pid: u32, s: Sig, tree: bool) -> bool {
    use std::os::windows::process::CommandExt;
    if matches!(s, Sig::Stop | Sig::Cont) {
        return false;
    }
    let mut c = Command::new("taskkill");
    c.arg("/PID").arg(pid.to_string());
    if tree {
        c.arg("/T");
    }
    // Term/Int/Hup without /F only posts WM_CLOSE, which console children (java, node, python) ignore: force always.
    c.arg("/F");
    c.creation_flags(CREATE_NO_WINDOW);
    c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    c.status().map(|st| st.success()).unwrap_or(false)
}

/// Is `pid` alive (`kill(pid, 0)`)?
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
        sys.process(p).is_some()
    }
}

/// Our own process group id (`getpgrp`). Windows has no groups: our pid.
pub fn own_group() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getpgrp() as u32 }
    }
    #[cfg(windows)]
    {
        std::process::id()
    }
}

/// Is `pid` the leader of its own process group (`getpgid(pid) == pid`)? Windows: always false.
pub fn is_group_leader(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::getpgid(pid as i32) == pid as i32 }
    }
    #[cfg(windows)]
    {
        let _ = pid;
        false
    }
}

/// Start the child in its own process group so the group can be signalled as one (`process_group(0)`).
/// Windows: a new process group with no console window.
pub fn new_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
    }
}

/// Hide the console window a GUI app's child would otherwise flash on Windows. No-op on unix.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A stable per-user tag for socket/temp names (`getuid()` on unix; the sanitized user name on Windows).
pub fn user_tag() -> String {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }.to_string()
    }
    #[cfg(windows)]
    {
        std::env::var("USERNAME").unwrap_or_else(|_| "user".into()).chars().filter(|c| c.is_ascii_alphanumeric()).collect()
    }
}

/// The signal that ended the process, if any (`ExitStatusExt::signal`). Windows: never.
pub fn exit_signal(st: &ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        st.signal()
    }
    #[cfg(windows)]
    {
        let _ = st;
        None
    }
}

/// The program to spawn for a bare command name. Unix: the name unchanged (the OS resolves it on PATH).
/// Windows: `CreateProcess` only finds `.exe`, so a name without an extension is looked up on PATH (see `resolve_program_in`).
pub fn resolve_program(name: &str) -> std::path::PathBuf {
    resolve_program_in(name, None)
}

/// `resolve_program`, also searching `cwd` first on Windows (where a `.cmd` next to the project is found too).
pub fn resolve_program_in(name: &str, cwd: Option<&std::path::Path>) -> std::path::PathBuf {
    resolve_program_on(name, cwd, &std::env::var_os("PATH").unwrap_or_default())
}

/// `resolve_program_in` with an explicit search PATH (the PATH a child will get, e.g. a venv's bin dir in front).
pub fn resolve_program_on(name: &str, cwd: Option<&std::path::Path>, path: &std::ffi::OsStr) -> std::path::PathBuf {
    #[cfg(unix)]
    {
        let _ = (cwd, path);
        std::path::PathBuf::from(name)
    }
    #[cfg(windows)]
    {
        if std::path::Path::new(name).extension().is_some() {
            return std::path::PathBuf::from(name);
        }
        let mut dirs: Vec<std::path::PathBuf> = cwd.map(|c| c.to_path_buf()).into_iter().collect();
        dirs.extend(std::env::split_paths(path));
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let exts: Vec<&str> = exts.split(';').filter(|e| !e.is_empty()).collect();
        search_program(name, &dirs, &exts).unwrap_or_else(|| std::path::PathBuf::from(name))
    }
}

/// First `dir/name<ext>` that is a file, for each dir in order, each PATHEXT entry in order. `None` when nothing matches.
#[cfg(any(windows, test))]
fn search_program(name: &str, dirs: &[std::path::PathBuf], exts: &[&str]) -> Option<std::path::PathBuf> {
    dirs.iter()
        .flat_map(|d| exts.iter().map(move |e| d.join(format!("{name}{e}"))))
        .find(|p| p.is_file())
}

/// Unix permission bits of a file (`mode()`); Windows: 0o644, or 0o444 when read-only.
pub fn mode(p: &std::fs::Permissions) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.mode()
    }
    #[cfg(windows)]
    {
        if p.readonly() {
            0o444
        } else {
            0o644
        }
    }
}

/// Is the file executable by its owner? Windows: by extension (.exe/.bat/.cmd/.com/.ps1).
pub fn is_executable(path: &std::path::Path, meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        let _ = path;
        mode(&meta.permissions()) & 0o111 != 0
    }
    #[cfg(windows)]
    {
        let _ = meta;
        matches!(
            path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
            Some("exe" | "bat" | "cmd" | "com" | "ps1")
        )
    }
}

/// `chmod(path, mode)`; Windows ignores the bits (NTFS ACLs already scope files to the user profile).
pub fn set_mode(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// Bytes actually allocated on disk (`blocks() * 512`); Windows: the logical length.
pub fn allocated_bytes(meta: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.blocks() * 512
    }
    #[cfg(windows)]
    {
        meta.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_alive_and_tagged() {
        assert!(alive(std::process::id()));
        assert!(!user_tag().is_empty());
    }

    #[test]
    fn resolve_program_unix_is_the_name() {
        #[cfg(unix)]
        assert_eq!(resolve_program("gradle"), std::path::PathBuf::from("gradle"));
        // A name with an extension is never searched, on any platform.
        assert_eq!(resolve_program("tool.exe"), std::path::PathBuf::from("tool.exe"));
    }

    #[test]
    fn search_program_prefers_dir_then_pathext_order() {
        let d = std::env::temp_dir().join(format!("ace-resolve-{}", std::process::id()));
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("npm.CMD"), b"").unwrap();
        std::fs::write(b.join("npm.EXE"), b"").unwrap();
        std::fs::write(b.join("npm.cmd"), b"").unwrap();
        let exts = [".COM", ".EXE", ".BAT", ".CMD"];
        // The first dir that has any PATHEXT match wins; within a dir the PATHEXT order decides (.EXE before .CMD).
        let hit = |dirs: &[std::path::PathBuf]| search_program("npm", dirs, &exts).map(|p| p.parent().unwrap().to_path_buf());
        assert_eq!(hit(&[a.clone(), b.clone()]), Some(a.clone()));
        assert_eq!(hit(&[b.clone(), a.clone()]), Some(b.clone()));
        assert!(search_program("npm", &[b.clone()], &exts).unwrap().to_string_lossy().to_ascii_lowercase().ends_with("npm.exe"));
        assert_eq!(search_program("nope", &[a.clone(), b.clone()], &exts), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn group_signal_ends_a_child_group() {
        let mut c = Command::new("sleep");
        c.arg("30");
        let mut child = new_group(&mut c).spawn().unwrap();
        let pid = child.id();
        assert!(is_group_leader(pid));
        assert!(signal_group(pid, Sig::Term));
        let st = child.wait().unwrap();
        assert_eq!(exit_signal(&st), Some(libc::SIGTERM));
    }
}
