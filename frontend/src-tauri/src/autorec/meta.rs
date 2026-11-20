//! AIWAH: per-meeting call metadata: which platform the call was on (drives the
//! sidebar folders and the HQ `platform` field), the meeting type (template), and
//! the Google Calendar event it belongs to (title, attendees for lead matching).

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;

use super::calendar::{CalendarEvent, EventAttendee};
use super::platform::CallPlatform;

/// Meeting types ("templates"). Guessed from the title and attendees, editable per meeting.
pub const MEETING_TYPES: &[(&str, &str)] = &[
    ("hiring", "Hiring screen"),
    ("discovery", "Discovery call"),
    ("demo", "Demo"),
    ("client", "Client call"),
    ("internal", "Internal"),
    ("other", "Other"),
];

pub fn is_valid_type(t: &str) -> bool {
    MEETING_TYPES.iter().any(|(k, _)| *k == t)
}

/// What we know about the recording that is running right now.
#[derive(Debug, Clone)]
pub struct RecordingContext {
    pub platform: CallPlatform,
    pub app_name: Option<String>,
    pub app_id: Option<String>,
    /// "manual" | "prompt" | "calendar"
    pub source: &'static str,
    pub event: Option<CalendarEvent>,
    pub title: Option<String>,
    pub started_at: DateTime<Utc>,
}

static CURRENT: Mutex<Option<RecordingContext>> = Mutex::new(None);

pub fn set_current(ctx: RecordingContext) {
    if let Ok(mut g) = CURRENT.lock() {
        *g = Some(ctx);
    }
}

pub fn current() -> Option<RecordingContext> {
    CURRENT.lock().ok().and_then(|g| g.clone())
}

pub fn update_current(f: impl FnOnce(&mut RecordingContext)) {
    if let Ok(mut g) = CURRENT.lock() {
        if let Some(ctx) = g.as_mut() {
            f(ctx);
        }
    }
}

fn take_current() -> Option<RecordingContext> {
    CURRENT.lock().ok().and_then(|mut g| g.take())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMeta {
    pub meeting_id: String,
    pub platform: String,
    pub meeting_type: String,
    pub source: String,
    pub app_name: Option<String>,
    pub calendar_event_id: Option<String>,
    pub attendees: Vec<EventAttendee>,
}

type MetaRow = (String, String, String, String, Option<String>, Option<String>, Option<String>);

fn from_row(r: MetaRow) -> MeetingMeta {
    MeetingMeta {
        meeting_id: r.0,
        platform: r.1,
        meeting_type: r.2,
        source: r.3,
        app_name: r.4,
        calendar_event_id: r.5,
        attendees: r.6.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
    }
}

const SELECT: &str =
    "SELECT meeting_id, platform, meeting_type, source, app_name, calendar_event_id, attendees_json FROM aiwah_meeting_meta";

pub async fn get_meta(pool: &SqlitePool, meeting_id: &str) -> Option<MeetingMeta> {
    let row: Option<MetaRow> = sqlx::query_as(&format!("{} WHERE meeting_id = ?", SELECT))
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    row.map(from_row)
}

pub async fn list_meta(pool: &SqlitePool) -> Result<Vec<MeetingMeta>, String> {
    let rows: Vec<MetaRow> = sqlx::query_as(SELECT)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to read meeting folders: {}", e))?;
    Ok(rows.into_iter().map(from_row).collect())
}

pub async fn update_meta(
    pool: &SqlitePool,
    meeting_id: &str,
    platform: Option<String>,
    meeting_type: Option<String>,
) -> Result<(), String> {
    if let Some(t) = meeting_type.as_deref() {
        if !is_valid_type(t) {
            return Err(format!("Unknown meeting type: {}", t));
        }
    }
    let platform = platform.map(|p| CallPlatform::from_str(&p).as_str().to_string());
    // Create the row for meetings recorded before this feature existed.
    sqlx::query(
        "INSERT OR IGNORE INTO aiwah_meeting_meta (meeting_id, platform, meeting_type, source, created_at)
         VALUES (?, 'other', 'other', 'manual', ?)",
    )
    .bind(meeting_id)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE aiwah_meeting_meta SET platform = COALESCE(?, platform), meeting_type = COALESCE(?, meeting_type)
         WHERE meeting_id = ?",
    )
    .bind(platform)
    .bind(meeting_type)
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove folder/sync rows whose meeting was deleted (no foreign keys on our tables).
pub async fn cleanup_orphans(pool: &SqlitePool) {
    for sql in [
        "DELETE FROM aiwah_meeting_meta WHERE meeting_id NOT IN (SELECT id FROM meetings)",
        "DELETE FROM hq_meeting_sync WHERE meeting_id NOT IN (SELECT id FROM meetings)",
    ] {
        match sqlx::query(sql).execute(pool).await {
            Ok(r) if r.rows_affected() > 0 => log::info!("Removed {} leftover rows of deleted meetings", r.rows_affected()),
            Ok(_) => {}
            Err(e) => log::warn!("Cleanup of deleted meetings' rows failed: {}", e),
        }
    }
}

fn domain(email: &str) -> Option<String> {
    email.rsplit_once('@').map(|(_, d)| d.trim().to_lowercase())
}

/// Template guess from the title and who was invited.
pub fn guess_type(title: &str, attendees: &[EventAttendee], self_email: Option<&str>) -> &'static str {
    let t = title.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["interview", "introductory conversation", "screening", "candidate", "hiring", "intern "]) {
        return "hiring";
    }
    if has(&["discovery", "requirement", "scoping"]) {
        return "discovery";
    }
    if has(&["demo", "walkthrough", "walk-through", "presentation"]) {
        return "demo";
    }
    let own = self_email.and_then(domain);
    let others: Vec<&EventAttendee> = attendees.iter().filter(|a| !a.is_self).collect();
    if let Some(own) = own {
        let generic = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"];
        let is_internal = |a: &&EventAttendee| domain(&a.email).map(|d| d == own && !generic.contains(&d.as_str())).unwrap_or(false);
        if !others.is_empty() && others.iter().all(is_internal) {
            return "internal";
        }
        if others.iter().any(|a| !is_internal(a)) {
            return "client";
        }
    }
    if has(&["standup", "stand-up", "sync", "all hands", "all-hands", "1:1", "retro", "planning"]) {
        return "internal";
    }
    "other"
}

