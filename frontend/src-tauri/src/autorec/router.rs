//! AIWAH: language router. After a recording is saved, decide which on-device engine owns its
//! transcript:
//!
//! - English (and anything not Indian) stays with Parakeet, which already transcribed it live.
//! - An Indian language (Malayalam, Tamil, Hindi, …) is re-transcribed from the saved audio by
//!   IndicConformer, replacing the live Parakeet text, before the summary and HQ sync run.
//!
//! The language comes from the meeting language picker when it names a language, otherwise from
//! spoken-language identification on the recording (Whisper LID, restricted to English plus the
//! Indian languages the user enabled). Nothing here runs during the call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const ENGINE_PARAKEET: &str = "parakeet";
pub const ENGINE_INDIC: &str = "indic";

/// Where routing stands for a meeting; the meeting page waits for `done` before it
/// auto-generates the summary, so the summary is written from the final transcript.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingState {
    pub meeting_id: String,
    /// pending | detecting | transcribing | done | failed
    pub state: String,
    pub language: Option<String>,
    pub engine: Option<String>,
    pub message: Option<String>,
}

static STATES: Mutex<Option<HashMap<String, RoutingState>>> = Mutex::new(None);

fn set_state<R: Runtime>(app: &AppHandle<R>, st: RoutingState) {
    if let Ok(mut g) = STATES.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        // Keep the map small: finished entries of older meetings are not needed.
        if map.len() > 50 {
            map.retain(|_, v| v.state != "done" && v.state != "failed");
        }
        map.insert(st.meeting_id.clone(), st.clone());
    }
    let _ = app.emit("aiwah-language-routing", st);
}

pub fn state_of(meeting_id: &str) -> Option<RoutingState> {
    STATES.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(meeting_id).cloned()))
}

/// Called synchronously when a meeting is saved, before any async work, so the meeting page
/// already sees `pending` when it asks.
pub fn begin<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) {
    set_state(
        app,
        RoutingState { meeting_id: meeting_id.to_string(), state: "pending".into(), language: None, engine: None, message: None },
    );
}

/// (language, engine) recorded for a meeting, if routing ran.
pub async fn meeting_language(pool: &SqlitePool, meeting_id: &str) -> (Option<String>, Option<String>) {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT language, engine FROM aiwah_meeting_language WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    match row {
        Some((l, e)) => (Some(l), Some(e)),
        None => (None, None),
    }
}

async fn save_language(pool: &SqlitePool, meeting_id: &str, language: &str, engine: &str, detected: bool) {
    let _ = sqlx::query(
        "INSERT OR REPLACE INTO aiwah_meeting_language (meeting_id, language, engine, detected, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(meeting_id)
    .bind(language)
    .bind(engine)
    .bind(if detected { 1i64 } else { 0i64 })
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await;
}

/// Base language code of a picker value: "ml-IN" -> "ml"; "auto"/"" -> None.
fn picker_language(pref: Option<&str>) -> Option<String> {
    let p = pref?.trim().to_ascii_lowercase();
    if p.is_empty() || p.starts_with("auto") {
        return None;
    }
    Some(p.split(['-', '_']).next().unwrap_or(&p).to_string())
}

pub fn is_indic(code: &str) -> bool {
    crate::indic_engine::SUPPORTED.iter().any(|(c, _)| *c == code)
}

pub fn indic_models_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("models").join("indic-conformer"))
}

pub fn indic_installed<R: Runtime>(app: &AppHandle<R>) -> bool {
    indic_models_dir(app).map(|d| crate::indic_engine::model::status(&d).installed).unwrap_or(false)
}

// ── Language-detection model (Whisper base, multilingual) ─────────────────────
//
// Part of the Indian languages pack. Stored where the Whisper engine keeps its models
// (`<app_data>/models/ggml-base.bin`) so the two share one copy. Tiny was rejected: it
// mislabelled Tamil as Kannada/Malayalam in testing; base got every test clip right.

const LID_FILE: &str = "ggml-base.bin";
const LID_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin";
const LID_SIZE: u64 = 147_951_465;
const LID_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
/// Marker in the Indic folder: the pack downloaded the LID model, so removing the pack may delete it.
const LID_OWNED_MARKER: &str = ".lid-model-owned";

