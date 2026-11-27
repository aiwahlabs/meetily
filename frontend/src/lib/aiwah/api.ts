// AIWAH: typed bridge to the Rust side of the Aiwah Minutes features
// (src-tauri/src/autorec/*, src-tauri/src/hq/*). Every Aiwah screen talks to
// the backend through this file, so the contract lives in one place.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

// ── Account (Google sign-in; HQ decides who gets in) ──────────────────────────

export interface AccountStatus {
  signedIn: boolean
  email: string | null
  name: string | null
  /** Google profile photo URL, if any. */
  picture: string | null
  /** Kept for older callers: true whenever an account is signed in. HQ, not an email domain, decides who may use the app. */
  domainOk: boolean
  /** A Google OAuth client is built in (or configured). False = sign-in cannot work yet. */
  hasClientId: boolean
}

export const account = {
  status: () => invoke<AccountStatus>("account_status"),
  /** Opens the browser for Google sign-in and waits (up to 5 min). Rejects with a
   *  user-facing message, e.g. "You don't have access to Aiwah HQ yet. Ask an Aiwah admin to invite you." */
  signIn: () => invoke<AccountStatus>("account_sign_in"),
  signOut: () => invoke<AccountStatus>("account_sign_out"),
}

// ── Calendar (same Google sign-in, read-only) ─────────────────────────────────

export interface EventAttendee {
  email: string
  name: string | null
  isSelf: boolean
  /** Google's answer to the invite. */
  response?: "accepted" | "declined" | "tentative" | "needsAction" | null
  isOrganizer?: boolean
  optional?: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  /** ISO 8601 */
  start: string
  end: string
  meetingUrl: string | null
  attendees: EventAttendee[]
  organizerEmail: string | null
  selfResponse: string | null
  description: string | null
}

export const calendar = {
  upcoming: (hoursAhead = 24) => invoke<CalendarEvent[]>("calendar_list_events", { hoursAhead }),
}

// ── Call detection / auto-record settings ─────────────────────────────────────

export interface AutoRecSettings {
  /** Ask with a pop-up when another app starts a call (mic turns on). */
  promptOnMic: boolean
  /** Pop-up 1 minute before a calendar meeting with a video link. */
  notifyCalendar: boolean
  /** Start recording a Google Meet calendar meeting without asking. Off by default. */
  autoRecordCalendar: boolean
  autoRecordMeet: boolean
  /** Stop when the call app releases the microphone. */
  autoStop: boolean
  /** Small "Recording" pill while recording, when Aiwah Minutes is not in front. */
  showRecordingPill: boolean
  /** Remind to tell participants the call is recorded. */
  consentReminder: boolean
  /** Delete the local audio once the meeting is in HQ. */
  deleteAudioAfterSync: boolean
  /** Comma-separated app/platform names that never get a pop-up (e.g. "WhatsApp, Discord"). */
  excludedApps: string
  /** Comma-separated words; calendar events with these in the title are ignored. */
  excludedKeywords: string
  /** Launch quietly in the tray at sign-in, so calls are detected. */
  startAtLogin: boolean
  /** After a meeting, detect English vs an Indian language (needs the Indian languages pack). */
  detectLanguage: boolean
  /** Indian languages this person speaks in meetings, e.g. ["ml", "ta"]. */
  indicLanguages: string[]
}

export const autorec = {
  getSettings: () => invoke<AutoRecSettings>("autorec_get_settings"),
  saveSettings: (settings: AutoRecSettings) => invoke<AutoRecSettings>("autorec_save_settings", { settings }),
  detectNow: () => invoke<DetectionReport>("autorec_detect_now"),
  refreshCalendar: () => invoke<void>("autorec_refresh_calendar"),
  /** Record a calendar event with its title, guests and platform ("Join & record"). */
  recordEvent: (eventId: string) => invoke<void>("autorec_record_event", { eventId }),
}

// ── Language routing and speakers ─────────────────────────────────────────────

/** What happens to a meeting's transcript right after it is saved. */
export interface RoutingState {
  meetingId: string
  state: "pending" | "detecting" | "transcribing" | "done" | "failed"
  language: string | null
  engine: "parakeet" | "indic" | null
  message: string | null
}

export interface TranscriptSpeakers {
  names: { me: string; them: string }
  /** transcript line id -> "me" | "them" */
  sides: Record<string, "me" | "them">
}

export const transcriptInfo = {
  routingState: (meetingId: string) => invoke<RoutingState | null>("aiwah_routing_state", { meetingId }),
  language: (meetingId: string) => invoke<[string | null, string | null]>("aiwah_meeting_language", { meetingId }),
  speakers: (meetingId: string) => invoke<TranscriptSpeakers>("aiwah_transcript_speakers", { meetingId }),
}

/** Event emitted while a saved meeting is routed / re-transcribed. */
export const ROUTING_EVENT = "aiwah-language-routing"

// ── Indian languages pack (IndicConformer) ────────────────────────────────────

export interface IndicPackStatus {
  installed: boolean
  bytesOnDisk: number
  /** Approximate download size in bytes. */
  downloadBytes: number
  downloading: boolean
}

export const INDIC_LANGUAGES: { code: string; name: string }[] = [
  { code: "ml", name: "Malayalam" },
  { code: "ta", name: "Tamil" },
  { code: "hi", name: "Hindi" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "bn", name: "Bengali" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "pa", name: "Punjabi" },
  { code: "or", name: "Odia" },
  { code: "as", name: "Assamese" },
  { code: "ur", name: "Urdu" },
]

export const indicPack = {
  status: () => invoke<IndicPackStatus>("indic_pack_status"),
  download: () => invoke<void>("indic_pack_download"),
  cancel: () => invoke<void>("indic_pack_cancel"),
  remove: () => invoke<IndicPackStatus>("indic_pack_delete"),
}

