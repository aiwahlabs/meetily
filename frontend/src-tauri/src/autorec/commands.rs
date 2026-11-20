//! AIWAH: Tauri commands for the floating button, auto-record settings and
//! per-platform meeting folders.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::meta::{self, MeetingMeta, MEETING_TYPES};
use super::mic::{self, MicUser};
use super::platform::{self, DetectedCall};
use super::settings::{self, AutoRecSettings};
use super::watcher::{self, FloatingState};
use crate::state::AppState;

#[tauri::command]
pub async fn autorec_get_floating_state() -> Result<FloatingState, String> {
    Ok(watcher::floating_state())
}

/// `action`: "record" | "dismiss" | "stop" | "open"
#[tauri::command]
pub async fn autorec_floating_action<R: Runtime>(app: AppHandle<R>, action: String) -> Result<(), String> {
    watcher::floating_action(&app, &action).await
}

/// The floating page asks for its own size (logical pixels) when its content changes.
#[tauri::command]
pub async fn autorec_floating_resize<R: Runtime>(app: AppHandle<R>, width: f64, height: f64) -> Result<(), String> {
    watcher::resize_floating(&app, width, height);
    Ok(())
}

#[tauri::command]
pub async fn autorec_get_settings(state: tauri::State<'_, AppState>) -> Result<AutoRecSettings, String> {
    Ok(settings::load(state.db_manager.pool()).await)
}

#[tauri::command]
pub async fn autorec_save_settings<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    settings: AutoRecSettings,
) -> Result<AutoRecSettings, String> {
    {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        let enabled = launcher.is_enabled().unwrap_or(false);
        let result = match (settings.start_at_login, enabled) {
            (true, false) => launcher.enable(),
            (false, true) => launcher.disable(),
            _ => Ok(()),
        };
        result.map_err(|e| format!("Could not change start-at-login: {}", e))?;
    }
    settings::save(state.db_manager.pool(), &settings).await?;
    watcher::invalidate_calendar();
    Ok(settings)
}

#[tauri::command]
pub async fn autorec_list_meeting_meta(state: tauri::State<'_, AppState>) -> Result<Vec<MeetingMeta>, String> {
    meta::list_meta(state.db_manager.pool()).await
}

/// Move a meeting to another platform folder and/or change its type.
#[tauri::command]
pub async fn autorec_update_meeting_meta(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    platform: Option<String>,
    meeting_type: Option<String>,
) -> Result<(), String> {
    meta::update_meta(state.db_manager.pool(), &meeting_id, platform, meeting_type).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTypeOption {
    pub id: &'static str,
    pub label: &'static str,
}

#[tauri::command]
pub async fn autorec_meeting_types() -> Result<Vec<MeetingTypeOption>, String> {
    Ok(MEETING_TYPES.iter().map(|(id, label)| MeetingTypeOption { id, label }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionReport {
    pub mic_users: Vec<MicUser>,
    pub detected: Option<DetectedCall>,
    pub per_app_supported: bool,
}

/// "Test detection" in Settings: what the app sees right now.
#[tauri::command]
pub async fn autorec_detect_now() -> Result<DetectionReport, String> {
    let users = tokio::task::spawn_blocking(mic::active_mic_users).await.map_err(|e| e.to_string())?;
    let u = users.clone();
    let detected = tokio::task::spawn_blocking(move || platform::detect_call(&u)).await.map_err(|e| e.to_string())?;
    Ok(DetectionReport { mic_users: users, detected, per_app_supported: cfg!(target_os = "windows") })
}

/// Open an https link (a meeting link) in the default browser.
#[tauri::command]
pub async fn aiwah_open_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "That link is not valid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https links can be opened".to_string());
    }
    open::that(parsed.as_str()).map_err(|e| format!("Could not open the link: {}", e))
}

/// Re-read Google Calendar on the next watcher tick (after connecting or disconnecting).
#[tauri::command]
pub async fn autorec_refresh_calendar() -> Result<(), String> {
    watcher::invalidate_calendar();
    Ok(())
}
