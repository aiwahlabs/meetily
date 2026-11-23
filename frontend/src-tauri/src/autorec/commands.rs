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

/// Speaker names for one meeting's transcript: `sides` maps transcript line id -> "me" | "them".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSpeakers {
    pub names: super::speakers::SpeakerNames,
    pub sides: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub async fn aiwah_transcript_speakers(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<TranscriptSpeakers, String> {
    let pool = state.db_manager.pool();
    let sides = super::speakers::sides_for_meeting(pool, &meeting_id)
        .await
        .into_iter()
        .map(|(id, side)| (id, side.as_str().to_string()))
        .collect();
    let names = super::speakers::resolve_names(pool, &meeting_id).await;
    Ok(TranscriptSpeakers { names, sides })
}

/// "Join & record" on a calendar event inside the app: records with its title and guests.
#[tauri::command]
pub async fn autorec_record_event<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    event_id: String,
) -> Result<(), String> {
    watcher::record_event(&app, state.db_manager.pool(), &event_id).await
}

/// Language routing of a just-saved meeting (the meeting page waits for "done" before it
/// writes the summary). `null` when routing never ran for it in this session.
#[tauri::command]
pub async fn aiwah_routing_state(meeting_id: String) -> Result<Option<super::router::RoutingState>, String> {
    Ok(super::router::state_of(&meeting_id))
}

/// Language and engine of a meeting's transcript, e.g. ("ml", "indic").
#[tauri::command]
pub async fn aiwah_meeting_language(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<(Option<String>, Option<String>), String> {
    Ok(super::router::meeting_language(state.db_manager.pool(), &meeting_id).await)
}

// ── Indian languages pack (IndicConformer + language detection model) ─────────

static INDIC_DOWNLOAD: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>> = std::sync::Mutex::new(None);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicPackStatus {
    pub installed: bool,
    pub bytes_on_disk: u64,
    pub download_bytes: u64,
    pub downloading: bool,
}

fn indic_status<R: Runtime>(app: &AppHandle<R>) -> Result<IndicPackStatus, String> {
    let dir = super::router::indic_models_dir(app).ok_or("App data folder is not available")?;
    let st = crate::indic_engine::model::status(&dir);
    let lid = super::router::lid_pack_status(app);
    Ok(IndicPackStatus {
        installed: st.installed && lid.installed,
        bytes_on_disk: st.bytes_on_disk + lid.bytes_on_disk,
        download_bytes: st.total_bytes + lid.download_bytes,
        downloading: INDIC_DOWNLOAD.lock().map(|g| g.is_some()).unwrap_or(false),
    })
}

#[tauri::command]
pub async fn indic_pack_status<R: Runtime>(app: AppHandle<R>) -> Result<IndicPackStatus, String> {
    indic_status(&app)
}

/// Download (or resume) the pack. Progress: "indic-pack-progress" { downloaded, total } bytes.
#[tauri::command]
pub async fn indic_pack_download<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Emitter;
    super::require_signed_in(&app).await?;
    let dir = super::router::indic_models_dir(&app).ok_or("App data folder is not available")?;
    let token = {
        let mut g = INDIC_DOWNLOAD.lock().map_err(|_| "Download state is unavailable")?;
        if g.is_some() {
            return Err("The Indian languages pack is already downloading.".into());
        }
        let t = tokio_util::sync::CancellationToken::new();
        *g = Some(t.clone());
        t
    };
    let lid = super::router::lid_pack_status(&app);
    let indic_total = crate::indic_engine::model::total_bytes();
    let total = indic_total + lid.download_bytes;
    let last = std::sync::atomic::AtomicU64::new(0);
    let emit_progress = |downloaded: u64| {
        // At most one event per ~2 MB so the UI is not flooded.
        let prev = last.load(std::sync::atomic::Ordering::Relaxed);
        if downloaded == total || downloaded < prev || downloaded - prev >= 2 * 1024 * 1024 {
            last.store(downloaded, std::sync::atomic::Ordering::Relaxed);
            let _ = app.emit("indic-pack-progress", serde_json::json!({ "downloaded": downloaded, "total": total }));
        }
    };
    let result = async {
        crate::indic_engine::model::download(&dir, &token, |done, _| emit_progress(done))
            .await
            .map_err(|e| {
                if crate::indic_engine::model::is_download_cancelled(&e) {
                    "Download cancelled".to_string()
                } else {
                    e.to_string()
                }
            })?;
        super::router::download_lid_model(&app, &token, |done| emit_progress(indic_total + done)).await
    }
    .await;
    if let Ok(mut g) = INDIC_DOWNLOAD.lock() {
        *g = None;
    }
    result
}

#[tauri::command]
pub async fn indic_pack_cancel() -> Result<(), String> {
    if let Ok(g) = INDIC_DOWNLOAD.lock() {
        if let Some(t) = g.as_ref() {
            t.cancel();
        }
    }
    Ok(())
}

/// Remove the IndicConformer files (the language model is kept if Whisper uses it too).
#[tauri::command]
pub async fn indic_pack_delete<R: Runtime>(app: AppHandle<R>) -> Result<IndicPackStatus, String> {
    if INDIC_DOWNLOAD.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("Cancel the download first.".into());
    }
    let dir = super::router::indic_models_dir(&app).ok_or("App data folder is not available")?;
    // The marker saying the pack owns the language model lives in `dir`; check it first.
    super::router::delete_lid_model(&app);
    crate::indic_engine::model::delete(&dir).map_err(|e| e.to_string())?;
    indic_status(&app)
}
