//! Claude Code "turn finished / needs input" signals for the notification feature (docs/AI-SESSIONS.md).
//!
//! Two sources, both event driven (no polling loops):
//!  1. Hook channel (sessions Ace launched, local and remote): `claude --settings <json>` registers `Stop`, `Notification` and
//!     `UserPromptSubmit` hooks whose command appends `"<pane id> <hook json>"` to a per-window append-only file. A reader
//!     (`sh` + `tail -F`, local or through the multiplexed ssh connection) streams the lines to Rust, which emits
//!     `claude://hook` to the owning window. The reader is registered with `procs` for the window, lives exactly as long as
//!     the window (stdin EOF also stops it, e.g. when Ace crashes) and removes its temp file when it ends.
//!     Why a file and not a socket/FIFO: a FIFO without a reader blocks the writer (= blocks Claude); a socket needs nc in the hook
//!     and a listener thread to be woken on shutdown. An O_APPEND file never blocks, survives a restarted reader, and works the
//!     same on mc. Hooks cannot use the session's tty: they run with stdin/stdout captured and no controlling terminal
//!     (so writing OSC 9/777 to /dev/tty is not available to hooks; verified by the hook docs: stdout is parsed as hook output).
//!  2. Transcript fallback (sessions Ace did not launch): local `~/.claude/projects/<cwd>/<id>.jsonl` changes already reach us
//!     through the shared notify watcher; the tail of the changed file is analysed. Remote (no inotify on mc) sessions can be
//!     followed explicitly with `tail -F` over ssh. Heuristics: last assistant record with stop_reason end_turn = done; a
//!     trailing AskUserQuestion/ExitPlanMode tool_use = question; any other trailing tool_use = "pending" (the frontend turns it
//!     into a question only after a quiet period, because long-running tools look the same).
use crate::remote::ssh;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, WebviewWindow};

// ------------------------------------------------------------------------------------------------ hook settings

/// One line per hook call: "<pane id> <single-line hook json>". A single printf = a single write(2) on an O_APPEND file,
/// so concurrent hooks cannot interleave. No-op when the env is missing (e.g. settings reused outside Ace).
#[cfg(any(not(windows), test))]
const HOOK_CMD: &str = r#"[ -n "$ATELIER_HOOK_FILE" ] && printf "%s %s\n" "$ATELIER_PANE" "$(tr "\n" " ")" >> "$ATELIER_HOOK_FILE"; exit 0"#;

/// The same line for Windows (no sh needed; Claude Code runs hooks through Git Bash or cmd). PowerShell reads the hook JSON from
/// stdin, joins it into one line, and appends `<pane> <json>` to `$env:ATELIER_HOOK_FILE` as UTF-8 without a BOM (Out-File would add
/// one and corrupt the first line). The script goes in as -EncodedCommand (base64 UTF-16LE) so neither cmd nor bash touches its quoting.
/// Unlike the unix line this runs PowerShell per hook call (~0.3 s); the hook timeout is 5 s.
#[cfg(any(windows, test))]
fn win_hook_cmd() -> String {
    use base64::Engine as _;
    const PS: &str = "if ($env:ATELIER_HOOK_FILE) { $j = [Console]::In.ReadToEnd() -replace '[\\r\\n]+', ' '; \
[IO.File]::AppendAllText($env:ATELIER_HOOK_FILE, $env:ATELIER_PANE + ' ' + $j + [char]10, (New-Object System.Text.UTF8Encoding $false)) }";
    let utf16: Vec<u8> = PS.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!("powershell -NoProfile -NonInteractive -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(utf16))
}

#[cfg(not(windows))]
fn hook_cmd() -> String {
    HOOK_CMD.to_string()
}
#[cfg(windows)]
fn hook_cmd() -> String {
    win_hook_cmd()
}

pub fn settings_json() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let cmd = hook_cmd();
        let h = || serde_json::json!([{ "hooks": [{ "type": "command", "command": cmd, "timeout": 5 }] }]);
        serde_json::json!({ "hooks": { "Stop": h(), "Notification": h(), "UserPromptSubmit": h() } }).to_string()
    })
}

/// Subcommands / flags for which `--settings` must not be injected.
const PASSTHROUGH: &[&str] = &[
    "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp", "plugin", "plugins", "purge", "respawn", "rm",
    "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
];
const PASSTHROUGH_FLAGS: &[&str] = &["-p", "--print", "-h", "--help", "-v", "--version", "--bg"];

