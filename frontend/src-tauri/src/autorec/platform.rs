//! AIWAH: call platform detection.
//!
//! Maps apps that currently use the microphone (see `mic`) to a call platform. Dedicated call apps
//! are recognised by exe / package name; browsers are resolved through visible window titles
//! (Windows only; macOS would need Screen Recording permission so we do not try).

use crate::autorec::mic::MicUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallPlatform {
    GoogleMeet,
    Zoom,
    Teams,
    Slack,
    WhatsApp,
    Other,
}

impl CallPlatform {
    pub fn label(&self) -> &'static str {
        match self {
            CallPlatform::GoogleMeet => "Google Meet",
            CallPlatform::Zoom => "Zoom",
            CallPlatform::Teams => "Microsoft Teams",
            CallPlatform::Slack => "Slack",
            CallPlatform::WhatsApp => "WhatsApp",
            CallPlatform::Other => "Other",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            CallPlatform::GoogleMeet => "google_meet",
            CallPlatform::Zoom => "zoom",
            CallPlatform::Teams => "teams",
            CallPlatform::Slack => "slack",
            CallPlatform::WhatsApp => "whatsapp",
            CallPlatform::Other => "other",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> CallPlatform {
        match s {
            "google_meet" => CallPlatform::GoogleMeet,
            "zoom" => CallPlatform::Zoom,
            "teams" => CallPlatform::Teams,
            "slack" => CallPlatform::Slack,
            "whatsapp" => CallPlatform::WhatsApp,
            _ => CallPlatform::Other,
        }
    }

    /// HQ ingest enum: "GOOGLE_MEET" | "ZOOM" | "TEAMS" | "OTHER".
    pub fn hq_platform(&self) -> &'static str {
        match self {
            CallPlatform::GoogleMeet => "GOOGLE_MEET",
            CallPlatform::Zoom => "ZOOM",
            CallPlatform::Teams => "TEAMS",
            _ => "OTHER",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCall {
    pub platform: CallPlatform,
    pub app_name: String,
    pub app_id: String,
    pub window_title: Option<String>,
}

/// Result of classifying an app by its exe name / package family name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppClass {
    /// Dedicated call app.
    Call(CallPlatform),
    /// Browser; the call (if any) must be derived from window titles.
    Browser,
    Unknown,
}

const BROWSER_EXES: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "arc.exe",
];

/// Pure classification by lowercase exe file name and/or package family name.
fn classify_app(exe_name: Option<&str>, package: Option<&str>) -> AppClass {
    let exe = exe_name.map(|s| s.to_lowercase()).unwrap_or_default();
    let pkg = package.map(|s| s.to_lowercase()).unwrap_or_default();

    if exe == "zoom.exe" || pkg.contains("zoom") {
        return AppClass::Call(CallPlatform::Zoom);
    }
    if exe == "ms-teams.exe" || exe == "teams.exe" || pkg.contains("msteams") || pkg.contains("microsoftteams") {
        return AppClass::Call(CallPlatform::Teams);
    }
    if exe == "slack.exe" || pkg.contains("slack") {
        return AppClass::Call(CallPlatform::Slack);
    }
    if exe == "whatsapp.exe" || pkg.contains("whatsapp") {
        return AppClass::Call(CallPlatform::WhatsApp);
    }
    if BROWSER_EXES.contains(&exe.as_str()) {
        return AppClass::Browser;
    }
    AppClass::Unknown
}

/// Classify a browser window title.
fn classify_title(title: &str) -> Option<CallPlatform> {
    let lower = title.to_lowercase();
    if title.contains("Meet - ") || lower.contains("meet.google.com") {
        Some(CallPlatform::GoogleMeet)
    } else if lower.contains("microsoft teams") {
        Some(CallPlatform::Teams)
    } else if lower.contains("zoom") {
        Some(CallPlatform::Zoom)
    } else {
        None
    }
}

fn browser_name(exe: &str) -> String {
    match exe {
        "chrome.exe" => "Chrome",
        "msedge.exe" => "Edge",
        "firefox.exe" => "Firefox",
        "brave.exe" => "Brave",
        "opera.exe" => "Opera",
        "arc.exe" => "Arc",
        other => other,
    }
    .to_string()
}

/// Pick the most likely call from current mic users. None if no mic users.
pub fn detect_call(users: &[MicUser]) -> Option<DetectedCall> {
    if users.is_empty() {
        return None;
    }

    // Lazily enumerated (title, exe) list, only if a browser is using the mic.
    let mut windows: Option<Vec<(String, String)>> = None;
    // (rank, call); lower rank wins, first wins on ties.
    let mut best: Option<(u8, DetectedCall)> = None;

    for u in users {
        let pkg = if u.packaged { Some(u.app_id.as_str()) } else { None };
        let class = classify_app(u.exe_name.as_deref(), pkg);
        let (rank, call) = match class {
            AppClass::Call(p) => (
                0,
                DetectedCall {
                    platform: p,
                    app_name: p.label().to_string(),
                    app_id: u.app_id.clone(),
                    window_title: None,
                },
            ),
            AppClass::Browser => {
                let exe = u.exe_name.clone().unwrap_or_default();
                let w = windows.get_or_insert_with(enumerate_windows);
                let hit = w
                    .iter()
                    .filter(|(_, e)| *e == exe)
                    .find_map(|(t, _)| classify_title(t).map(|p| (p, t.clone())));
                match hit {
                    Some((p, title)) => (
                        1,
                        DetectedCall {
                            platform: p,
                            app_name: p.label().to_string(),
                            app_id: u.app_id.clone(),
                            window_title: Some(title),
                        },
                    ),
                    None => (
                        3,
                        DetectedCall {
                            platform: CallPlatform::Other,
                            app_name: browser_name(&exe),
                            app_id: u.app_id.clone(),
                            window_title: None,
                        },
                    ),
                }
            }
            AppClass::Unknown => (
                2,
                DetectedCall {
                    platform: CallPlatform::Other,
                    app_name: if u.display_name.is_empty() {
                        "Unknown app".to_string()
                    } else {
                        u.display_name.clone()
                    },
                    app_id: u.app_id.clone(),
                    window_title: None,
                },
            ),
        };
        if best.as_ref().map_or(true, |(r, _)| rank < *r) {
            best = Some((rank, call));
        }
    }
    best.map(|(_, c)| c)
}

/// Classify a meeting URL from a calendar event.
pub fn platform_from_url(url: &str) -> Option<CallPlatform> {
    let lower = url.to_lowercase();
    if lower.contains("meet.google.com") {
        Some(CallPlatform::GoogleMeet)
    } else if lower.contains("zoom.us") || lower.contains("zoom.com") {
        Some(CallPlatform::Zoom)
    } else if lower.contains("teams.microsoft.com") || lower.contains("teams.live.com") {
        Some(CallPlatform::Teams)
    } else {
        None
    }
}

/// Top-level visible windows as (title, lowercase exe name). Empty off Windows.
#[cfg(not(target_os = "windows"))]
fn enumerate_windows() -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn enumerate_windows() -> Vec<(String, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut Vec<(String, String)>);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return 1;
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return 1;
        }
        let mut path = [0u16; 1024];
        let mut len: u32 = path.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, path.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return 1;
        }
        let full = String::from_utf16_lossy(&path[..len as usize]);
        let exe = full.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        out.push((title, exe));
        1
    }

    let mut out: Vec<(String, String)> = Vec::new();
    unsafe {
        EnumWindows(Some(cb), &mut out as *mut Vec<(String, String)> as LPARAM);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_classification() {
        assert_eq!(platform_from_url("https://meet.google.com/abc-defg-hij"), Some(CallPlatform::GoogleMeet));
        assert_eq!(platform_from_url("https://us02web.zoom.us/j/123"), Some(CallPlatform::Zoom));
        assert_eq!(platform_from_url("https://teams.microsoft.com/l/meetup-join/x"), Some(CallPlatform::Teams));
        assert_eq!(platform_from_url("https://teams.live.com/meet/1"), Some(CallPlatform::Teams));
        assert_eq!(platform_from_url("https://example.com"), None);
    }

    #[test]
    fn str_round_trip() {
        for p in [
            CallPlatform::GoogleMeet,
            CallPlatform::Zoom,
            CallPlatform::Teams,
            CallPlatform::Slack,
            CallPlatform::WhatsApp,
            CallPlatform::Other,
        ] {
            assert_eq!(CallPlatform::from_str(p.as_str()), p);
        }
        assert_eq!(CallPlatform::from_str("nonsense"), CallPlatform::Other);
        assert_eq!(CallPlatform::Teams.hq_platform(), "TEAMS");
        assert_eq!(CallPlatform::Slack.hq_platform(), "OTHER");
    }

    #[test]
    fn exe_classification() {
        assert_eq!(classify_app(Some("zoom.exe"), None), AppClass::Call(CallPlatform::Zoom));
        assert_eq!(classify_app(Some("ms-teams.exe"), None), AppClass::Call(CallPlatform::Teams));
        assert_eq!(classify_app(Some("slack.exe"), None), AppClass::Call(CallPlatform::Slack));
        assert_eq!(
            classify_app(None, Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm")),
            AppClass::Call(CallPlatform::WhatsApp)
        );
        assert_eq!(
            classify_app(None, Some("MSTeams_8wekyb3d8bbwe")),
            AppClass::Call(CallPlatform::Teams)
        );
        assert_eq!(classify_app(Some("chrome.exe"), None), AppClass::Browser);
        assert_eq!(classify_app(Some("notepad.exe"), None), AppClass::Unknown);
    }

    #[test]
    fn title_classification() {
        assert_eq!(classify_title("Meet - abc-defg-hij - Google Chrome"), Some(CallPlatform::GoogleMeet));
        assert_eq!(classify_title("Zoom Meeting"), Some(CallPlatform::Zoom));
        assert_eq!(classify_title("Chat | Microsoft Teams"), Some(CallPlatform::Teams));
        assert_eq!(classify_title("Inbox - Gmail"), None);
    }

    #[test]
    fn detect_prefers_dedicated_app() {
        let users = vec![
            MicUser { app_id: "x".into(), display_name: "notepad.exe".into(), exe_name: Some("notepad.exe".into()), packaged: false },
            MicUser { app_id: "C:\\z\\zoom.exe".into(), display_name: "zoom.exe".into(), exe_name: Some("zoom.exe".into()), packaged: false },
        ];
        assert_eq!(detect_call(&users).unwrap().platform, CallPlatform::Zoom);
        assert!(detect_call(&[]).is_none());
    }
}
