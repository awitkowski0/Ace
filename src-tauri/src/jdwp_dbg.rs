//! Java debugging over JDWP for Gradle debug runs: line breakpoints (deferred until their class loads), stack frames, locals / fields / array
//! elements, step over / into / out, resume / pause. The UI is the existing Debug window (src/components/gradle/java/session.ts adapts it).
//!
//! Commands (all take the attach session `id`; see jdwp.rs):
//!   jdwp_breakpoints({id, file, lines:[{line}]}) -> [{line, verified, message?}]   replaces the breakpoints of one source file
//!   jdwp_threads(id) -> [{id, name}]            jdwp_stack(id, thread) -> [{id, name, line, path?, className, method}]
//!   jdwp_scopes(id, frame) -> [{name, ref}]     jdwp_variables(id, ref) -> [{name, value, type, ref, indexed?}]
//!   jdwp_resume(id)  jdwp_suspend(id)  jdwp_step(id, thread, depth: "into"|"over"|"out")
//! Stops arrive as `jdwp://event/<id>` {kind: breakpoint|step, thread, ...}. The VM is suspended with SUSPEND_ALL (like IntelliJ's default).
//! Not supported: conditions, log messages, pass counts, exception breakpoints, evaluate / watches, set value.
use crate::jdwp::{with_conn, Conn, JdwpErr, Rd, VmEvent, Wr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

const T: Duration = Duration::from_secs(30);
const EV_STEP: u8 = 1;
const EV_BREAKPOINT: u8 = 2;
const EV_CLASS_PREPARE: u8 = 8;
const MAX_CHILDREN: u32 = 300;

// ---------------------------------------------------------------- state

#[derive(Clone)]
struct VarSlot {
    code_index: u64,
    length: u32,
    name: String,
    sig: String,
    slot: u32,
}

struct MethodInfo {
    id: u64,
    name: String,
    lines: Option<Vec<(u64, u32)>>,
    vars: Option<Vec<VarSlot>>,
}

#[derive(Default)]
struct ClassInfo {
    sig: String,
    source: Option<String>,
    methods: Option<Vec<MethodInfo>>,
}

#[derive(Clone)]
struct FrameInfo {
    thread: u64,
    class_id: u64,
    method_id: u64,
    index: u64,
}

#[derive(Clone)]
enum RefKind {
    Locals(u64),
    Object { id: u64 },
    Array { id: u64, elem: String, len: u32 },
}

#[derive(Default, Clone)]
struct FileBps {
    lines: Vec<u32>,
    reqs: Vec<u32>,
    class_req: Option<u32>,
}

#[derive(Default)]
struct Dbg {
    root: PathBuf,
    classes: HashMap<u64, ClassInfo>,
    files: HashMap<String, FileBps>,
    step_req: Option<u32>,
    frames: HashMap<u64, FrameInfo>,
    refs: HashMap<i64, RefKind>,
    next_ref: i64,
    src_cache: HashMap<String, Option<String>>,
    src_index: Option<HashMap<String, Vec<String>>>,
    type_names: HashMap<u64, String>,
}

fn all() -> &'static Mutex<HashMap<String, Arc<Mutex<Dbg>>>> {
    static A: OnceLock<Mutex<HashMap<String, Arc<Mutex<Dbg>>>>> = OnceLock::new();
    A.get_or_init(Default::default)
}
fn state(id: &str) -> Arc<Mutex<Dbg>> {
    all().lock().unwrap().entry(id.to_string()).or_default().clone()
}

pub fn init(id: &str, root: &str) {
    state(id).lock().unwrap().root = PathBuf::from(root);
}
/// A new JVM attached: everything that referred to the old one is void.
pub fn reset(id: &str) {
    let st = state(id);
    let mut d = st.lock().unwrap();
    d.classes.clear();
    d.frames.clear();
    d.refs.clear();
    d.step_req = None;
    d.type_names.clear();
    for f in d.files.values_mut() {
        f.reqs.clear();
        f.class_req = None;
    }
}
pub fn drop_session(id: &str) {
    all().lock().unwrap().remove(id);
}

fn lerr(m: impl Into<String>) -> JdwpErr {
    JdwpErr { code: 0, name: "LOCAL".into(), message: m.into() }
}

// ---------------------------------------------------------------- JDWP queries

type R<T> = Result<T, JdwpErr>;

fn all_classes(c: &Conn) -> R<Vec<(u8, u64, String)>> {
    let d = c.call(1, 3, &[], T)?;
    let mut r = Rd::new(&d);
    let n = r.u32()?;
    let sz = c.sizes();
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let tag = r.u8()?;
        let id = r.id(sz.ref_type)?;
        let sig = r.string()?;
        let _status = r.u32()?;
        out.push((tag, id, sig));
    }
    Ok(out)
}

