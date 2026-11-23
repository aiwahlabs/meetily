//! AIWAH: HQ Workshop sync for Aiwah Minutes.
//!
//! Every saved meeting is queued in `hq_meeting_sync` and pushed to the Aiwah HQ
//! API in the background:
//! - English and other non-Indic meetings: the local transcript goes to
//!   `POST /v1/meetings/ingest`.
//! - Indic-language meetings (Malayalam, Tamil, Hindi, …): the recording goes to
//!   `POST /v1/meetings/upload-recording`, where HQ transcribes it with Sarvam.
//!   If the HQ server does not support uploads yet (404), we fall back to ingest.
//!
//! Network work never runs on audio threads; it runs on the Tauri async runtime.
//! Transcript content is never logged.

pub mod commands;

use crate::state::AppState;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const DEFAULT_BASE_URL: &str = "https://hq-api.aiwahconnect.com";
const SETTINGS_ID: &str = "default";
const MAX_TRANSCRIPT_CHARS: usize = 500_000;
const MAX_UPLOAD_BYTES: u64 = 500 * 1024 * 1024; // HQ limit
const MAX_ATTEMPTS: i64 = 8;
const RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Language codes (as used by the language picker) routed to Sarvam via HQ.
const INDIC_LANGUAGES: &[&str] = &[
    "ml", "ta", "hi", "te", "kn", "bn", "mr", "gu", "pa", "or", "as", "ur", "sa", "ne",
];

pub fn is_indic_language(language: Option<&str>) -> bool {
    language
        .map(|l| l.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase())
        .map(|l| INDIC_LANGUAGES.contains(&l.as_str()))
        .unwrap_or(false)
}

/// Sarvam/BCP-47 code for an Indic picker code, e.g. "ml" -> "ml-IN".
pub fn sarvam_language_code(language: &str) -> String {
    let base = language.split(['-', '_']).next().unwrap_or(language).to_ascii_lowercase();
    format!("{}-IN", base)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HqSettings {
    pub base_url: String,
    pub api_key: Option<String>,
    pub auto_sync: bool,
    pub default_project_id: Option<String>,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
}

impl Default for HqSettings {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key: None,
            auto_sync: true,
            default_project_id: None,
            user_email: None,
            user_name: None,
        }
    }
}

impl HqSettings {
    pub fn is_configured(&self) -> bool {
        self.api_key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub meeting_id: String,
    pub status: String,
    pub mode: Option<String>,
    pub language: Option<String>,
    pub project_id: Option<String>,
    pub lead_id: Option<String>,
    pub hq_meeting_id: Option<String>,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEvent {
    meeting_id: String,
    status: String,
    hq_meeting_id: Option<String>,
    error: Option<String>,
}

fn now_str() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ── Settings storage ───────────────────────────────────────────────────────────

pub async fn load_settings(pool: &SqlitePool) -> Result<HqSettings, String> {
    let row: Option<(String, Option<String>, i64, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT base_url, api_key, auto_sync, default_project_id, user_email, user_name
             FROM hq_settings WHERE id = ?",
        )
        .bind(SETTINGS_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to read HQ settings: {}", e))?;

    Ok(match row {
        Some((base_url, api_key, auto_sync, default_project_id, user_email, user_name)) => HqSettings {
            base_url: if base_url.trim().is_empty() { DEFAULT_BASE_URL.to_string() } else { base_url },
            // AIWAH: the key lives in the OS credential store; move a legacy DB copy there.
            api_key: {
                let (key, migrated) = crate::autorec::secrets::load(crate::autorec::secrets::HQ_API_KEY, api_key);
                if migrated {
                    let _ = sqlx::query("UPDATE hq_settings SET api_key = NULL WHERE id = ?").bind(SETTINGS_ID).execute(pool).await;
                }
                key
            },
            auto_sync: auto_sync != 0,
            default_project_id,
            user_email,
            user_name,
        },
        None => HqSettings::default(),
    })
}

pub async fn save_settings(pool: &SqlitePool, settings: &HqSettings) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO hq_settings (id, base_url, api_key, auto_sync, default_project_id, user_email, user_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           auto_sync = excluded.auto_sync,
           default_project_id = excluded.default_project_id,
           user_email = excluded.user_email,
           user_name = excluded.user_name,
           updated_at = excluded.updated_at",
    )
    .bind(SETTINGS_ID)
    .bind(settings.base_url.trim().trim_end_matches('/'))
    .bind(crate::autorec::secrets::stash(
        crate::autorec::secrets::HQ_API_KEY,
        settings.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()),
    ))
    .bind(if settings.auto_sync { 1i64 } else { 0i64 })
    .bind(settings.default_project_id.as_deref().filter(|p| !p.trim().is_empty()))
    .bind(&settings.user_email)
    .bind(&settings.user_name)
    .bind(now_str())
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save HQ settings: {}", e))?;
    Ok(())
}

// ── Sync queue ─────────────────────────────────────────────────────────────────

pub async fn get_sync_records(pool: &SqlitePool, meeting_ids: &[String]) -> Result<Vec<SyncRecord>, String> {
    let all: Vec<SyncRecord> = sqlx::query_as(
        "SELECT meeting_id, status, mode, language, project_id, lead_id, hq_meeting_id, attempts, last_error, updated_at
         FROM hq_meeting_sync",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read HQ sync status: {}", e))?;
    if meeting_ids.is_empty() {
        return Ok(all);
    }
    Ok(all.into_iter().filter(|r| meeting_ids.contains(&r.meeting_id)).collect())
}