/// Binary used for hook-wrapped launches: `claude`, or `ATELIER_CLAUDE_BIN` (local) / `ATELIER_CLAUDE_BIN_<HOST>` (remote) when set
/// (point Ace at another build; the automation tests use it to run a fake claude instead of a real, usage-consuming session).
fn claude_bin(host: &str) -> String {
    let var = if host == "local" { "ATELIER_CLAUDE_BIN".to_string() } else { format!("ATELIER_CLAUDE_BIN_{}", host.to_uppercase().replace(|c: char| !c.is_ascii_alphanumeric(), "_")) };
    std::env::var(var).ok().filter(|v| !v.is_empty()).map(|v| ssh::quote(&v)).unwrap_or_else(|| "claude".into())
}

/// `claude ...` -> `claude --settings '<hooks json>' ...` (only for interactive session launches).
pub fn wrap_command(cmd: &str, host: &str) -> Option<String> {
    let t = cmd.trim_start();
    let rest = t.strip_prefix("claude")?;
    if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    let mut args = rest.split_whitespace();
    let first = args.next();
    if first.map_or(false, |f| PASSTHROUGH.contains(&f)) || rest.split_whitespace().any(|a| PASSTHROUGH_FLAGS.contains(&a)) {
        return None;
    }
    // The ace-studio plugin (docs/ANIMSTUDIO.md, plugins/ace-studio) rides along for local sessions: --plugin-dir is session-only,
    // nothing is installed into ~/.claude. Remote hosts only get it if the bundle exists there (not wired: see plugins/ace-studio/README.md).
    let plugin = if host == "local" { plugin_dir().map(|p| format!(" --plugin-dir {}", ssh::quote(p))).unwrap_or_default() } else { String::new() };
    Some(format!("{} --settings {}{}{}", claude_bin(host), ssh::quote(settings_json()), plugin, rest))
}

/// Directory of the bundled `ace-studio` Claude Code plugin, if this build can find one: `ATELIER_ACE_PLUGIN` (empty = disabled),
/// else `<repo>/plugins/ace-studio` next to the binary (dev builds) or `Resources/plugins/ace-studio` (app bundle). It must contain
/// the built server (`server/ace-mcp.mjs`, `pnpm build:mcp`).
pub fn plugin_dir() -> Option<&'static str> {
    static P: OnceLock<Option<String>> = OnceLock::new();
    P.get_or_init(|| {
        let ok = |d: &Path| d.join(".claude-plugin/plugin.json").is_file() && d.join("server/ace-mcp.mjs").is_file();
        if let Some(v) = std::env::var_os("ATELIER_ACE_PLUGIN") {
            let d = PathBuf::from(v);
            return (!d.as_os_str().is_empty() && ok(&d)).then(|| d.to_string_lossy().into_owned());
        }
        let mut cands: Vec<PathBuf> = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/ace-studio")];
        if let Ok(exe) = std::env::current_exe() {
            for a in exe.ancestors().skip(1).take(6) {
                cands.push(a.join("plugins/ace-studio"));
                cands.push(a.join("Resources/plugins/ace-studio"));
            }
        }
        cands.into_iter().filter_map(|c| c.canonicalize().ok()).find(|c| ok(c)).map(|c| c.to_string_lossy().into_owned())
    })
    .as_deref()
}

/// `NAME='v' ` assignments (shell prefix) that carry the channel into the claude process / interactive shell.
pub fn env_prefix(hook_file: &str, pane: &str, with_settings: bool) -> String {
    let mut s = format!("ATELIER_HOOK_FILE={} ATELIER_PANE={} ", ssh::quote(hook_file), ssh::quote(pane));
    if with_settings {
        s.push_str(&format!("ATELIER_CLAUDE_SETTINGS={} ", ssh::quote(settings_json())));
    }
    s
}

// ------------------------------------------------------------------------------------------------ child plumbing

type Reader = BufReader<std::process::ChildStdout>;

/// Run `sh -c script sh arg` locally or on `host` (through the multiplexed ssh connection), registered with procs for `label`.
fn spawn_script(label: &str, host: &str, kind: &str, script: &str, arg: &str) -> Result<(ChildStdin, Reader, u64), String> {
    let mut cmd = if host == "local" {
        let mut c = Command::new("sh");
        c.args(["-c", script, "sh", arg]);
        c
    } else {
        let mut c = ssh::command(host, false);
        c.arg(format!("sh -c {} sh {}", ssh::quote(script), ssh::quote(arg)));
        c
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::procs::group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let id = crate::procs::register_for(label, kind, host, child);
    Ok((stdin, BufReader::new(stdout), id))
}

fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}{:x}{}", std::process::id(), t & 0xffff_ffff, N.fetch_add(1, Ordering::Relaxed))
}