fn lid_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("models").join(LID_FILE))
}

pub struct LidStatus {
    pub installed: bool,
    pub bytes_on_disk: u64,
    /// Bytes still to download (0 when installed).
    pub download_bytes: u64,
}

pub fn lid_pack_status<R: Runtime>(app: &AppHandle<R>) -> LidStatus {
    // Any multilingual Whisper model the user already has works for detection.
    if crate::indic_engine::lid::model_path(app).is_some() {
        let on_disk = lid_path(app).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
        return LidStatus { installed: true, bytes_on_disk: on_disk, download_bytes: 0 };
    }
    LidStatus { installed: false, bytes_on_disk: 0, download_bytes: LID_SIZE }
}

/// Download the LID model if no usable Whisper model exists. `progress(bytes_done)`.
pub async fn download_lid_model<R: Runtime>(
    app: &AppHandle<R>,
    cancel: &tokio_util::sync::CancellationToken,
    progress: impl Fn(u64),
) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    if lid_pack_status(app).installed {
        return Ok(());
    }
    let path = lid_path(app).ok_or("App data folder is not available")?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let part = path.with_extension("bin.part");
    let resp = reqwest::Client::new()
        .get(LID_URL)
        .send()
        .await
        .map_err(|e| format!("Could not download the language model: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Could not download the language model (HTTP {})", resp.status()));
    }
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("Download cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("Download interrupted: {}", e))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        progress(done);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if done != LID_SIZE || digest != LID_SHA256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("The language model download was corrupted. Try again.".into());
    }
    tokio::fs::rename(&part, &path).await.map_err(|e| e.to_string())?;
    if let Some(dir) = indic_models_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(LID_OWNED_MARKER), b"1");
    }
    Ok(())
}

/// Delete the LID model only if the pack downloaded it (the user may use it for Whisper).
/// Call before deleting the Indic folder, which holds the marker.
pub fn delete_lid_model<R: Runtime>(app: &AppHandle<R>) {
    let owned = indic_models_dir(app).map(|d| d.join(LID_OWNED_MARKER).exists()).unwrap_or(false);
    if owned {
        if let Some(p) = lid_path(app) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// What routing decided, before any re-transcription.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    English { detected: bool },
    Indic { code: String, detected: bool },
}

/// Pure decision from the picker value and (optionally) detected language probabilities.
pub fn decide(pref: Option<&str>, detected: Option<Decision>) -> Decision {
    match picker_language(pref) {
        Some(code) if is_indic(&code) => Decision::Indic { code, detected: false },
        Some(_) => Decision::English { detected: false },
        None => detected.unwrap_or(Decision::English { detected: false }),
    }
}

/// Run spoken-language identification on the saved recording.
async fn detect_language<R: Runtime>(app: &AppHandle<R>, audio: &Path, allowed: Vec<String>) -> Option<Decision> {
    let lid_model = crate::indic_engine::lid::model_path(app)?;
    let audio = audio.to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> Result<Decision, String> {
        let decoded = crate::audio::decoder::decode_audio_file(&audio).map_err(|e| e.to_string())?;
        let samples = decoded.to_whisper_format();
        let allowed_refs: Vec<&str> = allowed.iter().map(String::as_str).collect();
        let route = crate::indic_engine::lid::route_audio(&samples, &lid_model, &allowed_refs)?;
        Ok(match route {
            crate::indic_engine::lid::Route::English => Decision::English { detected: true },
            crate::indic_engine::lid::Route::Indic(code) => Decision::Indic { code, detected: true },
        })
    })
    .await
    .ok()?;
    match result {
        Ok(d) => Some(d),
        Err(e) => {
            log::warn!("Language detection failed, keeping the English transcript: {}", e);
            None
        }
    }
}

