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

-- Locator state is optional so historical issues remain readable. On a fresh
-- database Hibernate creates these columns after this additive legacy step.
ALTER TABLE IF EXISTS issue_result
    ADD COLUMN IF NOT EXISTS locator_carousel_id INTEGER;
ALTER TABLE IF EXISTS issue_result
    ADD COLUMN IF NOT EXISTS locator_carousel_slide_index INTEGER;
ALTER TABLE IF EXISTS issue_result
    ADD COLUMN IF NOT EXISTS locator_carousel_slide_count INTEGER;

-- An OCR run with no samples or a failed CV run has no measured score. Preserve
-- historical numeric zeros and leave their new status unknown (NULL).
ALTER TABLE IF EXISTS score_result
    ALTER COLUMN IF EXISTS cv_score DROP NOT NULL;
ALTER TABLE IF EXISTS score_result
    ADD COLUMN IF NOT EXISTS cv_status VARCHAR(20);
