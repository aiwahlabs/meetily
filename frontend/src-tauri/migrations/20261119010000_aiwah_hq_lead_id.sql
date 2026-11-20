-- AIWAH: per-meeting HQ lead (the project is already stored in project_id).
ALTER TABLE hq_meeting_sync ADD COLUMN lead_id TEXT;
