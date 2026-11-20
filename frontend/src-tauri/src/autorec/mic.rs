//! AIWAH: microphone usage detection.
//!
//! Windows: reads the CapabilityAccessManager consent store in HKCU, which Windows maintains for
//! every app that opens the mic (`LastUsedTimeStart` set, `LastUsedTimeStop` == 0 while in use).
//! macOS: only a global "some process is capturing" signal is available (CoreAudio).

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicUser {
    /// Stable id: Win32 exe full path, or Store package family name, or macOS bundle id / "unknown".
    pub app_id: String,
    /// Short human name, e.g. "slack.exe", "WhatsApp", "chrome.exe".
    pub display_name: String,
    /// Lowercased exe file name if known, e.g. "slack.exe" (None for packaged apps / unknown).
    pub exe_name: Option<String>,
    pub packaged: bool,
}

/// Apps currently using the microphone, excluding this process. Cheap; called every ~2 s from a blocking thread.
pub fn active_mic_users() -> Vec<MicUser> {
    #[cfg(target_os = "windows")]
    {
        win::active_mic_users()
    }
    #[cfg(target_os = "macos")]
    {
        if mic_in_use_anywhere() {
            vec![MicUser {
                app_id: "unknown".to_string(),
                display_name: "Unknown app".to_string(),
                exe_name: None,
                packaged: false,
            }]
        } else {
            vec![]
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        vec![]
    }
}

/// True if ANY process (including us) is capturing from the mic. Used on macOS where per-app info is unavailable.
pub fn mic_in_use_anywhere() -> bool {
    #[cfg(target_os = "windows")]
    {
        !active_mic_users().is_empty()
    }
    #[cfg(target_os = "macos")]
    {
        mac::mic_in_use_anywhere()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

/// Friendly name for a Store package family name, e.g. `5319275A.WhatsAppDesktop_cv1g1gvanyjgm`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn friendly_package_name(family: &str) -> String {
    let lower = family.to_lowercase();
    let table: &[(&str, &str)] = &[
        ("whatsapp", "WhatsApp"),
        ("msteams", "Microsoft Teams"),
        ("microsoftteams", "Microsoft Teams"),
        ("zoom", "Zoom"),
        ("slack", "Slack"),
        ("skype", "Skype"),
        ("discord", "Discord"),
        ("telegram", "Telegram"),
        ("signal", "Signal"),
    ];
    for (needle, name) in table {
        if lower.contains(needle) {
            return (*name).to_string();
        }
    }
    family.split('_').next().unwrap_or(family).to_string()
}

/// Decode a `NonPackaged` subkey name (path with `\` replaced by `#`) back into a path.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn decode_nonpackaged(key: &str) -> String {
    key.replace('#', "\\")
}

/// Lowercased file name of a Windows path.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn exe_file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase()
}

/// True for exes that are this app (so we never detect ourselves).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_self_exe_name(file_name_lower: &str) -> bool {
    file_name_lower.contains("aiwah minutes")
        || file_name_lower == "meetily.exe"
        || file_name_lower == "aiwah-minutes.exe"
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const BASE: &str =
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn in_use(key: &RegKey) -> bool {
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(0);
        start > 0 && stop == 0
    }

    pub fn active_mic_users() -> Vec<MicUser> {
        let mut out = Vec::new();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let base = match hkcu.open_subkey(BASE) {
            Ok(k) => k,
            Err(_) => return out,
        };
        let own_exe = std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().to_lowercase());

        for name in base.enum_keys().flatten() {
            if name.eq_ignore_ascii_case("NonPackaged") {
                let np = match base.open_subkey("NonPackaged") {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                for sub in np.enum_keys().flatten() {
                    let Ok(k) = np.open_subkey(&sub) else { continue };
                    if !in_use(&k) {
                        continue;
                    }
                    let path = decode_nonpackaged(&sub);
                    let file = exe_file_name(&path);
                    if own_exe.as_deref() == Some(path.to_lowercase().as_str())
                        || is_self_exe_name(&file)
                    {
                        continue;
                    }
                    out.push(MicUser {
                        app_id: path,
                        display_name: file.clone(),
                        exe_name: Some(file),
                        packaged: false,
                    });
                }
            } else {
                let Ok(k) = base.open_subkey(&name) else { continue };
                if !in_use(&k) {
                    continue;
                }
                out.push(MicUser {
                    display_name: friendly_package_name(&name),
                    app_id: name,
                    exe_name: None,
                    packaged: true,
                });
            }
        }
        out
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            in_object_id: u32,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> i32;
    }

    const SYSTEM_OBJECT: u32 = 1; // kAudioObjectSystemObject
    const DEFAULT_INPUT_DEVICE: u32 = 0x6449_6E20; // 'dIn '
    const DEVICE_IS_RUNNING_SOMEWHERE: u32 = 0x676F_6E65; // 'gone'
    const SCOPE_GLOBAL: u32 = 0x676C_6F62; // 'glob'

    pub fn mic_in_use_anywhere() -> bool {
        unsafe {
            let addr = AudioObjectPropertyAddress {
                selector: DEFAULT_INPUT_DEVICE,
                scope: SCOPE_GLOBAL,
                element: 0,
            };
            let mut device: u32 = 0;
            let mut size: u32 = std::mem::size_of::<u32>() as u32;
            let status = AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut device as *mut u32 as *mut c_void,
            );
            if status != 0 || device == 0 {
                return false;
            }

            let addr = AudioObjectPropertyAddress {
                selector: DEVICE_IS_RUNNING_SOMEWHERE,
                scope: SCOPE_GLOBAL,
                element: 0,
            };
            let mut running: u32 = 0;
            let mut size: u32 = std::mem::size_of::<u32>() as u32;
            let status = AudioObjectGetPropertyData(
                device,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut running as *mut u32 as *mut c_void,
            );
            status == 0 && running != 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths_and_names() {
        let p = decode_nonpackaged("C:#Users#a#AppData#Local#slack#slack.exe");
        assert_eq!(p, r"C:\Users\a\AppData\Local\slack\slack.exe");
        assert_eq!(exe_file_name(&p), "slack.exe");
        assert!(is_self_exe_name("meetily.exe"));
        assert!(is_self_exe_name("aiwah minutes.exe"));
        assert!(!is_self_exe_name("zoom.exe"));
    }

    #[test]
    fn friendly_names() {
        assert_eq!(friendly_package_name("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"), "WhatsApp");
        assert_eq!(friendly_package_name("MSTeams_8wekyb3d8bbwe"), "Microsoft Teams");
        assert_eq!(friendly_package_name("Foo.Bar_abc"), "Foo.Bar");
    }

    #[test]
    #[ignore]
    fn print_live_mic_users() {
        println!("{:#?}", active_mic_users());
    }
}
