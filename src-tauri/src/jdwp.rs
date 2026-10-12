//! Minimal JDWP (Java Debug Wire Protocol) client for debugged Gradle runs (docs/GRADLE.md "Debug & hot swap").
//!
//! One *attach session* per Gradle debug run: a thread polls 127.0.0.1:<port> with backoff (the JavaExec of a Loom run is started
//! minutes after the Gradle client; nothing else polls), does the handshake, then reads packets until the VM goes away and starts
//! waiting again (a build may run several JVMs one after another). Implemented commands: Version, IDSizes, CapabilitiesNew,
//! ClassesBySignature, RedefineClasses, EventRequest.Set/Clear, Dispose, plus decoding of VMDeath / ClassPrepare events.
//!
//!   jdwp_free_port() -> port                            a free loopback port for the agent (`address=127.0.0.1:<port>`)
//!   jdwp_attach({id, port, timeoutSecs})                start waiting + attaching; events `jdwp://state/<id>`
//!                                                       {state: waiting|attached|detached|timeout|closed, vm?, port, waitedMs}
//!   jdwp_detach(id, killGame)                           Dispose + stop waiting; killGame also stops the game JVM (never a Gradle daemon)
//!   jdwp_kill_game(port)                                kill the JVMs of this run (marker `-Dace.jdwp=<port>`) and nested gradle clients of it
//!   jdwp_info(id)                                       current attach state
//!   jdwp_events(id, classPattern?)                      enables ClassPrepare events for classes matching the pattern (QA / hot-swap of new classes)
//! The hot swap itself (compile + RedefineClasses) lives in hotswap.rs and uses [`with_conn`].
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, WebviewWindow};

// ---------------------------------------------------------------- wire format

const HANDSHAKE: &[u8] = b"JDWP-Handshake";

#[derive(Debug, Clone, Serialize)]
pub struct JdwpErr {
    pub code: u16,
    pub name: String,
    pub message: String,
}
impl JdwpErr {
    fn local(msg: impl Into<String>) -> Self {
        JdwpErr { code: 0, name: "LOCAL".into(), message: msg.into() }
    }
}
impl std::fmt::Display for JdwpErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub fn err_name(code: u16) -> &'static str {
    match code {
        10 => "INVALID_THREAD",
        20 => "INVALID_CLASS",
        21 => "CLASS_NOT_PREPARED",
        23 => "INVALID_METHODID",
        30 => "INVALID_OBJECT",
        35 => "ABSENT_INFORMATION",
        59 => "VM_DEAD",
        60 => "INVALID_CLASS_FORMAT",
        61 => "CIRCULAR_CLASS_DEFINITION",
        62 => "FAILS_VERIFICATION",
        63 => "ADD_METHOD_NOT_IMPLEMENTED",
        64 => "SCHEMA_CHANGE_NOT_IMPLEMENTED",
        65 => "INVALID_TYPESTATE",
        66 => "HIERARCHY_CHANGE_NOT_IMPLEMENTED",
        67 => "DELETE_METHOD_NOT_IMPLEMENTED",
        68 => "UNSUPPORTED_VERSION",
        69 => "NAMES_DONT_MATCH",
        70 => "CLASS_MODIFIERS_CHANGE_NOT_IMPLEMENTED",
        71 => "METHOD_MODIFIERS_CHANGE_NOT_IMPLEMENTED",
        99 => "NOT_IMPLEMENTED",
        100 => "NULL_POINTER",
        103 => "INVALID_LENGTH",
        110 => "OUT_OF_MEMORY",
        113 => "INTERNAL",
        _ => "ERROR",
    }
}

