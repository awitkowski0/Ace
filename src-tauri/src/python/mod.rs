//! Python support backend: interpreter discovery (local + ssh), probing, tool lookup (language servers, ruff, uv...),
//! venv/conda creation, PyPI lookups and the bundled helper scripts (pytest plugin, unittest runner, console).
//! Nothing here runs until the frontend asks (a Python file/project was opened). Frontend wrappers: src/components/python/api.ts.
//!
//!   py_discover(host, root) -> [Interp]          py_probe(host, python) -> json
//!   py_tools(host, python?) -> {tool: path}      py_create_venv / py_create_conda
//!   py_pypi_search(query) / py_pypi_info(name)   py_scripts_dir() / py_script_source(name)
use crate::runner::{exec, Spec};
use crate::Location;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::WebviewWindow;

const PYTEST_PLUGIN: &str = include_str!("scripts/ace_pytest.py");
const UNITTEST_RUNNER: &str = include_str!("scripts/ace_unittest.py");
const CONSOLE: &str = include_str!("scripts/ace_console.py");
const NOTEBOOK_KERNEL: &str = include_str!("scripts/ace_console.py");

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Interp {
    pub id: String,
    pub path: String,
    pub version: String,
    /// venv | uv | poetry | pipenv | conda | pyenv | system
    pub kind: String,
    pub name: String,
    pub env_root: Option<String>,
    pub project: bool,
    pub host: String,
}

struct Cand {
    path: String,
    kind: &'static str,
    env_root: Option<String>,
    label: Option<String>,
    project: bool,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn is_exec(p: &Path) -> bool {
    p.metadata().map(|m| m.is_file() && crate::platform::is_executable(p, &m)).unwrap_or(false)
}

/// The interpreter of an environment prefix: `bin/<name>` on unix, `Scripts\python.exe` (or `python.exe` at the root) on Windows.
fn env_python(prefix: &Path, name: &str) -> PathBuf {
    if cfg!(windows) {
        let scripts = prefix.join("Scripts").join("python.exe");
        if scripts.is_file() {
            return scripts;
        }
        return prefix.join("python.exe");
    }
    prefix.join("bin").join(name)
}

/// File names to try for a tool on PATH: the bare name on unix; `.exe`/`.cmd`/`.bat` on Windows (npm shims are `.cmd`).
fn exe_names(bin: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")]
    } else {
        vec![bin.to_string()]
    }
}

fn version_from_cfg(env_root: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(env_root.join("pyvenv.cfg")).ok()?;
    for line in cfg.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k == "version" {
            return Some(v.to_string());
        }
        if k == "version_info" {
            return Some(v.split('.').take(3).collect::<Vec<_>>().join("."));
        }
    }
    None
}

fn parse_version(out: &str) -> Option<String> {
    let v = out.trim().strip_prefix("Python ")?.trim();
    let v: String = v.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    (!v.is_empty()).then_some(v)
}

fn mm(version: &str) -> String {
    version.split('.').take(2).collect::<Vec<_>>().join(".")
}

fn display_name(version: &str, label: Option<&str>) -> String {
    match label {
        Some(l) if !l.is_empty() => format!("Python {} ({l})", mm(version)),
        _ => format!("Python {}", mm(version)),
    }
}

fn dir_names(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    v.sort();
    v
}

fn slug(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()
}

