//! AIWAH: who spoke each transcript line — "me" (this device's microphone) or "them" (the
//! call audio coming out of the speakers).
//!
//! The pipeline mixes microphone and system audio in ~600 ms windows before VAD and
//! transcription. Just before mixing, it reports the loudness (RMS) of each side here. When the
//! meeting is saved, every transcript line is labelled by comparing the two sides over the
//! line's time range. Names are resolved later (the signed-in Google account for "me",
//! calendar guests or the call app for "them") so they can change without re-processing.
//!
//! Cost: two f32 sums per window and one short mutex lock; no logging, no audio is copied.

use sqlx::SqlitePool;
use std::sync::Mutex;

/// One mixing window: start time in recording seconds, length in seconds, RMS of each side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub t: f32,
    pub len: f32,
    pub mic: f32,
    pub sys: f32,
}

/// ~4 h of 600 ms windows; older windows are dropped so memory stays bounded (~1.4 MB).
const MAX_WINDOWS: usize = 24_000;

static TIMELINE: Mutex<Vec<Window>> = Mutex::new(Vec::new());

/// Called when a new recording pipeline starts.
pub fn reset() {
    if let Ok(mut t) = TIMELINE.lock() {
        t.clear();
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Called by the pipeline for every window, just before mic and system audio are mixed.
pub fn record(timestamp_secs: f64, sample_rate: u32, mic: &[f32], sys: &[f32]) {
    let len = mic.len().max(sys.len()) as f32 / sample_rate.max(1) as f32;
    let w = Window { t: timestamp_secs as f32, len, mic: rms(mic), sys: rms(sys) };
    if let Ok(mut t) = TIMELINE.lock() {
        if t.len() >= MAX_WINDOWS {
            t.drain(0..MAX_WINDOWS / 10);
        }
        t.push(w);
    }
}

/// One log line about how loud each side was over a recording: how many windows had signal and
/// the peak levels. Levels only, no content. Tells "call audio was never captured" (system side
/// silent) apart from "captured but not transcribed".
pub fn levels_summary(timeline: &[Window]) -> String {
    let n = timeline.len();
    if n == 0 {
        return "no audio windows".to_string();
    }
    let pct = |f: &dyn Fn(&Window) -> bool| timeline.iter().filter(|w| f(w)).count() * 100 / n;
    let peak = |f: &dyn Fn(&Window) -> f32| timeline.iter().map(f).fold(0.0f32, f32::max);
    format!(
        "{} windows; microphone active {}% (peak {:.3}); call audio active {}% (peak {:.3})",
        n,
        pct(&|w| w.mic >= 0.004),
        peak(&|w| w.mic),
        pct(&|w| w.sys >= 0.002),
        peak(&|w| w.sys),
    )
}

/// Hand over the timeline of the recording that just ended.
pub fn take() -> Vec<Window> {
    TIMELINE.lock().map(|mut t| std::mem::take(&mut *t)).unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Me,
    Them,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Me => "me",
            Side::Them => "them",
        }
    }
}

/// Below this the side is treated as silent (digital system audio is ~0 when nobody talks).
const SILENCE_RMS: f32 = 0.004;

/// Label one transcript line spanning `start..end` seconds. `None` when there is no audio
/// information for that range (e.g. imported files) or both sides are silent.
pub fn attribute(timeline: &[Window], start: f64, end: f64) -> Option<Side> {
    let (start, end) = (start as f32, end.max(start) as f32);
    let (mut mic, mut sys, mut n) = (0.0f32, 0.0f32, 0u32);
    for w in timeline {
        // Overlap with a little slack: window timestamps and VAD boundaries are not exact.
        if w.t + w.len < start - 0.3 || w.t > end + 0.3 {
            continue;
        }
        mic += w.mic * w.mic;
        sys += w.sys * w.sys;
        n += 1;
    }
    if n == 0 {
        return None;
    }
    let (mic, sys) = ((mic / n as f32).sqrt(), (sys / n as f32).sqrt());
    if mic < SILENCE_RMS && sys < SILENCE_RMS {
        return None;
    }
    // System audio is the clean digital signal of the other side. Without headphones the mic
    // also hears it (quieter), so "them" wins whenever the system side is clearly present.
    if sys >= SILENCE_RMS && sys * 2.0 >= mic {
        Some(Side::Them)
    } else {
        Some(Side::Me)
    }
}