/// Called when a meeting is saved: store what we knew about the call. Keeps an
/// existing row (e.g. the user already moved it to another folder).
pub async fn persist_for_meeting(pool: &SqlitePool, meeting_id: &str, self_email: Option<&str>) {
    let ctx = take_current().filter(|c| Utc::now().signed_duration_since(c.started_at).num_hours() < 12);
    let title: String = sqlx::query_as::<_, (String,)>("SELECT title FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(t,)| t)
        .unwrap_or_default();

    let (platform, source, app_name, event) = match &ctx {
        Some(c) => (c.platform, c.source, c.app_name.clone(), c.event.clone()),
        None => (CallPlatform::Other, "manual", None, None),
    };
    let attendees: Vec<EventAttendee> = event.as_ref().map(|e| e.attendees.clone()).unwrap_or_default();
    let meeting_type = guess_type(&title, &attendees, self_email);
    let result = sqlx::query(
        "INSERT OR IGNORE INTO aiwah_meeting_meta
           (meeting_id, platform, meeting_type, source, app_name, calendar_event_id, attendees_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(meeting_id)
    .bind(platform.as_str())
    .bind(meeting_type)
    .bind(source)
    .bind(app_name)
    .bind(event.as_ref().map(|e| e.id.clone()))
    .bind(serde_json::to_string(&attendees).ok())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    if let Err(e) = result {
        log::warn!("Could not save meeting call metadata: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(email: &str, is_self: bool) -> EventAttendee {
        EventAttendee { email: email.to_string(), name: None, is_self, response: None, is_organizer: false, optional: false }
    }

    #[test]
    fn type_guess() {
        let me = Some("me@aiwahlabs.com");
        assert_eq!(guess_type("Introductory Conversation - Asha", &[], me), "hiring");
        assert_eq!(guess_type("Discovery call: Acme", &[], me), "discovery");
        assert_eq!(guess_type("CRM demo", &[], me), "demo");
        assert_eq!(guess_type("Weekly", &[a("me@aiwahlabs.com", true), a("x@aiwahlabs.com", false)], me), "internal");
        assert_eq!(guess_type("Weekly", &[a("me@aiwahlabs.com", true), a("ceo@acme.com", false)], me), "client");
        assert_eq!(guess_type("Daily standup", &[], me), "internal");
        assert_eq!(guess_type("Chat", &[], None), "other");
    }
}
