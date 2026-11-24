//! AIWAH: the call watcher, modelled on Granola.
//!
//! Nothing is on screen while idle. Every couple of seconds the watcher checks which
//! apps use the microphone and what is on Google Calendar, and drives one small
//! frameless window (label "floating", pinned top-right, never takes focus):
//! - **prompt**: "Huddle detected" / "Call detected" / "Meeting detected" when a call
//!   starts (microphone in use), or "Meeting starts in 1 min" for a calendar meeting.
//!   The user chooses; nothing records without a click unless they opted in to
//!   auto-recording Google Meet calendar meetings.
//! - **starting** / **recording**: a compact pill with a timer and Stop, shown only
//!   while the main window is not in front.
//! - **saved**: "Saved to Aiwah Minutes · Open notes", briefly, after a recording.
//!
//! Recording itself starts exactly like the tray does it: the main window gets the
//! `autoStartRecording` flag and navigates home, so the normal start path (model
//! checks, devices, notifications) runs unchanged.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindowBuilder};

use super::calendar::{self, CalendarEvent};
use super::meta::{self, RecordingContext};
use super::mic;
use super::platform::{self, CallPlatform, DetectedCall};
use super::settings::{self, AutoRecSettings};
use crate::state::AppState;

pub const FLOATING_LABEL: &str = "floating";
pub const STATE_EVENT: &str = "aiwah-floating-state";

const POLL: Duration = Duration::from_secs(2);
const CALENDAR_REFRESH: Duration = Duration::from_secs(300);
const AUTO_STOP_GRACE: Duration = Duration::from_secs(20);
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a call prompt stays up before it hides itself.
const PROMPT_TTL_SECS: i64 = 60;
/// How long the "Saved" card stays up.
const SAVED_TTL_SECS: i64 = 10;
/// Calendar prompt: from this long before the start…
const CAL_LEAD_SECS: i64 = 75;
/// …until this long after it.
const CAL_LATE_SECS: i64 = 120;
/// A detected call within this many minutes of a calendar event takes its title.
const EVENT_MATCH_MIN: i64 = 15;

// ── State shared with the floating page (see src/lib/aiwah/api.ts) ────────────

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FloatingState {
    /// "hidden" | "prompt" | "starting" | "recording" | "saved"
    pub mode: String,
    /// prompt only: "calendar" | "adhoc"
    pub kind: Option<String>,
    pub headline: Option<String>,
    pub platform: Option<String>,
    pub platform_label: Option<String>,
    pub app_name: Option<String>,
    pub title: Option<String>,
    pub starts_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub meeting_url: Option<String>,
    pub attendee_count: usize,
    /// "manual" | "prompt" | "calendar"
    pub source: Option<String>,
    pub consent_reminder: bool,
    pub meeting_id: Option<String>,
}

impl FloatingState {
    fn hidden() -> Self {
        Self { mode: "hidden".into(), ..Default::default() }
    }
}

/// What the current prompt is about, so its buttons know what to record.
#[derive(Debug, Clone)]
struct Prompt {
    call: Option<DetectedCall>,
    event: Option<CalendarEvent>,
    platform: CallPlatform,
}

static STATE: Mutex<Option<FloatingState>> = Mutex::new(None);
static PROMPT: Mutex<Option<Prompt>> = Mutex::new(None);
/// Apps the user said "Not now" to; cleared when the app releases the mic.
static DISMISSED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Calendar events that already had their prompt.
static PROMPTED_EVENTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static STARTING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
static SHOW_PILL: AtomicBool = AtomicBool::new(true);
static CONSENT_REMINDER: AtomicBool = AtomicBool::new(true);
static WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);
static CALENDAR_DIRTY: AtomicBool = AtomicBool::new(false);

fn set_contains(m: &Mutex<Option<HashSet<String>>>, id: &str) -> bool {
    m.lock().ok().and_then(|g| g.as_ref().map(|s| s.contains(id))).unwrap_or(false)
}

fn set_insert(m: &Mutex<Option<HashSet<String>>>, id: &str) {
    if let Ok(mut g) = m.lock() {
        g.get_or_insert_with(HashSet::new).insert(id.to_string());
    }
}

fn retain_dismissed(active: &HashSet<String>) {
    if let Ok(mut g) = DISMISSED.lock() {
        if let Some(s) = g.as_mut() {
            s.retain(|id| active.contains(id));
        }
    }
}

pub fn floating_state() -> FloatingState {
    STATE.lock().ok().and_then(|g| g.clone()).unwrap_or_else(FloatingState::hidden)
}