/// Human text for the errors a class redefinition can fail with (what the user sees in the Debug console).
pub fn redefine_message(code: u16, enhanced: bool) -> String {
    let hint = if enhanced { "" } else { " Enable \"Enhanced HotSwap\" in the run configuration (JetBrains Runtime) to allow structural changes." };
    match code {
        63 => format!("Cannot reload: a method was added (ADD_METHOD_NOT_IMPLEMENTED).{hint}"),
        64 => format!("Cannot reload: fields or the class layout changed, i.e. a schema change (SCHEMA_CHANGE_NOT_IMPLEMENTED).{hint}"),
        66 => format!("Cannot reload: the class hierarchy changed (HIERARCHY_CHANGE_NOT_IMPLEMENTED).{hint}"),
        67 => format!("Cannot reload: a method was deleted (DELETE_METHOD_NOT_IMPLEMENTED).{hint}"),
        70 | 71 => format!("Cannot reload: class or method modifiers changed ({}).{hint}", err_name(code)),
        62 => "Cannot reload: the new class fails bytecode verification (FAILS_VERIFICATION).".into(),
        60 => "Cannot reload: the compiled class file is not valid for this JVM (INVALID_CLASS_FORMAT).".into(),
        68 => "Cannot reload: the class file version is newer than the debugged JVM supports (UNSUPPORTED_VERSION).".into(),
        69 => "Cannot reload: the class name does not match the loaded class (NAMES_DONT_MATCH).".into(),
        _ => format!("The JVM rejected the new class definition: {} ({code}).", err_name(code)),
    }
}

#[derive(Debug, Default, Clone, Copy)]
#[allow(dead_code)]
pub struct Sizes {
    pub field: usize,
    pub method: usize,
    pub object: usize,
    pub ref_type: usize,
    pub frame: usize,
}

struct Pkt {
    err: u16,
    reply: bool,
    set: u8,
    cmd: u8,
    id: u32,
    data: Vec<u8>,
}

pub struct Wr(pub Vec<u8>);
impl Wr {
    pub fn new() -> Self {
        Wr(Vec::new())
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn id(&mut self, v: u64, size: usize) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes()[8 - size..]);
        self
    }
    pub fn string(&mut self, s: &str) -> &mut Self {
        self.u32(s.len() as u32);
        self.0.extend_from_slice(s.as_bytes());
        self
    }
    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.0.extend_from_slice(b);
        self
    }
}

pub struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> Rd<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Rd { b, i: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], JdwpErr> {
        if self.i + n > self.b.len() {
            return Err(JdwpErr::local("truncated JDWP packet"));
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, JdwpErr> {
        Ok(self.take(1)?[0])
    }
    pub fn u32(&mut self) -> Result<u32, JdwpErr> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn u64(&mut self) -> Result<u64, JdwpErr> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    pub fn raw(&mut self, n: usize) -> Result<&'a [u8], JdwpErr> {
        self.take(n)
    }
    pub fn id(&mut self, size: usize) -> Result<u64, JdwpErr> {
        let b = self.take(size)?;
        let mut a = [0u8; 8];
        a[8 - size..].copy_from_slice(b);
        Ok(u64::from_be_bytes(a))
    }
    pub fn string(&mut self) -> Result<String, JdwpErr> {
        let n = self.u32()? as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
}

fn read_pkt(s: &mut TcpStream) -> std::io::Result<Pkt> {
    let mut h = [0u8; 11];
    s.read_exact(&mut h)?;
    let len = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
    let id = u32::from_be_bytes([h[4], h[5], h[6], h[7]]);
    let reply = h[8] & 0x80 != 0;
    if len < 11 || len > 256 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad JDWP packet length"));
    }
    let mut data = vec![0u8; len - 11];
    s.read_exact(&mut data)?;
    Ok(if reply {
        Pkt { err: u16::from_be_bytes([h[9], h[10]]), reply, set: 0, cmd: 0, id, data }
    } else {
        Pkt { err: 0, reply, set: h[9], cmd: h[10], id, data }
    })
}

// ---------------------------------------------------------------- connection

