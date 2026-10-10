//! Processes & Daemons tool window backend: gradle/kotlin/JVM/LSP/claude scan, stop, cleanup.
//! Local (sysinfo + one batched lsof) and ssh hosts (one round trip reading /proc). Owned by the daemons agent.
use crate::procs;
use crate::remote::ssh;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::Emitter;

const GRADLE_MAIN: &str = "org.gradle.launcher.daemon.bootstrap.GradleDaemon";

fn is_local(host: &str) -> bool {
    host == "local" || host.is_empty()
}

// ---------------------------------------------------------------- model

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub host: String,
    pub pid: u32,
    pub kind: String, // gradle | kotlin | java | lsp | claude | atelier
    pub label: String,
    pub version: Option<String>,
    pub rss: u64,
    pub cpu: f32,
    pub uptime_secs: u64,
    pub cwd: Option<String>,
    pub busy: Option<bool>,
    pub atelier: bool,
    pub cmd: String,
    /// Never part of a bulk action; killing requires typing the PID (Minecraft servers).
    pub guarded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub rows: Vec<ProcRow>,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub gradle_count: u32,
    pub rss: u64,
}

/// Raw process facts, platform independent (what classification needs).
#[allow(dead_code)]
struct Raw1 {
    pid: u32,
    name: String,
    cmd: Vec<String>,
    rss: u64,
    cpu: f32,
    uptime: u64,
    cwd: Option<String>,
}

const MC_MAINS: &[&str] = &[
    "net.minecraft.server.Main", "net.minecraft.server.MinecraftServer", "net.minecraft.bundler.Main", "net.minecraftforge.bootstrap",
    "net.neoforged", "net.fabricmc.loader.impl.launch.server", "net.fabricmc.loader.launch.server", "io.papermc", "org.bukkit.craftbukkit",
    "org.spigotmc", "org.quiltmc.loader",
];
const MC_JAR_HINTS: &[&str] = &["minecraft", "fabric-server", "fabric-launcher", "paper", "spigot", "purpur", "forge", "neoforge", "quilt-server", "bukkit", "folia", "pufferfish"];

/// "Minecraft server (jar)" when the command line looks like a Minecraft server JVM (jar name / main class / aikar flags).
pub fn minecraft_label(cmd: &[String]) -> Option<String> {
    let joined = cmd.join(" ");
    let jar = cmd.iter().position(|a| a == "-jar").and_then(|i| cmd.get(i + 1)).map(|j| j.rsplit('/').next().unwrap_or(j).to_string());
    let by_main = MC_MAINS.iter().any(|m| joined.contains(m));
    let by_jar = jar.as_deref().map(|j| { let l = j.to_lowercase(); MC_JAR_HINTS.iter().any(|h| l.contains(h)) }).unwrap_or(false);
    let by_flags = joined.contains("-Dusing.aikars.flags") || joined.contains("-Daikars.new.flags");
    if by_main || by_jar || by_flags {
        Some(match jar { Some(j) => format!("Minecraft server ({j})"), None => "Minecraft server".into() })
    } else {
        None
    }
}

pub fn classify(name: &str, cmd: &[String]) -> Option<(&'static str, Option<String>, String)> {
    let joined = cmd.join(" ");
    let exe = cmd.first().map(|s| s.rsplit('/').next().unwrap_or(s)).unwrap_or(name);
    let is_java = name == "java" || exe == "java";
    if is_java {
        if let Some(i) = cmd.iter().position(|a| a == GRADLE_MAIN) {
            let ver = cmd.get(i + 1).filter(|v| v.chars().next().map_or(false, |c| c.is_ascii_digit())).cloned().or_else(|| version_in(&joined, "gradle-"));
            return Some(("gradle", ver, "Gradle Daemon".into()));
        }
        if joined.contains("KotlinCompileDaemon") {
            let ver = version_in(&joined, "kotlin-compiler-embeddable-").or_else(|| version_in(&joined, "kotlin-daemon-"));
            return Some(("kotlin", ver, "Kotlin Compile Daemon".into()));
        }
        if joined.contains("org.eclipse.jdt.ls") || joined.contains("jdtls") {
            return Some(("lsp", None, "jdtls".into()));
        }
        if let Some(label) = minecraft_label(cmd) {
            return Some(("minecraft", None, label));
        }
        let label = if let Some(i) = cmd.iter().position(|a| a == "-jar") {
            cmd.get(i + 1).map(|j| j.rsplit('/').next().unwrap_or(j).to_string())
        } else {
            // first non-option arg after the java binary (skip -cp value)
            let mut it = cmd.iter().skip(1);
            let mut found = None;
            while let Some(a) = it.next() {
                if a == "-cp" || a == "-classpath" || a == "--class-path" || a == "-p" {
                    it.next();
                } else if !a.starts_with('-') && !a.starts_with('@') {
                    found = Some(a.clone());
                    break;
                }
            }
            found
        };
        return Some(("java", None, label.unwrap_or_else(|| "java".into())));
    }
    match name {
        "rust-analyzer" | "gopls" => return Some(("lsp", None, name.into())),
        "claude" => return Some(("claude", version_from_path(cmd.first()), "claude".into())),
        _ => {}
    }
    if exe == "claude" {
        return Some(("claude", version_from_path(cmd.first()), "claude".into()));
    }
    if matches!(name, "node" | "bun" | "deno") || exe.starts_with("python") || exe == "node" {
        for ls in ["typescript-language-server", "pyright-langserver", "pyright", "basedpyright"] {
            if joined.contains(ls) {
                return Some(("lsp", None, ls.into()));
            }
        }
    }
    if exe == "rust-analyzer" || exe == "gopls" {
        return Some(("lsp", None, exe.into()));
    }
    None
}

fn version_from_path(p: Option<&String>) -> Option<String> {
    // ~/.local/share/claude/versions/2.1.3
    let p = p?;
    let i = p.find("/versions/")?;
    Some(p[i + 10..].split('/').next()?.to_string())
}