fn take_prompt() -> Option<Prompt> {
    PROMPT.lock().ok().and_then(|mut g| g.take())
}

fn set_prompt(p: Option<Prompt>) {
    if let Ok(mut g) = PROMPT.lock() {
        *g = p;
    }
}

/// Re-read Google Calendar on the next tick (after signing in or out).
pub fn invalidate_calendar() {
    CALENDAR_DIRTY.store(true, Ordering::SeqCst);
}

fn main_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// Store and broadcast the state (only when it changed) and show/hide the window.
fn set_state<R: Runtime>(app: &AppHandle<R>, state: FloatingState) {
    let changed = match STATE.lock() {
        Ok(mut g) => {
            let changed = g.as_ref() != Some(&state);
            *g = Some(state.clone());
            changed
        }
        Err(_) => true,
    };
    if changed {
        let _ = app.emit(STATE_EVENT, &state);
    }
    apply_visibility(app, &state);
}

fn apply_visibility<R: Runtime>(app: &AppHandle<R>, state: &FloatingState) {
    let want = match state.mode.as_str() {
        "prompt" => true,
        // The pill is for when you are in the call app, not looking at Aiwah Minutes.
        "starting" | "recording" => SHOW_PILL.load(Ordering::SeqCst) && !main_window_focused(app),
        "saved" => !main_window_focused(app),
        _ => false,
    };
    if want == WINDOW_SHOWN.load(Ordering::SeqCst) {
        // AIWAH: the OS can drop a window below others (a new full-screen or topmost window,
        // another desktop/Space). While the pop-up should be up, re-assert it every tick.
        if want {
            if let Some(w) = app.get_webview_window(FLOATING_LABEL) {
                let _ = w.set_always_on_top(true);
                // set_always_on_top resets the window level, so pin again after it.
                pin_to_all_spaces(app);
            }
        }
        return;
    }
    if let Some(w) = app.get_webview_window(FLOATING_LABEL) {
        let ok = if want {
            let _ = w.set_always_on_top(true);
            // Follow the screen the user is on (the call may be on a second display).
            place_on_active_monitor(&w);
            let shown = w.show().is_ok();
            // set_always_on_top resets the window level, so pin again after it.
            pin_to_all_spaces(app);
            shown
        } else {
            w.hide().is_ok()
        };
        if ok {
            WINDOW_SHOWN.store(want, Ordering::SeqCst);
        }
    }
}

// ── The window ────────────────────────────────────────────────────────────────

/// Create the (hidden) pop-up window. Call once from `setup` (main thread).
pub fn create_floating_window<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(FLOATING_LABEL).is_some() {
        return;
    }
    let built = WebviewWindowBuilder::new(app, FLOATING_LABEL, WebviewUrl::App("floating".into()))
        .title("Aiwah Minutes")
        .inner_size(376.0, 140.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // Follow you across desktops / Spaces instead of staying on the one it opened on.
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        // Clicks work, but the call app keeps keyboard focus.
        .focusable(false)
        .shadow(false)
        .visible(false)
        .build();
    match built {
        Ok(_) => {
            resize_floating(app, 376.0, 140.0);
            pin_to_all_spaces(app);
        }
        Err(e) => log::warn!("Could not create the call pop-up window: {}", e),
    }
}

/// Size the window to its content (CSS px), pinned to the top-right of the screen the
/// user is on (the one under the mouse; the primary screen if that is unknown).
pub fn resize_floating<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let Some(w) = app.get_webview_window(FLOATING_LABEL) else { return };
    let monitor = active_monitor(&w);
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or_else(|| w.scale_factor().unwrap_or(1.0));
    let pw = (width.clamp(48.0, 640.0) * scale).round() as i32;
    let ph = (height.clamp(32.0, 480.0) * scale).round() as i32;
    let _ = w.set_size(PhysicalSize::new(pw as u32, ph as u32));
    place(&w, monitor.as_ref(), pw);
}

/// Re-pin the window to the top-right of the screen the user is on, keeping its size.
fn place_on_active_monitor<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let pw = w.outer_size().map(|s| s.width as i32).unwrap_or(0);
    let monitor = active_monitor(w);
    place(w, monitor.as_ref(), pw);
}