// ------------------------------------------------------------------------------------------------ hook channel

/// Creates the file, prints READY, streams appended lines; on EOF of stdin / termination removes the file.
const CHAN_SCRIPT: &str = r#"F="$1"; umask 077; : > "$F" || exit 1; echo READY; tail -n +1 -F "$F" 2>/dev/null & T=$!; trap 'kill $T 2>/dev/null; rm -f "$F"; exit 0' EXIT HUP TERM INT; cat >/dev/null"#;
/// Follows a transcript (starts with its last 80 lines).
const FOLLOW_SCRIPT: &str = r#"echo READY; tail -n 80 -F "$1" 2>/dev/null & T=$!; trap 'kill $T 2>/dev/null; exit 0' EXIT HUP TERM INT; cat >/dev/null"#;

struct Chan {
    file: String,
    host: String,
    proc_id: u64,
    /// the reader script's stdin: dropping it ends the script (unix / remote)
    _stdin: Option<ChildStdin>,
    /// Windows local channel: set on drop so the polling thread stops (there is no child process to end)
    _stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
impl Drop for Chan {
    fn drop(&mut self) {
        if let Some(stop) = &self._stop {
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
fn chans() -> &'static Mutex<HashMap<(String, String), Chan>> {
    static C: OnceLock<Mutex<HashMap<(String, String), Chan>>> = OnceLock::new();
    C.get_or_init(Default::default)
}
fn creating() -> &'static Mutex<()> {
    static C: OnceLock<Mutex<()>> = OnceLock::new();
    C.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HookChannel {
    pub host: String,
    pub file: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    host: String,
    pane: String,
    event: String,
    session_id: String,
    cwd: String,
    transcript: String,
    message: String,
    ntype: String,
    last: String,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn handle_hook_line(app: &AppHandle, label: &str, host: &str, line: &str) {
    let Some((pane, json)) = line.split_once(' ') else { return };
    let Ok(v) = serde_json::from_str::<Value>(json) else { return };
    let ev = HookEvent {
        host: host.to_string(),
        pane: pane.to_string(),
        event: s(&v, "hook_event_name"),
        session_id: s(&v, "session_id"),
        cwd: s(&v, "cwd"),
        transcript: s(&v, "transcript_path"),
        message: s(&v, "message"),
        ntype: s(&v, "notification_type"),
        last: first_line(&s(&v, "last_assistant_message")),
    };
    crate::windows::emit_window(app, label, "claude://hook", ev);
}

/// Per-window hook channel for `host` (created on first use, then reused). Blocks until the reader says READY.
#[tauri::command]
pub async fn claude_hook_channel(app: AppHandle, window: WebviewWindow, host: String) -> Result<HookChannel, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || channel(&app, &label, if host.is_empty() { "local" } else { &host })).await.map_err(|e| e.to_string())?
}

fn channel(app: &AppHandle, label: &str, host: &str) -> Result<HookChannel, String> {
    let key = (label.to_string(), host.to_string());
    let _g = creating().lock().unwrap();
    if let Some(c) = chans().lock().unwrap().get(&key) {
        return Ok(HookChannel { host: c.host.clone(), file: c.file.clone() });
    }
    let file = if host == "local" {
        let dir = std::env::temp_dir().join(format!("ace-claude-hooks-{}", crate::platform::user_tag()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = crate::platform::set_mode(&dir, 0o700);
        dir.join(format!("{label}-{}.log", nonce())).to_string_lossy().into_owned()
    } else {
        ssh::acquire(label, host);
        format!("/tmp/ace-claude-hooks-{}.log", nonce())
    };
    #[cfg(windows)]
    {
        if host == "local" {
            return local_tail_channel(app, label, key, file);
        }
    }
    let (stdin, mut out, proc_id) = spawn_script(label, host, "claude-hooks", CHAN_SCRIPT, &file)?;
    let mut first = String::new();
    if out.read_line(&mut first).is_err() || first.trim() != "READY" {
        crate::procs::kill(proc_id);
        return Err(format!("could not start the hook listener on {host}"));
    }
    chans().lock().unwrap().insert(key.clone(), Chan { file: file.clone(), host: host.to_string(), proc_id, _stdin: Some(stdin), _stop: None });
    let (app, label, host2) = (app.clone(), label.to_string(), host.to_string());
    std::thread::Builder::new()
        .name(format!("claude-hooks-{host2}"))
        .spawn(move || {
            for line in out.lines().map_while(Result::ok) {
                handle_hook_line(&app, &label, &host2, &line);
            }
            let mut g = chans().lock().unwrap();
            if g.get(&key).map(|c| c.proc_id) == Some(proc_id) {
                g.remove(&key);
            }
            crate::procs::unregister(proc_id);
        })
        .map_err(|e| e.to_string())?;
    Ok(HookChannel { host: host.to_string(), file })
}

/// Windows, local: the same channel without sh. This thread follows the file (see `Tailer`); dropping the `Chan` stops it.
#[cfg(windows)]
fn local_tail_channel(app: &AppHandle, label: &str, key: (String, String), file: String) -> Result<HookChannel, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    std::fs::write(&file, b"").map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let (app, label, stop2, path) = (app.clone(), label.to_string(), stop.clone(), PathBuf::from(&file));
    std::thread::Builder::new()
        .name("claude-hooks-local".into())
        .spawn(move || {
            let mut t = Tailer::new(path);
            while !stop2.load(Ordering::SeqCst) {
                for line in t.poll() {
                    if stop2.load(Ordering::SeqCst) {
                        break;
                    }
                    handle_hook_line(&app, &label, "local", &line);
                }
                std::thread::sleep(Duration::from_millis(TAIL_POLL_MS));
            }
        })
        .map_err(|e| e.to_string())?;
    chans().lock().unwrap().insert(key, Chan { file: file.clone(), host: "local".into(), proc_id: 0, _stdin: None, _stop: Some(stop) });
    Ok(HookChannel { host: "local".into(), file })
}

/// How often the Windows hook reader looks for appended bytes.
#[cfg(any(windows, test))]
const TAIL_POLL_MS: u64 = 150;

/// Follows an append-only file like `tail -n +1 -F`, without a child process: `poll` returns the complete lines appended since the
/// last call (a partial last line waits for its newline). Truncation (size below the read position) restarts at 0; a file that is
/// gone (removed, or about to be recreated) restarts at 0 as well, so a recreated file is read from its start.
#[cfg(any(windows, test))]
struct Tailer {
    path: PathBuf,
    pos: u64,
    partial: Vec<u8>,
}

#[cfg(any(windows, test))]
impl Tailer {
    fn new(path: PathBuf) -> Self {
        Self { path, pos: 0, partial: Vec::new() }
    }

    fn restart(&mut self) {
        self.pos = 0;
        self.partial.clear();
    }

    fn poll(&mut self) -> Vec<String> {
        let mut f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    self.restart();
                }
                return vec![];
            }
        };
        let Ok(len) = f.metadata().map(|m| m.len()) else { return vec![] };
        if len < self.pos {
            self.restart();
        }
        if len == self.pos || f.seek(SeekFrom::Start(self.pos)).is_err() {
            return vec![];
        }
        let mut buf = Vec::new();
        let Ok(n) = (&mut f).take(len - self.pos).read_to_end(&mut buf) else { return vec![] };
        self.pos += n as u64;
        self.partial.extend_from_slice(&buf);
        let mut out = Vec::new();
        while let Some(i) = self.partial.iter().position(|&b| b == b'\n') {
            let rest = self.partial.split_off(i + 1);
            let mut line = std::mem::replace(&mut self.partial, rest);
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }
}

// ------------------------------------------------------------------------------------------------ transcript analysis

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// done | question | pending | working
    pub kind: String,
    pub text: String,
    pub tool: Option<String>,
    pub uuid: String,
    pub ts_ms: u64,
}