/// Find `<prefix><digits.dots...>` in s and return the version part (strips a trailing .jar or -bin etc).
fn version_in(s: &str, prefix: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = s[from..].find(prefix) {
        let st = from + i + prefix.len();
        let v: String = s[st..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
        let v = v.trim_end_matches(|c: char| c == '.' || c == '-').to_string();
        if v.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            // cut at known suffix
            for suf in ["-bin", "-all", ".jar"] {
                if let Some(k) = v.find(suf) {
                    return Some(v[..k].to_string());
                }
            }
            return Some(v);
        }
        from = st;
    }
    None
}

// ---------------------------------------------------------------- cpu history / busy

#[derive(Default)]
struct Hist {
    last: f32,
    prev: f32,
    ticks: Option<(f64, f64)>, // remote: (cpu seconds, wall seconds)
}
#[derive(Default)]
struct State {
    sys: Option<System>,
    hist: HashMap<(String, u32, u64), Hist>,
    cwd: HashMap<(u32, u64), String>,
    primed: HashSet<String>,
    /// (host, pid) of guarded processes (Minecraft servers) from the latest scan of each host.
    guarded: HashSet<(String, u32)>,
}
fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State::default()))
}
fn busy_of(h: &Hist) -> bool {
    h.last >= 1.0 || h.prev >= 1.0
}

// ---------------------------------------------------------------- local scan

fn refresh_kind(cpu: bool) -> ProcessRefreshKind {
    let k = ProcessRefreshKind::nothing().with_memory().with_cmd(UpdateKind::OnlyIfNotSet);
    if cpu { k.with_cpu() } else { k }
}

fn lsof_cwds(pids: &[u32]) -> HashMap<u32, String> {
    let mut m = HashMap::new();
    if pids.is_empty() {
        return m;
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let Ok(out) = Command::new("lsof").args(["-a", "-d", "cwd", "-p", &list, "-Fpn"]).stdin(Stdio::null()).output() else {
        return m;
    };
    let mut cur = 0u32;
    for l in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = l.strip_prefix('p') {
            cur = p.parse().unwrap_or(0);
        } else if let Some(n) = l.strip_prefix('n') {
            if cur != 0 {
                m.insert(cur, n.to_string());
            }
        }
    }
    m
}

fn scan_local() -> Vec<ProcRow> {
    let mut st = state().lock().unwrap();
    let st = &mut *st;
    let sys = st.sys.get_or_insert_with(System::new);
    let first = st.primed.insert("local".into());
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind(true));
    if first {
        // cpu usage needs two samples; prime once
        std::thread::sleep(Duration::from_millis(250));
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind(true));
    }
    let tracked: HashMap<u32, procs::TrackedProc> = procs::list().into_iter().filter_map(|t| t.pid.map(|p| (p, t))).collect();
    let mut found: Vec<(Raw1, &'static str, Option<String>, String, bool, u64)> = Vec::new();
    for (pid, p) in sys.processes() {
        let pid = pid.as_u32();
        let cmd: Vec<String> = p.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
        let name = p.name().to_string_lossy().into_owned();
        let c = classify(&name, &cmd);
        let t = tracked.get(&pid);
        if c.is_none() && t.is_none() {
            continue;
        }
        let (kind, ver, label) = match (&c, t) {
            (Some((k, v, l)), _) => (*k, v.clone(), l.clone()),
            (None, Some(t)) => ("atelier", None, format!("{} {}", t.kind, t.label)),
            _ => unreachable!(),
        };
        let start = p.start_time();
        found.push((
            Raw1 { pid, name, cmd, rss: p.memory(), cpu: p.cpu_usage(), uptime: p.run_time(), cwd: None },
            kind,
            ver,
            label,
            t.is_some(),
            start,
        ));
    }
    // one lsof for all pids whose cwd we do not know yet
    let need: Vec<u32> = found.iter().filter(|f| !st.cwd.contains_key(&(f.0.pid, f.5))).map(|f| f.0.pid).collect();
    let got = lsof_cwds(&need);
    for f in &found {
        if let Some(c) = got.get(&f.0.pid) {
            st.cwd.insert((f.0.pid, f.5), c.clone());
        }
    }
    let live: HashSet<(u32, u64)> = found.iter().map(|f| (f.0.pid, f.5)).collect();
    st.cwd.retain(|k, _| live.contains(k));
    st.hist.retain(|k, _| k.0 != "local" || live.contains(&(k.1, k.2)));
    let mut rows = vec![];
    for (mut r, kind, ver, label, atelier, start) in found {
        r.cwd = st.cwd.get(&(r.pid, start)).cloned();
        let (mut kind, mut label) = (kind, label);
        if kind == "java" && r.cwd.as_deref().map_or(false, |c| Path::new(c).join("server.properties").is_file()) {
            kind = "minecraft";
            label = "Minecraft server".into();
        }
        let h = st.hist.entry(("local".into(), r.pid, start)).or_default();
        h.prev = h.last;
        h.last = r.cpu;
        let busy = if kind == "gradle" { Some(busy_of(h)) } else { None };
        rows.push(ProcRow {
            host: "local".into(), pid: r.pid, kind: kind.into(), label, version: ver, rss: r.rss, cpu: r.cpu,
            uptime_secs: r.uptime, cwd: r.cwd, busy, atelier,
            cmd: r.cmd.join(" ").chars().take(400).collect(),
            guarded: kind == "minecraft",
        });
    }
    st.guarded.retain(|g| g.0 != "local");
    st.guarded.extend(rows.iter().filter(|r| r.guarded).map(|r| ("local".to_string(), r.pid)));
    rows
}