fn class_info<'a>(c: &Conn, d: &'a mut Dbg, class_id: u64) -> R<&'a mut ClassInfo> {
    if !d.classes.contains_key(&class_id) {
        let sz = c.sizes();
        let mut w = Wr::new();
        w.id(class_id, sz.ref_type);
        let sig = Rd::new(&c.call(2, 1, &w.0, T)?).string()?;
        let source = c.call(2, 7, &w.0, T).ok().and_then(|b| Rd::new(&b).string().ok());
        d.classes.insert(class_id, ClassInfo { sig, source, methods: None });
    }
    Ok(d.classes.get_mut(&class_id).unwrap())
}

fn methods<'a>(c: &Conn, d: &'a mut Dbg, class_id: u64) -> R<&'a mut Vec<MethodInfo>> {
    class_info(c, d, class_id)?;
    let ci = d.classes.get_mut(&class_id).unwrap();
    if ci.methods.is_none() {
        let sz = c.sizes();
        let mut w = Wr::new();
        w.id(class_id, sz.ref_type);
        let b = c.call(2, 5, &w.0, T)?;
        let mut r = Rd::new(&b);
        let n = r.u32()?;
        let mut v = Vec::new();
        for _ in 0..n {
            let id = r.id(sz.method)?;
            let name = r.string()?;
            let _sig = r.string()?;
            let _mods = r.u32()?;
            v.push(MethodInfo { id, name, lines: None, vars: None });
        }
        ci.methods = Some(v);
    }
    Ok(ci.methods.as_mut().unwrap())
}

fn line_table(c: &Conn, class_id: u64, m: &mut MethodInfo) -> Vec<(u64, u32)> {
    if m.lines.is_none() {
        let sz = c.sizes();
        let mut w = Wr::new();
        w.id(class_id, sz.ref_type).id(m.id, sz.method);
        let t = (|| -> R<Vec<(u64, u32)>> {
            let b = c.call(6, 1, &w.0, T)?;
            let mut r = Rd::new(&b);
            let (_s, _e) = (r.u64()?, r.u64()?);
            let n = r.u32()?;
            let mut v = Vec::new();
            for _ in 0..n {
                v.push((r.u64()?, r.u32()?));
            }
            v.sort();
            Ok(v)
        })();
        m.lines = Some(t.unwrap_or_default()); // native / abstract methods have no table
    }
    m.lines.clone().unwrap()
}

fn var_table(c: &Conn, class_id: u64, m: &mut MethodInfo) -> Vec<VarSlot> {
    if m.vars.is_none() {
        let sz = c.sizes();
        let mut w = Wr::new();
        w.id(class_id, sz.ref_type).id(m.id, sz.method);
        let t = (|| -> R<Vec<VarSlot>> {
            let b = c.call(6, 2, &w.0, T)?;
            let mut r = Rd::new(&b);
            let _args = r.u32()?;
            let n = r.u32()?;
            let mut v = Vec::new();
            for _ in 0..n {
                let code_index = r.u64()?;
                let name = r.string()?;
                let sig = r.string()?;
                let length = r.u32()?;
                let slot = r.u32()?;
                v.push(VarSlot { code_index, length, name, sig, slot });
            }
            Ok(v)
        })();
        m.vars = Some(t.unwrap_or_default());
    }
    m.vars.clone().unwrap()
}

/// 1-based source line of a code index (the last table entry at or before it).
fn line_of(table: &[(u64, u32)], index: u64) -> u32 {
    table.iter().take_while(|(i, _)| *i <= index).last().map(|(_, l)| *l).unwrap_or(0)
}

// ---------------------------------------------------------------- source files

fn package_of(text: &str) -> String {
    for l in text.lines() {
        let t = l.trim();
        if let Some(rest) = t.strip_prefix("package ") {
            return rest.trim_end_matches(';').trim().to_string();
        }
        if t.starts_with("import ") || t.starts_with("public ") || t.starts_with("class ") {
            break;
        }
    }
    String::new()
}

/// `Lcom/x/Foo` for `/src/com/x/Foo.java` (the prefix of its classes' signatures, without `;` / `$…`).
fn sig_prefix(file: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let stem = std::path::Path::new(file).file_stem()?.to_string_lossy().into_owned();
    let pkg = package_of(&text);
    Some(if pkg.is_empty() { format!("L{stem}") } else { format!("L{}/{stem}", pkg.replace('.', "/")) })
}