/// The monitor under the mouse cursor, else the primary one, else the window's own.
fn active_monitor<R: Runtime>(w: &tauri::WebviewWindow<R>) -> Option<tauri::Monitor> {
    if let (Ok(cursor), Ok(monitors)) = (w.cursor_position(), w.available_monitors()) {
        for m in monitors {
            let (pos, size) = (m.position(), m.size());
            let inside = cursor.x >= pos.x as f64
                && cursor.x < pos.x as f64 + size.width as f64
                && cursor.y >= pos.y as f64
                && cursor.y < pos.y as f64 + size.height as f64;
            if inside {
                return Some(m);
            }
        }
    }
    w.primary_monitor().ok().flatten().or_else(|| w.current_monitor().ok().flatten())
}

fn place<R: Runtime>(w: &tauri::WebviewWindow<R>, monitor: Option<&tauri::Monitor>, pw: i32) {
    let scale = monitor.map(|m| m.scale_factor()).unwrap_or_else(|| w.scale_factor().unwrap_or(1.0));
    let margin = (12.0 * scale) as i32;
    // macOS menu bar sits at the top; Windows' taskbar is usually at the bottom.
    let top_inset = if cfg!(target_os = "macos") { (34.0 * scale) as i32 } else { margin };
    let (x, y) = match monitor {
        Some(m) => {
            let pos = m.position();
            let size = m.size();
            (pos.x + size.width as i32 - pw - margin, pos.y + top_inset)
        }
        None => (margin, top_inset),
    };
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// macOS: show the pop-up on every Space and over other apps' full-screen windows.
///
/// A plain window never appears over another app's full-screen Space, whatever its level or
/// collection behaviour. A non-activating `NSPanel` does, so the (tao) window is switched to
/// an `NSPanel` subclass once, the same way the tauri-nspanel plugin does it. The panel never
/// becomes key or main, so the call app keeps focus. Safe to call repeatedly. No-op elsewhere.
#[cfg(target_os = "macos")]
fn pin_to_all_spaces<R: Runtime>(app: &AppHandle<R>) {
    use objc::declare::ClassDecl;
    use objc::runtime::{object_getClass, Class, Object, Sel, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};

    extern "C" {
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
    }
    extern "C" fn never(_: &Object, _: Sel) -> BOOL {
        NO
    }

    // NSWindowCollectionBehavior: CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary
    const BEHAVIOR: u64 = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
    // NSWindowStyleMaskNonactivatingPanel
    const NONACTIVATING: u64 = 1 << 7;
    // NSStatusWindowLevel: above full-screen app windows.
    const LEVEL: i64 = 25;
    const CLASS_NAME: &str = "AiwahFloatingPanel";

    let Some(w) = app.get_webview_window(FLOATING_LABEL) else { return };
    let _ = app.run_on_main_thread(move || {
        let Ok(ptr) = w.ns_window() else { return };
        let ns = ptr as *mut Object;
        unsafe {
            let panel_class: *const Class = match Class::get(CLASS_NAME) {
                Some(c) => c as *const Class,
                None => match ClassDecl::new(CLASS_NAME, class!(NSPanel)) {
                    Some(mut decl) => {
                        decl.add_method(sel!(canBecomeKeyWindow), never as extern "C" fn(&Object, Sel) -> BOOL);
                        decl.add_method(sel!(canBecomeMainWindow), never as extern "C" fn(&Object, Sel) -> BOOL);
                        decl.register() as *const Class
                    }
                    None => {
                        log::warn!("Could not create the call pop-up panel class");
                        return;
                    }
                },
            };
            if object_getClass(ns) != panel_class {
                object_setClass(ns, panel_class);
            }
            let mask: u64 = msg_send![ns, styleMask];
            let _: () = msg_send![ns, setStyleMask: mask | NONACTIVATING];
            let _: () = msg_send![ns, setFloatingPanel: YES];
            // NSPanel hides itself when the app is not active, which is always the case here.
            let _: () = msg_send![ns, setHidesOnDeactivate: NO];
            let _: () = msg_send![ns, setBecomesKeyOnlyIfNeeded: YES];
            let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
            let _: () = msg_send![ns, setLevel: LEVEL];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn pin_to_all_spaces<R: Runtime>(_app: &AppHandle<R>) {}

// ── Start / stop ──────────────────────────────────────────────────────────────

fn default_title(platform: CallPlatform) -> String {
    let when = Local::now().format("%d %b %H:%M");
    match platform {
        CallPlatform::Other => format!("Call {}", when),
        CallPlatform::Slack => format!("Slack huddle {}", when),
        p => format!("{} call {}", p.label(), when),
    }
}

/// Start recording through the main window's normal start path.
pub fn start_recording<R: Runtime>(app: &AppHandle<R>, mut ctx: RecordingContext) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window is not available")?;
    let title = ctx.title.clone().unwrap_or_else(|| default_title(ctx.platform));
    ctx.title = Some(title.clone());
    let title_js = serde_json::to_string(&title).map_err(|e| e.to_string())?;
    meta::set_current(ctx.clone());
    window
        .eval(&format!(
            "sessionStorage.setItem('aiwahMeetingTitle', {}); sessionStorage.setItem('autoStartRecording', 'true'); window.location.assign('/');",
            title_js
        ))
        .map_err(|e| format!("Could not start recording: {}", e))?;
    if let Ok(mut g) = STARTING_SINCE.lock() {
        *g = Some(Instant::now());
    }
    log::info!("Starting recording ({} via {})", ctx.platform.as_str(), ctx.source);
    set_state(app, recording_state("starting", &ctx));
    Ok(())
}

fn recording_state(mode: &str, ctx: &RecordingContext) -> FloatingState {
    FloatingState {
        mode: mode.into(),
        platform: Some(ctx.platform.as_str().to_string()),
        platform_label: Some(ctx.platform.label().to_string()),
        app_name: ctx.app_name.clone(),
        title: ctx.title.clone(),
        started_at: Some(ctx.started_at),
        source: Some(ctx.source.to_string()),
        consent_reminder: CONSENT_REMINDER.load(Ordering::SeqCst),
        ..Default::default()
    }
}

fn event_platform(event: Option<&CalendarEvent>) -> Option<CallPlatform> {
    event.and_then(|e| e.meeting_url.as_deref()).and_then(platform::platform_from_url)
}

fn ctx_for(prompt: &Prompt, source: &'static str) -> RecordingContext {
    RecordingContext {
        platform: prompt.platform,
        app_name: prompt.call.as_ref().map(|c| c.app_name.clone()),
        app_id: prompt.call.as_ref().map(|c| c.app_id.clone()),
        source,
        event: prompt.event.clone(),
        title: prompt.event.as_ref().map(|e| e.title.clone()),
        started_at: Utc::now(),
    }
}

fn manual_ctx() -> RecordingContext {
    RecordingContext {
        platform: CallPlatform::Other,
        app_name: None,
        app_id: None,
        source: "manual",
        event: None,
        title: None,
        started_at: Utc::now(),
    }
}

/// Buttons in the pop-up / pill.
pub async fn floating_action<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<(), String> {
    match action {
        "record" | "join" => {
            if crate::audio::recording_commands::is_recording().await {
                return Ok(());
            }
            let prompt = take_prompt();
            if action == "join" {
                if let Some(url) = prompt.as_ref().and_then(|p| p.event.as_ref()).and_then(|e| e.meeting_url.clone()) {
                    if let Err(e) = open::that(&url) {
                        log::warn!("Could not open the meeting link: {}", e);
                    }
                }
            }
            if let Some(ev) = prompt.as_ref().and_then(|p| p.event.as_ref()) {
                set_insert(&PROMPTED_EVENTS, &ev.id);
            }
            let ctx = match prompt.as_ref() {
                Some(p) => ctx_for(p, if p.call.is_some() { "prompt" } else { "calendar" }),
                None => manual_ctx(),
            };
            start_recording(app, ctx)
        }
        "dismiss" => {
            if let Some(p) = take_prompt() {
                if let Some(call) = p.call {
                    set_insert(&DISMISSED, &call.app_id);
                }
                if let Some(ev) = p.event {
                    set_insert(&PROMPTED_EVENTS, &ev.id);
                }
            }
            set_state(app, FloatingState::hidden());
            Ok(())
        }
        "mute_app" => {
            let prompt = take_prompt();
            let name = prompt.as_ref().map(|p| match &p.call {
                Some(c) if p.platform == CallPlatform::Other => c.app_name.clone(),
                _ => p.platform.label().to_string(),
            });
            if let (Some(name), Some(state)) = (name, app.try_state::<AppState>()) {
                let pool = state.db_manager.pool();
                let mut s = settings::load(pool).await;
                if !s.is_app_excluded(&name, &name) {
                    s.excluded_apps = if s.excluded_apps.trim().is_empty() {
                        name.clone()
                    } else {
                        format!("{}, {}", s.excluded_apps.trim().trim_end_matches(','), name)
                    };
                    settings::save(pool, &s).await?;
                    log::info!("Calls from {} will no longer prompt", name);
                }
            }
            if let Some(call) = prompt.and_then(|p| p.call) {
                set_insert(&DISMISSED, &call.app_id);
            }
            set_state(app, FloatingState::hidden());
            Ok(())
        }
        "stop" => {
            if crate::audio::recording_commands::is_recording().await {
                crate::tray::stop_recording_handler(app);
            }
            Ok(())
        }
        "open" => {
            crate::tray::focus_main_window(app);
            Ok(())
        }
        "open_meeting" => {
            let id = floating_state().meeting_id;
            crate::tray::focus_main_window(app);
            if let (Some(id), Some(w)) = (id, app.get_webview_window("main")) {
                let url = serde_json::to_string(&format!("/meeting-details?id={}", id)).unwrap_or_default();
                let _ = w.eval(&format!("window.location.assign({})", url));
            }
            set_state(app, FloatingState::hidden());
            Ok(())
        }
        other => Err(format!("Unknown action: {}", other)),
    }
}

/// Called when a meeting has been saved: show "Saved · Open notes" briefly.
pub fn on_meeting_saved<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, title: Option<String>) {
    let mode = floating_state().mode;
    if mode == "prompt" {
        return; // never cover a live question with a receipt
    }
    set_state(
        app,
        FloatingState {
            mode: "saved".into(),
            title,
            meeting_id: Some(meeting_id.to_string()),
            expires_at: Some(Utc::now() + chrono::Duration::seconds(SAVED_TTL_SECS)),
            ..Default::default()
        },
    );
}

// ── Watcher loop ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct Watch {
    events: Vec<CalendarEvent>,
    events_at: Option<Instant>,
    calendar_warned: bool,
    auto_started: HashSet<String>,
    absent_since: Option<Instant>,
    was_recording: bool,
    recording_app: Option<String>,
}

fn is_browser_or_unknown(call: &DetectedCall) -> bool {
    if call.app_id == "unknown" {
        return true;
    }
    let n = format!("{} {}", call.app_name, call.app_id).to_lowercase();
    ["chrome", "msedge", "edge", "firefox", "brave", "opera", "arc", "safari", "vivaldi"].iter().any(|b| n.contains(b))
}

/// Granola-style headline for a detected call.
fn headline_for(platform: CallPlatform, call: &DetectedCall) -> &'static str {
    match platform {
        CallPlatform::Slack => "Huddle detected",
        CallPlatform::WhatsApp => "Call detected",
        CallPlatform::GoogleMeet | CallPlatform::Zoom | CallPlatform::Teams => "Meeting detected",
        CallPlatform::Other if is_browser_or_unknown(call) => "Meeting detected",
        CallPlatform::Other => "Call detected",
    }
}

/// A calendar event near now (for naming a detected call).
fn event_near<'a>(events: &'a [CalendarEvent], now: DateTime<Utc>, s: &AutoRecSettings) -> Option<&'a CalendarEvent> {
    let slack = chrono::Duration::minutes(EVENT_MATCH_MIN);
    events
        .iter()
        .filter(|e| e.start - slack <= now && now <= e.end + chrono::Duration::minutes(5))
        .filter(|e| !s.is_title_excluded(&e.title))
        .min_by_key(|e| (e.start - now).num_seconds().abs())
}