/// Cheap local scan: gradle/kotlin daemons only, no cpu, no lsof.
fn summary_local() -> Vec<(u32, &'static str, Option<String>, u64)> {
    static SUM: OnceLock<Mutex<System>> = OnceLock::new();
    let mut sys = SUM.get_or_init(|| Mutex::new(System::new())).lock().unwrap();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind(false));
    let mut v = vec![];
    for (pid, p) in sys.processes() {
        let name = p.name().to_string_lossy();
        if name != "java" {
            continue;
        }
        let cmd: Vec<String> = p.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
        if let Some((k, ver, _)) = classify(&name, &cmd) {
            if k == "gradle" || k == "kotlin" {
                v.push((pid.as_u32(), k, ver, p.memory()));
            }
        }
    }
    v
}

// ---------------------------------------------------------------- remote scan

const REMOTE_SCAN: &str = r#"python3 - <<'PYEOF'
import os, json
hz = os.sysconf('SC_CLK_TCK')
up = float(open('/proc/uptime').read().split()[0])
me = os.getpid()
out = []
LS = ('typescript-language-server', 'pyright', 'jdtls', 'org.eclipse.jdt.ls')
for d in os.listdir('/proc'):
    if not d.isdigit():
        continue
    pid = int(d)
    if pid == me:
        continue
    try:
        comm = open('/proc/%d/comm' % pid).read().strip()
        raw = open('/proc/%d/cmdline' % pid, 'rb').read()
        cmd = [a.decode('utf-8', 'replace') for a in raw.split(b'\0') if a]
        joined = ' '.join(cmd)
        ok = comm in ('java', 'claude', 'rust-analyzer', 'gopls') or (comm in ('node', 'bun') or comm.startswith('python')) and any(l in joined for l in LS)
        if not ok:
            continue
        rss = 0
        for l in open('/proc/%d/status' % pid):
            if l.startswith('VmRSS:'):
                rss = int(l.split()[1]) * 1024
                break
        st = open('/proc/%d/stat' % pid).read()
        f = st[st.rindex(')') + 2:].split()
        ticks = int(f[11]) + int(f[12])
        start = int(f[19])
        try:
            cwd = os.readlink('/proc/%d/cwd' % pid)
        except Exception:
            cwd = None
        props = False
        try:
            props = bool(cwd) and os.path.exists(cwd + '/server.properties')
        except Exception:
            pass
        box = None
        try:
            for l in open('/proc/%d/cgroup' % pid):
                if 'docker-' in l or '/docker/' in l:
                    box = 'docker'
                    break
        except Exception:
            pass
        out.append({'pid': pid, 'name': comm, 'cmd': cmd[:60], 'rss': rss, 'cpu': ticks / hz, 'start': start / hz, 'cwd': cwd, 'props': props, 'box': box})
    except Exception:
        pass
print(json.dumps({'up': up, 'procs': out}))
PYEOF"#;

fn remote_once(host: &str) -> Result<serde_json::Value, String> {
    let out = ssh::exec(host, REMOTE_SCAN)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("bad scan output from {host}: {e}"))
}

