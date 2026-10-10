use serde::{Deserialize, Serialize};

/// Every path in Atelier. `host` is "local" or an ssh alias (e.g. "mc").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Location {
    pub host: String,
    pub path: String,
}

impl Location {
    pub fn is_local(&self) -> bool {
        self.host == "local" || self.host.is_empty()
    }
}
