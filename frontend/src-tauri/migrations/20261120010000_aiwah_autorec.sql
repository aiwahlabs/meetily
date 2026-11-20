-- AIWAH: auto-record settings and per-meeting call metadata (platform folder,
-- meeting type, calendar event). Own tables so upstream migrations never conflict.
CREATE TABLE IF NOT EXISTS aiwah_autorec_settings (
    id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aiwah_meeting_meta (
    meeting_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,          -- google_meet | zoom | teams | slack | whatsapp | other
    meeting_type TEXT NOT NULL,      -- hiring | discovery | demo | client | internal | other
    source TEXT NOT NULL,            -- manual | prompt | calendar
    app_name TEXT,
    calendar_event_id TEXT,
    attendees_json TEXT,
    created_at TEXT NOT NULL
);