fn first_line(t: &str) -> String {
    let l = t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let l: String = l.trim_start_matches(|c: char| c == '#' || c == '*' || c == '-' || c == ' ').chars().take(160).collect();
    l
}

/// RFC3339 "2026-10-11T05:25:25.674Z" -> unix ms (UTC only; 0 when unparsable).
pub fn parse_ts(t: &str) -> u64 {
    let b = t.as_bytes();
    let num = |a: usize, n: usize| t.get(a..a + n).and_then(|x| x.parse::<i64>().ok());
    if b.len() < 19 {
        return 0;
    }
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) = (num(0, 4), num(5, 2), num(8, 2), num(11, 2), num(14, 2), num(17, 2)) else { return 0 };
    let frac: String = t.get(20..).unwrap_or("").chars().take_while(char::is_ascii_digit).take(3).collect();
    let ms: i64 = if b[19] == b'.' && !frac.is_empty() { format!("{frac:0<3}").parse().unwrap_or(0) } else { 0 };
    // days from civil
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    ((days * 86400 + h * 3600 + mi * 60 + se) * 1000 + ms).max(0) as u64
}

fn blocks(r: &Value) -> Vec<&Value> {
    match r.get("message").and_then(|m| m.get("content")) {
        Some(Value::Array(a)) => a.iter().collect(),
        _ => vec![],
    }
}
fn text_blocks(r: &Value) -> String {
    let mut out = String::new();
    for b in blocks(r) {
        if b.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = b.get("text").and_then(Value::as_str) {
                out.push_str(t);
                out.push('\n');
            }
        }
    }
    out
}