fn matches_prefix(sig: &str, prefix: &str) -> bool {
    sig.strip_prefix(prefix).map(|rest| rest == ";" || rest.starts_with('$')).unwrap_or(false)
}

/// One walk of the project per session: `.java` files by file name (build output, VCS and dependency directories are skipped).
fn build_index(root: &std::path::Path) -> HashMap<String, Vec<String>> {
    let mut idx: HashMap<String, Vec<String>> = HashMap::new();
    if !root.is_dir() {
        return idx;
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some(".git" | "node_modules" | "build" | ".gradle" | "out" | "target" | "run" | "runs")))
        .build();
    for e in walker.flatten() {
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) && e.path().extension().map(|x| x == "java").unwrap_or(false) {
            if let Some(n) = e.path().file_name().and_then(|n| n.to_str()) {
                idx.entry(n.to_string()).or_default().push(e.path().to_string_lossy().into_owned());
            }
        }
    }
    idx
}

/// Local file of a class: a breakpoint file with the same relative path, else the project's index. Several files may share the
/// package-relative name (a nested build with the same layout, shared source in many projects): the shortest path wins.
fn source_path(d: &mut Dbg, sig: &str, source: &str) -> Option<String> {
    let dir = sig.trim_start_matches('L').rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
    let rel = if dir.is_empty() { source.to_string() } else { format!("{dir}/{source}") };
    let suffix = format!("/{rel}");
    if let Some(f) = d.files.keys().find(|f| f.ends_with(&suffix)) {
        return Some(f.clone());
    }
    if let Some(v) = d.src_cache.get(&rel) {
        return v.clone();
    }
    if d.src_index.is_none() {
        d.src_index = Some(build_index(&d.root));
    }
    let found = d
        .src_index
        .as_ref()
        .and_then(|i| i.get(source))
        .and_then(|cands| cands.iter().filter(|p| p.ends_with(&suffix)).min_by_key(|p| std::path::Path::new(p.as_str()).components().count()).cloned());
    d.src_cache.insert(rel, found.clone());
    found
}

// ---------------------------------------------------------------- breakpoints

#[derive(Deserialize)]
pub struct BpLine {
    pub line: u32,
}

#[derive(Serialize)]
pub struct BpResult {
    pub line: u32,
    pub verified: bool,
    pub message: Option<String>,
}

fn clear_event(c: &Conn, kind: u8, req: u32) {
    let mut w = Wr::new();
    w.u8(kind).u32(req);
    let _ = c.call(15, 2, &w.0, T);
}

/// BREAKPOINT requests for `line` in one class; returns the request ids.
fn place(c: &Conn, d: &mut Dbg, class_id: u64, line: u32) -> R<Vec<u32>> {
    let sz = c.sizes();
    let mut locs: Vec<(u64, u64)> = Vec::new(); // (method id, code index)
    {
        let ms = methods(c, d, class_id)?;
        for m in ms.iter_mut() {
            let t = line_table(c, class_id, m);
            if let Some(idx) = t.iter().filter(|(_, l)| *l == line).map(|(i, _)| *i).min() {
                locs.push((m.id, idx));
            }
        }
    }
    let mut ids = Vec::new();
    for (mid, idx) in locs {
        let mut w = Wr::new();
        w.u8(EV_BREAKPOINT).u8(2).u32(1); // suspend ALL, one modifier
        w.u8(7).u8(1).id(class_id, sz.ref_type).id(mid, sz.method).bytes(&idx.to_be_bytes()); // LocationOnly (tag 1 = class)
        ids.push(Rd::new(&c.call(15, 1, &w.0, T)?).u32()?);
    }
    Ok(ids)
}

fn class_prepare_request(c: &Conn, pattern: &str) -> R<u32> {
    let mut w = Wr::new();
    w.u8(EV_CLASS_PREPARE).u8(1).u32(1).u8(5).string(pattern); // EVENT_THREAD: the loading thread waits until we placed the breakpoints
    Rd::new(&c.call(15, 1, &w.0, T)?).u32()
}