/// `ACE_JDWP_TRACE=1`: every packet to stderr (debugging the debugger).
fn trace() -> bool {
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(|| crate::appenv::var_os("ACE_JDWP_TRACE").is_some())
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join("")
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VmInfo {
    pub description: String,
    pub vm_name: String,
    pub vm_version: String,
    pub jdwp: String,
    pub can_redefine: bool,
    pub can_add_method: bool,
    pub can_unrestricted_redefine: bool,
    /// pid of the debuggee is not part of JDWP; the QA/UI use `java.version` style info only
    pub java_version: String,
    /// `java.class.path` of the VM (decides which of several projects compiling a file the running game uses)
    #[serde(skip)]
    pub class_path: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VmEvent {
    /// vmDeath | vmStart | classPrepare | breakpoint | step
    pub kind: String,
    pub signature: Option<String>,
    pub request_id: u32,
    /// 0 none, 1 event thread, 2 all: what the VM suspended for this event
    pub suspend_policy: u8,
    pub thread: u64,
    pub class_id: u64,
    pub method_id: u64,
    pub index: u64,
}
impl VmEvent {
    fn new(kind: &str, request_id: u32, suspend_policy: u8) -> Self {
        VmEvent { kind: kind.into(), signature: None, request_id, suspend_policy, thread: 0, class_id: 0, method_id: 0, index: 0 }
    }
}

pub struct Conn {
    w: Mutex<TcpStream>,
    pending: Mutex<HashMap<u32, Sender<Pkt>>>,
    next: AtomicU32,
    sizes: Mutex<Sizes>,
    closed: AtomicBool,
    pub info: Mutex<VmInfo>,
}

impl Conn {
    /// Connect + handshake. `None` while nothing listens yet or the peer is not (yet) a JDWP agent.
    fn open(port: u16) -> Option<(Arc<Conn>, TcpStream)> {
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).ok()?;
        let _ = s.set_nodelay(true);
        s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
        s.write_all(HANDSHAKE).ok()?;
        let mut b = [0u8; 14];
        s.read_exact(&mut b).ok()?;
        if b != HANDSHAKE {
            return None;
        }
        s.set_read_timeout(None).ok()?;
        let reader = s.try_clone().ok()?;
        let c = Arc::new(Conn { w: Mutex::new(s), pending: Mutex::new(HashMap::new()), next: AtomicU32::new(1), sizes: Mutex::new(Sizes::default()), closed: AtomicBool::new(false), info: Mutex::new(VmInfo::default()) });
        Some((c, reader))
    }

    pub fn sizes(&self) -> Sizes {
        *self.sizes.lock().unwrap()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn send(&self, set: u8, cmd: u8, data: &[u8]) -> Result<std::sync::mpsc::Receiver<Pkt>, JdwpErr> {
        if self.is_closed() {
            return Err(JdwpErr::local("the JVM is gone"));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        if trace() {
            eprintln!("[jdwp] > {id} {set}/{cmd} {} bytes: {}", data.len(), hex(&data[..data.len().min(96)]));
        }
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut p = Vec::with_capacity(11 + data.len());
        p.extend_from_slice(&((11 + data.len()) as u32).to_be_bytes());
        p.extend_from_slice(&id.to_be_bytes());
        p.push(0);
        p.push(set);
        p.push(cmd);
        p.extend_from_slice(data);
        let r = self.w.lock().unwrap().write_all(&p);
        if r.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(JdwpErr::local("lost the connection to the JVM"));
        }
        Ok(rx)
    }

    /// One request / reply. Errors carry the JDWP error code.
    pub fn call(&self, set: u8, cmd: u8, data: &[u8], timeout: Duration) -> Result<Vec<u8>, JdwpErr> {
        let rx = self.send(set, cmd, data)?;
        match rx.recv_timeout(timeout) {
            Ok(p) if p.err == 0 => Ok(p.data),
            Ok(p) => Err(JdwpErr { code: p.err, name: err_name(p.err).into(), message: format!("{} ({})", err_name(p.err), p.err) }),
            Err(_) => Err(JdwpErr::local(if self.is_closed() { "the JVM exited" } else { "the JVM did not answer in time" })),
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.w.lock().unwrap().shutdown(Shutdown::Both);
        self.pending.lock().unwrap().clear();
    }

    // ---- commands
    fn load_id_sizes(&self) -> Result<(), JdwpErr> {
        let d = self.call(1, 7, &[], Duration::from_secs(10))?;
        let mut r = Rd::new(&d);
        let mut n = || r.u32().map(|v| v as usize);
        let z = Sizes { field: n()?, method: n()?, object: n()?, ref_type: n()?, frame: n()? };
        *self.sizes.lock().unwrap() = z;
        Ok(())
    }

    fn version(&self) -> Result<VmInfo, JdwpErr> {
        let d = self.call(1, 1, &[], Duration::from_secs(10))?;
        let mut r = Rd::new(&d);
        let description = r.string()?;
        let (maj, min) = (r.u32()?, r.u32()?);
        let vm_version = r.string()?;
        let vm_name = r.string()?;
        let mut info = VmInfo { description, vm_name, vm_version: vm_version.clone(), jdwp: format!("{maj}.{min}"), java_version: vm_version, ..Default::default() };
        if let Ok(c) = self.call(1, 17, &[], Duration::from_secs(10)) {
            // CapabilitiesNew: 32 booleans; 7 canRedefineClasses, 8 canAddMethod, 9 canUnrestrictedlyRedefineClasses
            if c.len() > 9 {
                info.can_redefine = c[7] != 0;
                info.can_add_method = c[8] != 0;
                info.can_unrestricted_redefine = c[9] != 0;
            }
        }
        if let Ok(b) = self.call(1, 13, &[], Duration::from_secs(10)) {
            let mut r = Rd::new(&b);
            let _ = (|| -> Result<(), JdwpErr> {
                let _base = r.string()?;
                for _ in 0..r.u32()? {
                    info.class_path.push(r.string()?);
                }
                Ok(())
            })();
        }
        Ok(info)
    }

    /// All loaded reference types with this JNI signature (`Lcom/x/Foo;`): several when more than one class loader defines it.
    pub fn classes_by_signature(&self, sig: &str) -> Result<Vec<u64>, JdwpErr> {
        let mut w = Wr::new();
        w.string(sig);
        let d = self.call(1, 2, &w.0, Duration::from_secs(30))?;
        let mut r = Rd::new(&d);
        let n = r.u32()?;
        let mut out = Vec::new();
        for _ in 0..n {
            let _tag = r.u8()?;
            let id = r.id(self.sizes().ref_type)?;
            let _status = r.u32()?;
            out.push(id);
        }
        Ok(out)
    }

    /// One atomic RedefineClasses call. `classes` = (reference type id, class file bytes).
    pub fn redefine(&self, classes: &[(u64, Vec<u8>)]) -> Result<(), JdwpErr> {
        let mut w = Wr::new();
        w.u32(classes.len() as u32);
        for (id, bytes) in classes {
            w.id(*id, self.sizes().ref_type).u32(bytes.len() as u32).bytes(bytes);
        }
        self.call(1, 18, &w.0, Duration::from_secs(120)).map(|_| ())
    }

    /// EventRequest.Set with an optional ClassMatch filter (kind 8 = CLASS_PREPARE, 99 = VM_DEATH). Returns the request id.
    pub fn event_request(&self, kind: u8, class_pattern: Option<&str>) -> Result<u32, JdwpErr> {
        let mut w = Wr::new();
        w.u8(kind).u8(0); // suspendPolicy NONE
        match class_pattern {
            Some(p) => {
                w.u32(1).u8(5).string(p); // ClassMatch
            }
            None => {
                w.u32(0);
            }
        }
        let d = self.call(15, 1, &w.0, Duration::from_secs(10))?;
        Rd::new(&d).u32()
    }

    pub fn dispose(&self) {
        let _ = self.call(1, 6, &[], Duration::from_millis(800));
    }
}

/// Reader loop: dispatches replies, decodes events. Returns when the connection ends. `on_event` must not block (it only queues).
fn read_loop(conn: &Arc<Conn>, mut s: TcpStream, on_event: &dyn Fn(VmEvent)) {
    loop {
        let p = match read_pkt(&mut s) {
            Ok(p) => p,
            Err(_) => break,
        };
        if trace() {
            eprintln!("[jdwp] < {} {} err={} {}/{} {} bytes: {}", if p.reply { "reply" } else { "event" }, p.id, p.err, p.set, p.cmd, p.data.len(), hex(&p.data[..p.data.len().min(96)]));
        }
        if p.reply {
            if let Some(tx) = conn.pending.lock().unwrap().remove(&p.id) {
                let _ = tx.send(p);
            }
        } else if p.set == 64 && p.cmd == 100 {
            let mut r = Rd::new(&p.data);
            let sz = conn.sizes();
            let _ = (|| -> Result<(), JdwpErr> {
                let policy = r.u8()?;
                let n = r.u32()?;
                for _ in 0..n {
                    let kind = r.u8()?;
                    let req = r.u32()?;
                    match kind {
                        99 => on_event(VmEvent::new("vmDeath", req, policy)),
                        90 => {
                            let mut e = VmEvent::new("vmStart", req, policy);
                            e.thread = r.id(sz.object)?;
                            on_event(e);
                        }
                        1 | 2 => {
                            let mut e = VmEvent::new(if kind == 1 { "step" } else { "breakpoint" }, req, policy);
                            e.thread = r.id(sz.object)?;
                            let _tag = r.u8()?;
                            e.class_id = r.id(sz.ref_type)?;
                            e.method_id = r.id(sz.method)?;
                            e.index = r.u64()?;
                            on_event(e);
                        }
                        8 => {
                            let mut e = VmEvent::new("classPrepare", req, policy);
                            e.thread = r.id(sz.object)?;
                            let _tag = r.u8()?;
                            e.class_id = r.id(sz.ref_type)?;
                            e.signature = Some(r.string()?);
                            let _status = r.u32()?;
                            on_event(e);
                        }
                        _ => return Ok(()), // an event kind we did not ask for: stop decoding this composite
                    }
                }
                Ok(())
            })();
        }
    }
    conn.close();
}

// ---------------------------------------------------------------- attach sessions

struct Sess {
    owner: String,
    port: u16,
    cancel: Arc<AtomicBool>,
    conn: Arc<Mutex<Option<Arc<Conn>>>>,
    proc_id: u64,
    state: Arc<Mutex<serde_json::Value>>,
}

fn sessions() -> &'static Mutex<HashMap<String, Sess>> {
    static S: OnceLock<Mutex<HashMap<String, Sess>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// The connection of a session, or an error explaining why there is none.
pub fn with_conn<T>(id: &str, f: impl FnOnce(&Arc<Conn>) -> Result<T, JdwpErr>) -> Result<T, JdwpErr> {
    let c = {
        let g = sessions().lock().unwrap();
        let s = g.get(id).ok_or_else(|| JdwpErr::local("there is no debug session"))?;
        let c = s.conn.lock().unwrap().clone();
        c
    };
    match c {
        Some(c) if !c.is_closed() => f(&c),
        _ => Err(JdwpErr::local("the debugger is not attached to a JVM (still waiting for the game to start)")),
    }
}

/// Markers that identify the processes of one debug run: the JavaExec JVM (`-Dace.jdwp=<port>`), nested gradle clients (init script name).
pub fn markers(port: u16) -> Vec<String> {
    // trailing spaces / the full file name keep `…:1234` from matching port 12345
    vec![format!("-Dace.jdwp={port} "), format!("ace-debug-{port}.gradle"), format!("address=127.0.0.1:{port} ")]
}

pub fn kill_game(port: u16) -> Vec<u32> {
    crate::procs::kill_marked(&markers(port), Duration::from_millis(1500))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachArgs {
    pub id: String,
    pub port: u16,
    /// how long to wait for the JVM to open the port (per wait period)
    pub timeout_secs: u64,
    /// project root (source lookup for stack frames)
    #[serde(default)]
    pub root: String,
}

fn emit_state(app: &AppHandle, owner: &str, id: &str, state: &Arc<Mutex<serde_json::Value>>, v: serde_json::Value) {
    *state.lock().unwrap() = v.clone();
    crate::windows::emit_window(app, owner, &format!("jdwp://state/{id}"), v);
}

#[tauri::command]
pub fn jdwp_free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn jdwp_attach(app: AppHandle, window: WebviewWindow, args: AttachArgs) -> Result<(), String> {
    let owner = window.label().to_string();
    let AttachArgs { id, port, timeout_secs, root } = args;
    crate::jdwp_dbg::init(&id, &root);
    if sessions().lock().unwrap().contains_key(&id) {
        return Err("session exists".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let conn_slot: Arc<Mutex<Option<Arc<Conn>>>> = Arc::new(Mutex::new(None));
    let state = Arc::new(Mutex::new(serde_json::json!({"state": "waiting", "port": port})));
    // window close / app exit: stop the game JVM of this run (the client's tree does not contain it, it is a child of the daemon)
    let proc_id = crate::procs::register_killer_for(&owner, "jdwp", &format!("debug run :{port}"), None, Box::new(move || {
        kill_game(port);
    }));
    sessions().lock().unwrap().insert(id.clone(), Sess { owner: owner.clone(), port, cancel: cancel.clone(), conn: conn_slot.clone(), proc_id, state: state.clone() });
    std::thread::Builder::new()
        .name(format!("jdwp-{port}"))
        .spawn(move || {
            let emit = |v: serde_json::Value| emit_state(&app, &owner, &id, &state, v);
            'outer: loop {
                // ---- wait for the port with backoff (the only polling: bounded by timeout_secs, ends on attach / cancel)
                let t0 = Instant::now();
                emit(serde_json::json!({"state": "waiting", "port": port, "waitedMs": 0}));
                let mut delay = Duration::from_millis(150);
                let (conn, reader) = loop {
                    if cancel.load(Ordering::SeqCst) {
                        break 'outer;
                    }
                    if let Some(a) = Conn::open(port) {
                        break a;
                    }
                    if t0.elapsed() > Duration::from_secs(timeout_secs) {
                        emit(serde_json::json!({"state": "timeout", "port": port, "waitedMs": t0.elapsed().as_millis() as u64}));
                        break 'outer;
                    }
                    let until = Instant::now() + delay;
                    while Instant::now() < until && !cancel.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    delay = (delay * 3 / 2).min(Duration::from_secs(2));
                };
                // ---- attached: reader thread, then the handshake queries
                let (done_tx, done_rx) = channel::<()>();
                crate::jdwp_dbg::reset(&id);
                {
                    // events are handled on a worker (deferred breakpoints issue synchronous requests, which the reader must keep serving)
                    let (etx, erx) = channel::<VmEvent>();
                    let (c, a, o, i) = (conn.clone(), app.clone(), owner.clone(), id.clone());
                    std::thread::spawn(move || {
                        for e in erx {
                            crate::jdwp_dbg::on_event(&a, &o, &i, &c, e);
                        }
                    });
                    let (c, i) = (conn.clone(), id.clone());
                    let _ = i;
                    std::thread::spawn(move || {
                        read_loop(&c, reader, &|e| { let _ = etx.send(e); });
                        let _ = done_tx.send(());
                    });
                }
                let ready = conn.load_id_sizes().and_then(|_| conn.version());
                match ready {
                    Ok(info) => {
                        *conn.info.lock().unwrap() = info.clone();
                        let _ = conn.event_request(99, None); // VM_DEATH
                        *conn_slot.lock().unwrap() = Some(conn.clone());
                        emit(serde_json::json!({"state": "attached", "port": port, "vm": info, "waitedMs": t0.elapsed().as_millis() as u64}));
                    }
                    Err(_) => {
                        // not a usable JVM (yet): drop and look again
                        conn.close();
                        let _ = done_rx.recv();
                        continue;
                    }
                }
                let _ = done_rx.recv(); // blocks until the VM exits / the socket closes (no polling)
                *conn_slot.lock().unwrap() = None;
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                emit(serde_json::json!({"state": "detached", "port": port}));
            }
            if let Some(s) = sessions().lock().unwrap().remove(&id) {
                crate::procs::unregister(s.proc_id);
            }
            crate::jdwp_dbg::drop_session(&id);
            let st = state.lock().unwrap().clone();
            if st["state"] != "timeout" {
                emit(serde_json::json!({"state": "closed", "port": port}));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn jdwp_info(id: String) -> Option<serde_json::Value> {
    sessions().lock().unwrap().get(&id).map(|s| s.state.lock().unwrap().clone())
}

/// Stop attaching / disconnect (Dispose, the JVM keeps running). `kill_game` also stops the run's JVMs.
#[tauri::command]
pub fn jdwp_detach(id: String, kill: bool) {
    let s = sessions().lock().unwrap().get(&id).map(|s| (s.cancel.clone(), s.conn.clone(), s.port));
    if let Some((cancel, conn, port)) = s {
        cancel.store(true, Ordering::SeqCst);
        let c = conn.lock().unwrap().clone();
        if let Some(c) = c {
            if !kill {
                c.dispose();
            }
            c.close();
        }
        if kill {
            std::thread::spawn(move || {
                kill_game(port);
            });
        }
    }
}

#[tauri::command]
pub fn jdwp_kill_game(port: u16) -> Vec<u32> {
    kill_game(port)
}

/// ClassPrepare events (`jdwp://event/<id>`) for classes matching `pattern` (e.g. `com.example.*`).
#[tauri::command]
pub fn jdwp_events(id: String, class_pattern: String) -> Result<u32, JdwpErr> {
    with_conn(&id, |c| c.event_request(8, Some(&class_pattern)))
}

pub fn release_window(label: &str) {
    // the killers registered with procs (kill_owner) stop the JVMs; here only the threads are cancelled
    let mut g = sessions().lock().unwrap();
    for s in g.values().filter(|s| s.owner == label) {
        s.cancel.store(true, Ordering::SeqCst);
        if let Some(c) = s.conn.lock().unwrap().clone() {
            c.close();
        }
    }
    g.retain(|_, s| s.owner != label);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn reply(s: &mut TcpStream, id: u32, err: u16, data: &[u8]) {
        let mut p = Vec::new();
        p.extend_from_slice(&((11 + data.len()) as u32).to_be_bytes());
        p.extend_from_slice(&id.to_be_bytes());
        p.push(0x80);
        p.extend_from_slice(&err.to_be_bytes());
        p.extend_from_slice(data);
        s.write_all(&p).unwrap();
    }

    /// A tiny fake JVM: handshake, IDSizes, Version, ClassesBySignature (one class), RedefineClasses -> ADD_METHOD_NOT_IMPLEMENTED.
    #[test]
    fn client_talks_to_a_fake_vm() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut hs = [0u8; 14];
            s.read_exact(&mut hs).unwrap();
            s.write_all(&hs).unwrap();
            loop {
                let Ok(p) = read_pkt(&mut s) else { break };
                match (p.set, p.cmd) {
                    (1, 7) => reply(&mut s, p.id, 0, &[0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8]),
                    (1, 1) => {
                        let mut w = Wr::new();
                        w.string("Fake VM").u32(1).u32(8).string("21.0.9").string("FakeVM");
                        reply(&mut s, p.id, 0, &w.0)
                    }
                    (1, 17) => reply(&mut s, p.id, 0, &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
                    (1, 2) => {
                        let mut w = Wr::new();
                        w.u32(1).u8(1).id(0x1234, 8).u32(7);
                        reply(&mut s, p.id, 0, &w.0)
                    }
                    (1, 18) => reply(&mut s, p.id, 63, &[]),
                    (1, 6) => {
                        reply(&mut s, p.id, 0, &[]);
                        break;
                    }
                    _ => reply(&mut s, p.id, 99, &[]),
                }
            }
        });
        let (conn, reader) = Conn::open(port).expect("handshake");
        let c2 = conn.clone();
        std::thread::spawn(move || read_loop(&c2, reader, &|_| {}));
        conn.load_id_sizes().unwrap();
        assert_eq!(conn.sizes().ref_type, 8);
        let v = conn.version().unwrap();
        assert_eq!((v.vm_name.as_str(), v.vm_version.as_str(), v.jdwp.as_str()), ("FakeVM", "21.0.9", "1.8"));
        assert!(v.can_redefine && !v.can_add_method);
        assert_eq!(conn.classes_by_signature("Lx/Y;").unwrap(), vec![0x1234]);
        let e = conn.redefine(&[(0x1234, vec![0xCA, 0xFE])]).unwrap_err();
        assert_eq!((e.code, e.name.as_str()), (63, "ADD_METHOD_NOT_IMPLEMENTED"));
        assert!(redefine_message(63, false).contains("Enhanced HotSwap"));
        conn.dispose();
        h.join().unwrap();
    }

    #[test]
    fn handshake_rejects_non_jdwp() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let _ = s.write_all(b"HTTP/1.1 400 Bad\r\n\r\n");
        });
        assert!(Conn::open(port).is_none());
    }

    #[test]
    fn markers_match_exact_port() {
        let m = markers(4321);
        assert!(m.iter().any(|x| "java -Dace.jdwp=4321 -cp x".contains(x.as_str())));
        assert!(!m.iter().any(|x| "java -Dace.jdwp=43210 -cp x".contains(x.as_str())));
    }
}
