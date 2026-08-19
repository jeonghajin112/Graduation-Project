-- Hibernate's H2 enum update does not widen an enum that was created before
-- DOM_REPLAY existed. Run this idempotent, data-preserving widening before JPA
-- initializes so existing file databases accept the new capture mode.
ALTER TABLE IF EXISTS evaluation_artifact
    ALTER COLUMN capture_mode ENUM('DOM_REPLAY', 'FULL_PAGE', 'TILE', 'VIEWPORT');
