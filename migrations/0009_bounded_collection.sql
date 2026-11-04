ALTER TABLE sources ADD COLUMN lane TEXT NOT NULL DEFAULT 'http' CHECK(lane IN ('http','browser','discovery'));
UPDATE sources SET lane='browser' WHERE kind='browser';
ALTER TABLE sources ADD COLUMN last_checked_at TEXT;
ALTER TABLE sources ADD COLUMN last_changed_at TEXT;
ALTER TABLE sources ADD COLUMN last_fingerprint TEXT;
ALTER TABLE sources ADD COLUMN http_etag TEXT;
ALTER TABLE sources ADD COLUMN http_last_modified TEXT;
ALTER TABLE sources ADD COLUMN unchanged_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN claimed_lane TEXT;
CREATE INDEX sources_lane_due ON sources(lane,enabled,next_run_at,id);
CREATE INDEX jobs_source_active ON jobs(source_id,status);
CREATE INDEX jobs_lane_running ON jobs(claimed_lane,status,lease_expires_at);
CREATE INDEX jobs_created ON jobs(created_at,status,source_id);
CREATE INDEX jobs_retention ON jobs(status,updated_at);
CREATE TABLE collection_policy (
 lane TEXT PRIMARY KEY CHECK(lane IN ('http','browser','discovery')),
 daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 0 AND 10000),
 concurrency_limit INTEGER NOT NULL CHECK(concurrency_limit BETWEEN 0 AND 10)
);
INSERT INTO collection_policy VALUES ('http',1000,4),('browser',12,1),('discovery',3,1);
CREATE TABLE collection_usage (
 lane TEXT NOT NULL REFERENCES collection_policy(lane), day TEXT NOT NULL,
 claims INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(lane,day)
);