/// Decide what the conversation is doing from the newest records (oldest first).
pub fn analyze(recs: &[Value]) -> Option<Turn> {
    let mut i = recs.len();
    while i > 0 {
        i -= 1;
        let r = &recs[i];
        if r.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let ty = r.get("type").and_then(Value::as_str).unwrap_or("");
        let uuid = s(r, "uuid");
        let ts_ms = parse_ts(&s(r, "timestamp"));
        let mk = |kind: &str, text: String, tool: Option<String>| Turn { kind: kind.into(), text, tool, uuid: uuid.clone(), ts_ms };
        match ty {
            "user" => return Some(mk("working", String::new(), None)),
            "assistant" => {
                let bl = blocks(r);
                let tool = bl.iter().rev().find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"));
                if let Some(t) = tool {
                    let name = s(t, "name");
                    let input = t.get("input");
                    return Some(match name.as_str() {
                        "AskUserQuestion" => {
                            let q = input
                                .and_then(|i| i.get("questions"))
                                .and_then(Value::as_array)
                                .and_then(|a| a.first())
                                .and_then(|q| q.get("question"))
                                .and_then(Value::as_str)
                                .unwrap_or("Claude has a question");
                            mk("question", first_line(q), Some(name))
                        }
                        "ExitPlanMode" => mk("question", "Claude has a plan ready for your approval".into(), Some(name)),
                        _ => mk("pending", String::new(), Some(name)),
                    });
                }
                let sr = r.get("message").and_then(|m| m.get("stop_reason")).and_then(Value::as_str).unwrap_or("");
                if sr == "end_turn" || sr == "stop_sequence" {
                    let mut text = first_line(&text_blocks(r));
                    if text.is_empty() {
                        // text may sit in an earlier record of the same message
                        for p in recs[..i].iter().rev().take(6) {
                            if p.get("type").and_then(Value::as_str) == Some("assistant") {
                                text = first_line(&text_blocks(p));
                                if !text.is_empty() {
                                    break;
                                }
                            }
                        }
                    }
                    return Some(mk("done", text, None));
                }
                return Some(mk("working", String::new(), None));
            }
            _ => continue,
        }
    }
    None
}

fn parse_lines(buf: &[u8], drop_first: bool) -> Vec<Value> {
    let mut s = buf;
    if drop_first {
        match s.iter().position(|&b| b == b'\n') {
            Some(i) => s = &s[i + 1..],
            None => return vec![],
        }
    }
    s.split(|&b| b == b'\n').filter(|l| l.first() == Some(&b'{')).filter_map(|l| serde_json::from_slice(l).ok()).collect()
}

const TAIL_BYTES: u64 = 256 * 1024;

pub fn analyze_file(p: &Path) -> Option<(Turn, String)> {
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let recs = parse_lines(&buf, start > 0);
    let cwd = recs.iter().rev().find_map(|r| r.get("cwd").and_then(Value::as_str)).unwrap_or("").to_string();
    analyze(&recs).map(|t| (t, cwd))
}

/// Current state of one transcript (hook payloads carry the path; used to find the last message / pending question).
#[tauri::command]
pub async fn claude_turn_info(host: String, file: String) -> Result<Option<Turn>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if host.is_empty() || host == "local" {
            return Ok(analyze_file(Path::new(&file)).map(|x| x.0));
        }
        let out = ssh::exec(&host, &format!("tail -c {TAIL_BYTES} {}", ssh::quote(&file)))?;
        let recs = parse_lines(&out.stdout, true);
        Ok(analyze(&recs))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------------------------------------ transcript fallback

#[derive(Default, Clone)]
struct FbCfg {
    dirs: HashSet<String>,
    sessions: HashSet<String>,
}
fn fb() -> &'static Mutex<HashMap<String, FbCfg>> {
    static F: OnceLock<Mutex<HashMap<String, FbCfg>>> = OnceLock::new();
    F.get_or_init(Default::default)
}
pub fn fallback_active() -> bool {
    !fb().lock().unwrap().is_empty()
}
fn last_seen() -> &'static Mutex<HashMap<PathBuf, (String, String)>> {
    static L: OnceLock<Mutex<HashMap<PathBuf, (String, String)>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TurnEvent {
    host: String,
    session_id: String,
    file: String,
    cwd: String,
    #[serde(flatten)]
    turn: Turn,
}