/** Progress event while the pack downloads: { downloaded, total } in bytes. */
export const INDIC_PROGRESS_EVENT = "indic-pack-progress"

export interface DetectionReport {
  micUsers: { appId: string; displayName: string }[]
  detected: { platform: Platform; appName: string; windowTitle: string | null } | null
  perAppSupported: boolean
}

// ── Platforms and meeting folders ─────────────────────────────────────────────

export type Platform = "google_meet" | "zoom" | "teams" | "slack" | "whatsapp" | "other"

export const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "google_meet", label: "Google Meet" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "zoom", label: "Zoom" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "other", label: "Other" },
]

export type MeetingType = "hiring" | "discovery" | "demo" | "client" | "internal" | "other"

export const MEETING_TYPES: { id: MeetingType; label: string }[] = [
  { id: "hiring", label: "Hiring screen" },
  { id: "discovery", label: "Discovery call" },
  { id: "demo", label: "Demo" },
  { id: "client", label: "Client call" },
  { id: "internal", label: "Internal" },
  { id: "other", label: "Other" },
]

export interface MeetingMeta {
  meetingId: string
  platform: Platform
  meetingType: MeetingType
  source: "manual" | "prompt" | "calendar"
  appName: string | null
  calendarEventId: string | null
  attendees: EventAttendee[]
}

export interface MeetingSummary {
  id: string
  title: string
  /** ISO 8601 */
  created_at?: string
}

export const meetings = {
  list: () => invoke<MeetingSummary[]>("api_get_meetings"),
  meta: () => invoke<MeetingMeta[]>("autorec_list_meeting_meta"),
  updateMeta: (meetingId: string, patch: { platform?: Platform; meetingType?: MeetingType }) =>
    invoke<void>("autorec_update_meeting_meta", { meetingId, ...patch }),
}

// ── The call pop-up / recording pill window (label "floating") ─────────────────

export type FloatingMode = "hidden" | "prompt" | "starting" | "recording" | "saved"

export interface FloatingState {
  mode: FloatingMode
  /** prompt only: "calendar" = scheduled meeting about to start (solid accent bar),
   *  "adhoc" = a call was detected from the microphone (dashed accent bar). */
  kind: "calendar" | "adhoc" | null
  /** prompt only: "Meeting detected", "Huddle detected", "Call detected", "Meeting starts in 1 min". */
  headline: string | null
  platform: Platform | null
  platformLabel: string | null
  /** App using the microphone, e.g. "Slack", "Chrome". */
  appName: string | null
  /** Calendar event title or the recording title. */
  title: string | null
  /** prompt (calendar): event start; recording: when recording began. ISO 8601. */
  startsAt: string | null
  startedAt: string | null
  /** prompt only: when the pop-up hides itself (ISO 8601). */
  expiresAt: string | null
  /** prompt (calendar): the video link, for "Join & record". */
  meetingUrl: string | null
  attendeeCount: number
  /** recording only. */
  source: "manual" | "prompt" | "calendar" | null
  consentReminder: boolean
  /** saved only: the meeting that was just saved. */
  meetingId: string | null
}

export type FloatingAction =
  | "record" // start recording the prompted call
  | "join" // calendar prompt: open the meeting link and start recording
  | "dismiss" // not now (until this app releases the mic)
  | "mute_app" // never ask for this app again (adds it to excludedApps)
  | "stop" // stop recording
  | "open" // bring the main window to front
  | "open_meeting" // saved: open the saved meeting in the main window

export const floating = {
  state: () => invoke<FloatingState>("autorec_get_floating_state"),
  act: (action: FloatingAction) => invoke<void>("autorec_floating_action", { action }),
  /** Tell the native window how big the content is (CSS px). It stays anchored top-right. */
  resize: (width: number, height: number) => invoke<void>("autorec_floating_resize", { width, height }),
  onState: (cb: (s: FloatingState) => void): Promise<UnlistenFn> =>
    listen<FloatingState>("aiwah-floating-state", (e) => cb(e.payload)),
}

// ── HQ ─────────────────────────────────────────────────────────────────────────

export interface HqSettingsView {
  baseUrl: string
  hasApiKey: boolean
  apiKeyHint: string | null
  autoSync: boolean
  defaultProjectId: string | null
  userEmail: string | null
  userName: string | null
  /** Signed in to HQ through the Google sign-in (one login). The API key is then only a fallback. */
  hasSession: boolean
  signedInEmail: string | null
}

export const hq = {
  getSettings: () => invoke<HqSettingsView>("hq_get_settings"),
  /** apiKey: undefined keeps the stored key, "" clears it. Verifies the key against HQ. */
  saveSettings: (settings: { baseUrl?: string; apiKey?: string; autoSync?: boolean; defaultProjectId?: string }) =>
    invoke<HqSettingsView>("hq_save_settings", { settings }),
  testConnection: () => invoke<{ email: string | null; name: string | null }>("hq_test_connection"),
  syncPending: () => invoke<number>("hq_sync_pending"),
}

// ── System ──────────────────────────────────────────────────────────────────────

export const system = {
  /** Open an https link (e.g. a meeting link) in the default browser. */
  openUrl: (url: string) => invoke<void>("aiwah_open_url", { url }),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function platformLabel(p: Platform | string | null | undefined): string {
  return PLATFORMS.find((x) => x.id === p)?.label ?? "Other"
}

export function platformFromUrl(url: string | null | undefined): Platform | null {
  if (!url) return null
  if (url.includes("meet.google.com")) return "google_meet"
  if (url.includes("zoom.us")) return "zoom"
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return "teams"
  return null
}