async fn get_sync_record(pool: &SqlitePool, meeting_id: &str) -> Result<Option<SyncRecord>, String> {
    sqlx::query_as(
        "SELECT meeting_id, status, mode, language, project_id, lead_id, hq_meeting_id, attempts, last_error, updated_at
         FROM hq_meeting_sync WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read HQ sync status: {}", e))
}

/// Queue a meeting for HQ sync (idempotent: an already-synced meeting is left alone
/// unless `force` is set).
pub async fn enqueue(
    pool: &SqlitePool,
    meeting_id: &str,
    language: Option<String>,
    project_id: Option<String>,
    lead_id: Option<String>,
    force: bool,
) -> Result<(), String> {
    if let Some(existing) = get_sync_record(pool, meeting_id).await? {
        if existing.status == "synced" && !force {
            return Ok(());
        }
        sqlx::query(
            "UPDATE hq_meeting_sync SET status = 'pending', attempts = 0, last_error = NULL,
               language = COALESCE(?, language), project_id = COALESCE(?, project_id),
               lead_id = COALESCE(?, lead_id), updated_at = ?
             WHERE meeting_id = ?",
        )
        .bind(&language)
        .bind(&project_id)
        .bind(&lead_id)
        .bind(now_str())
        .bind(meeting_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to queue HQ sync: {}", e))?;
        return Ok(());
    }

    sqlx::query(
        "INSERT INTO hq_meeting_sync (meeting_id, status, language, project_id, lead_id, attempts, updated_at)
         VALUES (?, 'pending', ?, ?, ?, 0, ?)",
    )
    .bind(meeting_id)
    .bind(&language)
    .bind(&project_id)
    .bind(&lead_id)
    .bind(now_str())
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to queue HQ sync: {}", e))?;
    Ok(())
}

async fn mark(
    pool: &SqlitePool,
    meeting_id: &str,
    status: &str,
    mode: Option<&str>,
    hq_meeting_id: Option<&str>,
    error: Option<&str>,
    bump_attempts: bool,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE hq_meeting_sync SET status = ?, mode = COALESCE(?, mode), hq_meeting_id = COALESCE(?, hq_meeting_id),
           last_error = ?, attempts = attempts + ?, updated_at = ?
         WHERE meeting_id = ?",
    )
    .bind(status)
    .bind(mode)
    .bind(hq_meeting_id)
    .bind(error.map(|e| e.chars().take(500).collect::<String>()))
    .bind(if bump_attempts { 1i64 } else { 0i64 })
    .bind(now_str())
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update HQ sync status: {}", e))?;
    Ok(())
}

fn emit<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, status: &str, hq_meeting_id: Option<String>, error: Option<String>) {
    let _ = app.emit(
        "hq-sync-status",
        SyncEvent { meeting_id: meeting_id.to_string(), status: status.to_string(), hq_meeting_id, error },
    );
}

// ── Meeting data ───────────────────────────────────────────────────────────────

struct LocalMeeting {
    title: String,
    created_at: DateTime<Utc>,
    folder_path: Option<String>,
    segments: Vec<LocalSegment>,
}

struct LocalSegment {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
}

async fn load_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<LocalMeeting, String> {
    let meeting: Option<(String, DateTime<Utc>, Option<String>)> =
        sqlx::query_as("SELECT title, created_at, folder_path FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read meeting: {}", e))?;
    let (title, created_at, folder_path) = meeting.ok_or_else(|| "Meeting no longer exists locally".to_string())?;

    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT transcript, audio_start_time, audio_end_time FROM transcripts
         WHERE meeting_id = ? ORDER BY audio_start_time IS NULL, audio_start_time ASC, timestamp ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read transcripts: {}", e))?;

    let segments = rows
        .into_iter()
        .filter(|(text, _, _)| !text.trim().is_empty())
        .map(|(text, start, end)| LocalSegment { text: text.trim().to_string(), start, end })
        .collect();

    Ok(LocalMeeting { title, created_at, folder_path, segments })
}

impl LocalMeeting {
    fn duration_seconds(&self) -> f64 {
        self.segments.iter().filter_map(|s| s.end.or(s.start)).fold(0.0, f64::max)
    }

    /// `created_at` is written when the meeting is saved (≈ end of recording).
    fn time_range(&self) -> (String, String) {
        let ended = self.created_at;
        let started = ended - ChronoDuration::milliseconds((self.duration_seconds() * 1000.0) as i64);
        (
            started.to_rfc3339_opts(SecondsFormat::Millis, true),
            ended.to_rfc3339_opts(SecondsFormat::Millis, true),
        )
    }