/// Label every transcript line of a saved meeting and store the result.
pub async fn persist_for_meeting(pool: &SqlitePool, meeting_id: &str, timeline: &[Window]) {
    if timeline.is_empty() {
        return;
    }
    let rows: Vec<(String, Option<f64>, Option<f64>)> = match sqlx::query_as(
        "SELECT id, audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("Could not read transcript lines for speaker labels: {}", e);
            return;
        }
    };
    let mut labelled = 0usize;
    for (id, start, end) in rows {
        let (Some(start), Some(end)) = (start, end) else { continue };
        let Some(side) = attribute(timeline, start, end) else { continue };
        let res = sqlx::query(
            "INSERT OR REPLACE INTO aiwah_transcript_speaker (transcript_id, meeting_id, side) VALUES (?, ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(side.as_str())
        .execute(pool)
        .await;
        if res.is_ok() {
            labelled += 1;
        }
    }
    log::info!("Labelled {} transcript lines with a speaker side", labelled);
}

/// transcript id -> side, for one meeting.
pub async fn sides_for_meeting(pool: &SqlitePool, meeting_id: &str) -> std::collections::HashMap<String, Side> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT transcript_id, side FROM aiwah_transcript_speaker WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
    rows.into_iter()
        .filter_map(|(id, s)| match s.as_str() {
            "me" => Some((id, Side::Me)),
            "them" => Some((id, Side::Them)),
            _ => None,
        })
        .collect()
}

/// Display names for the two sides.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerNames {
    pub me: String,
    pub them: String,
}

/// "me" is the signed-in Google account (falls back to the HQ identity, then "Me").
/// "them" is the one other calendar guest when there is exactly one; otherwise the guests'
/// first names when there are at most three; otherwise a label from the call app.
pub fn names(
    my_name: Option<&str>,
    others: &[(String, Option<String>)],
    platform_label: Option<&str>,
) -> SpeakerNames {
    let me = my_name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Me").to_string();
    let display = |(email, name): &(String, Option<String>)| {
        name.as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| email.split('@').next().unwrap_or(email).to_string())
    };
    let them = match others.len() {
        0 => match platform_label {
            Some(p) if !p.is_empty() && p != "Other" => format!("Other person ({})", p),
            _ => "Other person".to_string(),
        },
        1 => display(&others[0]),
        2 | 3 => others
            .iter()
            .map(|o| display(o).split_whitespace().next().unwrap_or("").to_string())
            .collect::<Vec<_>>()
            .join(" / "),
        n => format!("Participants ({})", n),
    };
    SpeakerNames { me, them }
}

/// The person recording: the signed-in company Google account.
pub async fn me_identity(pool: &SqlitePool) -> (Option<String>, Option<String>) {
    match super::calendar::account_status(pool).await {
        Ok(a) => (a.email, a.name),
        Err(_) => (None, None),
    }
}

/// Names for the two sides of one meeting.
pub async fn resolve_names(pool: &SqlitePool, meeting_id: &str) -> SpeakerNames {
    let (my_email, my_name) = me_identity(pool).await;
    let my_name = my_name.or_else(|| my_email.as_deref().map(|e| e.split('@').next().unwrap_or(e).to_string()));
    let meta = super::meta::get_meta(pool, meeting_id).await;
    let others: Vec<(String, Option<String>)> = meta
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
        .unwrap_or_default();
    let platform_label = meta.as_ref().map(|m| super::platform::CallPlatform::from_str(&m.platform).label());
    names(my_name.as_deref(), &others, platform_label)
}

/// One transcript line with its speaker name (None when unknown).
#[derive(Debug, Clone)]
pub struct Line {
    pub id: String,
    pub speaker: Option<String>,
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
}

