-- Live-only reports keep the historical evaluation_artifact table so existing
-- capture geometry remains available. Replay-file columns from older schemas
-- are intentionally left in place, but must be nullable because new rows store
-- metadata only. Every statement is safe for both legacy and fresh databases.
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS storage_key DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS content_type DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS size_bytes DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS sha256 DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS image_width_px DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS image_height_px DROP NOT NULL;
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN IF EXISTS capture_mode DROP NOT NULL;
