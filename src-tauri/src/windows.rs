//! Multi-project windows, IntelliJ-on-macOS style: ONE PROJECT PER WINDOW, windows merged into native macOS tabs.
//!
//! * Every project lives in its own `WebviewWindow` labelled `project-<n>`; all share the NSWindow tabbing identifier
//!   [`TAB_ID`] with `tabbingMode = .preferred`, and a new project window is attached to the current frame with
//!   `addTabbedWindow:ordered:` (so it becomes a native tab; dragging a tab out, Window > Merge All Windows and the
//!   tab overview are AppKit's own).
//! * The registry here (label -> project) is the source of truth: `launch_location` returns the window's project, so a
//!   reload (used for "open in this window") comes back to the same project.
//! * Events are delivered per window (`emit_window`); shared resources (fs watchers, search index, Godot per root, ssh
//!   masters) are reference counted by window label and released by [`cleanup_window`] when a window closes.
//! * Lifecycle: closing a window asks its webview first (`window://close-requested`: save/discard prompt), then destroys
//!   it and kills only the children it owns (`procs::kill_owner`). The last project window closing leaves a Welcome
//!   window (IntelliJ shows the welcome screen); closing the Welcome window (or Quit) exits.
//! * Session: the open projects (tab order, active one) are written to `session.json` on every change and reopened on
//!   a launch without arguments.
use crate::Location;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const TAB_ID: &str = "atelier-projects";
pub const PREFIX: &str = "project-";

#[derive(Clone)]
struct WinRec {
    label: String,
    project: Option<Location>,
}

#[derive(Default)]
struct State {
    next: u32,
    wins: Vec<WinRec>, // creation order
    active: Option<String>,
    closing: HashSet<String>, // closes the webview already confirmed
    quit_queue: Vec<String>,
    quitting: bool,
    last_closed_had_project: bool,
}

fn st() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
}

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn remember_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Called by the signal handler right before `process::exit`.
pub fn on_signal_exit() {
    if let Some(app) = APP.get() {
        tauri_plugin_single_instance::destroy(app);
    }
}

// ---------- helpers shared by the other modules ----------

/// Deliver `event` to ONE window (by label) only.
pub fn emit_window<S: Serialize + Clone>(app: &AppHandle, label: &str, event: &str, payload: S) {
    let _ = app.emit_to(label, event, payload);
}

/// Deliver `event` to each window label in `labels`.
pub fn emit_windows<'a, S: Serialize + Clone>(app: &AppHandle, labels: impl IntoIterator<Item = &'a String>, event: &str, payload: S) {
    for l in labels {
        let _ = app.emit_to(l.as_str(), event, payload.clone());
    }
}

/// Run `f` on the main thread and wait for its result (direct call when already there).
pub fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    #[cfg(target_os = "macos")]
    if objc2_foundation::MainThreadMarker::new().is_some() {
        return Some(f());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

pub fn norm(l: &Location) -> Location {
    let mut p = l.path.clone();
    while p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    Location { host: if l.host.is_empty() { "local".into() } else { l.host.clone() }, path: p }
}

pub fn project_title(l: Option<&Location>) -> String {
    match l {
        None => "Atelier".into(),
        Some(l) => {
            let name = l.path.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(&l.path).to_string();
            if l.is_local() { name } else { format!("{name} \u{2014} {}", l.host) }
        }
    }
}

// ---------- native tabbing (macOS) ----------

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowTabbingMode};
    use tauri::WebviewWindow;

    pub fn ns(w: &WebviewWindow) -> Option<*mut NSWindow> {
        w.ns_window().ok().map(|p| p as *mut NSWindow)
    }

    /// Main thread only. Prefer tabs for `new`, and merge it into the frame of `anchor` when given.
    pub fn attach(new: &WebviewWindow, anchor: Option<&WebviewWindow>) {
        unsafe {
            let Some(n) = ns(new).and_then(|p| p.as_ref()) else { return };
            n.setTabbingMode(NSWindowTabbingMode::Preferred);
            if let Some(a) = anchor.and_then(ns).and_then(|p| p.as_ref()) {
                if a.tabbingIdentifier() == n.tabbingIdentifier() {
                    a.addTabbedWindow_ordered(n, NSWindowOrderingMode::Above);
                }
            }
        }
    }

    /// Pointers of the windows in `w`'s tab group, in tab order (empty when not tabbed).
    pub fn tab_ptrs(w: &WebviewWindow) -> Vec<*mut NSWindow> {
        unsafe {
            let Some(n) = ns(w).and_then(|p| p.as_ref()) else { return vec![] };
            n.tabbedWindows().map(|a| a.iter().map(|x| objc2::rc::Retained::as_ptr(&x) as *mut NSWindow).collect()).unwrap_or_default()
        }
    }

    pub fn select(w: &WebviewWindow) {
        unsafe {
            let Some(n) = ns(w).and_then(|p| p.as_ref()) else { return };
            if let Some(g) = n.tabGroup() {
                g.setSelectedWindow(Some(n));
            }
            n.makeKeyAndOrderFront(None);
        }
    }

    /// Main thread only: bring the app to the front (a launched / re-invoked `atelier <path>` must show its window).
    pub fn activate() {
        if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
            #[allow(deprecated)]
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    }

    pub fn info(w: &WebviewWindow) -> (String, i64, bool) {
        unsafe {
            let Some(n) = ns(w).and_then(|p| p.as_ref()) else { return (String::new(), -1, false) };
            (n.tabbingIdentifier().to_string(), n.tabbingMode().0 as i64, n.isKeyWindow())
        }
    }
}