/// Decide the language of a saved meeting and, for an Indian language, re-transcribe it with
/// IndicConformer. Never fails the save; on any problem the Parakeet transcript stays.
pub async fn run<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool, meeting_id: &str) {
    let folder: Option<String> = sqlx::query_as::<_, (Option<String>,)>("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|(f,)| f);
    let audio = folder.as_deref().and_then(|f| crate::audio::retranscription::find_audio_file(Path::new(f)).ok());
    let pref = crate::get_language_preference_internal();
    let installed = indic_installed(app);
    let settings = super::settings::load_cached(pool).await;

    let mut detected = None;
    if picker_language(pref.as_deref()).is_none() && installed && settings.detect_language {
        if let Some(audio) = &audio {
            set_state(app, RoutingState {
                meeting_id: meeting_id.into(),
                state: "detecting".into(),
                language: None,
                engine: None,
                message: Some("Detecting the meeting language…".into()),
            });
            let allowed: Vec<String> = settings.indic_languages.iter().filter(|c| is_indic(c)).cloned().collect();
            detected = detect_language(app, audio, allowed).await;
        }
    }

    match decide(pref.as_deref(), detected) {
        Decision::English { detected } => {
            save_language(pool, meeting_id, "en", ENGINE_PARAKEET, detected).await;
            set_state(app, RoutingState {
                meeting_id: meeting_id.into(),
                state: "done".into(),
                language: Some("en".into()),
                engine: Some(ENGINE_PARAKEET.into()),
                message: None,
            });
        }
        Decision::Indic { code, detected } => {
            let (Some(folder), true) = (folder.clone(), installed) else {
                // No Indic model on this device: keep the live transcript and let HQ (Sarvam)
                // transcribe the audio; the HQ sync sees the Indic language and uploads it.
                save_language(pool, meeting_id, &code, ENGINE_PARAKEET, detected).await;
                set_state(app, RoutingState {
                    meeting_id: meeting_id.into(),
                    state: "done".into(),
                    language: Some(code),
                    engine: Some(ENGINE_PARAKEET.into()),
                    message: Some("Indian languages pack not installed; HQ will transcribe this meeting.".into()),
                });
                return;
            };
            let name = crate::indic_engine::SUPPORTED.iter().find(|(c, _)| *c == code).map(|(_, n)| *n).unwrap_or("Indian language");
            set_state(app, RoutingState {
                meeting_id: meeting_id.into(),
                state: "transcribing".into(),
                language: Some(code.clone()),
                engine: Some(ENGINE_INDIC.into()),
                message: Some(format!("Transcribing in {}…", name)),
            });
            let result = crate::audio::retranscription::start_retranscription(
                app.clone(),
                meeting_id.to_string(),
                folder,
                Some(code.clone()),
                None,
                Some(ENGINE_INDIC.to_string()),
            )
            .await;
            match result {
                Ok(_) => {
                    save_language(pool, meeting_id, &code, ENGINE_INDIC, detected).await;
                    set_state(app, RoutingState {
                        meeting_id: meeting_id.into(),
                        state: "done".into(),
                        language: Some(code),
                        engine: Some(ENGINE_INDIC.into()),
                        message: None,
                    });
                }
                Err(e) => {
                    log::warn!("IndicConformer transcription failed, keeping the live transcript: {}", e);
                    save_language(pool, meeting_id, &code, ENGINE_PARAKEET, detected).await;
                    set_state(app, RoutingState {
                        meeting_id: meeting_id.into(),
                        state: "failed".into(),
                        language: Some(code),
                        engine: Some(ENGINE_PARAKEET.into()),
                        message: Some(format!("Could not transcribe in {}: {}", name, e)),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_language_wins_over_detection() {
        assert_eq!(decide(Some("ml"), Some(Decision::English { detected: true })), Decision::Indic { code: "ml".into(), detected: false });
        assert_eq!(decide(Some("en"), Some(Decision::Indic { code: "ta".into(), detected: true })), Decision::English { detected: false });
        assert_eq!(decide(Some("ml-IN"), None), Decision::Indic { code: "ml".into(), detected: false });
    }

    #[test]
    fn auto_uses_detection_or_english() {
        assert_eq!(decide(Some("auto"), Some(Decision::Indic { code: "hi".into(), detected: true })), Decision::Indic { code: "hi".into(), detected: true });
        assert_eq!(decide(None, None), Decision::English { detected: false });
        assert_eq!(decide(Some("auto-translate"), None), Decision::English { detected: false });
    }

    #[test]
    fn non_indic_picker_language_stays_with_parakeet() {
        assert_eq!(decide(Some("de"), None), Decision::English { detected: false });
    }
}
