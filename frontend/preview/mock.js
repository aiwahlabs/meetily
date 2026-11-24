// AIWAH preview: stand-in for the Tauri IPC bridge so the exported UI runs in a normal
// browser with sample data (no native code, no real Google, no recording). Used by
// `pnpm preview` (preview/serve.js), which injects this file into every page.
// Pick a state with ?mock=routing | indic-installed | signedout | onboarding | pop-adhoc | pop-calendar | pop-recording | pop-saved
(() => {
  window.alert = (m) => console.warn("[alert suppressed] " + m);
  const now = Date.now();
  const iso = (mins) => new Date(now + mins * 60000).toISOString();
  const meetings = [
    { id: "m-1", title: "Discovery call — Fayeda Tours", created_at: iso(-60 * 2) },
    { id: "m-2", title: "Introductory Conversation — Asha R", created_at: iso(-60 * 26) },
    { id: "m-3", title: "Slack huddle 19 Nov 16:20", created_at: iso(-60 * 30) },
    { id: "m-4", title: "Weekly product sync", created_at: iso(-60 * 50) },
    { id: "m-5", title: "WhatsApp call 18 Nov 11:02", created_at: iso(-60 * 75) },
    { id: "m-6", title: "CRM demo — 8point", created_at: iso(-60 * 24 * 6) },
  ];
  const meta = [
    { meetingId: "m-1", platform: "google_meet", meetingType: "discovery", source: "calendar", attendees: [] },
    { meetingId: "m-2", platform: "google_meet", meetingType: "hiring", source: "prompt", attendees: [] },
    { meetingId: "m-3", platform: "slack", meetingType: "internal", source: "prompt", attendees: [] },
    { meetingId: "m-4", platform: "google_meet", meetingType: "internal", source: "calendar", attendees: [] },
    { meetingId: "m-5", platform: "whatsapp", meetingType: "client", source: "prompt", attendees: [] },
    { meetingId: "m-6", platform: "zoom", meetingType: "demo", source: "manual", attendees: [] },
  ];
  const events = [
    { id: "e-1", title: "Discovery call — Kerala City Hall", start: iso(25), end: iso(55), meetingUrl: "https://meet.google.com/abc-defg-hij", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "abil@aiwahlabs.com", name: "Abilshan", isSelf: false, response: "accepted", isOrganizer: true }, { email: "anil@keralacity.gov.in", name: "Anil Kumar", isSelf: false, response: "accepted", isOrganizer: false }, { email: "meera@keralacity.gov.in", name: "Meera Nair", isSelf: false, response: "tentative", isOrganizer: false }, { email: "intern@keralacity.gov.in", name: null, isSelf: false, response: "needsAction", isOrganizer: false }] },
    { id: "e-2", title: "Weekly product sync", start: iso(180), end: iso(210), meetingUrl: "https://meet.google.com/xyz-weekly", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "abil@aiwahlabs.com", name: "Abilshan", isSelf: false, response: "accepted", isOrganizer: true }, { email: "asha@aiwahlabs.com", name: "Asha R", isSelf: false, response: "accepted", isOrganizer: false }, { email: "rahul@aiwahlabs.com", name: "Rahul M", isSelf: false, response: "declined", isOrganizer: false }] },
    { id: "e-3", title: "Introductory Conversation — Rahul", start: iso(1560), end: iso(1590), meetingUrl: "https://meet.google.com/rr-intro", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "rahul.v@gmail.com", name: "Rahul Verma", isSelf: false, response: "needsAction", isOrganizer: false }] },
    { id: "e-4", title: "CRM demo — 8point", start: iso(1680), end: iso(1740), meetingUrl: "https://zoom.us/j/123456", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "abil@aiwahlabs.com", name: "Abilshan", isSelf: false, response: "accepted", isOrganizer: true }, { email: "priya@8point.in", name: "Priya S", isSelf: false, response: "accepted", isOrganizer: false }, { email: "vikram@8point.in", name: "Vikram", isSelf: false, response: "accepted", isOrganizer: false }, { email: "sana@8point.in", name: "Sana", isSelf: false, response: "tentative", isOrganizer: false }, { email: "dev@8point.in", name: "Dev", isSelf: false, response: "needsAction", isOrganizer: false }] },
    { id: "e-5", title: "Team standup", start: iso(3000), end: iso(3015), meetingUrl: "https://meet.google.com/stand-up", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "abil@aiwahlabs.com", name: "Abilshan", isSelf: false, response: "accepted", isOrganizer: true }, { email: "asha@aiwahlabs.com", name: "Asha R", isSelf: false, response: "accepted", isOrganizer: false }, { email: "rahul@aiwahlabs.com", name: "Rahul M", isSelf: false, response: "accepted", isOrganizer: false }, { email: "nisha@aiwahlabs.com", name: "Nisha", isSelf: false, response: "accepted", isOrganizer: false }] },
    { id: "e-6", title: "Client review — Fayeda Tours", start: iso(4560), end: iso(4620), meetingUrl: null, attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "hello@fayedatours.com", name: "Fayeda", isSelf: false, response: "accepted", isOrganizer: true }] },
    { id: "e-7", title: "Quarterly planning", start: iso(8640), end: iso(8730), meetingUrl: "https://meet.google.com/plan-q4", attendees: [{ email: "darani@aiwahlabs.com", name: "Darani S", isSelf: true, response: "accepted", isOrganizer: false }, { email: "abil@aiwahlabs.com", name: "Abilshan", isSelf: false, response: "accepted", isOrganizer: true }, { email: "asha@aiwahlabs.com", name: "Asha R", isSelf: false, response: "needsAction", isOrganizer: false }] },
  ];
  const iso2 = iso;
  const signedOut = { signedIn: false, email: null, name: null, picture: null, domainOk: false, hasClientId: true };
  const popBase = { kind: null, headline: null, platform: null, platformLabel: null, appName: null, title: null, startsAt: null, startedAt: null, expiresAt: null, meetingUrl: null, attendeeCount: 0, source: null, consentReminder: true, meetingId: null };
  const PRESETS = {
    signedout: { account: signedOut },
    onboarding: { onboarded: false, account: signedOut },
    "pop-adhoc": { window: "floating", floating: { ...popBase, mode: "prompt", kind: "adhoc", headline: "Huddle detected", platform: "slack", platformLabel: "Slack", appName: "Slack", expiresAt: iso2(1) } },
    "pop-calendar": { window: "floating", floating: { ...popBase, mode: "prompt", kind: "calendar", headline: "Meeting starts in 1 min", platform: "google_meet", platformLabel: "Google Meet", title: "Discovery call — Kerala City Hall", startsAt: iso2(1), expiresAt: iso2(3), meetingUrl: "https://meet.google.com/abc", attendeeCount: 4 } },
    "pop-recording": { window: "floating", floating: { ...popBase, mode: "recording", platform: "google_meet", platformLabel: "Google Meet", appName: "Chrome", title: "Discovery call — Kerala City Hall", startedAt: iso2(-0.4), source: "calendar" } },
    "pop-saved": { window: "floating", floating: { ...popBase, mode: "saved", title: "Discovery call — Kerala City Hall", expiresAt: iso2(0.2), consentReminder: false, meetingId: "m-1" } },
  };
  PRESETS["routing"] = { routing: { meetingId: "m-1", state: "transcribing", language: "ml", engine: "indic", message: "Transcribing in Malayalam…" } };
  PRESETS["indic-installed"] = { indicInstalled: true };
  const preset = new URLSearchParams(location.search).get("mock");
  const state = window.__AIWAH_MOCK_STATE__ || PRESETS[preset] || {};
  const handlers = {
    get_onboarding_status: () => ({ version: "1", completed: state.onboarded !== false, current_step: state.onboarded === false ? 1 : 4, model_status: { parakeet: state.onboarded === false ? "not_downloaded" : "downloaded", summary: "downloaded" }, last_updated: new Date().toISOString() }),
    check_first_launch: () => state.onboarded === false,
    get_audio_devices: () => [{ name: "Microphone (Realtek Audio)", device_type: "Input" }, { name: "Speakers (Realtek Audio)", device_type: "Output" }],
    get_ollama_models: () => [],
    api_get_model_config: () => ({ provider: "builtin-ai", model: "qwen3.5-2b", whisperModel: "", apiKey: null }),
    api_get_api_key: () => "",
    get_recording_preferences: () => ({ save_folder: "C:\Users\me\Music\meetily-recordings", auto_save: true, file_format: "mp4", device_selection_version: [1, 1], preferred_mic_device: null, preferred_system_device: null }),
    get_recording_state: () => ({ is_recording: !!state.recording, is_paused: false, is_active: !!state.recording, recording_duration: state.recording ? 754 : null, active_duration: null, total_pause_duration: 0, current_pause_duration: null }),
    doodle_sync: () => null,
    set_language_preference: () => null,
    parakeet_has_available_models: () => state.onboarded !== false,
    builtin_ai_get_recommended_model: () => "qwen3.5-2b",
    builtin_ai_is_model_ready: () => state.onboarded !== false,
    check_audio_permissions: () => ({ microphone: true, system_audio: true }),
    api_get_meetings: () => meetings,
    autorec_list_meeting_meta: () => meta,
    calendar_get_status: () => ({ connected: true, accountEmail: "darani@aiwahlabs.com", hasClientId: true, clientIdHint: "1234…apps" }),
    calendar_list_events: (a) => events.filter((e) => new Date(e.start).getTime() < Date.now() + ((a && a.hoursAhead) || 24) * 3600000),
    aiwah_account_status: () => state.account ?? { signedIn: true, email: "darani@aiwahlabs.com", name: "Darani", picture: null, domainOk: true },
    autorec_get_settings: () => ({ floatingButton: false, promptOnMic: true, autoRecordCalendar: false, autoRecordMeet: true, autoStop: true, consentReminder: true, deleteAudioAfterSync: false, excludedApps: "", excludedKeywords: "personal, private", startAtLogin: true, notifyCalendar: true, showRecordingPill: true, mutedApps: [], detectLanguage: true, indicLanguages: ["ml", "ta", "hi"] }),
    autorec_get_floating_state: () => state.floating ?? { mode: "idle" },
    autorec_get_prompt_state: () => state.prompt ?? null,
    hq_get_settings: () => ({ baseUrl: "https://hq-api.aiwahconnect.com", hasApiKey: true, apiKeyHint: "xchg_…9f2a", autoSync: true, defaultProjectId: null, userEmail: "darani@aiwahlabs.com", userName: "Darani" }),
    hq_get_sync_status: () => [],
    is_recording: () => false,
    get_transcript_history: () => [],
    api_get_transcript_config: () => ({ provider: "parakeet", model: "parakeet-tdt-0.6b-v3-int8" }),
    get_app_version: () => "0.7.0",
    aiwah_open_url: () => null,
    builtin_ai_list_models: () => [{ name: "qwen3.5-2b", display_name: "Qwen 3.5 2B", status: { type: "downloaded" }, size_mb: 1500, description: "Fast" }],
    api_get_auto_generate_setting: () => true,
    get_notification_settings: () => ({ recording_notifications: true, time_based_reminders: false, meeting_reminders: false, respect_do_not_disturb: true, notification_sound: true, system_permission_granted: true, consent_given: true, manual_dnd_mode: false, notification_preferences: { show_recording_started: true, show_recording_stopped: true, show_recording_paused: true, show_recording_resumed: true, show_transcription_complete: true, show_meeting_reminders: false, show_system_errors: true, meeting_reminder_minutes: [5] } }),
    get_database_directory: () => "C:\Users\me\AppData\Roaming\com.aiwahlabs.minutes",
    whisper_get_models_directory: () => "C:\Users\me\AppData\Roaming\com.aiwahlabs.minutes\models",
    get_default_recordings_folder_path: () => "C:\Users\me\Music\meetily-recordings",
    parakeet_get_available_models: () => [{ name: "parakeet-tdt-0.6b-v3-int8", size_mb: 670, status: "Available", quantization: "Int8", speed: "Fast", accuracy: "High", description: "" }],
    whisper_get_available_models: () => [],
    get_audio_backend_info: () => [{ id: "default", name: "Default", description: "System default" }],
    get_current_audio_backend: () => "default",
    api_list_templates: () => [{ id: "standard_meeting", name: "Standard meeting", description: "Summary, decisions, action items" }],
    api_get_meeting_summary_language: () => null,
    api_get_meeting_metadata: (a) => ({ id: a?.meetingId || "m-1", title: "Discovery call — Fayeda Tours", created_at: iso(-120), updated_at: iso(-60), folder_path: null }),
    api_get_summary: () => state.noSummary ? null : ({ status: "completed", data: { MeetingName: "Discovery call — Fayeda Tours", markdown: ["## Summary", "", "Fayeda Tours wants a booking CRM for Kerala tour packages. They currently use WhatsApp and spreadsheets.", "", "## Action items", "", "- Abil: send proposal by Friday", "- Darani: prototype the itinerary builder", "", "## Decisions", "", "- Start with a 4-week pilot."].join(String.fromCharCode(10)) } }),
    api_get_meeting_transcripts: () => state.noTranscripts ? ({ transcripts: [], total_count: 0, has_more: false }) : ({ transcripts: [
      { id: "t1", text: "Thanks for joining. Let us walk through how bookings work today.", timestamp: iso(-120), audio_start_time: 0, audio_end_time: 4.2, duration: 4.2 },
      { id: "t2", text: "Most enquiries come on WhatsApp and we track them in a spreadsheet.", timestamp: iso(-119.9), audio_start_time: 4.5, audio_end_time: 9.1, duration: 4.6 },
      { id: "t3", text: "We would like one place to manage packages, payments and follow-ups.", timestamp: iso(-119.8), audio_start_time: 9.5, audio_end_time: 14.0, duration: 4.5 },
      { id: "t4", text: "Makes sense. Do you also need online payments, or only invoices?", timestamp: iso(-119.7), audio_start_time: 14.5, audio_end_time: 18.0, duration: 3.5 },
      { id: "t5", text: "Online payments, UPI mainly. Most customers pay an advance of ten thousand rupees.", timestamp: iso(-119.6), audio_start_time: 18.4, audio_end_time: 23.0, duration: 4.6 }
    ], total_count: 3, has_more: false }),
    account_status: () => state.account ?? { signedIn: true, email: "darani@aiwahlabs.com", name: "Darani S", picture: null, domainOk: true, hasClientId: true },
    api_search_transcripts: () => [],
    aiwah_transcript_speakers: () => ({ names: { me: "Darani S", them: "Anil Kumar" }, sides: { t1: "me", t2: "them", t3: "them", t4: "me", t5: "them" } }),
    aiwah_routing_state: () => state.routing ?? null,
    aiwah_meeting_language: () => ["en", "parakeet"],
    autorec_record_event: () => null,
    indic_pack_status: () => state.indicInstalled ? { installed: true, bytesOnDisk: 2650000000, downloadBytes: 2650000000, downloading: false } : { installed: false, bytesOnDisk: 0, downloadBytes: 2650000000, downloading: false },
    indic_pack_download: () => new Promise((r) => setTimeout(r, 1500)),
    indic_pack_cancel: () => null,
    indic_pack_delete: () => ({ installed: false, bytesOnDisk: 0, downloadBytes: 2650000000, downloading: false }),
  };
  let cb = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: state.window || "main" }, currentWebview: { windowLabel: state.window || "main", label: state.window || "main" } },
    transformCallback: (fn) => { const id = cb++; window["_" + id] = fn; return id; },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:event|listen")) return cb++;
      if (cmd === "plugin:store|get") return [null, false];
      if (cmd.startsWith("plugin:store|load") || cmd.startsWith("plugin:store|get_store")) return 1;
      if (cmd.startsWith("plugin:")) return null;
      const h = handlers[cmd];
      (window.__AIWAH_CALLS__ ||= []).push(cmd);
      return h ? h(args) : null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
