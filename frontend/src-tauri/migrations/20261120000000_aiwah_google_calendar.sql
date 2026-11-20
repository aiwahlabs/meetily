-- AIWAH: Google Calendar integration (Aiwah Minutes fork). Single row, id = 'default'.
CREATE TABLE IF NOT EXISTS aiwah_google_calendar (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    client_secret TEXT,
    refresh_token TEXT,
    access_token TEXT,
    access_token_expires_at TEXT,
    account_email TEXT,
    updated_at TEXT NOT NULL
);