fn scan_remote(host: &str) -> Result<Vec<ProcRow>, String> {
    let mut v = remote_once(host)?;
    let first = state().lock().unwrap().primed.insert(host.to_string());
    if first {
        std::thread::sleep(Duration::from_millis(250));
        v = remote_once(host)?;
    }
    let up = v["up"].as_f64().unwrap_or(0.0);
    let procs = v["procs"].as_array().cloned().unwrap_or_default();
    let mut st = state().lock().unwrap();
    let mut rows = vec![];
    let mut live: HashSet<(u32, u64)> = HashSet::new();
    for p in procs {
        let pid = p["pid"].as_u64().unwrap_or(0) as u32;
        let name = p["name"].as_str().unwrap_or("").to_string();
        let cmd: Vec<String> = p["cmd"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let Some((mut kind, ver, mut label)) = classify(&name, &cmd) else { continue };
        if kind == "java" && p["props"].as_bool() == Some(true) {
            kind = "minecraft";
            label = "Minecraft server".into();
        }
        if kind == "minecraft" {
            if let Some(b) = p["box"].as_str() {
                label = format!("{label} [{b}]");
            }
        }
        let start = p["start"].as_f64().unwrap_or(0.0);
        let startk = (start * 100.0) as u64;
        live.insert((pid, startk));
        let cpu_s = p["cpu"].as_f64().unwrap_or(0.0);
        let h = st.hist.entry((host.to_string(), pid, startk)).or_default();
        let cpu = match h.ticks {
            Some((c0, t0)) if up > t0 => (((cpu_s - c0) / (up - t0)) * 100.0).max(0.0) as f32,
            _ => (cpu_s / (up - start).max(1.0) * 100.0) as f32,
        };
        h.ticks = Some((cpu_s, up));
        h.prev = h.last;
        h.last = cpu;
        let busy = if kind == "gradle" { Some(busy_of(h)) } else { None };
        rows.push(ProcRow {
            host: host.into(), pid, kind: kind.into(), label, version: ver,
            rss: p["rss"].as_u64().unwrap_or(0), cpu, uptime_secs: (up - start).max(0.0) as u64,
            cwd: p["cwd"].as_str().map(String::from), busy, atelier: false,
            cmd: cmd.join(" ").chars().take(400).collect(),
            guarded: kind == "minecraft",
        });
    }
    st.guarded.retain(|g| g.0 != host);
    st.guarded.extend(rows.iter().filter(|r| r.guarded).map(|r| (host.to_string(), r.pid)));
    st.hist.retain(|k, _| k.0 != host || live.contains(&(k.1, k.2)));
    Ok(rows)
}

#[tauri::command]
pub async fn daemons_list(host: String) -> Result<ListResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = Instant::now();
        let rows = if is_local(&host) { scan_local() } else { scan_remote(&host)? };
        Ok(ListResult { rows, elapsed_ms: t.elapsed().as_millis() as u64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Status bar: gradle daemon count + RSS of all gradle+kotlin daemons. Local is cheap (no cpu, no lsof);
/// a remote host costs one ssh round trip (only asked for while a remote project/session is active).
#[tauri::command]
pub async fn daemons_summary(host: Option<String>) -> Result<Summary, String> {
    tauri::async_runtime::spawn_blocking(move || match host.filter(|h| !is_local(h)) {
        None => {
            let v = summary_local();
            Ok(Summary { gradle_count: v.iter().filter(|x| x.1 == "gradle").count() as u32, rss: v.iter().map(|x| x.3).sum() })
        }
        Some(h) => {
            let rows = scan_remote(&h)?;
            let d: Vec<&ProcRow> = rows.iter().filter(|r| r.kind == "gradle" || r.kind == "kotlin").collect();
            Ok(Summary { gradle_count: d.iter().filter(|r| r.kind == "gradle").count() as u32, rss: d.iter().map(|r| r.rss).sum() })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- actions

fn kill_cmd(host: &str, sig: &str, pids: &[u32]) -> Result<(), String> {
    let list = pids.iter().filter(|p| **p > 1).map(|p| p.to_string()).collect::<Vec<_>>();
    if list.is_empty() {
        return Ok(());
    }
    if is_local(host) {
        Command::new("kill").arg(format!("-{sig}")).args(&list).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        ssh::exec(host, &format!("kill -{sig} {} 2>/dev/null; true", list.join(" "))).map(|_| ())
    }
}

/// SIGTERM, then SIGKILL after 5s for survivors.
fn terminate(host: &str, pids: &[u32]) -> Result<(), String> {
    let pids: Vec<u32> = pids.iter().copied().filter(|p| *p > 1).collect();
    if pids.is_empty() {
        return Ok(());
    }
    if is_local(host) {
        kill_cmd(host, "TERM", &pids)?;
        let t = Instant::now();
        let alive = |p: &u32| Command::new("kill").args(["-0", &p.to_string()]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        while t.elapsed() < Duration::from_secs(5) {
            if !pids.iter().any(alive) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let left: Vec<u32> = pids.iter().copied().filter(alive).collect();
        kill_cmd(host, "KILL", &left)
    } else {
        let l = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
        let s = format!(
            "kill -TERM {l} 2>/dev/null; for i in $(seq 25); do a=0; for p in {l}; do kill -0 $p 2>/dev/null && a=1; done; [ $a = 0 ] && exit 0; sleep 0.2; done; kill -KILL {l} 2>/dev/null; true"
        );
        ssh::exec(host, &s).map(|_| ())
    }
}

fn host_key(host: &str) -> String {
    if is_local(host) { "local".into() } else { host.to_string() }
}
fn is_guarded(host: &str, pid: u32) -> bool {
    state().lock().unwrap().guarded.contains(&(host_key(host), pid))
}
fn without_guarded(host: &str, pids: &[u32]) -> Vec<u32> {
    pids.iter().copied().filter(|p| !is_guarded(host, *p)).collect()
}
/// Single-process actions on a guarded process need `confirm_pid == pid` (the user typed it).
fn check_confirm(host: &str, pid: u32, confirm_pid: Option<u32>) -> Result<(), String> {
    if is_guarded(host, pid) && confirm_pid != Some(pid) {
        return Err(format!("PID {pid} is a Minecraft server: type its PID to confirm"));
    }
    Ok(())
}

/// Find `<gradle home>/wrapper/dists/gradle-<ver>-*/*/gradle-<ver>/bin/gradle` locally.
pub fn find_gradle_bin(home: &Path, ver: &str) -> Option<PathBuf> {
    let dists = home.join(".gradle/wrapper/dists");
    let prefix = format!("gradle-{ver}-");
    for e in std::fs::read_dir(dists).ok()?.flatten() {
        if !e.file_name().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        for h in std::fs::read_dir(e.path()).ok()?.flatten() {
            let b = h.path().join(format!("gradle-{ver}/bin/gradle"));
            if b.is_file() {
                return Some(b);
            }
        }
    }
    None
}

fn local_stop_cmd(bin: &Path) -> String {
    format!("{} --stop", ssh::quote(&bin.to_string_lossy()))
}
fn remote_stop_script(ver: &str) -> String {
    format!(
        "g=$(ls -d \"$HOME\"/.gradle/wrapper/dists/gradle-{v}-*/*/gradle-{v}/bin/gradle 2>/dev/null | head -1); [ -n \"$g\" ] || exit 42; \"$g\" --stop",
        v = ver
    )
}

/// `gradle --stop` with the matching distribution. Ok(true) = ran, Ok(false) = no matching distribution.
fn gradle_stop(host: &str, ver: &str) -> Result<bool, String> {
    if !ver.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("bad version".into());
    }
    if is_local(host) {
        let Some(home) = dirs::home_dir() else { return Ok(false) };
        let Some(bin) = find_gradle_bin(&home, ver) else { return Ok(false) };
        let cmd = local_stop_cmd(&bin);
        let out = Command::new("/bin/zsh").args(["-lc", &cmd]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(true) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    } else {
        let s = remote_stop_script(ver);
        let out = ssh::exec(host, &ssh::login_wrap(&s))?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(42) => Ok(false),
            _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        }
    }
}

/// Graceful stop of one process. Gradle: `gradle --stop` (stops every daemon of that version); else SIGTERM -> SIGKILL.
#[tauri::command]
pub async fn daemons_stop(host: String, pid: u32, kind: String, version: Option<String>, confirm_pid: Option<u32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_confirm(&host, pid, confirm_pid)?;
        if kind == "gradle" {
            if let Some(v) = &version {
                if gradle_stop(&host, v)? {
                    return Ok(format!("gradle {v} --stop"));
                }
            }
        }
        terminate(&host, &[pid])?;
        Ok("terminated".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn daemons_kill(host: String, pid: u32, confirm_pid: Option<u32>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_confirm(&host, pid, confirm_pid)?;
        kill_cmd(&host, "KILL", &[pid])
    }).await.map_err(|e| e.to_string())?
}

/// SIGTERM->SIGKILL for the given pids (used by "Stop all idle Gradle": must not touch busy daemons).
#[tauri::command]
pub async fn daemons_terminate(host: String, pids: Vec<u32>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || terminate(&host, &without_guarded(&host, &pids))).await.map_err(|e| e.to_string())?
}

/// Stop all Gradle daemons on the host: one `gradle --stop` per version, terminate the rest.
#[tauri::command]
pub async fn daemons_stop_all_gradle(host: String, daemons: Vec<(u32, Option<String>)>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut vers: Vec<String> = daemons.iter().filter_map(|d| d.1.clone()).collect();
        vers.sort();
        vers.dedup();
        let mut stopped = HashSet::new();
        let mut errs = vec![];
        for v in &vers {
            match gradle_stop(&host, v) {
                Ok(true) => {
                    stopped.insert(v.clone());
                }
                Ok(false) => {}
                Err(e) => errs.push(format!("{v}: {e}")),
            }
        }
        let rest: Vec<u32> = without_guarded(&host, &daemons.iter().filter(|d| d.1.as_ref().map_or(true, |v| !stopped.contains(v))).map(|d| d.0).collect::<Vec<_>>());
        terminate(&host, &rest)?;
        Ok(if errs.is_empty() { format!("{} versions stopped", stopped.len()) } else { errs.join("; ") })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- cleanup

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanItem {
    pub id: String,
    pub group: String, // daemon | caches | wrapper
    pub label: String,
    pub path: String,
    pub bytes: Option<u64>,
    pub cleanable: bool,
    pub note: Option<String>,
}

#[derive(Default, Debug)]
struct RawLayout {
    daemon: Vec<(String, String)>,
    caches: Vec<(String, String)>,
    dists: Vec<(String, String)>,
    refs: Vec<String>,
}

/// Roots are injectable so tests can run against fake directories.
pub struct Env {
    pub home: PathBuf,
    pub trash: PathBuf,
    pub scan_roots: Vec<(PathBuf, usize)>,
}
impl Env {
    pub fn real_with(extra: &[String]) -> Env {
        let mut e = Env::real();
        e.scan_roots.extend(extra.iter().filter(|x| !x.trim().is_empty()).map(|x| (PathBuf::from(x.trim()), 6)));
        e
    }
    pub fn real() -> Env {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        Env {
            trash: home.join(".Trash"),
            scan_roots: vec![(home.join("IdeaProjects"), 6), (home.join("PycharmProjects"), 6), (home.clone(), 3)],
            home,
        }
    }
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "Library", ".gradle", ".Trash", "build", "target", ".cache", ".npm", ".cargo", ".rustup",
    ".m2", "Applications", ".venv", "venv", ".pyenv", ".nvm", "Pictures", "Movies", "Music", ".idea", ".next", "dist",
];

fn subdirs(p: &Path) -> Vec<(String, String)> {
    let mut v: Vec<_> = std::fs::read_dir(p)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().to_string_lossy().into_owned()))
        .collect();
    v.sort();
    v
}

fn walk_refs(dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, out: &mut Vec<String>) {
    if !seen.insert(dir.to_path_buf()) {
        return;
    }
    if let Ok(s) = std::fs::read_to_string(dir.join("gradle/wrapper/gradle-wrapper.properties")) {
        out.extend(s.lines().filter(|l| l.starts_with("distributionUrl")).map(String::from));
    }
    if depth == 0 {
        return;
    }
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(t) = e.file_type() else { continue };
        if !t.is_dir() {
            continue;
        }
        let n = e.file_name();
        let n = n.to_string_lossy();
        if SKIP_DIRS.contains(&n.as_ref()) || n.starts_with('.') {
            continue;
        }
        walk_refs(&e.path(), depth - 1, seen, out);
    }
}

fn raw_local(env: &Env) -> RawLayout {
    let g = env.home.join(".gradle");
    let mut r = RawLayout {
        daemon: subdirs(&g.join("daemon")),
        caches: subdirs(&g.join("caches")),
        dists: subdirs(&g.join("wrapper/dists")),
        refs: vec![],
    };
    let mut seen = HashSet::new();
    for (root, d) in &env.scan_roots {
        walk_refs(root, *d, &mut seen, &mut r.refs);
    }
    r
}

fn is_version(s: &str) -> bool {
    s.chars().next().map_or(false, |c| c.is_ascii_digit()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn classify_clean(raw: &RawLayout, running: &HashSet<String>) -> Vec<CleanItem> {
    let mut v = vec![];
    let any_running = !running.is_empty();
    for (n, p) in &raw.daemon {
        let run = running.contains(n);
        v.push(CleanItem {
            id: format!("daemon:{n}"), group: "daemon".into(), label: format!("daemon/{n} (logs, registry)"), path: p.clone(),
            bytes: None, cleanable: !run, note: run.then(|| "daemon of this version is running".into()),
        });
    }
    for (n, p) in &raw.caches {
        let (cleanable, note) = if is_version(n) {
            let run = running.contains(n);
            (!run, run.then(|| "daemon of this version is running".to_string()))
        } else {
            (!any_running, any_running.then(|| "Gradle daemons are running".to_string()))
        };
        v.push(CleanItem { id: format!("caches:{n}"), group: "caches".into(), label: format!("caches/{n}"), path: p.clone(), bytes: None, cleanable, note });
    }
    for (n, p) in &raw.dists {
        let ver = n.strip_prefix("gradle-").unwrap_or(n).trim_end_matches("-bin").trim_end_matches("-all").to_string();
        let run = running.contains(&ver);
        let used = raw.refs.iter().any(|u| u.contains(&format!("{n}.zip")));
        let note = if run { Some("daemon of this version is running".into()) } else if used { Some("referenced by a project".into()) } else { None };
        v.push(CleanItem {
            id: format!("wrapper:{n}"), group: "wrapper".into(), label: format!("wrapper/dists/{n}"), path: p.clone(),
            bytes: None, cleanable: !run && !used, note,
        });
    }
    v
}

/// Size on disk (allocated blocks) of a tree; symlinks not followed.
pub fn dir_size(p: &Path, cancel: &AtomicBool) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let mut total = 0u64;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return total;
        }
        let Ok(md) = std::fs::symlink_metadata(&d) else { continue };
        total += md.blocks() * 512;
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    stack.push(e.path());
                }
            }
        }
    }
    total
}

fn scans() -> &'static Mutex<HashMap<String, std::sync::Arc<AtomicBool>>> {
    static S: OnceLock<Mutex<HashMap<String, std::sync::Arc<AtomicBool>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Shell word list of directories to scan for gradle-wrapper references: `$HOME` plus the configured extra roots
/// (default `/opt/mc`; every root is skipped by the script when it does not exist).
fn remote_roots(extra: &[String]) -> String {
    let mut v = vec!["\"$HOME\"".to_string()];
    if extra.is_empty() {
        v.push("/opt/mc".into());
    } else {
        v.extend(extra.iter().filter(|e| !e.trim().is_empty()).map(|e| ssh::quote(e.trim())));
    }
    v.join(" ")
}

fn remote_raw(host: &str, extra: &[String]) -> Result<RawLayout, String> {
    let roots = remote_roots(extra);
    let script = r#"g="$HOME/.gradle"
for d in daemon caches wrapper/dists; do for p in "$g/$d"/*/; do [ -d "$p" ] && printf '%s\t%s\n' "$d" "${p%/}"; done; done
for r in @ROOTS@; do [ -d "$r" ] && find "$r" -maxdepth 6 \( -name node_modules -o -name .git -o -name .gradle -o -name build -o -name .cache -o -name .npm -o -name target \) -prune -o -path '*/gradle/wrapper/gradle-wrapper.properties' -print0 2>/dev/null | xargs -0 -r grep -h '^distributionUrl' 2>/dev/null | sed 's/^/R\t/'; done; true"#
        .replace("@ROOTS@", &roots);
    let out = ssh::exec(host, &ssh::login_wrap(&script))?;
    let mut r = RawLayout::default();
    for l in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((k, rest)) = l.split_once('\t') else { continue };
        let name = rest.rsplit('/').next().unwrap_or(rest).to_string();
        match k {
            "daemon" => r.daemon.push((name, rest.into())),
            "caches" => r.caches.push((name, rest.into())),
            "wrapper/dists" => r.dists.push((name, rest.into())),
            "R" => r.refs.push(rest.into()),
            _ => {}
        }
    }
    Ok(r)
}

