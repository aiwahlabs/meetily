-- AIWAH: the signed-in Google account's display details (email lives in aiwah_google_calendar).
CREATE TABLE IF NOT EXISTS aiwah_account (
    id TEXT PRIMARY KEY,
    name TEXT,
    picture TEXT,
    updated_at TEXT NOT NULL
);