/// Labels of the windows tabbed together with `label` (tab order); just `[label]` when it is alone.
fn tab_labels(app: &AppHandle, label: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Some(w) = app.get_webview_window(label) else { return vec![label.to_string()] };
        let app2 = app.clone();
        let out = on_main(app, move || {
            let ptrs = mac::tab_ptrs(&w);
            if ptrs.is_empty() {
                return vec![];
            }
            let mut out = vec![];
            for p in ptrs {
                if let Some((l, _)) = app2.webview_windows().into_iter().find(|(_, ww)| mac::ns(ww) == Some(p)) {
                    out.push(l);
                }
            }
            out
        })
        .unwrap_or_default();
        if out.is_empty() { vec![label.to_string()] } else { out }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        vec![label.to_string()]
    }
}

/// All project windows: tab groups contiguous and in tab order; groups ordered by their first-created member.
pub fn ordered_labels(app: &AppHandle) -> Vec<String> {
    let created: Vec<String> = st().lock().wins.iter().map(|w| w.label.clone()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = vec![];
    for l in &created {
        if seen.contains(l) {
            continue;
        }
        for t in tab_labels(app, l) {
            if created.contains(&t) && seen.insert(t.clone()) {
                out.push(t);
            }
        }
    }
    out
}

// ---------- window creation / focus ----------

/// Show the active window and activate the app (launch, second instance, open-file events).
pub fn activate(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = on_main(app, mac::activate);
    if let Some(l) = active_or_first() {
        focus(app, &l);
    }
}

/// The active window, else the first one. Takes the state lock once and releases it before returning.
fn active_or_first() -> Option<String> {
    let s = st().lock();
    s.active.clone().or_else(|| s.wins.first().map(|w| w.label.clone()))
}

fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        // Record the intent now: Focused(true) arrives later, and `activate` (often called right after) re-focuses `active`.
        let changed_active = {
            let mut s = st().lock();
            let c = s.active.as_deref() != Some(label);
            s.active = Some(label.to_string());
            c
        };
        if changed_active {
            changed(app);
        }
        let w2 = w.clone();
        let _ = on_main(app, move || {
            let _ = w2.unminimize();
            let _ = w2.show();
            #[cfg(target_os = "macos")]
            mac::select(&w2);
        });
        let _ = w.set_focus();
    }
}

fn find_project(loc: &Location) -> Option<String> {
    let loc = norm(loc);
    st().lock().wins.iter().find(|w| w.project.as_ref().map(norm).as_ref() == Some(&loc)).map(|w| w.label.clone())
}

fn project_of(label: &str) -> Option<Location> {
    st().lock().wins.iter().find(|w| w.label == label).and_then(|w| w.project.clone())
}