fn set_breakpoints(c: &Conn, d: &mut Dbg, file: &str, lines: &[u32]) -> R<Vec<BpResult>> {
    // forget the old requests of this file
    if let Some(old) = d.files.get(file).cloned() {
        for r in old.reqs {
            clear_event(c, EV_BREAKPOINT, r);
        }
        if let Some(r) = old.class_req {
            clear_event(c, EV_CLASS_PREPARE, r);
        }
    }
    if lines.is_empty() {
        d.files.remove(file);
        return Ok(vec![]);
    }
    let prefix = sig_prefix(file).ok_or_else(|| lerr(format!("cannot read {file}")))?;
    // the prepare request first: a class that loads while we look is then seen by one of the two
    let pattern = format!("{}*", prefix[1..].replace('/', "."));
    let class_req = class_prepare_request(c, &pattern).ok();
    let loaded: Vec<u64> = all_classes(c)?.into_iter().filter(|(_, _, s)| matches_prefix(s, &prefix)).map(|(_, id, _)| id).collect();
    let mut fb = FileBps { lines: lines.to_vec(), reqs: vec![], class_req };
    let mut out = Vec::new();
    for &line in lines {
        let mut placed = 0;
        for &cid in &loaded {
            if let Ok(ids) = place(c, d, cid, line) {
                placed += ids.len();
                fb.reqs.extend(ids);
            }
        }
        let verified = placed > 0 || loaded.is_empty();
        out.push(BpResult {
            line,
            verified,
            message: if placed > 0 { None } else if loaded.is_empty() { Some("The class is not loaded yet; the breakpoint activates when it loads".into()) } else { Some("No executable code at this line".into()) },
        });
    }
    d.files.insert(file.to_string(), fb);
    Ok(out)
}

fn on_class_prepare(c: &Conn, d: &mut Dbg, ev: &VmEvent) {
    let Some(sig) = ev.signature.clone() else { return };
    let files: Vec<(String, Vec<u32>)> = d.files.iter().map(|(f, b)| (f.clone(), b.lines.clone())).collect();
    for (file, lines) in files {
        let Some(prefix) = sig_prefix(&file) else { continue };
        if !matches_prefix(&sig, &prefix) {
            continue;
        }
        for line in lines {
            if let Ok(ids) = place(c, d, ev.class_id, line) {
                if let Some(f) = d.files.get_mut(&file) {
                    f.reqs.extend(ids);
                }
            }
        }
    }
}

// ---------------------------------------------------------------- events

fn emit_event(app: &AppHandle, owner: &str, id: &str, ev: &VmEvent) {
    crate::windows::emit_window(app, owner, &format!("jdwp://event/{id}"), ev.clone());
}

/// Runs on the session's event worker (never on the reader thread: it issues synchronous requests).
pub fn on_event(app: &AppHandle, owner: &str, id: &str, c: &Arc<Conn>, ev: VmEvent) {
    match ev.kind.as_str() {
        "classPrepare" => {
            {
                let st = state(id);
                let mut d = st.lock().unwrap();
                on_class_prepare(c, &mut d, &ev);
            }
            // the loading thread was suspended for us (EVENT_THREAD) -> let it go
            if ev.suspend_policy == 1 {
                let mut w = Wr::new();
                w.id(ev.thread, c.sizes().object);
                let _ = c.call(11, 3, &w.0, T);
            } else if ev.suspend_policy == 2 {
                let _ = c.call(1, 9, &[], T);
            }
            emit_event(app, owner, id, &ev);
        }
        "step" => {
            let st = state(id);
            let req = { st.lock().unwrap().step_req.take() };
            if let Some(r) = req {
                clear_event(c, EV_STEP, r);
            }
            st.lock().unwrap().frames.clear();
            emit_event(app, owner, id, &ev);
        }
        _ => emit_event(app, owner, id, &ev),
    }
}

// ---------------------------------------------------------------- values

struct Val {
    tag: u8,
    bytes: Vec<u8>,
}
fn tag_size(c: &Conn, tag: u8) -> usize {
    match tag {
        b'B' | b'Z' => 1,
        b'C' | b'S' => 2,
        b'F' | b'I' => 4,
        b'D' | b'J' => 8,
        b'V' => 0,
        _ => c.sizes().object,
    }
}
fn read_val(c: &Conn, r: &mut Rd) -> R<Val> {
    let tag = r.u8()?;
    let n = tag_size(c, tag);
    Ok(Val { tag, bytes: r.raw(n)?.to_vec() })
}
fn be(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, x| (a << 8) | *x as u64)
}
fn prim_text(tag: u8, b: &[u8]) -> String {
    let n = be(b);
    match tag {
        b'Z' => (n != 0).to_string(),
        b'B' => (n as u8 as i8).to_string(),
        b'S' => (n as u16 as i16).to_string(),
        b'I' => (n as u32 as i32).to_string(),
        b'J' => (n as i64).to_string(),
        b'C' => format!("'{}' {}", char::from_u32(n as u32).filter(|c| !c.is_control()).unwrap_or('?'), n),
        b'F' => java_float(f32::from_bits(n as u32) as f64),
        b'D' => java_float(f64::from_bits(n)),
        _ => String::new(),
    }
}
fn java_float(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if v.fract() == 0.0 && v.abs() < 1e7 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

fn prim_type_name(tag: u8) -> &'static str {
    match tag {
        b'Z' => "boolean",
        b'B' => "byte",
        b'S' => "short",
        b'C' => "char",
        b'I' => "int",
        b'J' => "long",
        b'F' => "float",
        b'D' => "double",
        _ => "",
    }
}

