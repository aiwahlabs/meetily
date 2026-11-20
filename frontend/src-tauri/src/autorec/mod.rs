//! AIWAH: automatic call detection and recording (Aiwah Minutes fork).
//!
//! - `mic`: which apps are using the microphone right now.
//! - `platform`: map those apps (and browser windows) to a call platform.
//! - `calendar`: Google Calendar sign-in and upcoming events.
//! - `settings`: auto-record and privacy settings.
//! - `meta`: per-meeting platform folder, meeting type and calendar event.
//! - `watcher`: ties the above together, drives the floating button and auto-record.

pub mod calendar;
pub mod commands;
pub mod meta;
pub mod mic;
pub mod platform;
pub mod secrets;
pub mod settings;
pub mod watcher;

/// AIWAH: refuse work that must wait for the company Google sign-in (model downloads).
pub async fn require_signed_in<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Err("Aiwah Minutes is still starting. Try again in a moment.".to_string());
    };
    if calendar::is_signed_in(state.db_manager.pool()).await {
        Ok(())
    } else {
        Err(format!("Sign in with your @{} Google account first.", calendar::ALLOWED_DOMAIN))
    }
}