/// True when a calendar event happening now has a title with an excluded word (so a Meet call
/// during "Doctor appointment" is never recorded on its own).
fn excluded_event_now(events: &[CalendarEvent], now: DateTime<Utc>, s: &AutoRecSettings) -> bool {
    let slack = chrono::Duration::minutes(EVENT_MATCH_MIN);
    events
        .iter()
        .any(|e| e.start - slack <= now && now <= e.end + chrono::Duration::minutes(5) && s.is_title_excluded(&e.title))
}

/// The calendar meeting that should get its "starts in 1 min" prompt now, if any.
fn calendar_due<'a>(events: &'a [CalendarEvent], now: DateTime<Utc>, s: &AutoRecSettings) -> Option<&'a CalendarEvent> {
    events
        .iter()
        .filter(|e| {
            let secs = (e.start - now).num_seconds();
            secs <= CAL_LEAD_SECS && secs >= -CAL_LATE_SECS
        })
        .filter(|e| e.meeting_url.is_some() || e.attendees.iter().filter(|a| !a.is_self).count() >= 1)
        .filter(|e| !s.is_title_excluded(&e.title))
        .filter(|e| !set_contains(&PROMPTED_EVENTS, &e.id))
        .min_by_key(|e| e.start)
}

/// Start the watcher. Safe to call once from `setup`.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let mut w = Watch::default();
        let mut cleaned = false;
        loop {
            if let Some(state) = app.try_state::<AppState>() {
                let pool = state.db_manager.pool().clone();
                if !cleaned {
                    meta::cleanup_orphans(&pool).await;
                    cleaned = true;
                }
                tick(&app, &pool, &mut w).await;
            }
            tokio::time::sleep(POLL).await;
        }
    });
}

