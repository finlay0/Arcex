-- One URL can have a cheap HTTP check and a separate browser investigation.
-- D1 always enforces foreign keys. Preserve children before rebuilding their parent
-- because dropping sources cascades jobs/watches and nulls observation/change links.
CREATE TABLE source_rows_preserved AS SELECT * FROM sources;
CREATE TABLE source_jobs_preserved AS SELECT * FROM jobs;
CREATE TABLE source_watches_preserved AS SELECT * FROM distribution_watches;
CREATE TABLE source_scans_preserved AS SELECT * FROM distribution_scans;
CREATE TABLE source_observations_preserved AS SELECT evidence_id,observed_at,job_id FROM evidence_observations WHERE job_id IS NOT NULL;
CREATE TABLE source_changes_preserved AS SELECT id,source_id FROM product_changes WHERE source_id IS NOT NULL;

DROP TABLE sources;
CREATE TABLE sources (
 id TEXT PRIMARY KEY,
 product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 url TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('public_page','rss','browser')),
 interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 720),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 next_run_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 lane TEXT NOT NULL DEFAULT 'http' CHECK(lane IN ('http','browser','discovery')),
 last_checked_at TEXT,
 last_changed_at TEXT,
 last_fingerprint TEXT,
 http_etag TEXT,
 http_last_modified TEXT,
 unchanged_streak INTEGER NOT NULL DEFAULT 0,
 failure_streak INTEGER NOT NULL DEFAULT 0,
 last_evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
 UNIQUE(url,kind)
);
INSERT INTO sources SELECT * FROM source_rows_preserved;
INSERT INTO jobs SELECT * FROM source_jobs_preserved;
INSERT INTO distribution_watches SELECT * FROM source_watches_preserved;
INSERT INTO distribution_scans SELECT * FROM source_scans_preserved;
UPDATE evidence_observations SET job_id=(
 SELECT p.job_id FROM source_observations_preserved p WHERE p.evidence_id=evidence_observations.evidence_id AND p.observed_at=evidence_observations.observed_at
) WHERE EXISTS(SELECT 1 FROM source_observations_preserved p WHERE p.evidence_id=evidence_observations.evidence_id AND p.observed_at=evidence_observations.observed_at);
UPDATE product_changes SET source_id=(SELECT p.source_id FROM source_changes_preserved p WHERE p.id=product_changes.id)
 WHERE id IN (SELECT id FROM source_changes_preserved);
CREATE INDEX sources_due ON sources(enabled,next_run_at);
CREATE INDEX sources_lane_due ON sources(lane,enabled,next_run_at,id);

DROP TABLE source_rows_preserved;
DROP TABLE source_jobs_preserved;
DROP TABLE source_watches_preserved;
DROP TABLE source_scans_preserved;
DROP TABLE source_observations_preserved;
DROP TABLE source_changes_preserved;