/// Create a project window (new native tab of `anchor`'s frame, else of the active window's frame).
pub fn create_window(app: &AppHandle, project: Option<Location>, anchor: Option<&str>) -> Result<String, String> {
    let project = project.map(|p| norm(&p));
    let anchor_label = anchor.map(String::from).or_else(|| st().lock().active.clone()).filter(|l| app.get_webview_window(l).is_some()).or_else(|| {
        st().lock().wins.iter().map(|w| w.label.clone()).find(|l| app.get_webview_window(l).is_some())
    });
    let label = {
        let mut s = st().lock();
        s.next += 1;
        let l = format!("{PREFIX}{}", s.next);
        s.wins.push(WinRec { label: l.clone(), project: project.clone() });
        l
    };
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(project_title(project.as_ref()))
        .inner_size(1500.0, 950.0)
        .min_inner_size(900.0, 600.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).tabbing_identifier(TAB_ID);
    }
    let win = match b.build() {
        Ok(w) => w,
        Err(e) => {
            st().lock().wins.retain(|w| w.label != label);
            return Err(e.to_string());
        }
    };
    #[cfg(target_os = "macos")]
    {
        let anchor_win = anchor_label.and_then(|l| app.get_webview_window(&l));
        let w2 = win.clone();
        let _ = on_main(app, move || {
            mac::attach(&w2, anchor_win.as_ref());
            mac::select(&w2);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = anchor_label;
    let _ = win.show();
    let _ = win.set_focus();
    st().lock().active = Some(label.clone());
    changed(app);
    Ok(label)
}

// ---------- persistence ----------

fn data_dir() -> Option<std::path::PathBuf> {
    if let Some(d) = std::env::var_os("ATELIER_DATA_DIR") {
        return Some(d.into());
    }
    Some(dirs::data_dir()?.join("com.alexw.atelier"))
}

#[derive(Serialize, Deserialize, Default)]
struct Session {
    projects: Vec<Location>,
    active: usize,
}

fn persist(app: &AppHandle) {
    // `changed` persists from unordered threads: serialise snapshot+write so a stale snapshot never lands last.
    static WRITE: OnceLock<Mutex<()>> = OnceLock::new();
    let _w = WRITE.get_or_init(Default::default).lock();
    if st().lock().quitting {
        return;
    }
    let order = ordered_labels(app);
    let (projects, active) = {
        let s = st().lock();
        let mut projects = vec![];
        let mut active = 0;
        for l in &order {
            if let Some(p) = s.wins.iter().find(|w| &w.label == l).and_then(|w| w.project.clone()) {
                if s.active.as_deref() == Some(l.as_str()) {
                    active = projects.len();
                }
                projects.push(p);
            }
        }
        (projects, active)
    };
    let Some(dir) = data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(bytes) = serde_json::to_vec(&Session { projects, active }) {
        let tmp = dir.join("session.json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(tmp, dir.join("session.json"));
        }
    }
}

fn read_session() -> Session {
    let Some(dir) = data_dir() else { return Session::default() };
    std::fs::read(dir.join("session.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Registry changed: refresh the native menu, the session file and tell every window.
pub fn changed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        persist(&app);
        crate::menu::refresh(&app);
        let _ = app.emit("windows://changed", ());
    });
}

// ---------- startup / external opens ----------

/// At launch: the project from argv, else the previous session, else a Welcome window.
pub fn startup(app: &AppHandle) {
    remember_app(app);
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().ok();
    if let Some(loc) = crate::location::parse_args(&argv, cwd.as_deref()) {
        let _ = create_window(app, Some(loc), None);
        return;
    }
    let sess = read_session();
    let mut made: Vec<String> = vec![];
    let mut active_label = None;
    for (i, p) in sess.projects.iter().enumerate() {
        if p.is_local() && !std::path::Path::new(&p.path).is_dir() {
            continue;
        }
        if let Ok(l) = create_window(app, Some(p.clone()), made.first().map(String::as_str)) {
            if i == sess.active {
                active_label = Some(l.clone());
            }
            made.push(l);
        }
    }
    if made.is_empty() {
        let _ = create_window(app, None, None);
    } else if let Some(l) = active_label {
        focus(app, &l);
        st().lock().active = Some(l);
    }
}

/// `atelier <path>` second process / `open -a Atelier <folder>`: open (or focus) the project as a tab.
pub fn open_or_focus(app: &AppHandle, loc: Location) {
    let app = app.clone();
    std::thread::spawn(move || {
        let loc = norm(&loc);
        if let Some(l) = find_project(&loc) {
            focus(&app, &l);
            activate(&app);
            return;
        }
        // An empty Welcome window is replaced by the project (IntelliJ closes the welcome frame).
        let welcome = st().lock().wins.iter().find(|w| w.project.is_none()).map(|w| w.label.clone());
        if let Some(w) = welcome {
            switch_window(&app, &w, loc);
            focus(&app, &w);
            activate(&app);
            return;
        }
        let _ = create_window(&app, Some(loc), None);
        activate(&app);
    });
}

/// Second process started: `argv` includes the executable at index 0.
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args: Vec<String> = argv.into_iter().skip(1).collect();
    match crate::location::parse_args(&args, Some(std::path::Path::new(&cwd))) {
        Some(loc) => open_or_focus(app, loc),
        None => {
            let active = active_or_first();
            if let Some(l) = active {
                focus(app, &l);
            }
            activate(app);
        }
    }
}

/// macOS open-file events (`open -a Atelier <folder>`, dropping a folder on the Dock icon).
pub fn on_opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    for u in urls {
        if u.scheme() != "file" {
            continue;
        }
        let Ok(p) = u.to_file_path() else { continue };
        let dir = if p.is_dir() { p } else { p.parent().map(|x| x.to_path_buf()).unwrap_or(p) };
        open_or_focus(app, Location { host: "local".into(), path: dir.canonicalize().unwrap_or(dir).to_string_lossy().into_owned() });
    }
}