/// `Ljava/util/Map$Entry;` -> `java.util.Map$Entry`; `[I` -> `int[]`.
fn nice_type(sig: &str) -> String {
    let dims = sig.chars().take_while(|c| *c == '[').count();
    let base = &sig[dims..];
    let b = match base.as_bytes().first() {
        Some(b'L') => base[1..base.len().saturating_sub(1)].replace('/', "."),
        Some(t) => prim_type_name(*t).to_string(),
        None => String::new(),
    };
    format!("{b}{}", "[]".repeat(dims))
}
/// `a.b.Outer$Inner` -> `Inner` (anonymous `Outer$1` keeps its number: `Outer$1`)
fn simple(t: &str) -> &str {
    let last = t.rsplit('.').next().unwrap_or(t);
    match last.rsplit_once('$') {
        Some((_, inner)) if !inner.is_empty() && !inner.chars().all(|c| c.is_ascii_digit()) => inner,
        _ => last,
    }
}

fn type_of_object(c: &Conn, d: &mut Dbg, obj: u64) -> R<(u64, String)> {
    let sz = c.sizes();
    let mut w = Wr::new();
    w.id(obj, sz.object);
    let b = c.call(9, 1, &w.0, T)?;
    let mut r = Rd::new(&b);
    let _tag = r.u8()?;
    let tid = r.id(sz.ref_type)?;
    if let Some(n) = d.type_names.get(&tid) {
        return Ok((tid, n.clone()));
    }
    let mut w = Wr::new();
    w.id(tid, sz.ref_type);
    let sig = Rd::new(&c.call(2, 1, &w.0, T)?).string()?;
    let name = nice_type(&sig);
    d.type_names.insert(tid, name.clone());
    Ok((tid, name))
}

fn string_value(c: &Conn, obj: u64) -> R<String> {
    let mut w = Wr::new();
    w.id(obj, c.sizes().object);
    Rd::new(&c.call(10, 1, &w.0, T)?).string()
}

fn new_ref(d: &mut Dbg, k: RefKind) -> i64 {
    d.next_ref += 1;
    let r = d.next_ref;
    d.refs.insert(r, k);
    r
}

const BOXES: [&str; 8] = ["java.lang.Integer", "java.lang.Long", "java.lang.Double", "java.lang.Float", "java.lang.Short", "java.lang.Byte", "java.lang.Boolean", "java.lang.Character"];