fn running_versions(host: &str) -> Result<HashSet<String>, String> {
    let rows: Vec<(String, Option<String>)> = if is_local(host) {
        summary_local().into_iter().map(|x| (x.1.to_string(), x.2)).collect()
    } else {
        scan_remote(host)?.into_iter().map(|r| (r.kind, r.version)).collect()
    };
    Ok(rows.into_iter().filter(|r| r.0 == "gradle").filter_map(|r| r.1).collect())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanEvent {
    host: String,
    scan: String,
    items: Option<Vec<CleanItem>>,
    id: Option<String>,
    bytes: Option<u64>,
    done: bool,
    error: Option<String>,
    progress: Option<(u32, u32)>,
}
impl ScanEvent {
    fn new(host: &str, scan: &str) -> Self {
        ScanEvent { host: host.into(), scan: scan.into(), items: None, id: None, bytes: None, done: false, error: None, progress: None }
    }
}

/// Starts a background scan; results stream as `daemons://cleanup` events. Returns immediately.
#[tauri::command]
pub fn daemons_cleanup_scan(app: tauri::AppHandle, host: String, scan: String, extra_roots: Option<Vec<String>>) {
    let extra = extra_roots.unwrap_or_default();
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    if let Some(old) = scans().lock().unwrap().insert(host.clone(), cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |e: ScanEvent| {
            let _ = app.emit("daemons://cleanup", e);
        };
        let res: Result<(), String> = (|| {
            let running = running_versions(&host)?;
            let raw = if is_local(&host) { raw_local(&Env::real_with(&extra)) } else { remote_raw(&host, &extra)? };
            let items = classify_clean(&raw, &running);
            let mut e = ScanEvent::new(&host, &scan);
            e.items = Some(items.clone());
            emit(e);
            let total = items.len() as u32;
            if is_local(&host) {
                for (i, it) in items.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let b = dir_size(Path::new(&it.path), &cancel);
                    let mut e = ScanEvent::new(&host, &scan);
                    e.id = Some(it.id.clone());
                    e.bytes = Some(b);
                    e.progress = Some((i as u32 + 1, total));
                    emit(e);
                }
            } else {
                let by_path: HashMap<&str, &CleanItem> = items.iter().map(|i| (i.path.as_str(), i)).collect();
                let args = items.iter().map(|i| ssh::quote(&i.path)).collect::<Vec<_>>().join(" ");
                let cmd = format!("for p in {args}; do du -sk -- \"$p\" 2>/dev/null; done");
                let mut c = ssh::command(&host, false);
                c.arg(cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
                let mut child = c.spawn().map_err(|e| e.to_string())?;
                let out = child.stdout.take().ok_or("no stdout")?;
                let pid = procs::register("ssh", &format!("du {host}"), child);
                let mut n = 0;
                for l in BufReader::new(out).lines().map_while(Result::ok) {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let Some((kb, p)) = l.split_once('\t') else { continue };
                    if let Some(it) = by_path.get(p) {
                        n += 1;
                        let mut e = ScanEvent::new(&host, &scan);
                        e.id = Some(it.id.clone());
                        e.bytes = Some(kb.trim().parse::<u64>().unwrap_or(0) * 1024);
                        e.progress = Some((n, total));
                        emit(e);
                    }
                }
                procs::kill(pid);
            }
            Ok(())
        })();
        let mut e = ScanEvent::new(&host, &scan);
        e.done = true;
        e.error = res.err();
        emit(e);
    });
}

