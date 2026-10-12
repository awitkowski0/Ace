//! Native menu bar. macOS: App / File / Edit / View / Window. Windows: File / Edit / View / Window / Help (About, Settings
//! and Exit move into File and Help, since there is no app menu). The Window menu lists the open project windows (checkmark on
//! the active one) next to the AppKit-provided tab items (Merge All Windows, Move Tab to New Window, Show All Tabs).
//! Keys that the in-app keymap owns (⌘W, ⌘`, ⌘⌥` ...) deliberately have NO menu accelerator, so a key press reaches the
//! webview dispatcher exactly once; only Quit (⌘Q) and the standard Edit items keep theirs.
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

const WINDOW_MENU_ID: &str = "window-menu";
const PROJ_PREFIX: &str = "proj:";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, Some("About Ace"), None)?;
    // Windows has no app menu: Quit becomes "Exit" in File, and About goes to Help. Settings uses the same action as the
    // toolbar gear. No accelerator on it: the in-app keymap owns the settings key (meta COMMA), see the module doc.
    #[cfg(target_os = "macos")]
    let quit = MenuItem::with_id(app, "quit", "Quit Ace", true, Some("CmdOrCtrl+Q"))?;
    #[cfg(not(target_os = "macos"))]
    let quit = MenuItem::with_id(app, "quit", "Exit", true, Some("CmdOrCtrl+Q"))?;
    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "Ace",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "act:OpenFolder", "Open Folder\u{2026}", true, None::<&str>)?,
            &MenuItem::with_id(app, "act:OpenRemoteProject", "Open Remote Project\u{2026}", true, None::<&str>)?,
            &MenuItem::with_id(app, "act:RecentProjects", "Recent Projects\u{2026}", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "act:CloseProject", "Close Project", true, None::<&str>)?,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "act:OpenFolder", "Open Folder\u{2026}", true, None::<&str>)?,
            &MenuItem::with_id(app, "act:OpenRemoteProject", "Open Remote Project\u{2026}", true, None::<&str>)?,
            &MenuItem::with_id(app, "act:RecentProjects", "Recent Projects\u{2026}", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "act:CloseProject", "Close Project", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "act:ShowSettings", "Settings\u{2026}", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let help = Submenu::with_items(app, "Help", true, &[&about])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_MENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, if cfg!(target_os = "macos") { Some("Zoom") } else { None })?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "next-win", "Next Project Window", true, None::<&str>)?,
            &MenuItem::with_id(app, "prev-win", "Previous Project Window", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file, &edit, &view, &window, &help])?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_as_windows_menu_for_nsapp();
    }
    Ok(())
}

fn window_submenu(app: &AppHandle) -> Option<Submenu<tauri::Wry>> {
    app.menu()?.get(WINDOW_MENU_ID)?.as_submenu().cloned()
}

/// Rebuild the project list at the end of the Window menu.
pub fn refresh(app: &AppHandle) {
    let Some(sub) = window_submenu(app) else { return };
    if let Ok(items) = sub.items() {
        for it in items {
            if it.id().0.starts_with(PROJ_PREFIX) {
                let _ = sub.remove(&it);
            }
        }
    }
    let cur = crate::windows::active_label().unwrap_or_default();
    for w in crate::windows::list_items(app, &cur) {
        if let Ok(it) = CheckMenuItem::with_id(app, format!("{PROJ_PREFIX}{}", w.label), &w.title, true, w.focused, None::<&str>) {
            let _ = sub.append(&it);
        }
    }
}

pub fn window_menu_titles(app: &AppHandle) -> Vec<String> {
    let app2 = app.clone();
    crate::windows::on_main(app, move || {
        let Some(sub) = window_submenu(&app2) else { return vec![] };
        sub.items().map(|v| v.iter().filter_map(|i| i.as_menuitem().and_then(|m| m.text().ok()).or_else(|| i.as_check_menuitem().and_then(|m| m.text().ok())).or_else(|| i.as_predefined_menuitem().and_then(|m| m.text().ok()))).collect()).unwrap_or_default()
    })
    .unwrap_or_default()
}

pub fn on_event(app: &AppHandle, id: &str) {
    if id == "quit" {
        crate::windows::request_quit(app);
    } else if id == "next-win" || id == "prev-win" {
        crate::windows::cycle_from_active(app, if id == "next-win" { 1 } else { -1 });
    } else if let Some(label) = id.strip_prefix(PROJ_PREFIX) {
        crate::windows::win_focus(app.clone(), label.to_string());
    } else if let Some(action) = id.strip_prefix("act:") {
        // File menu items run the same actions as the keymap, inside the active project window.
        if let Some(label) = crate::windows::active_label().or_else(crate::windows::first_label) {
            if app.get_webview_window(&label).is_some() {
                let _ = app.emit_to(label.as_str(), "menu://action", action);
            }
        }
    }
}
