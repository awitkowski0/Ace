//! Single-file hot swap for debugged Gradle runs (docs/GRADLE.md "Debug & hot swap").
//!
//!   hotswap_jdks()                              installed JDKs / JetBrains Runtimes (`java_home -V`, IntelliJ's bundled jbr, ~/Library/Java, ~/.gradle/jdks)
//!   gradle_debug_prepare({port, enhanced})      writes `<app data>/gradle/ace-debug-<port>.gradle` (init script that injects JDWP) -> {initScript, jbrPaths, ...}
//!   gradle_debug_cleanup(port)                  removes it
//!   hotswap_run({id, file, root, ...})          resolve the compile settings of the file's source set (Gradle `aceDumpClasspath`, cached per debug session),
//!                                               compile ONLY that file with the matching JDK's javac into a temp dir (nothing is copied into the build
//!                                               outputs), RedefineClasses every produced class that is loaded in the VM, report. Progress: `hotswap://progress/<id>`.
//!   hotswap_forget(id)                          drops the cached classpaths of a session
use crate::jdwp::{self, redefine_message, JdwpErr};
use crate::runner::{self, Spec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewWindow};

const DEBUG_INIT: &str = include_str!("gradle/ace-debug.gradle");
const DUMP_INIT: &str = include_str!("gradle/ace-dump.gradle");
const DUMP_MARKER: &str = "ACE-CP-JSON:";

// ---------------------------------------------------------------- JDK discovery

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Jdk {
    pub home: String,
    pub major: u32,
    pub version: String,
    pub vendor: String,
    pub jbr: bool,
    pub has_javac: bool,
    /// lib/hotswap/hotswap-agent-core.jar of a JBR, when present (never downloaded)
    pub agent: Option<String>,
}

fn parse_major(v: &str) -> u32 {
    let mut it = v.split(|c: char| c == '.' || c == '_' || c == '-' || c == '+');
    let first: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    if first == 1 {
        it.next().and_then(|x| x.parse().ok()).unwrap_or(1)
    } else {
        first
    }
}

fn release_value(text: &str, key: &str) -> String {
    text.lines()
        .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
        .map(|v| v.trim().trim_matches('"').to_string())
        .unwrap_or_default()
}

fn inspect(home: &Path) -> Option<Jdk> {
    let rel = std::fs::read_to_string(home.join("release")).ok()?;
    let version = release_value(&rel, "JAVA_VERSION");
    if version.is_empty() {
        return None;
    }
    let vendor = release_value(&rel, "IMPLEMENTOR");
    let hs = home.join("lib/hotswap/hotswap-agent-core.jar");
    let jbr = vendor.contains("JetBrains") || home.to_string_lossy().contains("jbr");
    Some(Jdk {
        home: home.to_string_lossy().into_owned(),
        major: parse_major(&version),
        version,
        vendor,
        jbr,
        has_javac: home.join("bin/javac").is_file(),
        agent: if hs.is_file() { Some(hs.to_string_lossy().into_owned()) } else { None },
    })
}

fn home_of(p: &Path) -> Option<PathBuf> {
    for c in [p.join("Contents/Home"), p.to_path_buf()] {
        if c.join("release").is_file() {
            return Some(c);
        }
    }
    None
}

pub fn detect_jdks() -> Vec<Jdk> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(o) = std::process::Command::new("/usr/libexec/java_home").arg("-V").stdin(std::process::Stdio::null()).output() {
        // the list goes to stderr: `    21.0.9 (arm64) "JetBrains s.r.o." - "JBR-21..." /path/Home`
        for l in String::from_utf8_lossy(&o.stderr).lines().chain(String::from_utf8_lossy(&o.stdout).lines()) {
            if let Some(i) = l.rfind(" /") {
                let p = l[i + 1..].trim();
                if p.starts_with('/') && !l.trim_start().starts_with("Matching") {
                    cands.push(p.into());
                }
            }
        }
    }
    let mut dirs: Vec<PathBuf> = vec!["/Library/Java/JavaVirtualMachines".into()];
    if let Some(h) = dirs::home_dir() {
        dirs.push(h.join("Library/Java/JavaVirtualMachines"));
        dirs.push(h.join(".gradle/jdks"));
        dirs.push(h.join(".sdkman/candidates/java"));
    }
    for d in dirs {
        if let Ok(rd) = std::fs::read_dir(d) {
            cands.extend(rd.flatten().map(|e| e.path()));
        }
    }
    // IDEs ship their own JetBrains Runtime
    if let Ok(rd) = std::fs::read_dir("/Applications") {
        for e in rd.flatten() {
            cands.push(e.path().join("Contents/jbr"));
            cands.push(e.path().join("Contents/jre"));
        }
    }
    if let Some(j) = std::env::var_os("JAVA_HOME") {
        cands.push(j.into());
    }
    let mut out: Vec<Jdk> = Vec::new();
    for c in cands {
        let Some(h) = home_of(&c) else { continue };
        let canon = std::fs::canonicalize(&h).unwrap_or(h.clone());
        if out.iter().any(|j| std::fs::canonicalize(&j.home).map(|x| x == canon).unwrap_or(false)) {
            continue;
        }
        if let Some(j) = inspect(&h) {
            out.push(j);
        }
    }
    out.sort_by(|a, b| b.major.cmp(&a.major).then(a.home.cmp(&b.home)));
    out
}