#[tauri::command]
pub fn daemons_cleanup_cancel(host: String) {
    if let Some(c) = scans().lock().unwrap().remove(&host) {
        c.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub moved: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

/// Move `to_trash` to the trash dir (rename, with a timestamp suffix on name clash).
pub fn trash_local(trash: &Path, p: &Path) -> Result<(), String> {
    std::fs::create_dir_all(trash).map_err(|e| e.to_string())?;
    let name = p.file_name().ok_or("no name")?.to_string_lossy().into_owned();
    let mut dest = trash.join(&name);
    if dest.exists() {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        dest = trash.join(format!("{name} {ts}"));
    }
    std::fs::rename(p, &dest).map_err(|e| e.to_string())
}

pub fn clean_local(env: &Env, running: &HashSet<String>, paths: &[String]) -> CleanResult {
    let items = classify_clean(&raw_local(env), running);
    let mut res = CleanResult { moved: vec![], skipped: vec![] };
    for p in paths {
        match items.iter().find(|i| &i.path == p) {
            None => res.skipped.push((p.clone(), "not a known cleanup target".into())),
            Some(i) if !i.cleanable => res.skipped.push((p.clone(), i.note.clone().unwrap_or_else(|| "in use".into()))),
            Some(_) => match trash_local(&env.trash, Path::new(p)) {
                Ok(()) => res.moved.push(p.clone()),
                Err(e) => res.skipped.push((p.clone(), e)),
            },
        }
    }
    res
}

#[tauri::command]
pub async fn daemons_cleanup_run(host: String, paths: Vec<String>, extra_roots: Option<Vec<String>>) -> Result<CleanResult, String> {
    let extra = extra_roots.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let running = running_versions(&host)?;
        if is_local(&host) {
            return Ok(clean_local(&Env::real_with(&extra), &running, &paths));
        }
        let items = classify_clean(&remote_raw(&host, &extra)?, &running);
        let mut res = CleanResult { moved: vec![], skipped: vec![] };
        let mut ok = vec![];
        for p in &paths {
            match items.iter().find(|i| &i.path == p) {
                None => res.skipped.push((p.clone(), "not a known cleanup target".into())),
                Some(i) if !i.cleanable => res.skipped.push((p.clone(), i.note.clone().unwrap_or_else(|| "in use".into()))),
                Some(_) => ok.push(p.clone()),
            }
        }
        if !ok.is_empty() {
            let args = ok.iter().map(|p| ssh::quote(p)).collect::<Vec<_>>().join(" ");
            let script = format!(
                "T=\"$HOME/.local/share/Trash/files\"; mkdir -p \"$T\"; for p in {args}; do n=$(basename \"$p\"); d=\"$T/$n\"; [ -e \"$d\" ] && d=\"$T/$n.$(date +%s)\"; mv -- \"$p\" \"$d\" && echo \"OK\t$p\" || echo \"ERR\t$p\"; done"
            );
            let out = ssh::exec(&host, &script)?;
            for l in String::from_utf8_lossy(&out.stdout).lines() {
                match l.split_once('\t') {
                    Some(("OK", p)) => res.moved.push(p.into()),
                    Some((_, p)) => res.skipped.push((p.into(), "mv failed".into())),
                    _ => {}
                }
            }
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn classifies() {
        let g = s(&["/jdk/bin/java", "-cp", "/h/.gradle/wrapper/dists/gradle-9.8.0-bin/x/gradle-9.8.0/lib/a.jar", GRADLE_MAIN, "9.8.0"]);
        assert_eq!(classify("java", &g).unwrap().0, "gradle");
        assert_eq!(classify("java", &g).unwrap().1.as_deref(), Some("9.8.0"));
        let k = s(&["java", "-cp", "kotlin-compiler-embeddable-2.0.21.jar", "org.jetbrains.kotlin.daemon.KotlinCompileDaemon"]);
        let c = classify("java", &k).unwrap();
        assert_eq!((c.0, c.1.as_deref()), ("kotlin", Some("2.0.21")));
        assert_eq!(classify("rust-analyzer", &s(&["rust-analyzer"])).unwrap().0, "lsp");
        assert_eq!(classify("claude", &s(&["claude"])).unwrap().0, "claude");
        assert_eq!(classify("java", &s(&["java", "-Xmx1g", "-jar", "/x/server.jar"])).unwrap().2, "server.jar");
        assert!(classify("zsh", &s(&["zsh"])).is_none());
    }

    #[test]
    fn minecraft_is_labelled_and_guarded() {
        let mc = s(&["java", "-XX:+UseG1GC", "-Dusing.aikars.flags=https://mcflags.emc.gs", "-Xmx8G", "-jar", "./fabric-server-mc.1.20.1-loader.0.18.4-launcher.1.1.2.jar"]);
        let c = classify("java", &mc).unwrap();
        assert_eq!(c.0, "minecraft");
        assert_eq!(c.2, "Minecraft server (fabric-server-mc.1.20.1-loader.0.18.4-launcher.1.1.2.jar)");
        assert_eq!(classify("java", &s(&["java", "net.minecraft.server.Main"])).unwrap().0, "minecraft");
        assert_eq!(classify("java", &s(&["java", "-jar", "paper-1.21.jar"])).unwrap().0, "minecraft");
        assert_eq!(classify("java", &s(&["java", "-jar", "app.jar"])).unwrap().0, "java");
        // guard bookkeeping
        state().lock().unwrap().guarded.insert(("mc".into(), 4242));
        assert!(is_guarded("mc", 4242) && !is_guarded("mc", 1) && !is_guarded("local", 4242));
        assert_eq!(without_guarded("mc", &[1, 4242, 7]), vec![1, 7]);
        assert!(check_confirm("mc", 4242, None).is_err());
        assert!(check_confirm("mc", 4242, Some(1)).is_err());
        assert!(check_confirm("mc", 4242, Some(4242)).is_ok());
        assert!(check_confirm("mc", 1, None).is_ok());
    }

    #[test]
    fn gradle_stop_commands() {
        assert_eq!(local_stop_cmd(Path::new("/h/.gradle/wrapper/dists/gradle-9.8.0-bin/x/gradle-9.8.0/bin/gradle")), "'/h/.gradle/wrapper/dists/gradle-9.8.0-bin/x/gradle-9.8.0/bin/gradle' --stop");
        let r = remote_stop_script("9.8.0");
        assert!(r.contains("gradle-9.8.0-*/*/gradle-9.8.0/bin/gradle") && r.ends_with("--stop") && r.contains("exit 42"));
        assert!(gradle_stop("local", "9.8.0; rm -rf /").is_err());
        assert_eq!(remote_roots(&[]), "\"$HOME\" /opt/mc");
        assert_eq!(remote_roots(&["/srv/mc".into(), "/data x".into()]), "\"$HOME\" '/srv/mc' '/data x'");
    }

    #[test]
    fn cleanup_on_fake_dirs() {
        let root = std::env::temp_dir().join(format!("atelier-daemons-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let h = root.join("home");
        for d in [
            ".gradle/daemon/9.8.0", ".gradle/daemon/8.4", ".gradle/caches/modules-2", ".gradle/caches/9.8.0",
            ".gradle/caches/8.4", ".gradle/wrapper/dists/gradle-9.8.0-bin/h/gradle-9.8.0/bin",
            ".gradle/wrapper/dists/gradle-8.4-bin", ".gradle/wrapper/dists/gradle-7.0-bin", "proj/gradle/wrapper",
            "proj/node_modules/x/gradle/wrapper",
        ] {
            std::fs::create_dir_all(h.join(d)).unwrap();
        }
        std::fs::write(h.join(".gradle/daemon/8.4/daemon.log"), vec![0u8; 8192]).unwrap();
        std::fs::write(h.join(".gradle/wrapper/dists/gradle-9.8.0-bin/h/gradle-9.8.0/bin/gradle"), "#!/bin/sh").unwrap();
        std::fs::write(h.join("proj/gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=https\\://x/gradle-8.4-bin.zip\n").unwrap();
        std::fs::write(h.join("proj/node_modules/x/gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=https\\://x/gradle-7.0-bin.zip\n").unwrap();
        let env = Env { home: h.clone(), trash: root.join("trash"), scan_roots: vec![(h.clone(), 3)] };
        assert!(find_gradle_bin(&h, "9.8.0").is_some());
        assert!(find_gradle_bin(&h, "1.0").is_none());
        let running: HashSet<String> = ["9.8.0".to_string()].into();
        let items = classify_clean(&raw_local(&env), &running);
        let by = |id: &str| items.iter().find(|i| i.id == id).unwrap().cleanable;
        assert!(!by("daemon:9.8.0") && by("daemon:8.4"));
        assert!(!by("caches:modules-2") && !by("caches:9.8.0") && by("caches:8.4"));
        assert!(!by("wrapper:gradle-9.8.0-bin")); // running
        assert!(!by("wrapper:gradle-8.4-bin")); // referenced
        assert!(by("wrapper:gradle-7.0-bin")); // node_modules ref ignored
        let none: HashSet<String> = HashSet::new();
        assert!(classify_clean(&raw_local(&env), &none).iter().find(|i| i.id == "caches:modules-2").unwrap().cleanable);
        let r = clean_local(
            &env,
            &running,
            &[h.join(".gradle/daemon/8.4").to_string_lossy().into(), h.join(".gradle/daemon/9.8.0").to_string_lossy().into(), "/etc".into()],
        );
        assert_eq!(r.moved.len(), 1);
        assert_eq!(r.skipped.len(), 2);
        assert!(!h.join(".gradle/daemon/8.4").exists() && h.join(".gradle/daemon/9.8.0").exists());
        assert!(root.join("trash/8.4/daemon.log").exists());
        let sz = dir_size(&root.join("trash/8.4"), &AtomicBool::new(false));
        assert!(sz >= 8192);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore]
    fn live() {
        for host in ["local", "mc"] {
            for round in 0..3 {
                let t = Instant::now();
                let rows = if host == "local" { scan_local() } else { scan_remote(host).unwrap() };
                println!("{host} refresh#{round}: {} rows in {} ms", rows.len(), t.elapsed().as_millis());
                if round == 2 {
                    for r in &rows {
                        println!("  {} {:7} v={:?} rss={}MB cpu={:.1} up={}s busy={:?} cwd={:?} {}", r.pid, r.kind, r.version, r.rss >> 20, r.cpu, r.uptime_secs, r.busy, r.cwd, r.label);
                    }
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        let t = Instant::now();
        let v = summary_local();
        println!("summary: {} in {} ms, rss={}", v.len(), t.elapsed().as_millis(), v.iter().map(|x| x.3).sum::<u64>());
        let t = Instant::now();
        let _ = summary_local();
        println!("summary#2 {} ms", t.elapsed().as_millis());
        let env = Env::real();
        let t = Instant::now();
        let raw = raw_local(&env);
        let run = running_versions("local").unwrap();
        let items = classify_clean(&raw, &run);
        println!("local raw+classify {} ms, running={:?}, refs={}", t.elapsed().as_millis(), run, raw.refs.len());
        let c = AtomicBool::new(false);
        for it in &items {
            let t = Instant::now();
            let b = dir_size(Path::new(&it.path), &c);
            println!("  {:40} {:>8} MB cleanable={} {:?} ({} ms)", it.label, b >> 20, it.cleanable, it.note, t.elapsed().as_millis());
        }
        let t = Instant::now();
        let raw = remote_raw("mc", &[]).unwrap();
        let run = running_versions("mc").unwrap();
        let items = classify_clean(&raw, &run);
        println!("mc raw {} ms running={:?} refs={}", t.elapsed().as_millis(), run, raw.refs.len());
        for it in &items { println!("  {} cleanable={} {:?}", it.label, it.cleanable, it.note); }
    }
}