    fn transcript_text(&self) -> String {
        let mut text = self.segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n");
        if text.chars().count() > MAX_TRANSCRIPT_CHARS {
            text = text.chars().take(MAX_TRANSCRIPT_CHARS).collect();
        }
        text
    }

    fn title(&self) -> String {
        let t = self.title.trim();
        let t = if t.is_empty() { "Aiwah Minutes meeting" } else { t };
        t.chars().take(300).collect()
    }
}


// ── HTTP ───────────────────────────────────────────────────────────────────────

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("AiwahMinutes/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

async fn error_from_response(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    let message = body
        .get("message")
        .or_else(|| body.get("error").and_then(|e| e.get("message")))
        .or_else(|| body.get("error"))
        .and_then(|m| m.as_str())
        .unwrap_or("request failed");
    match status.as_u16() {
        401 => "HQ rejected the API key (401). Update it in Settings → HQ.".to_string(),
        403 => format!("HQ refused the request (403): {}", message),
        code => format!("HQ error {}: {}", code, message),
    }
}

fn hq_meeting_id_from(body: &serde_json::Value) -> Option<String> {
    body.get("meetingId")
        .or_else(|| body.get("id"))
        .or_else(|| body.get("data").and_then(|d| d.get("meetingId")))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Result of `GET /v1/me`, used by "Test connection" to label meetings with the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HqIdentity {
    pub email: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
}

pub async fn fetch_identity(settings: &HqSettings) -> Result<HqIdentity, String> {
    let key = settings.api_key.as_deref().ok_or("Add your HQ API key first")?;
    let resp = client(Duration::from_secs(20))?
        .get(settings.url("/v1/me"))
        .bearer_auth(key.trim())
        .send()
        .await
        .map_err(|e| format!("Could not reach HQ at {}: {}", settings.base_url, e))?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Unexpected HQ response: {}", e))?;
    let principal = body.get("principal").cloned().unwrap_or(serde_json::Value::Null);
    let s = |k: &str| principal.get(k).and_then(|v| v.as_str()).map(str::to_string);
    Ok(HqIdentity { email: s("email"), name: s("name").or_else(|| s("displayName")), kind: s("kind") })
}

/// A project or lead a meeting can be tagged with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HqTarget {
    pub id: String,
    /// "project" | "lead"
    pub kind: &'static str,
    pub label: String,
}

async fn get_json(settings: &HqSettings, path: &str) -> Result<serde_json::Value, String> {
    let key = settings.api_key.as_deref().ok_or("Add your HQ API key first")?;
    let resp = client(Duration::from_secs(20))?
        .get(settings.url(path))
        .bearer_auth(key.trim())
        .send()
        .await
        .map_err(|e| format!("Could not reach HQ at {}: {}", settings.base_url, e))?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    resp.json().await.map_err(|e| format!("Unexpected HQ response: {}", e))
}

/// Projects (active ones first) and leads the key can see, for the per-meeting picker.
/// A failure to list leads does not hide the projects, and vice versa.
pub async fn list_targets(settings: &HqSettings) -> Result<Vec<HqTarget>, String> {
    let mut targets: Vec<HqTarget> = Vec::new();
    let projects = get_json(settings, "/v1/projects").await;
    let leads = get_json(settings, "/v1/leads").await;
    if let (Err(e), Err(_)) = (&projects, &leads) {
        return Err(e.clone());
    }
    if let Ok(body) = projects {
        let mut items: Vec<&serde_json::Value> = body.get("items").and_then(|v| v.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
        let done = |p: &serde_json::Value| matches!(p.get("status").and_then(|v| v.as_str()), Some("DONE") | Some("CANCELLED"));
        items.sort_by_key(|p| done(p));
        for p in items {
            if let (Some(id), Some(name)) = (p.get("id").and_then(|v| v.as_str()), p.get("name").and_then(|v| v.as_str())) {
                targets.push(HqTarget { id: id.to_string(), kind: "project", label: name.to_string() });
            }
        }
    }
    if let Ok(body) = leads {
        for l in body.get("leads").and_then(|v| v.as_array()).into_iter().flatten() {
            let id = l.get("id").and_then(|v| v.as_str());
            let name = l.get("projectName").and_then(|v| v.as_str()).or_else(|| l.get("name").and_then(|v| v.as_str()));
            if let (Some(id), Some(name)) = (id, name) {
                let label = match l.get("leadNumber").and_then(|v| v.as_i64()) {
                    Some(n) => format!("AL{} — {}", n, name),
                    None => name.to_string(),
                };
                targets.push(HqTarget { id: id.to_string(), kind: "lead", label });
            }
        }
    }
    Ok(targets)
}

/// AIWAH: what the call watcher, the Google sign-in and the speaker split know about a meeting.
struct CallExtras {
    hq_platform: &'static str,
    /// Calendar attendees other than the user who did not decline: (email, name).
    attendees: Vec<(String, Option<String>)>,
    /// The person recording: the signed-in company Google account (email, name).
    me: (Option<String>, Option<String>),
    /// hiring | discovery | demo | client | internal | other
    meeting_type: Option<String>,
    /// Transcript lines with speaker names, when the mic/call-audio split labelled them.
    lines: Option<Vec<crate::autorec::speakers::Line>>,
    /// Language the transcript is in ("en", "ml", …) and the engine that produced it.
    language: Option<String>,
    engine: Option<String>,
}

impl CallExtras {
    async fn load(pool: &SqlitePool, meeting_id: &str) -> Self {
        let meta = crate::autorec::meta::get_meta(pool, meeting_id).await;
        let me = crate::autorec::speakers::me_identity(pool).await;
        let my_email = me.0.clone();
        let (language, engine) = crate::autorec::router::meeting_language(pool, meeting_id).await;
        Self {
            hq_platform: meta
                .as_ref()
                .map(|m| crate::autorec::platform::CallPlatform::from_str(&m.platform).hq_platform())
                .unwrap_or("OTHER"),
            attendees: meta
                .as_ref()
                .map(|m| {
                    m.attendees
                        .iter()
                        .filter(|a| !a.is_self && a.email.contains('@'))
                        .filter(|a| my_email.as_deref().map(|e| !a.email.eq_ignore_ascii_case(e)).unwrap_or(true))
                        .filter(|a| a.response.as_deref() != Some("declined"))
                        .map(|a| (a.email.clone(), a.name.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            me,
            meeting_type: meta.as_ref().map(|m| m.meeting_type.clone()),
            lines: crate::autorec::speakers::labelled_lines(pool, meeting_id).await,
            language,
            engine,
        }
    }

    /// Everyone on the meeting: the person recording first (their Google account, so HQ links the
    /// meeting to their CRM user and shows it to them), then the HQ key's own user if it has an
    /// email, then the calendar guests. Names are omitted rather than sent as null.
    fn people(&self, settings: &HqSettings) -> Vec<serde_json::Value> {
        let mut people = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut add = |email: Option<&str>, name: Option<&str>| {
            let Some(email) = email.map(str::trim).filter(|e| e.contains('@')) else { return };
            if !seen.insert(email.to_lowercase()) {
                return;
            }
            let mut v = serde_json::json!({ "email": email });
            if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
                v["name"] = serde_json::json!(n.chars().take(200).collect::<String>());
            }
            people.push(v);
        };
        add(self.me.0.as_deref(), self.me.1.as_deref());
        add(settings.user_email.as_deref(), settings.user_name.as_deref());
        for (email, name) in &self.attendees {
            add(Some(email), name.as_deref());
        }
        people
    }

    /// The company domain, for telling guests from colleagues.
    fn own_domain(&self, settings: &HqSettings) -> Option<String> {
        self.me
            .0
            .as_deref()
            .or(settings.user_email.as_deref())
            .and_then(|e| e.rsplit_once('@'))
            .map(|(_, d)| d.to_lowercase())
    }
}

/// True if `needle` appears in `hay` as its own token (e.g. "al111" but not "al1110").
fn contains_token(hay: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = hay[from..].find(needle) {
        let start = from + pos;
        let end = start + needle.len();
        let before_ok = hay[..start].chars().next_back().map(|c| !c.is_alphanumeric()).unwrap_or(true);
        let after_ok = hay[end..].chars().next().map(|c| !c.is_alphanumeric()).unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// AIWAH: match a meeting to an HQ lead (attendee email, or "AL<n>" in the title)
/// or project (project name in the title). Returns (project_id, lead_id).
async fn auto_link(settings: &HqSettings, title: &str, extras: &CallExtras) -> (Option<String>, Option<String>) {
    let own_domain = extras.own_domain(settings);
    let external: Vec<String> = extras
        .attendees
        .iter()
        .map(|(e, _)| e.trim().to_lowercase())
        .filter(|e| own_domain.as_deref().map(|d| !e.ends_with(&format!("@{}", d))).unwrap_or(true))
        .collect();
    let title_l = title.to_lowercase();
    let text = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);

    if let Ok(body) = get_json(settings, "/v1/leads").await {
        let leads = body.get("leads").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for l in &leads {
            if let (Some(id), Some(email)) = (text(l, "id"), text(l, "email")) {
                if external.iter().any(|e| *e == email.trim().to_lowercase()) {
                    return (None, Some(id));
                }
            }
        }
        for l in &leads {
            if let (Some(id), Some(n)) = (text(l, "id"), l.get("leadNumber").and_then(|v| v.as_i64())) {
                if contains_token(&title_l, &format!("al{}", n)) {
                    return (None, Some(id));
                }
            }
        }
    }
    if let Ok(body) = get_json(settings, "/v1/projects").await {
        for p in body.get("items").and_then(|v| v.as_array()).into_iter().flatten() {
            if matches!(p.get("status").and_then(|v| v.as_str()), Some("DONE") | Some("CANCELLED")) {
                continue;
            }
            if let (Some(id), Some(name)) = (text(p, "id"), text(p, "name")) {
                let core = name.split(" (").next().unwrap_or(&name).trim().to_lowercase();
                if core.chars().count() >= 5 && title_l.contains(&core) {
                    return (Some(id), None);
                }
            }
        }
    }
    (None, None)
}

enum PushOutcome {
    Synced { mode: &'static str, hq_meeting_id: Option<String> },
    UploadUnsupported,
}

async fn push_ingest(
    settings: &HqSettings,
    meeting: &LocalMeeting,
    project_id: Option<&str>,
    lead_id: Option<&str>,
    extras: &CallExtras,
    auto_linked: bool,
) -> Result<PushOutcome, String> {
    // AIWAH: with speaker labels, the transcript reads "Name: text" and every segment carries
    // its speaker, so HQ shows who said what.
    let (transcript, segments): (String, Vec<serde_json::Value>) = match &extras.lines {
        Some(lines) if !lines.is_empty() => {
            let mut text = crate::autorec::speakers::render_paragraphs(lines);
            if text.chars().count() > MAX_TRANSCRIPT_CHARS {
                text = text.chars().take(MAX_TRANSCRIPT_CHARS).collect();
            }
            let segs = lines
                .iter()
                .map(|l| {
                    let mut v = serde_json::json!({ "text": l.text });
                    if let Some(s) = &l.speaker { v["speaker"] = serde_json::json!(s); }
                    if let Some(start) = l.start { v["startMs"] = serde_json::json!((start * 1000.0).round()); }
                    if let Some(end) = l.end { v["endMs"] = serde_json::json!((end * 1000.0).round()); }
                    v
                })
                .collect();
            (text, segs)
        }
        _ => (
            meeting.transcript_text(),
            meeting
                .segments
                .iter()
                .map(|s| {
                    let mut v = serde_json::json!({ "text": s.text });
                    if let Some(start) = s.start { v["startMs"] = serde_json::json!((start * 1000.0).round()); }
                    if let Some(end) = s.end { v["endMs"] = serde_json::json!((end * 1000.0).round()); }
                    v
                })
                .collect(),
        ),
    };
    if transcript.trim().is_empty() {
        return Err("Meeting has no transcript text to sync".to_string());
    }
    let (started_at, ended_at) = meeting.time_range();

    let mut body = serde_json::json!({
        "title": meeting.title(),
        "transcript": transcript,
        "platform": extras.hq_platform,
        "segments": segments,
        "startedAt": started_at,
        "endedAt": ended_at,
        "source": "aiwah-minutes-desktop",
        "transcriptionEngine": "ON_DEVICE",
    });
    let people = extras.people(settings);
    if !people.is_empty() { body["attendees"] = serde_json::json!(people); }
    if let Some(t) = &extras.meeting_type { body["meetingType"] = serde_json::json!(t); }
    if let Some(lang) = extras.language.as_deref().filter(|l| !l.is_empty()) {
        body["language"] = serde_json::json!(if lang == "en" { "en".to_string() } else { sarvam_language_code(lang) });
    }
    if let Some(p) = project_id { body["projectId"] = serde_json::json!(p); }
    if let Some(l) = lead_id { body["leadId"] = serde_json::json!(l); }
    if project_id.is_some() || lead_id.is_some() {
        body["autoLinked"] = serde_json::json!(auto_linked);
    }

    let resp = client(Duration::from_secs(60))?
        .post(settings.url("/v1/meetings/ingest"))
        .bearer_auth(settings.api_key.as_deref().unwrap_or_default().trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach HQ: {}", e))?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(PushOutcome::Synced { mode: "ingest", hq_meeting_id: hq_meeting_id_from(&body) })
}

fn find_recording(folder: Option<&str>) -> Option<PathBuf> {
    let folder = Path::new(folder?);
    crate::audio::retranscription::find_audio_file(folder).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4") | Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("webm") => "audio/webm",
        _ => "audio/mp4", // Meetily records AAC in an MP4 container
    }
}

async fn push_upload(
    settings: &HqSettings,
    meeting: &LocalMeeting,
    recording: &Path,
    language: &str,
    project_id: Option<&str>,
    extras: &CallExtras,
    auto_linked: bool,
) -> Result<PushOutcome, String> {
    let size = tokio::fs::metadata(recording).await.map_err(|e| format!("Recording not readable: {}", e))?.len();
    if size == 0 {
        return Err("Recording file is empty".to_string());
    }
    if size > MAX_UPLOAD_BYTES {
        return Err("Recording is larger than 500 MB; HQ cannot accept it".to_string());
    }
    let bytes = tokio::fs::read(recording).await.map_err(|e| format!("Recording not readable: {}", e))?;

    // Contract (HQ): raw audio body with an audio/* Content-Type; metadata in the query.
    let (started_at, ended_at) = meeting.time_range();
    let mut query: Vec<(&str, String)> = vec![
        ("title", meeting.title()),
        ("language", sarvam_language_code(language)),
        ("startedAt", started_at),
        ("endedAt", ended_at),
        ("source", "aiwah-minutes-desktop".to_string()),
    ];
    if let Some(p) = project_id {
        query.push(("projectId", p.to_string()));
        query.push(("autoLinked", auto_linked.to_string()));
    }
    query.push(("platform", extras.hq_platform.to_string()));
    if let Some(t) = &extras.meeting_type { query.push(("meetingType", t.clone())); }
    let people = extras.people(settings);
    if !people.is_empty() { query.push(("attendees", serde_json::json!(people).to_string())); }

    let resp = client(Duration::from_secs(30 * 60))?
        .post(settings.url("/v1/meetings/upload-recording"))
        .bearer_auth(settings.api_key.as_deref().unwrap_or_default().trim())
        .query(&query)
        .header(reqwest::header::CONTENT_TYPE, mime_for(recording))
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Could not upload recording to HQ: {}", e))?;
    if resp.status().as_u16() == 404 || resp.status().as_u16() == 405 {
        return Ok(PushOutcome::UploadUnsupported);
    }
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(PushOutcome::Synced { mode: "upload", hq_meeting_id: hq_meeting_id_from(&body) })
}

/// Push one queued meeting. Returns the new status.
pub async fn process_meeting<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool, meeting_id: &str) -> Result<String, String> {
    let settings = load_settings(pool).await?;
    if !settings.is_configured() {
        return Ok("pending".to_string()); // waits until the user adds a key
    }
    let record = match get_sync_record(pool, meeting_id).await? {
        Some(r) => r,
        None => return Ok("missing".to_string()),
    };
    if record.status == "synced" {
        return Ok(record.status);
    }

    emit(app, meeting_id, "syncing", None, None);
    let meeting = match load_meeting(pool, meeting_id).await {
        Ok(m) => m,
        Err(e) => {
            mark(pool, meeting_id, "skipped", None, None, Some(&e), false).await?;
            emit(app, meeting_id, "skipped", None, Some(e));
            return Ok("skipped".to_string());
        }
    };
    // AIWAH: platform, Google account, calendar guests, speaker labels and transcript language;
    // auto-link to an HQ lead/project when the user did not pick one.
    let extras = CallExtras::load(pool, meeting_id).await;
    let (mut project_id, mut lead_id) = (record.project_id.clone(), record.lead_id.clone());
    let mut auto_linked = false;
    if project_id.is_none() && lead_id.is_none() {
        let (p, l) = auto_link(&settings, &meeting.title(), &extras).await;
        if p.is_some() || l.is_some() {
            log::info!("Auto-linked meeting to an HQ {}", if l.is_some() { "lead" } else { "project" });
            auto_linked = true;
        }
        project_id = p;
        lead_id = l;
    }
    let project_id = project_id.or_else(|| settings.default_project_id.clone());
    let language = extras.language.clone().or_else(|| record.language.clone());
    // Indian-language meetings already transcribed on this device by IndicConformer go in like
    // English ones (transcript + speakers + audio). Only when the Indic model is missing does
    // HQ transcribe the recording itself with Sarvam.
    let transcribed_on_device_indic = extras.engine.as_deref() == Some(crate::autorec::router::ENGINE_INDIC);

    let outcome = if is_indic_language(language.as_deref()) && !transcribed_on_device_indic {
        match find_recording(meeting.folder_path.as_deref()) {
            Some(recording) => {
                let lang = language.as_deref().unwrap_or("ml");
                match push_upload(&settings, &meeting, &recording, lang, project_id.as_deref(), &extras, auto_linked).await {
                    Ok(PushOutcome::UploadUnsupported) => {
                        log::warn!("HQ does not accept recording uploads yet; falling back to transcript ingest");
                        push_ingest(&settings, &meeting, project_id.as_deref(), lead_id.as_deref(), &extras, auto_linked).await
                    }
                    other => other,
                }
            }
            None => {
                log::warn!("Indic meeting has no recording file; syncing local transcript instead");
                push_ingest(&settings, &meeting, project_id.as_deref(), lead_id.as_deref(), &extras, auto_linked).await
            }
        }
    } else {
        push_ingest(&settings, &meeting, project_id.as_deref(), lead_id.as_deref(), &extras, auto_linked).await
    };

    match outcome {
        Ok(PushOutcome::Synced { mode, hq_meeting_id }) => {
            mark(pool, meeting_id, "synced", Some(mode), hq_meeting_id.as_deref(), None, true).await?;
            log::info!("Meeting synced to HQ (mode={})", mode);
            // The upload route already stored the audio in HQ; after an ingest, attach it now.
            let audio_done = if mode == "upload" {
                set_audio_status(pool, meeting_id, "attached").await;
                true
            } else {
                set_audio_status(pool, meeting_id, "pending").await;
                attach_recording(pool, &settings, meeting_id).await
            };
            if audio_done {
                delete_audio_if_requested(pool, meeting.folder_path.as_deref()).await;
            }
            emit(app, meeting_id, "synced", hq_meeting_id, None);
            Ok("synced".to_string())
        }
        Ok(PushOutcome::UploadUnsupported) => unreachable!("handled above"),
        Err(e) => {
            let status = if record.attempts + 1 >= MAX_ATTEMPTS { "failed" } else { "pending" };
            mark(pool, meeting_id, status, None, None, Some(&e), true).await?;
            log::warn!("HQ sync attempt failed (status={})", status);
            emit(app, meeting_id, if status == "failed" { "failed" } else { "retrying" }, None, Some(e.clone()));
            Err(e)
        }
    }
}

// ── Recording audio in HQ ──────────────────────────────────────────────────────

/// Give up attaching audio after this many tries (about 2 days at the 5-minute retry loop
/// while the HQ endpoint is not deployed yet).
const MAX_AUDIO_ATTEMPTS: i64 = 600;

async fn set_audio_status(pool: &SqlitePool, meeting_id: &str, status: &str) {
    let _ = sqlx::query("UPDATE hq_meeting_sync SET audio_status = ?, updated_at = ? WHERE meeting_id = ?")
        .bind(status)
        .bind(now_str())
        .bind(meeting_id)
        .execute(pool)
        .await;
}

async fn delete_audio_if_requested(pool: &SqlitePool, folder: Option<&str>) {
    if !crate::autorec::settings::load(pool).await.delete_audio_after_sync {
        return;
    }
    if let Some(path) = find_recording(folder) {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => log::info!("Deleted local audio after HQ sync (privacy setting)"),
            Err(e) => log::warn!("Could not delete local audio after sync: {}", e),
        }
    }
}

enum AttachOutcome {
    Attached,
    /// HQ does not have the endpoint yet (404/405): keep the audio queued.
    Unsupported,
    NoRecording,
}

/// `PUT /v1/meetings/:id/recording`: raw audio body; stores the audio on the HQ meeting
/// without re-transcribing it.
async fn push_recording(settings: &HqSettings, hq_meeting_id: &str, recording: &Path, duration_secs: Option<f64>) -> Result<AttachOutcome, String> {
    let size = tokio::fs::metadata(recording).await.map_err(|e| format!("Recording not readable: {}", e))?.len();
    if size == 0 {
        return Ok(AttachOutcome::NoRecording);
    }
    if size > MAX_UPLOAD_BYTES {
        return Err("Recording is larger than 500 MB; HQ cannot accept it".to_string());
    }
    let bytes = tokio::fs::read(recording).await.map_err(|e| format!("Recording not readable: {}", e))?;
    let mut query: Vec<(&str, String)> = Vec::new();
    if let Some(d) = duration_secs.filter(|d| *d > 0.0) {
        query.push(("durationSeconds", (d.round() as i64).to_string()));
    }
    let resp = client(Duration::from_secs(30 * 60))?
        .put(settings.url(&format!("/v1/meetings/{}/recording", hq_meeting_id)))
        .bearer_auth(settings.api_key.as_deref().unwrap_or_default().trim())
        .query(&query)
        .header(reqwest::header::CONTENT_TYPE, mime_for(recording))
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Could not upload recording to HQ: {}", e))?;
    match resp.status().as_u16() {
        // Endpoint not deployed yet (or meeting gone): nothing was stored, retry later.
        404 | 405 => Ok(AttachOutcome::Unsupported),
        s if (200..300).contains(&s) => Ok(AttachOutcome::Attached),
        _ => Err(error_from_response(resp).await),
    }
}

/// Attach the local recording to the already-synced HQ meeting. Returns true when the audio is
/// in HQ (or there is no audio to send), so local cleanup may run.
async fn attach_recording(pool: &SqlitePool, settings: &HqSettings, meeting_id: &str) -> bool {
    let Ok(Some(record)) = get_sync_record(pool, meeting_id).await else { return false };
    let Some(hq_id) = record.hq_meeting_id.clone() else {
        set_audio_status(pool, meeting_id, "none").await;
        return false;
    };
    let Ok(meeting) = load_meeting(pool, meeting_id).await else { return false };
    let Some(recording) = find_recording(meeting.folder_path.as_deref()) else {
        set_audio_status(pool, meeting_id, "none").await;
        return true;
    };
    let _ = sqlx::query("UPDATE hq_meeting_sync SET audio_attempts = COALESCE(audio_attempts, 0) + 1 WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(pool)
        .await;
    match push_recording(settings, &hq_id, &recording, Some(meeting.duration_seconds())).await {
        Ok(AttachOutcome::Attached) => {
            log::info!("Recording attached to the HQ meeting");
            set_audio_status(pool, meeting_id, "attached").await;
            true
        }
        Ok(AttachOutcome::NoRecording) => {
            set_audio_status(pool, meeting_id, "none").await;
            true
        }
        Ok(AttachOutcome::Unsupported) => {
            log::info!("HQ cannot store meeting audio yet; will retry");
            false
        }
        Err(e) => {
            log::warn!("Attaching the recording to HQ failed: {}", e);
            false
        }
    }
}

/// Retry audio for synced meetings whose recording is not in HQ yet.
async fn process_pending_audio(pool: &SqlitePool, settings: &HqSettings) {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT s.meeting_id, m.folder_path FROM hq_meeting_sync s JOIN meetings m ON m.id = s.meeting_id
         WHERE s.status = 'synced' AND s.audio_status = 'pending' AND COALESCE(s.audio_attempts, 0) < ?
         ORDER BY s.updated_at ASC LIMIT 5",
    )
    .bind(MAX_AUDIO_ATTEMPTS)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (meeting_id, folder) in rows {
        if attach_recording(pool, settings, &meeting_id).await {
            delete_audio_if_requested(pool, folder.as_deref()).await;
        }
    }
}

pub async fn process_pending<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool) -> Result<usize, String> {
    let settings = load_settings(pool).await?;
    if !settings.is_configured() || !settings.auto_sync {
        return Ok(0);
    }
    let pending: Vec<(String,)> = sqlx::query_as(
        "SELECT meeting_id FROM hq_meeting_sync WHERE status = 'pending' ORDER BY updated_at ASC LIMIT 20",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read HQ sync queue: {}", e))?;
    let mut synced = 0;
    for (meeting_id,) in pending {
        if let Ok(s) = process_meeting(app, pool, &meeting_id).await {
            if s == "synced" { synced += 1; }
        }
    }
    process_pending_audio(pool, &settings).await;
    Ok(synced)
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

/// AIWAH hook: called right after a meeting is saved. Never fails the save.
pub fn on_meeting_saved<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) {
    let app = app.clone();
    let meeting_id = meeting_id.to_string();
    let language = crate::get_language_preference_internal();
    // AIWAH: the me/them loudness timeline of the recording that just ended, and a "pending"
    // routing state the meeting page can see before the async work below starts.
    let timeline = crate::autorec::speakers::take();
    crate::autorec::router::begin(&app, &meeting_id);
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return };
        let pool = state.db_manager.pool().clone();
        // AIWAH: remember platform / calendar event / meeting type for folders and HQ.
        let self_email = crate::autorec::speakers::me_identity(&pool)
            .await
            .0
            .or(load_settings(&pool).await.ok().and_then(|s| s.user_email));
        crate::autorec::meta::persist_for_meeting(&pool, &meeting_id, self_email.as_deref()).await;
        // AIWAH: English stays with the live Parakeet transcript; an Indian language is
        // re-transcribed by IndicConformer first. Then label who spoke each final line.
        crate::autorec::router::run(&app, &pool, &meeting_id).await;
        crate::autorec::speakers::persist_for_meeting(&pool, &meeting_id, &timeline).await;
        let title: Option<String> = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .map(|(t,)| t);
        crate::autorec::watcher::on_meeting_saved(&app, &meeting_id, title);
        if let Err(e) = enqueue(&pool, &meeting_id, language, None, None, false).await {
            log::warn!("Could not queue meeting for HQ sync: {}", e);
            return;
        }
        match load_settings(&pool).await {
            Ok(s) if s.is_configured() && s.auto_sync => {
                let _ = process_meeting(&app, &pool, &meeting_id).await;
            }
            _ => emit(&app, &meeting_id, "pending", None, None),
        }
    });
}

/// Background retry loop for queued meetings (offline / HQ down / key missing).
pub fn start_background_sync<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Give onboarding / DB setup time to finish.
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if let Some(state) = app.try_state::<AppState>() {
                let pool = state.db_manager.pool().clone();
                if let Err(e) = process_pending(&app, &pool).await {
                    log::warn!("HQ background sync skipped: {}", e);
                }
            }
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indic_detection() {
        assert!(is_indic_language(Some("ml")));
        assert!(is_indic_language(Some("ta-IN")));
        assert!(is_indic_language(Some("HI")));
        assert!(!is_indic_language(Some("en")));
        assert!(!is_indic_language(Some("auto")));
        assert!(!is_indic_language(Some("auto-translate")));
        assert!(!is_indic_language(None));
    }

    #[test]
    fn sarvam_codes() {
        assert_eq!(sarvam_language_code("ml"), "ml-IN");
        assert_eq!(sarvam_language_code("ta-IN"), "ta-IN");
    }

    #[test]
    fn meeting_id_parsing() {
        assert_eq!(hq_meeting_id_from(&serde_json::json!({"meetingId": "m1"})).as_deref(), Some("m1"));
        assert_eq!(hq_meeting_id_from(&serde_json::json!({"data": {"meetingId": "m2"}})).as_deref(), Some("m2"));
        assert_eq!(hq_meeting_id_from(&serde_json::json!({})), None);
    }
}