// ---------- switching the project shown by a window ----------

fn set_project(app: &AppHandle, label: &str, loc: Option<Location>) {
    let loc = loc.map(|l| norm(&l));
    {
        let mut s = st().lock();
        if let Some(w) = s.wins.iter_mut().find(|w| w.label == label) {
            w.project = loc.clone();
        }
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_title(&project_title(loc.as_ref()));
    }
    changed(app);
}

/// Re-point a window at another project: release what the old one owned, then reload the webview (fresh JS state).
fn switch_window(app: &AppHandle, label: &str, loc: Location) {
    cleanup_window(app, label);
    set_project(app, label, Some(loc));
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.eval("location.reload()");
    }
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WinItem {
    pub label: String,
    pub project: Option<Location>,
    pub title: String,
    pub current: bool,
    pub focused: bool,
}

#[tauri::command]
pub async fn win_list(app: AppHandle, window: WebviewWindow) -> Vec<WinItem> {
    list_items(&app, window.label())
}

pub fn list_items(app: &AppHandle, current: &str) -> Vec<WinItem> {
    let order = ordered_labels(app);
    let (recs, active) = {
        let s = st().lock();
        (s.wins.clone(), s.active.clone())
    };
    order
        .into_iter()
        .filter_map(|l| recs.iter().find(|w| w.label == l).cloned())
        .map(|w| WinItem {
            title: project_title(w.project.as_ref()),
            current: w.label == current,
            focused: active.as_deref() == Some(w.label.as_str()),
            label: w.label,
            project: w.project,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// "focused" (already open elsewhere), "here" (caller should switch itself via `win_switch_here`), "opened" (new tab)
    pub action: &'static str,
    pub label: String,
}

/// Open a project the IntelliJ way: already open -> focus it; `new_window` -> a new tab; else "here".
#[tauri::command]
pub async fn win_open_project(app: AppHandle, window: WebviewWindow, loc: Location, new_window: bool) -> Result<OpenResult, String> {
    let me = window.label().to_string();
    if let Some(l) = find_project(&loc) {
        focus(&app, &l);
        return Ok(OpenResult { action: "focused", label: l });
    }
    if !new_window || project_of(&me).is_none() {
        return Ok(OpenResult { action: "here", label: me });
    }
    let l = create_window(&app, Some(loc), Some(&me))?;
    Ok(OpenResult { action: "opened", label: l })
}

#[tauri::command]
pub async fn win_switch_here(app: AppHandle, window: WebviewWindow, loc: Location) -> Result<OpenResult, String> {
    let me = window.label().to_string();
    if let Some(l) = find_project(&loc).filter(|l| *l != me) {
        focus(&app, &l);
        return Ok(OpenResult { action: "focused", label: l });
    }
    switch_window(&app, &me, loc);
    Ok(OpenResult { action: "here", label: me })
}

/// The window's webview tells which project it displays (in-place open, Close Project).
#[tauri::command]
pub fn win_set_project(app: AppHandle, window: WebviewWindow, loc: Option<Location>) {
    let same = project_of(window.label()).map(|l| norm(&l)) == loc.as_ref().map(norm);
    if !same {
        set_project(&app, window.label(), loc);
    }
}

#[tauri::command]
pub fn win_focus(app: AppHandle, label: String) {
    focus(&app, &label);
}

#[tauri::command]
pub fn win_cycle(app: AppHandle, window: WebviewWindow, delta: i32) {
    cycle(&app, window.label(), delta);
}

pub fn cycle(app: &AppHandle, from: &str, delta: i32) {
    let order = ordered_labels(app);
    if order.len() < 2 {
        return;
    }
    let cur = st().lock().active.clone().filter(|a| order.contains(a)).unwrap_or_else(|| from.to_string());
    let i = order.iter().position(|l| *l == cur).unwrap_or(0) as i32;
    let n = order.len() as i32;
    let j = (((i + delta) % n) + n) % n;
    focus(app, &order[j as usize]);
}

pub fn cycle_from_active(app: &AppHandle, delta: i32) {
    let a = st().lock().active.clone().unwrap_or_default();
    cycle(app, &a, delta);
}

pub fn active_label() -> Option<String> {
    st().lock().active.clone()
}

pub fn first_label() -> Option<String> {
    st().lock().wins.first().map(|w| w.label.clone())
}

#[tauri::command]
pub fn win_new_welcome(app: AppHandle) -> Result<String, String> {
    create_window(&app, None, None)
}

/// Project of the calling window (set at creation, so a reload returns to the same project).
#[tauri::command]
pub fn win_project(window: WebviewWindow) -> Option<Location> {
    project_of(window.label())
}

/// Frontend confirms the window may close (no dirty editors, or the user decided).
#[tauri::command]
pub fn win_close_confirmed(window: WebviewWindow) {
    st().lock().closing.insert(window.label().to_string());
    let _ = window.destroy();
}

#[tauri::command]
pub fn win_close_cancelled() {
    let mut s = st().lock();
    s.quitting = false;
    s.quit_queue.clear();
}

#[tauri::command]
pub fn win_quit(app: AppHandle) {
    request_quit(&app);
}

/// Is this window currently showing the native tab bar (tabbed with at least one other window)? The webview extends under
/// the transparent title bar, so the frontend inserts a spacer of the tab bar's height below the toolbar.
#[tauri::command]
pub async fn win_tabbed(app: AppHandle, window: WebviewWindow) -> bool {
    tab_labels(&app, window.label()).len() > 1
}

/// QA only (ATELIER_AUTOMATION=1): what AppKit thinks about the calling window's tabbing.
#[tauri::command]
pub async fn win_debug(app: AppHandle, window: WebviewWindow) -> Result<serde_json::Value, String> {
    if !crate::automation::enabled() {
        return Err("automation disabled".into());
    }
    let label = window.label().to_string();
    let tabs = tab_labels(&app, &label);
    #[cfg(target_os = "macos")]
    let (id, mode, key) = { let w = window.clone(); on_main(&app, move || mac::info(&w)).unwrap_or_default() };
    #[cfg(not(target_os = "macos"))]
    let (id, mode, key) = (String::new(), 0i64, false);
    Ok(serde_json::json!({
        "label": label, "tabbingIdentifier": id, "tabbingMode": mode, "isKey": key,
        "tabbedWindows": tabs.len(), "tabbedLabels": tabs,
        "windows": app.webview_windows().keys().cloned().collect::<Vec<_>>(),
        "menu": crate::menu::window_menu_titles(&app),
    }))
}

// ---------- lifecycle ----------

/// Release everything a window owns or shares (does not close the window).
pub fn cleanup_window(app: &AppHandle, label: &str) {
    crate::procs::kill_owner(label);
    crate::pty::release_window(label);
    crate::fs::watch::release_window(label);
    crate::remote::watch::release_window(label);
    crate::remote::transfer::release_window(label);
    crate::search::release_window(label);
    crate::lsp::release_window(app, label);
    crate::claude::release_window(label);
    crate::daemons::release_window(label);
    crate::remote::ssh::release_window(label);
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label().to_string();
    if !label.starts_with(PREFIX) {
        return;
    }
    let app = window.app_handle().clone();
    match event {
        tauri::WindowEvent::Focused(true) => {
            let changed_active = {
                let mut s = st().lock();
                let c = s.active.as_deref() != Some(label.as_str());
                s.active = Some(label.clone());
                c
            };
            if changed_active {
                changed(&app);
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            // a tab dragged out / merged back changes the tab bar of the windows involved
            let _ = app.emit_to(label.as_str(), "windows://tabs", ());
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if st().lock().closing.contains(&label) {
                return;
            }
            api.prevent_close();
            emit_window(&app, &label, "window://close-requested", serde_json::json!({"reason": "close"}));
        }
        tauri::WindowEvent::Destroyed => {
            let (quitting, had_project) = {
                let mut s = st().lock();
                let had = s.wins.iter().find(|w| w.label == label).map(|w| w.project.is_some()).unwrap_or(false);
                s.wins.retain(|w| w.label != label);
                s.closing.remove(&label);
                s.quit_queue.retain(|l| *l != label);
                if s.active.as_deref() == Some(label.as_str()) {
                    s.active = s.wins.last().map(|w| w.label.clone());
                }
                s.last_closed_had_project = had;
                (s.quitting, had)
            };
            let _ = had_project;
            crate::automation::window_gone(&label);
            std::thread::spawn(move || {
                cleanup_window(&app, &label);
                if quitting {
                    next_quit(&app);
                } else {
                    changed(&app);
                }
            });
        }
        _ => {}
    }
}

/// ExitRequested without an exit code: either the last window closed or the user asked to terminate (Dock > Quit).
/// Returns true when the exit must be prevented.
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
    if code.is_some() {
        st().lock().quitting = true; // programmatic exit: freeze the session file, children die in RunEvent::Exit
        return false;
    }
    let (quitting, remaining, had_project) = {
        let s = st().lock();
        (s.quitting, s.wins.len(), s.last_closed_had_project)
    };
    if quitting {
        return false;
    }
    if remaining > 0 {
        request_quit(app);
        return true;
    }
    if had_project {
        // IntelliJ keeps running with the Welcome screen when the last project is closed.
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = create_window(&app, None, None);
        });
        return true;
    }
    false
}

