//! AIWAH: auto-record and privacy settings, stored as one JSON row so new
//! fields never need a migration.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoRecSettings {
    /// When another app starts using the microphone, ask whether to record (pop-up).
    pub prompt_on_mic: bool,
    /// Pop-up 1 minute before a calendar meeting that has a video link.
    pub notify_calendar: bool,
    /// Small "Recording" pill while recording, when the main window is not in front.
    pub show_recording_pill: bool,
    /// Start recording on its own when a Google Calendar event with a Meet link
    /// is happening and the browser is using the microphone. Off by default: the
    /// user is always asked first unless they opt in.
    pub auto_record_calendar: bool,
    /// Stop automatically when the call app releases the microphone (Windows).
    pub auto_stop: bool,
    /// Remind the user to tell participants the call is recorded.
    pub consent_reminder: bool,
    /// Delete the local audio file once the meeting is safely in HQ.
    pub delete_audio_after_sync: bool,
    /// Comma-separated app names that are never prompted or recorded.
    pub excluded_apps: String,
    /// Comma-separated words; calendar events whose title contains one are never auto-recorded.
    pub excluded_keywords: String,
    /// Start the app (hidden, in the tray) when the user signs in. Off unless the user opts in.
    pub start_at_login: bool,
}

impl Default for AutoRecSettings {
    fn default() -> Self {
        Self {
            prompt_on_mic: true,
            notify_calendar: true,
            show_recording_pill: true,
            auto_record_calendar: false,
            auto_stop: true,
            consent_reminder: true,
            delete_audio_after_sync: false,
            excluded_apps: String::new(),
            excluded_keywords: "personal, private, doctor, medical".to_string(),
            start_at_login: false,
        }
    }
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect()
}

impl AutoRecSettings {
    pub fn is_app_excluded(&self, app_name: &str, app_id: &str) -> bool {
        let name = app_name.to_lowercase();
        let id = app_id.to_lowercase();
        split_list(&self.excluded_apps).iter().any(|x| name.contains(x.as_str()) || id.contains(x.as_str()))
    }

    pub fn is_title_excluded(&self, title: &str) -> bool {
        let t = title.to_lowercase();
        split_list(&self.excluded_keywords).iter().any(|k| t.contains(k.as_str()))
    }
}

/// In-memory copy so the watcher does not hit the database every tick.
static CACHE: std::sync::Mutex<Option<AutoRecSettings>> = std::sync::Mutex::new(None);

/// Cached settings (loaded from the database once, updated by `save`).
pub async fn load_cached(pool: &SqlitePool) -> AutoRecSettings {
    if let Some(s) = CACHE.lock().ok().and_then(|g| g.clone()) {
        return s;
    }
    let s = load(pool).await;
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(s.clone());
    }
    s
}

pub async fn load(pool: &SqlitePool) -> AutoRecSettings {
    let row: Option<(String,)> = sqlx::query_as("SELECT settings_json FROM aiwah_autorec_settings WHERE id = 'default'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
    row.and_then(|(json,)| serde_json::from_str(&json).ok()).unwrap_or_default()
}

pub async fn save(pool: &SqlitePool, settings: &AutoRecSettings) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO aiwah_autorec_settings (id, settings_json, updated_at) VALUES ('default', ?, ?)
         ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
    )
    .bind(json)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save auto-record settings: {}", e))?;
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(settings.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusions() {
        let s = AutoRecSettings { excluded_apps: "WhatsApp, zoom".into(), ..Default::default() };
        assert!(s.is_app_excluded("WhatsApp", "5319275A.WhatsAppDesktop_x"));
        assert!(s.is_app_excluded("Zoom", r"C:\Zoom\bin\Zoom.exe"));
        assert!(!s.is_app_excluded("slack.exe", r"C:\slack.exe"));
        assert!(s.is_title_excluded("Doctor appointment"));
        assert!(!s.is_title_excluded("Discovery call with Acme"));
    }
}