/// Scope of the local transcript fallback for this window: sessions whose project folder is `cwd` plus the explicitly
/// opted-in session ids. Both empty = off. Starts the shared notify watcher when needed.
#[tauri::command]
pub fn claude_fallback_set(app: AppHandle, window: WebviewWindow, cwd: Option<String>, sessions: Vec<String>) -> Result<(), String> {
    let label = window.label().to_string();
    let cfg = FbCfg { dirs: cwd.iter().map(|c| crate::claude::encode_cwd(c)).collect(), sessions: sessions.into_iter().collect() };
    if cfg.dirs.is_empty() && cfg.sessions.is_empty() {
        fb().lock().unwrap().remove(&label);
        crate::claude::maybe_drop_watcher();
        return Ok(());
    }
    fb().lock().unwrap().insert(label, cfg);
    crate::claude::ensure_watcher(&app)
}

/// Debounced batch of changed paths under the projects dir (from the shared watcher).
pub fn on_paths(app: &AppHandle, paths: &HashSet<PathBuf>) {
    let cfgs = fb().lock().unwrap().clone();
    if cfgs.is_empty() {
        return;
    }
    let Some(root) = crate::claude::projects_dir() else { return };
    for p in paths {
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let (Some(dir), Some(id)) = (p.parent(), p.file_stem().and_then(|s| s.to_str())) else { continue };
        if dir.parent() != Some(root.as_path()) {
            continue; // sub-agent transcripts etc.
        }
        let folder = dir.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let labels: Vec<&String> = cfgs.iter().filter(|(_, c)| c.dirs.contains(&folder) || c.sessions.contains(id)).map(|(l, _)| l).collect();
        if labels.is_empty() {
            continue;
        }
        let Some((turn, cwd)) = analyze_file(p) else { continue };
        let mut seen = last_seen().lock().unwrap();
        let first = !seen.contains_key(p);
        let same = seen.get(p).map(|(k, u)| *k == turn.kind && *u == turn.uuid).unwrap_or(false);
        if same {
            continue;
        }
        seen.insert(p.clone(), (turn.kind.clone(), turn.uuid.clone()));
        drop(seen);
        // First sight of a file: do not announce a state that was already old (we only know it changed on disk).
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if first && turn.kind != "working" && turn.ts_ms > 0 && now.saturating_sub(turn.ts_ms) > 20_000 {
            continue;
        }
        let ev = TurnEvent { host: "local".into(), session_id: id.to_string(), file: p.to_string_lossy().into_owned(), cwd, turn };
        crate::windows::emit_windows(app, labels, "claude://turn", ev);
    }
}

// ---- remote follow (explicit opt-in per session; mc has no inotify tooling, `tail -F` over ssh is event driven) ----

struct Follow {
    _stdin: ChildStdin,
    proc_id: u64,
}
fn follows() -> &'static Mutex<HashMap<(String, String), Follow>> {
    static F: OnceLock<Mutex<HashMap<(String, String), Follow>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