pub fn request_quit(app: &AppHandle) {
    if st().lock().quitting {
        return;
    }
    persist(app); // final session snapshot, then freeze it
    {
        let mut s = st().lock();
        s.quitting = true;
        s.quit_queue = s.wins.iter().map(|w| w.label.clone()).collect();
    }
    next_quit(app);
}

fn next_quit(app: &AppHandle) {
    let next = {
        let mut s = st().lock();
        if !s.quitting {
            return;
        }
        if s.quit_queue.is_empty() { None } else { Some(s.quit_queue.remove(0)) }
    };
    let Some(label) = next else {
        let app = app.clone();
        std::thread::spawn(move || app.exit(0));
        return;
    };
    if app.get_webview_window(&label).is_none() {
        return next_quit(app);
    }
    emit_window(app, &label, "window://close-requested", serde_json::json!({"reason": "quit"}));
    // A webview that never answers must not block quitting forever.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(600));
        if st().lock().quitting {
            if let Some(w) = app2.get_webview_window(&label) {
                st().lock().closing.insert(label.clone());
                let _ = w.destroy();
            }
        }
    });
}

/// Current branch of a LOCAL project (reads `.git/HEAD`, no process spawned); None for remote/non-git projects.
#[tauri::command]
pub fn project_branch(loc: Location) -> Option<String> {
    if !loc.is_local() {
        return None;
    }
    let mut dir = std::path::PathBuf::from(&loc.path);
    let head = loop {
        let g = dir.join(".git");
        if g.is_dir() {
            break g.join("HEAD");
        }
        if g.is_file() {
            // worktree / submodule: ".git" is a file "gitdir: <path>"
            let txt = std::fs::read_to_string(&g).ok()?;
            let target = txt.trim().strip_prefix("gitdir:")?.trim();
            let t = std::path::Path::new(target);
            break if t.is_absolute() { t.join("HEAD") } else { dir.join(t).join("HEAD") };
        }
        if !dir.pop() {
            return None;
        }
    };
    let txt = std::fs::read_to_string(head).ok()?;
    let txt = txt.trim();
    match txt.strip_prefix("ref: refs/heads/") {
        Some(b) => Some(b.to_string()),
        None => Some(txt.chars().take(8).collect()),
    }
}