fn discover_local(root: &str) -> Vec<Interp> {
    let rootp = Path::new(root);
    let proj_name = rootp.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cands: Vec<Cand> = Vec::new();
    let pyproject = std::fs::read_to_string(rootp.join("pyproject.toml")).unwrap_or_default();
    let is_poetry = pyproject.contains("[tool.poetry]");
    for d in [".venv", "venv", "env", ".env", ".virtualenv"] {
        let env = rootp.join(d);
        let py = env_python(&env, "python");
        if is_exec(&py) {
            let kind = if rootp.join("uv.lock").is_file() && d == ".venv" { "uv" } else if is_poetry && d == ".venv" { "poetry" } else { "venv" };
            cands.push(Cand { path: py.to_string_lossy().into(), kind, env_root: Some(env.to_string_lossy().into()), label: Some(proj_name.clone()), project: true });
        }
    }
    // poetry's cache dir and pipenv's virtualenv dir: <name>-<hash>[-pyX.Y]
    let want = slug(&proj_name);
    let mut env_dirs: Vec<(PathBuf, &'static str)> = Vec::new();
    if is_poetry {
        env_dirs.push((home().join("Library/Caches/pypoetry/virtualenvs"), "poetry"));
        env_dirs.push((home().join(".cache/pypoetry/virtualenvs"), "poetry"));
    }
    if rootp.join("Pipfile").is_file() {
        env_dirs.push((home().join(".local/share/virtualenvs"), "pipenv"));
    }
    for (dir, kind) in env_dirs {
        for env in dir_names(&dir) {
            let n = env.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if slug(&n).starts_with(&format!("{want}-")) || n.starts_with(&format!("{proj_name}-")) {
                let py = env_python(&env, "python");
                if is_exec(&py) {
                    cands.push(Cand { path: py.to_string_lossy().into(), kind, env_root: Some(env.to_string_lossy().into()), label: Some(proj_name.clone()), project: true });
                }
            }
        }
    }
    // conda: ~/.conda/environments.txt lists every env prefix conda knows; the base prefix comes from the conda binary
    let mut prefixes: Vec<PathBuf> = Vec::new();
    if let Ok(t) = std::fs::read_to_string(home().join(".conda/environments.txt")) {
        prefixes.extend(t.lines().map(str::trim).filter(|l| l.starts_with('/')).map(PathBuf::from));
    }
    'conda: for d in std::env::split_paths(crate::lsp::login_path()) {
        for name in exe_names("conda") {
            if let Ok(real) = d.join(name).canonicalize() {
                if let Some(base) = real.parent().and_then(|b| b.parent()) {
                    prefixes.push(base.to_path_buf());
                    for e in dir_names(&base.join("envs")) {
                        prefixes.push(e);
                    }
                }
                break 'conda;
            }
        }
    }
    for p in prefixes {
        let py = if cfg!(windows) { p.join("python.exe") } else { p.join("bin/python") };
        if is_exec(&py) && p.join("conda-meta").is_dir() {
            let name = if p.join("envs").is_dir() { "base".to_string() } else { p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() };
            cands.push(Cand { path: py.to_string_lossy().into(), kind: "conda", env_root: Some(p.to_string_lossy().into()), label: Some(name), project: false });
        }
    }
    for v in dir_names(&home().join(".pyenv/versions")) {
        let py = env_python(&v, "python");
        if is_exec(&py) {
            cands.push(Cand { path: py.to_string_lossy().into(), kind: "pyenv", env_root: None, label: None, project: false });
        }
    }
    for v in dir_names(&home().join(".local/share/uv/python")) {
        let py = env_python(&v, "python3");
        if is_exec(&py) {
            cands.push(Cand { path: py.to_string_lossy().into(), kind: "system", env_root: None, label: Some("uv".into()), project: false });
        }
    }
    let mut sys: Vec<PathBuf> = Vec::new();
    for d in std::env::split_paths(crate::lsp::login_path()).filter(|d| !d.as_os_str().is_empty()) {
        for n in dir_names(&d) {
            let f = n.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            let f = if cfg!(windows) { f.strip_suffix(".exe").unwrap_or(&f).to_string() } else { f };
            if f == "python3" || f == "python" || (f.starts_with("python3.") && f[8..].chars().all(|c| c.is_ascii_digit())) {
                sys.push(n);
            }
        }
    }
    for v in dir_names(Path::new("/Library/Frameworks/Python.framework/Versions")) {
        sys.push(env_python(&v, "python3"));
    }
    sys.push(PathBuf::from("/usr/bin/python3"));
    for p in sys {
        if is_exec(&p) {
            cands.push(Cand { path: p.to_string_lossy().into(), kind: "system", env_root: None, label: None, project: false });
        }
    }
    // dedupe by real path (a venv python is a symlink to its base: venvs are keyed by their own path)
    let mut seen: HashSet<String> = HashSet::new();
    let mut uniq: Vec<Cand> = Vec::new();
    for c in cands {
        let key = if c.env_root.is_some() && c.kind != "conda" { c.path.clone() } else { Path::new(&c.path).canonicalize().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| c.path.clone()) };
        if seen.insert(key) {
            uniq.push(c);
        }
    }
    // versions: pyvenv.cfg when possible, otherwise `python --version` in parallel
    let versions: Vec<Option<String>> = std::thread::scope(|s| {
        let hs: Vec<_> = uniq
            .iter()
            .map(|c| {
                s.spawn(move || {
                    if let Some(v) = c.env_root.as_deref().and_then(|e| version_from_cfg(Path::new(e))) {
                        return Some(v);
                    }
                    let o = std::process::Command::new(crate::platform::resolve_program(&c.path)).arg("--version").stdin(std::process::Stdio::null()).output().ok()?;
                    parse_version(&String::from_utf8_lossy(&o.stdout)).or_else(|| parse_version(&String::from_utf8_lossy(&o.stderr)))
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().ok().flatten()).collect()
    });
    let mut out: Vec<Interp> = uniq
        .into_iter()
        .zip(versions)
        .filter_map(|(c, v)| {
            let v = v?;
            Some(Interp { id: c.path.clone(), name: display_name(&v, c.label.as_deref()), version: v, kind: c.kind.into(), env_root: c.env_root, project: c.project, path: c.path, host: "local".into() })
        })
        .collect();
    sort_interps(&mut out);
    out
}

fn ver_key(v: &str) -> Vec<u32> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

fn sort_interps(v: &mut [Interp]) {
    let rank = |k: &str| match k {
        "venv" | "uv" | "poetry" | "pipenv" => 0,
        "conda" => 1,
        "pyenv" => 2,
        _ => 3,
    };
    v.sort_by(|a, b| {
        b.project.cmp(&a.project).then(rank(&a.kind).cmp(&rank(&b.kind))).then(ver_key(&b.version).cmp(&ver_key(&a.version))).then(a.path.cmp(&b.path))
    });
}

const REMOTE_DISCOVER: &str = r#"
emit() { p="$2"; [ -x "$p" ] || return 0; v=$("$p" --version 2>&1 | head -1); printf '%s\t%s\t%s\t%s\n' "$1" "$p" "$3" "$v"; }
R="$1"
for d in .venv venv env .env; do emit project "$R/$d/bin/python" "$R/$d"; done
for p in $(command -v -a python3 python 2>/dev/null) /usr/bin/python3 /usr/local/bin/python3; do emit system "$p" ""; done
for p in "$HOME"/.pyenv/versions/*/bin/python; do emit pyenv "$p" ""; done
for p in "$HOME"/.local/share/uv/python/*/bin/python3; do emit uvpython "$p" ""; done
for d in "$HOME"/miniconda3 "$HOME"/anaconda3 "$HOME"/miniforge3 "$HOME"/micromamba; do
  emit conda "$d/bin/python" "$d"; for e in "$d"/envs/*; do emit conda "$e/bin/python" "$e"; done
done
true
"#;

fn discover_remote(host: &str, root: &str) -> Result<Vec<Interp>, String> {
    let script = format!("sh -c {} _ {}", crate::remote::ssh::quote(REMOTE_DISCOVER), crate::remote::ssh::quote(root));
    let out = crate::remote::ssh::exec_login(host, &script)?;
    let proj_name = root.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let mut seen = HashSet::new();
    let mut v = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let (src, path, env, ver) = (f[0], f[1], f[2], f[3]);
        let Some(version) = parse_version(ver) else { continue };
        if !seen.insert(path.to_string()) {
            continue;
        }
        let (kind, label, project) = match src {
            "project" => (if Path::new(&format!("{root}/uv.lock")).exists() { "uv" } else { "venv" }, Some(proj_name.clone()), true),
            "conda" => ("conda", Some(env.rsplit('/').next().unwrap_or("conda").to_string()), false),
            "pyenv" => ("pyenv", None, false),
            "uvpython" => ("system", Some("uv".to_string()), false),
            _ => ("system", None, false),
        };
        v.push(Interp {
            id: path.into(), path: path.into(), name: display_name(&version, label.as_deref()), version, kind: kind.into(),
            env_root: (!env.is_empty()).then(|| env.to_string()), project, host: host.into(),
        });
    }
    sort_interps(&mut v);
    Ok(v)
}

#[tauri::command]
pub async fn py_discover(host: String, root: String) -> Result<Vec<Interp>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if host.is_empty() || host == "local" {
            Ok(discover_local(&root))
        } else {
            discover_remote(&host, &root)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

const PROBE: &str = r#"
import sys, json, sysconfig, site
import importlib.util as u
mods = {m: u.find_spec(m) is not None for m in ("pip","debugpy","pytest","IPython","ruff","black","isort","basedpyright","pyright","jupyter_client","ipykernel","setuptools")}
try: sp = site.getsitepackages()
except Exception: sp = []
sp = list(dict.fromkeys(sp + [sysconfig.get_paths()["purelib"]]))
print(json.dumps({"version": list(sys.version_info[:3]), "prefix": sys.prefix, "basePrefix": sys.base_prefix, "executable": sys.executable,
                  "sitePackages": sp, "inVenv": sys.prefix != sys.base_prefix, "modules": mods}))
"#;

fn spec(host: &str, cwd: &str, argv: Vec<String>) -> Spec {
    Spec { host: host.into(), cwd: cwd.into(), argv, ..Default::default() }
}

#[tauri::command]
pub async fn py_probe(window: WebviewWindow, host: String, python: String) -> Result<serde_json::Value, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let s = spec(&host, "", vec![python, "-I".into(), "-c".into(), PROBE.into()]);
        let o = exec(&owner, &s, None, Duration::from_secs(20))?;
        if o.code != Some(0) {
            return Err(if o.stderr.trim().is_empty() { format!("python exited with {:?}", o.code) } else { o.stderr.trim().to_string() });
        }
        serde_json::from_str(o.stdout.trim()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

const TOOLS: [&str; 10] = ["basedpyright-langserver", "pyright-langserver", "ruff", "black", "isort", "uv", "pipx", "conda", "poetry", "pipenv"];

#[tauri::command]
pub async fn py_tools(window: WebviewWindow, host: String, python: Option<String>) -> Result<BTreeMap<String, String>, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = BTreeMap::new();
        if host.is_empty() || host == "local" {
            let mut dirs: Vec<PathBuf> = Vec::new();
            if let Some(p) = python.as_deref().and_then(|p| Path::new(p).parent()) {
                dirs.push(p.to_path_buf());
            }
            dirs.extend(std::env::split_paths(crate::lsp::login_path()).filter(|d| !d.as_os_str().is_empty()));
            dirs.push(home().join(".local/bin"));
            dirs.push(home().join(".cargo/bin"));
            for t in TOOLS {
                if let Some(p) = dirs.iter().flat_map(|d| exe_names(t).into_iter().map(move |n| d.join(n))).find(|p| is_exec(p)) {
                    out.insert(t.to_string(), p.to_string_lossy().into_owned());
                }
            }
        } else {
            let pre = python.as_deref().and_then(|p| p.rsplit_once('/')).map(|(d, _)| format!("PATH={}:\"$PATH\"; ", crate::remote::ssh::quote(d))).unwrap_or_default();
            let script = format!("{pre}for t in {}; do p=$(command -v $t 2>/dev/null) && printf '%s\\t%s\\n' $t \"$p\"; done; true", TOOLS.join(" "));
            let s = Spec { host: host.clone(), shell: Some(script), ..Default::default() };
            let o = exec(&owner, &s, None, Duration::from_secs(20))?;
            for l in o.stdout.lines() {
                if let Some((t, p)) = l.split_once('\t') {
                    out.insert(t.to_string(), p.to_string());
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn tail(s: &str) -> String {
    let t = s.trim();
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

/// Interpreter path of a venv created at `dir` (the string form of `env_python`, without touching the disk).
fn venv_python_str(dir: &str) -> String {
    if cfg!(windows) {
        format!("{}\\Scripts\\python.exe", dir.trim_end_matches(['/', '\\']))
    } else {
        format!("{}/bin/python", dir.trim_end_matches('/'))
    }
}

/// New virtual environment at `dir` with `uv venv --seed` (tool "uv") or `python -m venv`. Returns the interpreter path.
#[tauri::command]
pub async fn py_create_venv(window: WebviewWindow, host: String, dir: String, base: Option<String>, tool: String, uv: Option<String>, system_site: Option<bool>) -> Result<String, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let site = system_site.unwrap_or(false);
        let argv: Vec<String> = if tool == "uv" {
            let mut a = vec![uv.unwrap_or_else(|| "uv".into()), "venv".into(), "--seed".into()];
            if let Some(b) = &base {
                a.extend(["--python".into(), b.clone()]);
            }
            if site {
                a.push("--system-site-packages".into());
            }
            a.push(dir.clone());
            a
        } else {
            let default = if cfg!(windows) { "python" } else { "python3" };
            let mut a = vec![base.clone().unwrap_or_else(|| default.into()), "-m".into(), "venv".into()];
            if site {
                a.push("--system-site-packages".into());
            }
            a.push(dir.clone());
            a
        };
        let o = exec(&owner, &spec(&host, "", argv.clone()), None, Duration::from_secs(300))?;
        if o.code != Some(0) && tool != "uv" {
            // Debian/Ubuntu without python3-venv's ensurepip: still make a usable (pip-less) environment
            let mut a = argv.clone();
            a.insert(a.len() - 1, "--without-pip".into());
            let o2 = exec(&owner, &spec(&host, "", a), None, Duration::from_secs(120))?;
            if o2.code != Some(0) {
                return Err(tail(&format!("{}\n{}", o.stderr, o2.stderr)));
            }
        } else if o.code != Some(0) {
            return Err(tail(&format!("{}\n{}", o.stderr, o.stdout)));
        }
        Ok(venv_python_str(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `conda create -y -p <dir> python=<version>`. Returns the interpreter path.
#[tauri::command]
pub async fn py_create_conda(window: WebviewWindow, host: String, conda: String, dir: String, python_version: Option<String>) -> Result<String, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut argv = vec![conda, "create".into(), "-y".into(), "-p".into(), dir.clone()];
        argv.push(format!("python={}", python_version.unwrap_or_else(|| "3".into())));
        let o = exec(&owner, &spec(&host, "", argv), None, Duration::from_secs(900))?;
        if o.code != Some(0) {
            return Err(tail(&format!("{}\n{}", o.stderr, o.stdout)));
        }
        Ok(if cfg!(windows) { format!("{}\\python.exe", dir.trim_end_matches(['/', '\\'])) } else { format!("{}/bin/python", dir.trim_end_matches('/')) })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------------------------------------ PyPI

#[derive(Serialize, Debug, Clone)]
pub struct PypiHit {
    pub name: String,
    pub version: String,
    pub summary: String,
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).user_agent("Ace-IDE/0.1 (python packages)").build()
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

fn parse_search(html: &str) -> Vec<PypiHit> {
    let re = regex::Regex::new(r#"(?s)package-snippet__name">([^<]+)</span>\s*<span class="package-snippet__version">([^<]+)</span>.*?package-snippet__description">([^<]*)</p>"#).unwrap();
    re.captures_iter(html)
        .map(|c| PypiHit { name: unescape(c[1].trim()), version: unescape(c[2].trim()), summary: unescape(c[3].trim()) })
        .collect()
}

#[tauri::command]
pub async fn py_pypi_search(query: String) -> Result<Vec<PypiHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_string();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let mut hits: Vec<PypiHit> = Vec::new();
        // exact project first (the JSON API is stable; the HTML search page is a best-effort scrape)
        if let Ok(r) = http().get(&format!("https://pypi.org/pypi/{}/json", q.replace(['/', ' '], ""))).call() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.into_string().unwrap_or_default()) {
                if let Some(i) = v.get("info") {
                    hits.push(PypiHit {
                        name: i["name"].as_str().unwrap_or(&q).into(),
                        version: i["version"].as_str().unwrap_or("").into(),
                        summary: i["summary"].as_str().unwrap_or("").into(),
                    });
                }
            }
        }
        let enc: String = q.bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        if let Ok(r) = http().get(&format!("https://pypi.org/search/?q={enc}")).call() {
            for h in parse_search(&r.into_string().unwrap_or_default()) {
                if !hits.iter().any(|x| x.name.eq_ignore_ascii_case(&h.name)) {
                    hits.push(h);
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Versions (newest first) and summary for one project.
#[tauri::command]
pub async fn py_pypi_info(name: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = http().get(&format!("https://pypi.org/pypi/{}/json", name.replace(['/', ' '], ""))).call().map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut versions: Vec<String> = v["releases"]
            .as_object()
            .map(|m| m.iter().filter(|(_, files)| files.as_array().map(|f| f.iter().any(|x| x["yanked"] != true)).unwrap_or(false)).map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        versions.sort_by(|a, b| ver_key(b).cmp(&ver_key(a)));
        versions.truncate(40);
        Ok(serde_json::json!({
            "name": v["info"]["name"], "version": v["info"]["version"], "summary": v["info"]["summary"],
            "homePage": v["info"]["home_page"], "projectUrl": v["info"]["project_url"], "versions": versions,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------------------------------------ bundled scripts

/// `$TMPDIR/ace-python-v1-<uid>/` with `ace_pytest.py`, `ace_unittest.py`, `ace_console.py` (rewritten when different).
/// Nothing is installed into any environment: runs add this directory to PYTHONPATH.
#[tauri::command]
pub fn py_scripts_dir() -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!("ace-python-v1-{}", crate::platform::user_tag()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (n, body) in [("ace_pytest.py", PYTEST_PLUGIN), ("ace_unittest.py", UNITTEST_RUNNER), ("ace_console.py", CONSOLE)] {
        let p = dir.join(n);
        if std::fs::read_to_string(&p).ok().as_deref() != Some(body) {
            std::fs::write(&p, body).map_err(|e| e.to_string())?;
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Source text of a bundled script (used to run it remotely with `python -c`).
#[tauri::command]
pub fn py_script_source(name: String) -> Result<String, String> {
    match name.as_str() {
        "ace_pytest" => Ok(PYTEST_PLUGIN.into()),
        "ace_unittest" => Ok(UNITTEST_RUNNER.into()),
        "ace_console" => Ok(CONSOLE.into()),
        "ace_notebook" => Ok(NOTEBOOK_KERNEL.into()),
        _ => Err("unknown script".into()),
    }
}

/// Run a formatter/linter over `stdin` text (ruff/black/isort) in `cwd` and return stdout. Thin wrapper kept here so the
/// frontend does not need a second round trip for the tool path.
#[tauri::command]
pub async fn py_filter(window: WebviewWindow, loc_root: Location, argv: Vec<String>, stdin: String) -> Result<serde_json::Value, String> {
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let s = Spec { host: loc_root.host.clone(), cwd: loc_root.path.clone(), argv, ..Default::default() };
        let o = exec(&owner, &s, Some(&stdin), Duration::from_secs(30))?;
        Ok(serde_json::json!({ "code": o.code, "stdout": o.stdout, "stderr": o.stderr, "timedOut": o.timed_out }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_names() {
        assert_eq!(parse_version("Python 3.12.6\n").as_deref(), Some("3.12.6"));
        assert_eq!(parse_version("Python 3.13.0rc1").as_deref(), Some("3.13.0"));
        assert_eq!(display_name("3.12.6", Some("proj")), "Python 3.12 (proj)");
        assert_eq!(display_name("3.9.1", None), "Python 3.9");
    }

    #[test]
    fn search_page_parses() {
        let html = r#"<a class="package-snippet" href="/project/requests/"><h3 class="package-snippet__title"><span class="package-snippet__name">requests</span> <span class="package-snippet__version">2.32.3</span><span class="package-snippet__released"></span></h3><p class="package-snippet__description">Python HTTP for Humans.</p></a>"#;
        let h = parse_search(html);
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].name.as_str(), h[0].version.as_str(), h[0].summary.as_str()), ("requests", "2.32.3", "Python HTTP for Humans."));
    }
}
