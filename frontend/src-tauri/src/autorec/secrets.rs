//! AIWAH: secrets (HQ API key, Google tokens and client secret) live in the OS
//! credential store: Windows Credential Manager / macOS Keychain. The SQLite
//! columns that used to hold them are cleared once a value is safely in the store.
//!
//! Where no OS store is available (other platforms, or the store errors), callers
//! fall back to the database column so the app keeps working.

#[cfg(any(target_os = "windows", target_os = "macos"))]
const SERVICE: &str = "com.aiwahlabs.minutes";

/// Names of the stored secrets.
pub const HQ_API_KEY: &str = "hq-api-key";
pub const GOOGLE_CLIENT_SECRET: &str = "google-client-secret";
pub const GOOGLE_REFRESH_TOKEN: &str = "google-refresh-token";
pub const GOOGLE_ACCESS_TOKEN: &str = "google-access-token";

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// Read a secret from the OS store. `Ok(None)` = not stored; `Err` = store unavailable.
pub fn get(name: &str) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        match entry(name)?.get_password() {
            Ok(v) if !v.is_empty() => Ok(Some(v)),
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = name;
        Err("no OS credential store on this platform".to_string())
    }
}

/// Store (`Some`) or delete (`None`) a secret in the OS store.
pub fn set(name: &str, value: Option<&str>) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let e = entry(name)?;
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => e.set_password(v).map_err(|e| e.to_string()),
            None => match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            },
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (name, value);
        Err("no OS credential store on this platform".to_string())
    }
}

/// Save a secret. Returns what to write into the database column: `None` when the
/// OS store took it (the normal case), or the value itself as a fallback.
pub fn stash(name: &str, value: Option<&str>) -> Option<String> {
    match set(name, value) {
        Ok(()) => None,
        Err(e) => {
            log::warn!("OS credential store unavailable for {} ({}); keeping it in the local database", name, e);
            value.map(str::to_string)
        }
    }
}

/// Load a secret: the OS store first, then a legacy value from the database column.
/// A legacy value is moved into the store; `migrated` tells the caller to clear the column.
pub fn load(name: &str, db_value: Option<String>) -> (Option<String>, bool) {
    let db_value = db_value.filter(|v| !v.trim().is_empty());
    match get(name) {
        Ok(Some(v)) => (Some(v), db_value.is_some()),
        Ok(None) => match db_value {
            Some(v) => {
                let moved = set(name, Some(&v)).is_ok();
                (Some(v), moved)
            }
            None => (None, false),
        },
        Err(_) => (db_value, false),
    }
}

#[cfg(test)]
mod tests {
    /// Touches the real OS credential store, so it is opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn os_store_round_trip() {
        let name = "aiwah-selftest";
        super::set(name, Some("value-1")).expect("store");
        assert_eq!(super::get(name).unwrap().as_deref(), Some("value-1"));
        assert_eq!(super::stash(name, Some("value-2")), None, "stored in the OS, not the DB");
        let (v, migrated) = super::load(name, Some("legacy".into()));
        assert_eq!(v.as_deref(), Some("value-2"));
        assert!(migrated, "legacy DB copy should be cleared");
        super::set(name, None).expect("delete");
        assert_eq!(super::get(name).unwrap(), None);
    }
}
