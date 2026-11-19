-- AIWAH: HQ Workshop sync (Aiwah Minutes fork). Kept in its own tables so upstream
-- migrations never conflict.
CREATE TABLE IF NOT EXISTS hq_settings (
    id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    api_key TEXT,
    auto_sync INTEGER NOT NULL DEFAULT 1,
    default_project_id TEXT,
    user_email TEXT,
    user_name TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hq_meeting_sync (
    meeting_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,           -- pending | synced | failed | skipped
    mode TEXT,                      -- ingest | upload
    language TEXT,
    project_id TEXT,
    hq_meeting_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hq_meeting_sync_status ON hq_meeting_sync(status);