/// The JDK whose javac compiles for `--release release`: prefer exactly `prefer` (the toolchain), else the smallest installed JDK that is
/// at least `min`. JBRs rank after plain JDKs of the same major (they are only needed as runtimes).
pub fn pick_javac(jdks: &[Jdk], prefer: Option<u32>, min: u32) -> Option<Jdk> {
    let ok = |j: &&Jdk| j.has_javac && j.major >= min;
    let mut v: Vec<&Jdk> = jdks.iter().filter(ok).collect();
    v.sort_by_key(|j| (Some(j.major) != prefer, j.major, j.jbr));
    v.first().map(|j| (*j).clone())
}

/// The JBR to use per Java major (first match wins: user-installed before IDE-bundled, since the list is sorted by path).
pub fn jbr_map(jdks: &[Jdk]) -> Vec<(u32, Jdk)> {
    let mut m: Vec<(u32, Jdk)> = Vec::new();
    for j in jdks.iter().filter(|j| j.jbr) {
        if !m.iter().any(|(k, _)| *k == j.major) {
            m.push((j.major, j.clone()));
        }
    }
    m
}

#[tauri::command]
pub async fn hotswap_jdks() -> Result<Vec<Jdk>, String> {
    tauri::async_runtime::spawn_blocking(detect_jdks).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- the debug init script

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareArgs {
    pub port: u16,
    pub enhanced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub init_script: String,
    /// `-Dorg.gradle.java.installations.paths=…` value (enhanced mode), else empty
    pub jbr_paths: String,
    /// Java majors a JetBrains Runtime was found for
    pub jbr_majors: Vec<u32>,
    /// human note for the console when Enhanced HotSwap could not be enabled
    pub note: Option<String>,
}

fn gradle_dir() -> Result<PathBuf, String> {
    let d = crate::pstore::data_dir().join("gradle");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn render_debug_script(port: u16, self_path: &str, jbrs: &[(u32, Jdk)], agent: Option<&str>) -> String {
    let jb = jbrs.iter().map(|(m, j)| format!("{m}={}", j.home)).collect::<Vec<_>>().join(",");
    DEBUG_INIT
        .replace("@PORT@", &port.to_string())
        .replace("@SELF@", &self_path.replace('\\', "\\\\").replace('\'', "\\'"))
        .replace("@JBRS@", &jb.replace('\\', "\\\\").replace('\'', "\\'"))
        .replace("@AGENT@", &agent.unwrap_or("").replace('\\', "\\\\").replace('\'', "\\'"))
}

#[tauri::command]
pub async fn gradle_debug_prepare(args: PrepareArgs) -> Result<Prepared, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = gradle_dir()?;
        // stale scripts of earlier sessions (a crashed app never cleaned up)
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d > Duration::from_secs(2 * 86400)).unwrap_or(false);
                if n.starts_with("ace-debug-") && old {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let path = dir.join(format!("ace-debug-{}.gradle", args.port));
        let (jbrs, note) = if args.enhanced {
            let m = jbr_map(&detect_jdks());
            if m.is_empty() {
                (vec![], Some("Enhanced HotSwap is on, but no JetBrains Runtime was found (looked at java_home, ~/Library/Java/JavaVirtualMachines, ~/.gradle/jdks and the JBR bundled with IntelliJ IDEA). The game runs on its normal JDK.".to_string()))
            } else {
                (m, None)
            }
        } else {
            (vec![], None)
        };
        let agent = jbrs.iter().find_map(|(_, j)| j.agent.clone());
        let script = render_debug_script(args.port, &path.to_string_lossy(), &jbrs, agent.as_deref());
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        Ok(Prepared {
            init_script: path.to_string_lossy().into_owned(),
            jbr_paths: jbrs.iter().map(|(_, j)| j.home.clone()).collect::<Vec<_>>().join(","),
            jbr_majors: jbrs.iter().map(|(m, _)| *m).collect(),
            note,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn gradle_debug_cleanup(port: u16) {
    if let Ok(d) = gradle_dir() {
        let _ = std::fs::remove_file(d.join(format!("ace-debug-{port}.gradle")));
    }
}

// ---------------------------------------------------------------- classpath dump (cached per debug session)

fn cache() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

#[tauri::command]
pub fn hotswap_forget(id: String) {
    let p = format!("{id}\u{0}");
    cache().lock().unwrap().retain(|k, _| !k.starts_with(&p));
}

/// Nearest ancestor directory of `file` (up to and including `root`) that holds a settings.gradle[.kts]: the Gradle build that owns it.
pub fn build_dir_of(file: &Path, root: &Path) -> PathBuf {
    let mut d = file.parent();
    while let Some(x) = d {
        if x.join("settings.gradle").is_file() || x.join("settings.gradle.kts").is_file() {
            return x.to_path_buf();
        }
        if x == root {
            break;
        }
        d = x.parent();
    }
    root.to_path_buf()
}

fn dump_script(init: &str, file: &str, root: &str, pin: Option<&str>, offline: bool) -> String {
    let q = crate::remote::ssh::quote;
    format!(
        r#"G=./gradlew; [ -x "$G" ] || G={root}/gradlew; [ -x "$G" ] || G=gradle
exec "$G" -q --console=plain {off}--no-configuration-cache -Dorg.gradle.configureondemand=false --init-script {init} -Pace.file={file} {pin}aceDumpClasspath"#,
        pin = pin.map(|p| format!("{} ", q(&format!("-Pace.project={p}")))).unwrap_or_default(),
        root = q(root),
        off = if offline { "--offline " } else { "" },
        init = q(init),
        file = q(file),
    )
}

fn run_dump(owner: &str, build: &Path, root: &Path, file: &str, pin: Option<&str>, progress: &dyn Fn(&str)) -> Result<Value, String> {
    let dir = gradle_dir()?;
    let init = dir.join("ace-dump.gradle");
    if std::fs::read_to_string(&init).map(|s| s != DUMP_INIT).unwrap_or(true) {
        std::fs::write(&init, DUMP_INIT).map_err(|e| e.to_string())?;
    }
    let mut last_err = String::new();
    for offline in [true, false] {
        progress(&format!("Resolving the compile classpath of {} with Gradle{}…", file.rsplit('/').next().unwrap_or(file), if offline { " (offline)" } else { " (online)" }));
        let sp = Spec {
            host: "local".into(),
            cwd: build.to_string_lossy().into_owned(),
            shell: Some(dump_script(&init.to_string_lossy(), file, &root.to_string_lossy(), pin, offline)),
            ..Default::default()
        };
        let o = runner::exec(owner, &sp, None, Duration::from_secs(20 * 60))?;
        if let Some(line) = o.stdout.lines().find(|l| l.starts_with(DUMP_MARKER)) {
            return serde_json::from_str(&line[DUMP_MARKER.len()..]).map_err(|e| format!("unreadable classpath dump: {e}"));
        }
        let mut text = o.stdout.trim().to_string();
        if !o.stderr.trim().is_empty() {
            text.push('\n');
            text.push_str(o.stderr.trim());
        }
        last_err = text.lines().rev().take(25).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        let looks_offline = {
            let l = text.to_lowercase();
            l.contains("offline") || l.contains("no cached version") || l.contains("could not resolve") || l.contains("could not download") || l.contains("unknownhost")
        };
        if !offline || !looks_offline {
            break;
        }
    }
    Err(format!("Gradle could not resolve the compile classpath:\n{last_err}"))
}

// ---------------------------------------------------------------- compile

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotswapArgs {
    /// the jdwp attach session
    pub id: String,
    pub file: String,
    pub root: String,
    /// force a fresh classpath dump
    #[serde(default)]
    pub refresh: bool,
    /// the run uses Enhanced HotSwap (a JBR with -XX:+AllowEnhancedClassRedefinition): the JDWP capability bits do not say so
    #[serde(default)]
    pub enhanced: bool,
    /// resolve + compile only (no VM needed, nothing redefined): QA / "does this file compile with the build's settings"
    #[serde(default)]
    pub dry_run: bool,
    /// project paths whose tasks ran in this Gradle run (`> Task :compileJava` lines): a hint for which of several projects the game uses
    #[serde(default)]
    pub ran: Vec<String>,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HotswapResult {
    pub ok: bool,
    /// resolve | compile | redefine | done
    pub stage: String,
    pub message: String,
    pub redefined: Vec<String>,
    pub skipped: Vec<String>,
    pub warnings: Vec<String>,
    /// javac output (clickable `file:line: error:` lines)
    pub output: String,
    pub error_code: Option<u16>,
    pub error_name: Option<String>,
    pub elapsed_ms: u64,
    pub compiled: usize,
    pub javac: String,
    pub release: u32,
    pub source_set: String,
    pub dumped: bool,
}

fn strs(v: &Value, k: &str) -> Vec<String> {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn num(v: &Value, k: &str) -> Option<u32> {
    match v.get(k)? {
        Value::Number(n) => n.as_u64().map(|x| x as u32),
        Value::String(s) if !s.is_empty() => Some(parse_major(s)),
        _ => None,
    }
}

/// Every `(project dump, source set entry)` of the cached dumps whose source dirs contain `file` (full dumps only: they carry a classpath).
fn lookup_all(entries: &[Value], file: &Path) -> Vec<(Value, Value)> {
    let mut out = Vec::new();
    for d in entries {
        for ss in d.get("sourceSets").and_then(|s| s.as_array()).into_iter().flatten() {
            let hit = strs(ss, "srcDirs").iter().any(|s| file.starts_with(s));
            if hit && ss.get("classpath").is_some() {
                out.push((d.clone(), ss.clone()));
            }
        }
    }
    out
}

/// What tells which project/source set the RUNNING game was built from.
#[derive(Default, Clone)]
pub struct Evidence {
    /// the JVM's java.class.path
    pub vm_cp: Vec<String>,
    /// project paths whose tasks ran in this Gradle run
    pub ran: Vec<String>,
}
fn canon(p: &str) -> String {
    std::fs::canonicalize(p).map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|_| p.trim_end_matches('/').to_string())
}
/// Higher = more likely the one the game runs: its output dir is on the VM's class path (4), one of its tasks ran (2).
fn score(project: &str, output_dirs: &[String], ev: &Evidence) -> i32 {
    let cp: Vec<String> = ev.vm_cp.iter().map(|c| canon(c)).collect();
    let mut s = 0;
    if output_dirs.iter().any(|o| cp.contains(&canon(o))) {
        s += 4;
    }
    if ev.ran.iter().any(|p| p == project) {
        s += 2;
    }
    s
}
fn depth(p: &str) -> usize {
    Path::new(p).components().count()
}
/// Index of the best candidate and whether the evidence actually decided (false = tie, deepest project dir was taken).
fn choose(cands: &[(String, String, Vec<String>)], ev: &Evidence) -> (usize, bool) {
    let scores: Vec<i32> = cands.iter().map(|(p, _, o)| score(p, o, ev)).collect();
    let best = scores.iter().copied().max().unwrap_or(0);
    let top: Vec<usize> = (0..cands.len()).filter(|i| scores[*i] == best).collect();
    let i = *top.iter().max_by_key(|i| depth(&cands[**i].1)).unwrap_or(&0);
    (i, cands.len() == 1 || (top.len() == 1 && best > 0))
}

fn walk_classes(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_classes(&p, base, out);
        } else if p.extension().map(|x| x == "class").unwrap_or(false) {
            let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().trim_end_matches(".class").to_string();
            if rel.ends_with("package-info") || rel.ends_with("module-info") {
                continue;
            }
            out.push((format!("L{rel};"), p));
        }
    }
}

fn argfile_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Annotation processors whose output the code needs to compile (Lombok rewrites the AST; MapStruct / Dagger / AutoService / Immutables
/// generate classes). Everything else on a processor path (Mixin's refmap generator and its asm/mapping jars, Loom's mappings.jar) is
/// left out: it only produces build artefacts, and running it would write a refmap.
const NEEDED_PROCESSORS: [&str; 8] = ["lombok", "mapstruct", "dagger-compiler", "auto-service", "autoservice", "immutables", "record-builder", "querydsl-apt"];
fn processor_jars(path: &[String]) -> Vec<String> {
    path.iter()
        .filter(|p| {
            let n = p.rsplit('/').next().unwrap_or(p).to_lowercase();
            NEEDED_PROCESSORS.iter().any(|k| n.contains(k))
        })
        .cloned()
        .collect()
}

pub fn run_hotswap(app: &AppHandle, owner: &str, a: &HotswapArgs) -> HotswapResult {
    let t0 = Instant::now();
    let mut r = HotswapResult { stage: "resolve".into(), ..Default::default() };
    let emit = |line: &str| crate::windows::emit_window(app, owner, &format!("hotswap://progress/{}", a.id), line.to_string());
    let fail = |mut r: HotswapResult, stage: &str, msg: String| {
        r.ok = false;
        r.stage = stage.into();
        r.message = msg;
        r.elapsed_ms = t0.elapsed().as_millis() as u64;
        r
    };
    let file = Path::new(&a.file);
    if !a.file.ends_with(".java") {
        return fail(r, "resolve", "Hot swap works on .java files.".into());
    }
    let src = match std::fs::read_to_string(file) {
        Ok(s) => s,
        Err(e) => return fail(r, "resolve", format!("Cannot read {}: {e}", a.file)),
    };
    // the VM must be there before spending seconds in Gradle
    if !a.dry_run {
        if let Err(e) = jdwp::with_conn(&a.id, |_| Ok(())) {
            return fail(r, "resolve", e.message);
        }
    }
    // ---- 1. compile settings
    let root = PathBuf::from(&a.root);
    let build = build_dir_of(file, &root);
    let ck = format!("{}\u{0}{}", a.id, build.display());
    let ev = {
        let vm_cp = if a.dry_run { vec![] } else { jdwp::with_conn(&a.id, |c| Ok(c.info.lock().unwrap().class_path.clone())).unwrap_or_default() };
        Evidence { vm_cp, ran: a.ran.clone() }
    };
    // pick one of several (project, source set) pairs by evidence
    let pick_set = |all: Vec<(Value, Value)>| -> Option<((Value, Value), bool)> {
        if all.is_empty() {
            return None;
        }
        let c: Vec<(String, String, Vec<String>)> = all.iter().map(|(p, s)| (p.get("project").and_then(|x| x.as_str()).unwrap_or(":").to_string(), p.get("projectDir").and_then(|x| x.as_str()).unwrap_or("").to_string(), strs(s, "outputDirs"))).collect();
        let (i, decided) = choose(&c, &ev);
        Some((all[i].clone(), decided))
    };
    let cached = if a.refresh { None } else { pick_set(lookup_all(&cache().lock().unwrap().get(&ck).cloned().unwrap_or_default(), file)) };
    let ((proj, ss), decided) = match cached {
        Some(x) => x,
        None => {
            let mut dump = match run_dump(owner, &build, &root, &a.file, None, &emit) {
                Ok(d) => d,
                Err(e) => return fail(r, "resolve", e),
            };
            r.dumped = true;
            if dump.get("ok") != Some(&Value::Bool(true)) {
                let m = dump.get("error").and_then(|e| e.as_str()).unwrap_or("The file is not part of a Java source set.").to_string();
                return fail(r, "resolve", m);
            }
            let mut decided = true;
            if dump.get("needsChoice") == Some(&Value::Bool(true)) {
                // several projects compile this file (shared source): the one whose classes the running game uses
                let c: Vec<(String, String, Vec<String>)> = dump
                    .get("candidates")
                    .and_then(|x| x.as_array())
                    .into_iter()
                    .flatten()
                    .map(|x| (x.get("project").and_then(|v| v.as_str()).unwrap_or(":").to_string(), x.get("projectDir").and_then(|v| v.as_str()).unwrap_or("").to_string(), strs(x, "outputDirs")))
                    .collect();
                let (i, d) = choose(&c, &ev);
                decided = d;
                let pinned = c[i].0.clone();
                emit(&format!("{} projects compile this file; using {pinned}{}", c.len(), if d { "" } else { " (could not tell which one the running game uses)" }));
                dump = match run_dump(owner, &build, &root, &a.file, Some(&pinned), &emit) {
                    Ok(d) => d,
                    Err(e) => return fail(r, "resolve", e),
                };
                if dump.get("ok") != Some(&Value::Bool(true)) || dump.get("needsChoice") == Some(&Value::Bool(true)) {
                    return fail(r, "resolve", dump.get("error").and_then(|e| e.as_str()).unwrap_or("Gradle did not resolve the project.").to_string());
                }
            }
            cache().lock().unwrap().entry(ck.clone()).or_default().push(dump.clone());
            match pick_set(lookup_all(&[dump], file)) {
                Some((x, d)) => (x, d && decided),
                None => return fail(r, "resolve", "No source set of the build contains this file.".into()),
            }
        }
    };
    let _ = decided;
    if !decided && !a.dry_run {
        r.warnings.push("Several projects compile this file and Ace could not tell which one the running game was built from; it used the deepest one. If the reload misbehaves, run the build task of that project first.".into());
    }
    r.source_set = format!("{}:{}", proj.get("project").and_then(|x| x.as_str()).unwrap_or(":"), ss.get("name").and_then(|x| x.as_str()).unwrap_or("main"));
    let toolchain = num(&proj, "toolchain");
    let gradle_major = proj.get("gradleJava").and_then(|x| x.as_str()).map(parse_major).unwrap_or(17);
    let release = num(&ss, "release").or_else(|| num(&ss, "targetCompat")).or_else(|| num(&proj, "targetCompat")).or(toolchain).unwrap_or(gradle_major);
    r.release = release;
    let jdks = detect_jdks();
    let need = release.max(toolchain.unwrap_or(0)).max(8);
    let Some(jdk) = pick_javac(&jdks, toolchain.or(Some(release)), need) else {
        return fail(r, "compile", format!("No installed JDK (with javac) can compile for Java {release}. Installed: {}.", jdks.iter().map(|j| j.major.to_string()).collect::<Vec<_>>().join(", ")));
    };
    r.javac = format!("{} ({})", jdk.home, jdk.version);
    // ---- 2. compile only this file
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = crate::pstore::data_dir().join("hotswap").join(format!("{}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&tmp);
    if let Err(e) = std::fs::create_dir_all(tmp.join("out")) {
        return fail(r, "compile", format!("Cannot create a temp dir: {e}"));
    }
    let out_dirs: Vec<String> = strs(&ss, "outputDirs").into_iter().filter(|d| Path::new(d).is_dir()).collect();
    let mut cp: Vec<String> = out_dirs.clone();
    cp.extend(strs(&ss, "classpath"));
    let ap = strs(&ss, "annotationProcessorPath");
    let mut args: Vec<String> = vec!["-g".into(), "-encoding".into(), ss.get("encoding").and_then(|e| e.as_str()).unwrap_or("UTF-8").into(), "-Xlint:none".into(), "-implicit:none".into(), "--release".into(), release.to_string()];
    let procs = processor_jars(&ap);
    if procs.is_empty() {
        args.push("-proc:none".into());
    } else {
        // real processors (Lombok, MapStruct …): run them, generated sources go to the temp dir
        let gen = tmp.join("gen");
        let _ = std::fs::create_dir_all(&gen);
        args.extend(["-processorpath".into(), procs.join(":"), "-s".into(), gen.to_string_lossy().into_owned()]);
    }
    let build_args = strs(&ss, "compilerArgs");
    let mut it = build_args.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "-parameters" => args.push(x.clone()),
            "--add-exports" | "--add-opens" | "--add-reads" => {
                if let Some(v) = it.next() {
                    args.push(x.clone());
                    args.push(v.clone());
                }
            }
            _ => {}
        }
    }
    args.extend(["-d".into(), tmp.join("out").to_string_lossy().into_owned(), "-cp".into(), cp.join(":"), a.file.clone()]);
    let argfile = tmp.join("javac.args");
    let _ = std::fs::write(&argfile, args.iter().map(|x| argfile_quote(x)).collect::<Vec<_>>().join("\n"));
    emit(&format!("Compiling {} with javac {} (--release {release}, source set {})…", file.file_name().and_then(|n| n.to_str()).unwrap_or(""), jdk.version, r.source_set));
    let sp = Spec { host: "local".into(), cwd: build.to_string_lossy().into_owned(), argv: vec![format!("{}/bin/javac", jdk.home), format!("@{}", argfile.display())], ..Default::default() };
    let o = match runner::exec(owner, &sp, None, Duration::from_secs(300)) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return fail(r, "compile", format!("Cannot start javac: {e}"));
        }
    };
    r.output = format!("{}{}", o.stdout, o.stderr).trim().to_string();
    if o.code != Some(0) {
        let _ = std::fs::remove_dir_all(&tmp);
        let n = r.output.lines().filter(|l| l.contains(": error:")).count();
        return fail(r, "compile", format!("Compilation failed: {n} error{}. The running JVM was not touched.", if n == 1 { "" } else { "s" }));
    }
    let mut classes = Vec::new();
    walk_classes(&tmp.join("out"), &tmp.join("out"), &mut classes);
    r.compiled = classes.len();
    if a.dry_run {
        r.redefined = classes.iter().map(|(sig, _)| sig[1..sig.len() - 1].replace('/', ".")).collect();
        let _ = std::fs::remove_dir_all(&tmp);
        r.ok = true;
        r.stage = "done".into();
        r.message = format!("Compiled {} class{} (dry run)", classes.len(), if classes.len() == 1 { "" } else { "es" });
        r.elapsed_ms = t0.elapsed().as_millis() as u64;
        return r;
    }
    // ---- 3. @Mixin classes are merged into their targets when they load: redefining the mixin class itself changes nothing
    let is_mixin = src.contains("@Mixin") || src.contains("org.spongepowered.asm.mixin.Mixin");
    if is_mixin {
        let _ = std::fs::remove_dir_all(&tmp);
        r.warnings.push("This file contains a @Mixin class. Mixins are applied to their target class when it loads, so reloading the mixin class cannot change the running game; restart the game (or use a JetBrains Runtime with a Mixin-aware hot swap agent). The file compiled without errors.".into());
        r.ok = true;
        r.stage = "done".into();
        r.message = "Compiled, but not reloaded: @Mixin classes cannot be hot swapped.".into();
        r.elapsed_ms = t0.elapsed().as_millis() as u64;
        return r;
    }
    // ---- 4. redefine what is loaded
    emit(&format!("Redefining {} class{}…", classes.len(), if classes.len() == 1 { "" } else { "es" }));
    let res = jdwp::with_conn(&a.id, |c| {
        let mut batch: Vec<(u64, Vec<u8>)> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        for (sig, path) in &classes {
            let ids = c.classes_by_signature(sig)?;
            let nice = sig[1..sig.len() - 1].replace('/', ".");
            if ids.is_empty() {
                skipped.push(nice);
                continue;
            }
            let bytes = std::fs::read(path).map_err(|e| JdwpErr { code: 0, name: "LOCAL".into(), message: format!("cannot read {}: {e}", path.display()) })?;
            for id in ids {
                batch.push((id, bytes.clone()));
            }
            names.push(nice);
        }
        let enhanced = a.enhanced || c.info.lock().unwrap().can_add_method;
        if batch.is_empty() {
            return Ok((names, skipped, enhanced));
        }
        c.redefine(&batch).map_err(|mut e| {
            if e.code != 0 {
                e.message = redefine_message(e.code, enhanced);
            }
            e
        })?;
        Ok((names, skipped, enhanced))
    });
    let _ = std::fs::remove_dir_all(&tmp);
    r.elapsed_ms = t0.elapsed().as_millis() as u64;
    match res {
        Ok((names, skipped, _)) => {
            r.stage = "done".into();
            r.ok = true;
            r.redefined = names;
            r.skipped = skipped;
            r.message = if r.redefined.is_empty() {
                "Compiled, but none of its classes is loaded in the running JVM yet; nothing to reload.".to_string()
            } else {
                format!("Reloaded {} class{}", r.redefined.len(), if r.redefined.len() == 1 { "" } else { "es" })
            };
            if !r.redefined.is_empty() && !r.skipped.is_empty() {
                r.warnings.push(format!("Not loaded yet (a new class cannot be added to a running JVM): {}", r.skipped.join(", ")));
            }
        }
        Err(e) => {
            r.ok = false;
            r.stage = "redefine".into();
            r.message = e.message.clone();
            r.error_code = Some(e.code).filter(|c| *c != 0);
            r.error_name = Some(e.name).filter(|n| n != "LOCAL");
        }
    }
    r
}

/// Read-only classpath dump for `file` (nothing cached, no debug session needed): what `hotswap_run` resolves first. QA / diagnostics.
#[tauri::command]
pub async fn hotswap_dump(app: AppHandle, window: WebviewWindow, root: String, file: String) -> Result<Value, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let build = build_dir_of(Path::new(&file), Path::new(&root));
        let emit = |line: &str| crate::windows::emit_window(&app, &owner, "hotswap://progress/dump", line.to_string());
        let mut d = run_dump(&owner, &build, Path::new(&root), &file, None, &emit)?;
        if d.get("needsChoice") == Some(&Value::Bool(true)) {
            // several projects compile this file: no running game to ask here, so the deepest project (what a hot swap does without evidence)
            let cands: Vec<(String, String, Vec<String>)> = d
                .get("candidates")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
                .map(|x| (x.get("project").and_then(|v| v.as_str()).unwrap_or(":").to_string(), x.get("projectDir").and_then(|v| v.as_str()).unwrap_or("").to_string(), strs(x, "outputDirs")))
                .collect();
            let (i, _) = choose(&cands, &Evidence::default());
            let all = d.get("candidates").cloned().unwrap_or(Value::Null);
            d = run_dump(&owner, &build, Path::new(&root), &file, Some(&cands[i].0), &emit)?;
            d["candidates"] = all;
        }
        Ok(d)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hotswap_run(app: AppHandle, window: WebviewWindow, args: HotswapArgs) -> Result<HotswapResult, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || run_hotswap(&app, &owner, &args)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majors() {
        assert_eq!(parse_major("21.0.9"), 21);
        assert_eq!(parse_major("1.8.0_392"), 8);
        assert_eq!(parse_major("25.0.4.1"), 25);
        assert_eq!(parse_major("17"), 17);
    }

    fn jdk(major: u32, jbr: bool, javac: bool) -> Jdk {
        Jdk { home: format!("/j/{major}{}", if jbr { "jbr" } else { "" }), major, version: major.to_string(), vendor: String::new(), jbr, has_javac: javac, agent: None }
    }

    #[test]
    fn picks_matching_jdk() {
        let all = vec![jdk(25, true, true), jdk(21, true, true), jdk(21, false, true), jdk(17, false, true), jdk(17, false, false)];
        assert_eq!(pick_javac(&all, Some(17), 17).unwrap().major, 17);
        assert_eq!(pick_javac(&all, Some(21), 21).unwrap(), jdk(21, false, true), "plain JDK before JBR");
        assert_eq!(pick_javac(&all, None, 22).unwrap().major, 25, "smallest JDK that is new enough");
        assert!(pick_javac(&all, Some(26), 26).is_none());
        assert_eq!(jbr_map(&all).iter().map(|(m, _)| *m).collect::<Vec<_>>(), vec![25, 21]);
    }

    #[test]
    fn finds_nearest_build() {
        let d = std::env::temp_dir().join(format!("ace-bd-{}", std::process::id()));
        let nested = d.join("versions/1.20.1/forge");
        std::fs::create_dir_all(nested.join("src/main/java")).unwrap();
        std::fs::write(d.join("settings.gradle"), "").unwrap();
        std::fs::write(nested.join("settings.gradle.kts"), "").unwrap();
        std::fs::create_dir_all(d.join("src/a")).unwrap();
        assert_eq!(build_dir_of(&nested.join("src/main/java/X.java"), &d), nested);
        assert_eq!(build_dir_of(&d.join("src/a/Y.java"), &d), d);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn debug_script_has_no_placeholders_and_hooks_lazily() {
        let s = render_debug_script(4711, "/tmp/it's/ace-debug-4711.gradle", &[(21, jdk(21, true, true))], None);
        assert!(!s.contains('@') || !s.contains("@PORT@") && !s.contains("@SELF@") && !s.contains("@JBRS@") && !s.contains("@AGENT@"));
        assert!(s.contains("def acePort = '4711'") && s.contains("def aceJbrs = '21=/j/21jbr'"));
        assert!(s.contains("configureEach") && s.contains("withType(JavaExec)") && s.contains("withType(Exec)"));
        // never realizes tasks (Loom): no getByName / findByName on tasks / tasks.all; projectsEvaluated only to REGISTER a configureEach
        assert!(!s.contains("tasks.getByName") && !s.contains("tasks.findByName") && !s.contains("tasks.all") && !s.contains("afterEvaluate") && !s.contains(".realize"));
        let after = &s[s.find("projectsEvaluated").expect("late launcher hook") + "projectsEvaluated".len()..];
        assert!(after.contains("withType(JavaExec).configureEach") && s.matches("projectsEvaluated").count() == 1, "the late hook only registers configureEach");
        let plain = render_debug_script(4711, "/x/a.gradle", &[], None);
        assert!(plain.contains("def aceJbrs = ''"), "no JBR map when Enhanced HotSwap is off");
        assert!(!DUMP_INIT.contains("projectsEvaluated"));
    }

    #[test]
    fn only_needed_processors_run() {
        let real = ["mappings.jar", "mixinextras-common-0.2.0.jar", "lombok-1.18.34.jar", "fabric-mixin-compile-extensions-0.6.0.jar", "asm-9.10.1.jar", "sponge-mixin-0.17.3+mixin.0.8.7.jar"]
            .iter().map(|n| format!("/g/{n}")).collect::<Vec<_>>();
        assert_eq!(processor_jars(&real), vec!["/g/lombok-1.18.34.jar".to_string()]);
        assert!(processor_jars(&real[..2]).is_empty() && processor_jars(&real[3..]).is_empty());
    }

    #[test]
    fn picks_the_project_the_game_runs() {
        let ev_cp = Evidence { vm_cp: vec!["/p/build/classes/java/main".into(), "/x/lib.jar".into()], ran: vec![] };
        let c = vec![
            (":1.21.1:fabric".to_string(), "/p/versions/1.21.1/fabric".to_string(), vec!["/p/versions/1.21.1/fabric/build/classes/java/main".to_string()]),
            (":".to_string(), "/p".to_string(), vec!["/p/build/classes/java/common".to_string(), "/p/build/classes/java/main".to_string()]),
        ];
        assert_eq!(choose(&c, &ev_cp), (1, true), "output dir on the VM class path beats the deeper project");
        let ev_ran = Evidence { vm_cp: vec![], ran: vec![":1.21.1:fabric".into()] };
        assert_eq!(choose(&c, &ev_ran), (0, true), "a project whose compile task ran");
        assert_eq!(choose(&c, &Evidence::default()), (0, false), "no evidence: deepest project dir, undecided");
        assert_eq!(choose(&c[..1], &Evidence::default()), (0, true), "a single candidate is always decided");
    }

    #[test]
    fn argfile_quotes() {
        assert_eq!(argfile_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }
}