/// Transcript lines of a meeting in time order, with speaker names where known.
/// `None` when no line of this meeting has a speaker label.
pub async fn labelled_lines(pool: &SqlitePool, meeting_id: &str) -> Option<Vec<Line>> {
    let sides = sides_for_meeting(pool, meeting_id).await;
    if sides.is_empty() {
        return None;
    }
    let names = resolve_names(pool, meeting_id).await;
    let rows: Vec<(String, String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT id, transcript, audio_start_time, audio_end_time FROM transcripts
         WHERE meeting_id = ? ORDER BY COALESCE(audio_start_time, 0), timestamp",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .ok()?;
    Some(
        rows.into_iter()
            .filter(|(_, t, _, _)| !t.trim().is_empty())
            .map(|(id, text, start, end)| {
                let speaker = sides.get(&id).map(|s| match s {
                    Side::Me => names.me.clone(),
                    Side::Them => names.them.clone(),
                });
                Line { id, speaker, text: text.trim().to_string(), start, end }
            })
            .collect(),
    )
}

/// "Name: text" paragraphs (consecutive lines of one speaker merged), for the summary model
/// and HQ. `None` when the meeting has no speaker labels.
pub async fn labelled_transcript(pool: &SqlitePool, meeting_id: &str) -> Option<String> {
    let lines = labelled_lines(pool, meeting_id).await?;
    Some(render_paragraphs(&lines))
}

pub fn render_paragraphs(lines: &[Line]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut current: Option<(Option<String>, String)> = None;
    for l in lines {
        match &mut current {
            Some((who, text)) if *who == l.speaker => {
                text.push(' ');
                text.push_str(&l.text);
            }
            _ => {
                if let Some((who, text)) = current.take() {
                    out.push(match who { Some(w) => format!("{}: {}", w, text), None => text });
                }
                current = Some((l.speaker.clone(), l.text.clone()));
            }
        }
    }
    if let Some((who, text)) = current {
        out.push(match who { Some(w) => format!("{}: {}", w, text), None => text });
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(t: f32, mic: f32, sys: f32) -> Window {
        Window { t, len: 0.6, mic, sys }
    }

    #[test]
    fn mic_only_is_me_and_system_is_them() {
        let tl = vec![w(0.0, 0.2, 0.0), w(0.6, 0.2, 0.0), w(5.0, 0.0, 0.1), w(5.6, 0.03, 0.12)];
        assert_eq!(attribute(&tl, 0.0, 1.2), Some(Side::Me));
        // Remote speech that also leaks into the mic (no headphones) is still "them".
        assert_eq!(attribute(&tl, 5.0, 6.2), Some(Side::Them));
        assert_eq!(attribute(&tl, 20.0, 22.0), None);
    }

    #[test]
    fn silence_is_unknown() {
        assert_eq!(attribute(&[w(0.0, 0.001, 0.0)], 0.0, 0.6), None);
    }

    #[test]
    fn names_from_guests() {
        let one = vec![("anil@x.in".to_string(), Some("Anil Kumar".to_string()))];
        assert_eq!(names(Some("Darani S"), &one, None).them, "Anil Kumar");
        let two = vec![("a@x.in".to_string(), Some("Anil Kumar".to_string())), ("meera@x.in".to_string(), None)];
        assert_eq!(names(None, &two, None).them, "Anil / meera");
        assert_eq!(names(None, &two, None).me, "Me");
        assert_eq!(names(None, &[], Some("WhatsApp")).them, "Other person (WhatsApp)");
    }

    #[test]
    fn paragraphs_merge_consecutive_speakers() {
        let l = |s: Option<&str>, t: &str| Line { id: t.into(), speaker: s.map(Into::into), text: t.into(), start: None, end: None };
        let text = render_paragraphs(&[l(Some("Darani"), "Hi."), l(Some("Darani"), "Shall we start?"), l(Some("Anil"), "Yes."), l(None, "(noise)")]);
        assert_eq!(text, "Darani: Hi. Shall we start?\nAnil: Yes.\n(noise)");
    }

    #[test]
    fn timeline_is_bounded() {
        reset();
        for i in 0..(MAX_WINDOWS + 10) {
            record(i as f64 * 0.6, 48_000, &[0.1; 8], &[0.0; 8]);
        }
        assert!(take().len() <= MAX_WINDOWS);
    }
}
