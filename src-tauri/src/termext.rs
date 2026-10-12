//! Terminal extras: Ghostty themes/config (read-only), the system clipboard (the webview may refuse clipboard writes that
//! do not come from a user gesture, e.g. OSC 52) and macOS secure keyboard entry.
use std::path::PathBuf;

const GHOSTTY_APP_THEMES: &str = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

fn theme_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = dirs::home_dir() {
        v.push(h.join(".config/ghostty/themes"));
        v.push(h.join("Library/Application Support/com.mitchellh.ghostty/themes"));
    }
    v.push(PathBuf::from(GHOSTTY_APP_THEMES));
    v
}

/// Theme names from Ghostty's bundled themes and the user's own theme directories (sorted, de-duplicated).
#[tauri::command]
pub fn ghostty_themes() -> Vec<String> {
    let mut names: Vec<String> = theme_dirs()
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_file()).filter_map(|e| e.file_name().into_string().ok()))
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// Raw text of one theme file (user directories win over the bundled ones).
#[tauri::command]
pub fn ghostty_theme(name: String) -> Option<String> {
    if name.is_empty() || name.contains('/') || name.contains("..") || name.starts_with('.') {
        return None;
    }
    theme_dirs().iter().find_map(|d| std::fs::read_to_string(d.join(&name)).ok())
}

/// The user's Ghostty config, if one exists (read-only; never written).
#[tauri::command]
pub fn ghostty_config() -> Option<String> {
    let h = dirs::home_dir()?;
    [
        h.join(".config/ghostty/config"),
        h.join(".config/ghostty/config.ghostty"),
        h.join("Library/Application Support/com.mitchellh.ghostty/config"),
        h.join("Library/Application Support/com.mitchellh.ghostty/config.ghostty"),
    ]
    .iter()
    .find_map(|p| std::fs::read_to_string(p).ok())
}

#[cfg(target_os = "macos")]
fn pasteboard() -> objc2::rc::Retained<objc2_app_kit::NSPasteboard> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    // The automation harness uses a private pasteboard so tests never touch the real clipboard.
    if std::env::var_os("ATELIER_AUTOMATION").is_some() {
        NSPasteboard::pasteboardWithName(&NSString::from_str("atelier-qa"))
    } else {
        NSPasteboard::generalPasteboard()
    }
}

/// Windows clipboard under ATELIER_AUTOMATION: a process-private slot, so QA never touches the real clipboard.
#[cfg(windows)]
static QA_TEXT: parking_lot::Mutex<String> = parking_lot::Mutex::new(String::new());

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSPasteboardTypeString;
        use objc2_foundation::NSString;
        let pb = pasteboard();
        pb.clearContents();
        if unsafe { pb.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString) } {
            return Ok(());
        }
        return Err("pasteboard write failed".into());
    }
    #[cfg(windows)]
    {
        if std::env::var_os("ATELIER_AUTOMATION").is_some() {
            *QA_TEXT.lock() = text;
            return Ok(());
        }
        // The text goes over stdin as UTF-8: no argv or env size limit, no quoting. Set-Clipboard keeps Unicode intact.
        return crate::files::powershell("Set-Clipboard -Value (In-Utf8)", &[], Some(&text)).map(|_| ());
    }
    #[allow(unreachable_code)]
    {
        let _ = text;
        Err("clipboard unsupported".into())
    }
}

#[tauri::command]
pub fn clipboard_read() -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSPasteboardTypeString;
        return unsafe { pasteboard().stringForType(NSPasteboardTypeString) }.map(|s| s.to_string()).unwrap_or_default();
    }
    #[cfg(windows)]
    {
        if std::env::var_os("ATELIER_AUTOMATION").is_some() {
            return QA_TEXT.lock().clone();
        }
        // Empty when the clipboard holds no text (an image, or files): Get-Clipboard -Raw returns nothing then.
        return crate::files::powershell("$t=Get-Clipboard -Raw; if($t -ne $null){ Out-Utf8 ([string]$t) }", &[], None).unwrap_or_default();
    }
    #[allow(unreachable_code)]
    String::new()
}

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn EnableSecureEventInput() -> i32;
    fn DisableSecureEventInput() -> i32;
    fn IsSecureEventInputEnabled() -> u8;
}

/// Secure keyboard entry (macOS): other apps cannot observe keystrokes while on. Returns the resulting state.
#[tauri::command]
pub fn secure_keyboard_entry(enable: bool) -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        let on = IsSecureEventInputEnabled() != 0;
        if enable && !on {
            EnableSecureEventInput();
        } else if !enable && on {
            DisableSecureEventInput();
        }
        return IsSecureEventInputEnabled() != 0;
    }
    #[allow(unreachable_code)]
    {
        let _ = enable;
        false
    }
}