/// (value text, type text, ref (0 = no children), indexed length)
fn describe(c: &Conn, d: &mut Dbg, v: &Val, declared: &str) -> R<(String, String, i64, u32)> {
    if tag_size(c, v.tag) == 0 && v.tag == b'V' {
        return Ok(("void".into(), "void".into(), 0, 0));
    }
    if !matches!(v.tag, b'L' | b's' | b'[' | b't' | b'g' | b'l' | b'c') {
        return Ok((prim_text(v.tag, &v.bytes), prim_type_name(v.tag).into(), 0, 0));
    }
    let id = be(&v.bytes);
    if id == 0 {
        return Ok(("null".into(), nice_type(declared), 0, 0));
    }
    if v.tag == b's' {
        let s = string_value(c, id).unwrap_or_default();
        let shown: String = if s.chars().count() > 300 { s.chars().take(300).collect::<String>() + "…" } else { s };
        return Ok((format!("\"{}\"", shown.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")), "String".into(), 0, 0));
    }
    let (_tid, tname) = type_of_object(c, d, id)?;
    if v.tag == b'[' {
        let mut w = Wr::new();
        w.id(id, c.sizes().object);
        let len = Rd::new(&c.call(13, 1, &w.0, T)?).u32()?;
        let elem = tname.trim_end_matches("[]").to_string();
        let r = if len > 0 { new_ref(d, RefKind::Array { id, elem: elem.clone(), len }) } else { 0 };
        return Ok((format!("{}[{len}]@{id}", simple(&elem)), tname, r, len));
    }
    if BOXES.contains(&tname.as_str()) {
        if let Ok(kids) = fields_of(c, d, id) {
            if let Some((_, val, _, _, _)) = kids.iter().find(|k| k.0 == "value") {
                return Ok((val.clone(), simple(&tname).to_string(), 0, 0));
            }
        }
    }
    let r = new_ref(d, RefKind::Object { id });
    Ok((format!("{}@{id}", simple(&tname)), tname, r, 0))
}

type Kid = (String, String, String, i64, u32);

/// Instance fields (own, then superclasses') of an object.
fn fields_of(c: &Conn, d: &mut Dbg, obj: u64) -> R<Vec<Kid>> {
    let sz = c.sizes();
    let (mut tid, _) = type_of_object(c, d, obj)?;
    let mut fields: Vec<(u64, String, String)> = Vec::new();
    let mut guard = 0;
    while tid != 0 && guard < 20 {
        guard += 1;
        let mut w = Wr::new();
        w.id(tid, sz.ref_type);
        let b = c.call(2, 4, &w.0, T)?;
        let mut r = Rd::new(&b);
        let n = r.u32()?;
        for _ in 0..n {
            let fid = r.id(sz.field)?;
            let name = r.string()?;
            let sig = r.string()?;
            let mods = r.u32()?;
            if mods & 0x8 == 0 {
                fields.push((fid, name, sig));
            }
        }
        let sup = c.call(3, 1, &w.0, T).ok().and_then(|b| Rd::new(&b).id(sz.ref_type).ok()).unwrap_or(0);
        tid = sup;
    }
    fields.truncate(MAX_CHILDREN as usize);
    if fields.is_empty() {
        return Ok(vec![]);
    }
    let mut w = Wr::new();
    w.id(obj, sz.object).u32(fields.len() as u32);
    for f in &fields {
        w.id(f.0, sz.field);
    }
    let b = c.call(9, 2, &w.0, T)?;
    let mut r = Rd::new(&b);
    let n = r.u32()?;
    let mut out = Vec::new();
    for f in fields.iter().take(n as usize) {
        let v = read_val(c, &mut r)?;
        let (val, ty, rf, ix) = describe(c, d, &v, &f.2)?;
        out.push((f.1.clone(), val, ty, rf, ix));
    }
    Ok(out)
}

fn array_elems(c: &Conn, d: &mut Dbg, id: u64, elem: &str, len: u32) -> R<Vec<Kid>> {
    let sz = c.sizes();
    let n = len.min(MAX_CHILDREN);
    let mut w = Wr::new();
    w.id(id, sz.object).u32(0).u32(n);
    let b = c.call(13, 2, &w.0, T)?;
    let mut r = Rd::new(&b);
    let tag = r.u8()?;
    let cnt = r.u32()?;
    let mut out = Vec::new();
    for i in 0..cnt {
        let v = if matches!(tag, b'L' | b's' | b'[' | b't' | b'g' | b'l' | b'c') { read_val(c, &mut r)? } else { Val { tag, bytes: r.raw(tag_size(c, tag))?.to_vec() } };
        let declared = if tag == b'L' { format!("L{};", elem.replace('.', "/")) } else { String::new() };
        let (val, ty, rf, ix) = describe(c, d, &v, &declared)?;
        out.push((format!("[{i}]"), val, ty, rf, ix));
    }
    if len > n {
        out.push((format!("… {} more", len - n), String::new(), String::new(), 0, 0));
    }
    Ok(out)
}

fn locals_of(c: &Conn, d: &mut Dbg, frame: u64) -> R<Vec<Kid>> {
    let sz = c.sizes();
    let fi = d.frames.get(&frame).cloned().ok_or_else(|| lerr("the frame is gone (the program resumed)"))?;
    let (slots, is_static) = {
        let ms = methods(c, d, fi.class_id)?;
        let m = ms.iter_mut().find(|m| m.id == fi.method_id).ok_or_else(|| lerr("method not found"))?;
        let vars = var_table(c, fi.class_id, m);
        // static methods have no `this`: the debugger asks for it explicitly below
        let live: Vec<VarSlot> = vars.into_iter().filter(|v| v.code_index <= fi.index && fi.index < v.code_index + v.length as u64).collect();
        (live, false)
    };
    let _ = is_static;
    let mut out: Vec<Kid> = Vec::new();
    // this
    let mut w = Wr::new();
    w.id(fi.thread, sz.object).id(frame, sz.frame);
    if let Ok(b) = c.call(16, 3, &w.0, T) {
        let mut r = Rd::new(&b);
        if let Ok(v) = read_val(c, &mut r) {
            if be(&v.bytes) != 0 {
                let (val, ty, rf, ix) = describe(c, d, &v, "")?;
                out.push(("this".into(), val, ty, rf, ix));
            }
        }
    }
    if !slots.is_empty() {
        let mut w = Wr::new();
        w.id(fi.thread, sz.object).id(frame, sz.frame).u32(slots.len() as u32);
        for s in &slots {
            w.u32(s.slot).u8(s.sig.as_bytes()[0]);
        }
        let b = c.call(16, 1, &w.0, T)?;
        let mut r = Rd::new(&b);
        let n = r.u32()?;
        for s in slots.iter().take(n as usize) {
            let v = read_val(c, &mut r)?;
            let (val, ty, rf, ix) = describe(c, d, &v, &s.sig)?;
            out.push((s.name.clone(), val, ty, rf, ix));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- commands

fn js<T: Serialize>(v: R<T>) -> Result<T, JdwpErr> {
    v
}

#[tauri::command]
pub fn jdwp_breakpoints(id: String, file: String, lines: Vec<BpLine>) -> Result<Vec<BpResult>, JdwpErr> {
    with_conn(&id, |c| {
        let st = state(&id);
        let mut d = st.lock().unwrap();
        let ls: Vec<u32> = lines.iter().map(|l| l.line).collect();
        js(set_breakpoints(c, &mut d, &file, &ls))
    })
}

#[tauri::command]
pub fn jdwp_threads(id: String) -> Result<Vec<Value>, JdwpErr> {
    with_conn(&id, |c| {
        let sz = c.sizes();
        let b = c.call(1, 4, &[], T)?;
        let mut r = Rd::new(&b);
        let n = r.u32()?;
        let mut out = Vec::new();
        for _ in 0..n.min(200) {
            let t = r.id(sz.object)?;
            let mut w = Wr::new();
            w.id(t, sz.object);
            let name = c.call(11, 1, &w.0, T).ok().and_then(|b| Rd::new(&b).string().ok()).unwrap_or_default();
            out.push(json!({"id": t, "name": name}));
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn jdwp_stack(id: String, thread: u64) -> Result<Vec<Value>, JdwpErr> {
    with_conn(&id, |c| {
        let sz = c.sizes();
        let st = state(&id);
        let mut d = st.lock().unwrap();
        let mut w = Wr::new();
        w.id(thread, sz.object).u32(0).u32(u32::MAX);
        let b = c.call(11, 6, &w.0, T)?;
        let mut r = Rd::new(&b);
        let n = r.u32()?;
        let mut out = Vec::new();
        d.frames.clear();
        for i in 0..n.min(300) {
            let fid = r.id(sz.frame)?;
            let _tag = r.u8()?;
            let class_id = r.id(sz.ref_type)?;
            let method_id = r.id(sz.method)?;
            let index = r.u64()?;
            d.frames.insert(fid, FrameInfo { thread, class_id, method_id, index });
            let (sig, source) = {
                let ci = class_info(c, &mut d, class_id)?;
                (ci.sig.clone(), ci.source.clone())
            };
            let (mname, line) = {
                let ms = methods(c, &mut d, class_id)?;
                match ms.iter_mut().find(|m| m.id == method_id) {
                    Some(m) => {
                        let t = line_table(c, class_id, m);
                        (m.name.clone(), line_of(&t, index))
                    }
                    None => ("?".into(), 0),
                }
            };
            let cname = nice_type(&sig);
            let path = source.as_deref().and_then(|s| source_path(&mut d, &sig, s));
            let short = cname.rsplit('.').next().unwrap_or(&cname).replace('$', ".");
            out.push(json!({"id": fid, "name": format!("{short}.{mname}"), "line": line, "path": path, "className": cname, "method": mname, "top": i == 0}));
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn jdwp_scopes(id: String, frame: u64) -> Result<Vec<Value>, JdwpErr> {
    with_conn(&id, |_c| {
        let st = state(&id);
        let mut d = st.lock().unwrap();
        if !d.frames.contains_key(&frame) {
            return Err(lerr("the frame is gone"));
        }
        let r = new_ref(&mut d, RefKind::Locals(frame));
        Ok(vec![json!({"name": "Locals", "ref": r, "expensive": false})])
    })
}

#[tauri::command]
pub fn jdwp_variables(id: String, reference: i64) -> Result<Vec<Value>, JdwpErr> {
    with_conn(&id, |c| {
        let st = state(&id);
        let mut d = st.lock().unwrap();
        let k = d.refs.get(&reference).cloned().ok_or_else(|| lerr("stale variable reference (the program resumed)"))?;
        let kids = match k {
            RefKind::Locals(f) => locals_of(c, &mut d, f)?,
            RefKind::Object { id } => fields_of(c, &mut d, id)?,
            RefKind::Array { id, elem, len } => array_elems(c, &mut d, id, &elem, len)?,
        };
        Ok(kids.into_iter().map(|(name, value, ty, rf, ix)| json!({"name": name, "value": value, "type": ty, "ref": rf, "indexed": ix})).collect())
    })
}

#[tauri::command]
pub fn jdwp_resume(id: String) -> Result<(), JdwpErr> {
    with_conn(&id, |c| {
        let st = state(&id);
        {
            let mut d = st.lock().unwrap();
            d.frames.clear();
            d.refs.clear();
        }
        c.call(1, 9, &[], T).map(|_| ())
    })
}

#[tauri::command]
pub fn jdwp_suspend(id: String) -> Result<(), JdwpErr> {
    with_conn(&id, |c| c.call(1, 8, &[], T).map(|_| ()))
}

#[tauri::command]
pub fn jdwp_step(id: String, thread: u64, depth: String) -> Result<(), JdwpErr> {
    with_conn(&id, |c| {
        let sz = c.sizes();
        let st = state(&id);
        let old = {
            let mut d = st.lock().unwrap();
            d.frames.clear();
            d.refs.clear();
            d.step_req.take()
        };
        if let Some(r) = old {
            clear_event(c, EV_STEP, r);
        }
        let dep = match depth.as_str() {
            "into" => 0,
            "out" => 2,
            _ => 1,
        };
        let excl = ["java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*"];
        let mut w = Wr::new();
        w.u8(EV_STEP).u8(2).u32(2 + excl.len() as u32);
        w.u8(10).id(thread, sz.object).u32(1).u32(dep); // Step: line granularity
        for e in excl {
            w.u8(6).string(e); // ClassExclude
        }
        // Count LAST: it ends the request after its first occurrence even when an earlier filter suppressed that event
        w.u8(1).u32(1);
        let req = Rd::new(&c.call(15, 1, &w.0, T)?).u32()?;
        st.lock().unwrap().step_req = Some(req);
        c.call(1, 9, &[], T).map(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_and_names() {
        assert_eq!(package_of("// c\npackage a.b.c;\n\nimport x.Y;\npublic class Z {}"), "a.b.c");
        assert_eq!(package_of("public class Z {}"), "");
        assert!(matches_prefix("La/b/Z;", "La/b/Z"));
        assert!(matches_prefix("La/b/Z$Inner;", "La/b/Z"));
        assert!(matches_prefix("La/b/Z$1;", "La/b/Z"));
        assert!(!matches_prefix("La/b/ZZ;", "La/b/Z"), "another top-level class with the same prefix");
        assert_eq!(nice_type("Ljava/util/Map$Entry;"), "java.util.Map$Entry");
        assert_eq!(nice_type("[[I"), "int[][]");
        assert_eq!(nice_type("[Ljava/lang/String;"), "java.lang.String[]");
        assert_eq!(simple("demo.Probe$Pt"), "Pt");
        assert_eq!(simple("demo.Probe$1"), "Probe$1");
        assert_eq!(simple("java.util.ArrayList"), "ArrayList");
    }

    #[test]
    fn values_print_like_java() {
        assert_eq!(prim_text(b'I', &(-5i32).to_be_bytes()), "-5");
        assert_eq!(prim_text(b'Z', &[1]), "true");
        assert_eq!(prim_text(b'B', &[0xff]), "-1");
        assert_eq!(prim_text(b'C', &[0, 97]), "'a' 97");
        assert_eq!(prim_text(b'F', &1.0f32.to_bits().to_be_bytes()), "1.0");
        assert_eq!(prim_text(b'D', &2.5f64.to_bits().to_be_bytes()), "2.5");
        assert_eq!(prim_text(b'J', &(1i64 << 40).to_be_bytes()), "1099511627776");
        assert_eq!(java_float(f64::NAN), "NaN");
    }

    #[test]
    fn code_index_to_line() {
        let t = vec![(0, 5), (4, 6), (9, 8)];
        assert_eq!((line_of(&t, 0), line_of(&t, 3), line_of(&t, 4), line_of(&t, 100)), (5, 5, 6, 8));
        assert_eq!(line_of(&[], 3), 0);
    }

    #[test]
    fn finds_sources_shortest_path_wins() {
        let d = std::env::temp_dir().join(format!("ace-src-{}", std::process::id()));
        for p in ["src/main/java/demo", "nested/src/main/java/demo", "build/generated/demo"] {
            std::fs::create_dir_all(d.join(p)).unwrap();
            std::fs::write(d.join(p).join("Main.java"), "").unwrap();
        }
        let mut dbg = Dbg { root: d.clone(), ..Default::default() };
        let got = source_path(&mut dbg, "Ldemo/Main;", "Main.java").unwrap();
        assert!(got.ends_with("/src/main/java/demo/Main.java") && !got.contains("nested") && !got.contains("/build/"), "{got}");
        assert!(source_path(&mut dbg, "Ldemo/Nope;", "Nope.java").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