async fn refresh_calendar(pool: &SqlitePool, w: &mut Watch) {
    if CALENDAR_DIRTY.swap(false, Ordering::SeqCst) {
        w.events_at = None;
    }
    if w.events_at.map(|t| t.elapsed() < CALENDAR_REFRESH).unwrap_or(false) {
        return;
    }
    w.events_at = Some(Instant::now());
    if !calendar::is_connected(pool).await {
        w.events.clear();
        return;
    }
    let now = Utc::now();
    match calendar::upcoming_events(pool, now - chrono::Duration::hours(3), now + chrono::Duration::hours(12)).await {
        Ok(events) => {
            w.events = events;
            w.calendar_warned = false;
        }
        Err(e) => {
            if !w.calendar_warned {
                log::warn!("Google Calendar refresh failed: {}", e);
                w.calendar_warned = true;
            }
        }
    }
}

fn expired(state: &FloatingState, now: DateTime<Utc>) -> bool {
    state.expires_at.map(|t| now >= t).unwrap_or(false)
}

async fn tick<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool, w: &mut Watch) {
    let s = settings::load_cached(pool).await;
    SHOW_PILL.store(s.show_recording_pill, Ordering::SeqCst);
    CONSENT_REMINDER.store(s.consent_reminder, Ordering::SeqCst);
    let now = Utc::now();
    let current = floating_state();
    let recording_now = crate::audio::recording_commands::is_recording().await;

    // Calendar is only needed for prompts, naming and auto-record.
    if s.notify_calendar || s.prompt_on_mic || s.auto_record_calendar || recording_now {
        refresh_calendar(pool, w).await;
    }

    // Nothing to watch: keep only receipts/expiry handling.
    let detection_on = s.prompt_on_mic || s.auto_record_calendar;
    let users: Vec<mic::MicUser> = if detection_on || recording_now {
        tokio::task::spawn_blocking(mic::active_mic_users).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let users: Vec<mic::MicUser> = users.into_iter().filter(|u| !s.is_app_excluded(&u.display_name, &u.app_id)).collect();
    let active: HashSet<String> = users.iter().map(|u| u.app_id.clone()).collect();
    retain_dismissed(&active);
    let detected: Option<DetectedCall> = if users.is_empty() {
        None
    } else {
        let u = users.clone();
        tokio::task::spawn_blocking(move || platform::detect_call(&u)).await.ok().flatten()
    };
    let near_event = event_near(&w.events, now, &s).cloned();

    // ── While recording: keep the pill in sync, auto-stop when the call ends ──
    if recording_now {
        if let Ok(mut g) = STARTING_SINCE.lock() {
            *g = None;
        }
        if meta::current().is_none() {
            // Started from the app itself: remember what call it is, for folders and HQ.
            let mut ctx = manual_ctx();
            if let Some(call) = &detected {
                ctx.platform = match call.platform {
                    CallPlatform::Other => event_platform(near_event.as_ref()).unwrap_or(CallPlatform::Other),
                    p => p,
                };
                ctx.app_name = Some(call.app_name.clone());
                ctx.app_id = Some(call.app_id.clone());
            } else if let Some(p) = event_platform(near_event.as_ref()) {
                ctx.platform = p;
            }
            ctx.event = near_event.clone();
            meta::set_current(ctx);
        } else {
            meta::update_current(|ctx| {
                if ctx.platform == CallPlatform::Other {
                    if let Some(call) = &detected {
                        if call.platform != CallPlatform::Other {
                            ctx.platform = call.platform;
                            ctx.app_name = Some(call.app_name.clone());
                            ctx.app_id = Some(call.app_id.clone());
                        }
                    }
                }
                if ctx.event.is_none() {
                    ctx.event = near_event.clone();
                }
            });
        }
        let Some(ctx) = meta::current() else { return };
        w.was_recording = true;
        w.recording_app = ctx.app_id.clone();
        if let Some(ev) = &ctx.event {
            set_insert(&PROMPTED_EVENTS, &ev.id);
        }

        // Stop when the call app releases the microphone (only for recordings started
        // for a detected app, and only where per-app mic state is known).
        let auto = s.auto_stop && ctx.source != "manual";
        match ctx.app_id.as_deref().filter(|id| *id != "unknown") {
            Some(id) if auto => {
                if active.contains(id) {
                    w.absent_since = None;
                } else {
                    let since = *w.absent_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= AUTO_STOP_GRACE {
                        log::info!("Call app released the microphone; stopping the recording");
                        w.absent_since = None;
                        crate::tray::stop_recording_handler(app);
                    }
                }
            }
            _ => w.absent_since = None,
        }
        if current.mode != "saved" {
            set_state(app, recording_state("recording", &ctx));
        } else {
            apply_visibility(app, &current);
        }
        return;
    }

    if w.was_recording {
        // Recording just ended. If the call app is still on the mic (stopped by hand),
        // don't ask again for this call.
        w.was_recording = false;
        w.absent_since = None;
        if let Some(id) = w.recording_app.take() {
            if active.contains(&id) {
                set_insert(&DISMISSED, &id);
            }
        }
        if current.mode == "recording" || current.mode == "starting" {
            set_state(app, FloatingState::hidden());
        }
    }

    // Waiting for the main window to start a recording.
    let starting = STARTING_SINCE.lock().ok().and_then(|g| *g);
    if let Some(t) = starting {
        if t.elapsed() < START_TIMEOUT {
            apply_visibility(app, &current);
            return;
        }
        log::warn!("Recording did not start (is the transcription model ready and onboarding finished?)");
        if let Ok(mut g) = STARTING_SINCE.lock() {
            *g = None;
        }
        set_state(app, FloatingState::hidden());
        return;
    }

    // Receipts and prompts hide themselves.
    if (current.mode == "saved" || current.mode == "prompt") && expired(&current, now) {
        if current.mode == "prompt" {
            if let Some(p) = take_prompt() {
                if let Some(call) = p.call {
                    set_insert(&DISMISSED, &call.app_id);
                }
                if let Some(ev) = p.event {
                    set_insert(&PROMPTED_EVENTS, &ev.id);
                }
            }
        }
        set_state(app, FloatingState::hidden());
        return;
    }
    if current.mode == "saved" {
        apply_visibility(app, &current);
        return;
    }

    // ── A call is happening (microphone in use) ──
    if let Some(call) = detected.as_ref().filter(|c| !set_contains(&DISMISSED, &c.app_id)) {
        let platform = match call.platform {
            CallPlatform::Other => event_platform(near_event.as_ref()).unwrap_or(CallPlatform::Other),
            p => p,
        };

        // AIWAH: a Google Meet call while a company Google account is signed in is recorded
        // without asking (the calendar event is optional; it only supplies title and guests).
        // Skipped for excluded apps (filtered earlier) and calendar titles with an excluded word.
        let on_meet = call.platform == CallPlatform::GoogleMeet
            || (event_platform(near_event.as_ref()) == Some(CallPlatform::GoogleMeet) && is_browser_or_unknown(call));
        if s.auto_record_meet && on_meet && !excluded_event_now(&w.events, now, &s) && calendar::is_signed_in(pool).await {
            let key = match near_event.as_ref() {
                Some(ev) => ev.id.clone(),
                None => format!("meet:{}", call.window_title.clone().unwrap_or_else(|| call.app_id.clone())),
            };
            if !w.auto_started.contains(&key) {
                w.auto_started.insert(key);
                let prompt = Prompt { call: Some(call.clone()), event: near_event.clone(), platform: CallPlatform::GoogleMeet };
                set_prompt(None);
                if let Some(ev) = near_event.as_ref() {
                    set_insert(&PROMPTED_EVENTS, &ev.id);
                }
                match start_recording(app, ctx_for(&prompt, "calendar")) {
                    Ok(()) => return,
                    Err(e) => log::warn!("Auto-record of Google Meet failed to start: {}", e),
                }
            }
        }

        // Opt-in: record Google Meet calendar meetings without asking.
        if s.auto_record_calendar {
            if let Some(ev) = near_event.as_ref() {
                let meet_event = event_platform(Some(ev)) == Some(CallPlatform::GoogleMeet);
                let meet_call = call.platform == CallPlatform::GoogleMeet || is_browser_or_unknown(call);
                if meet_event && meet_call && !w.auto_started.contains(&ev.id) {
                    w.auto_started.insert(ev.id.clone());
                    let prompt = Prompt { call: Some(call.clone()), event: Some(ev.clone()), platform: CallPlatform::GoogleMeet };
                    set_prompt(None);
                    set_insert(&PROMPTED_EVENTS, &ev.id);
                    if let Err(e) = start_recording(app, ctx_for(&prompt, "calendar")) {
                        log::warn!("Auto-record failed to start: {}", e);
                    }
                    return;
                }
            }
        }

        if s.prompt_on_mic {
            // Keep an existing ad-hoc prompt for the same app (and its countdown).
            let same = current.mode == "prompt"
                && current.kind.as_deref() == Some("adhoc")
                && PROMPT.lock().ok().and_then(|g| g.as_ref().and_then(|p| p.call.as_ref().map(|c| c.app_id == call.app_id))).unwrap_or(false);
            if !same {
                let prompt = Prompt { call: Some(call.clone()), event: near_event.clone(), platform };
                set_prompt(Some(prompt));
                set_state(
                    app,
                    FloatingState {
                        mode: "prompt".into(),
                        kind: Some("adhoc".into()),
                        headline: Some(headline_for(platform, call).to_string()),
                        platform: Some(platform.as_str().to_string()),
                        platform_label: Some(platform.label().to_string()),
                        app_name: Some(call.app_name.clone()),
                        title: near_event.as_ref().map(|e| e.title.clone()),
                        starts_at: near_event.as_ref().map(|e| e.start),
                        expires_at: Some(now + chrono::Duration::seconds(PROMPT_TTL_SECS)),
                        meeting_url: near_event.as_ref().and_then(|e| e.meeting_url.clone()),
                        attendee_count: near_event.as_ref().map(|e| e.attendees.len()).unwrap_or(0),
                        consent_reminder: s.consent_reminder,
                        ..Default::default()
                    },
                );
            }
            return;
        }
    } else if current.mode == "prompt" && current.kind.as_deref() == Some("adhoc") {
        // The call app let go of the microphone before anyone answered.
        set_prompt(None);
        set_state(app, FloatingState::hidden());
        return;
    }

    // ── A calendar meeting is about to start ──
    if s.notify_calendar && current.mode != "prompt" {
        if let Some(ev) = calendar_due(&w.events, now, &s) {
            let platform = event_platform(Some(ev)).unwrap_or(CallPlatform::Other);
            let secs = (ev.start - now).num_seconds();
            let headline = if secs > 30 { "Meeting starts in 1 min" } else { "Meeting starting now" };
            set_insert(&PROMPTED_EVENTS, &ev.id);
            set_prompt(Some(Prompt { call: None, event: Some(ev.clone()), platform }));
            set_state(
                app,
                FloatingState {
                    mode: "prompt".into(),
                    kind: Some("calendar".into()),
                    headline: Some(headline.into()),
                    platform: Some(platform.as_str().to_string()),
                    platform_label: Some(platform.label().to_string()),
                    title: Some(ev.title.clone()),
                    starts_at: Some(ev.start),
                    expires_at: Some(now + chrono::Duration::seconds(CAL_LEAD_SECS + CAL_LATE_SECS)),
                    meeting_url: ev.meeting_url.clone(),
                    attendee_count: ev.attendees.len(),
                    consent_reminder: s.consent_reminder,
                    ..Default::default()
                },
            );
            return;
        }
    }

    if current.mode != "prompt" && current.mode != "hidden" {
        set_state(app, FloatingState::hidden());
    } else {
        apply_visibility(app, &current);
    }
}

/// AIWAH: "Join & record" on a calendar event in the app (Home / Calendar). Records with the
/// event's title, guests and platform, the same as when the 1-minute pop-up is accepted.
pub async fn record_event<R: Runtime>(app: &AppHandle<R>, pool: &sqlx::SqlitePool, event_id: &str) -> Result<(), String> {
    let now = Utc::now();
    let events = calendar::upcoming_events(pool, now - chrono::Duration::hours(6), now + chrono::Duration::days(31)).await?;
    let event = events
        .into_iter()
        .find(|e| e.id == event_id)
        .ok_or_else(|| "That calendar event was not found. Refresh the calendar and try again.".to_string())?;
    set_insert(&PROMPTED_EVENTS, &event.id);
    let platform = event
        .meeting_url
        .as_deref()
        .and_then(platform::platform_from_url)
        .unwrap_or(CallPlatform::Other);
    let ctx = RecordingContext {
        platform,
        app_name: None,
        app_id: None,
        source: "calendar",
        title: Some(event.title.clone()),
        event: Some(event),
        started_at: Utc::now(),
    };
    start_recording(app, ctx)
}