#[tauri::command]
pub async fn claude_follow(app: AppHandle, window: WebviewWindow, host: String, file: String, session_id: String) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let key = (label.clone(), format!("{host}:{file}"));
        if follows().lock().unwrap().contains_key(&key) {
            return Ok(());
        }
        ssh::acquire(&label, &host);
        let (stdin, mut out, proc_id) = spawn_script(&label, &host, "claude-follow", FOLLOW_SCRIPT, &file)?;
        let mut first = String::new();
        if out.read_line(&mut first).is_err() || first.trim() != "READY" {
            crate::procs::kill(proc_id);
            return Err(format!("could not follow {file} on {host}"));
        }
        follows().lock().unwrap().insert(key.clone(), Follow { _stdin: stdin, proc_id });
        std::thread::Builder::new()
            .name("claude-follow".into())
            .spawn(move || {
                let start = Instant::now();
                let mut recs: Vec<Value> = Vec::new();
                let mut last: Option<(String, String)> = None;
                let mut baseline = false;
                for line in out.lines().map_while(Result::ok) {
                    if !line.starts_with('{') {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                    let warm = start.elapsed() < Duration::from_millis(1500);
                    if !warm && !baseline {
                        baseline = true;
                        last = analyze(&recs).map(|t| (t.kind, t.uuid));
                    }
                    recs.push(v);
                    if recs.len() > 160 {
                        recs.drain(..80);
                    }
                    if warm {
                        continue;
                    }
                    if let Some(t) = analyze(&recs) {
                        let k = (t.kind.clone(), t.uuid.clone());
                        if last.as_ref() != Some(&k) {
                            last = Some(k);
                            let cwd = recs.iter().rev().find_map(|r| r.get("cwd").and_then(Value::as_str)).unwrap_or("").to_string();
                            crate::windows::emit_window(&app, &label, "claude://turn", TurnEvent { host: host.clone(), session_id: session_id.clone(), file: file.clone(), cwd, turn: t });
                        }
                    }
                }
                let mut g = follows().lock().unwrap();
                if g.get(&key).map(|f| f.proc_id) == Some(proc_id) {
                    g.remove(&key);
                }
                crate::procs::unregister(proc_id);
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn claude_unfollow(window: WebviewWindow, host: String, file: String) {
    let f = follows().lock().unwrap().remove(&(window.label().to_string(), format!("{host}:{file}")));
    if let Some(f) = f {
        crate::procs::kill(f.proc_id);
    }
}

// ------------------------------------------------------------------------------------------------ notification click routing

/// The notification plugin has no click callback on macOS desktop, so the window that showed the last OS notification records it
/// here; whichever window the app activates in claims it (within CLAIM_SECS) and the session is brought forward.
static LAST_NOTE: Mutex<Option<(String, String, Instant)>> = Mutex::new(None);
const CLAIM_SECS: u64 = 25;

#[tauri::command]
pub fn claude_note_shown(window: WebviewWindow, key: String) {
    *LAST_NOTE.lock().unwrap() = Some((window.label().to_string(), key, Instant::now()));
}

/// Called by a window that just became active. Returns true when it was routed (to this or another window).
#[tauri::command]
pub fn claude_note_claim(app: AppHandle, window: WebviewWindow) -> bool {
    let note = LAST_NOTE.lock().unwrap().take();
    let Some((label, key, at)) = note else { return false };
    if at.elapsed() > Duration::from_secs(CLAIM_SECS) {
        return false;
    }
    if label != window.label() {
        crate::windows::win_focus(app.clone(), label.clone());
    }
    crate::windows::emit_window(&app, &label, "claude://goto", key);
    true
}

// ------------------------------------------------------------------------------------------------ window cleanup

pub fn release_window(label: &str) {
    let mine: Vec<(String, String)> = chans().lock().unwrap().keys().filter(|k| k.0 == label).cloned().collect();
    for k in mine {
        if let Some(c) = chans().lock().unwrap().remove(&k) {
            if c.host == "local" {
                let _ = std::fs::remove_file(&c.file);
            }
            // dropping `_stdin` ends the reader script (EOF), which removes the file on remote hosts
        }
    }
    follows().lock().unwrap().retain(|k, _| k.0 != label);
    fb().lock().unwrap().remove(label);
    let mut n = LAST_NOTE.lock().unwrap();
    if n.as_ref().map_or(false, |(l, _, _)| l == label) {
        *n = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asst(stop: &str, blocks: Value, uuid: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"timestamp":"2026-10-11T05:25:25.674Z","message":{"role":"assistant","stop_reason":stop,"content":blocks}})
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_ts("2026-10-11T05:25:25.674Z"), 1_791_696_325_674);
        assert_eq!(parse_ts("1970-01-01T00:00:01Z"), 1000);
        assert_eq!(parse_ts("nope"), 0);
    }

    #[test]
    fn turn_states() {
        let done = vec![
            json!({"type":"user","uuid":"u","message":{"role":"user","content":"hi"}}),
            asst("end_turn", json!([{"type":"text","text":"\n## All set\nmore"}]), "a1"),
            json!({"type":"system","subtype":"turn_duration","uuid":"s"}),
        ];
        let t = analyze(&done).unwrap();
        assert_eq!((t.kind.as_str(), t.text.as_str(), t.uuid.as_str()), ("done", "All set", "a1"));
        let q = vec![asst("tool_use", json!([{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which DB?"}]}}]), "a2")];
        let t = analyze(&q).unwrap();
        assert_eq!((t.kind.as_str(), t.text.as_str()), ("question", "Which DB?"));
        let p = vec![asst("tool_use", json!([{"type":"tool_use","name":"Bash","input":{}}]), "a3")];
        assert_eq!(analyze(&p).unwrap().kind, "pending");
        let mut w = p.clone();
        w.push(json!({"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result"}]}}));
        assert_eq!(analyze(&w).unwrap().kind, "working");
        // sidechain (sub-agent) records never decide
        let mut sc = done.clone();
        sc.push(json!({"type":"assistant","isSidechain":true,"uuid":"x","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}));
        assert_eq!(analyze(&sc).unwrap().kind, "done");
    }

    #[test]
    fn wrapping() {
        assert!(wrap_command("claude", "local").unwrap().starts_with("claude --settings '"));
        assert!(wrap_command("claude --resume abc", "local").unwrap().ends_with(" --resume abc"));
        assert!(wrap_command("claude -c", "local").is_some());
        assert!(wrap_command("claude mcp list", "local").is_none());
        assert!(wrap_command("claude -p hi", "local").is_none());
        assert!(wrap_command("claudex", "local").is_none());
        assert!(wrap_command("ls", "local").is_none());
    }

    #[test]
    fn ace_studio_plugin_rides_along_for_local_sessions_only() {
        // the dev tree has plugins/ace-studio with the built server (pnpm build:mcp); skip when it has not been built
        let Some(dir) = plugin_dir() else { return };
        assert!(std::path::Path::new(dir).join("server/ace-mcp.mjs").is_file());
        let local = wrap_command("claude --resume abc", "local").unwrap();
        assert!(local.contains(&format!(" --plugin-dir '{dir}' --resume abc")), "{local}");
        assert!(!wrap_command("claude", "mc").unwrap().contains("--plugin-dir"));
    }

    #[test]
    fn win_hook_command_is_one_encoded_powershell_line() {
        use base64::Engine as _;
        let c = win_hook_cmd();
        assert!(c.starts_with("powershell -NoProfile -NonInteractive -EncodedCommand "), "{c}");
        assert!(!c.contains('\n') && !c.contains('"') && !c.contains('\'') && !c.contains('$'), "{c}");
        let b = base64::engine::general_purpose::STANDARD.decode(c.rsplit(' ').next().unwrap()).unwrap();
        let units: Vec<u16> = b.chunks(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        let ps = String::from_utf16(&units).unwrap();
        assert!(ps.contains("$env:ATELIER_HOOK_FILE") && ps.contains("$env:ATELIER_PANE") && ps.contains("UTF8Encoding $false"), "{ps}");
        assert!(!ps.contains('\n'));
    }

    #[test]
    fn tailer_follows_appends_truncation_and_recreation() {
        let dir = std::env::temp_dir().join(format!("ace-tail-test-{}", nonce()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("c.log");
        std::fs::write(&f, b"").unwrap();
        let mut t = Tailer::new(f.clone());
        assert!(t.poll().is_empty());
        let app = |b: &[u8]| {
            use std::io::Write;
            std::fs::OpenOptions::new().append(true).create(true).open(&f).unwrap().write_all(b).unwrap();
        };
        app(b"p1 {\"a\":1}\np2 {\"b\"");
        assert_eq!(t.poll(), vec!["p1 {\"a\":1}".to_string()]);
        app(b":2}\r\n");
        assert_eq!(t.poll(), vec!["p2 {\"b\":2}".to_string()]);
        // truncated, then written again from the start
        std::fs::write(&f, b"p3 x\n").unwrap();
        assert_eq!(t.poll(), vec!["p3 x".to_string()]);
        // removed, then recreated: read from its start
        std::fs::remove_file(&f).unwrap();
        assert!(t.poll().is_empty());
        std::fs::write(&f, b"p4 y\np5 z\n").unwrap();
        assert_eq!(t.poll(), vec!["p4 y".to_string(), "p5 z".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn hook_command_appends_a_line() {
        let dir = std::env::temp_dir().join(format!("ace-hook-test-{}", nonce()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("h.log");
        let mut c = Command::new("sh").arg("-c").arg(HOOK_CMD).env("ATELIER_HOOK_FILE", &f).env("ATELIER_PANE", "p1").stdin(Stdio::piped()).spawn().unwrap();
        use std::io::Write;
        c.stdin.take().unwrap().write_all(b"{\"hook_event_name\":\"Stop\",\n\"session_id\":\"s\"}\n").unwrap();
        assert!(c.wait().unwrap().success());
        let body = std::fs::read_to_string(&f).unwrap();
        assert_eq!(body.lines().count(), 1);
        let (pane, json) = body.trim_end().split_once(' ').unwrap();
        assert_eq!(pane, "p1");
        assert_eq!(serde_json::from_str::<Value>(json).unwrap()["hook_event_name"], "Stop");
        // without the env var: succeeds silently
        let st = Command::new("sh").arg("-c").arg(HOOK_CMD).env_remove("ATELIER_HOOK_FILE").stdin(Stdio::null()).status().unwrap();
        assert!(st.success());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
