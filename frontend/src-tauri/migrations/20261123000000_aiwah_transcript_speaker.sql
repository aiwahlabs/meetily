-- AIWAH: which side spoke each transcript line ("me" = this device's microphone,
-- "them" = call audio). Names are resolved when shown or synced. Own table so upstream
-- migrations never conflict.
CREATE TABLE IF NOT EXISTS aiwah_transcript_speaker (
    transcript_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    side TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiwah_transcript_speaker_meeting ON aiwah_transcript_speaker (meeting_id);

-- AIWAH: whether the recording audio is stored on the HQ meeting yet
-- (pending | attached | none) and how often attaching it was tried.
ALTER TABLE hq_meeting_sync ADD COLUMN audio_status TEXT;
ALTER TABLE hq_meeting_sync ADD COLUMN audio_attempts INTEGER NOT NULL DEFAULT 0;

-- AIWAH: the language each meeting's transcript is in and which on-device engine made it
-- (parakeet | indic), decided by the language router after the recording is saved.
CREATE TABLE IF NOT EXISTS aiwah_meeting_language (
    meeting_id TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    engine TEXT NOT NULL,
    detected INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
