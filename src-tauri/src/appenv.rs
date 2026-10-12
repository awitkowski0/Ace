//! Environment variables the app reads. Everything is named `ACE_*`; the pre-rename `ATELIER_*` name is still honoured
//! as a fallback so existing shells, scripts and launchers keep working. `ACE_X` wins when both are set.
use std::env::VarError;
use std::ffi::OsString;

/// `ATELIER_<rest>` for an `ACE_<rest>` name (anything else is returned unchanged).
fn legacy(name: &str) -> String {
    match name.strip_prefix("ACE_") {
        Some(rest) => format!("ATELIER_{rest}"),
        None => name.to_string(),
    }
}

/// Like `std::env::var_os`, `name` is the `ACE_*` spelling.
pub fn var_os(name: &str) -> Option<OsString> {
    var_os_or(name, &legacy(name))
}

/// Explicit new/old pair for the few names that don't map by prefix alone.
pub fn var_os_or(new: &str, old: &str) -> Option<OsString> {
    std::env::var_os(new).or_else(|| std::env::var_os(old))
}

/// Like `std::env::var`, `name` is the `ACE_*` spelling.
pub fn var(name: &str) -> Result<String, VarError> {
    match var_os(name) {
        Some(v) => v.into_string().map_err(VarError::NotUnicode),
        None => Err(VarError::NotPresent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ace_wins_then_falls_back_to_atelier() {
        std::env::remove_var("ACE_APPENV_T1");
        std::env::remove_var("ATELIER_APPENV_T1");
        assert!(var_os("ACE_APPENV_T1").is_none());
        std::env::set_var("ATELIER_APPENV_T1", "old");
        assert_eq!(var("ACE_APPENV_T1").unwrap(), "old");
        std::env::set_var("ACE_APPENV_T1", "new");
        assert_eq!(var("ACE_APPENV_T1").unwrap(), "new");
        std::env::remove_var("ACE_APPENV_T1");
        std::env::remove_var("ATELIER_APPENV_T1");
    }
}
