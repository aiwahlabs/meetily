//! AIWAH: Tauri commands for HQ Workshop sync (Settings → HQ, meeting badges).

use super::{
    enqueue, fetch_identity, get_sync_records, load_settings, process_meeting, process_pending, save_settings,
    HqIdentity, HqSettings, SyncRecord,
};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

/// Settings as shown to the UI: the API key is never sent back in full.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HqSettingsView {
    pub base_url: String,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub auto_sync: bool,
    pub default_project_id: Option<String>,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
}

impl From<&HqSettings> for HqSettingsView {
    fn from(s: &HqSettings) -> Self {
        let hint = s.api_key.as_deref().map(|k| k.chars().collect::<Vec<_>>()).filter(|c| c.len() > 8).map(|c| {
            format!("{}…{}", c[..5].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
        });
        Self {
            base_url: s.base_url.clone(),
            has_api_key: s.is_configured(),
            api_key_hint: hint,
            auto_sync: s.auto_sync,
            default_project_id: s.default_project_id.clone(),
            user_email: s.user_email.clone(),
            user_name: s.user_name.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HqSettingsInput {
    pub base_url: Option<String>,
    /// `None` keeps the stored key; `Some("")` clears it.
    pub api_key: Option<String>,
    pub auto_sync: Option<bool>,
    pub default_project_id: Option<String>,
}

#[tauri::command]
pub async fn hq_get_settings(state: tauri::State<'_, AppState>) -> Result<HqSettingsView, String> {
    let settings = load_settings(state.db_manager.pool()).await?;
    Ok(HqSettingsView::from(&settings))
}

/// Save settings. When a key is present, verifies it against `GET /v1/me` and
/// remembers the user's email so their meetings stay visible to them in HQ.
#[tauri::command]
pub async fn hq_save_settings<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    settings: HqSettingsInput,
) -> Result<HqSettingsView, String> {
    let pool = state.db_manager.pool().clone();
    let mut current = load_settings(&pool).await?;
    if let Some(url) = settings.base_url {
        let url = url.trim().trim_end_matches('/').to_string();
        if !url.is_empty() {
            if !(url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")) {
                return Err("HQ URL must start with https://".to_string());
            }
            current.base_url = url;
        }
    }
    let key_changed = settings.api_key.is_some();
    if let Some(key) = settings.api_key {
        let key = key.trim().to_string();
        current.api_key = if key.is_empty() { None } else { Some(key) };
        current.user_email = None;
        current.user_name = None;
    }
    if let Some(auto) = settings.auto_sync {
        current.auto_sync = auto;
    }
    if let Some(project) = settings.default_project_id {
        let project = project.trim().to_string();
        current.default_project_id = if project.is_empty() { None } else { Some(project) };
    }

    if key_changed && current.is_configured() {
        let identity = fetch_identity(&current).await?;
        current.user_email = identity.email;
        current.user_name = identity.name;
    }
    save_settings(&pool, &current).await?;

    // Flush anything that queued while HQ was not configured.
    if current.is_configured() && current.auto_sync {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = process_pending(&app2, &pool).await;
        });
    }
    Ok(HqSettingsView::from(&current))
}

#[tauri::command]
pub async fn hq_test_connection(state: tauri::State<'_, AppState>) -> Result<HqIdentity, String> {
    let settings = load_settings(state.db_manager.pool()).await?;
    fetch_identity(&settings).await
}

#[tauri::command]
pub async fn hq_get_sync_status(
    state: tauri::State<'_, AppState>,
    meeting_ids: Option<Vec<String>>,
) -> Result<Vec<SyncRecord>, String> {
    get_sync_records(state.db_manager.pool(), &meeting_ids.unwrap_or_default()).await
}

/// Sync (or re-sync) one meeting now. `language` overrides the language recorded
/// at save time, e.g. to send an old meeting to Sarvam.
#[tauri::command]
pub async fn hq_sync_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    language: Option<String>,
    project_id: Option<String>,
    force: Option<bool>,
) -> Result<String, String> {
    let pool = state.db_manager.pool().clone();
    let settings = load_settings(&pool).await?;
    if !settings.is_configured() {
        return Err("Connect HQ first: add your API key in Settings → HQ".to_string());
    }
    enqueue(&pool, &meeting_id, language, project_id, force.unwrap_or(false)).await?;
    process_meeting(&app, &pool, &meeting_id).await
}

#[tauri::command]
pub async fn hq_sync_pending<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let pool = state.db_manager.pool().clone();
    process_pending(&app, &pool).await
}
